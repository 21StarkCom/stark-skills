import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Route watcher paths into the tmpdir root (watcher_paths honors CODEX_SANDBOX).
// Must be set before importing anything that computes a watcher path.
process.env.CODEX_SANDBOX = "1";

const { readState, updateState, writeLatestPointer } = await import("../lib/watcher_state.ts");
const { latestPointer } = await import("../lib/watcher_paths.ts");

test("readState: absent file -> {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wstate-"));
  try {
    assert.deepEqual(readState(path.join(dir, "nope.json")), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readState: malformed json -> {} (torn prior write must not wedge)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wstate-"));
  const f = path.join(dir, "s.json");
  try {
    fs.writeFileSync(f, "{ not json");
    assert.deepEqual(readState(f), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateState: merges over existing fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wstate-"));
  const f = path.join(dir, "s.json");
  try {
    fs.writeFileSync(f, JSON.stringify({ status: "watching", pr: 7, keep: true }));
    updateState(f, { status: "done", finishedAt: "T" });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), {
      status: "done",
      pr: 7,
      keep: true,
      finishedAt: "T",
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateState: writes fresh when file absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wstate-"));
  const f = path.join(dir, "s.json");
  try {
    updateState(f, { status: "watching" });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), { status: "watching" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeLatestPointer: writes {headSha, status, updatedAt}", () => {
  const owner = "o";
  const repo = `r-${Math.random().toString(36).slice(2)}`;
  const pr = 1;
  const lp = latestPointer("github.com", owner, repo, pr);
  try {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    writeLatestPointer("github.com", owner, repo, pr, { headSha: "deadbeef", status: "done" });
    const got = JSON.parse(fs.readFileSync(lp, "utf8"));
    assert.equal(got.headSha, "deadbeef");
    assert.equal(got.status, "done");
    assert.equal(typeof got.updatedAt, "string");
  } finally {
    fs.rmSync(path.dirname(lp), { recursive: true, force: true });
  }
});
