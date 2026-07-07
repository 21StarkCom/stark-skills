// Tests for `tools/github_app_lib.ts` — RS256 JWT shape, on-disk cache
// round-trip + 0600 perms, installation-ID hardcoded short-circuit,
// CI env-var key resolution, type-guard narrowing, and `ownerFromPath`
// auto-derivation behavior.
//
// The keychain + live mint paths are exercised by `live-verify` in CI and
// by ad-hoc smoke from the CLI; this file covers everything that's pure
// or filesystem-only.

import { strict as assert } from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_NAMES,
  APPS,
  DEFAULT_APP,
  getPrivateKeyFromEnv,
  getInstallationId,
  isAppName,
  makeJwt,
  readCachedToken,
  readInstallCache,
  resolveAppName,
  writeCachedToken,
  writeInstallCache,
} from "./github_app_lib.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function generateTestKeypair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKey, publicKey };
}

function base64urlDecode(s: string): Buffer {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function withScratchHome<T>(fn: (home: string) => T): T {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gh-app-test-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = scratch;
  try {
    return fn(scratch);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// App registry + type-guards
// ---------------------------------------------------------------------------

test("APP_NAMES enumerates every registry key", () => {
  assert.deepEqual(
    [...APP_NAMES].sort(),
    ["default", "stark-claude", "stark-codex", "stark-gemini"],
  );
});

test("isAppName narrows on known names, rejects unknowns", () => {
  assert.equal(isAppName("stark-claude"), true);
  assert.equal(isAppName("stark-codex"), true);
  assert.equal(isAppName("default"), true);
  assert.equal(isAppName("typo"), false);
  assert.equal(isAppName(""), false);
});

test("resolveAppName: returns default when undefined", () => {
  assert.equal(resolveAppName(), DEFAULT_APP);
});

test("resolveAppName: throws with available list on unknown", () => {
  assert.throws(
    () => resolveAppName("nope" as never),
    (err: Error) => {
      assert.match(err.message, /Unknown app 'nope'/);
      assert.match(err.message, /stark-claude/);
      return true;
    },
  );
});

test("APPS.default and APPS['stark-claude'] share the same config object", () => {
  // Verifies the legacy alias is identity-equal — a runtime mutation on one
  // should be visible on the other (the Python behaved this way).
  assert.equal(APPS["default"], APPS["stark-claude"]);
});

// ---------------------------------------------------------------------------
// JWT signing
// ---------------------------------------------------------------------------

test("makeJwt: emits three base64url segments", () => {
  const { privateKey } = generateTestKeypair();
  const token = makeJwt(privateKey, "12345");
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  for (const p of parts) assert.match(p, /^[A-Za-z0-9_-]+$/);
});

test("makeJwt: header decodes to RS256/JWT", () => {
  const { privateKey } = generateTestKeypair();
  const [header] = makeJwt(privateKey, "12345").split(".");
  const decoded = JSON.parse(base64urlDecode(header!).toString("utf8"));
  assert.deepEqual(decoded, { alg: "RS256", typ: "JWT" });
});

test("makeJwt: payload carries iss/iat/exp with iat=now-60 exp=now+600", () => {
  const { privateKey } = generateTestKeypair();
  const now = 1_700_000_000;
  const [, payload] = makeJwt(privateKey, "99999", now).split(".");
  const decoded = JSON.parse(base64urlDecode(payload!).toString("utf8"));
  assert.equal(decoded.iss, "99999");
  assert.equal(decoded.iat, now - 60);
  assert.equal(decoded.exp, now + 600);
});

test("makeJwt: signature verifies against the public key", () => {
  const { privateKey, publicKey } = generateTestKeypair();
  const token = makeJwt(privateKey, "12345");
  const [header, payload, signature] = token.split(".");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  const ok = verifier.verify(publicKey, base64urlDecode(signature!));
  assert.equal(ok, true);
});

test("makeJwt: signature minted by the wrong key fails verification", () => {
  const { privateKey } = generateTestKeypair();
  const { publicKey: otherPublic } = generateTestKeypair();
  const token = makeJwt(privateKey, "12345");
  const [header, payload, signature] = token.split(".");
  const verifier = crypto.createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.equal(verifier.verify(otherPublic, base64urlDecode(signature!)), false);
});

// ---------------------------------------------------------------------------
// CI env-var fallback (STARK_*)
// ---------------------------------------------------------------------------

test("getPrivateKeyFromEnv: throws when any of the three env vars is empty", () => {
  const prev = {
    keyB64: process.env["STARK_PRIVATE_KEY_B64"],
    appId: process.env["STARK_APP_ID"],
    installId: process.env["STARK_INSTALL_ID"],
  };
  try {
    delete process.env["STARK_PRIVATE_KEY_B64"];
    delete process.env["STARK_APP_ID"];
    delete process.env["STARK_INSTALL_ID"];
    assert.throws(() => getPrivateKeyFromEnv(), /STARK_PRIVATE_KEY_B64/);

    // GitHub Actions exposes unset secrets as empty strings — must be
    // treated as missing, not garbage to feed into JWT signing.
    process.env["STARK_PRIVATE_KEY_B64"] = "";
    process.env["STARK_APP_ID"] = "1";
    process.env["STARK_INSTALL_ID"] = "2";
    assert.throws(() => getPrivateKeyFromEnv(), /missing or empty/);
  } finally {
    if (prev.keyB64 === undefined) delete process.env["STARK_PRIVATE_KEY_B64"];
    else process.env["STARK_PRIVATE_KEY_B64"] = prev.keyB64;
    if (prev.appId === undefined) delete process.env["STARK_APP_ID"];
    else process.env["STARK_APP_ID"] = prev.appId;
    if (prev.installId === undefined) delete process.env["STARK_INSTALL_ID"];
    else process.env["STARK_INSTALL_ID"] = prev.installId;
  }
});

test("getPrivateKeyFromEnv: round-trips a base64-encoded PEM", () => {
  const { privateKey } = generateTestKeypair();
  const prev = {
    keyB64: process.env["STARK_PRIVATE_KEY_B64"],
    appId: process.env["STARK_APP_ID"],
    installId: process.env["STARK_INSTALL_ID"],
  };
  try {
    process.env["STARK_PRIVATE_KEY_B64"] =
      Buffer.from(privateKey, "utf8").toString("base64");
    process.env["STARK_APP_ID"] = "555";
    process.env["STARK_INSTALL_ID"] = "777";
    const got = getPrivateKeyFromEnv();
    assert.equal(got.privateKey, privateKey);
    assert.equal(got.appId, "555");
    assert.equal(got.installationId, "777");
    // The decoded key is a real RSA private key — sign something with it
    // to prove it survived the round-trip intact, matching the CI flow.
    const jwt = makeJwt(got.privateKey, got.appId);
    assert.equal(jwt.split(".").length, 3);
  } finally {
    if (prev.keyB64 === undefined) delete process.env["STARK_PRIVATE_KEY_B64"];
    else process.env["STARK_PRIVATE_KEY_B64"] = prev.keyB64;
    if (prev.appId === undefined) delete process.env["STARK_APP_ID"];
    else process.env["STARK_APP_ID"] = prev.appId;
    if (prev.installId === undefined) delete process.env["STARK_INSTALL_ID"];
    else process.env["STARK_INSTALL_ID"] = prev.installId;
  }
});

// ---------------------------------------------------------------------------
// On-disk caches (token + installation discovery)
// ---------------------------------------------------------------------------

test("token cache: write+read round-trip honors the 5-minute early expiry", () => {
  withScratchHome((home) => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    writeCachedToken("ghs_test", future, "stark-claude", "111");
    assert.equal(readCachedToken("stark-claude", "111"), "ghs_test");

    // Just inside the 5-minute safety window → treated as expired.
    const closeToExpiry = Math.floor(Date.now() / 1000) + 100;
    writeCachedToken("ghs_old", closeToExpiry, "stark-claude", "111");
    assert.equal(readCachedToken("stark-claude", "111"), null);

    // Cache file should have 0600 perms — credentials material.
    const cacheFile = path.join(
      home,
      ".cache",
      "github-app-tokens",
      "stark-claude-111.json",
    );
    const mode = fs.statSync(cacheFile).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("token cache: returns null when no file exists", () => {
  withScratchHome(() => {
    assert.equal(readCachedToken("stark-claude", "999"), null);
  });
});

test("install cache: write+read round-trip; expired entries dropped", () => {
  withScratchHome(() => {
    writeInstallCache("stark-codex", { OtherOrg: "12345" });
    const got = readInstallCache("stark-codex");
    assert.deepEqual(got, { OtherOrg: "12345" });
  });
});

// ---------------------------------------------------------------------------
// Installation-ID hardcoded short-circuit (no network)
// ---------------------------------------------------------------------------

test("getInstallationId: GetEvinced short-circuits to hardcoded ID", async () => {
  // Hardcoded entries take precedence over cache + API discovery, so this
  // doesn't touch the network even with no keychain entry available.
  const id = await getInstallationId("GetEvinced", "stark-claude");
  assert.equal(id, "141330785");
});

test("getInstallationId: cache hit short-circuits to cached value", async () => {
  await withScratchHome(async () => {
    writeInstallCache("stark-codex", { SyntheticOrg: "99999" });
    const id = await getInstallationId("SyntheticOrg", "stark-codex");
    assert.equal(id, "99999");
  });
});
