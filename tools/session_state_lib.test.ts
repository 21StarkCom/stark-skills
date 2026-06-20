// Tests for `tools/session_state_lib.ts` — port of `scripts/session_state.py`.
// Covers the SessionState shape, on-disk roundtrip, sanitization (defends
// against path traversal via session ID), git-derived defaults, the
// repo URL normalizer, and the mutation helpers used by SKILL.md.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type SessionState,
  loadState,
  normalizeRepoUrl,
  sanitizeId,
  saveState,
  setField,
} from "./session_state_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-state-test-"));
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "abc-123",
    started_at: "2026-05-18T00:00:00Z",
    branch: "main",
    repo: "21-Stark-AI/stark-skills",
    tasks_completed: [],
    last_checkpoint: null,
    context: {},
    name: null,
    start_head: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sanitizeId — must strip path-traversal characters
// ---------------------------------------------------------------------------

test("sanitizeId: keeps alphanumerics, dashes, underscores", () => {
  assert.equal(sanitizeId("abc-123_def"), "abc-123_def");
});

test("sanitizeId: strips slashes, dots, and other path glyphs", () => {
  assert.equal(sanitizeId("../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeId("foo/bar"), "foobar");
  assert.equal(sanitizeId("foo.bar"), "foobar");
});

test("sanitizeId: strips whitespace and special chars", () => {
  assert.equal(sanitizeId("a b c"), "abc");
  assert.equal(sanitizeId("a!@#$%^&*()b"), "ab");
});

// ---------------------------------------------------------------------------
// normalizeRepoUrl — owner/repo extraction
// ---------------------------------------------------------------------------

test("normalizeRepoUrl: https GitHub URL → owner/repo", () => {
  assert.equal(
    normalizeRepoUrl("https://github.com/21-Stark-AI/stark-skills.git"),
    "21-Stark-AI/stark-skills",
  );
});

test("normalizeRepoUrl: ssh GitHub URL → owner/repo", () => {
  assert.equal(
    normalizeRepoUrl("git@github.com:21-Stark-AI/stark-skills.git"),
    "21-Stark-AI/stark-skills",
  );
});

test("normalizeRepoUrl: handles missing .git suffix", () => {
  assert.equal(
    normalizeRepoUrl("https://github.com/foo/bar"),
    "foo/bar",
  );
});

test("normalizeRepoUrl: trims trailing slash before .git stripping", () => {
  assert.equal(
    normalizeRepoUrl("https://github.com/foo/bar/"),
    "foo/bar",
  );
});

test("normalizeRepoUrl: non-GitHub URL passed through after .git/slash strip", () => {
  assert.equal(
    normalizeRepoUrl("https://gitlab.com/foo/bar.git"),
    "https://gitlab.com/foo/bar",
  );
});

test("normalizeRepoUrl: empty input returns empty", () => {
  assert.equal(normalizeRepoUrl(""), "");
});

// ---------------------------------------------------------------------------
// save/load roundtrip
// ---------------------------------------------------------------------------

test("saveState + loadState: full roundtrip preserves all fields", () => {
  const dir = tmp();
  const original = makeState({
    tasks_completed: ["t1", "t2"],
    last_checkpoint: "/path/to/ck.json",
    context: { foo: "bar", n: 42 },
    name: "ship-the-thing",
    start_head: "abcd1234",
  });
  saveState(original, dir);
  const loaded = loadState(original.session_id, dir);
  assert.deepEqual(loaded, original);
});

test("saveState: writes to <dir>/<sanitized-id>.json", () => {
  const dir = tmp();
  saveState(makeState({ session_id: "weird/../id" }), dir);
  const expected = path.join(dir, "weirdid.json"); // sanitized
  assert.ok(fs.existsSync(expected));
});

test("loadState: returns null when file is missing", () => {
  const dir = tmp();
  assert.equal(loadState("nonexistent-id", dir), null);
});

test("loadState: returns null on malformed JSON", () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bad.json"), "{not json");
  assert.equal(loadState("bad", dir), null);
});

test("loadState: returns null when JSON root is not an object", () => {
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "arr.json"), JSON.stringify([1, 2, 3]));
  assert.equal(loadState("arr", dir), null);
});

test("loadState: fills missing fields with safe defaults (Python parity)", () => {
  // Python uses data.get(...) with defaults — old state files without
  // the newer fields (name, start_head, context) must still load.
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "old.json"),
    JSON.stringify({
      session_id: "old",
      started_at: "2026-01-01T00:00:00Z",
      branch: "main",
      repo: "x/y",
    }),
  );
  const loaded = loadState("old", dir);
  assert.ok(loaded);
  assert.deepEqual(loaded!.tasks_completed, []);
  assert.equal(loaded!.last_checkpoint, null);
  assert.equal(loaded!.name, null);
  assert.equal(loaded!.start_head, null);
  assert.deepEqual(loaded!.context, {});
});

test("loadState: preserves session_id from disk over the lookup id", () => {
  // Python falls back to the lookup `session_id` only if the on-disk
  // value is missing — matching Python's `data.get("session_id", session_id)`.
  const dir = tmp();
  saveState(makeState({ session_id: "real-id" }), dir);
  const loaded = loadState("real-id", dir);
  assert.equal(loaded!.session_id, "real-id");
});

// ---------------------------------------------------------------------------
// setField — used by /stark-session SKILL.md Phase 3 / Phase 6
// ---------------------------------------------------------------------------

test("setField: updates start_head on existing state and persists", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  setField({
    sessionId: "abc-123",
    field: "start_head",
    value: "deadbeef",
    sessionsDir: dir,
  });
  const loaded = loadState("abc-123", dir);
  assert.equal(loaded!.start_head, "deadbeef");
});

test("setField: updates name on existing state and persists", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  setField({
    sessionId: "abc-123",
    field: "name",
    value: "ship-it",
    sessionsDir: dir,
  });
  const loaded = loadState("abc-123", dir);
  assert.equal(loaded!.name, "ship-it");
});

test("setField: updates last_checkpoint on existing state and persists", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  setField({
    sessionId: "abc-123",
    field: "last_checkpoint",
    value: "/tmp/ckpt.json",
    sessionsDir: dir,
  });
  const loaded = loadState("abc-123", dir);
  assert.equal(loaded!.last_checkpoint, "/tmp/ckpt.json");
});

test("setField: creates new state file when none exists (Python get_current parity)", () => {
  const dir = tmp();
  setField({
    sessionId: "fresh-id",
    field: "start_head",
    value: "f00d",
    sessionsDir: dir,
    started_at: "2026-05-18T00:00:00Z",
    branch: "feat/x",
    repo: "owner/repo",
  });
  const loaded = loadState("fresh-id", dir);
  assert.equal(loaded!.session_id, "fresh-id");
  assert.equal(loaded!.start_head, "f00d");
  assert.equal(loaded!.branch, "feat/x");
});

test("setField: throws on unknown field", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  assert.throws(
    () =>
      setField({
        // @ts-expect-error — invalid field name on purpose
        field: "bogus",
        sessionId: "abc-123",
        value: "x",
        sessionsDir: dir,
      }),
    /unknown field/,
  );
});
