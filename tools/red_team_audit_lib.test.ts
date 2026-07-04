// Test coverage for `tools/red_team_audit_lib.ts`'s fold-run + fix-plan
// disposition audit tables (workstream C, Task 9).
//
// Covers: `recordFoldRun` + `recordDispositions` round-trip against a real
// temp SQLite DB, and the idempotent-upsert contract on
// `(fold_run_id, move_id)` that `recordDispositions` must honor via
// `INSERT OR REPLACE`.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  connect,
  initRedTeamTables,
  recordDispositions,
  recordFoldRun,
} from "./red_team_audit_lib.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function mkTempDb(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "red-team-audit-lib-test-")),
    "audit.db",
  );
}

function readFoldRun(dbPath: string, foldRunId: string): Record<string, unknown> {
  const db = connect(dbPath);
  try {
    const row = db
      .prepare("SELECT * FROM red_team_fold_runs WHERE fold_run_id = ?")
      .get(foldRunId) as Record<string, unknown> | undefined;
    assert.ok(row, `no red_team_fold_runs row for fold_run_id=${foldRunId}`);
    return row!;
  } finally {
    db.close();
  }
}

function countFoldRuns(dbPath: string, foldRunId: string): number {
  const db = connect(dbPath);
  try {
    const r = db
      .prepare("SELECT count(*) AS c FROM red_team_fold_runs WHERE fold_run_id = ?")
      .get(foldRunId) as { c: number };
    return Number(r.c);
  } finally {
    db.close();
  }
}

function readDispositions(
  dbPath: string,
  foldRunId: string,
): Array<Record<string, unknown>> {
  const db = connect(dbPath);
  try {
    return db
      .prepare(
        "SELECT * FROM red_team_fix_plan_dispositions WHERE fold_run_id = ? ORDER BY id",
      )
      .all(foldRunId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

test("recordFoldRun + recordDispositions round-trip; disposition upserts", () => {
  const dbPath = mkTempDb();
  initRedTeamTables(dbPath);

  recordFoldRun(
    {
      fold_run_id: "f1",
      source_run_id: "r1",
      stage: "design",
      decider_model: "claude-opus-4-8",
      accepted_count: 1,
      modified_count: 1,
      rejected_count: 2,
      apply_failed_count: 0,
      cost_usd: 0.4,
      duration_s: 3,
      artifact_hash: "h",
      fix_plan_hash: "g",
    },
    dbPath,
  );

  // Round-trip the fold-run row itself: fields passed in come back intact,
  // and fields never passed (repo, pr_number, artifact_relative_path)
  // land as NULL rather than throwing or defaulting to something else.
  const foldRun = readFoldRun(dbPath, "f1");
  assert.equal(foldRun.source_run_id, "r1");
  assert.equal(foldRun.stage, "design");
  assert.equal(foldRun.decider_model, "claude-opus-4-8");
  assert.equal(foldRun.accepted_count, 1);
  assert.equal(foldRun.modified_count, 1);
  assert.equal(foldRun.rejected_count, 2);
  assert.equal(foldRun.apply_failed_count, 0);
  assert.equal(foldRun.cost_usd, 0.4);
  assert.equal(foldRun.duration_s, 3);
  assert.equal(foldRun.artifact_hash, "h");
  assert.equal(foldRun.fix_plan_hash, "g");
  assert.equal(foldRun.repo, null);
  assert.equal(foldRun.pr_number, null);
  assert.equal(foldRun.artifact_relative_path, null);

  recordDispositions(
    [
      {
        fold_run_id: "f1",
        source_run_id: "r1",
        move_id: "m1",
        addressed_finding_ids: "rt1",
        disposition: "accept",
        rationale: "ok",
        move_snapshot_json: "{}",
      },
    ],
    dbPath,
  );

  // Upsert: same (fold_run_id, move_id) key replaces the row, not duplicates.
  recordDispositions(
    [
      {
        fold_run_id: "f1",
        source_run_id: "r1",
        move_id: "m1",
        addressed_finding_ids: "rt1",
        disposition: "modify",
        rationale: "changed",
        move_snapshot_json: "{}",
      },
    ],
    dbPath,
  );

  const rows = readDispositions(dbPath, "f1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].disposition, "modify");
  assert.equal(rows[0].rationale, "changed");
});

test("recordDispositions writes one row per distinct move_id in a batch", () => {
  const dbPath = mkTempDb();
  initRedTeamTables(dbPath);

  recordFoldRun(
    {
      fold_run_id: "f2",
      source_run_id: "r2",
      stage: "plan",
      decider_model: "claude-opus-4-8",
      accepted_count: 0,
      modified_count: 0,
      rejected_count: 0,
      apply_failed_count: 0,
      cost_usd: 0,
      duration_s: 0,
    },
    dbPath,
  );

  recordDispositions(
    [
      {
        fold_run_id: "f2",
        source_run_id: "r2",
        move_id: "m1",
        addressed_finding_ids: "rt1",
        disposition: "accept",
      },
      {
        fold_run_id: "f2",
        source_run_id: "r2",
        move_id: "m2",
        addressed_finding_ids: "rt2,rt3",
        disposition: "reject",
        rationale: "out of scope",
      },
    ],
    dbPath,
  );

  const rows = readDispositions(dbPath, "f2");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.move_id),
    ["m1", "m2"],
  );
  assert.equal(rows[1].rationale, "out of scope");
});

test("recordDispositions is a no-op for an empty batch", () => {
  const dbPath = mkTempDb();
  initRedTeamTables(dbPath);
  recordDispositions([], dbPath);
  const rows = readDispositions(dbPath, "nonexistent");
  assert.equal(rows.length, 0);
});

test("recordFoldRun is idempotent — same fold_run_id upserts to the updated counts", () => {
  const dbPath = mkTempDb();
  initRedTeamTables(dbPath);

  const base = {
    fold_run_id: "f-dup",
    source_run_id: "r1",
    stage: "design",
    decider_model: "claude-opus-4-8",
    accepted_count: 1,
    modified_count: 0,
    rejected_count: 0,
    apply_failed_count: 0,
    cost_usd: 0.1,
    duration_s: 1,
  };
  recordFoldRun(base, dbPath);

  // A legitimate identical rerun: fold_run_id is deterministic
  // (`fold-<sourceRunId>-<hash8>`), so re-folding a byte-identical artifact
  // reuses the same key. This must upsert (rt2 "next run reconciles"), not
  // throw a SQLite UNIQUE violation.
  recordFoldRun(
    { ...base, accepted_count: 0, rejected_count: 3, cost_usd: 0.2, duration_s: 2 },
    dbPath,
  );

  // Exactly ONE row, carrying the UPDATED counts.
  assert.equal(countFoldRuns(dbPath, "f-dup"), 1);
  const row = readFoldRun(dbPath, "f-dup");
  assert.equal(row.accepted_count, 0);
  assert.equal(row.rejected_count, 3);
  assert.equal(row.cost_usd, 0.2);
  assert.equal(row.duration_s, 2);
});

test("initRedTeamTables is idempotent across the new fold-run tables", () => {
  const dbPath = mkTempDb();
  initRedTeamTables(dbPath);
  initRedTeamTables(dbPath); // must not throw ("table already exists")
  recordFoldRun(
    {
      fold_run_id: "f3",
      source_run_id: "r3",
      stage: "design",
      decider_model: "claude-opus-4-8",
      accepted_count: 0,
      modified_count: 0,
      rejected_count: 0,
      apply_failed_count: 0,
      cost_usd: 0,
      duration_s: 0,
    },
    dbPath,
  );
  const foldRun = readFoldRun(dbPath, "f3");
  assert.equal(foldRun.fold_run_id, "f3");
});
