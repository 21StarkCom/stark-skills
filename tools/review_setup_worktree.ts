#!/usr/bin/env node

// Resolve a PR's metadata, fetch the GitHub PR head ref, and create (or
// validate-reuse) an isolated git worktree pointing at that ref. Replaces the
// 50-line bash block under stark-review's Setup section.
//
// The worktree path is deterministic per (repo, pr, mode) so a second run
// reuses the same checkout if it's still pointing at the right commit and
// has no local edits — and refuses to clobber it otherwise.

import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PrMetadata = {
  number: number;
  branch: string;
  headSha: string;
  base: string;
  isFork: boolean;
  maintainerCanModify: boolean;
};

export type WorktreeReceipt = {
  worktreePath: string;
  pr: PrMetadata;
  reused: boolean;
};

export type SetupErrorCode =
  | "gh-cli-failure"
  | "repo-mismatch"
  | "worktree-dirty"
  | "worktree-head-mismatch"
  | "git-failure";

export class SetupError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// ── Pure helpers ────────────────────────────────────────────────

export function repoSlug(repo: string): string {
  // GitHub `org/name` is case-insensitive; normalize for path stability so
  // `Evinced/foo` and `evinced/foo` collide on the same worktree (which is
  // what callers want — same repo, same checkout).
  return repo.toLowerCase().replace(/\//g, "-");
}

export function defaultWorktreePath(
  repo: string,
  pr: number,
  mode: string,
): string {
  return path.join("/tmp", `review-${repoSlug(repo)}-pr${pr}-${mode}`);
}

// ── External commands (override in tests) ───────────────────────

export type Runner = {
  gh: (args: string[]) => string;
  git: (args: string[], cwd?: string) => string;
  fileExists: (p: string) => boolean;
  worktreeExistsAt: (p: string) => boolean;
};

const REAL_RUNNER: Runner = {
  gh: (args) => execFileSync("gh", args, { encoding: "utf8" }),
  git: (args, cwd) =>
    execFileSync("git", args, { encoding: "utf8", cwd }),
  fileExists: (p) => fs.existsSync(p),
  worktreeExistsAt: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
};

// ── PR metadata fetch ───────────────────────────────────────────

export function fetchPrMetadata(
  pr: number,
  repo: string,
  runner: Runner,
): PrMetadata {
  const fields =
    "number,headRefName,headRefOid,baseRefName,isCrossRepository,maintainerCanModify";
  let raw: string;
  try {
    raw = runner.gh(["pr", "view", String(pr), "--repo", repo, "--json", fields]);
  } catch (err) {
    throw new SetupError(
      "gh-cli-failure",
      `gh pr view failed for ${repo}#${pr}: ${(err as Error).message}`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SetupError(
      "gh-cli-failure",
      `gh pr view returned non-JSON: ${(err as Error).message}`,
    );
  }
  return {
    number: Number(parsed.number ?? pr),
    branch: String(parsed.headRefName ?? ""),
    headSha: String(parsed.headRefOid ?? ""),
    base: String(parsed.baseRefName ?? ""),
    isFork: Boolean(parsed.isCrossRepository),
    maintainerCanModify: Boolean(parsed.maintainerCanModify),
  };
}

export function assertRepoMatches(repo: string, runner: Runner): void {
  let raw: string;
  try {
    raw = runner.gh(["repo", "view", "--json", "nameWithOwner"]).trim();
  } catch (err) {
    throw new SetupError(
      "gh-cli-failure",
      `gh repo view failed: ${(err as Error).message}`,
    );
  }
  let current: string;
  try {
    current = String(JSON.parse(raw).nameWithOwner ?? "");
  } catch (err) {
    throw new SetupError(
      "gh-cli-failure",
      `gh repo view returned non-JSON: ${(err as Error).message}`,
    );
  }
  if (current.toLowerCase() !== repo.toLowerCase()) {
    throw new SetupError(
      "repo-mismatch",
      `current checkout is ${current}, but --repo is ${repo}; ` +
        `re-run from the matching local clone.`,
    );
  }
}

// ── Worktree provisioning ───────────────────────────────────────

export type SetupOptions = {
  pr: number;
  repo: string;
  mode: "single" | "multi";
  worktreePath?: string;
  /**
   * Skip the `gh repo view` cross-check. Useful for callers that already
   * verified the working directory or that intentionally run from somewhere
   * other than the target repo (e.g. CI runners).
   */
  skipRepoCheck?: boolean;
  runner?: Runner;
};

export function setupWorktree(opts: SetupOptions): WorktreeReceipt {
  const runner = opts.runner ?? REAL_RUNNER;
  if (!opts.skipRepoCheck) {
    assertRepoMatches(opts.repo, runner);
  }
  const meta = fetchPrMetadata(opts.pr, opts.repo, runner);
  const worktreePath =
    opts.worktreePath ?? defaultWorktreePath(opts.repo, opts.pr, opts.mode);
  const prRef = `refs/remotes/origin/pr/${meta.number}`;

  // Fetch the base branch and the PR's head ref. We force-update both
  // so a stale local ref can't make us review a different tree than what's
  // currently on the PR.
  runner.git([
    "fetch",
    "origin",
    `+${meta.base}:refs/remotes/origin/${meta.base}`,
  ]);
  runner.git(["fetch", "origin", `+refs/pull/${meta.number}/head:${prRef}`]);

  const exists = runner.worktreeExistsAt(worktreePath);
  if (exists) {
    return reuseWorktree(worktreePath, meta, prRef, runner);
  }

  runner.git(["worktree", "add", "--detach", worktreePath, prRef]);
  const head = runner.git(["rev-parse", "HEAD"], worktreePath).trim();
  if (head !== meta.headSha) {
    throw new SetupError(
      "worktree-head-mismatch",
      `freshly-created worktree HEAD ${head} != PR head ${meta.headSha}; ` +
        `aborting before any review work begins.`,
    );
  }
  return { worktreePath, pr: meta, reused: false };
}

function reuseWorktree(
  worktreePath: string,
  meta: PrMetadata,
  prRef: string,
  runner: Runner,
): WorktreeReceipt {
  // Both `diff --quiet` and `diff --cached --quiet` exit 0 only when there
  // are zero unstaged / zero staged changes. Any non-zero is dirty.
  if (!gitDiffQuiet(["diff", "--quiet"], worktreePath, runner)) {
    throw new SetupError(
      "worktree-dirty",
      `existing worktree has unstaged changes: ${worktreePath}`,
    );
  }
  if (!gitDiffQuiet(["diff", "--cached", "--quiet"], worktreePath, runner)) {
    throw new SetupError(
      "worktree-dirty",
      `existing worktree has staged changes: ${worktreePath}`,
    );
  }
  const head = runner.git(["rev-parse", "HEAD"], worktreePath).trim();
  if (head !== meta.headSha) {
    throw new SetupError(
      "worktree-head-mismatch",
      `existing worktree HEAD ${head} != PR head ${meta.headSha}; ` +
        `clean it up manually or choose a fresh worktree path.`,
    );
  }
  // Detach to the PR ref explicitly to handle the case where someone
  // checked out a branch in there since the last review.
  runner.git(["checkout", "--detach", prRef], worktreePath);
  return { worktreePath, pr: meta, reused: true };
}

function gitDiffQuiet(
  args: string[],
  cwd: string,
  runner: Runner,
): boolean {
  try {
    runner.git(args, cwd);
    return true;
  } catch (err) {
    // `git diff --quiet` exits 1 when differences exist. Any other
    // non-zero indicates a real failure (corrupt repo, wrong cwd) and
    // should bubble up rather than be misread as "dirty."
    const status = (err as SpawnSyncReturns<string>).status;
    if (status === 1) return false;
    throw new SetupError(
      "git-failure",
      `git ${args.join(" ")} failed: ${(err as Error).message}`,
    );
  }
}

// ── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): {
  pr: number | null;
  repo: string | null;
  mode: "single" | "multi";
  worktreePath: string | null;
  skipRepoCheck: boolean;
  asJson: boolean;
} {
  let pr: number | null = null;
  let repo: string | null = null;
  let mode: "single" | "multi" = "single";
  let worktreePath: string | null = null;
  let skipRepoCheck = false;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pr") pr = Number(argv[++i] ?? "");
    else if (arg === "--repo") repo = argv[++i] ?? null;
    else if (arg === "--mode") {
      const m = argv[++i] ?? "";
      if (m !== "single" && m !== "multi") {
        console.error(`--mode must be 'single' or 'multi', got '${m}'`);
        process.exit(2);
      }
      mode = m;
    } else if (arg === "--worktree") worktreePath = argv[++i] ?? null;
    else if (arg === "--skip-repo-check") skipRepoCheck = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: review_setup_worktree --pr N --repo ORG/NAME [--mode single|multi]\n" +
          "                             [--worktree PATH] [--skip-repo-check] [--json]",
      );
      process.exit(0);
    }
  }
  return { pr, repo, mode, worktreePath, skipRepoCheck, asJson };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.pr === null || Number.isNaN(opts.pr)) {
    console.error("--pr is required (positive integer)");
    process.exit(2);
  }
  if (!opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    console.error("--repo is required (org/name)");
    process.exit(2);
  }
  try {
    const receipt = setupWorktree({
      pr: opts.pr,
      repo: opts.repo,
      mode: opts.mode,
      worktreePath: opts.worktreePath ?? undefined,
      skipRepoCheck: opts.skipRepoCheck,
    });
    if (opts.asJson) {
      console.log(JSON.stringify(receipt, null, 2));
    } else {
      console.log(
        `worktree: ${receipt.worktreePath}\n` +
          `pr: ${opts.repo}#${receipt.pr.number} (${receipt.pr.branch})\n` +
          `base: ${receipt.pr.base}\n` +
          `head: ${receipt.pr.headSha}\n` +
          `fork: ${receipt.pr.isFork}\n` +
          `reused: ${receipt.reused}`,
      );
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof SetupError) {
      console.error(`[${err.code}] ${err.message}`);
      // Distinct exit codes per failure mode so the calling skill can
      // pattern-match without parsing stderr.
      const exitCodeByCode: Record<SetupErrorCode, number> = {
        "gh-cli-failure": 2,
        "repo-mismatch": 3,
        "worktree-dirty": 4,
        "worktree-head-mismatch": 5,
        "git-failure": 6,
      };
      process.exit(exitCodeByCode[err.code] ?? 1);
    }
    console.error((err as Error).message);
    process.exit(1);
  }
}

// Match against both the lexical and realpath form of argv[1]:
//   - Node's --experimental-strip-types loader (Node 25+) sets import.meta.url
//     to the realpath, so a symlinked invocation needs the realpath comparison.
//   - NODE_OPTIONS=--preserve-symlinks-main keeps import.meta.url at the
//     symlink URL, so we need the lexical comparison too.
//   - realpathSync throws if argv[1] doesn't exist on disk (embedded runners
//     that fake argv[1]); swallow that and fall through to "not invoked".
function isInvokedAsScript(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(path.resolve(argv1)).href) return true;
  try {
    return metaUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main();
}
