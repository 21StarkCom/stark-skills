/**
 * Lock-file helpers — minimal TS subset of `scripts/lock_helpers.py`.
 *
 * Only `isLockStale(path)` is exposed here because that's the only entry
 * point `tools/preflight_lib.ts` needs. The full lock_helpers.py
 * (acquire/release/force-unlock + audit log) stays in Python for the
 * orchestrators that hold and release real locks.
 *
 * On-disk format (must match the Python so locks are interpretable
 * cross-language):
 *
 *   {
 *     "pid": 12345,
 *     "start_time": "Thu Apr  3 12:34:56 2026",  // ps -o lstart=
 *     "timestamp": "2026-04-03T12:34:56Z",       // UTC iso8601 Z-suffix
 *     "worktree": "/path/to/worktree",
 *     "ttl_minutes": 30
 *   }
 *
 * Staleness criteria (matches Python's `_is_lock_data_stale`):
 *   - Missing/malformed timestamp → stale
 *   - now > timestamp + ttl_minutes → stale
 *   - pid not an integer → stale
 *   - kill(pid, 0) fails with ESRCH → stale
 *   - `ps -o lstart=` start_time differs from stored start_time → stale
 *     (guards against PID reuse)
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";

interface LockData {
  pid?: unknown;
  start_time?: unknown;
  timestamp?: unknown;
  ttl_minutes?: unknown;
}

function readLock(path: string): LockData | null {
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as LockData;
  } catch {
    return null;
  }
}

function getProcessStartTime(pid: number): string {
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) return "";
  return (r.stdout ?? "").trim();
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard Unix "does this process exist" probe — it
    // performs the permission check but doesn't deliver a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM means the process exists but we can't signal it — alive.
    return true;
  }
}

function parseUtcZ(stamp: string): number | null {
  // Mirror Python's `datetime.fromisoformat(s.replace("Z", "+00:00"))`.
  // The Python version is permissive about offset suffixes; Date.parse
  // handles `2026-04-03T12:34:56Z` natively.
  const ms = Date.parse(stamp);
  return Number.isFinite(ms) ? ms : null;
}

function isLockDataStale(data: LockData, now: number = Date.now()): boolean {
  const stamp = typeof data.timestamp === "string" ? data.timestamp : null;
  if (!stamp) return true;
  const storedMs = parseUtcZ(stamp);
  if (storedMs === null) return true;

  const ttlMin =
    typeof data.ttl_minutes === "number" ? data.ttl_minutes : 30;
  if (now > storedMs + ttlMin * 60_000) return true;

  const pid = data.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid)) return true;
  if (!isPidAlive(pid)) return true;

  const storedStart =
    typeof data.start_time === "string" ? data.start_time : "";
  const currentStart = getProcessStartTime(pid);
  if (currentStart && storedStart && currentStart !== storedStart) {
    return true;
  }
  return false;
}

/**
 * Return true if a lock file exists at `path` and represents a stale
 * lock (dead PID, reused PID, TTL exceeded, or unparseable contents).
 * Returns false when the file doesn't exist — no lock = not stale.
 */
export function isLockStale(path: string): boolean {
  if (!fs.existsSync(path)) return false;
  const data = readLock(path);
  if (data === null) return true; // corrupt = stale
  return isLockDataStale(data);
}

/** Test seam — exposed so unit tests can drive the staleness rules
 * without writing real lock files. Not part of the public CLI surface. */
export const __test = { isLockDataStale, isPidAlive, getProcessStartTime };
