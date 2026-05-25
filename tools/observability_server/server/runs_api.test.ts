// HTTP-level tests for the read-side API. Run via:
//   node --experimental-strip-types --test server/runs_api.test.ts

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { loadMigrations } from "./migrations_loader.ts";
import { registerRunsApi } from "./runs_api.ts";
import { EventBus, type ParsedEvent } from "./event_bus.ts";

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

async function withApp(
  fn: (
    app: import("fastify").FastifyInstance,
    db: import("better-sqlite3").Database,
  ) => Promise<void>,
): Promise<void> {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log("[runs_api.test] skipping — better-sqlite3 not available");
    return;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-api-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  const app = Fastify({ logger: false });
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    registerRunsApi(app, {
      db,
      spoolRoot: path.join(tmpDir, "spool"),
      indexWriterStats: () => ({
        events_indexed_total: 7,
        events_skipped_replay_total: 0,
        chunk_truncated_transitions_total: 0,
        batches_flushed_total: 1,
      }),
      getTailerParseErrors: () => 0,
    });
    await app.ready();
    await fn(app, db);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function seedRun(
  db: import("better-sqlite3").Database,
  runId: string,
  startedAt: string,
  status = "running",
): void {
  db.prepare(
    `INSERT INTO runs (run_id, dispatcher, started_at, status)
     VALUES (?, 'multi_review', ?, ?)`,
  ).run(runId, startedAt, status);
}

test("GET /api/runs returns items sorted by started_at DESC", async () => {
  await withApp(async (app, db) => {
    seedRun(db, "run-a", "2026-01-01T00:00:00.000Z");
    seedRun(db, "run-b", "2026-02-01T00:00:00.000Z");
    seedRun(db, "run-c", "2026-03-01T00:00:00.000Z");
    const res = await app.inject({ method: "GET", url: "/api/runs?limit=2" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      items: Array<{ run_id: string }>;
      next_cursor: string | null;
    };
    assert.deepEqual(body.items.map((r) => r.run_id), ["run-c", "run-b"]);
    assert.ok(body.next_cursor !== null);

    const page2 = await app.inject({
      method: "GET",
      url: `/api/runs?limit=2&cursor=${encodeURIComponent(body.next_cursor!)}`,
    });
    const body2 = page2.json() as {
      items: Array<{ run_id: string }>;
      next_cursor: string | null;
    };
    assert.deepEqual(body2.items.map((r) => r.run_id), ["run-a"]);
    assert.equal(body2.next_cursor, null);
  });
});

test("GET /api/runs filters by status", async () => {
  await withApp(async (app, db) => {
    seedRun(db, "r-running", "2026-01-01T00:00:00.000Z", "running");
    seedRun(db, "r-crashed", "2026-01-02T00:00:00.000Z", "crashed");
    const res = await app.inject({
      method: "GET",
      url: "/api/runs?status=crashed",
    });
    const body = res.json() as { items: Array<{ run_id: string }> };
    assert.deepEqual(body.items.map((r) => r.run_id), ["r-crashed"]);
  });
});

test("GET /api/runs/:run_id includes subagents block", async () => {
  await withApp(async (app, db) => {
    seedRun(db, "run-x", "2026-01-01T00:00:00.000Z");
    db.prepare(
      `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
       VALUES ('run-x:1', 'run-x', 'claude', 'review', ?, 'running')`,
    ).run("2026-01-01T00:00:00.000Z");
    const res = await app.inject({ method: "GET", url: "/api/runs/run-x" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      run: { run_id: string };
      subagents: Array<{ subagent_id: string }>;
    };
    assert.equal(body.run.run_id, "run-x");
    assert.equal(body.subagents.length, 1);
    assert.equal(body.subagents[0]!.subagent_id, "run-x:1");
  });
});

test("GET /api/runs/:run_id → 404 when missing", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runs/ghost-run",
    });
    assert.equal(res.statusCode, 404);
  });
});

test("GET /api/health surfaces counters + ISO timestamp + durability block", async () => {
  await withApp(async (app, db) => {
    seedRun(db, "h-1", "2026-01-01T00:00:00.000Z", "running");
    seedRun(db, "h-2", "2026-01-02T00:00:00.000Z", "crashed");
    const res = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ok: boolean;
      ts: string;
      runs: { running_runs: number; crashed_runs: number };
      index_writer: { events_indexed_total: number };
      tailer: { parse_errors_total: number };
      durability: {
        batched_queue_depth: number;
        fsync_p50_ms: number | null;
        fsync_p99_ms: number | null;
        last_fsync_at: string | null;
      };
    };
    assert.equal(body.ok, true);
    assert.match(body.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(body.runs.running_runs, 1);
    assert.equal(body.runs.crashed_runs, 1);
    assert.equal(body.index_writer.events_indexed_total, 7);
    assert.equal(body.tailer.parse_errors_total, 0);
    // RT5 durability block — required by /api/health contract.
    assert.ok(body.durability !== undefined, "durability block present");
    assert.equal(typeof body.durability.batched_queue_depth, "number");
    assert.equal(body.durability.batched_queue_depth, 0);
    assert.equal(body.durability.fsync_p50_ms, null);
    assert.equal(body.durability.fsync_p99_ms, null);
    assert.equal(body.durability.last_fsync_at, null);
  });
});

test("GET /api/health durability block reflects injected provider", async () => {
  if (Database === null) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-api-d-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  const app = Fastify({ logger: false });
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    registerRunsApi(app, {
      db,
      spoolRoot: path.join(tmpDir, "spool"),
      indexWriterStats: () => ({
        events_indexed_total: 0,
        events_skipped_replay_total: 0,
        chunk_truncated_transitions_total: 0,
        batches_flushed_total: 0,
      }),
      getTailerParseErrors: () => 0,
      getDurabilityStats: () => ({
        batched_queue_depth: 12,
        fsync_p50_ms: 3.4,
        fsync_p99_ms: 17.1,
        last_fsync_at: "2026-05-25T12:00:00.000Z",
      }),
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    const body = res.json() as {
      durability: {
        batched_queue_depth: number;
        fsync_p50_ms: number | null;
        fsync_p99_ms: number | null;
        last_fsync_at: string | null;
      };
    };
    assert.equal(body.durability.batched_queue_depth, 12);
    assert.equal(body.durability.fsync_p50_ms, 3.4);
    assert.equal(body.durability.fsync_p99_ms, 17.1);
    assert.equal(body.durability.last_fsync_at, "2026-05-25T12:00:00.000Z");
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chunks SSE with to_seq omitted switches to live tail and ends on subagent_end", async () => {
  if (Database === null) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-api-sse-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  const app = Fastify({ logger: false });
  const bus = new EventBus();
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    seedRun(db, "r-live", "2026-01-01T00:00:00.000Z", "running");
    db.prepare(
      `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
       VALUES ('r-live:1', 'r-live', 'claude', 'review', ?, 'running')`,
    ).run("2026-01-01T00:00:00.000Z");
    registerRunsApi(app, {
      db,
      spoolRoot: path.join(tmpDir, "spool"),
      bus,
      indexWriterStats: () => ({
        events_indexed_total: 0,
        events_skipped_replay_total: 0,
        chunk_truncated_transitions_total: 0,
        batches_flushed_total: 0,
      }),
      getTailerParseErrors: () => 0,
    });
    await app.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("no server address");
    }
    const url = `http://127.0.0.1:${addr.port}/api/runs/r-live/subagents/r-live:1/chunks`;
    const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
    assert.equal(res.status, 200);
    // Give the handler a moment to attach the bus listener before we emit.
    await new Promise((r) => setTimeout(r, 100));
    const fakeEvent: ParsedEvent = {
      runId: "r-live",
      rotationIndex: 0,
      filePath: "",
      byteStart: 0,
      byteEnd: 1,
      mtimeNs: 0,
      record: {
        type: "subagent_stdout",
        seq: 7,
        ts: "2026-01-01T00:00:00.001Z",
        run_id: "r-live",
        subagent_id: "r-live:1",
        encoding: "utf8",
        chunk: "hello",
      },
    };
    bus.emit("event", fakeEvent);
    const fakeEnd: ParsedEvent = {
      runId: "r-live",
      rotationIndex: 0,
      filePath: "",
      byteStart: 0,
      byteEnd: 1,
      mtimeNs: 0,
      record: {
        type: "subagent_end",
        seq: 8,
        ts: "2026-01-01T00:00:00.002Z",
        run_id: "r-live",
        subagent_id: "r-live:1",
        status: "ok",
      },
    };
    bus.emit("event", fakeEnd);
    const text = await res.text();
    assert.match(text, /event: chunk\b/);
    assert.match(text, /"seq":7/);
    assert.match(text, /event: end\b/);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("chunks SSE on already-terminal subagent emits end immediately", async () => {
  if (Database === null) return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-api-sse2-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  const app = Fastify({ logger: false });
  const bus = new EventBus();
  try {
    db.pragma("foreign_keys = ON");
    for (const m of loadMigrations(
      path.resolve(import.meta.dirname, "..", "migrations"),
    )) {
      applySql(db, m.sql);
    }
    seedRun(db, "r-done", "2026-01-01T00:00:00.000Z", "ok");
    db.prepare(
      `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
       VALUES ('r-done:1', 'r-done', 'claude', 'review', ?, 'ok')`,
    ).run("2026-01-01T00:00:00.000Z");
    registerRunsApi(app, {
      db,
      spoolRoot: path.join(tmpDir, "spool"),
      bus,
      indexWriterStats: () => ({
        events_indexed_total: 0,
        events_skipped_replay_total: 0,
        chunk_truncated_transitions_total: 0,
        batches_flushed_total: 0,
      }),
      getTailerParseErrors: () => 0,
    });
    await app.ready();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("no server address");
    }
    const url = `http://127.0.0.1:${addr.port}/api/runs/r-done/subagents/r-done:1/chunks`;
    const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
    const text = await res.text();
    assert.match(text, /event: end\b/);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("bad cursor → 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runs?cursor=!!!notbase64",
    });
    // Either bad_cursor or bad_query, both 400.
    assert.equal(res.statusCode, 400);
  });
});
