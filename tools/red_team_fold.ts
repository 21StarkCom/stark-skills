#!/usr/bin/env node
/**
 * `/stark-red-team-fold` TS dispatcher (CLI).
 *
 * Thin wrapper over `runFold` (`tools/red_team_fold_lib.ts`, Task 10). runFold
 * resolves the fix-plan source (sidecar `Run ID` → audit DB `fix_plan_json`),
 * dispatches the least-privilege Claude decider, applies the accept/modify
 * patches, writes the revised artifact + `.fold.md` decision log, and audits
 * BEFORE any publish — but it never touches git.
 *
 * This CLI owns the git + PR side, in the one order that works:
 *   1. Call runFold with `openPr:false` — writes + audits, no PR.
 *   2. If a real doc diff landed (`status === "ok"` and the revised text
 *      differs from the original — i.e. at least one accept/modify), ensure a
 *      working branch, commit the artifact + `.fold.md`, push, THEN open/edit
 *      the fold PR via `openOrEditFoldPr` (GitHub API, authored by stark-claude,
 *      find-by-marker edit-or-create). `openOrEditFoldPr` needs the branch
 *      already pushed, which is why runFold cannot open the PR itself.
 *   3. All-rejected / no-diff folds skip the doc PR (the `.fold.md` is still on
 *      disk + audited; a comment on the existing red-team PR is a follow-up).
 * NEVER merges. `--dry-run` triages only (no writes, no git, no PR); `--no-pr`
 * lets runFold write + audit but the CLI does no git/PR.
 *
 * Usage:
 *   node --experimental-strip-types tools/red_team_fold.ts \
 *     --artifact path/to/design.md \
 *     [--source-spec path/to/spec.md] \
 *     [--fix-plan-json path/to/plan.json] \
 *     [--source-run-id RUN_ID] [--force-stale] \
 *     [--model claude-opus-4-8] \
 *     [--dry-run] [--no-pr] [--json]
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { detectRepo } from "./github_app_lib.ts";
import { resolveDb } from "./red_team_db_resolver.ts";
import {
  foldSidecarPathFor,
  openOrEditFoldPr,
  runFold,
  type FoldResult,
} from "./red_team_fold_lib.ts";

interface CliArgs {
  artifact: string;
  sourceSpec: string | null;
  fixPlanJson: string | null;
  sourceRunId: string | null;
  forceStale: boolean;
  model: string | null;
  dryRun: boolean;
  noPr: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    artifact: "",
    sourceSpec: null,
    fixPlanJson: null,
    sourceRunId: null,
    forceStale: false,
    model: null,
    dryRun: false,
    noPr: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--artifact":
        args.artifact = next();
        break;
      case "--source-spec":
        args.sourceSpec = next();
        break;
      case "--fix-plan-json":
        args.fixPlanJson = next();
        break;
      case "--source-run-id":
        args.sourceRunId = next();
        break;
      case "--force-stale":
        args.forceStale = true;
        break;
      case "--model":
        args.model = next();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--no-pr":
        args.noPr = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.artifact) {
    throw new Error("--artifact is required");
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`usage: red_team_fold.ts [-h] --artifact ARTIFACT
                        [--source-spec SOURCE_SPEC]
                        [--fix-plan-json FIX_PLAN_JSON]
                        [--source-run-id SOURCE_RUN_ID] [--force-stale]
                        [--model MODEL]
                        [--dry-run] [--no-pr] [--json]

Fold a red-team fix plan into its artifact (TS dispatcher).

Resolves the fix plan (--fix-plan-json > --source-run-id > adjacent
<artifact>.red-team.md sidecar's Run ID → audit DB), runs the Claude decider to
triage each move (accept/modify/reject), writes the revised artifact + a
<artifact>.fold.md decision log, audits BEFORE publishing, then — for a real doc
diff — commits + pushes the branch and opens/edits the fold PR. Never merges.

options:
  -h, --help                 show this help message and exit
  --artifact ARTIFACT        Path to the artifact (design/plan doc) to fold. Required.
  --source-spec SOURCE_SPEC  Optional source-spec file, folded into the prompt as context.
  --fix-plan-json PATH       Explicit fix-plan JSON file (overrides sidecar/DB resolution).
  --source-run-id RUN_ID     Name the prior red-team run whose fix plan to fold (DB fallback).
  --force-stale              Fold even when the fix plan's artifact hash no longer matches.
  --model MODEL              Override the decider model (Claude CLI only; default red_team.fold.model).
  --dry-run                  Triage only — no writes, no audit, no git, no PR.
  --no-pr                    runFold still writes + audits; the CLI does no git/PR.
  --json                     Emit the FoldResult (+ artifact/branch/pr_url) as JSON on stdout.
`);
}

// ── git helpers (the CLI owns the git side; runFold never touches git) ──────

function git(gitArgs: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", gitArgs, { cwd, encoding: "utf8", timeout: 30_000 });
  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function gitToplevel(cwd: string): string | null {
  const r = git(["rev-parse", "--show-toplevel"], cwd);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

function defaultBranch(cwd: string): string {
  const r = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (r.code === 0 && r.stdout) return r.stdout.replace(/^origin\//, "");
  return "main";
}

function currentBranch(cwd: string): string {
  const r = git(["branch", "--show-current"], cwd);
  return r.code === 0 ? r.stdout : "";
}

function timestampSlug(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function emitError(json: boolean, message: string): void {
  if (json) {
    process.stdout.write(JSON.stringify({ status: "error", error: message }, null, 2) + "\n");
  } else {
    process.stderr.write(`red_team_fold: ${message}\n`);
  }
}

type Envelope = FoldResult & {
  artifact: string;
  branch: string | null;
  pr_url: string | null;
};

function printSummary(
  env: Envelope,
  ctx: { dryRun: boolean; noPr: boolean; realDiff: boolean; foldLogPath: string },
): void {
  process.stdout.write(`Status:           ${env.status}\n`);
  process.stdout.write(`Source run:       ${env.source_run_id || "—"}\n`);
  process.stdout.write(`Decider model:    ${env.decider_model}\n`);
  if (env.status === "ok") {
    process.stdout.write(
      `Dispositions:     ${env.applied_count} accepted / ${env.modified_count} modified / ` +
        `${env.rejected_count} rejected / ${env.apply_failed_count} apply-failed\n`,
    );
    process.stdout.write(
      `Cost / duration:  $${env.cost_usd.toFixed(4)} / ${env.duration_s.toFixed(1)}s\n`,
    );
    if (ctx.dryRun) {
      process.stdout.write(`(dry-run — no writes, no audit, no git, no PR)\n`);
    } else {
      process.stdout.write(`Decision log:     ${ctx.foldLogPath}\n`);
      if (!ctx.realDiff) {
        process.stdout.write(
          `Note:             no doc changes landed (all moves rejected/failed); ` +
            `decision log + audit written, doc PR skipped\n`,
        );
      } else if (ctx.noPr) {
        process.stdout.write(`Note:             --no-pr — artifact + decision log written + audited; no git/PR\n`);
      }
    }
  } else {
    process.stdout.write(`(no fold applied — see status above)\n`);
  }
  if (env.branch) process.stdout.write(`Branch:           ${env.branch}\n`);
  if (env.pr_url) process.stdout.write(`PR:               ${env.pr_url}\n`);
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    emitError(false, (err as Error).message);
    return 2;
  }

  const artifactPath = path.resolve(args.artifact);
  if (!fs.existsSync(artifactPath)) {
    emitError(args.json, `artifact file not found: ${artifactPath}`);
    return 2;
  }

  const sourceSpecPath = args.sourceSpec ? path.resolve(args.sourceSpec) : null;
  if (sourceSpecPath && !fs.existsSync(sourceSpecPath)) {
    emitError(args.json, `source-spec file not found: ${sourceSpecPath}`);
    return 2;
  }

  let explicitFixPlanJson: string | null = null;
  if (args.fixPlanJson) {
    const fpPath = path.resolve(args.fixPlanJson);
    if (!fs.existsSync(fpPath)) {
      emitError(args.json, `fix-plan-json file not found: ${fpPath}`);
      return 2;
    }
    explicitFixPlanJson = fs.readFileSync(fpPath, "utf8");
  }

  const sourceSpec = sourceSpecPath ? fs.readFileSync(sourceSpecPath, "utf8") : null;

  // Repo-relative artifact path (marker/log/audit); falls back to basename.
  const cwd = path.dirname(artifactPath);
  const repoRoot = gitToplevel(cwd);
  const artifactRelPath = repoRoot
    ? path.relative(repoRoot, artifactPath)
    : path.basename(artifactPath);

  // Capture the pre-fold text BEFORE runFold overwrites the artifact on disk,
  // so we can tell a real diff (accept/modify) from a no-op (all-rejected) fold.
  const originalArtifact = fs.readFileSync(artifactPath, "utf8");

  const dbPath = resolveDb(null).db_path;
  const repo = detectRepo() || null;

  // 1) runFold with openPr:false — writes revised artifact + .fold.md + audits
  //    (unless --dry-run), but NEVER opens a PR. The CLI owns git + PR because
  //    openOrEditFoldPr needs the branch pushed with the diff first.
  let result: FoldResult;
  try {
    result = await runFold({
      artifactPath,
      dbPath,
      dryRun: args.dryRun,
      openPr: false,
      explicitFixPlanJson,
      sourceRunId: args.sourceRunId,
      forceStale: args.forceStale,
      model: args.model ?? undefined,
      sourceSpec,
      artifactRelPath,
      repo,
      prNumber: null,
    });
  } catch (err) {
    emitError(args.json, `fold failed: ${(err as Error).message}`);
    return 1;
  }

  const foldLogPath = foldSidecarPathFor(artifactPath);

  // 2) Git + PR — only for a real doc diff, and only when not --dry-run/--no-pr.
  let branch: string | null = null;
  let prUrl: string | null = result.pr_url;
  const realDiff = result.status === "ok" && result.revised_doc !== originalArtifact;
  const doPr = !args.dryRun && !args.noPr && realDiff;

  if (doPr) {
    const root = repoRoot ?? cwd;
    try {
      // 2a) Ensure a working branch — never commit to the default branch.
      const def = defaultBranch(root);
      const cur = currentBranch(root);
      if (!cur || cur === def) {
        const stem = path.basename(artifactPath).replace(/\.[^.]+$/, "");
        branch = `red-team-fold/${stem}-${timestampSlug()}`;
        const sw = git(["switch", "-c", branch], root);
        if (sw.code !== 0) throw new Error(`git switch failed: ${sw.stderr}`);
      } else {
        branch = cur;
      }

      // 2b) Stage + commit the artifact + decision log (path-pathspec, never -a;
      //     author + trailer per workspace policy). The explicit `git add` is
      //     required for a first-time `.fold.md` — `git commit -- <pathspec>`
      //     errors on an untracked path.
      git(["add", "--", artifactPath, foldLogPath], root);
      const msg =
        `fold: ${artifactRelPath} (${result.applied_count}/${result.modified_count}/${result.rejected_count})\n\n` +
        `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`;
      const commit = git(["commit", "-m", msg, "--", artifactPath, foldLogPath], root);
      if (commit.code !== 0) {
        process.stderr.write(
          `red_team_fold: git commit failed (fold already written + audited): ${commit.stderr}\n`,
        );
      }

      // 2c) Push + open/edit the PR (best-effort; the commit is durable locally).
      if (!repo) {
        process.stderr.write(`red_team_fold: no origin remote — committed locally, skipping PR\n`);
      } else if (commit.code !== 0) {
        process.stderr.write(`red_team_fold: nothing committed — skipping push + PR\n`);
      } else {
        const push = git(["push", "-u", "origin", "HEAD"], root);
        if (push.code !== 0) {
          process.stderr.write(`red_team_fold: git push failed (skipping PR): ${push.stderr}\n`);
        } else {
          const foldLog = fs.existsSync(foldLogPath) ? fs.readFileSync(foldLogPath, "utf8") : "";
          // Marker matches runFold's exactly so the find-by-marker comment is
          // idempotent across reruns (edit-or-create one fold comment per PR).
          const marker = `<!-- stark-red-team-fold: source_run_id=${result.source_run_id} artifact=${artifactRelPath} -->`;
          const pr = await openOrEditFoldPr({
            repo,
            marker,
            body: `${marker}\n\n${foldLog}`,
            branch,
            base: def,
            prNumber: null,
            artifactRelPath,
            sourceRunId: result.source_run_id,
            app: "stark-claude",
          });
          prUrl = pr.pr_url;
        }
      }
    } catch (err) {
      process.stderr.write(
        `red_team_fold: git/PR step failed (fold already written + audited): ${(err as Error).message}\n`,
      );
    }
  }

  // 3) Output.
  const envelope: Envelope = { ...result, artifact: artifactPath, branch, pr_url: prUrl };
  if (args.json) {
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    printSummary(envelope, { dryRun: args.dryRun, noPr: args.noPr, realDiff, foldLogPath });
  }

  if (result.status === "decider_dispatch_failed") return 1;
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`red_team_fold: unhandled: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
