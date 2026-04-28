import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateLockLiveness, isLockShape,
  watcherStateLatestPath, watcherLockPath,
  type LockRecord,
} from "../lib/watcher_lock.ts";

const HOST = "test-host";
const ALIVE_PID = 100;
const DEAD_PID = 999;
const KNOWN_START = "Mon Apr 28 12:00:00 2026";

const newLock: LockRecord = {
  pid: ALIVE_PID,
  startedAt: KNOWN_START,
  hostname: HOST,
  ownerToken: "owner-1",
};

test("evaluateLockLiveness: live new-format lock", () => {
  const r = evaluateLockLiveness(newLock, {
    hostname: HOST,
    now: (pid) => pid === ALIVE_PID,
    startedAt: () => KNOWN_START,
  });
  assert.equal(r.alive, true);
  assert.equal(r.shape, "new");
});

test("evaluateLockLiveness: stale lock — pid dead", () => {
  const r = evaluateLockLiveness(newLock, {
    hostname: HOST,
    now: () => false,
    startedAt: () => null,
  });
  assert.equal(r.alive, false);
  assert.match(r.reason, /pid 100 dead/);
});

test("evaluateLockLiveness: PID reuse detected via startedAt mismatch", () => {
  const r = evaluateLockLiveness(newLock, {
    hostname: HOST,
    now: () => true,                              // pid currently exists
    startedAt: () => "Tue May 01 09:00:00 2026",  // but started at different time
  });
  assert.equal(r.alive, false);
  assert.match(r.reason, /startedAt.*PID reuse/);
});

test("evaluateLockLiveness: hostname mismatch — treat as live (cross-host)", () => {
  const r = evaluateLockLiveness({ ...newLock, hostname: "other-host" }, {
    hostname: HOST,
    now: () => false,                             // doesn't matter
    startedAt: () => null,
  });
  assert.equal(r.alive, true);
  assert.match(r.reason, /hostname/);
});

test("evaluateLockLiveness: old/unknown shape — treat as live (conservative)", () => {
  const r1 = evaluateLockLiveness({ legacy: "stuff" }, { hostname: HOST });
  assert.equal(r1.alive, true);
  assert.equal(r1.shape, "unknown");
  // Also accepts null (no lock at all is handled by caller; this is just shape).
  const r2 = evaluateLockLiveness(null, { hostname: HOST });
  assert.equal(r2.alive, true);
  assert.equal(r2.shape, "unknown");
});

test("evaluateLockLiveness: startedAt unreadable → stale", () => {
  const r = evaluateLockLiveness(newLock, {
    hostname: HOST,
    now: () => true,
    startedAt: () => null,
  });
  assert.equal(r.alive, false);
  assert.match(r.reason, /unreadable/);
});

test("isLockShape recognizes complete record", () => {
  assert.equal(isLockShape(newLock), true);
});

test("isLockShape rejects missing fields", () => {
  for (const k of ["pid", "startedAt", "hostname", "ownerToken"]) {
    const partial = { ...newLock } as Record<string, unknown>;
    delete partial[k];
    assert.equal(isLockShape(partial), false, `missing ${k}`);
  }
});

test("isLockShape rejects pid as string", () => {
  assert.equal(isLockShape({ ...newLock, pid: "100" }), false);
});

test("watcherStateLatestPath layout", () => {
  const p = watcherStateLatestPath("github.com", "evinced", "stark-skills", 42, "/tmp/watchers");
  assert.equal(p, "/tmp/watchers/github.com/evinced/stark-skills/pr-42/latest.json");
});

test("watcherLockPath sibling .lock file", () => {
  const latest = "/tmp/w/x/y/pr-1/latest.json";
  assert.equal(watcherLockPath(latest), "/tmp/w/x/y/pr-1/latest.json.lock");
});
