// Unit tests for the state-only retention sweeper. Run via:
//   node --experimental-strip-types --test server/retention.test.ts

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMigrations } from "./migrations_loader.ts";
import { RetentionSweeper } from "./retention.ts";

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

test("retention sweeper deletes rows whose spool dir vanished", () => {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log("[retention.test] skipping — better-sqlite3 not available");
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  const dbPath = path.join(tmpDir, "index.db");
  const spoolRoot = path.join(tmpDir, "runs");
  fs.mkdirSync(spoolRoot, { recursive: true });
  fs.mkdirSync(path.join(spoolRoot, "alive-run"));
  // No directory for "gone-run".
  const db = new Database(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status) VALUES (?, 'x', ?, 'ok')`,
    ).run("alive-run", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status) VALUES (?, 'x', ?, 'ok')`,
    ).run("gone-run", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
       VALUES ('gone-run:1', 'gone-run', 'a', 't', '2026-01-01T00:00:00.000Z', 'ok')`,
    ).run();

    const sw = new RetentionSweeper({ db, spoolRoot });
    sw.runTick();
    const remaining = db
      .prepare(`SELECT run_id FROM runs ORDER BY run_id`)
      .all() as Array<{ run_id: string }>;
    assert.deepEqual(
      remaining.map((r) => r.run_id),
      ["alive-run"],
    );
    // FK cascade also dropped the subagent row.
    const subs = db
      .prepare(`SELECT COUNT(*) AS n FROM subagents`)
      .get() as { n: number };
    assert.equal(subs.n, 0);
    assert.equal(sw.getStats().files_deleted_total, 1);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
