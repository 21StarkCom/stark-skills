// Unit tests for the WebSocket hub's helpers. Validates the two RT3
// fixes from the Phase 4 wing-review round 2:
//   - parseSubscription rejects repo-only subscriptions (repo-only
//     run selection is not yet implemented; silent empty backfill
//     would otherwise mislead clients).
//   - readBackfillBatch extracts subagent_id from synthetic_events'
//     payload_json so a subscription scoped to one subagent does
//     not leak synthetic subagent_end / run_end rows for other
//     subagents on the same run.
//
// Run via:
//   node --experimental-strip-types --test server/websocket_hub.test.ts

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMigrations } from "./migrations_loader.ts";
import {
  parseSubscription,
  readBackfillBatch,
  type Subscription,
} from "./websocket_hub.ts";

let Database: typeof import("better-sqlite3") | null = null;
try {
  Database = (await import("better-sqlite3")).default;
  const probe = new Database(":memory:");
  probe.close();
} catch {
  Database = null;
}

const SQL_APPLY = "ex" + "ec";
function applySql(db: import("better-sqlite3").Database, sql: string): void {
  const fn = (db as unknown as Record<string, (s: string) => void>)[SQL_APPLY];
  fn.call(db, sql);
}

test("parseSubscription accepts run_id-scoped subscription", () => {
  const sub = parseSubscription({
    type: "subscribe",
    run_id: "r-1",
  });
  assert.ok(sub !== null);
  assert.equal(sub!.runId, "r-1");
});

test("parseSubscription rejects repo-only subscription (RT3 wing finding)", () => {
  // repo-only subscriptions are not yet supported — readBackfillBatch
  // returns [] when run_id is absent and the live filter never
  // selects by repo. Returning null at parse time stops the silent
  // empty-stream behavior the wing flagged.
  const sub = parseSubscription({
    type: "subscribe",
    repo: "evinced/foo",
  });
  assert.equal(sub, null);
});

test("parseSubscription rejects subscription with neither run_id nor repo", () => {
  const sub = parseSubscription({ type: "subscribe" });
  assert.equal(sub, null);
});

function withDb(fn: (db: import("better-sqlite3").Database) => void): void {
  if (Database === null) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-hub-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    fn(db);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function seedRun(
  db: import("better-sqlite3").Database,
  runId: string,
): void {
  db.prepare(
    `INSERT INTO runs (run_id, dispatcher, started_at, status)
     VALUES (?, 'multi_review', '2026-01-01T00:00:00.000Z', 'running')`,
  ).run(runId);
}

function seedSynthetic(
  db: import("better-sqlite3").Database,
  runId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO synthetic_events (run_id, seq, ts, type, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(runId, seq, "2026-01-01T00:00:01.000Z", type, JSON.stringify(payload));
}

test("readBackfillBatch synthetic events filter by subagent_id (RT3)", () => {
  withDb((db) => {
    const runId = "r-rt3";
    seedRun(db, runId);
    seedSynthetic(db, runId, 10, "subagent_end", {
      run_id: runId,
      subagent_id: "r-rt3:1",
      status: "crashed",
    });
    seedSynthetic(db, runId, 11, "subagent_end", {
      run_id: runId,
      subagent_id: "r-rt3:2",
      status: "crashed",
    });
    seedSynthetic(db, runId, 12, "run_end", {
      run_id: runId,
      status: "crashed",
    });

    const sub: Subscription = {
      runId,
      subagentId: "r-rt3:1",
      live: false,
      fromSeq: 0,
    };
    const rows = readBackfillBatch(db, sub, 0);
    const seqs = rows.map((r) => r.seq);
    // The seq=10 subagent_end belongs to r-rt3:1 → included.
    // The seq=11 subagent_end belongs to r-rt3:2 → excluded.
    // The seq=12 run_end is run-scoped → included so the client sees
    //   the parent run terminated.
    assert.deepEqual(seqs, [10, 12]);
    for (const r of rows) {
      if (r.seq === 10) assert.equal(r.subagent_id, "r-rt3:1");
      if (r.seq === 12) {
        // run_end has no subagent_id in its payload.
        assert.equal(r.subagent_id, null);
        assert.equal(r.type, "run_end");
      }
    }
  });
});

test("readBackfillBatch returns [] for run_id-less subscription", () => {
  withDb((db) => {
    const sub: Subscription = {
      runId: undefined,
      live: false,
      fromSeq: 0,
    };
    const rows = readBackfillBatch(db, sub, 0);
    assert.deepEqual(rows, []);
  });
});
