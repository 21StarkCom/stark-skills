// Tests for `tools/lock_helpers_lib.ts` — the minimal `isLockStale`
// helper that preflight uses to flag abandoned `.lock` files.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { __test, isLockStale } from "./lock_helpers_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lock-helpers-test-"));
}

// ---------------------------------------------------------------------------
// isLockStale (file IO)
// ---------------------------------------------------------------------------

test("isLockStale: missing file → not stale (no lock = not stale)", () => {
  const dir = tmp();
  try {
    assert.equal(isLockStale(path.join(dir, "absent.lock")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLockStale: malformed JSON contents → stale", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "corrupt.lock");
    fs.writeFileSync(file, "not-json{");
    assert.equal(isLockStale(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLockStale: missing timestamp → stale", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "no-ts.lock");
    fs.writeFileSync(file, JSON.stringify({ pid: 1 }));
    assert.equal(isLockStale(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLockStale: own process holding the lock → not stale", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "own.lock");
    // Use lstart= output for the real PID so the start-time match holds.
    const startTime = __test.getProcessStartTime(process.pid);
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid,
        start_time: startTime,
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        ttl_minutes: 30,
      }),
    );
    assert.equal(isLockStale(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLockStale: dead PID → stale", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "dead.lock");
    // PID 1 is init/launchd — always alive. Pick a PID that almost
    // certainly isn't running by going past the typical kernel cap.
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: 999_999_999,
        start_time: "",
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        ttl_minutes: 30,
      }),
    );
    assert.equal(isLockStale(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isLockStale: TTL exceeded → stale even if PID is alive", () => {
  const dir = tmp();
  try {
    const file = path.join(dir, "ttl.lock");
    const old = new Date(Date.now() - 60 * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");
    fs.writeFileSync(
      file,
      JSON.stringify({
        pid: process.pid, // alive
        start_time: __test.getProcessStartTime(process.pid),
        timestamp: old,
        ttl_minutes: 30, // 30m TTL, we said 60m ago → stale
      }),
    );
    assert.equal(isLockStale(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// isLockDataStale (pure logic via the test seam — no real PIDs needed)
// ---------------------------------------------------------------------------

test("isLockDataStale: malformed timestamp string → stale", () => {
  assert.equal(__test.isLockDataStale({ timestamp: "not-a-date" }), true);
});

test("isLockDataStale: non-integer pid → stale", () => {
  assert.equal(
    __test.isLockDataStale({
      timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      pid: "abc",
    }),
    true,
  );
});

test("isLockDataStale: ttl_minutes missing → defaults to 30 (boundary)", () => {
  const justInside = new Date(Date.now() - 25 * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const wayOutside = new Date(Date.now() - 60 * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  // Inside the default 30m → pid check decides; pid=1 is launchd, alive.
  assert.equal(
    __test.isLockDataStale({
      timestamp: justInside,
      pid: 1,
      start_time: "",
    }),
    false,
  );
  // Way outside → TTL says stale regardless of pid liveness.
  assert.equal(
    __test.isLockDataStale({
      timestamp: wayOutside,
      pid: 1,
      start_time: "",
    }),
    true,
  );
});

test("isPidAlive: own pid is alive, absurdly-high pid is dead", () => {
  assert.equal(__test.isPidAlive(process.pid), true);
  assert.equal(__test.isPidAlive(999_999_999), false);
});
