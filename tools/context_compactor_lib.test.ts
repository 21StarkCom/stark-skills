// Tests for `tools/context_compactor_lib.ts` — port of
// `scripts/context_compactor.py`. Covers checkpoint content assembly,
// the size cap, `last_checkpoint` propagation back into session_state,
// `getLatestCheckpoint` lookup, and config defaults.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCheckpointContent,
  DEFAULT_CONTEXT_COMPACTION,
  generateCheckpoint,
  getLatestCheckpoint,
  loadContextCompactionConfig,
} from "./context_compactor_lib.ts";
import { saveState } from "./session_state_lib.ts";
import type { SessionState } from "./session_state_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-compactor-test-"));
}

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    session_id: "ckpt-session",
    started_at: "2026-04-01T10:00:00Z",
    branch: "main",
    repo: "21-Stark-AI/stark-skills",
    tasks_completed: ["task-1", "task-2"],
    last_checkpoint: null,
    context: { env: "test" },
    name: null,
    start_head: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCheckpointContent
// ---------------------------------------------------------------------------

test("buildCheckpointContent: includes Generated timestamp and the session header", () => {
  const md = buildCheckpointContent({
    state: makeState(),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "(stub)",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date("2026-05-18T08:00:00Z"),
  });
  assert.ok(md.includes("# Session Checkpoint"));
  assert.ok(md.includes("**Generated:** 2026-05-18T08:00:00Z"));
  assert.ok(md.includes("- **Session ID:** ckpt-session"));
  assert.ok(md.includes("- **Branch:** main"));
  assert.ok(md.includes("- **Repo:** 21-Stark-AI/stark-skills"));
});

test("buildCheckpointContent: lists tasks_completed", () => {
  const md = buildCheckpointContent({
    state: makeState(),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  assert.ok(md.includes("- task-1"));
  assert.ok(md.includes("- task-2"));
});

test("buildCheckpointContent: emits '(none)' tasks placeholder when empty", () => {
  const md = buildCheckpointContent({
    state: makeState({ tasks_completed: [] }),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  assert.ok(md.includes("## Tasks Completed"));
  assert.ok(md.includes("_(none)_"));
});

test("buildCheckpointContent: includes Key Decisions when context is non-empty", () => {
  const md = buildCheckpointContent({
    state: makeState({ context: { decision_x: "go with B", env: "prod" } }),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  assert.ok(md.includes("## Key Decisions"));
  assert.ok(md.includes("- **decision_x:** go with B"));
  assert.ok(md.includes("- **env:** prod"));
});

test("buildCheckpointContent: omits Key Decisions when context is empty", () => {
  const md = buildCheckpointContent({
    state: makeState({ context: {} }),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  assert.ok(!md.includes("## Key Decisions"));
});

test("buildCheckpointContent: lists modified files + emits 3-line summaries when enabled", () => {
  const md = buildCheckpointContent({
    state: makeState(),
    cfg: { ...DEFAULT_CONTEXT_COMPACTION, include_file_summaries: true },
    gitLogOneline: () => "",
    gitModifiedFiles: () => ["a.ts", "b.ts"],
    fileHead: (p) => `head of ${p}`,
    now: () => new Date(),
  });
  assert.ok(md.includes("- `a.ts`"));
  assert.ok(md.includes("- `b.ts`"));
  assert.ok(md.includes("### File Summaries (first 3 lines)"));
  assert.ok(md.includes("**a.ts**"));
  assert.ok(md.includes("head of a.ts"));
  assert.ok(md.includes("head of b.ts"));
});

test("buildCheckpointContent: lists modified files WITHOUT summaries when disabled", () => {
  const md = buildCheckpointContent({
    state: makeState(),
    cfg: { ...DEFAULT_CONTEXT_COMPACTION, include_file_summaries: false },
    gitLogOneline: () => "",
    gitModifiedFiles: () => ["a.ts"],
    fileHead: () => "should-not-appear",
    now: () => new Date(),
  });
  assert.ok(md.includes("- `a.ts`"));
  assert.ok(!md.includes("### File Summaries"));
  assert.ok(!md.includes("should-not-appear"));
});

test("buildCheckpointContent: '(no modified files detected)' placeholder", () => {
  const md = buildCheckpointContent({
    state: makeState(),
    cfg: DEFAULT_CONTEXT_COMPACTION,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  assert.ok(md.includes("_(no modified files detected)_"));
});

// ---------------------------------------------------------------------------
// generateCheckpoint — full roundtrip
// ---------------------------------------------------------------------------

test("generateCheckpoint: writes checkpoint-{timestamp}.md inside sessions/<sid>/", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  const ckpt = generateCheckpoint({
    sessionId: "ckpt-session",
    sessionsDir: dir,
    gitLogOneline: () => "abc commit one",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date("2026-05-18T08:30:00Z"),
  });
  assert.ok(fs.existsSync(ckpt));
  const parent = path.dirname(ckpt);
  assert.equal(path.basename(parent), "ckpt-session");
  assert.equal(path.dirname(parent), dir);
  const filename = path.basename(ckpt);
  assert.match(filename, /^checkpoint-\d{8}T\d{6}Z\.md$/);
});

test("generateCheckpoint: updates session_state.last_checkpoint and persists", () => {
  const dir = tmp();
  saveState(makeState(), dir);
  const ckpt = generateCheckpoint({
    sessionId: "ckpt-session",
    sessionsDir: dir,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  const reloaded = JSON.parse(
    fs.readFileSync(path.join(dir, "ckpt-session.json"), "utf8"),
  ) as SessionState;
  assert.equal(reloaded.last_checkpoint, ckpt);
});

test("generateCheckpoint: synthesizes a minimal state when session_state file is missing", () => {
  const dir = tmp();
  const ckpt = generateCheckpoint({
    sessionId: "ephemeral",
    sessionsDir: dir,
    gitLogOneline: () => "",
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date("2026-05-18T09:00:00Z"),
  });
  assert.ok(fs.existsSync(ckpt));
  const md = fs.readFileSync(ckpt, "utf8");
  assert.ok(md.includes("ephemeral"));
});

test("generateCheckpoint: truncates content past max_checkpoint_size_kb cap", () => {
  const dir = tmp();
  // 1KB cap + giant per-file head — should land near 1 KB + small tolerance.
  saveState(makeState(), dir);
  const big = "x".repeat(5000);
  const ckpt = generateCheckpoint({
    sessionId: "ckpt-session",
    sessionsDir: dir,
    cfg: { ...DEFAULT_CONTEXT_COMPACTION, max_checkpoint_size_kb: 1 },
    gitLogOneline: () => big,
    gitModifiedFiles: () => [],
    fileHead: () => "",
    now: () => new Date(),
  });
  const stat = fs.statSync(ckpt);
  // Cap is 1 KB, allow a tiny tolerance for the truncation marker line.
  assert.ok(stat.size <= 1024 + 80, `size ${stat.size} exceeded 1 KB + tolerance`);
  const md = fs.readFileSync(ckpt, "utf8");
  assert.ok(md.includes("_(checkpoint truncated due to size limit)_"));
});

// ---------------------------------------------------------------------------
// getLatestCheckpoint
// ---------------------------------------------------------------------------

test("getLatestCheckpoint: returns null when the session dir doesn't exist", () => {
  const dir = tmp();
  assert.equal(getLatestCheckpoint({ sessionId: "nope", sessionsDir: dir }), null);
});

test("getLatestCheckpoint: returns null when the dir exists but no checkpoints", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "ckpt-session"), { recursive: true });
  assert.equal(
    getLatestCheckpoint({ sessionId: "ckpt-session", sessionsDir: dir }),
    null,
  );
});

test("getLatestCheckpoint: returns the lexicographically-newest checkpoint", () => {
  // Python sorts by `glob` (alphabetical); since filenames are timestamp-
  // prefixed, newest sorts last → returned. Verify parity.
  const dir = tmp();
  const sessDir = path.join(dir, "ckpt-session");
  fs.mkdirSync(sessDir, { recursive: true });
  const older = path.join(sessDir, "checkpoint-20260518T080000Z.md");
  const newer = path.join(sessDir, "checkpoint-20260518T090000Z.md");
  fs.writeFileSync(older, "older");
  fs.writeFileSync(newer, "newer");
  assert.equal(
    getLatestCheckpoint({ sessionId: "ckpt-session", sessionsDir: dir }),
    newer,
  );
});

// ---------------------------------------------------------------------------
// loadContextCompactionConfig — defaults + override merge
// ---------------------------------------------------------------------------

test("loadContextCompactionConfig: returns defaults when config file is missing", () => {
  const cfg = loadContextCompactionConfig("/does/not/exist.json");
  assert.deepEqual(cfg, DEFAULT_CONTEXT_COMPACTION);
});

test("loadContextCompactionConfig: returns defaults when config has no section", () => {
  const dir = tmp();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, JSON.stringify({ other_section: { foo: 1 } }));
  const cfg = loadContextCompactionConfig(p);
  assert.deepEqual(cfg, DEFAULT_CONTEXT_COMPACTION);
});

test("loadContextCompactionConfig: merges overrides over defaults (partial)", () => {
  const dir = tmp();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({ context_compaction: { max_checkpoint_size_kb: 200 } }),
  );
  const cfg = loadContextCompactionConfig(p);
  // override:
  assert.equal(cfg.max_checkpoint_size_kb, 200);
  // unchanged defaults:
  assert.equal(cfg.checkpoint_interval_minutes, 15);
  assert.equal(cfg.include_file_summaries, true);
  assert.equal(cfg.enabled, true);
});

test("loadContextCompactionConfig: tolerates malformed JSON, returns defaults", () => {
  const dir = tmp();
  const p = path.join(dir, "config.json");
  fs.writeFileSync(p, "{not valid");
  assert.deepEqual(loadContextCompactionConfig(p), DEFAULT_CONTEXT_COMPACTION);
});
