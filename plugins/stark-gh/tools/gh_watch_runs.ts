#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { stateFile, lockFile, latestPointer, ensurePrDir, atomicWriteJson } from "./lib/watcher_paths.ts";
import * as ghLib from "./lib/gh.ts";
import { fetchRequiredCheckRollup, summarizeVerdict, isGreen, type Context } from "./lib/checks_graphql.ts";
import { resolveCallback } from "./lib/watcher_callbacks.ts";
import { readPrMergePlan, type PrMergePlan } from "./lib/plan.ts";
import type { WatcherKind } from "./lib/watcher_lock.ts";

export interface LockFileContent {
  pid: number;
  startedAt: string;
  headSha: string;
  command: "gh-watch-runs";
  ownerToken: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(
  filepath: string,
  args: { headSha: string },
): { acquired: boolean; alreadyRunning?: boolean; ownerToken?: string } {
  // Inspect first; if a live owner holds it for our headSha, defer.
  if (fs.existsSync(filepath)) {
    try {
      const c: LockFileContent = JSON.parse(fs.readFileSync(filepath, "utf8"));
      if (c.command === "gh-watch-runs" && c.headSha === args.headSha && pidAlive(c.pid)) {
        return { acquired: false, alreadyRunning: true };
      }
    } catch {
      // Malformed lock is stale.
    }
  }
  const ownerToken = crypto.randomUUID();
  const content: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    headSha: args.headSha,
    command: "gh-watch-runs",
    ownerToken,
  };
  // Per-process tempfile to avoid two concurrent acquirers stomping the same
  // .tmp path; then atomic O_EXCL link to win the race deterministically.
  const tmp = `${filepath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(content), { mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.linkSync(tmp, filepath);
      fs.unlinkSync(tmp);
      return { acquired: true, ownerToken };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
        throw err;
      }
      // Re-read existing lock; defer if still held by a live owner.
      try {
        const c: LockFileContent = JSON.parse(fs.readFileSync(filepath, "utf8"));
        if (c.command === "gh-watch-runs" && c.headSha === args.headSha && pidAlive(c.pid)) {
          fs.unlinkSync(tmp);
          return { acquired: false, alreadyRunning: true };
        }
      } catch {
        // Malformed: fall through to take it over.
      }
      try { fs.unlinkSync(filepath); } catch { /* race ok */ }
    }
  }
  try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
  return { acquired: false };
}

// Mirror an active per-SHA lock to the per-PR latest.json.lock pointer in the
// LockRecord shape that lib/watcher_lock.ts (used by pr-merge preflight)
// expects. This bridges the two lock contracts so preflight's recovery check
// can detect a live watcher without having to enumerate per-SHA locks.
//
// Best-effort: if the mirror write fails (disk full, permissions), the
// per-SHA lock still protects against a duplicate watcher; preflight will
// just lose its fast-path attach signal.
export function mirrorLockToLatest(
  latestLockPath: string,
  perShaLockContent: LockFileContent,
  kind: Exclude<WatcherKind, "unknown">,
): void {
  try {
    // The mirror lock is consumed by lib/watcher_lock.ts.evaluateLockLiveness,
    // which compares `startedAt` to `ps -o lstart= -p <pid>`. We must write the
    // ps lstart string here — not an ISO timestamp — or every live watcher
    // looks like PID reuse and preflight always re-spawns instead of attaching.
    const lstart = (() => {
      try {
        return execFileSync("ps", ["-o", "lstart=", "-p", String(perShaLockContent.pid)], {
          stdio: ["pipe", "pipe", "pipe"],
        }).toString("utf8").trim();
      } catch {
        return "";
      }
    })();
    if (!lstart) return; // Without lstart the mirror can't pass liveness — skip.
    const record = {
      pid: perShaLockContent.pid,
      startedAt: lstart,
      hostname: os.hostname(),
      ownerToken: perShaLockContent.ownerToken,
      kind,
    };
    const tmp = `${latestLockPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    try { fs.unlinkSync(latestLockPath); } catch { /* may not exist */ }
    fs.renameSync(tmp, latestLockPath);
  } catch {
    // Best-effort mirror; per-SHA lock remains the source of truth.
  }
}

export function releaseMirrorLatestLock(latestLockPath: string, ownerToken: string): void {
  if (!fs.existsSync(latestLockPath)) return;
  try {
    const c = JSON.parse(fs.readFileSync(latestLockPath, "utf8")) as { ownerToken?: string };
    if (c.ownerToken === ownerToken) fs.unlinkSync(latestLockPath);
  } catch {
    // Malformed mirror lock — leave it; preflight's liveness check will treat
    // unknown shapes as live (conservative) which is fine for one stale write.
  }
}

export function releaseLockIfOwner(filepath: string, ownerToken: string): void {
  if (!fs.existsSync(filepath)) return;
  try {
    const c: LockFileContent = JSON.parse(fs.readFileSync(filepath, "utf8"));
    if (c.ownerToken === ownerToken) fs.unlinkSync(filepath);
  } catch {
    // Leave malformed lock for the next acquisition path.
  }
}

export function* backoffSchedule(initial: number, cap: number): Generator<number> {
  for (let i = 0; i < 5; i++) yield initial;
  let cur = initial * 2;
  while (true) {
    yield cur;
    cur = Math.min(cur * 2, cap);
    if (cur === cap) break;
  }
  while (true) yield cap;
}

interface CheckRecord {
  state?: string;
  conclusion?: string | null;
}

export function isTerminal(checks: CheckRecord[]): boolean {
  if (checks.length === 0) return false;
  return checks.every(c => {
    const state = String(c.state ?? c.conclusion ?? "").toUpperCase();
    return state !== "" && !["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(state);
  });
}

export function summarize(checks: CheckRecord[]) {
  const counts = { total: checks.length, success: 0, failure: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const r of checks) {
    const state = String(r.state ?? r.conclusion ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "PASS") counts.success++;
    else if (state === "FAILURE" || state === "FAIL" || state === "ERROR" || state === "ACTION_REQUIRED" || state === "TIMED_OUT") counts.failure++;
    else if (state === "CANCELLED" || state === "CANCELED") counts.cancelled++;
    else if (state === "SKIPPED") counts.skipped++;
    else if (state === "NEUTRAL") counts.neutral++;
  }
  return counts;
}

interface CliArgs {
  host: string;
  owner: string;
  repo: string;
  pr: number;
  headSha: string;
  maxMinutes: number;
  initialPollSeconds: number;
  maxPollSeconds: number;
  noChecksGraceMinutes: number;
}

function parseArgs(argv: string[]): CliArgs {
  const get = (flag: string, def?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0) {
      if (def !== undefined) return def;
      throw new Error(`missing ${flag}`);
    }
    return argv[i + 1]!;
  };
  const repo = get("--repo");
  const [owner, repoName] = repo.split("/");
  return {
    host: get("--host"),
    owner: owner!,
    repo: repoName!,
    pr: Number(get("--pr")),
    headSha: get("--head-sha"),
    maxMinutes: Number(get("--max-minutes", "30")),
    initialPollSeconds: Number(get("--initial-poll-seconds", "15")),
    maxPollSeconds: Number(get("--max-poll-seconds", "240")),
    noChecksGraceMinutes: Number(get("--no-checks-grace-minutes", "5")),
  };
}

function notifyDone(summary: ReturnType<typeof summarize>, pr: number): void {
  try {
    const msg = `PR #${pr}: ${summary.success} success, ${summary.failure} failure, ${summary.cancelled} cancelled`;
    execFileSync("osascript", ["-e", `display notification "${msg.replace(/"/g, "")}" with title "stark-gh"`], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // Best effort only.
  }
}

async function mainAsync(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  ensurePrDir(args.host, args.owner, args.repo, args.pr);

  const sf = stateFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lf = lockFile(args.host, args.owner, args.repo, args.pr, args.headSha);
  const lock = acquireLock(lf, { headSha: args.headSha });
  if (lock.alreadyRunning) {
    process.stderr.write(`watcher already running for PR #${args.pr} @ ${args.headSha}\n`);
    process.exit(0);
  }
  const ownerToken = lock.ownerToken!;
  // Mirror to latest.json.lock so pr-merge preflight's recovery check sees us.
  const latestLockMain = latestPointer(args.host, args.owner, args.repo, args.pr) + ".lock";
  mirrorLockToLatest(latestLockMain, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    headSha: args.headSha,
    command: "gh-watch-runs",
    ownerToken,
  }, "ci-observer");
  // Wrapper to release per-SHA + mirror locks together at every exit point.
  const releaseAll = (): void => {
    releaseLockIfOwner(lf, ownerToken);
    releaseMirrorLatestLock(latestLockMain, ownerToken);
  };

  atomicWriteJson(sf, {
    schemaVersion: 1,
    command: "gh-watch-runs",
    host: args.host,
    repo: `${args.owner}/${args.repo}`,
    pr: args.pr,
    headSha: args.headSha,
    status: "watching",
    startedAt: new Date().toISOString(),
    lastPolledAt: null,
    nextPollAt: new Date().toISOString(),
    lastError: null,
    checks: [],
    summary: null,
  });

  const start = Date.now();
  const sched = backoffSchedule(args.initialPollSeconds, args.maxPollSeconds);
  let consecErrors = 0;
  let firstSeenAt: number | null = null;

  while (true) {
    const elapsedMin = (Date.now() - start) / 60000;
    if (elapsedMin > args.maxMinutes) {
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, { ...cur, status: "timeout", finishedAt: new Date().toISOString() });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "timeout",
        updatedAt: new Date().toISOString(),
      });
      releaseAll();
      process.exit(0);
    }

    let checks: CheckRecord[] = [];
    let pollError: Error | null = null;
    try {
      const currentHead = ghLib.prHeadOid(args.pr, args.owner, args.repo);
      if (currentHead !== args.headSha) {
        const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
        atomicWriteJson(sf, {
          ...cur,
          status: "superseded",
          supersededBy: currentHead,
          finishedAt: new Date().toISOString(),
        });
        // Do not touch latest.json: the newer watcher (or its caller) owns
        // that pointer for currentHead. Overwriting from here would clobber
        // a fresher status with our terminal "superseded" record.
        releaseAll();
        process.exit(0);
      }
      const raw = ghLib.prChecks(args.pr, args.owner, args.repo) as CheckRecord[];
      checks = raw;
      consecErrors = 0;
    } catch (e) {
      pollError = e as Error;
    }
    if (pollError !== null) {
      consecErrors++;
      if (consecErrors >= 5) {
        const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
        atomicWriteJson(sf, {
          ...cur,
          status: "error",
          lastError: String(pollError.message),
          finishedAt: new Date().toISOString(),
        });
        releaseAll();
        process.exit(1);
      }
    }

    if (checks.length > 0) firstSeenAt ??= Date.now();
    if (firstSeenAt === null && elapsedMin > args.noChecksGraceMinutes) {
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, { ...cur, status: "no-checks-observed", finishedAt: new Date().toISOString() });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "no-checks-observed",
        updatedAt: new Date().toISOString(),
      });
      releaseAll();
      process.exit(0);
    }

    if (isTerminal(checks)) {
      const sum = summarize(checks);
      const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
      atomicWriteJson(sf, {
        ...cur,
        status: "done",
        finishedAt: new Date().toISOString(),
        checks,
        summary: sum,
      });
      atomicWriteJson(latestPointer(args.host, args.owner, args.repo, args.pr), {
        headSha: args.headSha,
        status: "done",
        updatedAt: new Date().toISOString(),
      });
      notifyDone(sum, args.pr);
      releaseAll();
      process.exit(0);
    }

    const sleepSec = sched.next().value as number;
    const cur = JSON.parse(fs.readFileSync(sf, "utf8"));
    atomicWriteJson(sf, {
      ...cur,
      lastPolledAt: new Date().toISOString(),
      nextPollAt: new Date(Date.now() + sleepSec * 1000).toISOString(),
      checks,
    });
    await new Promise(r => setTimeout(r, sleepSec * 1000));
  }
}

// =============================================================================
// pr-merge watcher mode (--on-green callback). Coexists with legacy mode.
// Triggered when --on-green <name> is present.
// =============================================================================

interface PrMergeWatchArgs {
  callbackName: string;
  planFile: string;
  watchTimeoutHours: number;
  pollSeconds: number;
}

function parsePrMergeArgs(argv: string[]): PrMergeWatchArgs | null {
  const onGreenIdx = argv.indexOf("--on-green");
  if (onGreenIdx < 0) return null;
  const callbackName = argv[onGreenIdx + 1];
  if (!callbackName) throw new Error("--on-green requires a value");
  const planIdx = argv.indexOf("--plan-file");
  if (planIdx < 0) throw new Error("--on-green requires --plan-file");
  const planFile = argv[planIdx + 1];
  if (!planFile) throw new Error("--plan-file requires a value");
  const wtIdx = argv.indexOf("--watch-timeout");
  const watchTimeoutHours = wtIdx >= 0 ? Number(argv[wtIdx + 1]) : 6;
  const pollIdx = argv.indexOf("--poll-seconds");
  const pollSeconds = pollIdx >= 0 ? Number(argv[pollIdx + 1]) : 30;
  return { callbackName, planFile, watchTimeoutHours, pollSeconds };
}

function jitter(seconds: number, pct = 0.2): number {
  const delta = seconds * pct;
  return Math.max(1, seconds + (Math.random() * 2 - 1) * delta);
}

interface PollOutcome {
  kind: "wait" | "ready" | "head_moved" | "fatal";
  reason?: string;
  // Set only on a `wait` produced by a rollup with ZERO required contexts. See
  // decideVacuousTransition for why that case is time-bounded rather than
  // waited on indefinitely.
  vacuous?: boolean;
  // Set only on a `wait` produced by a rollup whose latest context for some
  // REQUIRED check is SKIPPED. Same shape as `vacuous`: transient right after
  // the draft-time push, permanent once the real run has had time to register.
  skipped?: boolean;
  skippedNames?: string[];
}

// Constants exported for the unit-test of decideHeadMovedTransition.
export const HEAD_MOVED_REQUIRED_RECONFIRMS = 3;
export const HEAD_MOVED_RECONFIRM_DELAY_SEC = 5;

// Pure: given the running head_moved counter, decide whether to reconfirm
// (transient — likely GraphQL replication lag right after force-push) or
// declare the head_moved terminal. consecutiveCount is the post-increment
// value, so the very first head_moved seen passes 1.
export function decideHeadMovedTransition(
  consecutiveCount: number,
  required: number = HEAD_MOVED_REQUIRED_RECONFIRMS,
): "reconfirm" | "terminal" {
  return consecutiveCount < required ? "reconfirm" : "terminal";
}

// How long a VACUOUS rollup (zero REQUIRED contexts) may persist before the
// watcher gives up instead of polling to its 6h timeout.
export const NO_REQUIRED_CHECKS_GRACE_SEC = 300;

// Pure: a vacuous rollup is ambiguous, and the two readings need opposite
// handling.
//
//   TRANSIENT — the push just landed and GitHub has not attached the check
//     runs yet, so nothing is required *yet*. Waiting fixes it, usually within
//     seconds.
//   PERMANENT — the base branch has no required status checks at all
//     (unprotected branch, or protection without required contexts). Waiting
//     can NEVER fix this: `required` is 0 because of branch configuration, and
//     no amount of polling changes branch configuration.
//
// They are indistinguishable in a single sample, so time separates them: past
// the grace window, treat it as configuration and stop.
//
// This is the bug that motivated the helper. A PR into an UNPROTECTED base
// branch left the watcher polling happily for its full 6h timeout —
// `status: "watching"`, `consecutiveGreen: 0`, `lastError: null` — while every
// check run on the head was green and the PR was MERGEABLE/CLEAN. Nothing ever
// merged and nothing said why, because `evaluateRollup`'s wait reason was
// computed and then dropped (see writeStatus at the call site, now fixed too).
// Observed on 21StarkCom/kotodama#861, whose base `build/gke-api-auth-boundary`
// carried no branch protection; `main` requires one context, so every prior run
// had exercised only the non-vacuous path.
export function decideVacuousTransition(
  vacuousElapsedSec: number,
  graceSec: number = NO_REQUIRED_CHECKS_GRACE_SEC,
): "wait" | "terminal" {
  return vacuousElapsedSec < graceSec ? "wait" : "terminal";
}

// How long a SKIPPED required check may persist before the watcher stops.
//
// Same two readings as the vacuous case, so the same treatment. TRANSIENT: the
// merge flow force-pushed while the PR was still a draft, so a draft-guarded
// required check reported SKIPPED, and the `ready_for_review` run that replaces
// it has not registered yet. PERMANENT: the check skips by configuration (or
// its real run was lost), and nothing but a new commit will ever change it.
// Shorter than the vacuous window because the replacement run is fired by this
// tool's own `gh pr ready` moments earlier — it is late by seconds, not minutes.
export const SKIPPED_CHECK_GRACE_SEC = 120;

export function decideSkippedTransition(
  skippedElapsedSec: number,
  graceSec: number = SKIPPED_CHECK_GRACE_SEC,
): "wait" | "terminal" {
  return skippedElapsedSec < graceSec ? "wait" : "terminal";
}

// Pure function: maps a rollup result (mismatch | contexts) + plan policy
// into a PollOutcome. Easy to unit-test.
export function evaluateRollup(
  rollup: { mismatch: boolean; contexts: Context[] | null; headRefOid: string },
  policy: { allowNoRequiredChecks: boolean; allowSkippedChecks?: boolean },
): PollOutcome {
  if (rollup.mismatch) return { kind: "head_moved", reason: `headRefOid=${rollup.headRefOid}` };
  const v = summarizeVerdict(rollup.contexts!);
  if (v.vacuous) {
    if (policy.allowNoRequiredChecks) return { kind: "ready", reason: "vacuous-allowed" };
    // `vacuous: true` is carried on the outcome so the caller can time-bound it
    // (decideVacuousTransition) instead of waiting on a condition that may be
    // permanent. The reason string is not a marker — callers must not parse it.
    return { kind: "wait", reason: "no required checks observed yet", vacuous: true };
  }
  if (v.anyFailing) return { kind: "fatal", reason: `failing checks: ${v.failing}` };
  // A skipped required check will not resolve itself: re-running the workflow
  // replays the original event payload (so a draft-guarded job skips again), and
  // a `workflow_dispatch` run does not join the PR's status rollup at all —
  // measured on #877, where the dispatch produced `test: SUCCESS` on the head
  // sha that the rollup never carried. Only a new commit clears it.
  //
  // But it is NOT terminal on sight, for the same reason a vacuous rollup is
  // not: this flow manufactures a transient skip. `pr-merge` force-pushes while
  // the PR is still a draft (creating a SKIPPED run in any target repo that
  // still draft-guards that check) and only then marks it ready, which fires the
  // real run. A first poll landing in that gap would abort seconds before the
  // genuine run registers, telling the operator to push a commit they do not
  // need. Time separates the two readings, exactly as with vacuous — the caller
  // bounds it via decideSkippedTransition.
  if (v.anySkipped && !policy.allowSkippedChecks) {
    return {
      kind: "wait",
      reason: `required check(s) skipped, so the suite has not run on this commit: ${v.skippedNames.join(", ")}`,
      skipped: true,
      skippedNames: v.skippedNames,
    };
  }
  if (isGreen(v, { allowSkippedChecks: policy.allowSkippedChecks })) {
    return { kind: "ready", reason: "all required passing" };
  }
  return { kind: "wait", reason: `pending: ${v.pending}` };
}

async function pollOnce(plan: PrMergePlan): Promise<PollOutcome> {
  const r = await fetchRequiredCheckRollup({
    owner: plan.pr.headRepositoryOwner,
    repo: plan.pr.headRepositoryName,
    prNumber: plan.pr.number,
    expectedHeadOid: plan.pushedHeadOid!,
  });
  return evaluateRollup(r as any, {
    allowNoRequiredChecks: plan.execute.allowNoRequiredChecks,
    allowSkippedChecks: plan.execute.allowSkippedChecks === true,
  });
}

interface BackoffState {
  consecErrors: number;
  rateLimitDelaySec: number;
}

function classifyError(err: Error): { rateLimit: boolean; secondaryRateLimit: boolean; transient: boolean } {
  const msg = err.message;
  if (/X-RateLimit-Remaining: 0/i.test(msg) || /\b429\b/.test(msg)) return { rateLimit: true, secondaryRateLimit: false, transient: false };
  if (/secondary rate limit/i.test(msg)) return { rateLimit: false, secondaryRateLimit: true, transient: false };
  if (/\b50[0-9]\b/.test(msg)) return { rateLimit: false, secondaryRateLimit: false, transient: true };
  return { rateLimit: false, secondaryRateLimit: false, transient: false };
}

function backoffDelaySeconds(state: BackoffState, base: number): number {
  // Capped exponential: base * 2^consecErrors, cap 15 min.
  const exp = Math.min(15 * 60, base * Math.pow(2, Math.max(0, state.consecErrors - 1)));
  return jitter(exp);
}

function spawnCallback(callbackPath: string, planFile: string): { pid: number } {
  // Detached spawn so the watcher's exit doesn't kill the callback.
  const child = spawn("node", ["--experimental-strip-types", callbackPath, "--plan-file", planFile], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid ?? -1 };
}

async function prMergeWatchLoop(args: PrMergeWatchArgs): Promise<number> {
  const plan = readPrMergePlan(args.planFile);
  if (!plan.pushedHeadOid) {
    process.stderr.write("watcher: plan.pushedHeadOid is null; nothing to watch\n");
    return 1;
  }
  const callbackPath = resolveCallback(args.callbackName);
  if (!callbackPath) {
    process.stderr.write(`watcher: unknown callback name '${args.callbackName}'; refused before spawn\n`);
    return 2;
  }

  const host = "github.com"; // pr-merge uses the same default
  ensurePrDir(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number);
  const sf = stateFile(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number, plan.pushedHeadOid);
  const lf = lockFile(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number, plan.pushedHeadOid);
  const lock = acquireLock(lf, { headSha: plan.pushedHeadOid });
  if (lock.alreadyRunning) {
    process.stderr.write(`watcher already running for PR #${plan.pr.number} @ ${plan.pushedHeadOid}\n`);
    return 0;
  }
  const ownerToken = lock.ownerToken!;
  const startedAt = new Date().toISOString();
  // Mirror to per-PR latest.json.lock so pr-merge preflight's recovery check
  // can detect us at a stable, SHA-independent path (the per-SHA lock above
  // can't be found by a recovery query that doesn't yet know the SHA).
  const latestLockMerge = latestPointer(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number) + ".lock";
  mirrorLockToLatest(latestLockMerge, {
    pid: process.pid,
    startedAt,
    headSha: plan.pushedHeadOid,
    command: "gh-watch-runs",
    ownerToken,
  }, "merge-driver");
  const releaseAllMerge = (): void => {
    releaseLockIfOwner(lf, ownerToken);
    releaseMirrorLatestLock(latestLockMerge, ownerToken);
  };

  atomicWriteJson(sf, {
    schemaVersion: 1,
    command: "stark-gh-pr-merge-watch",
    host,
    repo: plan.pr.nameWithOwner,
    pr: plan.pr.number,
    headSha: plan.pushedHeadOid,
    status: "watching",
    startedAt,
    pid: process.pid,
    hostname: os.hostname(),
    consecutiveGreen: 0,
    lastPolledAt: null,
    lastError: null,
  });

  const start = Date.now();
  const maxMs = args.watchTimeoutHours * 60 * 60 * 1000;
  const backoff: BackoffState = { consecErrors: 0, rateLimitDelaySec: 0 };
  let consecutiveGreen = 0;
  // When the CURRENT run of vacuous polls began (null = not currently vacuous).
  // Timestamped rather than counted so the grace window is wall-clock and stays
  // meaningful as the poll interval backs off under rate limiting.
  let vacuousSinceMs: number | null = null;
  // Same shape, for a rollup whose latest context on some required check is
  // SKIPPED. See decideSkippedTransition.
  let skippedSinceMs: number | null = null;
  const REQUIRED_GREEN = 2; // PR4-claude H13 debounce
  // Tolerate transient head-OID mismatch right after force-push: GitHub's
  // GraphQL `pullRequest.headRefOid` can lag the push receiver by hundreds
  // of milliseconds, so the very first poll often observes the pre-push
  // OID and would otherwise exit the watcher 500ms after spawn. Require
  // HEAD_MOVED_REQUIRED_RECONFIRMS consecutive head_moved outcomes (with
  // a short reconfirm delay between them) before declaring a terminal
  // head_moved. A real intervening force-push survives all reconfirms;
  // replication lag resolves within seconds.
  let consecutiveHeadMoved = 0;

  const writeStatus = (extras: Record<string, unknown>): void => {
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { /* keep empty */ }
    atomicWriteJson(sf, { ...cur, ...extras, lastPolledAt: new Date().toISOString() });
    // Heartbeat: touch latest.json's mtime each poll.
    try { fs.utimesSync(sf, new Date(), new Date()); } catch { /* best-effort */ }
  };

  while (true) {
    const elapsedMs = Date.now() - start;
    if (elapsedMs > maxMs) {
      writeStatus({ status: "watch_timeout", finishedAt: new Date().toISOString() });
      releaseAllMerge();
      return 0;
    }

    let outcome: PollOutcome | null = null;
    let pollErr: Error | null = null;
    try {
      outcome = await pollOnce(plan);
    } catch (err) {
      pollErr = err as Error;
    }

    if (pollErr) {
      backoff.consecErrors++;
      const cls = classifyError(pollErr);
      let delay: number;
      if (cls.rateLimit || cls.secondaryRateLimit) {
        delay = Math.min(15 * 60, args.pollSeconds * Math.pow(2, backoff.consecErrors));
      } else if (cls.transient) {
        delay = args.pollSeconds * backoff.consecErrors;
      } else {
        if (backoff.consecErrors >= 3) {
          writeStatus({ status: "auth_failed", lastError: pollErr.message, finishedAt: new Date().toISOString() });
          releaseAllMerge();
          return 1;
        }
        delay = args.pollSeconds;
      }
      writeStatus({ lastError: pollErr.message, consecErrors: backoff.consecErrors });
      await new Promise(r => setTimeout(r, jitter(delay) * 1000));
      continue;
    }
    backoff.consecErrors = 0;

    if (outcome!.kind === "head_moved") {
      consecutiveHeadMoved++;
      if (decideHeadMovedTransition(consecutiveHeadMoved) === "reconfirm") {
        // Likely GraphQL replication lag right after force-push; reconfirm
        // with a short delay before treating as terminal. Reset the green
        // debounce: a transient head_moved invalidates any in-flight green
        // streak, otherwise one ready poll before the mismatch plus one
        // after could dispatch the merge after only one post-mismatch green.
        consecutiveGreen = 0;
        writeStatus({
          status: "watching",
          consecutiveHeadMoved,
          consecutiveGreen,
          lastWarning: `head_moved (transient ${consecutiveHeadMoved}/${HEAD_MOVED_REQUIRED_RECONFIRMS}): ${outcome!.reason}`,
        });
        await new Promise(r => setTimeout(r, jitter(HEAD_MOVED_RECONFIRM_DELAY_SEC) * 1000));
        continue;
      }
      writeStatus({ status: "head_moved", finishedAt: new Date().toISOString(), reason: outcome!.reason });
      atomicWriteJson(latestPointer(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number), {
        headSha: plan.pushedHeadOid,
        status: "head_moved",
        updatedAt: new Date().toISOString(),
      });
      releaseAllMerge();
      return 0;
    }
    // Any non-head_moved outcome resets the consecutive counter so a stray
    // mismatch followed by recovery doesn't accumulate toward terminal.
    consecutiveHeadMoved = 0;
    if (outcome!.kind === "fatal") {
      writeStatus({ status: "checks_failed", finishedAt: new Date().toISOString(), reason: outcome!.reason });
      releaseAllMerge();
      return 0;
    }
    if (outcome!.kind === "ready") {
      consecutiveGreen++;
      vacuousSinceMs = null;
      skippedSinceMs = null;
      writeStatus({ consecutiveGreen, status: "watching", lastWait: null });
      if (consecutiveGreen >= REQUIRED_GREEN) {
        // Fire callback. Spawn detached so its lifetime is independent.
        const { pid } = spawnCallback(callbackPath, args.planFile);
        writeStatus({
          status: "callback_dispatched",
          callbackName: args.callbackName,
          callbackPid: pid,
          finishedAt: new Date().toISOString(),
        });
        releaseAllMerge();
        return 0;
      }
    } else {
      consecutiveGreen = 0;
      // SURFACE THE REASON. This used to write only the counter, so a watcher
      // that could never progress was indistinguishable from one waiting on a
      // check that was about to finish: `status: "watching"`, `lastError: null`
      // and nothing else. The reason is the entire diagnosis.
      writeStatus({ consecutiveGreen, status: "watching", lastWait: outcome!.reason ?? null });

      // A vacuous rollup may be transient (checks not attached yet) or permanent
      // (the base branch requires no checks at all). Bound it: past the grace
      // window, stop rather than poll to the 6h timeout with nothing to wait for.
      if (outcome!.vacuous) {
        if (vacuousSinceMs === null) vacuousSinceMs = Date.now();
        const elapsedSec = (Date.now() - vacuousSinceMs) / 1000;
        if (decideVacuousTransition(elapsedSec) === "terminal") {
          const reason =
            `no REQUIRED status checks on this PR after ${Math.round(elapsedSec)}s — the base branch has none configured, ` +
            `so this will never turn green no matter how long it is watched. Check runs on the head may all be passing and the ` +
            `PR MERGEABLE; the watcher gates on REQUIRED contexts, and there are none. Either add required checks to the base ` +
            `branch's protection, or re-run the merge with --allow-no-required-checks to accept a vacuous pass.`;
          writeStatus({ status: "no_required_checks", finishedAt: new Date().toISOString(), reason });
          atomicWriteJson(latestPointer(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number), {
            headSha: plan.pushedHeadOid,
            status: "no_required_checks",
            updatedAt: new Date().toISOString(),
          });
          releaseAllMerge();
          return 0;
        }
      } else {
        vacuousSinceMs = null;
      }

      // A SKIPPED required check reads the same two ways, and gets the same
      // wall-clock separation: transient while this flow's own `gh pr ready`
      // run is still registering, permanent once it should have.
      if (outcome!.skipped) {
        if (skippedSinceMs === null) skippedSinceMs = Date.now();
        const elapsedSec = (Date.now() - skippedSinceMs) / 1000;
        if (decideSkippedTransition(elapsedSec) === "terminal") {
          const names = (outcome!.skippedNames ?? []).join(", ");
          const reason =
            `required check(s) still SKIPPED after ${Math.round(elapsedSec)}s: ${names}. The suite never ran against this ` +
            `commit, and nothing will change that on its own — re-running the workflow replays the original event payload ` +
            `(a draft-guarded job skips again) and a workflow_dispatch run does not join this PR's status rollup. GitHub ` +
            `itself counts a skipped check as satisfying the requirement, which is why the merge box looks green; it is not. ` +
            `Push a commit to re-fire CI, or re-run the merge with --allow-skipped-checks if these checks skip by design.`;
          writeStatus({ status: "checks_skipped", finishedAt: new Date().toISOString(), reason });
          atomicWriteJson(latestPointer(host, plan.pr.headRepositoryOwner, plan.pr.headRepositoryName, plan.pr.number), {
            headSha: plan.pushedHeadOid,
            status: "checks_skipped",
            updatedAt: new Date().toISOString(),
          });
          releaseAllMerge();
          return 0;
        }
      } else {
        skippedSinceMs = null;
      }
    }
    await new Promise(r => setTimeout(r, jitter(args.pollSeconds) * 1000));
  }
}

if (process.argv[1]?.endsWith("gh_watch_runs.ts")) {
  // Branch on --on-green: pr-merge mode vs legacy pr-open mode.
  const argv = process.argv.slice(2);
  let prMergeArgs: PrMergeWatchArgs | null = null;
  try {
    prMergeArgs = parsePrMergeArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(2);
  }
  if (prMergeArgs) {
    prMergeWatchLoop(prMergeArgs).then(c => process.exit(c)).catch(e => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
  } else {
    mainAsync().catch(e => {
      process.stderr.write(String(e) + "\n");
      process.exit(1);
    });
  }
}

// Exports for tests
export { parsePrMergeArgs, classifyError, jitter, pollOnce };
