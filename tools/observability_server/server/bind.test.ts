// Unit tests for `bind.ts`. Pure logic — no Fastify, no SQLite.
//
// Runnable from inside `tools/observability_server/` via:
//   node --experimental-strip-types --test server/bind.test.ts

import { strict as assert } from "node:assert";
import test from "node:test";

import { BindRefused, resolveBindDecision } from "./bind.ts";

const MARKER = "/data/last_bootstrap_at";

function inputs(env: Record<string, string>, markerExists = false) {
  return { env, markerExists, markerPath: MARKER };
}

test("loopback publish is accepted with default port", () => {
  const d = resolveBindDecision(
    inputs({ OBSERVABILITY_PUBLISHED_HOST: "127.0.0.1:7700" }),
  );
  assert.equal(d.bindHost, "0.0.0.0");
  assert.equal(d.bindPort, 7700);
  assert.equal(d.publishedHost, "127.0.0.1:7700");
  assert.equal(d.isLan, false);
});

test("loopback over container-internal LAN port (7799) is accepted", () => {
  const d = resolveBindDecision(
    inputs({
      OBSERVABILITY_PUBLISHED_HOST: "127.0.0.1:7799",
      OBSERVABILITY_PORT: "7799",
    }),
  );
  assert.equal(d.bindPort, 7799);
  assert.equal(d.isLan, false);
});

test("missing OBSERVABILITY_PUBLISHED_HOST refuses with explainer", () => {
  assert.throws(
    () => resolveBindDecision(inputs({})),
    (err: Error) =>
      err instanceof BindRefused &&
      /OBSERVABILITY_PUBLISHED_HOST is required/.test(err.message),
  );
});

test("invalid OBSERVABILITY_PORT refuses", () => {
  assert.throws(
    () =>
      resolveBindDecision(
        inputs({
          OBSERVABILITY_PUBLISHED_HOST: "127.0.0.1:7700",
          OBSERVABILITY_PORT: "abc",
        }),
      ),
    (err: Error) => err instanceof BindRefused && /OBSERVABILITY_PORT/.test(err.message),
  );
  assert.throws(() =>
    resolveBindDecision(
      inputs({
        OBSERVABILITY_PUBLISHED_HOST: "127.0.0.1:7700",
        OBSERVABILITY_PORT: "99999",
      }),
    ),
  );
});

test("non-loopback publish with NO allow/tls/marker refuses with all three reasons", () => {
  let captured: Error | undefined;
  try {
    resolveBindDecision(
      inputs({ OBSERVABILITY_PUBLISHED_HOST: "192.168.1.42:7700" }, false),
    );
  } catch (err) {
    captured = err as Error;
  }
  assert.ok(captured instanceof BindRefused);
  const msg = captured!.message;
  assert.match(msg, /OBSERVABILITY_ALLOW_LAN=1 missing/);
  assert.match(msg, /OBSERVABILITY_TLS_TERMINATED=1 missing/);
  assert.match(msg, /\/data\/last_bootstrap_at not present/);
  assert.match(msg, /Required steps:/);
});

test("non-loopback publish with allow + tls but no marker refuses", () => {
  assert.throws(
    () =>
      resolveBindDecision(
        inputs(
          {
            OBSERVABILITY_PUBLISHED_HOST: "192.168.1.42:7700",
            OBSERVABILITY_ALLOW_LAN: "1",
            OBSERVABILITY_TLS_TERMINATED: "1",
          },
          false,
        ),
      ),
    (err: Error) =>
      err instanceof BindRefused &&
      /last_bootstrap_at not present/.test(err.message),
  );
});

test("non-loopback publish with all three gates passes (LAN-bootstrapped)", () => {
  const d = resolveBindDecision(
    inputs(
      {
        OBSERVABILITY_PUBLISHED_HOST: "192.168.1.42:7700",
        OBSERVABILITY_ALLOW_LAN: "1",
        OBSERVABILITY_TLS_TERMINATED: "1",
        OBSERVABILITY_PORT: "7799",
      },
      true,
    ),
  );
  assert.equal(d.isLan, true);
  assert.equal(d.bindPort, 7799);
  assert.equal(d.publishedHost, "192.168.1.42:7700");
});

test("envFlag treats '0' and 'false' as off", () => {
  // Spot-check the implicit truthiness rule: OBSERVABILITY_ALLOW_LAN=0
  // does not authorize a LAN bind even with the marker present.
  assert.throws(() =>
    resolveBindDecision(
      inputs(
        {
          OBSERVABILITY_PUBLISHED_HOST: "192.168.1.42:7700",
          OBSERVABILITY_ALLOW_LAN: "0",
          OBSERVABILITY_TLS_TERMINATED: "1",
        },
        true,
      ),
    ),
  );
  assert.throws(() =>
    resolveBindDecision(
      inputs(
        {
          OBSERVABILITY_PUBLISHED_HOST: "192.168.1.42:7700",
          OBSERVABILITY_ALLOW_LAN: "true",
          OBSERVABILITY_TLS_TERMINATED: "false",
        },
        true,
      ),
    ),
  );
});
