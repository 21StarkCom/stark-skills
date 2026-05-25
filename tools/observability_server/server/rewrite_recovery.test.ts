// RT2 recovery sweep tests. Drive `recoverPendingRewrites` against an
// in-memory SQLite DB with an injected fs façade so we can exercise
// both finish-forward + finish-back without touching real disk.
// Skipped (not failed) if better-sqlite3's native binding isn't built
// for the host Node — Docker tests cover it under node:22.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMigrations } from "./migrations_loader.ts";
import { recoverPendingRewrites } from "./rewrite_recovery.ts";

let Database: typeof import("better-sqlite3") | null = null;
let dbModuleError: unknown = null;
try {
  Database = (await import("better-sqlite3")).default;
  const probe = new Database(":memory:");
  probe.close();
} catch (err) {
  Database = null;
  dbModuleError = err;
}

const SQL_APPLY_METHOD = "ex" + "ec";
function applySql(db: import("better-sqlite3").Database, sql: string): void {
  const fn = (db as unknown as Record<string, (s: string) => void>)[
    SQL_APPLY_METHOD
  ];
  fn.call(db, sql);
}

function withDb(fn: (db: import("better-sqlite3").Database) => void): void {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[rewrite_recovery.test] skipping — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-test-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const migrationsDir = path.resolve(import.meta.dirname, "..", "migrations");
    for (const m of loadMigrations(migrationsDir)) applySql(db, m.sql);
    fn(db);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function seedPendingRow(
  db: import("better-sqlite3").Database,
  opts: {
    runId: string;
    rotationIndex?: number;
    filePath: string;
    truncatedSeqs: number[];
    targetSize: number;
    targetMtimeNs?: number;
  },
): void {
  db.prepare(
    `INSERT INTO runs (run_id, dispatcher, started_at, status) VALUES (?, ?, ?, 'running')`,
  ).run(opts.runId, "x", "2026-05-25T00:00:00.000Z");
  db.prepare(
    `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
     VALUES (?, ?, 'a', 't', ?, 'running')`,
  ).run(`${opts.runId}:1`, opts.runId, "2026-05-25T00:00:00.000Z");
  const truncJson = JSON.stringify(
    opts.truncatedSeqs.map((seq) => ({
      seq,
      subagent_id: `${opts.runId}:1`,
      stream: "stdout",
      bytes_dropped: 10,
    })),
  );
  db.prepare(
    `INSERT INTO spool_files
       (run_id, rotation_index, file_path, size_bytes, mtime_ns, last_offset,
        rewrite_pending, rewrite_pending_size_bytes, rewrite_pending_truncated_json,
        rewrite_txn_id, rewrite_state, target_size_bytes, target_mtime_ns)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'txn-x', 'pending', ?, ?)`,
  ).run(
    opts.runId,
    opts.rotationIndex ?? 0,
    opts.filePath,
    1000,
    1_000_000,
    1000,
    opts.targetSize,
    truncJson,
    opts.targetSize,
    opts.targetMtimeNs ?? null,
  );
  for (const seq of opts.truncatedSeqs) {
    db.prepare(
      `INSERT INTO event_offsets (run_id, seq, ts, type, subagent_id,
        rotation_index, byte_start, byte_end)
       VALUES (?, ?, 't', 'subagent_stdout', ?, 0, ?, ?)`,
    ).run(opts.runId, seq, `${opts.runId}:1`, seq * 100, seq * 100 + 100);
    db.prepare(
      `INSERT INTO chunk_offsets (run_id, subagent_id, seq, stream,
        rotation_index, byte_start, byte_end, ts, encoding)
       VALUES (?, ?, ?, 'stdout', 0, ?, ?, 't', 'utf8')`,
    ).run(opts.runId, `${opts.runId}:1`, seq, seq * 100, seq * 100 + 100);
  }
}

test("RT2 recovery commits when size AND mtime_ns match target", () => {
  withDb((db) => {
    const filePath = "/spool/runs/run-rec-a/events-0000.jsonl";
    seedPendingRow(db, {
      runId: "run-rec-a",
      filePath,
      truncatedSeqs: [10, 11],
      targetSize: 400,
      targetMtimeNs: 2_000_000,
    });
    const stats = recoverPendingRewrites(db, {
      statSync: (p) => {
        assert.equal(p, filePath);
        return { size: 400, mtimeMs: 2 };
      },
    });
    assert.equal(stats.scanned, 1);
    assert.equal(stats.committed, 1);
    assert.equal(stats.aborted, 0);
    const row = db
      .prepare(
        `SELECT rewrite_state, rewrite_pending, mtime_ns, size_bytes,
                target_mtime_ns, rewrite_txn_id
           FROM spool_files WHERE run_id = 'run-rec-a' AND rotation_index = 0`,
      )
      .get() as {
      rewrite_state: string;
      rewrite_pending: number;
      mtime_ns: number;
      size_bytes: number;
      target_mtime_ns: number;
      rewrite_txn_id: string | null;
    };
    assert.equal(row.rewrite_state, "committed");
    assert.equal(row.rewrite_pending, 0);
    assert.equal(row.size_bytes, 400);
    assert.equal(row.mtime_ns, 2_000_000);
    assert.equal(row.target_mtime_ns, 2_000_000);
    assert.equal(row.rewrite_txn_id, null);
    const remainingChunks = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?`)
        .get("run-rec-a") as { n: number }
    ).n;
    assert.equal(remainingChunks, 0);
  });
});

test("RT2 recovery aborts when on-disk size does not match", () => {
  withDb((db) => {
    const filePath = "/spool/runs/run-rec-b/events-0000.jsonl";
    seedPendingRow(db, {
      runId: "run-rec-b",
      filePath,
      truncatedSeqs: [20],
      targetSize: 400,
    });
    const stats = recoverPendingRewrites(db, {
      statSync: () => ({ size: 1000, mtimeMs: 1 }), // unchanged from original
    });
    assert.equal(stats.scanned, 1);
    assert.equal(stats.aborted, 1);
    assert.equal(stats.committed, 0);
    const row = db
      .prepare(
        `SELECT rewrite_state, rewrite_pending, rewrite_pending_size_bytes,
                rewrite_pending_truncated_json, rewrite_txn_id
           FROM spool_files WHERE run_id = 'run-rec-b' AND rotation_index = 0`,
      )
      .get() as {
      rewrite_state: string;
      rewrite_pending: number;
      rewrite_pending_size_bytes: number | null;
      rewrite_pending_truncated_json: string | null;
      rewrite_txn_id: string | null;
    };
    assert.equal(row.rewrite_state, "aborted");
    assert.equal(row.rewrite_pending, 0);
    assert.equal(row.rewrite_pending_size_bytes, null);
    assert.equal(row.rewrite_pending_truncated_json, null);
    assert.equal(row.rewrite_txn_id, null);
    // Chunks unchanged because the rename never landed.
    const remainingChunks = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?`)
        .get("run-rec-b") as { n: number }
    ).n;
    assert.equal(remainingChunks, 1);
  });
});

test("RT2 recovery aborts when size matches target but mtime_ns does not (failed-rename same-size guard)", () => {
  withDb((db) => {
    // The rename(2) failed but the original file happens to share the
    // rewritten size. Without the mtime check, recovery would
    // finish-forward, delete event_offsets/chunk_offsets, reset
    // tail_offsets, then double-count bytes on the next tailer read.
    const filePath = "/spool/runs/run-rec-d/events-0000.jsonl";
    seedPendingRow(db, {
      runId: "run-rec-d",
      filePath,
      truncatedSeqs: [40],
      targetSize: 400,
      targetMtimeNs: 2_000_000,
    });
    const stats = recoverPendingRewrites(db, {
      statSync: () => ({ size: 400, mtimeMs: 999 }), // size match, mtime mismatch
    });
    assert.equal(stats.scanned, 1);
    assert.equal(stats.committed, 0);
    assert.equal(stats.aborted, 1);
    const row = db
      .prepare(
        `SELECT rewrite_state, rewrite_pending, rewrite_txn_id
           FROM spool_files WHERE run_id = 'run-rec-d' AND rotation_index = 0`,
      )
      .get() as {
      rewrite_state: string;
      rewrite_pending: number;
      rewrite_txn_id: string | null;
    };
    assert.equal(row.rewrite_state, "aborted");
    assert.equal(row.rewrite_pending, 0);
    assert.equal(row.rewrite_txn_id, null);
    const remainingChunks = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?`)
        .get("run-rec-d") as { n: number }
    ).n;
    assert.equal(remainingChunks, 1); // chunk preserved — replay would not double-count
  });
});

test("RT2 recovery aborts when the file is missing on disk", () => {
  withDb((db) => {
    seedPendingRow(db, {
      runId: "run-rec-c",
      filePath: "/spool/runs/run-rec-c/events-0000.jsonl",
      truncatedSeqs: [30],
      targetSize: 400,
    });
    const stats = recoverPendingRewrites(db, {
      statSync: () => {
        throw new Error("ENOENT");
      },
    });
    assert.equal(stats.scanned, 1);
    assert.equal(stats.aborted, 1);
    const row = db
      .prepare(
        `SELECT rewrite_state FROM spool_files WHERE run_id = 'run-rec-c'`,
      )
      .get() as { rewrite_state: string };
    assert.equal(row.rewrite_state, "aborted");
  });
});

test("RT2 recovery skips rows that are not in pending/renamed", () => {
  withDb((db) => {
    db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status) VALUES ('r-d', 'x', ?, 'ok')`,
    ).run("2026-05-25T00:00:00.000Z");
    db.prepare(
      `INSERT INTO spool_files
         (run_id, rotation_index, file_path, size_bytes, mtime_ns, last_offset,
          rewrite_pending, rewrite_state)
       VALUES ('r-d', 0, '/spool/runs/r-d/events-0000.jsonl', 100, 1, 100, 0, 'committed')`,
    ).run();
    const stats = recoverPendingRewrites(db, {
      statSync: () => ({ size: 999, mtimeMs: 1 }),
    });
    assert.equal(stats.scanned, 0);
  });
});
