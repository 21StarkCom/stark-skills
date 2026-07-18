#!/usr/bin/env node
/**
 * write_spec_land.ts — the create-or-adopt idempotent PR landing helper for
 * `/stark-write-spec` (#706). This CLI owns EVERY git + PR side effect; the
 * deterministic decisions live in `write_spec_land_lib.ts` (pure, unit-proven).
 *
 * Subcommands:
 *   resolve-slug   --topic "..."            → print sanitizeSlug(topic)
 *   validate-out   --out PATH               → print deriveSlugFromOut(PATH)
 *   prepare-branch --branch NAME            → adopt-or-create the branch:
 *                                             refuses a dirty tree; ff-only merge
 *                                             for an existing local (a non-ff
 *                                             divergence is a HARD error — never
 *                                             force); the 3 standardized actions.
 *   publish        --repo O/R --branch B    → git add <spec>; commit (REPO
 *                  --spec PATH --receipt P    identity, NOT App-authored) iff
 *                  [--accepted-gaps PATH]     something is staged; plain push
 *                  [--lead claude|codex]      (never --force); adopt an existing
 *                  [--ready] [--base B]       PR (prList → pickPrForHead) and
 *                  [--title T]                merge ONLY our owned body block
 *                  [--dry-run] [--json]       (apiGet → mergePrBody → apiPatch),
 *                                             un-drafting via `gh pr ready` under
 *                                             the ambient user when --ready; else
 *                                             prCreate(draft:!ready, app:lead).
 *
 * Arg-parsing house style mirrors `write_spec.ts` / `red_team_fold.ts`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  apiGet,
  apiPatch,
  prCreate,
  prList,
  type AppName,
} from "./github_app_lib.ts";
import { deriveSlugFromOut, type WriteSpecReceipt } from "./write_spec_lib.ts";
import { getWriteSpecConfig } from "./stark_config_lib.ts";
import { sanitizeSlug } from "./stark_handover_lib.ts";
import {
  appForLead,
  buildOwnedBlock,
  mergePrBody,
  parseAcceptedGaps,
  pickPrForHead,
  planBranchAction,
  shouldRunGitStep,
  shouldSkipCommit,
  type AcceptedGap,
  type OpenPr,
} from "./write_spec_land_lib.ts";

// ── git / gh shell helpers (the CLI owns the side-effect surface) ───────────

interface Shell {
  code: number;
  stdout: string;
  stderr: string;
}

function git(args: string[], cwd: string = process.cwd()): Shell {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function gh(args: string[], cwd: string = process.cwd()): Shell {
  const r = spawnSync("gh", args, { cwd, encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function treeIsDirty(cwd: string): boolean {
  return git(["status", "--porcelain"], cwd).stdout.length > 0;
}

function localBranchExists(branch: string, cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], cwd).code === 0;
}

function remoteBranchExists(branch: string, cwd: string): boolean {
  const r = git(["ls-remote", "--heads", "origin", branch], cwd);
  return r.code === 0 && r.stdout.length > 0;
}

function stagedDiffEmpty(cwd: string): boolean {
  // `git diff --cached --quiet` exits 0 when nothing is staged, 1 when there is.
  return git(["diff", "--cached", "--quiet"], cwd).code === 0;
}

// ── CLI plumbing ────────────────────────────────────────────────────────────

const HELP = `usage: write_spec_land.ts <subcommand> [options]

Create-or-adopt idempotent PR landing helper for /stark-write-spec.

subcommands:
  resolve-slug   --topic TEXT                     Print the sanitized slug for a topic.
  validate-out   --out PATH [--json]              Derive + print the slug from an --out path.
  prepare-branch --branch NAME [--repo-dir DIR]   Adopt-or-create the branch (ff-only; never force).
                 [--dry-run] [--json]
  publish        --repo OWNER/REPO --branch NAME  Add/commit(spec)/push, adopt-or-create the PR,
                 --spec PATH --receipt PATH          merge only the owned body block.
                 [--accepted-gaps PATH] [--lead claude|codex]
                 [--base BRANCH] [--title TEXT] [--ready]
                 [--repo-dir DIR] [--dry-run] [--json]

options:
  -h, --help   show this help message and exit

Notes:
  - The commit uses the REPO git identity (not App-authored); only the PR is App-authored.
  - Pushes are plain (never --force); a non-ff local branch is a HARD error.
  - App tokens cannot un-draft — --ready shells 'gh pr ready' under the ambient user.
`;

function fail(json: boolean, message: string, code = 2): number {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  else process.stderr.write(`write_spec_land: ${message}\n`);
  return code;
}

interface Flags {
  [k: string]: string | boolean | undefined;
}

/** Minimal flag parser: `--key value` and boolean `--flag`. */
function parseFlags(argv: string[], booleans: Set<string>): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} requires a value`);
    flags[key] = v;
  }
  return flags;
}

function str(flags: Flags, key: string): string {
  const v = flags[key];
  return typeof v === "string" ? v : "";
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ── Subcommand: resolve-slug ────────────────────────────────────────────────

function cmdResolveSlug(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["json"]));
  const json = flags["json"] === true;
  const topic = str(flags, "topic");
  if (!topic) return fail(json, "--topic is required");
  const slug = sanitizeSlug(topic);
  if (json) process.stdout.write(JSON.stringify({ ok: true, slug }, null, 2) + "\n");
  else process.stdout.write(slug + "\n");
  return 0;
}

// ── Subcommand: validate-out ────────────────────────────────────────────────

function cmdValidateOut(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["json"]));
  const json = flags["json"] === true;
  const out = str(flags, "out");
  if (!out) return fail(json, "--out is required");
  let slug: string;
  try {
    slug = deriveSlugFromOut(out);
  } catch (err) {
    return fail(json, (err as Error).message, 1);
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, out, slug }, null, 2) + "\n");
  else process.stdout.write(slug + "\n");
  return 0;
}

// ── Subcommand: prepare-branch ──────────────────────────────────────────────

function cmdPrepareBranch(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["json", "dry-run"]));
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;
  const branch = str(flags, "branch");
  const cwd = str(flags, "repo-dir") || process.cwd();
  if (!branch) return fail(json, "--branch is required");

  const localExists = localBranchExists(branch, cwd);
  const remoteExists = remoteBranchExists(branch, cwd);
  const action = planBranchAction(localExists, remoteExists);

  if (!shouldRunGitStep(dryRun)) {
    const plan = { ok: true, dry_run: true, branch, action, localExists, remoteExists };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }

  if (treeIsDirty(cwd)) {
    return fail(json, "refusing to prepare a branch on a dirty working tree", 1);
  }

  const steps: string[] = [];
  const runGit = (args: string[]): Shell => {
    const r = git(args, cwd);
    steps.push(`git ${args.join(" ")}`);
    return r;
  };

  if (action === "checkout-ff") {
    let r = runGit(["checkout", branch]);
    if (r.code !== 0) return fail(json, `checkout ${branch} failed: ${r.stderr}`, 1);
    // Fast-forward to the remote if it exists; a non-ff divergence is a HARD
    // error — we NEVER force-reset a local branch.
    if (remoteExists) {
      r = runGit(["fetch", "origin", branch]);
      if (r.code !== 0) return fail(json, `fetch origin ${branch} failed: ${r.stderr}`, 1);
      r = runGit(["merge", "--ff-only", `origin/${branch}`]);
      if (r.code !== 0) {
        return fail(
          json,
          `local branch ${branch} has diverged from origin/${branch}; ` +
            `refusing to force (resolve the divergence manually): ${r.stderr}`,
          1,
        );
      }
    }
  } else if (action === "checkout-track") {
    let r = runGit(["fetch", "origin", branch]);
    if (r.code !== 0) return fail(json, `fetch origin ${branch} failed: ${r.stderr}`, 1);
    r = runGit(["checkout", "-B", branch, `origin/${branch}`]);
    if (r.code !== 0) return fail(json, `checkout tracking ${branch} failed: ${r.stderr}`, 1);
  } else {
    const r = runGit(["checkout", "-b", branch]);
    if (r.code !== 0) return fail(json, `create ${branch} failed: ${r.stderr}`, 1);
  }

  const result = { ok: true, branch, action, steps };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

// ── Subcommand: publish ─────────────────────────────────────────────────────

interface PublishResult {
  ok: boolean;
  branch: string;
  committed: boolean;
  pushed: boolean;
  pr: { number: number; url: string; app: AppName; adopted: boolean } | null;
}

async function cmdPublish(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json", "dry-run", "ready"]));
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;
  const ready = flags["ready"] === true;
  const repo = str(flags, "repo");
  const branch = str(flags, "branch");
  const spec = str(flags, "spec");
  const receiptPath = str(flags, "receipt");
  const acceptedGapsPath = str(flags, "accepted-gaps");
  const lead = str(flags, "lead") || getWriteSpecConfig().lead_agent;
  const base = str(flags, "base") || "main";
  const title = str(flags, "title");
  const cwd = str(flags, "repo-dir") || process.cwd();

  if (!repo) return fail(json, "--repo OWNER/REPO is required");
  if (!branch) return fail(json, "--branch is required");
  if (!spec) return fail(json, "--spec is required");
  if (!receiptPath) return fail(json, "--receipt is required");

  let receipt: WriteSpecReceipt;
  try {
    receipt = readJsonFile(receiptPath) as WriteSpecReceipt;
  } catch (err) {
    return fail(json, `cannot read --receipt: ${(err as Error).message}`, 1);
  }

  let acceptedGaps: AcceptedGap[] = [];
  if (acceptedGapsPath) {
    try {
      acceptedGaps = parseAcceptedGaps(readJsonFile(acceptedGapsPath));
    } catch (err) {
      return fail(json, `cannot read --accepted-gaps: ${(err as Error).message}`, 1);
    }
  }

  const app = appForLead(lead);
  const ownedBlock = buildOwnedBlock(receipt, acceptedGaps);
  const prTitle = title || `spec: ${receipt.slug ?? deriveSlugFromOut(spec)}`;

  // ── Dry run: report the plan, ZERO side effects ───────────────────────────
  if (!shouldRunGitStep(dryRun)) {
    const plan = {
      ok: true,
      dry_run: true,
      repo,
      branch,
      base,
      spec,
      lead,
      app,
      ready,
      title: prTitle,
      accepted_gaps: acceptedGaps.length,
      owned_block_chars: ownedBlock.length,
    };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }

  const result: PublishResult = { ok: true, branch, committed: false, pushed: false, pr: null };

  // 1. Stage ONLY the spec file (never `git add -A`).
  let r = git(["add", "--", spec], cwd);
  if (r.code !== 0) return fail(json, `git add ${spec} failed: ${r.stderr}`, 1);

  // 2. Commit iff something is staged — skip otherwise (idempotent re-run).
  if (shouldSkipCommit(stagedDiffEmpty(cwd))) {
    result.committed = false;
  } else {
    // REPO identity (ambient git config) — deliberately NOT App-authored.
    r = git(["commit", "-m", `docs(spec): ${receipt.slug ?? "write-spec"} (${branch})`], cwd);
    if (r.code !== 0) return fail(json, `git commit failed: ${r.stderr}`, 1);
    result.committed = true;
  }

  // 3. Push plain — NEVER --force.
  r = git(["push", "-u", "origin", branch], cwd);
  if (r.code !== 0) return fail(json, `git push failed: ${r.stderr}`, 1);
  result.pushed = true;

  // 4. Adopt an existing open PR for this head, else create one.
  let openPrs: OpenPr[] = [];
  try {
    openPrs = (await prList(repo, "open", app)) as OpenPr[];
  } catch (err) {
    return fail(json, `prList failed: ${(err as Error).message}`, 1);
  }
  const existing = pickPrForHead(openPrs, branch);

  if (existing) {
    // Merge ONLY the owned block into the current body (preserve the rest).
    let current: { body?: string | null; draft?: boolean } = existing;
    try {
      current = (await apiGet(`/repos/${repo}/pulls/${existing.number}`, undefined, app)) as {
        body?: string | null;
        draft?: boolean;
      };
    } catch {
      /* fall back to the list body */
    }
    const merged = mergePrBody(current.body ?? existing.body ?? "", ownedBlock);
    try {
      await apiPatch(`/repos/${repo}/pulls/${existing.number}`, { body: merged }, app);
    } catch (err) {
      return fail(json, `apiPatch PR body failed: ${(err as Error).message}`, 1);
    }
    // Un-draft via gh (App tokens cannot un-draft) when --ready + still draft.
    if (ready && (current.draft ?? existing.draft) === true) {
      const gr = gh(["pr", "ready", String(existing.number), "--repo", repo], cwd);
      if (gr.code !== 0) {
        return fail(json, `gh pr ready failed: ${gr.stderr}`, 1);
      }
    }
    result.pr = {
      number: existing.number,
      url: existing.html_url ?? `https://github.com/${repo}/pull/${existing.number}`,
      app,
      adopted: true,
    };
  } else {
    let created: { number?: number; html_url?: string };
    try {
      created = (await prCreate(repo, {
        head: branch,
        base,
        title: prTitle,
        body: ownedBlock,
        draft: !ready,
        app,
      })) as { number?: number; html_url?: string };
    } catch (err) {
      return fail(json, `prCreate failed: ${(err as Error).message}`, 1);
    }
    result.pr = {
      number: created.number ?? 0,
      url: created.html_url ?? "",
      app,
      adopted: false,
    };
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `landed on ${branch}: committed=${result.committed} pushed=${result.pushed} ` +
        `pr=#${result.pr?.number ?? "?"} (${result.pr?.adopted ? "adopted" : "created"}, ${app})\n`,
    );
  }
  return 0;
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<number> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "-h" || sub === "--help" || sub === "help" || sub === undefined) {
    process.stdout.write(HELP);
    return 0;
  }
  // A standalone --help anywhere in the args also prints help (help.md protocol).
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "resolve-slug":
        return cmdResolveSlug(rest);
      case "validate-out":
        return cmdValidateOut(rest);
      case "prepare-branch":
        return cmdPrepareBranch(rest);
      case "publish":
        return await cmdPublish(rest);
      default:
        return fail(false, `unknown subcommand: ${sub}`);
    }
  } catch (err) {
    return fail(false, (err as Error).message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`write_spec_land: unhandled: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
