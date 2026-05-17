// Phase 5a parity test: TS `tools/red_team_human_review_lib.ts` vs
// Python `scripts/red_team_human_review.py`.
//
// Both implementations write to the same SQLite table shape, so the
// strategy is: run the equivalent operation on each side against twin
// fixture DBs, then diff DB state (table rows + accept_key generation).
// Plus pure-function parity for computeAcceptKey.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { initRedTeamTables, recordRedTeamRun, recordFindings } from "./red_team_audit_lib.ts";
import { policyFromConfig } from "./red_team_audit_text_lib.ts";
import {
  acceptFinding,
  computeAcceptKey,
  filterHumanReviewFindings,
  initTable,
  isAccepted,
  listPendingHalts,
  lookupFindingMetadata,
  resolveAcceptedBy,
} from "./red_team_human_review_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PY_SCRIPTS = path.join(REPO_ROOT, "scripts");

function tmpDb(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rt-hr-parity-${label}-`));
  return path.join(dir, "audit.db");
}

function runPython(script: string, payloadJson: string = ""): string {
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
  return proc.stdout;
}

function dumpAccepts(dbPath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT accept_key, stable_key, run_id, stage, round_num, persona, " +
          "finding_id, concern_hash, concern_excerpt, accepted_by, note, version " +
          "FROM red_team_human_review_accepts ORDER BY accept_key",
      )
      .all() as Array<Record<string, unknown>>;
    return rows;
  } finally {
    db.close();
  }
}

// ── computeAcceptKey parity ──────────────────────────────────────────

test("computeAcceptKey produces the canonical {repo}:{stage}:{persona}:{concern_hash} shape", () => {
  const key = computeAcceptKey({
    stage: "design",
    persona: "security-trust",
    concernHash: "abc123",
    repo: "Evinced/foo",
  });
  assert.equal(key, "Evinced/foo:design:security-trust:abc123");
});

test("computeAcceptKey refuses null / empty / 'unknown' repo (FU-rt8 + PR-#430 fix #10)", () => {
  for (const repo of [null, undefined, "", "unknown"] as Array<string | null | undefined>) {
    assert.throws(
      () =>
        computeAcceptKey({
          stage: "design",
          persona: "security-trust",
          concernHash: "abc",
          repo,
        }),
      /resolved repository identifier/,
    );
  }
});

test("computeAcceptKey parity vs Python compute_accept_key over a value matrix", () => {
  const fixtures: Array<{ stage: string; persona: string; concernHash: string; repo: string }> = [
    { stage: "design", persona: "security-trust", concernHash: "abc123", repo: "Evinced/foo" },
    { stage: "plan", persona: "data", concernHash: "deadbeef", repo: "GetEvinced/stark-skills" },
    { stage: "design", persona: "cost-ops", concernHash: "0", repo: "org/repo-with-dashes" },
  ];
  for (const fx of fixtures) {
    const tsKey = computeAcceptKey({
      stage: fx.stage,
      persona: fx.persona,
      concernHash: fx.concernHash,
      repo: fx.repo,
    });
    const pyKey = runPython(
      `
import red_team_types as rt
payload = json.loads(sys.stdin.read())
sys.stdout.write(rt.compute_accept_key(stage=payload["stage"], persona=payload["persona"], concern_hash=payload["concern_hash"], repo=payload["repo"]))
`,
      JSON.stringify({
        stage: fx.stage,
        persona: fx.persona,
        concern_hash: fx.concernHash,
        repo: fx.repo,
      }),
    );
    assert.equal(tsKey, pyKey, `divergence for ${JSON.stringify(fx)}`);
  }
});

// ── resolveAcceptedBy parity ─────────────────────────────────────────

test("resolveAcceptedBy honors explicit value, then USER env, then 'manual' fallback", () => {
  assert.equal(resolveAcceptedBy("explicit", {}), "explicit");
  assert.equal(resolveAcceptedBy(null, { USER: "operator" }), "operator");
  assert.equal(resolveAcceptedBy(undefined, {}), "manual");
  // Empty string is falsy; falls through.
  assert.equal(resolveAcceptedBy("", { USER: "fallback" }), "fallback");
});

// ── acceptFinding parity (DB state diff) ─────────────────────────────

const ACCEPT_FIXTURE = {
  stableKey: "run-xyz:design:1:security-trust:rt1:deadbeef",
  runId: "run-xyz",
  stage: "design",
  roundNum: 1,
  persona: "security-trust",
  findingId: "rt1",
  concernHash: "deadbeef",
  concernExcerpt: "Concern excerpt with user@evinced.com",
  repo: "Evinced/foo",
  acceptedBy: "test-operator",
  note: "Acknowledged in standup",
};

test("acceptFinding writes a row that matches Python's INSERT verbatim", () => {
  const tsDb = tmpDb("accept-ts");
  const pyDb = tmpDb("accept-py");
  initTable(tsDb);
  acceptFinding({ ...ACCEPT_FIXTURE, dbPath: tsDb });
  runPython(
    `
import red_team_human_review as hr
payload = json.loads(sys.stdin.read())
hr.accept_finding(
    payload["stable_key"],
    run_id=payload["run_id"],
    stage=payload["stage"],
    round_num=payload["round_num"],
    persona=payload["persona"],
    finding_id=payload["finding_id"],
    concern_hash=payload["concern_hash"],
    concern_excerpt=payload["concern_excerpt"],
    repo=payload["repo"],
    accepted_by=payload["accepted_by"],
    note=payload["note"],
    db_path=${JSON.stringify(pyDb)},
)
`,
    JSON.stringify({
      stable_key: ACCEPT_FIXTURE.stableKey,
      run_id: ACCEPT_FIXTURE.runId,
      stage: ACCEPT_FIXTURE.stage,
      round_num: ACCEPT_FIXTURE.roundNum,
      persona: ACCEPT_FIXTURE.persona,
      finding_id: ACCEPT_FIXTURE.findingId,
      concern_hash: ACCEPT_FIXTURE.concernHash,
      concern_excerpt: ACCEPT_FIXTURE.concernExcerpt,
      repo: ACCEPT_FIXTURE.repo,
      accepted_by: ACCEPT_FIXTURE.acceptedBy,
      note: ACCEPT_FIXTURE.note,
    }),
  );
  // Compare DB state — accepted_at is SQLite-defaulted so each side
  // gets its own timestamp. Strip it before comparing.
  const tsRows = dumpAccepts(tsDb);
  const pyRows = dumpAccepts(pyDb);
  assert.deepEqual(tsRows, pyRows);
});

test("acceptFinding is idempotent (INSERT OR IGNORE) — second call is a no-op", () => {
  const dbPath = tmpDb("accept-idempotent");
  initTable(dbPath);
  acceptFinding({ ...ACCEPT_FIXTURE, dbPath });
  const after1 = dumpAccepts(dbPath);
  acceptFinding({ ...ACCEPT_FIXTURE, dbPath });
  const after2 = dumpAccepts(dbPath);
  assert.deepEqual(after1, after2, "second accept must not insert another row");
  assert.equal(after2.length, 1);
});

test("acceptFinding refuses 'unknown' repo via computeAcceptKey", () => {
  const dbPath = tmpDb("accept-refuses");
  initTable(dbPath);
  assert.throws(
    () => acceptFinding({ ...ACCEPT_FIXTURE, repo: "unknown", dbPath }),
    /resolved repository identifier/,
  );
});

// ── isAccepted parity ────────────────────────────────────────────────

test("isAccepted returns true after acceptFinding, by both key types", () => {
  const dbPath = tmpDb("is-accepted");
  initTable(dbPath);
  assert.equal(
    isAccepted({ stableKey: ACCEPT_FIXTURE.stableKey, dbPath }),
    false,
    "fresh DB should report unaccepted",
  );
  acceptFinding({ ...ACCEPT_FIXTURE, dbPath });
  assert.equal(isAccepted({ stableKey: ACCEPT_FIXTURE.stableKey, dbPath }), true);
  const acceptKey = computeAcceptKey({
    stage: ACCEPT_FIXTURE.stage,
    persona: ACCEPT_FIXTURE.persona,
    concernHash: ACCEPT_FIXTURE.concernHash,
    repo: ACCEPT_FIXTURE.repo,
  });
  assert.equal(isAccepted({ acceptKey, dbPath }), true);
});

test("isAccepted rejects callers that pass neither or both keys", () => {
  const dbPath = tmpDb("is-accepted-args");
  initTable(dbPath);
  assert.throws(() => isAccepted({ dbPath }), /exactly one/);
  assert.throws(
    () => isAccepted({ acceptKey: "x", stableKey: "y", dbPath }),
    /exactly one/,
  );
});

// ── filterHumanReviewFindings parity ─────────────────────────────────

test("filterHumanReviewFindings splits accepted vs unaccepted by accept_key", () => {
  const dbPath = tmpDb("filter");
  initTable(dbPath);
  acceptFinding({ ...ACCEPT_FIXTURE, dbPath });
  const findings = [
    {
      persona: "security-trust",
      concern_hash: "deadbeef",
      counter_proposal: "REQUEST_HUMAN_REVIEW",
    },
    {
      persona: "data",
      concern_hash: "freshhash",
      counter_proposal: "REQUEST_HUMAN_REVIEW",
    },
    {
      persona: "security-trust",
      concern_hash: "another",
      counter_proposal: "Concrete fix",
    },
  ];
  const { unaccepted, matchedKeys } = filterHumanReviewFindings({
    findings,
    stage: "design",
    repo: "Evinced/foo",
    dbPath,
  });
  assert.equal(unaccepted.length, 1);
  assert.equal(unaccepted[0]!.concern_hash, "freshhash");
  assert.deepEqual(matchedKeys, ["Evinced/foo:design:security-trust:deadbeef"]);
});

// ── listPendingHalts parity (end-to-end with seeded audit DB) ────────

test("listPendingHalts returns only unaccepted human-review findings, oldest-first by run", () => {
  const dbPath = tmpDb("list-pending");
  initRedTeamTables(dbPath);
  // Seed two runs, two findings each. One is human-review + unaccepted,
  // one is human-review + accepted, two are concrete (excluded).
  for (const runId of ["run-1", "run-2"]) {
    recordRedTeamRun(
      {
        run_id: runId,
        stage: "design",
        rounds_used: 1,
        final_status: "halted_human_review",
        total_findings: 2,
        critical_count: 0,
        high_count: 0,
        medium_count: 0,
        human_review_count: 2,
        duration_s: 1.0,
        cost_usd: 0,
        model: "gpt-5.5-pro",
        caller: "stark-red-team-ts",
        repo: "Evinced/foo",
        artifact_relative_path: "docs/d.md",
        pr_number: null,
        fix_plan_status: "skipped_disabled",
        fix_plan_md: null,
        fix_plan_json: null,
        fix_plan_cost_usd: null,
        created_at: runId === "run-1" ? "2026-05-16T10:00:00Z" : "2026-05-17T10:00:00Z",
      },
      dbPath,
    );
    recordFindings(
      [
        {
          run_id: runId,
          stage: "design",
          round_num: 1,
          finding_id: "rt1",
          persona: "security-trust",
          severity: "high",
          concern: `Unaccepted concern in ${runId}`,
          consequence: "C",
          counter_proposal: "REQUEST_HUMAN_REVIEW",
          trade_off: null,
          reason_for_uncertainty: "needs ops review",
          stable_key: `${runId}:design:1:security-trust:rt1:hash-${runId}`,
          concern_hash: `hash-${runId}`,
          risk_key: null,
          affected_component: null,
          failure_mode: null,
        },
      ],
      dbPath,
      policyFromConfig({ retain_full_text: true }),
    );
  }
  // Accept run-1's finding so only run-2 should be pending.
  acceptFinding({
    stableKey: "run-1:design:1:security-trust:rt1:hash-run-1",
    runId: "run-1",
    stage: "design",
    roundNum: 1,
    persona: "security-trust",
    findingId: "rt1",
    concernHash: "hash-run-1",
    concernExcerpt: null,
    repo: "Evinced/foo",
    dbPath,
  });
  const halts = listPendingHalts({ dbPath });
  assert.equal(halts.length, 1);
  assert.equal(halts[0]!.run_id, "run-2");
  assert.equal(halts[0]!.persona, "security-trust");
  assert.equal(halts[0]!.repo, "Evinced/foo");
});

// ── lookupFindingMetadata parity ─────────────────────────────────────

test("lookupFindingMetadata returns the row data the accept CLI displays", () => {
  const dbPath = tmpDb("lookup");
  initRedTeamTables(dbPath);
  recordRedTeamRun(
    {
      run_id: "lookup-run",
      stage: "design",
      rounds_used: 1,
      final_status: "halted_human_review",
      total_findings: 1,
      critical_count: 0,
      high_count: 0,
      medium_count: 0,
      human_review_count: 1,
      duration_s: 0.5,
      cost_usd: 0,
      model: "gpt-5.5-pro",
      caller: "stark-red-team-ts",
      repo: "Evinced/foo",
      artifact_relative_path: "docs/d.md",
      pr_number: 7,
      fix_plan_status: "skipped_disabled",
      fix_plan_md: null,
      fix_plan_json: null,
      fix_plan_cost_usd: null,
      created_at: "2026-05-17T10:00:00Z",
    },
    dbPath,
  );
  recordFindings(
    [
      {
        run_id: "lookup-run",
        stage: "design",
        round_num: 1,
        finding_id: "rt1",
        persona: "security-trust",
        severity: "high",
        concern: "Concern body text",
        consequence: "C",
        counter_proposal: "REQUEST_HUMAN_REVIEW",
        trade_off: null,
        reason_for_uncertainty: "needs ops review",
        stable_key: "lookup-run:design:1:security-trust:rt1:lookup-hash",
        concern_hash: "lookup-hash",
        risk_key: null,
        affected_component: null,
        failure_mode: null,
      },
    ],
    dbPath,
    policyFromConfig({ retain_full_text: true }),
  );
  const meta = lookupFindingMetadata({
    stableKey: "lookup-run:design:1:security-trust:rt1:lookup-hash",
    dbPath,
  });
  assert.ok(meta);
  assert.equal(meta!.run_id, "lookup-run");
  assert.equal(meta!.severity, "high");
  assert.equal(meta!.counter_proposal, "REQUEST_HUMAN_REVIEW");
  assert.equal(meta!.repo, "Evinced/foo");
  assert.equal(meta!.concern_excerpt, "Concern body text");
  // Missing key → null.
  const missing = lookupFindingMetadata({ stableKey: "no-such-key", dbPath });
  assert.equal(missing, null);
});

// ── Cross-language interop (key evidence that Phase 5a writers + readers
//    can mix safely until Phase 5b cutover deletes Python) ───────────────

test("interop: TS-accepted halt is honored by Python's listing", () => {
  const dbPath = tmpDb("interop-ts-to-py");
  initRedTeamTables(dbPath);
  // Seed via TS (writer parity already proven separately).
  recordRedTeamRun(
    {
      run_id: "interop", stage: "design", rounds_used: 1,
      final_status: "halted_human_review",
      total_findings: 1, critical_count: 0, high_count: 0,
      medium_count: 0, human_review_count: 1,
      duration_s: 0.1, cost_usd: 0,
      model: "gpt-5.5-pro", caller: "stark-red-team-ts",
      repo: "Evinced/foo", artifact_relative_path: "d.md", pr_number: 1,
      fix_plan_status: "skipped_disabled", fix_plan_md: null,
      fix_plan_json: null, fix_plan_cost_usd: null,
      created_at: "2026-05-17T11:00:00Z",
    },
    dbPath,
  );
  recordFindings(
    [
      {
        run_id: "interop", stage: "design", round_num: 1, finding_id: "rt1",
        persona: "data", severity: "high", concern: "c", consequence: "c",
        counter_proposal: "REQUEST_HUMAN_REVIEW",
        trade_off: null, reason_for_uncertainty: "x",
        stable_key: "interop:design:1:data:rt1:interop-hash",
        concern_hash: "interop-hash",
        risk_key: null, affected_component: null, failure_mode: null,
      },
    ],
    dbPath,
    policyFromConfig({ retain_full_text: true }),
  );
  // Confirm Python sees the row.
  const before = JSON.parse(
    runPython(
      `
import red_team_human_review as hr
halts = hr.list_pending_halts(db_path=${JSON.stringify(dbPath)})
sys.stdout.write(json.dumps([{"stable_key": h.stable_key} for h in halts]))
`,
    ),
  );
  assert.equal(before.length, 1);
  // Accept via TS.
  acceptFinding({
    stableKey: "interop:design:1:data:rt1:interop-hash",
    runId: "interop", stage: "design", roundNum: 1,
    persona: "data", findingId: "rt1",
    concernHash: "interop-hash", concernExcerpt: null,
    repo: "Evinced/foo", dbPath,
  });
  // Python's listing must now be empty — same accept_key, same SQL.
  const after = JSON.parse(
    runPython(
      `
import red_team_human_review as hr
halts = hr.list_pending_halts(db_path=${JSON.stringify(dbPath)})
sys.stdout.write(json.dumps([{"stable_key": h.stable_key} for h in halts]))
`,
    ),
  );
  assert.deepEqual(after, []);
});

test("interop: Python-accepted halt is honored by TS's listing", () => {
  const dbPath = tmpDb("interop-py-to-ts");
  initRedTeamTables(dbPath);
  recordRedTeamRun(
    {
      run_id: "interop2", stage: "design", rounds_used: 1,
      final_status: "halted_human_review",
      total_findings: 1, critical_count: 0, high_count: 0,
      medium_count: 0, human_review_count: 1,
      duration_s: 0.1, cost_usd: 0,
      model: "gpt-5.5-pro", caller: "py",
      repo: "Evinced/foo", artifact_relative_path: "d.md", pr_number: 2,
      fix_plan_status: "skipped_disabled", fix_plan_md: null,
      fix_plan_json: null, fix_plan_cost_usd: null,
      created_at: "2026-05-17T11:00:00Z",
    },
    dbPath,
  );
  recordFindings(
    [
      {
        run_id: "interop2", stage: "design", round_num: 1, finding_id: "rt2",
        persona: "data", severity: "high", concern: "c", consequence: "c",
        counter_proposal: "REQUEST_HUMAN_REVIEW",
        trade_off: null, reason_for_uncertainty: "x",
        stable_key: "interop2:design:1:data:rt2:interop2-hash",
        concern_hash: "interop2-hash",
        risk_key: null, affected_component: null, failure_mode: null,
      },
    ],
    dbPath,
    policyFromConfig({ retain_full_text: true }),
  );
  // Confirm TS sees the row.
  const before = listPendingHalts({ dbPath });
  assert.equal(before.length, 1);
  // Accept via Python.
  runPython(
    `
import red_team_human_review as hr
hr.accept_finding(
    "interop2:design:1:data:rt2:interop2-hash",
    run_id="interop2", stage="design", round_num=1,
    persona="data", finding_id="rt2",
    concern_hash="interop2-hash", concern_excerpt=None,
    repo="Evinced/foo", db_path=${JSON.stringify(dbPath)},
)
`,
  );
  // TS listing must now be empty.
  const after = listPendingHalts({ dbPath });
  assert.deepEqual(after, []);
});
