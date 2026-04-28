// Watcher lock format and liveness detection.
// Lock JSON: { pid, startedAt, hostname, ownerToken }
// Liveness: hostname match + kill -0 success + process start-time match.
// Tolerant reader: also accepts old-format locks (any other shape) and treats
// them as live — defensive — so the upgrade window doesn't kill running pr-open
// watchers.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export interface LockRecord {
  pid: number;
  startedAt: string;          // ISO 8601 of process start
  hostname: string;
  ownerToken: string;
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

export function watcherStateLatestPath(host: string, owner: string, repo: string, prNumber: number, watchersRoot: string): string {
  return path.join(watchersRoot, host, owner, repo, `pr-${prNumber}`, "latest.json");
}

export function watcherLockPath(latestPath: string): string {
  return latestPath + ".lock";
}
