#!/usr/bin/env node
/**
 * copilot_land.ts — the create-or-adopt idempotent impl-PR landing CLI for
 * `/stark-copilot` (#773). This CLI owns EVERY git + PR side effect; the
 * deterministic decisions live in `copilot_land_lib.ts` (pure, unit-proven).
 *
 * `copilot` is the merge point for the `impl` artifact: a run is not done
 * without a non-empty `artifact_prs.impl`. (The `/stark-forge` chainer that
 * enforced this was retired 2026-07-26; the invariant outlived it.)
 * Copilot itself only commits locally (SKILL.md §2g); this CLI runs AFTER
 * that work is committed and lands it: adopt-or-create the impl branch,
 * push (never force), adopt-or-create the PR, report its number(s).
 *
 * Subcommands:
 *   branch-name    --plan-slug SLUG|"" --fallback-slug SLUG
 *                  Print deriveImplBranch(planSlug, fallbackSlug).
 *
 *   prepare-branch --branch NAME [--repo-dir DIR] [--require-base SHA]
 *                  [--dry-run] [--json]
 *                  Adopt-or-create the branch on the CURRENT checkout
 *                  (refuses a dirty tree; ff-only merge for an existing
 *                  local — a non-ff divergence is a HARD error, never
 *                  force). Mirrors `write_spec_land.ts prepare-branch`.
 *                  --require-base SHA refuses to adopt a remote branch that
 *                  does not contain SHA, and asserts HEAD contains it after
 *                  every path. Without it, a leftover remote branch from an
 *                  abandoned run silently resets HEAD onto the old codebase.
 *
 *   land           --repo O/R --branch NAME --title T --body TEXT
 *                  [--base main] [--lead claude|codex|gemini] [--ready]
 *                  [--known-prs "812,819"] [--repo-dir DIR]
 *                  [--dry-run] [--json]
 *                  Push the already-committed branch (never --force),
 *                  adopt an existing open PR for that head or open a
 *                  fresh one (draft by default, authored by `aryeh-stark`
 *                  via `gh` — NOT by the lead's GitHub App), and print
 *                  `{pr, prs}` — `prs` is the union of `--known-prs` with
 *                  the landed/adopted number. `--lead` still selects the
 *                  App used for the READ (PR listing), which needs a token
 *                  but confers no authorship.
 *
 * Arg-parsing house style mirrors `write_spec_land.ts` / `red_team_fold.ts`.
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./main_module_lib.ts";
import { prList, type AppName } from "./github_app_lib.ts";
import {
  appForLead,
  buildPushArgs,
  deriveImplBranch,
  landImpl,
  type LandDeps,
  type OpenPr,
} from "./copilot_land_lib.ts";

// ── git shell helpers (the CLI owns the side-effect surface) ───────────────

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

// Does `ref` contain `commitish` (i.e. is it an ancestor of, or equal to, ref)?
// Used by prepare-branch's --require-base guard: adopting a leftover branch from
// an abandoned run silently resets HEAD onto the OLD codebase, so every later
// measurement is taken against a tree predating the caller's pin. Observed live
// on a /stark-build run.
//
// TRI-STATE ON PURPOSE. `merge-base --is-ancestor` exits 0 (yes), 1 (no), or
// 128 (could not evaluate — the ref does not resolve, e.g. a --single-branch or
// --depth clone where refs/remotes/origin/<branch> was never created by the
// fetch). Collapsing 128 into "no" makes the guard confidently report a healthy
// branch as stale and tell the operator to DELETE it — data loss on a false
// premise. Callers must handle "unresolvable" as its own outcome.
type Containment = "yes" | "no" | "unresolvable";

function refContains(ref: string, commitish: string, cwd: string): Containment {
  const r = git(["merge-base", "--is-ancestor", commitish, ref], cwd);
  if (r.code === 0) return "yes";
  if (r.code === 1) return "no";
  return "unresolvable";
}

function hasUpstream(cwd: string): boolean {
  return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd).code === 0;
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────

const HELP = `usage: copilot_land.ts <subcommand> [options]

Create-or-adopt idempotent impl-PR landing helper for /stark-copilot.

subcommands:
  branch-name    --plan-slug SLUG --fallback-slug SLUG [--json]
                 Print the deterministic impl branch name.
  prepare-branch --branch NAME [--repo-dir DIR] [--require-base SHA]
                 [--dry-run] [--json]
                 Adopt-or-create the branch (ff-only; never force).
                 --require-base SHA refuses a stale remote branch that
                 does not contain SHA, and asserts HEAD contains it.
  land           --repo OWNER/REPO --branch NAME --title TEXT --body TEXT
                 [--base BRANCH] [--lead claude|codex|gemini] [--ready]
                 [--known-prs "812,819"] [--repo-dir DIR]
                 [--dry-run] [--json]
                 Push (never --force), adopt-or-create the PR, print
                 {pr, prs}.

options:
  -h, --help   show this help message and exit

Notes:
  - Pushes are plain (never --force); a non-ff local branch is a HARD error.
  - Draft PRs by default (repo policy); --ready opts out.
  - impl is the only artifact allowed multiple PRs — --known-prs is unioned
    with the landed/adopted number, never treated as a conflict.
`;

function fail(json: boolean, message: string, code = 2): number {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  else process.stderr.write(`copilot_land: ${message}\n`);
  return code;
}

interface Flags {
  [k: string]: string | boolean | undefined;
}

/** Minimal flag parser: `--key value` and boolean `--flag`. */
// `values` is the allowlist of recognized value-taking flags. Unknown flags are
// a HARD error, never a silent drop: a typo'd or renamed safety flag
// (`--requirebase` for `--require-base`) must not quietly disable the guard it
// names while the command still exits 0. Callers pass every flag they read.
function parseFlags(argv: string[], booleans: Set<string>, values: Set<string>): Flags {
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!values.has(key)) {
      const known = [...booleans, ...values].sort().map((k) => `--${k}`).join(", ");
      throw new Error(`unknown flag: --${key} (known flags: ${known})`);
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

// Distinguishes "flag absent" from "flag present but empty" — `str()` collapses
// both to "", which let `--require-base ""` (an unresolved shell variable)
// silently disable every base guard while still reporting ok:true.
function present(flags: Flags, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(flags, key);
}

function parsePrCsv(csv: string): number[] {
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`--known-prs: not an integer: ${s}`);
      return n;
    });
}

// ── Subcommand: branch-name ──────────────────────────────────────────────────

function cmdBranchName(argv: string[]): number {
  const flags = parseFlags(argv, new Set(["json"]), new Set(["plan-slug", "fallback-slug"]));
  const json = flags["json"] === true;
  const planSlug = str(flags, "plan-slug");
  const fallbackSlug = str(flags, "fallback-slug");
  if (!fallbackSlug) return fail(json, "--fallback-slug is required");
  const branch = deriveImplBranch(planSlug || null, fallbackSlug);
  if (json) process.stdout.write(JSON.stringify({ ok: true, branch }, null, 2) + "\n");
  else process.stdout.write(branch + "\n");
  return 0;
}

// ── Subcommand: prepare-branch ──────────────────────────────────────────────
//
// Mirrors write_spec_land.ts's `prepare-branch` (same three-way decision:
// existing local wins + ff-only, else track an existing remote, else create).
// Kept as its own copy rather than a shared import: the git side effects here
// are CLI-owned, not the pure decision (which copilot_land_lib.ts does not
// need to re-derive — the branch/PR existence checks below are what matter).

function cmdPrepareBranch(argv: string[]): number {
  const flags = parseFlags(
    argv,
    new Set(["json", "dry-run"]),
    new Set(["branch", "repo-dir", "require-base"]),
  );
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;
  const branch = str(flags, "branch");
  const cwd = str(flags, "repo-dir") || process.cwd();
  const requireBase = str(flags, "require-base");
  if (!branch) return fail(json, "--branch is required");
  // Present-but-empty must fail, not no-op: `--require-base "$UNSET_VAR"` would
  // otherwise disable every guard below while still reporting success.
  if (present(flags, "require-base") && !requireBase) {
    return fail(json, "--require-base requires a non-empty commit-ish", 1);
  }

  const localExists = localBranchExists(branch, cwd);
  const remoteExists = remoteBranchExists(branch, cwd);
  const action = localExists ? "checkout-ff" : remoteExists ? "checkout-track" : "create";

  // Validate the base BEFORE the dry-run return, so a preflight cannot green-light
  // a bogus SHA that the real run rejects.
  if (requireBase && git(["cat-file", "-e", `${requireBase}^{commit}`], cwd).code !== 0) {
    return fail(json, `--require-base ${requireBase} is not a commit in ${cwd}`, 1);
  }

  // Evaluate the guard in dry-run too, so the preflight verdict matches the real
  // one. Previously --dry-run returned ok:true for exactly the stale-remote case
  // the real invocation hard-refuses.
  if (dryRun) {
    let wouldRefuse: string | null = null;
    if (requireBase) {
      if (action === "checkout-track") {
        const c = refContains(`origin/${branch}`, requireBase, cwd);
        if (c === "no") wouldRefuse = `origin/${branch} does not contain ${requireBase}`;
        if (c === "unresolvable") {
          wouldRefuse = `origin/${branch} could not be resolved (fetch it first)`;
        }
      } else if (action === "checkout-ff") {
        const local = refContains(branch, requireBase, cwd);
        const remote = remoteExists ? refContains(`origin/${branch}`, requireBase, cwd) : "no";
        if (local !== "yes" && remote !== "yes") {
          wouldRefuse = `neither ${branch} nor origin/${branch} contains ${requireBase}`;
        }
      }
    }
    const plan = {
      ok: wouldRefuse === null,
      dry_run: true,
      branch,
      action,
      localExists,
      remoteExists,
      require_base: requireBase || null,
      would_refuse: wouldRefuse,
    };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return wouldRefuse === null ? 0 : 1;
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
    // Fetch FIRST (non-destructive) so the guard can see origin's tip, then guard,
    // then check out. `git checkout <branch>` relocates the worktree, so a stale
    // LOCAL branch must be refused BEFORE it runs — a post-condition alone leaves
    // the caller stranded on the wrong tree with a remedy naming a remote branch
    // that may not even exist.
    if (remoteExists) {
      const rf = runGit(["fetch", "origin", branch]);
      if (rf.code !== 0) return fail(json, `fetch origin ${branch} failed: ${rf.stderr}`, 1);
    }
    if (requireBase) {
      // The base may legitimately be absent from the local branch but present on
      // the remote — the ff-merge below brings it in. Refuse only when NEITHER
      // holds it, and report unresolvable refs as their own failure.
      const local = refContains(branch, requireBase, cwd);
      const remote = remoteExists ? refContains(`origin/${branch}`, requireBase, cwd) : "no";
      if (local === "unresolvable") {
        return fail(json, `cannot evaluate whether ${branch} contains ${requireBase}`, 1);
      }
      if (local !== "yes" && remote !== "yes") {
        return fail(
          json,
          `refusing to adopt local branch ${branch}: neither it nor ` +
            `${remoteExists ? `origin/${branch}` : "any remote counterpart"} contains ` +
            `${requireBase}. That local branch is stale (likely a leftover from an ` +
            `abandoned run); checking it out would move this worktree onto a codebase ` +
            `predating the requested base. Delete the local branch ` +
            `(git branch -D ${branch}) or re-pin, then retry. The worktree has not moved.`,
          1,
        );
      }
    }
    let r = runGit(["checkout", branch]);
    if (r.code !== 0) return fail(json, `checkout ${branch} failed: ${r.stderr}`, 1);
    if (remoteExists) {
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
    // Guard BEFORE the destructive `checkout -B`: that command resets HEAD onto
    // the remote branch, so a leftover branch from an abandoned run would
    // silently replace the caller's pinned base with an older codebase. Checked
    // here rather than only as a post-condition so the worktree is never moved.
    if (requireBase) {
      const c = refContains(`origin/${branch}`, requireBase, cwd);
      // "unresolvable" is NOT staleness — in a --single-branch/--depth clone the
      // fetch writes only FETCH_HEAD and refs/remotes/origin/<branch> never
      // exists. Reporting that as stale would tell the operator to delete a
      // healthy branch holding the previous run's pushed work.
      if (c === "unresolvable") {
        return fail(
          json,
          `cannot evaluate whether origin/${branch} contains ${requireBase}: the ref ` +
            `does not resolve locally (a --single-branch or --depth clone fetches ` +
            `into FETCH_HEAD without creating refs/remotes/origin/${branch}). This is ` +
            `NOT evidence that the branch is stale — do not delete it. Fetch it ` +
            `explicitly (git fetch origin ${branch}:refs/remotes/origin/${branch}) and retry.`,
          1,
        );
      }
      if (c === "no") {
        return fail(
          json,
          `refusing to adopt origin/${branch}: it does not contain ${requireBase}. ` +
            `That remote branch is stale (likely a leftover from an abandoned run) and ` +
            `adopting it would reset HEAD onto a codebase predating the requested base. ` +
            `Re-pin, or land this run on a suffixed branch (${branch}-2). Deleting ` +
            `origin/${branch} also works but CLOSES any open PR on it — losing review ` +
            `threads and posted findings. The worktree has not moved.`,
          1,
        );
      }
    }
    r = runGit(["checkout", "-B", branch, `origin/${branch}`]);
    if (r.code !== 0) return fail(json, `checkout tracking ${branch} failed: ${r.stderr}`, 1);
  } else {
    const r = runGit(["checkout", "-b", branch]);
    if (r.code !== 0) return fail(json, `create ${branch} failed: ${r.stderr}`, 1);
  }

  // Universal post-condition: whichever path ran, HEAD must contain the base.
  // Backstop only — every path above guards before it mutates the worktree.
  if (requireBase && refContains("HEAD", requireBase, cwd) !== "yes") {
    return fail(
      json,
      `branch ${branch} was prepared but HEAD does not contain ${requireBase} ` +
        `(action=${action}). Refusing to report success — every gate measured ` +
        `against this tree would be taken against the wrong codebase.`,
      1,
    );
  }

  const result = { ok: true, branch, action, steps, require_base: requireBase || null };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

// ── Subcommand: land ──────────────────────────────────────────────────────

async function cmdLand(argv: string[]): Promise<number> {
  const flags = parseFlags(
    argv,
    new Set(["json", "dry-run", "ready"]),
    new Set(["repo", "branch", "title", "body", "base", "lead", "known-prs", "repo-dir"]),
  );
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;
  const ready = flags["ready"] === true;
  const repo = str(flags, "repo");
  const branch = str(flags, "branch");
  const title = str(flags, "title");
  const body = str(flags, "body");
  const lead = str(flags, "lead") || "claude";
  const base = str(flags, "base") || "main";
  const cwd = str(flags, "repo-dir") || process.cwd();
  const knownPrsCsv = str(flags, "known-prs");

  if (!repo) return fail(json, "--repo OWNER/REPO is required");
  if (!branch) return fail(json, "--branch is required");
  if (!title) return fail(json, "--title is required");

  let knownPrs: number[];
  try {
    knownPrs = knownPrsCsv ? parsePrCsv(knownPrsCsv) : [];
  } catch (err) {
    return fail(json, (err as Error).message, 1);
  }

  const app = appForLead(lead);

  if (dryRun) {
    const plan = {
      ok: true,
      dry_run: true,
      repo,
      branch,
      base,
      lead,
      app,
      ready,
      title,
      known_prs: knownPrs,
    };
    process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    return 0;
  }

  const deps: LandDeps = {
    push: () => {
      const args = buildPushArgs(branch, hasUpstream(cwd));
      const r = git(args, cwd);
      return { ok: r.code === 0, stderr: r.stderr };
    },
    listOpenPrs: async () => (await prList(repo, "open", app)) as OpenPr[],
    // Opening the PR shells `gh` so it is authored by `aryeh-stark`, not by the
    // lead agent's GitHub App. Changed 2026-08-04: this used to call
    // `github_app_lib::prCreate`, which authors as `app/stark-<lead>[bot]` — a
    // PR Aryeh is considered to have opened must carry his name. `gh pr create`
    // prints the PR URL and offers no --json, so the number comes from the URL.
    createPr: async (opts) => {
      const argv = [
        "pr", "create",
        "--repo", repo,
        "--head", opts.head,
        "--base", opts.base,
        "--title", opts.title,
        "--body", opts.body,
      ];
      if (opts.draft) argv.push("--draft");
      const r = gh(argv, cwd);
      if (r.code !== 0) {
        throw new Error(`gh pr create failed: ${r.stderr || r.stdout}`);
      }
      const url = r.stdout.split("\n").map((l) => l.trim())
        .find((l) => /^https:\/\/github\.com\/.+\/pull\/\d+$/.test(l));
      const number = Number(url?.match(/\/pull\/(\d+)$/)?.[1]);
      if (!Number.isFinite(number)) {
        // Never invent a number — a wrong one makes every later step (comments,
        // ready, merge) act on somebody else's PR.
        throw new Error(
          `gh pr create succeeded but no PR URL was parseable from its output: ${r.stdout}`,
        );
      }
      return { number, html_url: url };
    },
    // App tokens cannot un-draft — shell 'gh pr ready' under the ambient user
    // (mirrors write_spec_land.ts).
    markReady: async (prNumber) => {
      const r = gh(["pr", "ready", String(prNumber), "--repo", repo], cwd);
      return { ok: r.code === 0, stderr: r.stderr };
    },
  };

  let result;
  try {
    result = await landImpl(
      { branch, base, title, body, lead, ready, hasUpstream: hasUpstream(cwd), knownPrs },
      deps,
    );
  } catch (err) {
    return fail(json, (err as Error).message, 1);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + "\n");
  } else {
    process.stdout.write(
      `landed impl on ${branch}: pr=#${result.pr.number} ` +
        `(${result.pr.adopted ? "adopted" : "created"}, ${result.pr.app}) prs=[${result.prs.join(",")}]\n`,
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
  if (rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (sub) {
      case "branch-name":
        return cmdBranchName(rest);
      case "prepare-branch":
        return cmdPrepareBranch(rest);
      case "land":
        return await cmdLand(rest);
      default:
        return fail(false, `unknown subcommand: ${sub}`);
    }
  } catch (err) {
    return fail(false, (err as Error).message);
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`copilot_land: unhandled: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
