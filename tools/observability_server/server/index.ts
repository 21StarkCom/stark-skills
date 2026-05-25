/**
 * stark-observability server — Phase 1 skeleton.
 *
 * What's here:
 *   - Start-up binding-rules enforcement (OBSERVABILITY_PUBLISHED_HOST,
 *     OBSERVABILITY_ALLOW_LAN, OBSERVABILITY_TLS_TERMINATED, marker file
 *     present, NO Node host-publish in LAN mode).
 *   - SQLite migrations runner against /data/index.db.
 *   - GET /api/health/probe → {"ok": true}.
 *
 * Everything else (auth, WS, retention listener, prune endpoints, tailer,
 * findings synthesis, etc.) is added by later phases — see the plan.
 *
 * Bind decision tree:
 *   1. Read OBSERVABILITY_BIND (default 0.0.0.0) + OBSERVABILITY_PORT
 *      (default 7700).
 *   2. Require OBSERVABILITY_PUBLISHED_HOST. Refuse to boot if missing.
 *   3. If PUBLISHED_HOST is NOT in the loopback allowlist, require ALL
 *      of: OBSERVABILITY_ALLOW_LAN=1, OBSERVABILITY_TLS_TERMINATED=1,
 *      /data/last_bootstrap_at present. Print the recovery instructions
 *      and exit non-zero otherwise.
 *
 * The container does NOT introspect Compose `ports:` mappings. The
 * required env contract is the only reliable signal.
 */

import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

import { runMigrations } from "./db.ts";
import { BindRefused, resolveBindDecision } from "./bind.ts";
import { seedTokens } from "./tokens.ts";

const DATA_DIR = process.env.OBSERVABILITY_DATA_DIR ?? "/data";
const DB_PATH = path.join(DATA_DIR, "index.db");
const BOOTSTRAP_MARKER = path.join(DATA_DIR, "last_bootstrap_at");

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // Phase 4+ will swap this for a redactor that hashes/strips secrets.
    logger: { level: process.env.OBSERVABILITY_LOG_LEVEL ?? "info" },
    disableRequestLogging: false,
  });

  app.get("/api/health/probe", async () => ({ ok: true }));

  return app;
}

async function main(): Promise<void> {
  // 1. ensure data dir + open DB + run migrations BEFORE we bind a port,
  //    so a schema failure surfaces in `docker logs` instead of as a
  //    crashed liveness probe.
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  await runMigrations(DB_PATH, path.join(import.meta.dirname, "..", "migrations"));

  // 1b. seed scoped secrets on first boot (bootstrap_token, prune_token,
  //     and the /data/token backward-compat symlink). Idempotent — a
  //     re-boot with the named volume preserved is a no-op. The hint we
  //     log is presence-only; values are NEVER written to stdout/stderr.
  const seeded = seedTokens(DATA_DIR);
  if (seeded.generated.length > 0) {
    process.stdout.write(
      "[server] bootstrap required — run: node --experimental-strip-types tools/observability_open.ts\n",
    );
  }

  // 2. validate the binding contract.
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

  // 3. build the app and listen.
  const app = await buildServer();
  await app.listen({ host: decision.bindHost, port: decision.bindPort });
  app.log.info(
    {
      bind: `${decision.bindHost}:${decision.bindPort}`,
      published: decision.publishedHost,
      lan: decision.isLan,
    },
    "stark-observability server listening",
  );

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, "shutting down");
    await app.close();
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
