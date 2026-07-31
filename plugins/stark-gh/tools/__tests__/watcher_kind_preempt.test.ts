// Regression: `pr-open --ready` followed immediately by `pr-merge` failed with
// exit 34 ("watcher already running") until the pr-open CI watcher aged out on
// its own poll cadence. The mirror lock carried no owner-kind, so pr-merge
// preflight could not tell a CI *observer* (pre-emptible — pr-merge is about to
// invalidate the head it watches) from a merge *driver* (must not be raced).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockKind, preemptCiObserver, isLockShape } from "../lib/watcher_lock.ts";

test("lockKind classifies both watcher kinds", () => {
  assert.equal(lockKind({ kind: "ci-observer" }), "ci-observer");
  assert.equal(lockKind({ kind: "merge-driver" }), "merge-driver");
});

test("lockKind: pre-kind mirror, garbage kind, and non-objects read as unknown", () => {
  // Conservative fallback — preflight treats "unknown" as attached, as before.
  assert.equal(lockKind({ pid: 1, startedAt: "x", hostname: "h", ownerToken: "t" }), "unknown");
  assert.equal(lockKind({ kind: "something-else" }), "unknown");
  assert.equal(lockKind({ kind: 7 }), "unknown");
  assert.equal(lockKind(null), "unknown");
  assert.equal(lockKind("nope"), "unknown");
});

test("isLockShape still accepts a lock with no kind (back-compat)", () => {
  const noKind = { pid: 1, startedAt: "s", hostname: "h", ownerToken: "t" };
  assert.equal(isLockShape(noKind), true);
  assert.equal(isLockShape({ ...noKind, kind: "ci-observer" }), true);
});

function tmpLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-preempt-"));
  const p = path.join(dir, "latest.json.lock");
  fs.writeFileSync(p, JSON.stringify({ pid: 4242, kind: "ci-observer" }));
  return p;
}

test("preemptCiObserver: SIGTERM is enough — no SIGKILL, mirror lock removed", () => {
  const lockPath = tmpLock();
  const signals: string[] = [];
  let alive = true;
  preemptCiObserver(4242, lockPath, {
    kill: (_pid, sig) => { signals.push(sig); if (sig === "SIGTERM") alive = false; },
    alive: () => alive,
    graceMs: 500,
    sleep: () => {},
  });
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(fs.existsSync(lockPath), false);
});

test("preemptCiObserver: wedged observer escalates to SIGKILL", () => {
  const lockPath = tmpLock();
  const signals: string[] = [];
  preemptCiObserver(4242, lockPath, {
    kill: (_pid, sig) => { signals.push(sig); },
    alive: () => true,           // never dies
    graceMs: 300,
    sleep: () => {},
  });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  // Unconditional: a wedged observer must not keep blocking pr-merge.
  assert.equal(fs.existsSync(lockPath), false);
});

test("preemptCiObserver: already-dead pid — kill throws, still clears the lock", () => {
  const lockPath = tmpLock();
  preemptCiObserver(4242, lockPath, {
    kill: () => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); },
    alive: () => false,
    graceMs: 100,
    sleep: () => {},
  });
  assert.equal(fs.existsSync(lockPath), false);
});

test("preemptCiObserver: missing mirror lock is not an error", () => {
  const lockPath = tmpLock();
  fs.unlinkSync(lockPath);
  assert.doesNotThrow(() => preemptCiObserver(4242, lockPath, {
    kill: () => {}, alive: () => false, graceMs: 100, sleep: () => {},
  }));
});
