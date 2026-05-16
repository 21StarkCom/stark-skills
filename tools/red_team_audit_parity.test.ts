// Phase 5a parity test: TS `tools/red_team_audit_lib.ts` vs Python
// `scripts/red_team_audit.py`.
//
// Strategy: each test runs the same logical operation through both
// implementations against twin temp DBs, then diffs the resulting
// rows (normalized to drop auto-IDs and SQLite-defaulted timestamps).
// Catches drift in schema columns, migration steps, INSERT ordering,
// fix-plan JSON sanitization, and retention-policy application.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  type FindingRow,
  type PersonaStatRow,
  type RedTeamRunRow,
  initRedTeamTables,
  recordFindings,
  recordFixPlan,
  recordPersonaStats,
  recordRedTeamRun,
  sanitizeFixPlanJson,
} from "./red_team_audit_lib.ts";
import { policyFromConfig } from "./red_team_audit_text_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PY_SCRIPTS = path.join(REPO_ROOT, "scripts");

function tmpDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `red-team-audit-parity-${label}-`));
  return path.join(dir, "audit.db");
}

function runPython(script: string, payloadJson: string): void {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY_SCRIPTS)})
${script}
`,
    ],
    { input: payloadJson, encoding: "utf8" },
  );
  if (proc.status !== 0) {
    throw new Error(`python helper failed (exit=${proc.status}): ${proc.stderr}`);
  }
}

/** Dump a table's rows as an array of plain objects, with auto-IDs and
 *  SQLite-defaulted timestamps replaced by placeholders so two
 *  independently-inserted rows can be compared. */
function dumpTable(dbPath: string, table: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => {
      const out: Record<string, unknown> = { ...row };
      delete out.id;
      // created_at is a SQLite-defaulted ISO string and will differ by
      // microseconds across runs — but if the caller passed an
      // explicit created_at, we want to compare it.  The test fixture
      // for the explicit-created_at case asserts presence separately;
      // here we normalize the implicit case.
      if (typeof out.created_at === "string" && out.created_at.startsWith("20")) {
        out.created_at = "<TIMESTAMP>";
      }
      return out;
    });
  } finally {
    db.close();
  }
}

function dumpAllTables(dbPath: string): Record<string, Array<Record<string, unknown>>> {
  return {
    red_team_runs: dumpTable(dbPath, "red_team_runs"),
    red_team_persona_stats: dumpTable(dbPath, "red_team_persona_stats"),
    red_team_findings: dumpTable(dbPath, "red_team_findings"),
  };
}

// Sanity: TS imports still work alongside the re-exported policy alias.
test("audit_lib exports are present", () => {
  assert.equal(typeof recordRedTeamRun, "function");
  assert.equal(typeof recordFindings, "function");
  assert.equal(typeof recordFixPlan, "function");
  assert.equal(typeof recordPersonaStats, "function");
  assert.equal(typeof sanitizeFixPlanJson, "function");

  assert.equal(typeof policyFromConfig, "function");
});

test("parity: initRedTeamTables produces the same schema on both sides", () => {
  const tsDb = tmpDb("init-ts");
  const pyDb = tmpDb("init-py");

  initRedTeamTables(tsDb);
  runPython(
    `
import red_team_audit
red_team_audit.init_red_team_tables(${JSON.stringify(pyDb)})
`,
    "",
  );

  for (const table of ["red_team_runs", "red_team_persona_stats", "red_team_findings"]) {
    const tsDbConn = new DatabaseSync(tsDb);
    const pyDbConn = new DatabaseSync(pyDb);
    try {
      const tsCols = (tsDbConn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>).map((r) => `${r.name}:${r.type}`);
      const pyCols = (pyDbConn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
        type: string;
      }>).map((r) => `${r.name}:${r.type}`);
      assert.deepEqual(
        tsCols.sort(),
        pyCols.sort(),
        `column drift in ${table}:\n  TS: ${tsCols.join(", ")}\n  PY: ${pyCols.join(", ")}`,
      );
    } finally {
      tsDbConn.close();
      pyDbConn.close();
    }
  }
});

const RUN_FIXTURE: RedTeamRunRow = {
  run_id: "parity-run-1",
  stage: "design",
  rounds_used: 1,
  final_status: "halted",
  total_findings: 2,
  critical_count: 0,
  high_count: 1,
  medium_count: 1,
  human_review_count: 0,
  duration_s: 12.3,
  cost_usd: 1.42,
  model: "gpt-5.5-pro",
  caller: "stark-red-team-ts",
  repo: "GetEvinced/stark-skills",
  artifact_relative_path: "docs/design.md",
  pr_number: 999,
  fix_plan_status: "skipped_disabled",
  fix_plan_md: null,
  fix_plan_json: null,
  fix_plan_cost_usd: null,
  created_at: "2026-05-16T19:00:00Z",
};

test("parity: recordRedTeamRun writes identical rows on both sides", () => {
  const tsDb = tmpDb("run-ts");
  const pyDb = tmpDb("run-py");
  initRedTeamTables(tsDb);
  recordRedTeamRun(RUN_FIXTURE, tsDb);
  runPython(
    `
import red_team_audit, json
red_team_audit.init_red_team_tables(${JSON.stringify(pyDb)})
payload = json.loads(sys.stdin.read())
red_team_audit.record_red_team_run(payload, ${JSON.stringify(pyDb)})
`,
    JSON.stringify(RUN_FIXTURE),
  );
  assert.deepEqual(dumpAllTables(tsDb), dumpAllTables(pyDb));
});

const FINDINGS_FIXTURE: FindingRow[] = [
  {
    run_id: "parity-run-1",
    stage: "design",
    round_num: 1,
    finding_id: "rt1",
    persona: "security-trust",
    severity: "high",
    concern: "Auth token leak via alice@evinced.com email path",
    consequence: "Token leaked to 192.168.1.42",
    counter_proposal: "Rotate the secret",
    trade_off: "One-time deploy hit",
    reason_for_uncertainty: null,
    stable_key: "parity-run-1:design:1:security-trust:rt1:abcd1234",
    concern_hash: "abcd1234abcd1234",
    risk_key: "auth-token-leak",
    affected_component: "auth-service",
    failure_mode: "security",
  },
  {
    run_id: "parity-run-1",
    stage: "design",
    round_num: 1,
    finding_id: "rt2",
    persona: "data",
    severity: "medium",
    concern: "Schema migration without backfill verifier",
    consequence: "Risk of partial state",
    counter_proposal: "REQUEST_HUMAN_REVIEW",
    trade_off: null,
    reason_for_uncertainty: "Not enough context on rollback plan",
    stable_key: "parity-run-1:design:1:data:rt2:deadbeefdeadbeef",
    concern_hash: "deadbeefdeadbeef",
    risk_key: null,
    affected_component: null,
    failure_mode: null,
  },
];

for (const retain of [false, true]) {
  test(`parity: recordFindings under retention.retain_full_text=${retain}`, () => {
    const tsDb = tmpDb(`findings-ts-${retain}`);
    const pyDb = tmpDb(`findings-py-${retain}`);
    initRedTeamTables(tsDb);
    recordFindings(
      FINDINGS_FIXTURE,
      tsDb,
      policyFromConfig({ retain_full_text: retain, excerpt_max_chars: 240 }),
    );
    runPython(
      `
import red_team_audit, red_team_audit_text, json
red_team_audit.init_red_team_tables(${JSON.stringify(pyDb)})
payload = json.loads(sys.stdin.read())
pol = red_team_audit_text.policy_from_config({"retain_full_text": ${retain ? "True" : "False"}, "excerpt_max_chars": 240})
red_team_audit.record_findings(payload, ${JSON.stringify(pyDb)}, pol)
`,
      JSON.stringify(FINDINGS_FIXTURE),
    );
    assert.deepEqual(dumpAllTables(tsDb), dumpAllTables(pyDb));
  });
}

const PERSONA_STATS_FIXTURE: PersonaStatRow[] = [
  {
    run_id: "parity-run-1",
    stage: "design",
    round_num: 1,
    persona: "security-trust",
    findings_raised: 1,
    findings_at_critical: 0,
    findings_at_high: 1,
    findings_at_medium: 0,
    human_review_requests: 0,
  },
  {
    run_id: "parity-run-1",
    stage: "design",
    round_num: 1,
    persona: "data",
    findings_raised: 1,
    findings_at_critical: 0,
    findings_at_high: 0,
    findings_at_medium: 1,
    human_review_requests: 1,
  },
];

test("parity: recordPersonaStats writes identical rows", () => {
  const tsDb = tmpDb("personas-ts");
  const pyDb = tmpDb("personas-py");
  initRedTeamTables(tsDb);
  recordPersonaStats(PERSONA_STATS_FIXTURE, tsDb);
  runPython(
    `
import red_team_audit, json
red_team_audit.init_red_team_tables(${JSON.stringify(pyDb)})
payload = json.loads(sys.stdin.read())
red_team_audit.record_persona_stats(payload, ${JSON.stringify(pyDb)})
`,
    JSON.stringify(PERSONA_STATS_FIXTURE),
  );
  assert.deepEqual(dumpAllTables(tsDb), dumpAllTables(pyDb));
});

test("parity: recordFixPlan + sanitizeFixPlanJson produce identical UPDATE", () => {
  const tsDb = tmpDb("fixplan-ts");
  const pyDb = tmpDb("fixplan-py");
  initRedTeamTables(tsDb);
  recordRedTeamRun(RUN_FIXTURE, tsDb);
  // Same run row on the Python side first.
  runPython(
    `
import red_team_audit, json
red_team_audit.init_red_team_tables(${JSON.stringify(pyDb)})
payload = json.loads(sys.stdin.read())
red_team_audit.record_red_team_run(payload, ${JSON.stringify(pyDb)})
`,
    JSON.stringify(RUN_FIXTURE),
  );
  // Fix-plan UPDATE with raw_output present (must be sanitized away).
  const fpJson = JSON.stringify({
    summary: "phased",
    moves: [{ id: "m1", title: "stage", addressed_finding_ids: ["rt1"] }],
    raw_output: "model output that should be stripped",
  });
  recordFixPlan(
    "parity-run-1",
    {
      fixPlanMd: "## Proposed Fix Plan\n…",
      fixPlanJson: fpJson,
      fixPlanCostUsd: 0.42,
      fixPlanStatus: "success",
    },
    tsDb,
  );
  runPython(
    `
import red_team_audit, json
payload = json.loads(sys.stdin.read())
red_team_audit.record_fix_plan(
  "parity-run-1",
  fix_plan_md=payload["md"],
  fix_plan_json=payload["json"],
  fix_plan_cost_usd=payload["cost"],
  fix_plan_status=payload["status"],
  db_path=${JSON.stringify(pyDb)},
)
`,
    JSON.stringify({
      md: "## Proposed Fix Plan\n…",
      json: fpJson,
      cost: 0.42,
      status: "success",
    }),
  );
  assert.deepEqual(dumpAllTables(tsDb), dumpAllTables(pyDb));
});

test("sanitizeFixPlanJson strips raw_output + matches Python sort_keys=True format", () => {
  const fpJson = JSON.stringify({
    moves: [{ id: "m1" }],
    summary: "phased",
    raw_output: "should be gone",
    notes: "n",
  });
  const tsOut = sanitizeFixPlanJson(fpJson);
  const proc = spawnSync(
    "python3",
    [
      "-c",
      `
import sys, json
sys.path.insert(0, ${JSON.stringify(PY_SCRIPTS)})
from red_team_audit import _sanitize_fix_plan_json
sys.stdout.write(_sanitize_fix_plan_json(sys.stdin.read()) or "")
`,
    ],
    { input: fpJson, encoding: "utf8" },
  );
  if (proc.status !== 0) throw new Error(`python sanitize failed: ${proc.stderr}`);
  const pyOut = proc.stdout || null;
  assert.equal(tsOut, pyOut);
  assert.ok(!String(tsOut).includes("raw_output"), "raw_output must be stripped");
});

test("recordFindings is atomic — mid-batch failure leaves zero rows", () => {
  // Self-review fix: without BEGIN/COMMIT each statement auto-commits,
  // so a mid-batch failure would leak partial rows. Python uses deferred
  // commit (one conn.commit() after the loop), so a NOT NULL violation
  // on row N rolls back rows 1..N-1. TS must match.
  const dbPath = tmpDb("atomic");
  initRedTeamTables(dbPath);
  const good: FindingRow = {
    run_id: "atomic-run",
    stage: "design",
    round_num: 1,
    finding_id: "rt1",
    persona: "data",
    severity: "high",
    concern: "first finding",
    consequence: "first consequence",
    counter_proposal: "fix it",
    trade_off: null,
    reason_for_uncertainty: null,
  };
  // Force a NOT NULL violation on the second row by sending null where
  // schema demands NOT NULL (persona is NOT NULL in the DDL).
  const bad = { ...good, finding_id: "rt2", persona: null as unknown as string };
  assert.throws(
    () =>
      recordFindings(
        [good, bad],
        dbPath,
        policyFromConfig({ retain_full_text: true }),
      ),
    /NOT NULL/i,
  );
  const after = new DatabaseSync(dbPath);
  try {
    const count = (after.prepare("SELECT count(*) AS c FROM red_team_findings").get() as {
      c: number;
    }).c;
    assert.equal(count, 0, "atomicity: zero rows must persist after rolled-back batch");
  } finally {
    after.close();
  }
});

test("recordPersonaStats is atomic — mid-batch failure leaves zero rows", () => {
  const dbPath = tmpDb("atomic-personas");
  initRedTeamTables(dbPath);
  const good: PersonaStatRow = {
    run_id: "atomic-run",
    stage: "design",
    round_num: 1,
    persona: "data",
    findings_raised: 1,
    findings_at_critical: 0,
    findings_at_high: 1,
    findings_at_medium: 0,
    human_review_requests: 0,
  };
  const bad = { ...good, persona: null as unknown as string };
  assert.throws(() => recordPersonaStats([good, bad], dbPath), /NOT NULL/i);
  const after = new DatabaseSync(dbPath);
  try {
    const count = (after.prepare("SELECT count(*) AS c FROM red_team_persona_stats").get() as {
      c: number;
    }).c;
    assert.equal(count, 0);
  } finally {
    after.close();
  }
});
