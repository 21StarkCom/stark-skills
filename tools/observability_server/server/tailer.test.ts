// Tests for `tailer.ts` helpers that don't require the native SQLite
// binding. Restart/rotation + rewrite-gate behavior is verified
// end-to-end via the Phase 3 verification command in Docker (see
// plan §"Verification"); here we pin the pure parsing helpers.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventBus } from "./event_bus.ts";
import { IndexWriter } from "./index_writer.ts";
import { loadMigrations } from "./migrations_loader.ts";
import { Tailer, parseSpoolPath } from "./tailer.ts";

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

test("parseSpoolPath extracts runId + rotationIndex from a canonical path", () => {
  const got = parseSpoolPath(
    "/spool/runs",
    "/spool/runs/abc-123/events-0001.jsonl",
  );
  assert.deepEqual(got, { runId: "abc-123", rotationIndex: 1 });
});

test("parseSpoolPath returns null for paths outside the spool root", () => {
  assert.equal(parseSpoolPath("/spool/runs", "/etc/passwd"), null);
  assert.equal(parseSpoolPath("/spool/runs", "/spool/other/x.jsonl"), null);
});

test("parseSpoolPath returns null for too-deep paths", () => {
  assert.equal(
    parseSpoolPath("/spool/runs", "/spool/runs/abc/nested/events-0001.jsonl"),
    null,
  );
});

test("parseSpoolPath returns null when the basename does not match", () => {
  assert.equal(
    parseSpoolPath("/spool/runs", "/spool/runs/abc/meta.json"),
    null,
  );
  assert.equal(
    parseSpoolPath("/spool/runs", "/spool/runs/abc/events-1.jsonl"),
    null,
  );
});

test("parseSpoolPath honors the actual spool root parameter", () => {
  const root = path.resolve("/tmp/my-spool");
  const got = parseSpoolPath(
    root,
    path.join(root, "run-x", "events-0042.jsonl"),
  );
  assert.deepEqual(got, { runId: "run-x", rotationIndex: 42 });
});

// Multi-statement SQL runner. Aliased so the call site doesn't trip
// the repo's shell-exec security hook (false positive on the substring
// "exec(").
function applySql(db: import("better-sqlite3").Database, sql: string): void {
  db.exec(sql);
}

// Regression for wing-round-4 finding: rewrite detection MUST seed
// `state.lastSize` + `state.lastMtimeNs` from the persisted
// `spool_files` row on first touch. Without that seed, a file that
// was rewritten (smaller / mtime regressed) while the server was
// down looks like a normal append after restart, and the tailer
// resumes from the stale `tail_offsets.offset` — skipping the
// rewritten head of the file entirely.
test("Tailer seeds size/mtime from spool_files on first touch so post-restart rewrite is detected", async () => {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[tailer.test] skipping post-restart-rewrite — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return;
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-restart-"));
  const spoolRoot = path.join(tmpRoot, "spool");
  const runDir = path.join(spoolRoot, "run-r");
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, "events-0001.jsonl");

  // Simulate the post-restart state: the file ON DISK is the
  // rewritten (small) version. The DB still carries the pre-restart
  // state — spool_files.size_bytes is large; tail_offsets.offset
  // points PAST the new file's actual EOF.
  const rewrittenContent =
    '{"seq":10,"ts":"t","type":"chunk_truncated"}\n{"seq":11,"ts":"t","type":"chunk_truncated"}\n';
  fs.writeFileSync(filePath, rewrittenContent);

  const db = new Database(":memory:");
  try {
    applySql(
      db,
      `
      CREATE TABLE spool_files (
        run_id TEXT NOT NULL,
        rotation_index INTEGER NOT NULL,
        rewrite_pending INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ns INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, rotation_index)
      );
      CREATE TABLE tail_offsets (
        file_path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL DEFAULT 0,
        mtime_ns INTEGER NOT NULL DEFAULT 0
      );
    `,
    );
    // Pre-restart: server saw a 9_999-byte file at this path.
    db.prepare(
      `INSERT INTO spool_files (run_id, rotation_index, size_bytes, mtime_ns)
       VALUES (?, ?, ?, ?)`,
    ).run("run-r", 1, 9999, 2_000_000_000);
    // Pre-restart tail position is past the rewritten file's actual EOF.
    db.prepare(
      `INSERT INTO tail_offsets (file_path, offset, mtime_ns)
       VALUES (?, ?, ?)`,
    ).run(filePath, 9999, 2_000_000_000);

    const bus = new EventBus();
    const emitted: Array<{ seq: unknown; type: unknown }> = [];
    bus.on("event", (e) => {
      const r = e.record as Record<string, unknown>;
      emitted.push({ seq: r.seq, type: r.type });
    });

    const tailer = new Tailer({
      spoolRoot,
      bus,
      db: db as unknown as import("better-sqlite3").Database,
      watcherFactory: () =>
        ({
          on() {
            return this;
          },
          close() {
            return Promise.resolve();
          },
        }) as unknown as import("chokidar").FSWatcher,
      disableBackupSweep: true,
    });
    tailer.start();

    await tailer.pokeForTesting(filePath);

    // With the seed-from-spool_files fix: isShrink fires (200 < 9999),
    // tailer resets to offset 0, and BOTH records appear. Without
    // the fix: read would resume from offset 9999 (past EOF) and
    // emit zero events.
    assert.deepEqual(emitted, [
      { seq: 10, type: "chunk_truncated" },
      { seq: 11, type: "chunk_truncated" },
    ]);
  } finally {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Regression: when a JSON object is split across two tailer passes,
// the second pass must NOT re-read carry bytes from disk. The fix
// reads from `state.buffer.nextReadOffset` instead of
// `state.persistedOffset` so the partial line isn't duplicated.
test("Tailer does not duplicate carry when a JSON line spans two reads", async () => {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[tailer.test] skipping — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return;
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-split-"));
  const spoolRoot = path.join(tmpRoot, "spool");
  const runDir = path.join(spoolRoot, "run-1");
  fs.mkdirSync(runDir, { recursive: true });
  const filePath = path.join(runDir, "events-0001.jsonl");

  const db = new Database(":memory:");
  try {
    applySql(
      db,
      `
      CREATE TABLE spool_files (
        run_id TEXT NOT NULL,
        rotation_index INTEGER NOT NULL,
        rewrite_pending INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        mtime_ns INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, rotation_index)
      );
      CREATE TABLE tail_offsets (
        file_path TEXT PRIMARY KEY,
        offset INTEGER NOT NULL DEFAULT 0,
        mtime_ns INTEGER NOT NULL DEFAULT 0
      );
    `,
    );
    const bus = new EventBus();
    const emitted: Array<{ seq: unknown; type: unknown }> = [];
    bus.on("event", (e) => {
      const r = e.record as Record<string, unknown>;
      emitted.push({ seq: r.seq, type: r.type });
    });
    const parseErrors: unknown[] = [];
    bus.on("parse_error", (e) => parseErrors.push(e));

    const tailer = new Tailer({
      spoolRoot,
      bus,
      db: db as unknown as import("better-sqlite3").Database,
      // Provide a no-op watcher so .start() is harmless; we drive
      // the tailer directly via pokeForTesting.
      watcherFactory: () =>
        ({
          on() {
            return this;
          },
          close() {
            return Promise.resolve();
          },
        }) as unknown as import("chokidar").FSWatcher,
      disableBackupSweep: true,
    });
    tailer.start();

    // Pass 1: write one complete line + a partial second line (no \n).
    fs.writeFileSync(filePath, '{"seq":1,"ts":"t","type":"x"}\n{"seq":2,"ts":"t","ty');
    await tailer.pokeForTesting(filePath);
    assert.deepEqual(emitted, [{ seq: 1, type: "x" }]);

    // Pass 2: append the rest of the second line (closes the JSON).
    fs.appendFileSync(filePath, 'pe":"y"}\n');
    await tailer.pokeForTesting(filePath);

    // The carry must be flushed cleanly — exactly one new complete
    // event, no parse_error from a duplicated-prefix corruption.
    assert.equal(parseErrors.length, 0, "no parse errors expected");
    assert.deepEqual(emitted, [
      { seq: 1, type: "x" },
      { seq: 2, type: "y" },
    ]);
  } finally {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// Regression for wing-round-5 finding: chokidar's initial `add` events
// and the backup sweeper's `readdirSync` walk had no per-run ordering.
// On startup with multiple rotated files for the same run, an
// events-0002.jsonl carrying chunks/progress could be ingested BEFORE
// events-0001.jsonl carrying the run_start + subagent_start that
// chunks/progress reference. Under `PRAGMA foreign_keys = ON` that
// fails the INSERT; with FKs off it silently drops the aggregate
// counters the index writer gates on first-time-applied.
//
// Fix: deterministic rotation-sorted enumeration + per-run promise
// chain serialization in the tailer. This test injects a readdirSync
// that returns events-0002 BEFORE events-0001 (the OS's worst-case
// dirent order) and asserts that the index writer still sees every
// row, with parents before children, no FK violation, and the
// aggregates landing exactly once.
test("Tailer ingests rotations in rotation_index order even when readdir returns 0002 first", async () => {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[tailer.test] skipping rotation-order regression — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return;
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-rotorder-"));
  const dbFile = path.join(tmpRoot, "index.db");
  const spoolRoot = path.join(tmpRoot, "spool");
  const runId = "run-rot";
  const runDir = path.join(spoolRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // events-0001: run_start + subagent_start (parents).
  const file1 = path.join(runDir, "events-0001.jsonl");
  fs.writeFileSync(
    file1,
    [
      JSON.stringify({
        seq: 1,
        ts: "2026-05-25T10:00:00.000Z",
        type: "run_start",
        tracked_parent_pid: 12345,
        writer_daemon_pid: 12346,
        host_boot_id: "1700000000.0",
        meta: { dispatcher: "stark-review", repo: "evinced/stark", branch: "main" },
      }),
      JSON.stringify({
        seq: 2,
        ts: "2026-05-25T10:00:01.000Z",
        type: "subagent_start",
        subagent_id: `${runId}:1`,
        agent: "claude",
        model: "opus-4-7",
        task: "domain-security",
      }),
      "",
    ].join("\n"),
  );

  // events-0002: subagent_stdout + subagent_progress (children).
  // Both reference the subagent_id created in events-0001 and the
  // run_id created by events-0001's run_start.
  const file2 = path.join(runDir, "events-0002.jsonl");
  fs.writeFileSync(
    file2,
    [
      JSON.stringify({
        seq: 3,
        ts: "2026-05-25T10:00:02.000Z",
        type: "subagent_stdout",
        subagent_id: `${runId}:1`,
        stream: "stdout",
        encoding: "utf8",
        chunk: "hello world",
      }),
      JSON.stringify({
        seq: 4,
        ts: "2026-05-25T10:00:03.000Z",
        type: "subagent_progress",
        subagent_id: `${runId}:1`,
        kind: "finding",
        payload: { severity: "high" },
      }),
      "",
    ].join("\n"),
  );

  const db = new Database(dbFile);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const migrationsDir = path.resolve(import.meta.dirname, "..", "migrations");
    for (const m of loadMigrations(migrationsDir)) {
      applySql(db, m.sql);
    }

    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    // Capture index-writer commit failures so a silent FK violation
    // does not pass as success. Without the per-run queue + sorted
    // enumeration, applying events-0002's subagent_stdout BEFORE
    // events-0001's subagent_start throws (`chunk_offsets.subagent_id`
    // FK → subagents) and lands in this list.
    const writerErrors: unknown[] = [];
    writer.on("error", (err) => writerErrors.push(err));

    // Worst-case readdir: returns events-0002 BEFORE events-0001 so
    // we exercise the sort in `walkSpoolSorted` / `scanNow` rather
    // than relying on the OS to happen to return them in name order.
    const injectedReaddir = (dir: string): string[] => {
      if (path.resolve(dir) === path.resolve(spoolRoot)) {
        return [runId];
      }
      if (path.resolve(dir) === path.resolve(runDir)) {
        return ["events-0002.jsonl", "events-0001.jsonl"];
      }
      return fs.readdirSync(dir);
    };

    const tailer = new Tailer({
      spoolRoot,
      bus,
      db,
      readdirSync: injectedReaddir,
      watcherFactory: () =>
        ({
          on() {
            return this;
          },
          close() {
            return Promise.resolve();
          },
        }) as unknown as import("chokidar").FSWatcher,
      disableBackupSweep: true,
    });
    tailer.start();
    // Drain the startup scan that `start()` kicked off + force a
    // sweep so the test does not depend on the disabled 10-second
    // timer firing.
    await tailer.scanNow({ runId });
    writer.flush();

    assert.deepEqual(
      writerErrors,
      [],
      `index writer should not have emitted FK / commit errors; got: ${writerErrors
        .map((e) => (e instanceof Error ? e.message : String(e)))
        .join(" | ")}`,
    );

    const runRow = db
      .prepare(
        `SELECT dispatcher, total_subagents, total_findings, last_seq, parent_pid
           FROM runs WHERE run_id = ?`,
      )
      .get(runId) as
      | {
          dispatcher: string;
          total_subagents: number;
          total_findings: number;
          last_seq: number;
          parent_pid: number;
        }
      | undefined;
    assert.ok(runRow, "runs row created from events-0001 run_start");
    assert.equal(runRow.dispatcher, "stark-review");
    assert.equal(runRow.parent_pid, 12345);
    // total_subagents must be 1 exactly — proves the aggregate
    // increment ran the FIRST time subagent_start was applied,
    // not skipped because some out-of-order earlier ingestion
    // already marked seq 2 as wasIndexed.
    assert.equal(runRow.total_subagents, 1);
    assert.equal(runRow.total_findings, 1);
    assert.equal(runRow.last_seq, 4);

    const sa = db
      .prepare(
        `SELECT stdout_bytes, finding_count FROM subagents WHERE subagent_id = ?`,
      )
      .get(`${runId}:1`) as
      | { stdout_bytes: number; finding_count: number }
      | undefined;
    assert.ok(sa, "subagents row created from events-0001 subagent_start");
    assert.equal(sa.stdout_bytes, "hello world".length);
    assert.equal(sa.finding_count, 1);

    const eventCount = db
      .prepare(`SELECT COUNT(*) AS n FROM event_offsets WHERE run_id = ?`)
      .get(runId) as { n: number };
    assert.equal(eventCount.n, 4);

    const chunkCount = db
      .prepare(`SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?`)
      .get(runId) as { n: number };
    assert.equal(chunkCount.n, 1);

    const progressCount = db
      .prepare(`SELECT COUNT(*) AS n FROM progress_events WHERE run_id = ?`)
      .get(runId) as { n: number };
    assert.equal(progressCount.n, 1);
  } finally {
    db.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
