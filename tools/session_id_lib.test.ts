// Tests for `tools/session_id_lib.ts` — port of `scripts/session_id.py`.
// Covers the three-tier resolver (CLAUDE_SESSION_ID env > project marker
// scan > uuid4 fallback) and the standalone checkpoint reader.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveFromCheckpoint,
  resolveFromProjectsDir,
  resolveSessionId,
} from "./session_id_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-id-test-"));
}

function writeJson(dir: string, name: string, data: unknown, mtimeOffset = 0): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data));
  if (mtimeOffset !== 0) {
    const t = (Date.now() + mtimeOffset) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

// ---------------------------------------------------------------------------
// resolveSessionId — env precedence
// ---------------------------------------------------------------------------

test("resolveSessionId: returns CLAUDE_SESSION_ID when set + non-empty", () => {
  const projectsDir = tmp();
  const id = resolveSessionId({
    env: { CLAUDE_SESSION_ID: "explicit-id" },
    projectsDir,
  });
  assert.equal(id, "explicit-id");
});

test("resolveSessionId: trims whitespace from CLAUDE_SESSION_ID", () => {
  const projectsDir = tmp();
  const id = resolveSessionId({
    env: { CLAUDE_SESSION_ID: "  trimmed  " },
    projectsDir,
  });
  assert.equal(id, "trimmed");
});

test("resolveSessionId: skips CLAUDE_SESSION_ID when blank, falls through", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "marker.json", { session_id: "from-marker" });
  const id = resolveSessionId({
    env: { CLAUDE_SESSION_ID: "   " },
    projectsDir,
  });
  assert.equal(id, "from-marker");
});

// ---------------------------------------------------------------------------
// resolveSessionId — projects-dir scan
// ---------------------------------------------------------------------------

test("resolveSessionId: finds session_id in a flat projects dir", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "a.json", { session_id: "uuid-a" });
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "uuid-a");
});

test("resolveSessionId: recurses into nested project dirs (Path.rglob parity)", () => {
  const projectsDir = tmp();
  writeJson(
    path.join(projectsDir, "proj-alpha", "subdir"),
    "marker.json",
    { session_id: "nested-uuid" },
  );
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "nested-uuid");
});

test("resolveSessionId: prefers newest-mtime marker when multiple exist", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "old.json", { session_id: "old-uuid" }, -60_000);
  writeJson(projectsDir, "new.json", { session_id: "new-uuid" });
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "new-uuid");
});

test("resolveSessionId: skips markers with empty session_id and continues", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "newest.json", { session_id: "" });
  writeJson(projectsDir, "older.json", { session_id: "real-uuid" }, -10_000);
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "real-uuid");
});

test("resolveSessionId: skips markers with whitespace-only session_id", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "newest.json", { session_id: "   " });
  writeJson(projectsDir, "older.json", { session_id: "real-uuid" }, -10_000);
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "real-uuid");
});

test("resolveSessionId: skips non-dict JSON (e.g. arrays) gracefully", () => {
  const projectsDir = tmp();
  fs.writeFileSync(path.join(projectsDir, "newest.json"), JSON.stringify([1, 2, 3]));
  writeJson(projectsDir, "older.json", { session_id: "real" }, -10_000);
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "real");
});

test("resolveSessionId: skips malformed JSON files and keeps scanning", () => {
  const projectsDir = tmp();
  fs.writeFileSync(path.join(projectsDir, "bad.json"), "not json {");
  writeJson(projectsDir, "good.json", { session_id: "good-uuid" }, -10_000);
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "good-uuid");
});

test("resolveSessionId: trims whitespace from marker session_id value", () => {
  const projectsDir = tmp();
  writeJson(projectsDir, "marker.json", { session_id: "  padded-uuid  " });
  const id = resolveSessionId({ env: {}, projectsDir });
  assert.equal(id, "padded-uuid");
});

// ---------------------------------------------------------------------------
// resolveSessionId — uuid4 fallback
// ---------------------------------------------------------------------------

test("resolveSessionId: returns a uuid4 when env + projects dir yield nothing", () => {
  const projectsDir = tmp(); // empty
  const id = resolveSessionId({ env: {}, projectsDir });
  // RFC 4122 v4 shape: 8-4-4-4-12 hex, version nibble = 4
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("resolveSessionId: returns a uuid4 when projectsDir doesn't exist", () => {
  const dir = path.join(tmp(), "does-not-exist");
  const id = resolveSessionId({ env: {}, projectsDir: dir });
  assert.match(id, /^[0-9a-f-]{36}$/i);
});

// ---------------------------------------------------------------------------
// resolveFromProjectsDir (standalone, returns null when no marker)
// ---------------------------------------------------------------------------

test("resolveFromProjectsDir: returns null when dir doesn't exist", () => {
  const dir = path.join(tmp(), "missing");
  assert.equal(resolveFromProjectsDir(dir), null);
});

test("resolveFromProjectsDir: returns null when no .json files present", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "notes.txt"), "irrelevant");
  assert.equal(resolveFromProjectsDir(dir), null);
});

// ---------------------------------------------------------------------------
// resolveFromCheckpoint (single-file reader)
// ---------------------------------------------------------------------------

test("resolveFromCheckpoint: reads session_id from a checkpoint file", () => {
  const dir = tmp();
  const file = path.join(dir, "checkpoint.json");
  fs.writeFileSync(file, JSON.stringify({ session_id: "ckpt-uuid", other: "data" }));
  assert.equal(resolveFromCheckpoint(file), "ckpt-uuid");
});

test("resolveFromCheckpoint: returns null when file is missing", () => {
  assert.equal(resolveFromCheckpoint("/nonexistent/file.json"), null);
});

test("resolveFromCheckpoint: returns null when JSON is malformed", () => {
  const dir = tmp();
  const file = path.join(dir, "bad.json");
  fs.writeFileSync(file, "not json");
  assert.equal(resolveFromCheckpoint(file), null);
});

test("resolveFromCheckpoint: returns null when value is non-string", () => {
  const dir = tmp();
  const file = path.join(dir, "weird.json");
  fs.writeFileSync(file, JSON.stringify({ session_id: 42 }));
  assert.equal(resolveFromCheckpoint(file), null);
});

test("resolveFromCheckpoint: returns null when JSON root is not an object", () => {
  const dir = tmp();
  const file = path.join(dir, "arr.json");
  fs.writeFileSync(file, JSON.stringify(["session_id", "foo"]));
  assert.equal(resolveFromCheckpoint(file), null);
});

test("resolveFromCheckpoint: trims whitespace from value", () => {
  const dir = tmp();
  const file = path.join(dir, "p.json");
  fs.writeFileSync(file, JSON.stringify({ session_id: "  spaced  " }));
  assert.equal(resolveFromCheckpoint(file), "spaced");
});
