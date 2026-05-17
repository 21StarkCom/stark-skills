// Tests for `tools/emit_queue_lib.ts` — the TS write-side of the durable
// queue. Covers parity with `scripts/emit_queue.py` for the surfaces
// Phase 2 of the emit-queue → TS migration ports (recordContextPct,
// pendingCount, deadLetterCount, health, initSchema), plus the
// pre-existing write path (validate, redact, dedupe formulas, enqueue).

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ctxHistoryPath,
  deadLetterCount,
  enqueue,
  health,
  initSchema,
  makeEvent,
  pendingCount,
  queueDbPath,
  queueDir,
  recordContextPct,
  validate,
} from "./emit_queue_lib.ts";

function freshEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-queue-lib-"));
  return { ...process.env, STARK_QUEUE_DIR: dir, CLAUDE_SESSION_ID: "test-session" };
}

function baseEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: "skill_invocation",
    timestamp: "2026-04-01T14:30:00Z",
    cli: "claude",
    source: "skill",
    schema_version: 1,
    payload: { skill: "stark-team-review", duration_s: 120 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// validate()
// ---------------------------------------------------------------------------

test("validate accepts a well-formed event", () => {
  assert.deepEqual(validate(baseEvent()), []);
});

test("validate rejects unknown event type", () => {
  const errs = validate(baseEvent({ type: "bogus" }));
  assert.ok(errs.some((e) => e.includes("invalid type")));
});

test("validate rejects unknown cli", () => {
  const errs = validate(baseEvent({ cli: "chatgpt" }));
  assert.ok(errs.some((e) => e.includes("invalid cli")));
});

test("validate rejects unknown source", () => {
  // VALID_SOURCES is {skill, hook, scraper, backfill} — matches the Python
  // _VALID_SOURCES exactly. Use a definitely-bogus name.
  const errs = validate(baseEvent({ source: "magic" }));
  assert.ok(errs.some((e) => e.includes("invalid source")));
});

test("validate accepts every source in the parity set", () => {
  for (const source of ["skill", "hook", "scraper", "backfill"]) {
    assert.deepEqual(validate(baseEvent({ source })), [], source);
  }
});

test("validate rejects the removed 'subagent' source", () => {
  // Locks in the intentional removal from the prior {skill, hook, subagent}
  // set. If you're re-adding 'subagent', delete this test deliberately.
  const errs = validate(baseEvent({ source: "subagent" }));
  assert.ok(errs.some((e) => e.includes("invalid source")));
});

test("validate rejects payload that isn't an object", () => {
  const errs = validate(baseEvent({ payload: "not a dict" }));
  assert.ok(errs.some((e) => e.includes("payload")));
});

test("validate rejects empty required strings", () => {
  for (const field of ["type", "timestamp", "cli", "source"] as const) {
    const errs = validate(baseEvent({ [field]: "" }));
    assert.ok(errs.some((e) => e.includes(field)), `expected ${field} error`);
  }
});

test("validate accepts v2 + red-team event types", () => {
  for (const type of [
    "red_team_run",
    "red_team_finding",
    "red_team_fix_plan",
    "red_team_call_start",
    "red_team_call_end",
  ]) {
    assert.deepEqual(validate(baseEvent({ type })), [], type);
  }
});

test("validate accepts the v2 + tool + ci + back-compat type set", () => {
  // Broader sweep — every additional type widened in this PR (beyond the
  // red-team batch above). If a future change drops one, this test fails
  // loudly instead of being silently masked by the negative coverage.
  for (const type of [
    "skill_invocation", "review_finding", "review_quality",
    "agent_dispatch", "prompt", "correction",
    "memory_write", "code_change", "bug_fix",
    "pr_event", "tool_usage", "ci_signal",
    "tournament_result", "preflight_check", "approach_contract",
    "validation_result", "heal_attempt",
    "context_compaction", "learning_captured", "skill_recommendation",
    "learning_capture", "skill_suggestion",
    "red_team_override_rejected",
  ]) {
    assert.deepEqual(validate(baseEvent({ type })), [], type);
  }
});

// ---------------------------------------------------------------------------
// makeEvent + dedupe formulas (ADR-0014)
// ---------------------------------------------------------------------------

test("makeEvent uses defaults for cli/source/schema_version", () => {
  const env = freshEnv();
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: { skill: "x" },
    env,
  });
  assert.equal(event.type, "skill_invocation");
  assert.equal(event.cli, "claude");
  assert.equal(event.source, "skill");
  assert.equal(event.schema_version, 2);
  assert.ok(event.event_id.length > 0);
  assert.ok(event.timestamp.endsWith("Z"));
});

test("makeEvent honors explicit dedupe key over the auto formula", () => {
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: {},
    sessionId: "sess-1",
    dedupeKey: "custom-key",
  });
  assert.equal(event.dedupe_key, "custom-key");
});

// ADR-0014 source-specific dedupe formulas. The TS auto-formula MUST match
// Python's `_default_dedupe_key` exactly because Python consumers (preflight,
// validation_gate, skill_router, …) compute their dedupe keys via the same
// path during the migration window — divergence would re-deliver events.

test("dedupe skill: payload {skill, start_timestamp} → `{skill}:{sid}:{start_ts}`", () => {
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: { skill: "stark-team-review", start_timestamp: 1700000000 },
    sessionId: "sess-123",
    source: "skill",
  });
  assert.equal(event.dedupe_key, "stark-team-review:sess-123:1700000000");
});

test("dedupe hook: payload {sequence_number} → `{cli}:{sid}:{seq}`", () => {
  const event = makeEvent({
    eventType: "tool_usage",
    payload: { sequence_number: 42 },
    sessionId: "sess-1",
    source: "hook",
    cli: "codex",
  });
  assert.equal(event.dedupe_key, "codex:sess-1:42");
});

test("dedupe scraper: payload {file_path, byte_offset} → `{cli}:{file_path}:{byte_offset}`", () => {
  const event = makeEvent({
    eventType: "ci_signal",
    payload: { file_path: "/var/log/ci.log", byte_offset: 12345 },
    sessionId: "sess-x",
    source: "scraper",
    cli: "gemini",
  });
  assert.equal(event.dedupe_key, "gemini:/var/log/ci.log:12345");
});

test("dedupe generic fallback: skill payload without `skill` → `{type}:{sid}:{ts}`", () => {
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: {},
    sessionId: "s",
    source: "skill",
  });
  assert.match(event.dedupe_key, /^skill_invocation:s:\d+$/);
});

test("dedupe skill: falsy start_timestamp (0/'') falls back to now (Python parity)", () => {
  // Python uses `or ts` — `0` and `''` coalesce to current ts. The TS
  // ?? operator preserves them, which would drift dedupe keys between
  // the two implementations during the coexistence window. Regression
  // guard for that divergence.
  for (const falsy of [0, ""]) {
    const event = makeEvent({
      eventType: "skill_invocation",
      payload: { skill: "stark-team-review", start_timestamp: falsy },
      sessionId: "sess-z",
      source: "skill",
    });
    assert.match(event.dedupe_key, /^stark-team-review:sess-z:\d+$/,
      `falsy start_timestamp=${JSON.stringify(falsy)} should fall back to ts`);
  }
});

// ---------------------------------------------------------------------------
// enqueue + queue introspection
// ---------------------------------------------------------------------------

test("enqueue persists a valid event and reports non-duplicate", () => {
  const env = freshEnv();
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: { skill: "x" },
    dedupeKey: "uniq-1",
    env,
  });
  const r = enqueue(event, env);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, false);
  assert.equal(pendingCount(env), 1);
});

test("enqueue with duplicate dedupe_key is ignored", () => {
  const env = freshEnv();
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: { skill: "x" },
    dedupeKey: "dup-1",
    env,
  });
  enqueue(event, env);
  const r = enqueue(event, env);
  assert.equal(r.ok, true);
  assert.equal(r.duplicate, true);
  assert.equal(pendingCount(env), 1);
});

test("enqueue with invalid event returns ok:false + error message", () => {
  const env = freshEnv();
  // Pass a deliberately broken event shape (bypasses makeEvent).
  const r = enqueue({ type: "bogus" } as never, env);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Invalid event/);
});

test("enqueue redacts API-key-shaped tokens in the persisted JSON", () => {
  const env = freshEnv();
  const event = makeEvent({
    eventType: "skill_invocation",
    payload: { token: "sk-1234567890abcdef" },
    dedupeKey: "redact-1",
    env,
  });
  enqueue(event, env);
  const db = new DatabaseSync(queueDbPath(env));
  try {
    const row = db
      .prepare("SELECT event_json FROM pending WHERE dedupe_key = ?")
      .get("redact-1") as { event_json: string };
    assert.ok(!row.event_json.includes("sk-1234567890abcdef"));
    assert.ok(row.event_json.includes("sk-[REDACTED]"));
  } finally {
    db.close();
  }
});

test("pendingCount + deadLetterCount on a fresh DB return zero", () => {
  const env = freshEnv();
  assert.equal(pendingCount(env), 0);
  assert.equal(deadLetterCount(env), 0);
});

test("health on a fresh DB returns {pending_count:0, max_created_at:null}", () => {
  const env = freshEnv();
  const h = health(env);
  assert.equal(h.pending_count, 0);
  assert.equal(h.max_created_at, null);
});

test("health reports COUNT + MAX(created_at) after enqueue", () => {
  const env = freshEnv();
  enqueue(
    makeEvent({ eventType: "skill_invocation", payload: { skill: "a" }, dedupeKey: "h-1", env }),
    env,
  );
  enqueue(
    makeEvent({ eventType: "skill_invocation", payload: { skill: "b" }, dedupeKey: "h-2", env }),
    env,
  );
  const h = health(env);
  assert.equal(h.pending_count, 2);
  assert.ok(h.max_created_at !== null, "max_created_at should be set");
});

// ---------------------------------------------------------------------------
// recordContextPct trend math (Python parity)
// ---------------------------------------------------------------------------

test("recordContextPct first reading returns empty trend", () => {
  const env = freshEnv();
  const trend = recordContextPct(10, env);
  assert.equal(trend, "");
});

test("recordContextPct returns ▲ on a >=5pp jump", () => {
  const env = freshEnv();
  recordContextPct(10, env);
  const trend = recordContextPct(20, env); // +10pp
  assert.equal(trend, "▲");
});

test("recordContextPct returns ▸ on a 1pp..5pp move", () => {
  const env = freshEnv();
  recordContextPct(50, env);
  const trend = recordContextPct(52, env); // +2pp
  assert.equal(trend, "▸");
});

test("recordContextPct returns empty on a sub-1pp move", () => {
  const env = freshEnv();
  recordContextPct(50, env);
  const trend = recordContextPct(50.5, env);
  assert.equal(trend, "");
});

test("recordContextPct keeps at most 10 entries on disk", () => {
  const env = freshEnv();
  for (let i = 0; i < 15; i += 1) recordContextPct(i, env);
  const lines = fs.readFileSync(ctxHistoryPath(env), "utf8").trim().split("\n");
  assert.equal(lines.length, 10);
});

test("recordContextPct writes via tmp+rename (no .tmp left behind)", () => {
  const env = freshEnv();
  recordContextPct(42, env);
  const tmp = ctxHistoryPath(env) + ".tmp";
  assert.equal(fs.existsSync(tmp), false);
});

test("recordContextPct trend compares against the oldest kept entry", () => {
  // The semantic invariant is `kept[0]` (oldest in the rolling window),
  // not the previous reading. A slow-rise series (each step <1pp vs
  // previous, but cumulatively > 5pp vs oldest) must trigger ▲ — that's
  // what catches a regression that compares-to-previous instead of
  // compares-to-oldest.
  const env = freshEnv();
  for (const v of [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5]) {
    recordContextPct(v, env);
  }
  // window now contains [50..54.5]. Next write of 56 is +1.5pp vs the
  // previous (54.5) — would NOT trigger ▲ under compare-to-previous —
  // but +6pp vs the oldest (50) which MUST trigger ▲ under the
  // documented compare-to-oldest semantics.
  const trend = recordContextPct(56, env);
  assert.equal(trend, "▲");
});

// ---------------------------------------------------------------------------
// initSchema
// ---------------------------------------------------------------------------

test("initSchema creates queue.db with pending + dead_letter tables", () => {
  const env = freshEnv();
  const dbPath = initSchema(env);
  assert.equal(dbPath, queueDbPath(env));
  assert.equal(fs.existsSync(dbPath), true);
  const db = new DatabaseSync(dbPath);
  try {
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(tables.includes("pending"));
    assert.ok(tables.includes("dead_letter"));
  } finally {
    db.close();
  }
});

test("initSchema is idempotent: running it twice doesn't error", () => {
  const env = freshEnv();
  initSchema(env);
  initSchema(env);
  assert.equal(pendingCount(env), 0);
});

// ---------------------------------------------------------------------------
// queueDir / queueDbPath env honoring
// ---------------------------------------------------------------------------

test("queueDir honors STARK_QUEUE_DIR override", () => {
  const env = { STARK_QUEUE_DIR: "/tmp/somewhere" } as NodeJS.ProcessEnv;
  assert.equal(queueDir(env), "/tmp/somewhere");
  assert.equal(queueDbPath(env), "/tmp/somewhere/queue.db");
});
