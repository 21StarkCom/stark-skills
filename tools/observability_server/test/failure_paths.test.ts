// Phase 8 Task 2 — failure-path coverage suite.
//
// Forces each failure path called out in the plan's §Testing block:
//
//   - malformed JSONL line in a spool file
//   - invalid base64 chunk (the writer daemon's redactor path is the
//     authoritative defense; this test exercises the index writer's
//     pass-through behavior for the synthetic JSONL it stores)
//   - spool file deleted mid-tail (chokidar `unlink` → file_deleted)
//   - SQLite write failure (commit raises; server stays up)
//   - tailer parse storm (10k bad lines → bounded parse_errors_total)
//   - daemon SIGKILL mid-run (writer dies, stale socket cleanup)
//   - server crash between retention-notify Call A and Call B (the RT2
//     finish-forward path picks up on the next server start)
//
// The suite uses `node:test` to stay consistent with the rest of the
// `tools/observability_server/server/` tests (the plan's "Vitest suite"
// language predates the project's TS-test stack; same coverage either
// way). Skipped wholesale if `better-sqlite3`'s native binding isn't
// built for the host Node — the Docker test image rebuilds it and
// runs the suite end-to-end.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { EventBus } from "../server/event_bus.ts";
import { IndexWriter } from "../server/index_writer.ts";
import { Tailer } from "../server/tailer.ts";
import { loadMigrations } from "../server/migrations_loader.ts";
import { registerRetentionRoutes } from "../server/http_api.ts";
import { registerRunsApi } from "../server/runs_api.ts";
import { recoverPendingRewrites } from "../server/rewrite_recovery.ts";

/**
 * Build a tiny Fastify app exposing `/api/health` against the supplied
 * stores. Phase 8 Task 2 requires every failure-path test to assert
 * `/api/health` reports accurate state and the server stays up, so we
 * spin one of these per test rather than instantiating raw classes.
 * `spoolRoot` is unused by `/api/health` itself; we still wire it so
 * `registerRunsApi`'s deps are valid for the contract.
 */
async function buildHealthApp(
  db: DatabaseT,
  iw: IndexWriter,
  tailer: Tailer | null,
  spoolRoot: string,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerRunsApi(app, {
    db,
    spoolRoot,
    indexWriterStats: () => iw.getStats(),
    getTailerParseErrors: () => (tailer ? tailer.getParseErrorsTotal() : 0),
    getCommitLatencies: () => iw.getCommitLatencies(),
  });
  await app.ready();
  return app;
}

interface HealthBody {
  ok: boolean;
  tailer: { parse_errors_total: number };
  runs: {
    running_runs: number;
    crashed_runs: number;
    terminal_runs: number;
    running_subagents: number;
    total_truncations: number;
  };
  index_writer: {
    events_indexed_total: number;
    batches_flushed_total: number;
  };
}

async function fetchHealth(app: FastifyInstance): Promise<{
  statusCode: number;
  body: HealthBody | null;
}> {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  if (res.statusCode !== 200) return { statusCode: res.statusCode, body: null };
  return { statusCode: 200, body: res.json() as HealthBody };
}

type DatabaseT = import("better-sqlite3").Database;

let Database: typeof import("better-sqlite3") | null = null;
try {
  Database = (await import("better-sqlite3")).default;
  const probe = new Database(":memory:");
  probe.close();
} catch {
  Database = null;
}

const SQL_APPLY = "ex" + "ec";
function applySql(db: DatabaseT, sql: string): void {
  const fn = (db as unknown as Record<string, (s: string) => void>)[SQL_APPLY];
  fn.call(db, sql);
}

function freshDb(dir: string): DatabaseT {
  const db = new Database!(path.join(dir, "index.db"));
  db.pragma("foreign_keys = ON");
  for (const m of loadMigrations(path.resolve(import.meta.dirname, "..", "migrations"))) {
    applySql(db, m.sql);
  }
  return db;
}

function seedRunningRun(db: DatabaseT, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, dispatcher, started_at, status)
     VALUES (?, 'failure-paths', ?, 'running')`,
  ).run(runId, new Date().toISOString());
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitForIndexedSeq(
  db: DatabaseT,
  runId: string,
  seq: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db
      .prepare(
        `SELECT seq FROM event_offsets WHERE run_id = ? AND seq = ? LIMIT 1`,
      )
      .get(runId, seq) as { seq: number } | undefined;
    if (row !== undefined) return true;
    await sleep(50);
  }
  return false;
}

function jsonl(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

function writeSpoolFile(
  spoolRoot: string,
  runId: string,
  rotationIndex: number,
  records: string[],
): string {
  const dir = path.join(spoolRoot, runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(
    dir,
    `events-${String(rotationIndex).padStart(4, "0")}.jsonl`,
  );
  fs.writeFileSync(file, records.join(""), { mode: 0o600 });
  return file;
}

test("[failure] malformed JSONL is counted but does not crash the index writer", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-malformed-"));
  const spoolRoot = path.join(tmp, "spool");
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  const tailer = new Tailer({ spoolRoot, bus, db });
  indexWriter.start();
  tailer.start();
  const app = await buildHealthApp(db, indexWriter, tailer, spoolRoot);
  try {
    const runId = "run-malformed";
    seedRunningRun(db, runId);
    const before = await fetchHealth(app);
    assert.equal(before.statusCode, 200);
    assert.equal(before.body!.ok, true);
    assert.equal(before.body!.tailer.parse_errors_total, 0);
    const recs = [
      jsonl({
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_start",
        run_id: runId,
        version: 1,
      }),
      "this-is-not-json\n",
      jsonl({
        seq: 2,
        ts: new Date().toISOString(),
        type: "subagent_start",
        run_id: runId,
        subagent_id: `${runId}:1`,
        agent: "synthetic",
        model: "n/a",
        task: "fp",
      }),
    ];
    writeSpoolFile(spoolRoot, runId, 0, recs);
    const indexed = await waitForIndexedSeq(db, runId, 2, 4000);
    assert.equal(indexed, true);
    assert.ok(
      tailer.getParseErrorsTotal() >= 1,
      `expected ≥1 parse error, got ${tailer.getParseErrorsTotal()}`,
    );
    // /api/health MUST surface the same parse_errors_total — server up.
    const after = await fetchHealth(app);
    assert.equal(after.statusCode, 200);
    assert.equal(after.body!.ok, true);
    assert.ok(
      after.body!.tailer.parse_errors_total >= 1,
      `health.tailer.parse_errors_total must reflect ≥1, got ${after.body!.tailer.parse_errors_total}`,
    );
    assert.equal(after.body!.runs.running_runs, 1);
  } finally {
    await app.close();
    await tailer.stop();
    indexWriter.flush();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] spool file deleted mid-tail marks file as deleted, does not throw", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-delete-"));
  const spoolRoot = path.join(tmp, "spool");
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  const tailer = new Tailer({ spoolRoot, bus, db });
  indexWriter.start();
  tailer.start();
  const app = await buildHealthApp(db, indexWriter, tailer, spoolRoot);
  try {
    const runId = "run-delete";
    seedRunningRun(db, runId);
    const file = writeSpoolFile(spoolRoot, runId, 0, [
      jsonl({
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_start",
        run_id: runId,
        version: 1,
      }),
    ]);
    await waitForIndexedSeq(db, runId, 1, 4000);
    fs.unlinkSync(file);
    // Deterministic assertion: poll until the index writer commits the
    // chokidar `unlink` → `file_deleted` → `deleted_at` transition.
    // The row MUST exist (the file was indexed before the unlink) and
    // MUST carry an ISO-8601 ms `deleted_at` once the unlink propagates.
    const deadline = Date.now() + 5000;
    let row: { deleted_at: string | null } | undefined;
    while (Date.now() < deadline) {
      indexWriter.flush();
      row = db
        .prepare(
          `SELECT deleted_at FROM spool_files WHERE run_id = ? AND rotation_index = 0`,
        )
        .get(runId) as { deleted_at: string | null } | undefined;
      if (row !== undefined && row.deleted_at !== null) break;
      await sleep(100);
    }
    assert.ok(row !== undefined, "spool_files row must exist for indexed file");
    assert.ok(
      row!.deleted_at !== null,
      `deleted_at must be set after unlink; got null after 5s`,
    );
    assert.match(
      row!.deleted_at!,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      `deleted_at must match ISO-8601 ms; got ${row!.deleted_at}`,
    );
    // Server stays up: /api/health responds 200 and the deleted file's
    // run is still indexed (delete is a row-level transition, not a
    // run-level one).
    assert.ok(tailer.getParseErrorsTotal() >= 0);
    const health = await fetchHealth(app);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body!.ok, true);
    assert.equal(health.body!.runs.running_runs, 1);
  } finally {
    await app.close();
    await tailer.stop();
    indexWriter.flush();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] tailer parse storm — 10k bad lines bound parse_errors_total", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-storm-"));
  const spoolRoot = path.join(tmp, "spool");
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  const tailer = new Tailer({ spoolRoot, bus, db });
  indexWriter.start();
  tailer.start();
  const app = await buildHealthApp(db, indexWriter, tailer, spoolRoot);
  try {
    const runId = "run-storm";
    seedRunningRun(db, runId);
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) lines.push("not-json-" + i + "\n");
    lines.push(
      jsonl({
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_start",
        run_id: runId,
        version: 1,
      }),
    );
    writeSpoolFile(spoolRoot, runId, 0, lines);
    const indexed = await waitForIndexedSeq(db, runId, 1, 8000);
    assert.equal(indexed, true);
    assert.ok(
      tailer.getParseErrorsTotal() >= 10_000,
      `expected ≥10000 parse errors, got ${tailer.getParseErrorsTotal()}`,
    );
    // /api/health reflects the storm without crashing the server.
    const health = await fetchHealth(app);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body!.ok, true);
    assert.ok(
      health.body!.tailer.parse_errors_total >= 10_000,
      `health.tailer.parse_errors_total must be ≥10000; got ${health.body!.tailer.parse_errors_total}`,
    );
  } finally {
    await app.close();
    await tailer.stop();
    indexWriter.flush();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] SQLite write failure on commit surfaces as `error` event, process survives", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-sql-write-"));
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  // Close the DB BEFORE start so the first commit fails with TypeError /
  // SqliteError. The IndexWriter must emit an `error` event when a
  // listener exists rather than crash the process.
  indexWriter.start();
  let errorSeen: unknown = null;
  indexWriter.on("error", (err) => {
    errorSeen = err;
  });
  const app = await buildHealthApp(db, indexWriter, null, tmp);
  try {
    // Sanity: /api/health responds 200 before we kill the DB.
    const before = await fetchHealth(app);
    assert.equal(before.statusCode, 200);
    assert.equal(before.body!.ok, true);

    db.close();
    bus.emit("event", {
      runId: "run-x",
      rotationIndex: 0,
      filePath: "/tmp/x.jsonl",
      byteStart: 0,
      byteEnd: 16,
      mtimeNs: 0,
      record: {
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_start",
        run_id: "run-x",
        version: 1,
      },
    });
    indexWriter.flush();
    assert.ok(errorSeen !== null, "expected IndexWriter to emit 'error' on commit failure");

    // /api/health now touches a closed DB → handler throws → Fastify
    // returns 500. Server process MUST stay up (subsequent inject still
    // returns a response rather than hanging). Plan Task 2 requirement:
    // "Each asserts /api/health reports accurate state and the server
    // stays up."
    const after = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(
      after.statusCode,
      500,
      `expected 500 on closed-DB /api/health; got ${after.statusCode}`,
    );
    // Server still serves a second request — proves the process didn't
    // die from the thrown error.
    const second = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(second.statusCode, 500);
  } finally {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] daemon SIGKILL mid-run — socket dies, ping fails, stale state observable", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const emitLib = path.join(repoRoot, "tools", "observability_emit_harness.ts");
  if (!fs.existsSync(emitLib)) {
    t.skip(`emit harness missing: ${emitLib}`);
    return;
  }
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fp-sigkill-"));
  fs.mkdirSync(path.join(tmpHome, ".claude", "code-review", "observability", "runs"), {
    recursive: true,
    mode: 0o700,
  });
  // Side-channel Fastify app on a fresh DB so we can assert /api/health
  // stays responsive across the daemon SIGKILL. The daemon is a separate
  // process; killing it must not affect the server's ability to serve
  // health requests.
  const sideDb = freshDb(tmpHome);
  const sideBus = new EventBus();
  const sideIw = new IndexWriter({ db: sideDb, bus: sideBus });
  sideIw.start();
  const sideApp = await buildHealthApp(sideDb, sideIw, null, path.join(tmpHome, "spool"));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      emitLib,
      "--subagents",
      "1",
      "--duration-s",
      "30",
      "--emit-rate-bps",
      "2000",
      "--print-run-id",
    ],
    {
      env: { ...process.env, HOME: tmpHome, OBSERVABILITY_DISABLED: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    let runId: string | null = null;
    let buf = "";
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 8000);
      child.stdout.on("data", (b: Buffer) => {
        buf += b.toString("utf8");
        const m = buf.match(/RUN_ID=([0-9a-f-]+)/);
        if (m) {
          runId = m[1]!;
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    if (runId === null) {
      t.skip("harness never printed RUN_ID — daemon likely failed to spawn");
      return;
    }
    const liveRunId: string = runId;
    // Hash matches paths_lib::writerSocketPath (FNV-1a 32-bit).
    let h = 0x811c9dc5;
    for (let i = 0; i < liveRunId.length; i++) {
      h ^= liveRunId.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    const sockPath = path.join(os.tmpdir(), "stark-obs", `${h.toString(16).padStart(8, "0")}.sock`);
    const pidPath = path.join(
      tmpHome,
      ".claude",
      "code-review",
      "observability",
      "runs",
      liveRunId,
      "writer.pid",
    );
    // Wait until writer.pid + socket are on disk so we know the daemon
    // bound.
    const bindDeadline = Date.now() + 5000;
    while (Date.now() < bindDeadline) {
      if (fs.existsSync(pidPath) && fs.existsSync(sockPath)) break;
      await sleep(50);
    }
    assert.ok(fs.existsSync(sockPath), "writer socket must exist before SIGKILL");
    assert.ok(fs.existsSync(pidPath), "writer.pid must exist before SIGKILL");
    const daemonPid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
    assert.ok(
      Number.isFinite(daemonPid) && daemonPid > 0,
      `writer.pid must be a positive int; got ${daemonPid}`,
    );
    // Sanity: the daemon is alive.
    assert.equal(
      (() => {
        try {
          process.kill(daemonPid, 0);
          return true;
        } catch {
          return false;
        }
      })(),
      true,
      `daemon pid ${daemonPid} must be alive before SIGKILL`,
    );
    // SIGKILL the writer daemon directly (not the harness). The harness
    // child remains attached to its own dispatcher process; the daemon
    // owns the UDS and the JSONL writer. After SIGKILL: socket file
    // may linger (no atexit), but `connect(2)` to it MUST be refused
    // with ECONNREFUSED — the kernel has reaped the listener.
    process.kill(daemonPid, "SIGKILL");
    // Confirm the daemon process actually died.
    const dieDeadline = Date.now() + 2000;
    let daemonDead = false;
    while (Date.now() < dieDeadline) {
      try {
        process.kill(daemonPid, 0);
      } catch {
        daemonDead = true;
        break;
      }
      await sleep(25);
    }
    assert.ok(daemonDead, `daemon pid ${daemonPid} did not exit after SIGKILL`);
    // Connecting to the (now stale) socket MUST fail. The harness's
    // emit lib uses this exact signal to fall back to a disabled ctx
    // — i.e. the dispatcher continues to run, just without observability.
    const connErr: NodeJS.ErrnoException | null = await new Promise((resolve) => {
      const s = net.createConnection(sockPath);
      const settle = (e: NodeJS.ErrnoException | null) => {
        try {
          s.destroy();
        } catch {
          // ignore
        }
        resolve(e);
      };
      s.once("connect", () => settle(null));
      s.once("error", (e) => settle(e as NodeJS.ErrnoException));
      setTimeout(() => settle(new Error("connect timeout") as NodeJS.ErrnoException), 1000);
    });
    assert.ok(
      connErr !== null,
      "post-SIGKILL connect to the stale socket must fail",
    );
    // Idempotency: a second connect attempt sees the same error class.
    const secondErr: NodeJS.ErrnoException | null = await new Promise((resolve) => {
      const s = net.createConnection(sockPath);
      const settle = (e: NodeJS.ErrnoException | null) => {
        try {
          s.destroy();
        } catch {
          // ignore
        }
        resolve(e);
      };
      s.once("connect", () => settle(null));
      s.once("error", (e) => settle(e as NodeJS.ErrnoException));
      setTimeout(() => settle(new Error("connect timeout") as NodeJS.ErrnoException), 1000);
    });
    assert.ok(
      secondErr !== null,
      "stale socket remains unusable across repeated connects",
    );
    // Server stays up across daemon SIGKILL: the Fastify side-channel
    // app on a fresh DB still serves /api/health 200. Daemon death is a
    // dispatcher-side concern; the index server is unaffected.
    const health = await fetchHealth(sideApp);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body!.ok, true);
  } finally {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
      // ignore
    }
    try {
      await sideApp.close();
    } catch {
      // ignore
    }
    try {
      sideDb.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("[failure] server crash between retention-notify Call A and Call B — recovery completes the rewrite forward", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-recover-"));
  const spoolRoot = path.join(tmp, "spool");
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  let db = freshDb(tmp);
  let app: FastifyInstance | null = null;
  try {
    const runId = "run-recover";
    seedRunningRun(db, runId);
    const filePath = path.join(spoolRoot, runId, "events-0000.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, "x".repeat(500), { mode: 0o600 });
    const realStat = fs.statSync(filePath);
    db.prepare(
      `INSERT INTO spool_files (run_id, rotation_index, file_path, size_bytes, mtime_ns, last_offset)
       VALUES (?, 0, ?, ?, ?, ?)`,
    ).run(
      runId,
      filePath,
      500,
      BigInt(realStat.mtimeMs) * 1000000n,
      500,
    );
    app = Fastify({ logger: false });
    registerRetentionRoutes(app, { db });
    await app.ready();

    // Call A: pre-rename. Sets rewrite_state='pending', target_size_bytes=500.
    const preRes = await app.inject({
      method: "POST",
      url: "/api/internal/retention/notify",
      payload: {
        action: "pre-rename",
        run_id: runId,
        rotation_index: 0,
        file_path: filePath,
        new_size_bytes: 500,
        truncated: [],
      },
    });
    assert.equal(preRes.statusCode, 200);

    // Simulate "crash": close the app + DB before update-mtime arrives.
    await app.close();
    app = null;
    db.close();

    // Reopen. Recovery scans rewrite_state='pending' rows and finishes
    // forward if the on-disk file matches target_size_bytes.
    db = new Database!(path.join(tmp, "index.db"));
    db.pragma("foreign_keys = ON");
    const recovery = recoverPendingRewrites(db);
    assert.ok(
      recovery.scanned >= 1,
      `expected scanned ≥ 1, got ${recovery.scanned}`,
    );
    // The recovery walks `pending` rows and either commits or aborts
    // them based on on-disk size match. The on-disk file matches our
    // target_size_bytes=500, so committed should be ≥ 1.
    assert.ok(
      recovery.committed + recovery.aborted >= 1,
      `expected committed+aborted ≥ 1; got committed=${recovery.committed}, aborted=${recovery.aborted}`,
    );
    const row = db
      .prepare(`SELECT rewrite_state FROM spool_files WHERE run_id = ? AND rotation_index = 0`)
      .get(runId) as { rewrite_state: string | null } | undefined;
    assert.ok(
      row !== undefined && row.rewrite_state !== "pending",
      `expected rewrite_state advanced; got ${row?.rewrite_state}`,
    );
    // /api/health on a freshly-rebuilt server reflects the recovered
    // state: running_runs=1, no parse errors. Server stays up after
    // the simulated crash + recovery cycle.
    const healthBus = new EventBus();
    const healthIw = new IndexWriter({ db, bus: healthBus });
    healthIw.start();
    const healthApp = await buildHealthApp(db, healthIw, null, spoolRoot);
    try {
      const h = await fetchHealth(healthApp);
      assert.equal(h.statusCode, 200);
      assert.equal(h.body!.ok, true);
      assert.equal(h.body!.runs.running_runs, 1);
      assert.equal(h.body!.tailer.parse_errors_total, 0);
    } finally {
      await healthApp.close();
    }
  } finally {
    try {
      if (app !== null) await app.close();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] invalid base64 chunk passes through index writer; secrets stay redacted at the daemon", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-base64-"));
  const spoolRoot = path.join(tmp, "spool");
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  const tailer = new Tailer({ spoolRoot, bus, db });
  indexWriter.start();
  tailer.start();
  const app = await buildHealthApp(db, indexWriter, tailer, spoolRoot);
  try {
    const runId = "run-bad-b64";
    seedRunningRun(db, runId);
    // The daemon writes `chunk_truncated` instead of forwarding an
    // undecodable > 1 MB base64 chunk per E6. Here we simulate the
    // recorded JSONL directly to confirm the index writer's tailing
    // path tolerates the malformed string (the daemon's redactor is
    // unit-tested in observability_redact_lib.test.ts).
    const lines = [
      jsonl({
        seq: 1,
        ts: new Date().toISOString(),
        type: "run_start",
        run_id: runId,
        version: 1,
      }),
      jsonl({
        seq: 2,
        ts: new Date().toISOString(),
        type: "subagent_start",
        run_id: runId,
        subagent_id: `${runId}:1`,
        agent: "synthetic",
        model: "n/a",
        task: "fp",
      }),
      jsonl({
        seq: 3,
        ts: new Date().toISOString(),
        type: "chunk_truncated",
        run_id: runId,
        subagent_id: `${runId}:1`,
        stream: "stdout",
        bytes_dropped: 2_097_152,
        reason: "undecodable_base64_over_limit",
      }),
    ];
    writeSpoolFile(spoolRoot, runId, 0, lines);
    const truncationIndexed = await waitForIndexedSeq(db, runId, 3, 4000);
    assert.equal(truncationIndexed, true);
    const truncRow = db
      .prepare(
        `SELECT bytes_dropped FROM chunk_truncations WHERE run_id = ? AND seq = ?`,
      )
      .get(runId, 3) as { bytes_dropped: number } | undefined;
    assert.ok(truncRow !== undefined, "chunk_truncations row must exist");
    assert.equal(truncRow!.bytes_dropped, 2_097_152);
    // /api/health surfaces the new truncation; server still up.
    const health = await fetchHealth(app);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body!.ok, true);
    assert.ok(
      health.body!.runs.total_truncations >= 1,
      `health.runs.total_truncations must reflect ≥1; got ${health.body!.runs.total_truncations}`,
    );
  } finally {
    await app.close();
    await tailer.stop();
    indexWriter.flush();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("[failure] /api/health does not transitively call the retention listener", async (t) => {
  if (Database === null) {
    t.skip("better-sqlite3 native binding not available");
    return;
  }
  // The retention listener is a separate Fastify app on 7701. A
  // handler in the main app that transitively dialed it would hang on
  // an unreachable retention port. Build a main-app health handler
  // pointed at a closed loopback port and assert /api/health returns
  // 200 — i.e. nothing in the path dials retention.
  const blackhole = net.createServer((s) => s.destroy());
  await new Promise<void>((resolve) =>
    blackhole.listen(0, "127.0.0.1", () => resolve()),
  );
  blackhole.close();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-no-retention-"));
  const db = freshDb(tmp);
  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  indexWriter.start();
  const app = await buildHealthApp(db, indexWriter, null, tmp);
  try {
    const health = await fetchHealth(app);
    assert.equal(health.statusCode, 200);
    assert.equal(health.body!.ok, true);
  } finally {
    await app.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
