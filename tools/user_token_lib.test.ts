// Tests for `tools/user_token_lib.ts` — GitHub PAT identity resolver
// ported from `scripts/user_token.py`. Keychain access is injected so
// these run without touching the real macOS Keychain.

import { strict as assert } from "node:assert";
import test from "node:test";

import { getUserToken, resolveKind, resolveUser } from "./user_token_lib.ts";

function fakeKeychain(entries: Record<string, string>) {
  return (account: string): string | null => entries[account] ?? null;
}

test("getUserToken: kind=fine returns the fine token", () => {
  const lookup = fakeKeychain({ "primary-fine": "FINE", "primary-classic": "CLA" });
  assert.equal(getUserToken("primary", "fine", lookup), "FINE");
});

test("getUserToken: kind=fine throws when fine token absent", () => {
  const lookup = fakeKeychain({ "primary-classic": "CLA" });
  assert.throws(() => getUserToken("primary", "fine", lookup), /primary-fine not found/);
});

test("getUserToken: kind=classic returns the classic token", () => {
  const lookup = fakeKeychain({ "primary-fine": "FINE", "primary-classic": "CLA" });
  assert.equal(getUserToken("primary", "classic", lookup), "CLA");
});

test("getUserToken: kind=classic throws when classic token absent", () => {
  const lookup = fakeKeychain({ "primary-fine": "FINE" });
  assert.throws(() => getUserToken("primary", "classic", lookup), /primary-classic not found/);
});

test("getUserToken: auto prefers fine for primary", () => {
  const lookup = fakeKeychain({ "primary-fine": "FINE", "primary-classic": "CLA" });
  assert.equal(getUserToken("primary", "auto", lookup), "FINE");
});

test("getUserToken: auto prefers classic for secondary (Checks-API workaround)", () => {
  const lookup = fakeKeychain({
    "secondary-fine": "FINE",
    "secondary-classic": "CLA",
  });
  assert.equal(getUserToken("secondary", "auto", lookup), "CLA");
});

test("getUserToken: auto falls back to fine for secondary when classic absent", () => {
  const lookup = fakeKeychain({ "secondary-fine": "FINE" });
  assert.equal(getUserToken("secondary", "auto", lookup), "FINE");
});

test("getUserToken: auto falls back to classic when only classic present", () => {
  const lookup = fakeKeychain({ "primary-classic": "CLA" });
  assert.equal(getUserToken("primary", "auto", lookup), "CLA");
});

test("getUserToken: auto throws when neither token present", () => {
  const lookup = fakeKeychain({});
  assert.throws(() => getUserToken("primary", "auto", lookup), /neither/);
});

test("resolveUser: CLI flag wins over env", () => {
  assert.equal(resolveUser("secondary", { STARK_GH_USER: "primary" }), "secondary");
});

test("resolveUser: env used when no CLI flag", () => {
  assert.equal(resolveUser(null, { STARK_GH_USER: "secondary" }), "secondary");
});

test("resolveUser: defaults to primary, case-insensitive", () => {
  assert.equal(resolveUser(null, {}), "primary");
  assert.equal(resolveUser("SECONDARY", {}), "secondary");
});

test("resolveUser: rejects invalid identity", () => {
  assert.throws(() => resolveUser("admin", {}), /invalid user/);
});

test("resolveKind: CLI flag wins, env fallback, default auto", () => {
  assert.equal(resolveKind("classic", { STARK_GH_TOKEN_KIND: "fine" }), "classic");
  assert.equal(resolveKind(null, { STARK_GH_TOKEN_KIND: "fine" }), "fine");
  assert.equal(resolveKind(null, {}), "auto");
});

test("resolveKind: rejects invalid kind", () => {
  assert.throws(() => resolveKind("bogus", {}), /invalid kind/);
});
