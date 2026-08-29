// Watcher lock format and liveness detection.
// Lock JSON: { pid, startedAt, hostname, ownerToken }
// Liveness: hostname match + kill -0 success + process start-time match.
// Tolerant reader: also accepts old-format locks (any other shape) and treats
// them as live — defensive — so the upgrade window doesn't kill running pr-open
// watchers.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

// Which command owns a live watcher. pr-merge preflight needs this because the
// two kinds mean opposite things to it:
//   ci-observer  — a pr-open watcher merely REPORTING check status on a head
//                  that pr-merge is about to invalidate by rebasing and
//                  force-pushing. Pre-emptible.
//   merge-driver — a pr-merge watcher that will itself mark-ready and merge.
//                  Genuinely attached; a second run must not race it.
// Absent (pre-kind mirrors) ⇒ "unknown", handled conservatively as attached.
export type WatcherKind = "ci-observer" | "merge-driver" | "unknown";

export interface LockRecord {
  pid: number;
  startedAt: string;          // ISO 8601 of process start
  hostname: string;
  ownerToken: string;
  kind?: Exclude<WatcherKind, "unknown">;   // optional: pre-kind mirrors omit it
}

export type ProcessAlive = (pid: number) => boolean;

export type ProcessStartedAt = (pid: number) => string | null;

const defaultProcessAlive: ProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);    // signal 0 → existence check, no-op
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;       // process exists, owned by another user
    if (code === "ESRCH") return false;
    return false;
  }
};

const defaultProcessStartedAt: ProcessStartedAt = (pid) => {
  try {
    // ps -o lstart= -p <pid>  → "Mon Apr 28 12:34:56 2026"
    // Cross-platform enough for darwin + linux. Output stable enough for equality match.
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { stdio: ["pipe", "pipe", "pipe"] })
      .toString("utf8")
      .trim();
    return out || null;
  } catch {
    return null;
  }
};

export function readLock(filepath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filepath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function isLockShape(v: unknown): v is LockRecord {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.pid === "number"
    && typeof o.startedAt === "string"
    && typeof o.hostname === "string"
    && typeof o.ownerToken === "string";
}

// Classify a lock's owning command. Deliberately tolerant: any shape we don't
// recognize, or a recognized shape with no/garbage `kind`, reads as "unknown"
// so callers fall back to their conservative branch.
export function lockKind(lock: unknown): WatcherKind {
  if (typeof lock !== "object" || lock === null) return "unknown";
  const k = (lock as Record<string, unknown>).kind;
  if (k === "ci-observer" || k === "merge-driver") return k;
  return "unknown";
}

export interface LivenessResult {
  alive: boolean;
  reason: string;
  shape: "new" | "unknown";    // "unknown" ⇒ pre-Phase-6 lock; treat as alive
}

export function evaluateLockLiveness(
  lock: unknown,
  opts: { now?: ProcessAlive; startedAt?: ProcessStartedAt; hostname?: string } = {},
): LivenessResult {
  const isAlive = opts.now ?? defaultProcessAlive;
  const startedAt = opts.startedAt ?? defaultProcessStartedAt;
  const myHostname = opts.hostname ?? os.hostname();

  if (!isLockShape(lock)) {
    // Old-format lock OR unparseable. Conservative: treat as alive so we
    // don't trample an in-flight pr-open watcher mid-upgrade.
    return { alive: true, reason: "unknown lock shape; treat as live (conservative)", shape: "unknown" };
  }
  if (lock.hostname !== myHostname) {
    // Lock from a different host (shared FS, NFS). Cannot verify locally.
    return { alive: true, reason: `lock hostname '${lock.hostname}' != local '${myHostname}'`, shape: "new" };
  }
  if (!isAlive(lock.pid)) {
    return { alive: false, reason: `pid ${lock.pid} dead (kill -0 failed)`, shape: "new" };
  }
  const currentStart = startedAt(lock.pid);
  if (currentStart === null) {
    return { alive: false, reason: `pid ${lock.pid} startedAt unreadable; treat as stale`, shape: "new" };
  }
  if (currentStart !== lock.startedAt) {
    return {
      alive: false,
      reason: `pid ${lock.pid} startedAt '${currentStart}' != recorded '${lock.startedAt}' (PID reuse)`,
      shape: "new",
    };
  }
  return { alive: true, reason: "lock is live", shape: "new" };
}

// Stop a live ci-observer watcher and drop its mirror lock, so a pr-merge run
// can proceed immediately instead of waiting for the observer's poll cadence.
// SIGTERM first (the watcher releases its own per-SHA lock on the way out),
// then SIGKILL if it hasn't gone after `graceMs`. Removing the mirror lock is
// unconditional: even a wedged observer must not keep blocking pr-merge, and a
// leftover per-SHA lock is self-healing (its pid reads dead on next acquire).
export function preemptCiObserver(
  pid: number,
  mirrorLockPath: string,
  opts: { kill?: (pid: number, sig: NodeJS.Signals) => void; alive?: ProcessAlive; graceMs?: number; sleep?: (ms: number) => void } = {},
): void {
  const kill = opts.kill ?? ((p, s) => process.kill(p, s));
  const isAlive = opts.alive ?? defaultProcessAlive;
  const graceMs = opts.graceMs ?? 2000;
  const sleep = opts.sleep ?? ((ms: number) => {
    // Synchronous: preflight is a straight-line script with no event loop to yield to.
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, ms);
  });

  try { kill(pid, "SIGTERM"); } catch { /* already gone */ }
  const step = 100;
  for (let waited = 0; waited < graceMs && isAlive(pid); waited += step) {
    sleep(step);
  }
  if (isAlive(pid)) {
    try { kill(pid, "SIGKILL"); } catch { /* raced with its own exit */ }
  }
  try { fs.unlinkSync(mirrorLockPath); } catch { /* already released */ }
}

// ===========================================================================
// Per-SHA lock (the watcher's own acquire/release) + the per-PR mirror lock.
//
// Two lock SHAPES, deliberately, one module:
//
//   Per-SHA lock  (LockFileContent, at <sha>.json.lock) — the watcher's own
//     mutex against a duplicate watcher for the same head. Liveness = kill(0)
//     on the recorded pid, keyed by headSha. Written and read here.
//
//   Mirror lock   (LockRecord, at latest.json.lock) — a SHA-INDEPENDENT copy
//     so pr-merge preflight can detect a live watcher WITHOUT knowing the SHA
//     (it cannot enumerate per-SHA locks for a head it has not computed yet).
//     Liveness = evaluateLockLiveness (hostname + kill(0) + ps-lstart start
//     time), which is why its `startedAt` is the `ps -o lstart=` STRING, not an
//     ISO timestamp — see mirrorLockToLatest.
//
// The two are not merged into one shape because they guard different failure
// modes (a same-head duplicate vs a cross-host / PID-reuse false-attach) and
// their liveness checks disagree on the timestamp format on purpose.
// ===========================================================================

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
// LockRecord shape that evaluateLockLiveness (used by pr-merge preflight)
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
    // The mirror lock is consumed by evaluateLockLiveness, which compares
    // `startedAt` to `ps -o lstart= -p <pid>`. We must write the ps lstart
    // string here — not an ISO timestamp — or every live watcher looks like
    // PID reuse and preflight always re-spawns instead of attaching.
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
    const record: LockRecord = {
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

export function watcherStateLatestPath(host: string, owner: string, repo: string, prNumber: number, watchersRoot: string): string {
  return path.join(watchersRoot, host, owner, repo, `pr-${prNumber}`, "latest.json");
}

export function watcherLockPath(latestPath: string): string {
  return latestPath + ".lock";
}
