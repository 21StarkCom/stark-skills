// Tests for `tools/self_healer_lib.ts` — port of `scripts/self_healer.py`
// (which had ZERO tests for a module that auto-applies fixes to files).
// Coverage focuses on the gate ladder: guard → session cap → auto-mode
// gate → circuit breaker → suggest/auto branch → execute → outcome
// recorded → circuit updated → alerts emitted on critical transitions.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type CircuitState,
  type HealerPattern,
  isCircuitTripped,
  loadCircuits,
  readSession,
  recordCircuitFailure,
  recordCircuitSuccess,
  runHeal,
  sessionCount,
  sessionIncrement,
  writeCircuits,
  writeSession,
} from "./self_healer_lib.ts";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "self-healer-test-"));
}

interface TestCtx {
  dir: string;
  patternsPath: string;
  circuitsPath: string;
  sessionPath: string;
  logPath: string;
  /** alert_delivery_lib base dir — sibling of the healer state files. */
  alertsBaseDir: string;
  env: NodeJS.ProcessEnv;
}

function ctx(): TestCtx {
  const dir = tmp();
  const alertsBaseDir = path.join(dir, "alerts");
  return {
    dir,
    patternsPath: path.join(dir, "healer_patterns.json"),
    circuitsPath: path.join(dir, "healer-circuits.json"),
    sessionPath: path.join(dir, "healer-session.json"),
    logPath: path.join(dir, "healer.jsonl"),
    alertsBaseDir,
    env: {
      ...process.env,
      CLAUDE_SESSION_ID: "self-healer-test",
    },
  };
}

function pattern(overrides: Partial<HealerPattern> = {}): HealerPattern {
  return {
    id: "test-pattern",
    action: "release_stale_lock",
    requires_confirmation: false,
    ...overrides,
  };
}

function writePatterns(c: TestCtx, patterns: HealerPattern[]): void {
  fs.writeFileSync(c.patternsPath, JSON.stringify(patterns));
}

function logLines(c: TestCtx): Array<Record<string, unknown>> {
  if (!fs.existsSync(c.logPath)) return [];
  return fs
    .readFileSync(c.logPath, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function alertMarkers(c: TestCtx): string[] {
  if (!fs.existsSync(c.alertsBaseDir)) return [];
  return fs
    .readdirSync(c.alertsBaseDir)
    .filter((n) => n.startsWith("alert-") && n.endsWith(".marker"))
    .sort();
}

// ---------------------------------------------------------------------------
// Session-counter helpers
// ---------------------------------------------------------------------------

test("readSession: returns {} when file missing", () => {
  assert.deepEqual(readSession(path.join(tmp(), "missing.json")), {});
});

test("writeSession + readSession: roundtrip", () => {
  const c = ctx();
  writeSession({ p1: 3 }, c.sessionPath);
  assert.deepEqual(readSession(c.sessionPath), { p1: 3 });
});

test("sessionCount: returns 0 for unseen pattern", () => {
  const c = ctx();
  assert.equal(sessionCount("nope", c.sessionPath), 0);
});

test("sessionIncrement: increments and persists", () => {
  const c = ctx();
  sessionIncrement("p1", c.sessionPath);
  sessionIncrement("p1", c.sessionPath);
  sessionIncrement("p2", c.sessionPath);
  assert.equal(sessionCount("p1", c.sessionPath), 2);
  assert.equal(sessionCount("p2", c.sessionPath), 1);
});

test("writeSession: leaves no .tmp behind (atomic)", () => {
  const c = ctx();
  writeSession({ p1: 1 }, c.sessionPath);
  const dir = path.dirname(c.sessionPath);
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

// ---------------------------------------------------------------------------
// Circuit-breaker helpers
// ---------------------------------------------------------------------------

test("loadCircuits: returns {} when file missing", () => {
  assert.deepEqual(loadCircuits(path.join(tmp(), "missing.json")), {});
});

test("writeCircuits: roundtrips state with last_reset_at preserved", () => {
  const c = ctx();
  const state: Record<string, CircuitState> = {
    p1: {
      consecutive_failures: 2,
      tripped_at: "2026-05-18T10:00:00Z",
      ever_tripped: true,
      last_reset_at: "2026-05-17T08:00:00Z",
    },
  };
  writeCircuits(state, c.circuitsPath);
  assert.deepEqual(loadCircuits(c.circuitsPath), state);
});

test("writeCircuits: leaves no .tmp behind (atomic)", () => {
  const c = ctx();
  writeCircuits({ p1: {} }, c.circuitsPath);
  const dir = path.dirname(c.circuitsPath);
  const leftovers = fs.readdirSync(dir).filter((n) => n.includes(".tmp"));
  assert.deepEqual(leftovers, []);
});

test("isCircuitTripped: true when tripped within 24h", () => {
  const c = ctx();
  const now = new Date("2026-05-18T12:00:00Z");
  writeCircuits(
    { p1: { tripped_at: "2026-05-18T11:00:00Z" } },
    c.circuitsPath,
  );
  assert.equal(isCircuitTripped("p1", 3, { now, circuitsPath: c.circuitsPath }), true);
});

test("isCircuitTripped: false when trip was > 24h ago", () => {
  const c = ctx();
  const now = new Date("2026-05-18T12:00:00Z");
  writeCircuits(
    { p1: { tripped_at: "2026-05-15T11:00:00Z" } },
    c.circuitsPath,
  );
  assert.equal(isCircuitTripped("p1", 3, { now, circuitsPath: c.circuitsPath }), false);
});

test("isCircuitTripped: true when consecutive_failures >= threshold, even without tripped_at", () => {
  const c = ctx();
  writeCircuits({ p1: { consecutive_failures: 3 } }, c.circuitsPath);
  assert.equal(
    isCircuitTripped("p1", 3, { now: new Date(), circuitsPath: c.circuitsPath }),
    true,
  );
});

test("isCircuitTripped: false for unseen pattern", () => {
  const c = ctx();
  assert.equal(
    isCircuitTripped("unseen", 3, { now: new Date(), circuitsPath: c.circuitsPath }),
    false,
  );
});

test("recordCircuitFailure: increments and sets tripped_at on threshold", () => {
  const c = ctx();
  const now = new Date("2026-05-18T12:00:00Z");
  // 1st: increment, not tripped
  assert.equal(
    recordCircuitFailure("p1", 3, { now, circuitsPath: c.circuitsPath }),
    false,
  );
  assert.equal(loadCircuits(c.circuitsPath).p1.consecutive_failures, 1);
  // 2nd: still not
  recordCircuitFailure("p1", 3, { now, circuitsPath: c.circuitsPath });
  // 3rd: trips
  assert.equal(
    recordCircuitFailure("p1", 3, { now, circuitsPath: c.circuitsPath }),
    true,
  );
  const state = loadCircuits(c.circuitsPath).p1;
  assert.equal(state.consecutive_failures, 3);
  assert.equal(state.tripped_at, "2026-05-18T12:00:00Z");
  assert.equal(state.ever_tripped, true);
});

test("recordCircuitFailure: does NOT re-trip an already-tripped circuit", () => {
  const c = ctx();
  const now = new Date("2026-05-18T12:00:00Z");
  writeCircuits(
    {
      p1: {
        consecutive_failures: 3,
        tripped_at: "2026-05-18T10:00:00Z",
        ever_tripped: true,
      },
    },
    c.circuitsPath,
  );
  // Already tripped — newly_tripped must be false even though we cross threshold again.
  assert.equal(
    recordCircuitFailure("p1", 3, { now, circuitsPath: c.circuitsPath }),
    false,
  );
});

test("recordCircuitSuccess: clears tripped_at + failures, stamps last_reset_at", () => {
  const c = ctx();
  const now = new Date("2026-05-18T12:00:00Z");
  writeCircuits(
    {
      p1: {
        consecutive_failures: 3,
        tripped_at: "2026-05-18T10:00:00Z",
        ever_tripped: true,
      },
    },
    c.circuitsPath,
  );
  recordCircuitSuccess("p1", { now, circuitsPath: c.circuitsPath });
  const state = loadCircuits(c.circuitsPath).p1;
  assert.equal(state.consecutive_failures, 0);
  assert.equal(state.tripped_at, null);
  assert.equal(state.last_reset_at, "2026-05-18T12:00:00Z");
  // ever_tripped is historical — preserved.
  assert.equal(state.ever_tripped, true);
});

// ---------------------------------------------------------------------------
// runHeal — full flow tests, one per gate
// ---------------------------------------------------------------------------

function baseOpts(c: TestCtx) {
  return {
    patternsPath: c.patternsPath,
    sessionPath: c.sessionPath,
    circuitsPath: c.circuitsPath,
    logPath: c.logPath,
    alertsBaseDir: c.alertsBaseDir,
    env: c.env,
    now: new Date("2026-05-18T12:00:00Z"),
  };
}

test("runHeal: missing pattern id returns error result with code 1", () => {
  const c = ctx();
  writePatterns(c, [pattern({ id: "p1" })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "some error");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "nope",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "suggest",
  });
  assert.equal(r.exit, 1);
  assert.ok(r.result.error);
});

test("runHeal: missing stderr-file returns error result with code 1", () => {
  const c = ctx();
  writePatterns(c, [pattern()]);
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: "/does/not/exist",
    mode: "suggest",
  });
  assert.equal(r.exit, 1);
  assert.ok(r.result.error);
});

test("runHeal: guard command failure → aborted with reason=guard_failed", () => {
  const c = ctx();
  writePatterns(c, [pattern({ guard: "false" })]); // always exit 1
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "aborted");
  assert.equal(r.result.reason, "guard_failed");
  // Logged with status=aborted.
  const aborted = logLines(c).filter((e) => e.status === "aborted");
  assert.equal(aborted.length, 1);
});

test("runHeal: max_per_session reached → aborted with reason=max_per_session_reached", () => {
  const c = ctx();
  writePatterns(c, [pattern({ max_per_session: 2 })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  writeSession({ "test-pattern": 2 }, c.sessionPath);
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "aborted");
  assert.equal(r.result.reason, "max_per_session_reached");
});

test("runHeal: --mode auto downgrades to suggest when pattern not in auto_patterns", () => {
  const c = ctx();
  writePatterns(c, [pattern()]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: [], // pattern NOT promoted
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "suggested");
  // Log entry confirms the downgrade.
  const logged = logLines(c).find((e) => e.status === "suggested");
  assert.equal(logged?.mode, "suggest");
});

test("runHeal: --mode auto + tripped circuit → skipped with reason=circuit_open + emits warning alert", () => {
  const c = ctx();
  writePatterns(c, [pattern()]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  writeCircuits(
    { "test-pattern": { tripped_at: "2026-05-18T11:00:00Z" } },
    c.circuitsPath,
  );
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "skipped");
  assert.equal(r.result.reason, "circuit_open");
  // A warning-level alert was emitted — JSONL entry exists in alerts/
  const alertsLog = path.join(c.alertsBaseDir, "alerts.jsonl");
  assert.ok(fs.existsSync(alertsLog));
  const lastAlert = JSON.parse(fs.readFileSync(alertsLog, "utf8").trim().split("\n").pop()!);
  assert.equal(lastAlert.level, "warning");
  assert.equal(lastAlert.source, "self_healer");
  // Warning level should NOT create a marker file.
  assert.equal(alertMarkers(c).length, 0);
});

test("runHeal: --mode suggest → emits a 'suggested' result + log", () => {
  const c = ctx();
  writePatterns(c, [pattern()]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "suggest",
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "suggested");
});

test("runHeal: --mode auto + requires_confirmation → skipped (won't auto-apply)", () => {
  const c = ctx();
  writePatterns(c, [pattern({ requires_confirmation: true })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "skipped");
});

test("runHeal: --mode auto + applied → success path records circuit success", () => {
  const c = ctx();
  // The default 'release_stale_lock' action always returns success in
  // the Python; verify the TS preserves that quirk.
  writePatterns(c, [pattern({ action: "release_stale_lock", verify_command: "true" })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  // Plant some prior failures so we can verify they get cleared.
  writeCircuits(
    { "test-pattern": { consecutive_failures: 2 } },
    c.circuitsPath,
  );
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "applied");
  assert.equal(r.result.verify_passed, true);
  // Circuit reset.
  const state = loadCircuits(c.circuitsPath)["test-pattern"];
  assert.equal(state.consecutive_failures, 0);
  assert.equal(state.tripped_at, null);
});

test("runHeal: --mode auto + verify fails → records circuit failure, no trip yet", () => {
  const c = ctx();
  writePatterns(c, [pattern({ action: "release_stale_lock", verify_command: "false" })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  const r = runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
    threshold: 3,
  });
  assert.equal(r.exit, 0);
  assert.equal(r.result.status, "applied");
  assert.equal(r.result.verify_passed, false);
  const state = loadCircuits(c.circuitsPath)["test-pattern"];
  assert.equal(state.consecutive_failures, 1);
});

test("runHeal: third consecutive verify-fail trips the circuit AND emits a CRITICAL alert (marker)", () => {
  const c = ctx();
  writePatterns(c, [pattern({ action: "release_stale_lock", verify_command: "false" })]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  for (let i = 0; i < 3; i++) {
    runHeal({
      ...baseOpts(c),
      patternId: "test-pattern",
      stderrFile: path.join(c.dir, "stderr.log"),
      mode: "auto",
      autoPatterns: ["test-pattern"],
      threshold: 3,
    });
  }
  // After the 3rd failure the circuit trips; alert delivery dropped a marker.
  assert.equal(alertMarkers(c).length, 1);
  // And the alerts.jsonl log carries the critical-level entry.
  const alertsLog = path.join(c.alertsBaseDir, "alerts.jsonl");
  const lines = fs.readFileSync(alertsLog, "utf8").trim().split("\n");
  const lastAlert = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastAlert.level, "critical");
});

test("runHeal: max_per_session counter only increments on successful executions", () => {
  // Python parity: failed executions do NOT bump the session counter.
  // Means a broken pattern can keep being attempted (circuit breaker is
  // what catches that), but successful runs are budgeted.
  const c = ctx();
  writePatterns(c, [
    pattern({ action: "release_stale_lock", verify_command: "false", max_per_session: 2 }),
  ]);
  fs.writeFileSync(path.join(c.dir, "stderr.log"), "err");
  runHeal({
    ...baseOpts(c),
    patternId: "test-pattern",
    stderrFile: path.join(c.dir, "stderr.log"),
    mode: "auto",
    autoPatterns: ["test-pattern"],
    threshold: 99, // prevent circuit trip from interfering
  });
  // Verify failed → counter should still be 0.
  // (Action 'release_stale_lock' itself "succeeds" in the Python; verify
  //  decides whether the OUTCOME counts. Reading the Python again:
  //  session bump only when `execution.success` — not `verify_passed`.
  //  release_stale_lock action returns success=true regardless, so the
  //  counter DOES bump. Match Python exactly.)
  assert.equal(sessionCount("test-pattern", c.sessionPath), 1);
});
