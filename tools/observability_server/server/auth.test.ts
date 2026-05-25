// Unit tests for `auth.ts`. Pure auth-state surface — no Fastify
// listener needed. Run via:
//   node --experimental-strip-types --test server/auth.test.ts

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import test from "node:test";

import { AuditWriter } from "./audit.ts";
import { AuthState } from "./auth.ts";

function makeState(opts?: {
  publishedHost?: string;
  tlsTerminated?: boolean;
  isLan?: boolean;
  token?: string;
}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  const tokenPath = path.join(tmpDir, "bootstrap_token");
  const markerPath = path.join(tmpDir, "last_bootstrap_at");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  fs.writeFileSync(tokenPath, (opts?.token ?? "secret-token") + "\n", {
    mode: 0o600,
  });
  const audit = new AuditWriter({ filePath: auditPath });
  const state = new AuthState({
    bootstrapTokenPath: tokenPath,
    bootstrapMarkerPath: markerPath,
    publishedHost: opts?.publishedHost ?? "127.0.0.1:7700",
    tlsTerminated: opts?.tlsTerminated ?? false,
    isLan: opts?.isLan ?? false,
    audit,
  });
  return { state, tmpDir, tokenPath, markerPath, auditPath };
}

test("verifyBootstrapToken matches the on-disk token (constant-time)", () => {
  const { state, tmpDir } = makeState({ token: "alpha-bravo" });
  try {
    assert.equal(state.verifyBootstrapToken("alpha-bravo").ok, true);
    assert.equal(state.verifyBootstrapToken("alpha-brav").ok, false);
    assert.equal(state.verifyBootstrapToken("").ok, false);
    assert.equal(state.verifyBootstrapToken("alpha-bravo ").ok, true); // trims
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("missing token file → verify always returns false", () => {
  const { state, tokenPath, tmpDir } = makeState();
  fs.unlinkSync(tokenPath);
  try {
    assert.equal(state.verifyBootstrapToken("secret-token").ok, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("bootstrap code is single-use and consume marks it replayed", () => {
  const { state, tmpDir } = makeState();
  try {
    const { code } = state.mintBootstrapCode();
    const a = state.consumeBootstrapCode(code);
    assert.equal(a.ok, true);
    const b = state.consumeBootstrapCode(code);
    assert.equal(b.ok, false);
    if (!b.ok) assert.equal(b.reason, "unknown");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("bootstrap code expires after 60 s (deterministic clock)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  const tokenPath = path.join(tmpDir, "bootstrap_token");
  const markerPath = path.join(tmpDir, "last_bootstrap_at");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  fs.writeFileSync(tokenPath, "secret\n", { mode: 0o600 });
  let now = 1_000_000;
  const audit = new AuditWriter({ filePath: auditPath, now: () => now });
  const state = new AuthState({
    bootstrapTokenPath: tokenPath,
    bootstrapMarkerPath: markerPath,
    publishedHost: "127.0.0.1:7700",
    tlsTerminated: false,
    isLan: false,
    audit,
    now: () => now,
  });
  try {
    const { code } = state.mintBootstrapCode();
    now += 60_001;
    const r = state.consumeBootstrapCode(code);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "expired");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("session lifecycle: mint → verify → invalidate", () => {
  const { state, tmpDir } = makeState();
  try {
    state.verifyBootstrapToken("secret-token");
    const { sid } = state.mintSession(state["generation"] as unknown as number);
    assert.equal(state.verifySession(sid), true);
    state.invalidateSession(sid);
    assert.equal(state.verifySession(sid), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeBootstrapMarker writes ISO timestamp at 0600", () => {
  const { state, markerPath, tmpDir } = makeState();
  try {
    state.writeBootstrapMarker();
    const stat = fs.statSync(markerPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const content = fs.readFileSync(markerPath, "utf8").trim();
    assert.match(content, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cookieOptions: loopback always permits, no TLS required", () => {
  const { state, tmpDir } = makeState({ publishedHost: "127.0.0.1:7700" });
  try {
    const opts = state.cookieOptions({
      headers: {},
    } as any);
    assert.deepEqual(opts, { secure: false });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cookieOptions: LAN without TLS header → refused (null)", () => {
  const { state, tmpDir } = makeState({
    publishedHost: "192.168.1.10:7700",
    tlsTerminated: true,
    isLan: true,
  });
  try {
    const opts = state.cookieOptions({ headers: {} } as any);
    assert.equal(opts, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cookieOptions: LAN with TLS header + tlsTerminated → secure cookie", () => {
  const { state, tmpDir } = makeState({
    publishedHost: "192.168.1.10:7700",
    tlsTerminated: true,
    isLan: true,
  });
  try {
    const opts = state.cookieOptions({
      headers: { "x-forwarded-proto": "https" },
    } as any);
    assert.deepEqual(opts, { secure: true });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("token rotation invalidates prior session", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
  const tokenPath = path.join(tmpDir, "bootstrap_token");
  const markerPath = path.join(tmpDir, "last_bootstrap_at");
  const auditPath = path.join(tmpDir, "audit.jsonl");
  fs.writeFileSync(tokenPath, "first\n", { mode: 0o600 });
  const audit = new AuditWriter({ filePath: auditPath });
  const state = new AuthState({
    bootstrapTokenPath: tokenPath,
    bootstrapMarkerPath: markerPath,
    publishedHost: "127.0.0.1:7700",
    tlsTerminated: false,
    isLan: false,
    audit,
  });
  try {
    const { generation } = state.verifyBootstrapToken("first");
    const { sid } = state.mintSession(generation);
    assert.equal(state.verifySession(sid), true);
    // Rotate token — write new content, force a stat mismatch by
    // touching the file with a future mtime.
    fs.writeFileSync(tokenPath, "second\n", { mode: 0o600 });
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(tokenPath, future, future);
    state.verifyBootstrapToken("second");
    assert.equal(state.verifySession(sid), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AuditWriter appends one JSONL line per call, 0600 mode", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  const filePath = path.join(tmpDir, "audit.jsonl");
  const w = new AuditWriter({ filePath, now: () => 1_700_000_000_000 });
  try {
    w.record("auth.bootstrap.attempt", "success", {
      host_meta: { remote: "127.0.0.1", host: "127.0.0.1:7700" },
    });
    w.record("auth.exchange.success", "success", {
      credential_kind: "session_cookie",
      generation: 1,
    });
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.action, "auth.bootstrap.attempt");
    assert.equal(first.result, "success");
    assert.match(first.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const second = JSON.parse(lines[1]!);
    assert.equal(second.action, "auth.exchange.success");
    const stat = fs.statSync(filePath);
    assert.equal(stat.mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("AuditWriter never carries raw token/code keys (sanitizer drops forbidden)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  const filePath = path.join(tmpDir, "audit.jsonl");
  const w = new AuditWriter({ filePath });
  try {
    w.record("auth.exchange.failure", "failure", {
      extra: {
        token: "ghp_super_secret",
        code: "1234",
        session: "xyz",
        ok_field: "yes",
      },
    });
    const line = fs.readFileSync(filePath, "utf8").trim();
    assert.equal(line.includes("ghp_super_secret"), false);
    assert.equal(line.includes("token"), false);
    const parsed = JSON.parse(line);
    assert.equal(parsed.extra.ok_field, "yes");
    assert.equal(parsed.extra.token, undefined);
    assert.equal(parsed.extra.code, undefined);
    assert.equal(parsed.extra.session, undefined);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Cookie / Bearer parser smoke tests
import { readBearerToken, readSessionCookie } from "./auth.ts";

test("readSessionCookie parses obs_session", () => {
  const sid = readSessionCookie({
    headers: { cookie: "foo=bar; obs_session=abc123; other=x" },
  } as any);
  assert.equal(sid, "abc123");
});

test("readBearerToken parses standard header", () => {
  const t = readBearerToken({
    headers: { authorization: "Bearer my-token-value" },
  } as any);
  assert.equal(t, "my-token-value");
});

test("Buffer import is wired (sanity for base64url usage)", () => {
  assert.equal(Buffer.from("hello", "utf8").toString("base64url"), "aGVsbG8");
});
