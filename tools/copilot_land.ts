#!/usr/bin/env node
/**
 * copilot_land.ts — the create-or-adopt idempotent impl-PR landing CLI for
 * `/stark-copilot` (#773). This CLI owns EVERY git + PR side effect; the
 * deterministic decisions live in `copilot_land_lib.ts` (pure, unit-proven).
 *
 * `/stark-forge` treats `copilot` as the merge point for the `impl`
 * artifact — it cannot reach `done` without a non-empty `artifact_prs.impl`.
 * Copilot itself only commits locally (SKILL.md §2g); this CLI runs AFTER
 * that work is committed and lands it: adopt-or-create the impl branch,
 * push (never force), adopt-or-create the PR, report its number(s).
 *
 * Subcommands:
 *   branch-name    --plan-slug SLUG|"" --fallback-slug SLUG
 *                  Print deriveImplBranch(planSlug, fallbackSlug).
 *
 *   prepare-branch --branch NAME [--repo-dir DIR] [--dry-run] [--json]
 *                  Adopt-or-create the branch on the CURRENT checkout
 *                  (refuses a dirty tree; ff-only merge for an existing
 *                  local — a non-ff divergence is a HARD error, never
 *                  force). Mirrors `write_spec_land.ts prepare-branch`.
 *
 *   land           --repo O/R --branch NAME --title T --body TEXT
 *                  [--base main] [--lead claude|codex|gemini] [--ready]
 *                  [--known-prs "812,819"] [--repo-dir DIR]
 *                  [--dry-run] [--json]
 *                  Push the already-committed branch (never --force),
 *                  adopt an existing open PR for that head or open a
 *                  fresh one (draft by default, authored by the lead's
 *                  App), and print `{pr, prs}` — `prs` is the union of
 *                  `--known-prs` with the landed/adopted number.
 *
 * Arg-parsing house style mirrors `write_spec_land.ts` / `red_team_fold.ts`.
 */
import { spawnSync } from "node:child_process";
import { isMainModule } from "./main_module_lib.ts";
import { prCreate, prList, type AppName } from "./github_app_lib.ts";
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

function hasUpstream(cwd: string): boolean {
  return git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd).code === 0;
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────

const HELP = `usage: copilot_land.ts <subcommand> [options]

Create-or-adopt idempotent impl-PR landing helper for /stark-copilot.

subcommands:
  branch-name    --plan-slug SLUG --fallback-slug SLUG [--json]
                 Print the deterministic impl branch name.
  prepare-branch --branch NAME [--repo-dir DIR] [--dry-run] [--json]
                 Adopt-or-create the branch (ff-only; never force).
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
  const flags = parseFlags(argv, new Set(["json"]));
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
  const flags = parseFlags(argv, new Set(["json", "dry-run"]));
  const json = flags["json"] === true;
  const dryRun = flags["dry-run"] === true;
  const branch = str(flags, "branch");
  const cwd = str(flags, "repo-dir") || process.cwd();
  if (!branch) return fail(json, "--branch is required");

  const localExists = localBranchExists(branch, cwd);
  const remoteExists = remoteBranchExists(branch, cwd);
  const action = localExists ? "checkout-ff" : remoteExists ? "checkout-track" : "create";

  if (dryRun) {
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

// ── Subcommand: land ──────────────────────────────────────────────────────

async function cmdLand(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, new Set(["json", "dry-run", "ready"]));
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
    createPr: async (opts) =>
      (await prCreate(repo, {
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body,
        draft: opts.draft,
        app: opts.app,
      })) as { number: number; html_url?: string },
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
