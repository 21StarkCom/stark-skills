import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";

// Route watcher paths into the tmpdir root (watcher_paths honors CODEX_SANDBOX).
process.env.CODEX_SANDBOX = "1";

const { startSession } = await import("../lib/watcher_session.ts");
const { stateFile, lockFile, latestPointer } = await import("../lib/watcher_paths.ts");

function uniqueRepo(): string {
  return `r-${Math.random().toString(36).slice(2)}`;
}

test("startSession: acquires per-SHA lock + mirror, returns matching state file", () => {
  const owner = "o";
  const repo = uniqueRepo();
  const pr = 1;
  const sha = "abc123";
  const s = startSession({ host: "github.com", owner, repo, pr, headSha: sha, kind: "merge-driver" });
  try {
    assert.ok(s !== null);
    assert.equal(s!.sf, stateFile("github.com", owner, repo, pr, sha));
    assert.ok(fs.existsSync(lockFile("github.com", owner, repo, pr, sha)), "per-SHA lock created");
    assert.ok(fs.existsSync(latestPointer("github.com", owner, repo, pr) + ".lock"), "mirror lock created");
    // Mirror carries the kind so preflight can classify the watcher.
    const mirror = JSON.parse(fs.readFileSync(latestPointer("github.com", owner, repo, pr) + ".lock", "utf8"));
    assert.equal(mirror.kind, "merge-driver");
  } finally {
    s?.releaseAll();
    fs.rmSync(latestPointer("github.com", owner, repo, pr).replace(/\/latest\.json$/, ""), { recursive: true, force: true });
  }
});

test("startSession: returns null when a live same-head lock is already held", () => {
  const owner = "o";
  const repo = uniqueRepo();
  const pr = 1;
  const sha = "abc123";
  const s1 = startSession({ host: "github.com", owner, repo, pr, headSha: sha, kind: "ci-observer" });
  try {
    assert.ok(s1 !== null);
    // Second acquirer for the same head, same live pid, must defer.
    const s2 = startSession({ host: "github.com", owner, repo, pr, headSha: sha, kind: "ci-observer" });
    assert.equal(s2, null);
  } finally {
    s1?.releaseAll();
    fs.rmSync(latestPointer("github.com", owner, repo, pr).replace(/\/latest\.json$/, ""), { recursive: true, force: true });
  }
});

test("startSession: releaseAll removes both the per-SHA lock and the mirror", () => {
  const owner = "o";
  const repo = uniqueRepo();
  const pr = 1;
  const sha = "abc123";
  const s = startSession({ host: "github.com", owner, repo, pr, headSha: sha, kind: "merge-driver" });
  assert.ok(s !== null);
  const lf = lockFile("github.com", owner, repo, pr, sha);
  const mirror = latestPointer("github.com", owner, repo, pr) + ".lock";
  try {
    assert.ok(fs.existsSync(lf) && fs.existsSync(mirror));
    s!.releaseAll();
    assert.ok(!fs.existsSync(lf), "per-SHA lock released");
    assert.ok(!fs.existsSync(mirror), "mirror lock released");
  } finally {
    fs.rmSync(latestPointer("github.com", owner, repo, pr).replace(/\/latest\.json$/, ""), { recursive: true, force: true });
  }
});
