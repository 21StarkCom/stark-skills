#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Exit } from "./lib/exit.ts";
import { stateFile, lockFile, ensurePrDir } from "./lib/watcher_paths.ts";
import { die, printJson } from "./lib/output.ts";
import { readPlan, writePlan, type Plan } from "./lib/plan.ts";
import { diffFingerprints, fingerprintFromInputs, fingerprintsMatch } from "./lib/state.ts";
import * as gitLib from "./lib/git.ts";
import * as ghLib from "./lib/gh.ts";
import type { Candidate, ExecFn, Provenance } from "./lib/types.ts";
import { downgradeLlmCloses, extractCandidates, formatLine } from "./lib/issue.ts";
import { scanSecrets } from "./lib/secret.ts";
import { mktempInRuntime } from "./lib/runtime.ts";
import { fetchBase } from "./gh_pr_open_preflight.ts";
import { appendSecretOverride } from "./lib/audit.ts";

export function reverifyState(plan: Plan, opts: { exec?: ExecFn } = {}): void {
  const headOid = gitLib.headOid(opts);
  const indexBytes = gitLib.diffCached(opts);
  const status = gitLib.statusPorcelain(opts);
  const branch = gitLib.currentBranch(opts);
  const repo = ghLib.repoView(opts);
  const existingPrSha = plan.existingPr ? ghLib.prView(plan.existingPr.number, opts).headRefOid : null;
  const worktreeContentBytes = plan.userArgs.commitAll
    ? gitLib.git(["diff", "--binary"], opts) + plan.tree.dirtyFiles.untracked.map(p => gitLib.hashUntrackedFile(p)).join("")
    : null;
  const actual = fingerprintFromInputs({
    headOid,
    indexBytes,
    // Always hash the live worktree status so a clean -> dirty transition
    // between preflight and execute is detected as drift.
    worktreeBytes: status,
    worktreeContentBytes,
    existingPrSha,
    baseOid: plan.baseOid,
    branch,
    repoNameWithOwner: repo.nameWithOwner,
  });
  if (!fingerprintsMatch(plan.stateFingerprint, actual)) {
    const fields = diffFingerprints(plan.stateFingerprint, actual).join(", ");
    throw new Error(`state changed between preflight and execute (${fields}); rerun /stark-gh:pr-open`);
  }
}

export function stageChanges(plan: Plan, opts: { exec?: ExecFn } = {}): void {
  if (!plan.stage3.willCommit) return;
  if (plan.stage3.commitStrategy === "commit-all") gitLib.add(["-A"], opts);
  if (plan.stage3.commitStrategy === "staged-only") {
    const cached = gitLib.diffCached(opts);
    if (!cached.trim()) throw new Error("nothing-staged");
  }
}

export function postStageSecretScan(plan: Plan, opts: { exec?: ExecFn } = {}): void {
  const cached = gitLib.diffCached(opts);
  const hits = scanSecrets(cached);
  if (hits.length === 0) return;
  if (!plan.userArgs.allowSecretCommit) {
    const cats = [...new Set(hits.map(h => h.category))].join(", ");
    throw new Error(`post-stage-secret-hit:${cats}`);
  }
  // Override is in effect: append a durable audit record so the bypass
  // survives plan-file deletion (spec rt2-r2).
  appendSecretOverride({
    timestamp: new Date().toISOString(),
    stage: "post-stage",
    allowSecretCommit: plan.userArgs.allowSecretCommit,
    allowSecretToLlm: plan.userArgs.allowSecretToLlm,
    branch: plan.branch,
    repoNameWithOwner: plan.repo.nameWithOwner,
    hits: hits.map(h => ({ category: h.category, location: `line ${h.lineNumber}` })),
  });
}

export interface LateLines {
  closesLines: string[];
  refsLines: string[];
  lateCandidates: Candidate[];
}

export function extractLateLines(
  commitMessageFile: string,
  baseRepo: { owner: string; name: string },
  preflightCandidates: Candidate[],
  provenance: Provenance,
  ghLike: { issueExists: (owner: string, repo: string, n: number) => boolean },
): LateLines {
  const text = fs.readFileSync(commitMessageFile, "utf8");
  const candidates = downgradeLlmCloses(extractCandidates({ branch: "", commits: text, baseRepo, provenance }));
  const seen = new Set(preflightCandidates.map(c => `${c.owner}/${c.repo}#${c.number}`));
  const fresh: Candidate[] = [];
  for (const c of candidates) {
    const key = `${c.owner}/${c.repo}#${c.number}`;
    if (seen.has(key)) continue;
    if (!ghLike.issueExists(c.owner, c.repo, c.number)) continue;
    fresh.push({ ...c, verified: true });
  }
  const closesLines: string[] = [];
  const refsLines: string[] = [];
  for (const c of fresh) {
    const line = formatLine(c, baseRepo);
    if (c.relation === "Closes" && c.owner === baseRepo.owner && c.repo === baseRepo.name) closesLines.push(line);
    else refsLines.push(line);
  }
  return { closesLines, refsLines, lateCandidates: fresh };
}

export function pushBranch(
  input: { branch: string; repo: { owner: string; name: string; host?: string } },
  opts: { exec?: ExecFn } = {},
): string {
  const url = gitLib.originUrl(opts);
  if (!url || !ghLib.originMatches(input.repo, url)) {
    const expected = input.repo.host
      ? `${input.repo.host}/${input.repo.owner}/${input.repo.name}`
      : `${input.repo.owner}/${input.repo.name}`;
    throw new Error(`origin URL '${url ?? "(none)"}' doesn't match expected '${expected}'`);
  }
  gitLib.pushExplicit(input.branch, opts);
  return gitLib.headOid(opts);
}

export function assembleBody(input: { bodyFile: string; closesLines: string[]; refsLines: string[] }): string {
  const body = fs.readFileSync(input.bodyFile, "utf8").replace(/\s+$/g, "");
  const lines = [...input.closesLines, ...input.refsLines];
  const merged = lines.length === 0 ? body + "\n" : body + "\n\n" + lines.join("\n") + "\n";
  // Always write to a fresh tempfile. Returning input.bodyFile would mean the
  // execute cleanup path unlinks the user's --body-file argument.
  const out = mktempInRuntime("stark-gh-body-XXXXXX.md");
  fs.writeFileSync(out, merged, { mode: 0o600 });
  return out;
}

function ensureCommitMessageFile(plan: Plan): string | null {
  if (plan.stage2.outputs.commitMessageFile) return plan.stage2.outputs.commitMessageFile;
  if (plan.userArgs.commitMessageFile) return plan.userArgs.commitMessageFile;
  if (plan.userArgs.commitMessage) {
    const f = mktempInRuntime("user-commit-XXXXXX.txt");
    fs.writeFileSync(f, plan.userArgs.commitMessage, { mode: 0o600 });
    return f;
  }
  return null;
}

function titleFromPlan(plan: Plan): string {
  if (plan.stage2.outputs.titleFile) return fs.readFileSync(plan.stage2.outputs.titleFile, "utf8").trim();
  if (plan.userArgs.title) return plan.userArgs.title;
  return plan.existingPr?.title ?? "";
}

function bodyFileFromPlan(plan: Plan): string | null {
  if (plan.stage2.outputs.bodyFile) return plan.stage2.outputs.bodyFile;
  if (plan.userArgs.bodyFile) return plan.userArgs.bodyFile;
  if (plan.userArgs.body) {
    const f = mktempInRuntime("user-body-XXXXXX.md");
    fs.writeFileSync(f, plan.userArgs.body, { mode: 0o600 });
    return f;
  }
  return null;
}

export type SpawnFn = (
  command: string,
  argv: readonly string[],
  options: { detached: boolean; stdio: "ignore" },
) => { pid?: number; unref(): void };

export function spawnWatcher(
  args: {
    host: string;
    owner: string;
    repo: string;
    pr: number;
    headSha: string;
  },
  deps: { spawnFn?: SpawnFn } = {},
): { pid: number | null; stateFile: string | null; alreadyRunning: boolean } {
  ensurePrDir(args.host, args.owner, args.repo, args.pr);
  const sf = stateFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lf = lockFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  if (fs.existsSync(lf)) {
    try {
      const lock = JSON.parse(fs.readFileSync(lf, "utf8"));
      if (lock?.headSha === args.headSha && typeof lock.pid === "number") {
        try {
          process.kill(lock.pid, 0);
          return { pid: null, stateFile: sf, alreadyRunning: true };
        } catch {
          // Stale lock; gh_watch_runs will reclaim it.
        }
      }
    } catch {
      // Malformed lock; gh_watch_runs will reclaim it.
    }
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const watcher = path.join(here, "gh_watch_runs.ts");
  const spawnFn = deps.spawnFn ?? ((cmd, argv, options) => spawn(cmd, argv as string[], options));
  const child = spawnFn(
    process.execPath,
    [
      "--experimental-strip-types",
      watcher,
      "--host",
      args.host,
      "--repo",
      `${args.owner}/${args.repo}`,
      "--pr",
      String(args.pr),
      "--head-sha",
      args.headSha,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return { pid: child.pid ?? null, stateFile: sf, alreadyRunning: false };
}

function cleanupFile(p?: string | null): void {
  if (!p) return;
  try {
    fs.unlinkSync(p);
  } catch {
    // Best effort cleanup.
  }
}

function main(): never {
  const argv = process.argv.slice(2);
  const planIdx = argv.indexOf("--plan-file");
  if (planIdx < 0) die(Exit.PLAN_FILE_INVALID, "missing --plan-file");
  const planPath = argv[planIdx + 1]!;
  let plan: Plan;
  try {
    plan = readPlan(planPath);
  } catch (e) {
    die(Exit.PLAN_FILE_INVALID, `invalid plan-file: ${(e as Error).message}`);
  }

  try {
    reverifyState(plan);
  } catch (e) {
    die(Exit.STATE_DRIFT, String((e as Error).message));
  }

  try {
    stageChanges(plan);
  } catch (e) {
    if (String((e as Error).message) === "nothing-staged") {
      die(Exit.NOTHING_STAGED, "nothing staged under --staged-only; `git add` what you want, or drop --staged-only to stage everything");
    }
    throw e;
  }
  try {
    postStageSecretScan(plan);
  } catch (e) {
    die(Exit.SECRET_HIT_POST_STAGE, String((e as Error).message));
  }

  const commitMessageFile = ensureCommitMessageFile(plan);
  if (commitMessageFile) {
    const provenance: Provenance = plan.userArgs.commitMessage || plan.userArgs.commitMessageFile ? "user-provided" : "llm-drafted";
    const late = extractLateLines(
      commitMessageFile,
      { owner: plan.repo.owner, name: plan.repo.name },
      plan.candidateIssues.preflight,
      provenance,
      { issueExists: (o, r, n) => ghLib.issueExists(o, r, n) },
    );
    plan.closesLines.late = late.closesLines;
    plan.refsLines.late = late.refsLines;
    plan.candidateIssues.lateFromCommitMessage = late.lateCandidates;
    writePlan(planPath, plan);
  }

  if (plan.stage3.willCommit) {
    if (!commitMessageFile) die(Exit.PLAN_FILE_INVALID, "willCommit but no commit message file");
    gitLib.commitWithMessageFile(commitMessageFile);
  }

  let headSha = gitLib.headOid();
  if (plan.stage3.willPush) {
    try {
      headSha = pushBranch({
        branch: plan.branch,
        repo: { owner: plan.repo.owner, name: plan.repo.name, host: plan.repo.host },
      });
    } catch (e) {
      if (/origin URL/.test(String((e as Error).message))) die(Exit.ORIGIN_MISMATCH, String((e as Error).message));
      die(Exit.PUSH_FAILED, String((e as Error).message));
    }
  }

  const closesAll = [...(plan.closesLines.preflight ?? []), ...(plan.closesLines.late ?? [])];
  const refsAll = [...(plan.refsLines.preflight ?? []), ...(plan.refsLines.late ?? [])];
  let prNumber = plan.existingPr?.number ?? null;
  let prUrl = plan.existingPr?.url ?? "";
  let mergedBodyFile: string | null = null;

  // Per spec rt6-r3: re-fetch and verify baseOid immediately before the
  // mutating gh call, not earlier. Stage/commit/push can take seconds and
  // the remote base can move during them.
  if (plan.stage3.action !== "push-only") {
    const fresh = fetchBase(plan.baseBranch);
    if (fresh.baseOid !== plan.baseOid) {
      die(
        Exit.BASE_OID_DRIFT,
        `base branch moved upstream (was ${plan.baseOid}, now ${fresh.baseOid}); rerun /stark-gh:pr-open`,
      );
    }
  }

  if (plan.stage3.action === "create") {
    try {
      const bodyFile = bodyFileFromPlan(plan);
      if (!bodyFile) die(Exit.PLAN_FILE_INVALID, "create action needs body file");
      mergedBodyFile = assembleBody({ bodyFile, closesLines: closesAll, refsLines: refsAll });
      ghLib.prCreate({
        title: titleFromPlan(plan),
        bodyFile: mergedBodyFile,
        base: plan.baseBranch,
        reviewers: plan.userArgs.reviewer,
        labels: plan.userArgs.label,
        assignees: plan.userArgs.assignee,
        draft: plan.userArgs.draft,
      });
    } catch (e) {
      die(Exit.GH_PR_CREATE_FAILED, String((e as Error).message));
    }
  } else if (plan.stage3.action === "edit") {
    try {
      const args: Parameters<typeof ghLib.prEdit>[1] = {};
      if (plan.stage3.willEditTitle) args.title = titleFromPlan(plan);
      if (plan.stage3.willEditBody) {
        const bodyFile = bodyFileFromPlan(plan);
        if (bodyFile) {
          mergedBodyFile = assembleBody({ bodyFile, closesLines: closesAll, refsLines: refsAll });
          args.bodyFile = mergedBodyFile;
        }
      }
      if (plan.userArgs.reviewer.length) args.addReviewers = plan.userArgs.reviewer;
      if (plan.userArgs.label.length) args.addLabels = plan.userArgs.label;
      if (plan.userArgs.assignee.length) args.addAssignees = plan.userArgs.assignee;
      ghLib.prEdit(plan.existingPr!.number, args);
    } catch (e) {
      die(Exit.GH_PR_EDIT_FAILED, String((e as Error).message));
    }
  }

  if (prNumber === null) {
    const pr = ghLib.findOpenPrForBranch(plan.branch);
    if (pr) {
      prNumber = pr.number;
      prUrl = pr.url;
    }
  } else if (!prUrl) {
    const v = ghLib.prView(prNumber);
    prUrl = v.url;
  }

  if (prNumber === null) {
    die(
      Exit.PR_NOT_RESOLVED,
      `gh pr create reported success but no open PR was found for branch '${plan.branch}'; cannot start watcher or report URL`,
    );
  }

  const watcher = plan.userArgs.noWatch
    ? { pid: null, stateFile: null, alreadyRunning: false }
    : spawnWatcher({
        host: plan.repo.host,
        owner: plan.repo.owner,
        repo: plan.repo.name,
        pr: prNumber,
        headSha,
      });
  printJson({
    action: plan.stage3.action === "create" ? "created" : plan.stage3.action === "edit" ? "updated" : "pushed-only",
    prNumber,
    prUrl,
    headSha,
    watcherPid: watcher.pid,
    watcherStateFile: watcher.stateFile,
    watcherAlreadyRunning: watcher.alreadyRunning,
  });

  cleanupFile(plan.stage2.outputs.titleFile);
  cleanupFile(plan.stage2.outputs.bodyFile);
  cleanupFile(plan.stage2.outputs.commitMessageFile);
  cleanupFile(mergedBodyFile);
  cleanupFile(planPath);
  process.exit(0);
}

if (process.argv[1]?.endsWith("gh_pr_open_execute.ts")) main();
