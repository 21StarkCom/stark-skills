/**
 * Auth subsystem for the main listener (Phase 4 Task 1).
 *
 * Surfaces:
 *
 *   - `POST /api/auth/bootstrap` — body `{ token }`. Validates the
 *     posted token against `/data/bootstrap_token` (constant-time).
 *     On success, mints a one-time bootstrap code (60 s TTL) and
 *     returns `{ code }`. Does NOT write the `last_bootstrap_at`
 *     marker — only a successful `exchange` may do that.
 *   - `POST /api/auth/exchange` — body `{ code }`. Validates and
 *     consumes the code (single-use). Mints a 24 h session id and
 *     sets the `obs_session` cookie (`HttpOnly; SameSite=Strict;
 *     Path=/`; `Secure` when off-loopback). Atomically writes the
 *     `/data/last_bootstrap_at` marker so future LAN binds are
 *     authorized. Returns 204.
 *
 * Auth state is in-memory and process-local:
 *   - `bootstrapCodes: Map<code, { expiresAtMs }>` — single-use.
 *   - `sessions: Map<sid, { expiresAtMs }>` — TTL-bounded.
 *   Both maps are swept lazily on every read so a quiet process
 *   doesn't grow unbounded under bursty bootstrap attempts.
 *
 * The TLS-terminated LAN cookie path refuses to set the cookie on a
 * non-TLS off-loopback request. The detector reads
 * `OBSERVABILITY_TLS_TERMINATED=1` AND the `X-Forwarded-Proto: https`
 * header (Caddy in front of Node). When both are present, the cookie
 * carries `Secure`. When neither is present and the publish address is
 * non-loopback, the cookie is refused.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import type { AuditWriter } from "./audit.ts";

export const SESSION_COOKIE = "obs_session";
const BOOTSTRAP_TOKEN_BYTES = 32;
const SESSION_ID_BYTES = 32;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const BOOTSTRAP_CODE_TTL_MS = 60 * 1000;
const SESSION_GC_MAX_BATCH = 64;

interface CodeEntry {
  expiresAtMs: number;
  /** Bootstrap-token generation that minted the code (rotation-tagged). */
  generation: number;
}

interface SessionEntry {
  expiresAtMs: number;
  /** Bootstrap-token generation that minted the session (rotation-tagged). */
  generation: number;
}

export interface AuthStateDeps {
  /** Filesystem path to `/data/bootstrap_token`. */
  bootstrapTokenPath: string;
  /** Filesystem path to `/data/last_bootstrap_at`. */
  bootstrapMarkerPath: string;
  /** Resolved publish address (host:port). Drives loopback detection. */
  publishedHost: string;
  /** True iff Caddy is fronting Node with TLS (`OBSERVABILITY_TLS_TERMINATED=1`). */
  tlsTerminated: boolean;
  /** True iff the server is configured for LAN mode. */
  isLan: boolean;
  /** Audit writer (Phase 4 Task 7). All auth events fan out here. */
  audit: AuditWriter;
  /** Test seam — let tests inject a clock. */
  now?: () => number;
  /** Test seam — let tests inject the RNG. */
  randomBytes?: (size: number) => Buffer;
}

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1:7700",
  "::1:7700",
  "localhost:7700",
  "127.0.0.1:7799",
  "::1:7799",
  "localhost:7799",
]);

export class AuthState {
  readonly deps: AuthStateDeps;
  private readonly now: () => number;
  private readonly rng: (size: number) => Buffer;
  private readonly codes = new Map<string, CodeEntry>();
  private readonly sessions = new Map<string, SessionEntry>();
  private generation = 0;
  private cachedTokenDigest: Buffer | null = null;
  private cachedTokenStat: { mtimeMs: number; size: number } | null = null;

  constructor(deps: AuthStateDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.rng = deps.randomBytes ?? crypto.randomBytes;
  }

  private resolveTokenDigest(): Buffer | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.deps.bootstrapTokenPath);
    } catch {
      this.cachedTokenDigest = null;
      this.cachedTokenStat = null;
      return null;
    }
    const cached = this.cachedTokenStat;
    if (
      this.cachedTokenDigest !== null &&
      cached !== null &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size
    ) {
      return this.cachedTokenDigest;
    }
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.deps.bootstrapTokenPath);
    } catch {
      this.cachedTokenDigest = null;
      this.cachedTokenStat = null;
      return null;
    }
    const trimmed = raw.toString("utf8").trim();
    this.cachedTokenDigest = crypto.createHash("sha256").update(trimmed).digest();
    this.cachedTokenStat = { mtimeMs: st.mtimeMs, size: st.size };
    this.generation += 1;
    return this.cachedTokenDigest;
  }

  verifyBootstrapToken(posted: string): { ok: boolean; generation: number } {
    const digest = this.resolveTokenDigest();
    const generation = this.generation;
    if (digest === null) return { ok: false, generation };
    const trimmed = typeof posted === "string" ? posted.trim() : "";
    if (trimmed.length === 0 || trimmed.length > 256) {
      return { ok: false, generation };
    }
    const postedDigest = crypto.createHash("sha256").update(trimmed).digest();
    const ok =
      postedDigest.length === digest.length &&
      crypto.timingSafeEqual(postedDigest, digest);
    return { ok, generation };
  }

  mintBootstrapCode(): { code: string; expiresAtMs: number } {
    this.sweepCodes();
    const code = this.rng(BOOTSTRAP_TOKEN_BYTES).toString("base64url");
    const expiresAtMs = this.now() + BOOTSTRAP_CODE_TTL_MS;
    this.codes.set(code, { expiresAtMs, generation: this.generation });
    return { code, expiresAtMs };
  }

  consumeBootstrapCode(
    posted: unknown,
  ):
    | { ok: true; generation: number }
    | { ok: false; reason: "expired" | "replayed" | "unknown" } {
    if (typeof posted !== "string" || posted.length === 0) {
      return { ok: false, reason: "unknown" };
    }
    const entry = this.codes.get(posted);
    if (entry === undefined) {
      return { ok: false, reason: "unknown" };
    }
    this.codes.delete(posted);
    if (entry.expiresAtMs <= this.now()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, generation: entry.generation };
  }

  mintSession(generation: number): {
    sid: string;
    expiresAtMs: number;
  } {
    this.sweepSessions();
    const sid = this.rng(SESSION_ID_BYTES).toString("base64url");
    const expiresAtMs = this.now() + SESSION_TTL_MS;
    this.sessions.set(sid, { expiresAtMs, generation });
    return { sid, expiresAtMs };
  }

  verifySession(sid: unknown): boolean {
    if (typeof sid !== "string" || sid.length === 0) return false;
    const entry = this.sessions.get(sid);
    if (entry === undefined) return false;
    if (entry.expiresAtMs <= this.now()) {
      this.sessions.delete(sid);
      return false;
    }
    if (entry.generation !== this.generation) {
      this.sessions.delete(sid);
      return false;
    }
    return true;
  }

  invalidateSession(sid: string): void {
    this.sessions.delete(sid);
  }

  writeBootstrapMarker(): void {
    const tmp = this.deps.bootstrapMarkerPath + ".tmp";
    const dir = path.dirname(this.deps.bootstrapMarkerPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ts = new Date(this.now()).toISOString();
    fs.writeFileSync(tmp, ts + "\n", { mode: 0o600, flag: "w" });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.deps.bootstrapMarkerPath);
    fs.chmodSync(this.deps.bootstrapMarkerPath, 0o600);
  }

  isLoopback(): boolean {
    return LOOPBACK_HOSTS.has(this.deps.publishedHost);
  }

  cookieOptions(req: FastifyRequest): { secure: boolean } | null {
    const loopback = this.isLoopback();
    if (loopback) return { secure: false };
    const xfp =
      typeof req.headers["x-forwarded-proto"] === "string"
        ? (req.headers["x-forwarded-proto"] as string)
        : "";
    const tlsHeader = xfp.split(",")[0]?.trim() === "https";
    if (tlsHeader && this.deps.tlsTerminated) return { secure: true };
    return null;
  }

  private sweepCodes(): void {
    if (this.codes.size === 0) return;
    const now = this.now();
    let removed = 0;
    for (const [k, v] of this.codes) {
      if (v.expiresAtMs <= now) {
        this.codes.delete(k);
        removed += 1;
        if (removed >= SESSION_GC_MAX_BATCH) break;
      }
    }
  }

  private sweepSessions(): void {
    if (this.sessions.size === 0) return;
    const now = this.now();
    let removed = 0;
    for (const [k, v] of this.sessions) {
      if (v.expiresAtMs <= now) {
        this.sessions.delete(k);
        removed += 1;
        if (removed >= SESSION_GC_MAX_BATCH) break;
      }
    }
  }
}

export interface AuthRouteDeps {
  state: AuthState;
}

const RATE_LIMIT_OPTS = { max: 10, timeWindow: "1 minute" } as const;

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): void {
  const { state } = deps;
  app.post(
    "/api/auth/bootstrap",
    { config: { rateLimit: RATE_LIMIT_OPTS } },
    async (req, reply) => handleBootstrap(state, req, reply),
  );
  app.post(
    "/api/auth/exchange",
    { config: { rateLimit: RATE_LIMIT_OPTS } },
    async (req, reply) => handleExchange(state, req, reply),
  );
}

async function handleBootstrap(
  state: AuthState,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const audit = state.deps.audit;
  const host = strHeader(req, "host");
  const origin = strHeader(req, "origin");
  audit.record("auth.bootstrap.attempt", "success", {
    host_meta: { host, origin, remote: req.ip },
  });
  const body = req.body as { token?: unknown } | undefined;
  const posted = typeof body?.token === "string" ? body.token : "";
  const { ok, generation } = state.verifyBootstrapToken(posted);
  if (!ok) {
    audit.record("auth.bootstrap.failure", "failure", {
      reason_code: "bad_token",
      generation,
      host_meta: { host, origin, remote: req.ip },
    });
    await reply.code(401).send({ ok: false, code: "unauthorized" });
    return;
  }
  const { code } = state.mintBootstrapCode();
  audit.record("auth.bootstrap.success", "success", {
    generation,
    credential_kind: "bootstrap_token",
    host_meta: { host, origin, remote: req.ip },
  });
  await reply.code(200).send({ code });
}

async function handleExchange(
  state: AuthState,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const audit = state.deps.audit;
  const host = strHeader(req, "host");
  const origin = strHeader(req, "origin");
  const body = req.body as { code?: unknown } | undefined;
  const consume = state.consumeBootstrapCode(body?.code);
  if (!consume.ok) {
    const reason = consume.reason;
    const action =
      reason === "expired"
        ? "auth.exchange.code_expired"
        : reason === "replayed"
          ? "auth.exchange.code_replayed"
          : "auth.exchange.failure";
    audit.record(action, "failure", {
      reason_code: reason,
      host_meta: { host, origin, remote: req.ip },
    });
    await reply.code(401).send({ ok: false, code: "unauthorized" });
    return;
  }
  const opts = state.cookieOptions(req);
  if (opts === null) {
    audit.record("auth.exchange.failure", "failure", {
      reason_code: "tls_required",
      generation: consume.generation,
      host_meta: { host, origin, remote: req.ip },
    });
    await reply.code(400).send({
      ok: false,
      code: "tls_required",
      message:
        "non-loopback bind requires TLS termination — front the listener " +
        "with the mkcert reverse-proxy described in tools/observability_server/README.md",
    });
    return;
  }
  const { sid } = state.mintSession(consume.generation);
  const cookieValue = serializeSessionCookie(sid, opts.secure);
  state.writeBootstrapMarker();
  audit.record("auth.exchange.success", "success", {
    generation: consume.generation,
    credential_kind: "session_cookie",
    host_meta: { host, origin, remote: req.ip },
  });
  reply.header("Set-Cookie", cookieValue);
  await reply.code(204).send();
}

function serializeSessionCookie(sid: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${sid}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_TTL_MS / 1000}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function strHeader(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

export function readSessionCookie(req: FastifyRequest): string | null {
  const raw = strHeader(req, "cookie");
  if (!raw) return null;
  const parts = raw.split(";");
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed.startsWith(SESSION_COOKIE + "=")) continue;
    const v = trimmed.slice(SESSION_COOKIE.length + 1);
    return v.length > 0 ? v : null;
  }
  return null;
}

export function readBearerToken(req: FastifyRequest): string | null {
  const raw = strHeader(req, "authorization");
  if (!raw) return null;
  const m = /^Bearer\s+(\S+)$/.exec(raw.trim());
  return m ? (m[1] ?? null) : null;
}
