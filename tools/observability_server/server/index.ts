/**
 * stark-observability server bootstrap.
 *
 * What's wired now (Phase 1 + Phase 3):
 *
 *   - Start-up binding-rules enforcement (main listener).
 *   - SQLite migrations runner against /data/index.db.
 *   - GET /api/health/probe → {"ok": true}.
 *   - JSONL spool tailer + event-bus + SQLite index writer
 *     (Phase 3 Tasks 1, 2, 3, 6, 7).
 *   - Loopback-only retention listener on a SECOND Fastify instance,
 *     hosting POST /api/internal/retention/notify (Phase 3 Task 4).
 *
 * What is intentionally NOT here yet:
 *
 *   - Auth middleware (Phase 4 Task 1) — the retention route accepts
 *     loopback connections without a Bearer in this phase; Phase 4
 *     wires `/data/prune_token` validation through the `requireBearer`
 *     dep.
 *   - The rest of the HTTP API + WebSocket + UI + liveness sweeper.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";

import { runMigrations } from "./db.ts";
import { BindRefused, resolveBindDecision } from "./bind.ts";
import { seedTokens } from "./tokens.ts";
import { EventBus } from "./event_bus.ts";
import { IndexWriter } from "./index_writer.ts";
import { Tailer } from "./tailer.ts";
import { registerRetentionRoutes } from "./http_api.ts";
import { recoverPendingRewrites } from "./rewrite_recovery.ts";

const DATA_DIR = process.env.OBSERVABILITY_DATA_DIR ?? "/data";
const DB_PATH = path.join(DATA_DIR, "index.db");
const BOOTSTRAP_MARKER = path.join(DATA_DIR, "last_bootstrap_at");
const SPOOL_DIR = process.env.OBSERVABILITY_SPOOL_DIR ?? "/spool/runs";
const RETENTION_PORT = Number(
  process.env.OBSERVABILITY_RETENTION_PORT ?? "7701",
);
const RETENTION_BIND = process.env.OBSERVABILITY_BIND_RETENTION ?? "0.0.0.0";

export interface BuiltServer {
  app: FastifyInstance;
  retentionApp: FastifyInstance;
  tailer: Tailer;
  indexWriter: IndexWriter;
  bus: EventBus;
  db: Database.Database;
}

export async function buildServer(opts?: {
  dbPath?: string;
  spoolRoot?: string;
}): Promise<BuiltServer> {
  const dbPath = opts?.dbPath ?? DB_PATH;
  const spoolRoot = opts?.spoolRoot ?? SPOOL_DIR;
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  // RT2: SQLite is the sole rewrite transaction log. On boot, finish
  // any rewrite that was interrupted between pre-rename and update-mtime
  // BEFORE the tailer (which would otherwise honor the rewrite_pending
  // gate forever) and the retention listener come up.
  try {
    recoverPendingRewrites(db);
  } catch (err) {
    process.stderr.write(
      `[server] rewrite recovery failed: ${(err as Error).message}\n`,
    );
  }

  const bus = new EventBus();
  const indexWriter = new IndexWriter({ db, bus });
  const tailer = new Tailer({ spoolRoot, bus, db });

  const app = Fastify({
    logger: { level: process.env.OBSERVABILITY_LOG_LEVEL ?? "info" },
    disableRequestLogging: false,
  });
  app.get("/api/health/probe", async () => ({ ok: true }));

  const retentionApp = Fastify({
    logger: { level: process.env.OBSERVABILITY_LOG_LEVEL ?? "info" },
    disableRequestLogging: false,
  });
  registerRetentionRoutes(retentionApp, {
    db,
    triggerScan: (target) => tailer.scanNow(target),
  });

  return { app, retentionApp, tailer, indexWriter, bus, db };
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  await runMigrations(DB_PATH, path.join(import.meta.dirname, "..", "migrations"));
  const seeded = seedTokens(DATA_DIR);
  if (seeded.generated.length > 0) {
    process.stdout.write(
      "[server] bootstrap required — run: node --experimental-strip-types tools/observability_open.ts\n",
    );
  }

  let decision;
  try {
    decision = resolveBindDecision({
      env: process.env,
      markerExists: fs.existsSync(BOOTSTRAP_MARKER),
      markerPath: BOOTSTRAP_MARKER,
    });
  } catch (err) {
    if (err instanceof BindRefused) {
      process.stderr.write(err.message + "\n");
      process.exit(2);
    }
    throw err;
  }

  const built = await buildServer();
  built.indexWriter.start();
  built.tailer.start();

  await built.app.listen({ host: decision.bindHost, port: decision.bindPort });
  built.app.log.info(
    {
      bind: `${decision.bindHost}:${decision.bindPort}`,
      published: decision.publishedHost,
      lan: decision.isLan,
    },
    "stark-observability main listener up",
  );

  await built.retentionApp.listen({
    host: RETENTION_BIND,
    port: RETENTION_PORT,
  });
  built.retentionApp.log.info(
    {
      bind: `${RETENTION_BIND}:${RETENTION_PORT}`,
      published:
        process.env.OBSERVABILITY_RETENTION_PUBLISHED_HOST ?? "<unset>",
    },
    "stark-observability retention listener up",
  );

  const shutdown = async (sig: string) => {
    built.app.log.info({ sig }, "shutting down");
    try {
      built.indexWriter.flush();
    } catch {
      // best-effort
    }
    try {
      await built.tailer.stop();
    } catch {
      // best-effort
    }
    try {
      await built.app.close();
    } catch {
      // best-effort
    }
    try {
      await built.retentionApp.close();
    } catch {
      // best-effort
    }
    try {
      built.db.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

const isEntry =
  import.meta.url ===
  (process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[server] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
