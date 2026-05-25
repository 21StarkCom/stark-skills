/**
 * stark-observability server bootstrap.
 *
 * Phase 4 wiring:
 *
 *   - Phase 1: bind decision, migrations, probe endpoint.
 *   - Phase 3: tailer + event bus + SQLite index writer +
 *     retention listener with two-action notify.
 *   - Phase 4: auth subsystem (bootstrap + exchange) + cookie/Bearer
 *     middleware, full read-side HTTP API, WebSocket hub with
 *     event_offsets + synthetic_events backfill, liveness sweeper
 *     (host_boot_id + parent_pid + daemon_lost + orphan), state-only
 *     retention sweeper, security headers, audit log on `/audit`.
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";

import { runMigrations } from "./db.ts";
import {
  BindRefused,
  isLoopbackPublishedHost,
  resolveBindDecision,
} from "./bind.ts";
import { seedTokens } from "./tokens.ts";
import { EventBus } from "./event_bus.ts";
import { IndexWriter } from "./index_writer.ts";
import { Tailer } from "./tailer.ts";
import { registerRetentionRoutes } from "./http_api.ts";
import { recoverPendingRewrites } from "./rewrite_recovery.ts";
import { AuditWriter } from "./audit.ts";
import { AuthState, registerAuthRoutes } from "./auth.ts";
import {
  buildPruneTokenChecker,
  registerAuthGate,
  registerHostOriginGuard,
  registerSecurityHeaders,
} from "./middleware.ts";
import { registerRunsApi } from "./runs_api.ts";
import { WebSocketHub } from "./websocket_hub.ts";
import { LivenessSweeper } from "./liveness.ts";
import { RetentionSweeper } from "./retention.ts";

const DATA_DIR = process.env.OBSERVABILITY_DATA_DIR ?? "/data";
const DB_PATH = path.join(DATA_DIR, "index.db");
const BOOTSTRAP_MARKER = path.join(DATA_DIR, "last_bootstrap_at");
const BOOTSTRAP_TOKEN = path.join(DATA_DIR, "bootstrap_token");
const PRUNE_TOKEN = path.join(DATA_DIR, "prune_token");
const SPOOL_DIR = process.env.OBSERVABILITY_SPOOL_DIR ?? "/spool/runs";
const HOSTINFO_PATH =
  process.env.OBSERVABILITY_HOSTINFO_PATH ?? "/hostinfo/host.json";
const AUDIT_PATH =
  process.env.OBSERVABILITY_AUDIT_PATH ?? "/audit/audit.jsonl";
const RETENTION_PORT = Number(
  process.env.OBSERVABILITY_RETENTION_PORT ?? "7701",
);
const RETENTION_BIND = process.env.OBSERVABILITY_BIND_RETENTION ?? "0.0.0.0";
const UI_DIR = process.env.OBSERVABILITY_UI_DIR ?? "/app/ui/dist";

export interface BuiltServer {
  app: FastifyInstance;
  retentionApp: FastifyInstance;
  tailer: Tailer;
  indexWriter: IndexWriter;
  bus: EventBus;
  db: Database.Database;
  audit: AuditWriter;
  auth: AuthState;
  liveness: LivenessSweeper;
  retentionSweep: RetentionSweeper;
  wsHub: WebSocketHub;
}

export interface BuildServerOpts {
  dbPath?: string;
  spoolRoot?: string;
  hostInfoPath?: string;
  auditPath?: string;
  publishedHost?: string;
  isLan?: boolean;
  tlsTerminated?: boolean;
  bootstrapTokenPath?: string;
  bootstrapMarkerPath?: string;
  pruneTokenPath?: string;
  uiDir?: string;
}

export async function buildServer(
  opts: BuildServerOpts = {},
): Promise<BuiltServer> {
  const dbPath = opts.dbPath ?? DB_PATH;
  const spoolRoot = opts.spoolRoot ?? SPOOL_DIR;
  const hostInfoPath = opts.hostInfoPath ?? HOSTINFO_PATH;
  const auditPath = opts.auditPath ?? AUDIT_PATH;
  const publishedHost =
    opts.publishedHost ?? process.env.OBSERVABILITY_PUBLISHED_HOST ?? "127.0.0.1:7700";
  const isLan = opts.isLan ?? false;
  const tlsTerminated =
    opts.tlsTerminated ??
    (process.env.OBSERVABILITY_TLS_TERMINATED === "1");
  const bootstrapTokenPath = opts.bootstrapTokenPath ?? BOOTSTRAP_TOKEN;
  const bootstrapMarkerPath = opts.bootstrapMarkerPath ?? BOOTSTRAP_MARKER;
  const pruneTokenPath = opts.pruneTokenPath ?? PRUNE_TOKEN;
  const uiDir = opts.uiDir ?? UI_DIR;

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

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
  const audit = new AuditWriter({ filePath: auditPath });
  const auth = new AuthState({
    bootstrapTokenPath,
    bootstrapMarkerPath,
    publishedHost,
    tlsTerminated,
    isLan,
    audit,
  });
  const liveness = new LivenessSweeper({
    db,
    hostInfoPath,
    audit,
    bus,
  });
  const retentionSweep = new RetentionSweeper({ db, spoolRoot });

  const app = Fastify({
    logger: { level: process.env.OBSERVABILITY_LOG_LEVEL ?? "info" },
    disableRequestLogging: false,
    trustProxy: true,
  });

  await app.register(fastifyRateLimit, {
    global: false,
    max: 240,
    timeWindow: "1 minute",
  });

  registerSecurityHeaders(app, { publishedHost, isLan, tlsTerminated, auth });
  registerHostOriginGuard(app, { publishedHost, isLan, tlsTerminated, auth });
  registerAuthGate(app, { publishedHost, isLan, tlsTerminated, auth });

  app.get("/api/health/probe", async () => ({ ok: true }));

  registerAuthRoutes(app, { state: auth });
  registerRunsApi(app, {
    db,
    spoolRoot,
    bus,
    indexWriterStats: () => indexWriter.getStats(),
    getTailerParseErrors: () => tailer.getParseErrorsTotal(),
    getDurabilityStats: () => readDurabilityStats(DATA_DIR),
  });

  // Static UI shell (Phase 5 builds the React app; Phase 4 just wires
  // the mount so cold-load passes through the auth-exempt list).
  if (fs.existsSync(uiDir)) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: "/",
      decorateReply: false,
      index: "index.html",
    });
  }

  const wsHub = new WebSocketHub({
    db,
    bus,
    auth,
    spoolRoot,
    publishedHost,
    isLan,
    tlsTerminated,
  });
  wsHub.attach(app);

  const retentionApp = Fastify({
    logger: { level: process.env.OBSERVABILITY_LOG_LEVEL ?? "info" },
    disableRequestLogging: false,
  });
  const pruneTokenChecker = buildPruneTokenChecker({
    readPruneToken: () => {
      try {
        return fs.readFileSync(pruneTokenPath, "utf8").trim();
      } catch {
        return null;
      }
    },
  });
  registerRetentionRoutes(retentionApp, {
    db,
    requireBearer: pruneTokenChecker,
    triggerScan: (target) => tailer.scanNow(target),
  });

  return {
    app,
    retentionApp,
    tailer,
    indexWriter,
    bus,
    db,
    audit,
    auth,
    liveness,
    retentionSweep,
    wsHub,
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
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

  const built = await buildServer({
    publishedHost: decision.publishedHost,
    isLan: decision.isLan,
  });
  built.indexWriter.start();
  built.tailer.start();
  built.liveness.start();
  built.retentionSweep.start();

  await built.app.listen({ host: decision.bindHost, port: decision.bindPort });
  built.app.log.info(
    {
      bind: `${decision.bindHost}:${decision.bindPort}`,
      published: decision.publishedHost,
      lan: decision.isLan,
    },
    "stark-observability main listener up",
  );
  built.audit.record(decision.isLan ? "boot.lan.accepted" : "boot.loopback", "success", {
    extra: { bind: `${decision.bindHost}:${decision.bindPort}` },
  });

  // The retention listener carries the prune-token-authenticated
  // `/api/internal/retention/notify` endpoint. Phase 4 Task 1 mandates
  // it is reachable ONLY via host loopback; any non-loopback publish
  // address turns the prune-token into an effectively LAN-reachable
  // privileged surface. The container bind itself is `0.0.0.0:7701`,
  // but the host-side compose publish MUST resolve to loopback. Refuse
  // boot otherwise — there is no operator path that requires LAN
  // publish for the prune listener.
  const retentionPublished =
    process.env.OBSERVABILITY_RETENTION_PUBLISHED_HOST ?? "127.0.0.1:7701";
  if (!isLoopbackPublishedHost(retentionPublished)) {
    process.stderr.write(
      `[server] refused to start retention listener: ` +
        `OBSERVABILITY_RETENTION_PUBLISHED_HOST=${retentionPublished} ` +
        `is not a loopback address. The retention listener accepts the ` +
        `prune token and must be reachable only via host loopback. ` +
        `Unset the override or set it to a 127.0.0.1/::1/localhost host.\n`,
    );
    process.exit(2);
  }

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
      built.liveness.stop();
    } catch {
      // best-effort
    }
    try {
      built.retentionSweep.stop();
    } catch {
      // best-effort
    }
    try {
      built.wsHub.closeAll();
    } catch {
      // best-effort
    }
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

/**
 * RT5 durability block source. The writer daemon writes a small JSON
 * status file to `${DATA_DIR}/durability.json` on each batched
 * group-commit and tier-immediate fsync. Missing / unreadable file →
 * stable zeros + nulls so the surface remains stable for clients.
 */
function readDurabilityStats(dataDir: string): {
  batched_queue_depth: number;
  fsync_p50_ms: number | null;
  fsync_p99_ms: number | null;
  last_fsync_at: string | null;
} {
  try {
    const raw = fs.readFileSync(path.join(dataDir, "durability.json"), "utf8");
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const num = (k: string, def: number): number => {
      const v = obj[k];
      return typeof v === "number" && Number.isFinite(v) ? v : def;
    };
    const numOrNull = (k: string): number | null => {
      const v = obj[k];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const strOrNull = (k: string): string | null => {
      const v = obj[k];
      return typeof v === "string" && v.length > 0 ? v : null;
    };
    return {
      batched_queue_depth: num("batched_queue_depth", 0),
      fsync_p50_ms: numOrNull("fsync_p50_ms"),
      fsync_p99_ms: numOrNull("fsync_p99_ms"),
      last_fsync_at: strOrNull("last_fsync_at"),
    };
  } catch {
    return {
      batched_queue_depth: 0,
      fsync_p50_ms: null,
      fsync_p99_ms: null,
      last_fsync_at: null,
    };
  }
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
