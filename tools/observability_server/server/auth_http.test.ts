// HTTP-level tests for auth routes + middleware. Drives an in-memory
// Fastify; no real listener. Run via:
//   node --experimental-strip-types --test server/auth_http.test.ts

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { AuditWriter } from "./audit.ts";
import { AuthState, registerAuthRoutes } from "./auth.ts";
import {
  registerAuthGate,
  registerHostOriginGuard,
  registerSecurityHeaders,
} from "./middleware.ts";

async function withApp(
  fn: (
    app: import("fastify").FastifyInstance,
    state: AuthState,
    tmpDir: string,
  ) => Promise<void>,
  opts?: { publishedHost?: string; isLan?: boolean; tlsTerminated?: boolean },
): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-http-"));
  const tokenPath = path.join(tmpDir, "bootstrap_token");
  const markerPath = path.join(tmpDir, "last_bootstrap_at");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  fs.writeFileSync(tokenPath, "secret-token-value\n", { mode: 0o600 });
  const audit = new AuditWriter({ filePath: auditPath });
  const state = new AuthState({
    bootstrapTokenPath: tokenPath,
    bootstrapMarkerPath: markerPath,
    publishedHost: opts?.publishedHost ?? "127.0.0.1:7700",
    tlsTerminated: opts?.tlsTerminated ?? false,
    isLan: opts?.isLan ?? false,
    audit,
  });
  const app = Fastify({ logger: false });
  try {
    registerSecurityHeaders(app, {
      publishedHost: state.deps.publishedHost,
      isLan: state.deps.isLan,
      tlsTerminated: state.deps.tlsTerminated,
      auth: state,
    });
    registerHostOriginGuard(app, {
      publishedHost: state.deps.publishedHost,
      isLan: state.deps.isLan,
      tlsTerminated: state.deps.tlsTerminated,
      auth: state,
    });
    registerAuthGate(app, {
      publishedHost: state.deps.publishedHost,
      isLan: state.deps.isLan,
      tlsTerminated: state.deps.tlsTerminated,
      auth: state,
    });
    app.get("/api/health/probe", async () => ({ ok: true }));
    app.get("/api/runs", async () => ({ items: [] }));
    registerAuthRoutes(app, { state });
    await app.ready();
    await fn(app, state, tmpDir);
  } finally {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("probe is reachable without auth", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/probe",
      headers: { host: "127.0.0.1:7700" },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });
});

test("protected route returns 401 without auth", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { host: "127.0.0.1:7700" },
    });
    assert.equal(res.statusCode, 401);
  });
});

test("bootstrap → exchange round-trip sets obs_session cookie + writes marker", async () => {
  await withApp(async (app, _state, tmpDir) => {
    const markerPath = path.join(tmpDir, "last_bootstrap_at");
    assert.equal(fs.existsSync(markerPath), false);
    const boot = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { token: "secret-token-value" },
    });
    assert.equal(boot.statusCode, 200);
    const code = (boot.json() as { code: string }).code;
    assert.equal(typeof code, "string");

    const exchange = await app.inject({
      method: "POST",
      url: "/api/auth/exchange",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { code },
    });
    assert.equal(exchange.statusCode, 204);
    const setCookie = exchange.headers["set-cookie"];
    assert.ok(typeof setCookie === "string" && setCookie.startsWith("obs_session="));
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\//);

    // Marker file MUST exist after a successful exchange.
    assert.equal(fs.existsSync(markerPath), true);
    const markerContent = fs.readFileSync(markerPath, "utf8").trim();
    assert.match(
      markerContent,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // Replay the same code → 401.
    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/exchange",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { code },
    });
    assert.equal(replay.statusCode, 401);
  });
});

test("bootstrap with the wrong token → 401, marker NOT written", async () => {
  await withApp(async (app, _state, tmpDir) => {
    const markerPath = path.join(tmpDir, "last_bootstrap_at");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { token: "wrong" },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(fs.existsSync(markerPath), false);
  });
});

test("session cookie unlocks protected route", async () => {
  await withApp(async (app) => {
    const boot = await app.inject({
      method: "POST",
      url: "/api/auth/bootstrap",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { token: "secret-token-value" },
    });
    const code = (boot.json() as { code: string }).code;
    const exchange = await app.inject({
      method: "POST",
      url: "/api/auth/exchange",
      headers: { host: "127.0.0.1:7700", "content-type": "application/json" },
      payload: { code },
    });
    const setCookie = exchange.headers["set-cookie"] as string;
    const cookie = setCookie.split(";")[0]!;
    const res = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: { host: "127.0.0.1:7700", cookie },
    });
    assert.equal(res.statusCode, 200);
  });
});

test("Bearer bootstrap-token unlocks protected route (script path)", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/runs",
      headers: {
        host: "127.0.0.1:7700",
        authorization: "Bearer secret-token-value",
      },
    });
    assert.equal(res.statusCode, 200);
  });
});

test("host header outside allowlist → 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/probe",
      headers: { host: "evil.example.com" },
    });
    assert.equal(res.statusCode, 400);
  });
});

test("origin header outside allowlist → 400", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/probe",
      headers: { host: "127.0.0.1:7700", origin: "http://evil.example.com" },
    });
    assert.equal(res.statusCode, 400);
  });
});

test("LAN without TLS header refuses cookie on exchange (400 tls_required)", async () => {
  await withApp(
    async (app) => {
      const boot = await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: {
          host: "127.0.0.1:7700",
          "content-type": "application/json",
        },
        payload: { token: "secret-token-value" },
      });
      const code = (boot.json() as { code: string }).code;
      const exchange = await app.inject({
        method: "POST",
        url: "/api/auth/exchange",
        headers: {
          host: "127.0.0.1:7700",
          "content-type": "application/json",
        },
        payload: { code },
      });
      assert.equal(exchange.statusCode, 400);
      const body = exchange.json() as { code?: string };
      assert.equal(body.code, "tls_required");
    },
    {
      publishedHost: "192.168.1.10:7700",
      isLan: true,
      tlsTerminated: true,
    },
  );
});

test("LAN exchange with TLS header sets Secure cookie", async () => {
  await withApp(
    async (app) => {
      const boot = await app.inject({
        method: "POST",
        url: "/api/auth/bootstrap",
        headers: {
          host: "192.168.1.10:7700",
          "content-type": "application/json",
        },
        payload: { token: "secret-token-value" },
      });
      assert.equal(boot.statusCode, 200);
      const code = (boot.json() as { code: string }).code;
      const exchange = await app.inject({
        method: "POST",
        url: "/api/auth/exchange",
        headers: {
          host: "192.168.1.10:7700",
          "content-type": "application/json",
          "x-forwarded-proto": "https",
        },
        payload: { code },
      });
      assert.equal(exchange.statusCode, 204);
      const setCookie = exchange.headers["set-cookie"] as string;
      assert.match(setCookie, /Secure/);
    },
    {
      publishedHost: "192.168.1.10:7700",
      isLan: true,
      tlsTerminated: true,
    },
  );
});

test("security headers attached to every response", async () => {
  await withApp(async (app) => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health/probe",
      headers: { host: "127.0.0.1:7700" },
    });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.match(
      res.headers["content-security-policy"] as string,
      /frame-ancestors 'none'/,
    );
  });
});
