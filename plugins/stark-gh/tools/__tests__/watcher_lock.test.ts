import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireLock, releaseLockIfOwner } from "../gh_watch_runs.ts";

test("acquireLock creates lock when absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  const lockfile = path.join(dir, "x.lock");
  try {
    const r = acquireLock(lockfile, { headSha: "abc" });
    assert.equal(r.acquired, true);
    assert.ok(fs.existsSync(lockfile));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireLock returns alreadyRunning when same sha + alive PID", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  const lockfile = path.join(dir, "x.lock");
  try {
    fs.writeFileSync(
      lockfile,
      JSON.stringify({ pid: process.pid, headSha: "abc", ownerToken: "x", command: "gh-watch-runs", startedAt: new Date().toISOString() }),
    );
    const r = acquireLock(lockfile, { headSha: "abc" });
    assert.equal(r.acquired, false);
    assert.equal(r.alreadyRunning, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("releaseLockIfOwner respects token", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lock-test-"));
  const lockfile = path.join(dir, "x.lock");
  try {
    fs.writeFileSync(
      lockfile,
      JSON.stringify({ pid: process.pid, headSha: "abc", ownerToken: "owner-1", command: "gh-watch-runs", startedAt: new Date().toISOString() }),
    );
    releaseLockIfOwner(lockfile, "WRONG");
    assert.ok(fs.existsSync(lockfile), "still present when token mismatches");
    releaseLockIfOwner(lockfile, "owner-1");
    assert.ok(!fs.existsSync(lockfile), "removed when token matches");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
