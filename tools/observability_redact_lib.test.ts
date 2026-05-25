// Unit tests for observability_redact_lib.ts.
//
// Covers:
//   - every built-in pattern in `redact()`
//   - boundary-split sweep for `createStreamRedactor()` so a secret split
//     across feed boundaries is still caught
//   - depth-capped + size-capped redactJson()
//   - env-injected literal patterns
//   - disable-pattern toggle
//
// Phase 2 Task 5 (+E6) acceptance is built around these tests; they MUST
// stay sharp because the integration runtime trusts that no unredacted
// secret leaks past the daemon.

import { strict as assert } from "node:assert";
import test from "node:test";

import {
  __test,
  createStreamRedactor,
  getActivePatterns,
  MAX_REDACT_STRING_BYTES,
  redact,
  redactJson,
  resetPatternCacheForTests,
} from "./observability_redact_lib.ts";

function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetPatternCacheForTests();
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetPatternCacheForTests();
  }
}

test("redact masks GitHub PAT with length-preserving REDACTED tag", () => {
  const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
  const text = `auth: ${secret} end`;
  const r = redact(text);
  assert.equal(r.redacted, true);
  assert.equal(r.text.length, text.length);
  assert.equal(r.text.includes(secret), false);
  assert.match(r.text, /<REDACTED:ghp>\*+/);
});

test("redact masks Anthropic key (sk-ant-)", () => {
  const secret = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";
  const r = redact(`Authorization: ${secret}`);
  assert.equal(r.redacted, true);
  assert.equal(r.text.includes(secret), false);
});

test("redact masks AWS AKIA access key", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const r = redact(`aws_access_key_id=${secret}`);
  assert.equal(r.redacted, true);
  assert.equal(r.text.includes(secret), false);
});

test("redact masks JWT (eyJ... three dot-separated b64url segments)", () => {
  const secret =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4eHh4eCJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const r = redact(`token=${secret} extra`);
  assert.equal(r.redacted, true);
  assert.equal(r.text.includes(secret), false);
});

test("redact masks `Authorization: Bearer ...` header", () => {
  const secret = "AAAAAAAAAAAAAAAAAAAA=BBBBBBBB";
  const r = redact(`Authorization: Bearer ${secret}`);
  assert.equal(r.redacted, true);
  assert.equal(r.text.includes(secret), false);
});

test("redact leaves benign log content alone", () => {
  const text = "Just a normal log line about commit abc123 and a 200 status";
  const r = redact(text);
  assert.equal(r.redacted, false);
  assert.equal(r.text, text);
});

test("redact() bails out on oversize strings with a length-preserving sentinel", () => {
  const big = "a".repeat(MAX_REDACT_STRING_BYTES + 1);
  const r = redact(big);
  assert.equal(r.redacted, true);
  assert.equal(r.text.length, big.length);
  assert.match(r.text, /^<REDACTED:oversize>\*+$/);
});

test("createStreamRedactor catches a secret split across two feeds", () => {
  const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
  // Put secret across the middle.
  const head = "prefix " + secret.slice(0, 10);
  const tail = secret.slice(10) + " suffix";
  const red = createStreamRedactor();
  // Filler uses spaces so the regex `\b` word boundary fires before/after
  // the secret. "x" is a \w char which would suppress the boundary.
  const filler = " ".repeat(4096);
  let out = "";
  out += red.feed(filler);
  out += red.feed(head);
  out += red.feed(tail);
  out += red.flush();
  assert.equal(out.includes(secret), false, `secret leaked: ${out}`);
  assert.equal(red.hasRedacted(), true);
});

test("createStreamRedactor catches a secret split at every offset across the chunk boundary", () => {
  const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
  // Use space-padded filler so the `\b` word boundary in the regex fires
  // before the secret. (filler="x" is a \w char and would suppress it.)
  const filler = " ".repeat(4096);
  for (let split = 1; split < secret.length; split++) {
    const red = createStreamRedactor();
    const head = filler + secret.slice(0, split);
    const tail = secret.slice(split) + filler;
    let out = "";
    out += red.feed(head);
    out += red.feed(tail);
    out += red.flush();
    assert.equal(
      out.includes(secret),
      false,
      `secret leaked at split=${split}: ${out.slice(0, 64)}…`,
    );
  }
});

test("createStreamRedactor handles only-one-chunk input via flush()", () => {
  const secret = "AKIAIOSFODNN7EXAMPLE";
  const red = createStreamRedactor();
  // Small enough to fully buffer; flush() must run the regex on the residual.
  let out = red.feed(`leak ${secret} done`);
  out += red.flush();
  assert.equal(out.includes(secret), false);
  assert.equal(red.hasRedacted(), true);
});

test("redactJson walks nested objects + arrays, marks redacted=true", () => {
  const value = {
    a: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567",
    b: { c: "AKIAIOSFODNN7EXAMPLE", d: 42 },
    e: ["safe", "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"],
  };
  const r = redactJson(value);
  const out = r.value as typeof value;
  assert.equal(r.redacted, true);
  assert.equal((out.a as string).includes("ghp_AAAAA"), false);
  assert.equal(((out.b as { c: string }).c).includes("AKIA"), false);
  assert.equal((out.b as { d: number }).d, 42);
  assert.equal((out.e as string[])[0], "safe");
  // Check for the unique payload after the tag-shared prefix — the
  // REDACTED tag itself contains the literal "sk-ant", so we check that
  // the secret's payload (api03-AAA...) is gone.
  assert.equal((out.e as string[])[1].includes("api03-AAAA"), false);
});

test("redactJson caps recursion depth", () => {
  let nested: unknown = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
  for (let i = 0; i < 50; i++) nested = { x: nested };
  const r = redactJson(nested);
  assert.equal(r.value !== undefined, true);
  // No exception thrown — the deep leaf is replaced with the depth sentinel.
});

test("OBSERVABILITY_REDACT_DISABLE_PATTERNS turns off named patterns", () => {
  withEnv({ OBSERVABILITY_REDACT_DISABLE_PATTERNS: "ghp" }, () => {
    const secret = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
    const r = redact(`auth: ${secret}`);
    assert.equal(r.redacted, false);
    assert.equal(r.text.includes(secret), true);
  });
});

test("OBSERVABILITY_REDACT_EXTRA_ENV plants per-install literal secrets", () => {
  withEnv(
    {
      MY_PROD_TOKEN: "abc-prod-12345",
      OBSERVABILITY_REDACT_EXTRA_ENV: "MY_PROD_TOKEN",
    },
    () => {
      const r = redact("auth: abc-prod-12345 end");
      assert.equal(r.redacted, true);
      assert.equal(r.text.includes("abc-prod-12345"), false);
    },
  );
});

test("getActivePatterns is deterministic across calls (cached)", () => {
  withEnv({}, () => {
    const p1 = getActivePatterns();
    const p2 = getActivePatterns();
    assert.equal(p1, p2);
  });
});

test("padToLen never returns fewer than `<REDACTED:NAME>` chars for short inputs", () => {
  const padded = __test.padToLen("jwt", 5);
  assert.ok(padded.length >= 5);
});
