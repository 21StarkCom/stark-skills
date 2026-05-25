/**
 * Cross-cutting request middleware for the main listener.
 *
 * Three concerns, registered in this order:
 *
 *   1. `Host` / `Origin` allowlist (Phase 4 Task 1). Loopback hosts in
 *      the curated set are always allowed; LAN mode lets the configured
 *      LAN host pass; everything else is 400'd before any handler runs.
 *      `req.socket.remoteAddress` is intentionally NOT consulted —
 *      Docker's userland proxy rewrites it to the gateway address on
 *      every host-to-container call, so a literal-127.0.0.1 check
 *      would reject every legitimate loopback request.
 *   2. Security headers (Phase 4 Task 6) — `X-Content-Type-Options`,
 *      `X-Frame-Options`, `Referrer-Policy`, and a CSP that forbids
 *      framing and constrains `connect-src` to same-origin + `ws:`/
 *      `wss:` upgrades.
 *   3. Cookie / Bearer auth (Phase 4 Task 1) — every route except an
 *      explicit exemption list (probe, bootstrap, exchange, static UI
 *      shell per §1.5.1 E1) requires either `obs_session` or
 *      `Authorization: Bearer <bootstrap_token>`. The Bearer surface is
 *      a fallback for scripts that can't carry cookies; cookie is the
 *      browser path.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";

import {
  AuthState,
  readBearerToken,
  readSessionCookie,
} from "./auth.ts";

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1:7700",
  "::1:7700",
  "localhost:7700",
  "127.0.0.1:7799",
  "::1:7799",
  "localhost:7799",
]);

/** Routes that bypass the cookie/Bearer auth middleware. */
const AUTH_EXEMPT_EXACT = new Set([
  "/api/health/probe",
  "/api/auth/bootstrap",
  "/api/auth/exchange",
  "/",
  "/index.html",
  "/favicon.ico",
]);

/** Path prefixes that bypass the auth middleware (static UI assets). */
const AUTH_EXEMPT_PREFIX = ["/assets/"];

const CSP_VALUE = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join("; ");

export interface MiddlewareDeps {
  /** Resolved `host:port` the server publishes on (drives Host/Origin checks). */
  publishedHost: string;
  /** True iff bound on a non-loopback address (drives Origin-scheme allowance). */
  isLan: boolean;
  /** True iff Caddy is fronting Node with TLS. */
  tlsTerminated: boolean;
  auth: AuthState;
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  _deps: MiddlewareDeps,
): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", CSP_VALUE);
    return payload;
  });
}

export function registerHostOriginGuard(
  app: FastifyInstance,
  deps: MiddlewareDeps,
): void {
  const allowedHosts = buildAllowedHosts(deps);
  const allowedOrigins = buildAllowedOrigins(deps);
  app.addHook("onRequest", async (req, reply) => {
    const host = strHeader(req, "host");
    if (!host || !allowedHosts.has(host.toLowerCase())) {
      await reply
        .code(400)
        .send({ ok: false, code: "bad_host", host: host ?? null });
      return reply;
    }
    const origin = strHeader(req, "origin");
    if (origin !== undefined) {
      const lower = origin.toLowerCase();
      if (!allowedOrigins.has(lower)) {
        await reply.code(400).send({ ok: false, code: "bad_origin", origin });
        return reply;
      }
    }
    return undefined;
  });
}

export function registerAuthGate(
  app: FastifyInstance,
  deps: MiddlewareDeps,
): void {
  app.addHook("onRequest", async (req, reply) => {
    if (isAuthExempt(req.url)) return undefined;
    const sid = readSessionCookie(req);
    if (sid !== null && deps.auth.verifySession(sid)) return undefined;
    const bearer = readBearerToken(req);
    if (bearer !== null) {
      const { ok } = deps.auth.verifyBootstrapToken(bearer);
      if (ok) return undefined;
    }
    await reply.code(401).send({ ok: false, code: "unauthorized" });
    return reply;
  });
}

export function isAuthExempt(url: string): boolean {
  const pathOnly = url.split("?", 1)[0] ?? "";
  if (AUTH_EXEMPT_EXACT.has(pathOnly)) return true;
  for (const p of AUTH_EXEMPT_PREFIX) {
    if (pathOnly.startsWith(p)) return true;
  }
  return false;
}

export type UpgradeRejection = { status: number; reason: string };

/**
 * Defense-in-depth checks for WebSocket upgrades. The `app.server`
 * `upgrade` event fires BEFORE Fastify's `onRequest` hooks, so the
 * regular Host/Origin guard does not run. This helper applies the same
 * Host/Origin allowlist AND, in LAN mode, requires `x-forwarded-proto:
 * https` so plain `ws://` off-loopback is refused (the bind contract
 * requires TLS termination via Caddy in LAN mode).
 */
export function checkUpgradeAllowed(
  headers: Record<string, unknown>,
  deps: MiddlewareDeps,
): UpgradeRejection | null {
  const host = pickHeader(headers, "host");
  const allowedHosts = buildAllowedHosts(deps);
  if (host === undefined || !allowedHosts.has(host.toLowerCase())) {
    return { status: 400, reason: "bad_host" };
  }
  const origin = pickHeader(headers, "origin");
  if (origin !== undefined) {
    const allowedOrigins = buildAllowedOrigins(deps);
    if (!allowedOrigins.has(origin.toLowerCase())) {
      return { status: 400, reason: "bad_origin" };
    }
  }
  if (deps.isLan) {
    const xfp = pickHeader(headers, "x-forwarded-proto") ?? "";
    const tls = xfp.split(",")[0]?.trim() === "https";
    if (!tls || !deps.tlsTerminated) {
      return { status: 400, reason: "tls_required" };
    }
  }
  return null;
}

function pickHeader(
  headers: Record<string, unknown>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

function buildAllowedHosts(deps: MiddlewareDeps): Set<string> {
  const out = new Set<string>();
  out.add(deps.publishedHost.toLowerCase());
  for (const h of LOOPBACK_HOSTS) out.add(h);
  return out;
}

function buildAllowedOrigins(deps: MiddlewareDeps): Set<string> {
  const out = new Set<string>();
  const scheme = deps.isLan && deps.tlsTerminated ? "https" : "http";
  out.add(`${scheme}://${deps.publishedHost.toLowerCase()}`);
  for (const h of LOOPBACK_HOSTS) {
    out.add(`http://${h}`);
    out.add(`https://${h}`);
  }
  return out;
}

function strHeader(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
  return undefined;
}

/**
 * Convenience helper for routes that need to assert auth manually
 * (e.g. WebSocket upgrade). Returns the authenticated session id or
 * Bearer token on success and `null` on failure.
 */
export function authenticateForUpgrade(
  req: FastifyRequest,
  auth: AuthState,
): { kind: "session"; sid: string } | { kind: "bearer" } | null {
  const sid = readSessionCookie(req);
  if (sid !== null && auth.verifySession(sid)) {
    return { kind: "session", sid };
  }
  const bearer = readBearerToken(req);
  if (bearer !== null) {
    const { ok } = auth.verifyBootstrapToken(bearer);
    if (ok) return { kind: "bearer" };
  }
  return null;
}

/**
 * Validate that the `Authorization: Bearer <token>` value on a
 * retention-listener request matches `/data/prune_token`. The retention
 * listener is its own Fastify instance; this is wired in `index.ts`.
 */
export function buildPruneTokenChecker(opts: {
  readPruneToken(): string | null;
}): (req: FastifyRequest) => boolean {
  return (req) => {
    const expected = opts.readPruneToken();
    if (expected === null) return false;
    const posted = readBearerToken(req);
    if (posted === null) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(posted);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    return diff === 0;
  };
}
