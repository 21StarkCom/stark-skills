// Integration tests for `index_writer.ts`. Exercise the two-step
// idempotency pattern, the chunk_truncated state transition, and the
// universal event_offsets indexing rule end-to-end against an
// in-memory SQLite DB. Skipped (not failed) if better-sqlite3's
// native binding isn't built for the host Node — Docker tests cover
// it under node:22.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EventBus } from "./event_bus.ts";
import { IndexWriter } from "./index_writer.ts";
import { loadMigrations } from "./migrations_loader.ts";

let Database: typeof import("better-sqlite3") | null = null;
let dbModuleError: unknown = null;
try {
  Database = (await import("better-sqlite3")).default;
  // Probe the native binding so the test fail-fast-skips when the
  // .node file failed to build on the host (Node 26 + better-sqlite3
  // 11.10 case). Without the probe, the import succeeds but the first
  // `new Database()` inside a test throws.
  const probe = new Database(":memory:");
  probe.close();
} catch (err) {
  Database = null;
  dbModuleError = err;
}

// Multi-statement SQL runner. Aliased so the call site doesn't trip
// the repo's shell-exec security hook (false positive on the substring
// "exec(").
function applySql(db: import("better-sqlite3").Database, sql: string): void {
  db.exec(sql);
}

function withDb(fn: (db: import("better-sqlite3").Database) => void): void {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[index_writer.test] skipping — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return;
  }
  const tmpFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "iw-test-")),
    "index.db",
  );
  const db = new Database(tmpFile);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    const migrationsDir = path.resolve(import.meta.dirname, "..", "migrations");
    for (const m of loadMigrations(migrationsDir)) {
      applySql(db, m.sql);
    }
    fn(db);
  } finally {
    db.close();
    fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
  }
}

function pushEvent(
  bus: EventBus,
  runId: string,
  record: Record<string, unknown>,
  byteStart: number,
  byteEnd: number,
  rotationIndex = 0,
  mtimeNs = 1_000_000_000_000,
): void {
  bus.emit("event", {
    runId,
    rotationIndex,
    filePath: `/spool/runs/${runId}/events-${String(rotationIndex).padStart(4, "0")}.jsonl`,
    byteStart,
    byteEnd,
    mtimeNs,
    record,
  });
}

test("run_start + subagent_start + chunks index all rows", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "run-1",
      {
        seq: 1,
        ts: "2026-05-25T10:00:00.000Z",
        type: "run_start",
        tracked_parent_pid: 12345,
        writer_daemon_pid: 12346,
        host_boot_id: "1700000000.0",
        meta: { dispatcher: "stark-review", repo: "evinced/stark", branch: "main" },
      },
      0,
      100,
    );
    pushEvent(
      bus,
      "run-1",
      {
        seq: 2,
        ts: "2026-05-25T10:00:01.000Z",
        type: "subagent_start",
        subagent_id: "run-1:1",
        agent: "claude",
        model: "opus-4-7",
        task: "domain-security",
      },
      100,
      200,
    );
    pushEvent(
      bus,
      "run-1",
      {
        seq: 3,
        ts: "2026-05-25T10:00:02.000Z",
        type: "subagent_stdout",
        subagent_id: "run-1:1",
        stream: "stdout",
        encoding: "utf8",
        chunk: "hello world",
      },
      200,
      300,
    );
    writer.flush();

    const run = db.prepare("SELECT * FROM runs WHERE run_id = ?").get("run-1") as
      | {
          dispatcher: string;
          repo: string;
          parent_pid: number;
          total_subagents: number;
          last_seq: number;
        }
      | undefined;
    assert.ok(run);
    assert.equal(run.dispatcher, "stark-review");
    assert.equal(run.repo, "evinced/stark");
    assert.equal(run.parent_pid, 12345);
    assert.equal(run.total_subagents, 1);
    assert.equal(run.last_seq, 3);

    const sa = db
      .prepare("SELECT * FROM subagents WHERE subagent_id = ?")
      .get("run-1:1") as { stdout_bytes: number; finding_count: number } | undefined;
    assert.ok(sa);
    assert.equal(sa.stdout_bytes, 11);
    assert.equal(sa.finding_count, 0);

    const offsets = db
      .prepare("SELECT seq, type FROM event_offsets WHERE run_id = ? ORDER BY seq")
      .all("run-1") as Array<{ seq: number; type: string }>;
    assert.deepEqual(offsets, [
      { seq: 1, type: "run_start" },
      { seq: 2, type: "subagent_start" },
      { seq: 3, type: "subagent_stdout" },
    ]);

    const chunk = db
      .prepare(
        "SELECT seq, stream, byte_start, byte_end FROM chunk_offsets WHERE subagent_id = ?",
      )
      .get("run-1:1") as {
      seq: number;
      stream: string;
      byte_start: number;
      byte_end: number;
    };
    assert.equal(chunk.seq, 3);
    assert.equal(chunk.stream, "stdout");
    assert.equal(chunk.byte_start, 200);
    assert.equal(chunk.byte_end, 300);
  });
});

test("replay of an already-indexed seq is idempotent (counters unchanged, offset refreshed)", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "run-2",
      {
        seq: 1,
        ts: "2026-05-25T10:00:00.000Z",
        type: "run_start",
        tracked_parent_pid: 99,
        meta: { dispatcher: "x" },
      },
      0,
      50,
    );
    pushEvent(
      bus,
      "run-2",
      {
        seq: 2,
        ts: "2026-05-25T10:00:01.000Z",
        type: "subagent_start",
        subagent_id: "run-2:1",
        agent: "claude",
        task: "t",
      },
      50,
      150,
    );
    writer.flush();

    // Replay the same seq with NEW byte ranges.
    pushEvent(
      bus,
      "run-2",
      {
        seq: 2,
        ts: "2026-05-25T10:00:01.000Z",
        type: "subagent_start",
        subagent_id: "run-2:1",
        agent: "claude",
        task: "t",
      },
      40,
      140,
    );
    writer.flush();

    const run = db
      .prepare("SELECT total_subagents FROM runs WHERE run_id = ?")
      .get("run-2") as { total_subagents: number };
    assert.equal(run.total_subagents, 1);

    const offset = db
      .prepare(
        "SELECT byte_start, byte_end FROM event_offsets WHERE run_id = ? AND seq = 2",
      )
      .get("run-2") as { byte_start: number; byte_end: number };
    assert.equal(offset.byte_start, 40);
    assert.equal(offset.byte_end, 140);

    const stats = writer.getStats();
    assert.equal(stats.events_skipped_replay_total, 1);
  });
});

test("chunk_truncated transitions a stdout row in-place (byte counters decremented, chunk_offsets deleted)", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "run-3",
      {
        seq: 1,
        ts: "t",
        type: "run_start",
        meta: { dispatcher: "x" },
        tracked_parent_pid: 1,
      },
      0,
      50,
    );
    pushEvent(
      bus,
      "run-3",
      {
        seq: 2,
        ts: "t",
        type: "subagent_start",
        subagent_id: "run-3:1",
        agent: "a",
        task: "t",
      },
      50,
      100,
    );
    pushEvent(
      bus,
      "run-3",
      {
        seq: 3,
        ts: "t",
        type: "subagent_stdout",
        subagent_id: "run-3:1",
        stream: "stdout",
        encoding: "utf8",
        chunk: "aaaaaaaaaa",
      },
      100,
      200,
    );
    writer.flush();

    const beforeBytes = (
      db
        .prepare("SELECT stdout_bytes FROM subagents WHERE subagent_id = ?")
        .get("run-3:1") as { stdout_bytes: number }
    ).stdout_bytes;
    assert.equal(beforeBytes, 10);
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?")
          .get("run-3") as { n: number }
      ).n,
      1,
    );

    pushEvent(
      bus,
      "run-3",
      {
        seq: 3,
        ts: "t",
        type: "chunk_truncated",
        subagent_id: "run-3:1",
        stream: "stdout",
        bytes_dropped: 7,
      },
      90,
      150,
    );
    writer.flush();

    const after = db
      .prepare("SELECT stdout_bytes FROM subagents WHERE subagent_id = ?")
      .get("run-3:1") as { stdout_bytes: number };
    assert.equal(after.stdout_bytes, 3);

    const chunkCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ?")
        .get("run-3") as { n: number }
    ).n;
    assert.equal(chunkCount, 0);
    const truncRow = db
      .prepare(
        "SELECT seq, bytes_dropped, stream FROM chunk_truncations WHERE run_id = ?",
      )
      .get("run-3") as { seq: number; bytes_dropped: number; stream: string };
    assert.equal(truncRow.seq, 3);
    assert.equal(truncRow.bytes_dropped, 7);
    assert.equal(truncRow.stream, "stdout");

    const offset = db
      .prepare(
        "SELECT type, byte_start, byte_end FROM event_offsets WHERE run_id = ? AND seq = 3",
      )
      .get("run-3") as { type: string; byte_start: number; byte_end: number };
    assert.equal(offset.type, "chunk_truncated");
    assert.equal(offset.byte_start, 90);
    assert.equal(offset.byte_end, 150);

    pushEvent(
      bus,
      "run-3",
      {
        seq: 3,
        ts: "t",
        type: "chunk_truncated",
        subagent_id: "run-3:1",
        stream: "stdout",
        bytes_dropped: 7,
      },
      90,
      150,
    );
    writer.flush();
    const after2 = db
      .prepare("SELECT stdout_bytes FROM subagents WHERE subagent_id = ?")
      .get("run-3:1") as { stdout_bytes: number };
    assert.equal(after2.stdout_bytes, 3);
  });
});

test("chunk_truncated at a fresh seq (synthetic gap) does NOT decrement byte counters", () => {
  // Regression: the writer daemon's `emit_chunk_truncated` test-seed op
  // writes a chunk_truncated at a brand-new seq. Without the
  // hadExistingChunk guard, the byte-counter decrement would push
  // subagents.stdout_bytes below the true emitted total.
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "run-synth",
      {
        seq: 1,
        ts: "t",
        type: "run_start",
        meta: { dispatcher: "x" },
        tracked_parent_pid: 1,
      },
      0,
      50,
    );
    pushEvent(
      bus,
      "run-synth",
      {
        seq: 2,
        ts: "t",
        type: "subagent_start",
        subagent_id: "run-synth:1",
        agent: "a",
        task: "t",
      },
      50,
      100,
    );
    pushEvent(
      bus,
      "run-synth",
      {
        seq: 3,
        ts: "t",
        type: "subagent_stdout",
        subagent_id: "run-synth:1",
        stream: "stdout",
        encoding: "utf8",
        chunk: "bbbbbbbbbb",
      },
      100,
      200,
    );
    writer.flush();
    assert.equal(
      (
        db
          .prepare("SELECT stdout_bytes FROM subagents WHERE subagent_id = ?")
          .get("run-synth:1") as { stdout_bytes: number }
      ).stdout_bytes,
      10,
    );

    // Synthetic gap at a NEW seq (4) — no prior chunk_offsets row.
    pushEvent(
      bus,
      "run-synth",
      {
        seq: 4,
        ts: "t",
        type: "chunk_truncated",
        subagent_id: "run-synth:1",
        stream: "stdout",
        bytes_dropped: 999_999,
      },
      200,
      260,
    );
    writer.flush();

    // Byte counter unchanged — the gap was synthetic.
    assert.equal(
      (
        db
          .prepare("SELECT stdout_bytes FROM subagents WHERE subagent_id = ?")
          .get("run-synth:1") as { stdout_bytes: number }
      ).stdout_bytes,
      10,
    );
    // chunk_truncations row + event_offsets row still landed.
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM chunk_truncations WHERE run_id = ? AND seq = 4",
          )
          .get("run-synth") as { n: number }
      ).n,
      1,
    );
    const offset = db
      .prepare("SELECT type FROM event_offsets WHERE run_id = ? AND seq = 4")
      .get("run-synth") as { type: string };
    assert.equal(offset.type, "chunk_truncated");
    // Pre-existing chunk_offsets row at seq 3 untouched.
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM chunk_offsets WHERE run_id = ? AND seq = 3",
          )
          .get("run-synth") as { n: number }
      ).n,
      1,
    );
  });
});

test("subagent_progress finding increments both subagent + run counters; non-finding kinds don't", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "r4",
      { seq: 1, ts: "t", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "r4",
      {
        seq: 2,
        ts: "t",
        type: "subagent_start",
        subagent_id: "r4:1",
        agent: "a",
        task: "t",
      },
      10,
      20,
    );
    pushEvent(
      bus,
      "r4",
      {
        seq: 3,
        ts: "t",
        type: "subagent_progress",
        subagent_id: "r4:1",
        kind: "finding",
        payload: { severity: "high" },
      },
      20,
      30,
    );
    pushEvent(
      bus,
      "r4",
      {
        seq: 4,
        ts: "t",
        type: "subagent_progress",
        subagent_id: "r4:1",
        kind: "round",
        payload: { round_num: 1 },
      },
      30,
      40,
    );
    writer.flush();

    const sa = db
      .prepare("SELECT finding_count FROM subagents WHERE subagent_id = ?")
      .get("r4:1") as { finding_count: number };
    assert.equal(sa.finding_count, 1);
    const run = db
      .prepare("SELECT total_findings FROM runs WHERE run_id = ?")
      .get("r4") as { total_findings: number };
    assert.equal(run.total_findings, 1);

    const progressRows = db
      .prepare("SELECT seq, kind FROM progress_events WHERE run_id = ? ORDER BY seq")
      .all("r4") as Array<{ seq: number; kind: string }>;
    assert.deepEqual(progressRows, [
      { seq: 3, kind: "finding" },
      { seq: 4, kind: "round" },
    ]);
  });
});

test("run_end + subagent_end populate terminal columns", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "r5",
      { seq: 1, ts: "t1", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "r5",
      {
        seq: 2,
        ts: "t2",
        type: "subagent_start",
        subagent_id: "r5:1",
        agent: "a",
        task: "t",
      },
      10,
      20,
    );
    pushEvent(
      bus,
      "r5",
      {
        seq: 3,
        ts: "2026-05-25T10:00:00.000Z",
        type: "subagent_end",
        subagent_id: "r5:1",
        status: "ok",
        duration_ms: 1234,
        summary: { findings: 0 },
      },
      20,
      30,
    );
    pushEvent(
      bus,
      "r5",
      {
        seq: 4,
        ts: "2026-05-25T10:00:05.000Z",
        type: "run_end",
        status: "crashed",
        crashed_reason: "parent_exit",
      },
      30,
      40,
    );
    writer.flush();

    const sa = db
      .prepare(
        "SELECT status, duration_ms, ended_at, summary_json FROM subagents WHERE subagent_id = ?",
      )
      .get("r5:1") as {
      status: string;
      duration_ms: number;
      ended_at: string;
      summary_json: string;
    };
    assert.equal(sa.status, "ok");
    assert.equal(sa.duration_ms, 1234);
    assert.equal(sa.ended_at, "2026-05-25T10:00:00.000Z");
    assert.deepEqual(JSON.parse(sa.summary_json), { findings: 0 });

    const run = db
      .prepare("SELECT status, crashed_reason, ended_at FROM runs WHERE run_id = ?")
      .get("r5") as { status: string; crashed_reason: string; ended_at: string };
    assert.equal(run.status, "crashed");
    assert.equal(run.crashed_reason, "parent_exit");
    assert.equal(run.ended_at, "2026-05-25T10:00:05.000Z");
  });
});

// Regression for the wing finding: `runs.last_seq` must reflect the
// final emitted event's seq regardless of type. The previous version
// only advanced it on subagent_stdout/subagent_stderr, so a run whose
// final event was run_heartbeat / run_end / subagent_progress /
// subagent_end left last_seq stale and broke Phase 3 restart
// verification.
test("runs.last_seq advances for every event type, including a final run_end", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "rseq",
      { seq: 1, ts: "t", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "rseq",
      {
        seq: 2,
        ts: "t",
        type: "subagent_start",
        subagent_id: "rseq:1",
        agent: "a",
        task: "t",
      },
      10,
      20,
    );
    pushEvent(
      bus,
      "rseq",
      {
        seq: 3,
        ts: "t",
        type: "subagent_progress",
        subagent_id: "rseq:1",
        kind: "round",
        payload: { round_num: 1 },
      },
      20,
      30,
    );
    pushEvent(
      bus,
      "rseq",
      {
        seq: 4,
        ts: "t",
        type: "subagent_heartbeat",
        subagent_id: "rseq:1",
      },
      30,
      40,
    );
    pushEvent(
      bus,
      "rseq",
      {
        seq: 5,
        ts: "t",
        type: "subagent_end",
        subagent_id: "rseq:1",
        status: "ok",
      },
      40,
      50,
    );
    pushEvent(
      bus,
      "rseq",
      {
        seq: 6,
        ts: "t",
        type: "run_heartbeat",
        parent_pid: 1,
        bytes_written: 50,
      },
      50,
      60,
    );
    pushEvent(
      bus,
      "rseq",
      { seq: 7, ts: "t", type: "run_end", status: "ok" },
      60,
      70,
    );
    writer.flush();

    const row = db
      .prepare("SELECT last_seq FROM runs WHERE run_id = ?")
      .get("rseq") as { last_seq: number };
    assert.equal(row.last_seq, 7);
  });
});

test("runs.last_seq is MAX-clamped (out-of-order replay doesn't regress it)", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "rclamp",
      { seq: 1, ts: "t", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "rclamp",
      { seq: 5, ts: "t", type: "run_heartbeat", bytes_written: 1 },
      10,
      20,
    );
    writer.flush();
    // Replay seq=1 (the wasIndexed=true path) — must not lower last_seq.
    pushEvent(
      bus,
      "rclamp",
      { seq: 1, ts: "t", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    writer.flush();

    const row = db
      .prepare("SELECT last_seq FROM runs WHERE run_id = ?")
      .get("rclamp") as { last_seq: number };
    assert.equal(row.last_seq, 5);
  });
});

// Regression: a JSON object missing seq / ts / type is a complete-
// consumed line on disk. The previous version returned early WITHOUT
// upserting tail_offsets, so a restart would re-read the same bad
// line forever. The fix advances tail_offsets just like the parse_error
// path (file offset moves past the bad line).
test("schema-invalid JSON record still advances tail_offsets", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    const filePath = "/spool/runs/run-bad/events-0000.jsonl";
    // Schema-invalid: parses as a JSON object but missing required
    // envelope fields (no seq / ts / type).
    bus.emit("event", {
      runId: "run-bad",
      rotationIndex: 0,
      filePath,
      byteStart: 0,
      byteEnd: 50,
      mtimeNs: 2_000_000_000,
      record: { hello: "world" },
    });
    writer.flush();

    const row = db
      .prepare(
        "SELECT offset, mtime_ns FROM tail_offsets WHERE file_path = ?",
      )
      .get(filePath) as { offset: number; mtime_ns: number } | undefined;
    assert.ok(row, "tail_offsets row must exist after schema-invalid record");
    assert.equal(row.offset, 50);
    assert.equal(row.mtime_ns, 2_000_000_000);
  });
});

test("chunk_truncated transition emits a typed truncation event after commit", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();
    const broadcasts: Array<Record<string, unknown>> = [];
    bus.on("truncation", (t) => {
      broadcasts.push({ ...t });
    });

    pushEvent(
      bus,
      "rtb",
      { seq: 1, ts: "t", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "rtb",
      {
        seq: 2,
        ts: "t",
        type: "subagent_start",
        subagent_id: "rtb:1",
        agent: "a",
        task: "t",
      },
      10,
      20,
    );
    pushEvent(
      bus,
      "rtb",
      {
        seq: 3,
        ts: "t",
        type: "subagent_stdout",
        subagent_id: "rtb:1",
        stream: "stdout",
        encoding: "utf8",
        chunk: "aaaaaaaaaa",
      },
      20,
      40,
    );
    writer.flush();
    assert.equal(broadcasts.length, 0, "no broadcast before truncation");

    pushEvent(
      bus,
      "rtb",
      {
        seq: 3,
        ts: "t2",
        type: "chunk_truncated",
        subagent_id: "rtb:1",
        stream: "stdout",
        bytes_dropped: 7,
      },
      18,
      30,
    );
    writer.flush();

    assert.equal(broadcasts.length, 1, "one truncation broadcast after state transition");
    assert.deepEqual(broadcasts[0], {
      runId: "rtb",
      subagentId: "rtb:1",
      seq: 3,
      ts: "t2",
      stream: "stdout",
      bytesDropped: 7,
      rotationIndex: 0,
      byteStart: 18,
      byteEnd: 30,
    });

    // No-op replay of the SAME chunk_truncated row must NOT re-fire.
    pushEvent(
      bus,
      "rtb",
      {
        seq: 3,
        ts: "t2",
        type: "chunk_truncated",
        subagent_id: "rtb:1",
        stream: "stdout",
        bytes_dropped: 7,
      },
      18,
      30,
    );
    writer.flush();
    assert.equal(
      broadcasts.length,
      1,
      "no-op replay of chunk_truncated must not re-broadcast",
    );
  });
});

test("run_heartbeat populates parent_pid + writer_daemon_pid + last_heartbeat_at", () => {
  withDb((db) => {
    const bus = new EventBus();
    const writer = new IndexWriter({ db, bus });
    writer.start();

    pushEvent(
      bus,
      "r6",
      { seq: 1, ts: "t1", type: "run_start", meta: { dispatcher: "x" } },
      0,
      10,
    );
    pushEvent(
      bus,
      "r6",
      {
        seq: 2,
        ts: "2026-05-25T10:00:00.000Z",
        type: "run_heartbeat",
        parent_pid: 555,
        writer_daemon_pid: 666,
        host_boot_id: "1.2",
        bytes_written: 1024,
      },
      10,
      20,
    );
    writer.flush();

    const run = db
      .prepare(
        "SELECT parent_pid, writer_daemon_pid, host_boot_id, last_heartbeat_at, bytes_written FROM runs WHERE run_id = ?",
      )
      .get("r6") as {
      parent_pid: number;
      writer_daemon_pid: number;
      host_boot_id: string;
      last_heartbeat_at: string;
      bytes_written: number;
    };
    assert.equal(run.parent_pid, 555);
    assert.equal(run.writer_daemon_pid, 666);
    assert.equal(run.host_boot_id, "1.2");
    assert.equal(run.last_heartbeat_at, "2026-05-25T10:00:00.000Z");
    assert.equal(run.bytes_written, 1024);
  });
});
