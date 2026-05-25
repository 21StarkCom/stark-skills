// Unit tests for `middleware.ts`. Exercises auth-exemption rules and
// the prune-token Bearer checker. Run via:
//   node --experimental-strip-types --test server/middleware.test.ts

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  buildPruneTokenChecker,
  isAuthExempt,
} from "./middleware.ts";

test("E1 — static UI shell is auth-exempt", () => {
  assert.equal(isAuthExempt("/"), true);
  assert.equal(isAuthExempt("/index.html"), true);
  assert.equal(isAuthExempt("/assets/index.abc.js"), true);
  assert.equal(isAuthExempt("/assets/style.css"), true);
});

test("probe + auth bootstrap + exchange are auth-exempt", () => {
  assert.equal(isAuthExempt("/api/health/probe"), true);
  assert.equal(isAuthExempt("/api/auth/bootstrap"), true);
  assert.equal(isAuthExempt("/api/auth/exchange"), true);
});

test("protected API surface is NOT auth-exempt", () => {
  assert.equal(isAuthExempt("/api/runs"), false);
  assert.equal(isAuthExempt("/api/runs?limit=10"), false);
  assert.equal(isAuthExempt("/api/health"), false);
  assert.equal(isAuthExempt("/ws"), false);
  assert.equal(isAuthExempt("/api/internal/retention/notify"), false);
});

test("prune-token checker accepts matching Bearer, rejects mismatch", () => {
  const check = buildPruneTokenChecker({
    readPruneToken: () => "expected-prune-token",
  });
  assert.equal(
    check({ headers: { authorization: "Bearer expected-prune-token" } } as any),
    true,
  );
  assert.equal(
    check({ headers: { authorization: "Bearer wrong-token" } } as any),
    false,
  );
  assert.equal(check({ headers: {} } as any), false);
  assert.equal(
    check({ headers: { authorization: "Basic xyz" } } as any),
    false,
  );
});

test("prune-token checker yields false when the token file is missing", () => {
  const check = buildPruneTokenChecker({ readPruneToken: () => null });
  assert.equal(
    check({ headers: { authorization: "Bearer anything" } } as any),
    false,
  );
});
