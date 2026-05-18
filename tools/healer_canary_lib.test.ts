// Tests for `tools/healer_canary_lib.ts` — port + improvements over
// `scripts/healer_canary.py`. The Python had ZERO tests, so these
// establish the contract for the canary subsystem from scratch.
//
// Tests cover: data loaders (patterns, circuits, config, log entries),
// stats math, promotion-criteria gating (configurable), all four
// commands (status, promote, demote, AND the two new commands —
// check + closeCircuit), explain output, atomic config writes, and
// the `healer_canary` insights event payload shape.

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type CircuitState,
  type HealerLogEntry,
  type HealerPattern,
  appendLogEntry,
  checkPromotionCriteria,
  cmdCheck,
  cmdCloseCircuit,
  cmdDemote,
  cmdExplain,
  cmdPromote,
  cmdStatus,
  computeStats,
  DEFAULT_GATE,
  loadCircuits,
  loadConfig,
  loadGate,
  loadLogEntries,
  loadPatterns,
  writeConfig,
} from "./healer_canary_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "healer-canary-test-"));
}

interface TestCtx {
  dir: string;
  patternsPath: string;
  circuitsPath: string;
  configPath: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

function ctx(): TestCtx {
  const dir = tmp();
  const queueDir = path.join(dir, "stark-insights");
  return {
    dir,
    patternsPath: path.join(dir, "healer_patterns.json"),
    circuitsPath: path.join(dir, "healer-circuits.json"),
    configPath: path.join(dir, "config.json"),
    logPath: path.join(dir, "healer.jsonl"),
    env: {
      ...process.env,
      STARK_QUEUE_DIR: queueDir,
      CLAUDE_SESSION_ID: "healer-canary-test",
    },
  };
}

function pattern(overrides: Partial<HealerPattern> = {}): HealerPattern {
  return {
    id: "test-pattern",
    requires_confirmation: false,
    ...overrides,
  };
}

function entry(overrides: Partial<HealerLogEntry> = {}): HealerLogEntry {
  return {
    timestamp: "2026-05-18T08:00:00Z",
    pattern_id: "test-pattern",
    status: "suggested",
    ...overrides,
  };
}

function queueEvents(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
  const file = path.join(env.STARK_QUEUE_DIR ?? "", "queue.db");
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file);
  try {
    const rows = db
      .prepare("SELECT event_json FROM pending ORDER BY id")
      .all() as Array<{ event_json: string }>;
    return rows.map((r) => JSON.parse(r.event_json));
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

test("loadPatterns: returns the parsed array from a valid file", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  const result = loadPatterns(c.patternsPath);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "p1");
});

test("loadPatterns: returns empty array when file is missing", () => {
  assert.deepEqual(loadPatterns("/does/not/exist.json"), []);
});

test("loadPatterns: returns empty array when JSON is malformed", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, "not json");
  assert.deepEqual(loadPatterns(c.patternsPath), []);
});

test("loadCircuits: returns empty object when file is missing", () => {
  assert.deepEqual(loadCircuits("/does/not/exist.json"), {});
});

test("loadConfig: returns empty object when file is missing", () => {
  assert.deepEqual(loadConfig("/does/not/exist.json"), {});
});

test("loadLogEntries: returns parsed entries from JSONL", () => {
  const c = ctx();
  const lines = [
    JSON.stringify(entry({ pattern_id: "a", status: "suggested" })),
    JSON.stringify(entry({ pattern_id: "b", status: "applied" })),
  ].join("\n");
  fs.writeFileSync(c.logPath, `${lines}\n`);
  const result = loadLogEntries(c.logPath);
  assert.equal(result.length, 2);
  assert.equal(result[0].pattern_id, "a");
  assert.equal(result[1].pattern_id, "b");
});

test("loadLogEntries: skips malformed lines and keeps reading", () => {
  const c = ctx();
  fs.writeFileSync(
    c.logPath,
    [
      JSON.stringify(entry({ pattern_id: "a" })),
      "not json",
      JSON.stringify(entry({ pattern_id: "b" })),
    ].join("\n") + "\n",
  );
  const result = loadLogEntries(c.logPath);
  assert.equal(result.length, 2);
});

test("loadLogEntries: returns empty list when file is missing", () => {
  assert.deepEqual(loadLogEntries("/does/not/exist.jsonl"), []);
});

// ---------------------------------------------------------------------------
// Atomic config writes
// ---------------------------------------------------------------------------

test("writeConfig: writes file with parents and pretty-prints", () => {
  const c = ctx();
  const cfg = { self_heal: { auto_patterns: ["p1"] } };
  writeConfig(cfg, c.configPath);
  const loaded = JSON.parse(fs.readFileSync(c.configPath, "utf8"));
  assert.deepEqual(loaded, cfg);
});

test("writeConfig: leaves no tmp file behind (atomic)", () => {
  const c = ctx();
  writeConfig({ a: 1 }, c.configPath);
  // No `.tmp` sibling should remain — write goes tmp → rename.
  const dir = path.dirname(c.configPath);
  const leftovers = fs
    .readdirSync(dir)
    .filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("writeConfig: never produces a half-written file on overlapping writes", () => {
  // Concurrent-ish writes: tmp+rename means a reader at any moment sees
  // either the old full content or the new full content, never a torn
  // half-write. Sanity check: after a hundred sequential writes, the
  // final read is a valid JSON object.
  const c = ctx();
  for (let i = 0; i < 100; i++) {
    writeConfig({ counter: i, deep: { nested: { value: i } } }, c.configPath);
  }
  const final = JSON.parse(fs.readFileSync(c.configPath, "utf8"));
  assert.equal(final.counter, 99);
  assert.equal(final.deep.nested.value, 99);
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

test("computeStats: counts suggested + applied + aborted in the last 7d", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const entries: HealerLogEntry[] = [
    entry({ status: "suggested", timestamp: "2026-05-18T08:00:00Z" }),
    entry({ status: "suggested", timestamp: "2026-05-18T09:00:00Z" }),
    entry({ status: "applied", timestamp: "2026-05-18T10:00:00Z" }),
    entry({ status: "aborted", timestamp: "2026-05-18T11:00:00Z" }), // in window
    entry({ status: "aborted", timestamp: "2026-04-01T12:00:00Z" }), // before window
  ];
  const stats = computeStats("test-pattern", entries, {}, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(stats.total_attempts, 5);
  assert.equal(stats.successful_suggests, 2);
  assert.equal(stats.applied, 1);
  assert.equal(stats.aborts_last_7d, 1);
});

test("computeStats: success_rate is (suggested + applied) / total", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const entries = [
    entry({ status: "suggested" }),
    entry({ status: "suggested" }),
    entry({ status: "applied" }),
    entry({ status: "aborted" }),
    entry({ status: "skipped" }),
  ];
  const stats = computeStats("test-pattern", entries, {}, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(stats.success_rate, 0.6);
});

test("computeStats: success_rate is 0 when no entries", () => {
  const stats = computeStats("test-pattern", [], {}, {
    gate: DEFAULT_GATE,
    now: new Date(),
  });
  assert.equal(stats.success_rate, 0);
  assert.equal(stats.total_attempts, 0);
});

test("computeStats: circuit_open=true when tripped within the configurable window", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const circuits: Record<string, CircuitState> = {
    "test-pattern": {
      tripped_at: "2026-05-18T11:00:00Z", // 1h ago
      ever_tripped: true,
      consecutive_failures: 3,
    },
  };
  const stats = computeStats("test-pattern", [], circuits, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(stats.circuit_open, true);
  assert.equal(stats.ever_tripped, true);
});

test("computeStats: circuit_open=false when trip was beyond the window", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const circuits: Record<string, CircuitState> = {
    "test-pattern": {
      tripped_at: "2026-05-15T11:00:00Z", // 3d ago
      ever_tripped: true,
    },
  };
  const stats = computeStats("test-pattern", [], circuits, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(stats.circuit_open, false);
  assert.equal(stats.ever_tripped, true);
});

test("computeStats: honors a configurable abort_window_days", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const entries = [
    entry({ status: "aborted", timestamp: "2026-05-15T12:00:00Z" }), // 3d ago
  ];
  // With a 1-day window, this abort is OUT of scope.
  const tight = computeStats("test-pattern", entries, {}, {
    gate: { ...DEFAULT_GATE, abort_window_days: 1 },
    now,
  });
  assert.equal(tight.aborts_last_7d, 0);
  // With the default 7-day window, this abort is IN scope.
  const loose = computeStats("test-pattern", entries, {}, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(loose.aborts_last_7d, 1);
});

test("computeStats: honors a configurable circuit_open_hours", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const circuits: Record<string, CircuitState> = {
    "test-pattern": { tripped_at: "2026-05-18T06:00:00Z" }, // 6h ago
  };
  // 1-hour window → circuit considered closed.
  const tight = computeStats("test-pattern", [], circuits, {
    gate: { ...DEFAULT_GATE, circuit_open_hours: 1 },
    now,
  });
  assert.equal(tight.circuit_open, false);
  // 24-hour default → circuit considered open.
  const loose = computeStats("test-pattern", [], circuits, {
    gate: DEFAULT_GATE,
    now,
  });
  assert.equal(loose.circuit_open, true);
});

// ---------------------------------------------------------------------------
// checkPromotionCriteria (configurable gate)
// ---------------------------------------------------------------------------

test("checkPromotionCriteria: empty list when fully eligible", () => {
  const stats = computeStats(
    "test-pattern",
    Array.from({ length: 5 }, () => entry({ status: "suggested" })),
    {},
    { gate: DEFAULT_GATE, now: new Date("2026-05-18T12:00:00Z") },
  );
  const unmet = checkPromotionCriteria(pattern(), stats, DEFAULT_GATE);
  assert.deepEqual(unmet, []);
});

test("checkPromotionCriteria: flags below-threshold suggests", () => {
  const stats = computeStats(
    "test-pattern",
    Array.from({ length: 2 }, () => entry({ status: "suggested" })),
    {},
    { gate: DEFAULT_GATE, now: new Date("2026-05-18T12:00:00Z") },
  );
  const unmet = checkPromotionCriteria(pattern(), stats, DEFAULT_GATE);
  assert.ok(unmet.some((r) => r.includes("5 successful suggests")));
});

test("checkPromotionCriteria: flags abort_last_7d > 0", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const entries = [
    ...Array.from({ length: 5 }, () => entry({ status: "suggested" })),
    entry({ status: "aborted", timestamp: "2026-05-17T12:00:00Z" }),
  ];
  const stats = computeStats("test-pattern", entries, {}, { gate: DEFAULT_GATE, now });
  const unmet = checkPromotionCriteria(pattern(), stats, DEFAULT_GATE);
  assert.ok(unmet.some((r) => r.includes("guard failure")));
});

test("checkPromotionCriteria: flags ever_tripped circuit", () => {
  const now = new Date("2026-05-18T12:00:00Z");
  const entries = Array.from({ length: 5 }, () => entry({ status: "suggested" }));
  const circuits = { "test-pattern": { ever_tripped: true } };
  const stats = computeStats("test-pattern", entries, circuits, {
    gate: DEFAULT_GATE,
    now,
  });
  const unmet = checkPromotionCriteria(pattern(), stats, DEFAULT_GATE);
  assert.ok(unmet.some((r) => r.includes("tripped")));
});

test("checkPromotionCriteria: flags requires_confirmation true", () => {
  const stats = computeStats(
    "test-pattern",
    Array.from({ length: 5 }, () => entry({ status: "suggested" })),
    {},
    { gate: DEFAULT_GATE, now: new Date("2026-05-18T12:00:00Z") },
  );
  const unmet = checkPromotionCriteria(
    pattern({ requires_confirmation: true }),
    stats,
    DEFAULT_GATE,
  );
  assert.ok(unmet.some((r) => r.includes("requires_confirmation")));
});

test("checkPromotionCriteria: honors a configurable min_successful_suggests", () => {
  const stats = computeStats(
    "test-pattern",
    Array.from({ length: 3 }, () => entry({ status: "suggested" })),
    {},
    { gate: { ...DEFAULT_GATE, min_successful_suggests: 3 }, now: new Date("2026-05-18T12:00:00Z") },
  );
  const unmet = checkPromotionCriteria(pattern(), stats, { ...DEFAULT_GATE, min_successful_suggests: 3 });
  assert.deepEqual(unmet, []);
});

// ---------------------------------------------------------------------------
// loadGate — pulls overrides from config.self_heal.* with defaults
// ---------------------------------------------------------------------------

test("loadGate: returns defaults when config has no self_heal section", () => {
  const c = ctx();
  fs.writeFileSync(c.configPath, JSON.stringify({ unrelated: {} }));
  assert.deepEqual(loadGate(c.configPath), DEFAULT_GATE);
});

test("loadGate: merges partial overrides over defaults", () => {
  const c = ctx();
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({
      self_heal: { min_successful_suggests: 10, circuit_open_hours: 6 },
    }),
  );
  const gate = loadGate(c.configPath);
  assert.equal(gate.min_successful_suggests, 10);
  assert.equal(gate.circuit_open_hours, 6);
  assert.equal(gate.abort_window_days, DEFAULT_GATE.abort_window_days);
});

// ---------------------------------------------------------------------------
// cmdStatus
// ---------------------------------------------------------------------------

test("cmdStatus: lists every pattern with mode/circuit/eligibility", () => {
  const c = ctx();
  fs.writeFileSync(
    c.patternsPath,
    JSON.stringify([pattern({ id: "p1" }), pattern({ id: "p2" })]),
  );
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  // p2 has 5 suggests → eligible.
  fs.writeFileSync(
    c.logPath,
    Array.from({ length: 5 }, () =>
      JSON.stringify(entry({ pattern_id: "p2" })),
    ).join("\n") + "\n",
  );
  const result = cmdStatus({
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.patterns.length, 2);
  const p1 = result.patterns.find((r) => r.id === "p1")!;
  const p2 = result.patterns.find((r) => r.id === "p2")!;
  assert.equal(p1.mode, "auto");
  assert.equal(p2.mode, "suggest");
  assert.equal(p2.eligible_for_promotion, true);
  assert.deepEqual(p2.promotion_blockers, []);
});

test("cmdStatus: auto-mode patterns never report eligibility/blockers (they're already promoted)", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  const result = cmdStatus({
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.patterns[0].mode, "auto");
  assert.equal(result.patterns[0].eligible_for_promotion, false);
  assert.deepEqual(result.patterns[0].promotion_blockers, []);
});

// ---------------------------------------------------------------------------
// cmdPromote
// ---------------------------------------------------------------------------

test("cmdPromote: appends pattern id to auto_patterns when gate is met", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  fs.writeFileSync(
    c.logPath,
    Array.from({ length: 5 }, () =>
      JSON.stringify(entry({ pattern_id: "p1" })),
    ).join("\n") + "\n",
  );
  const result = cmdPromote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.auto_patterns, ["p1"]);
  const cfg = JSON.parse(fs.readFileSync(c.configPath, "utf8"));
  assert.deepEqual(cfg.self_heal.auto_patterns, ["p1"]);
});

test("cmdPromote: fails fast with explicit reasons when gate not met", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  // Only 2 suggests — gate requires 5.
  fs.writeFileSync(
    c.logPath,
    [
      JSON.stringify(entry({ pattern_id: "p1" })),
      JSON.stringify(entry({ pattern_id: "p1" })),
    ].join("\n") + "\n",
  );
  const result = cmdPromote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons && result.reasons.length > 0);
  // Config not mutated.
  const cfg = JSON.parse(fs.readFileSync(c.configPath, "utf8"));
  assert.ok(!cfg.self_heal || !(cfg.self_heal as any).auto_patterns?.includes("p1"));
});

test("cmdPromote: idempotent — second promote returns already_present note", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  fs.writeFileSync(
    c.logPath,
    Array.from({ length: 5 }, () =>
      JSON.stringify(entry({ pattern_id: "p1" })),
    ).join("\n") + "\n",
  );
  const result = cmdPromote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  assert.equal(result.already_present, true);
});

test("cmdPromote: rejects unknown pattern id", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  const result = cmdPromote("nope", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons && result.reasons.some((r) => r.includes("not found")));
});

test("cmdPromote: emits a healer_canary insights event with action=promoted", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  fs.writeFileSync(
    c.logPath,
    Array.from({ length: 5 }, () =>
      JSON.stringify(entry({ pattern_id: "p1" })),
    ).join("\n") + "\n",
  );
  cmdPromote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  const events = queueEvents(c.env);
  const match = events.find(
    (e) => e.type === "healer_canary"
      && (e.payload as Record<string, unknown>).action === "promoted",
  );
  assert.ok(match, `expected promoted event in ${JSON.stringify(events)}`);
  const payload = match!.payload as Record<string, unknown>;
  assert.equal(payload.pattern_id, "p1");
});

// ---------------------------------------------------------------------------
// cmdDemote
// ---------------------------------------------------------------------------

test("cmdDemote: removes the id from auto_patterns and emits a demoted event", () => {
  const c = ctx();
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1", "p2"] } }),
  );
  const result = cmdDemote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.auto_patterns, ["p2"]);
  const cfg = JSON.parse(fs.readFileSync(c.configPath, "utf8"));
  assert.deepEqual(cfg.self_heal.auto_patterns, ["p2"]);
  const events = queueEvents(c.env);
  assert.ok(events.some((e) => (e.payload as Record<string, unknown>).action === "demoted"));
});

test("cmdDemote: idempotent — second demote returns not_present note", () => {
  const c = ctx();
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  const result = cmdDemote("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  assert.equal(result.not_present, true);
});

// ---------------------------------------------------------------------------
// cmdCheck — NEW. Exits non-zero (in CLI; here we just inspect the result)
// when any auto-mode pattern has its circuit open.
// ---------------------------------------------------------------------------

test("cmdCheck: ok=true when no auto patterns are tripped", () => {
  const c = ctx();
  fs.writeFileSync(
    c.patternsPath,
    JSON.stringify([pattern({ id: "p1" }), pattern({ id: "p2" })]),
  );
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  const result = cmdCheck({
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tripped_auto_patterns, []);
});

test("cmdCheck: ok=false + lists tripped pattern when an auto-pattern's circuit is open", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  fs.writeFileSync(
    c.circuitsPath,
    JSON.stringify({
      p1: { tripped_at: "2026-05-18T11:00:00Z", ever_tripped: true },
    }),
  );
  const result = cmdCheck({
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.tripped_auto_patterns, ["p1"]);
});

test("cmdCheck: ok=true when a SUGGEST-mode pattern is tripped (only auto-mode matters)", () => {
  // A suggest-mode pattern hitting its circuit is normal canary behavior
  // — that's exactly what suggest-mode is for. Don't page on it.
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  fs.writeFileSync(
    c.circuitsPath,
    JSON.stringify({
      p1: { tripped_at: "2026-05-18T11:00:00Z", ever_tripped: true },
    }),
  );
  const result = cmdCheck({
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tripped_auto_patterns, []);
});

// ---------------------------------------------------------------------------
// cmdCloseCircuit — NEW. Manual recovery of a tripped circuit.
// ---------------------------------------------------------------------------

test("cmdCloseCircuit: clears tripped_at + consecutive_failures, stamps last_reset_at", () => {
  const c = ctx();
  fs.writeFileSync(
    c.circuitsPath,
    JSON.stringify({
      p1: {
        tripped_at: "2026-05-18T11:00:00Z",
        ever_tripped: true,
        consecutive_failures: 3,
      },
    }),
  );
  const result = cmdCloseCircuit("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  const circuits = JSON.parse(fs.readFileSync(c.circuitsPath, "utf8"));
  assert.equal(circuits.p1.tripped_at, null);
  assert.equal(circuits.p1.consecutive_failures, 0);
  assert.equal(circuits.p1.last_reset_at, "2026-05-18T12:00:00Z");
  // ever_tripped is a historical fact — we deliberately don't reset it.
  assert.equal(circuits.p1.ever_tripped, true);
});

test("cmdCloseCircuit: no-op when circuit wasn't tripped (idempotent)", () => {
  const c = ctx();
  const result = cmdCloseCircuit("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  assert.equal(result.ok, true);
  assert.equal(result.no_op, true);
});

test("cmdCloseCircuit: emits a healer_canary event with action=circuit_closed", () => {
  const c = ctx();
  fs.writeFileSync(
    c.circuitsPath,
    JSON.stringify({ p1: { tripped_at: "2026-05-18T11:00:00Z" } }),
  );
  cmdCloseCircuit("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
    env: c.env,
  });
  const events = queueEvents(c.env);
  assert.ok(events.some((e) => (e.payload as Record<string, unknown>).action === "circuit_closed"));
});

// ---------------------------------------------------------------------------
// cmdExplain — NEW. Audit trail for a single pattern.
// ---------------------------------------------------------------------------

test("cmdExplain: returns full chronological log entries for the pattern + current state", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(
    c.configPath,
    JSON.stringify({ self_heal: { auto_patterns: ["p1"] } }),
  );
  fs.writeFileSync(
    c.logPath,
    [
      JSON.stringify(entry({ pattern_id: "p1", status: "suggested", timestamp: "2026-05-17T08:00:00Z" })),
      JSON.stringify(entry({ pattern_id: "other", status: "suggested" })), // unrelated — must NOT appear
      JSON.stringify(entry({ pattern_id: "p1", status: "applied", timestamp: "2026-05-17T09:00:00Z" })),
    ].join("\n") + "\n",
  );
  fs.writeFileSync(
    c.circuitsPath,
    JSON.stringify({ p1: { ever_tripped: true, consecutive_failures: 0 } }),
  );
  const result = cmdExplain("p1", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.found, true);
  assert.equal(result.pattern_id, "p1");
  assert.equal(result.mode, "auto");
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0].timestamp, "2026-05-17T08:00:00Z");
  assert.equal(result.entries[1].timestamp, "2026-05-17T09:00:00Z");
  assert.equal(result.circuit?.ever_tripped, true);
  assert.equal(typeof result.stats?.success_rate, "number");
});

test("cmdExplain: found=false when pattern id isn't in healer_patterns.json", () => {
  const c = ctx();
  fs.writeFileSync(c.patternsPath, JSON.stringify([pattern({ id: "p1" })]));
  fs.writeFileSync(c.configPath, JSON.stringify({}));
  const result = cmdExplain("missing", {
    patternsPath: c.patternsPath,
    configPath: c.configPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    now: new Date("2026-05-18T12:00:00Z"),
  });
  assert.equal(result.found, false);
});

// ---------------------------------------------------------------------------
// appendLogEntry (helper used by cmdPromote/cmdDemote/cmdCloseCircuit)
// ---------------------------------------------------------------------------

test("appendLogEntry: writes a JSONL line + creates the log file/parents", () => {
  const c = ctx();
  appendLogEntry(
    { timestamp: "2026-05-18T12:00:00Z", pattern_id: "p1", event: "canary_promoted" },
    c.logPath,
  );
  const text = fs.readFileSync(c.logPath, "utf8");
  const parsed = JSON.parse(text.trim());
  assert.equal(parsed.pattern_id, "p1");
  assert.equal(parsed.event, "canary_promoted");
});
