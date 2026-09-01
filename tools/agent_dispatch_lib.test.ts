import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  isPlainObject,
  parseCodexJsonl,
  parseGeminiJson,
  shouldFallbackToApiKey,
  VALID_AGENTS,
  run,
} from "./agent_dispatch_lib.ts";

// --- parseCodexJsonl -------------------------------------------------------

describe("parseCodexJsonl", () => {
  test("passes through non-JSONL output unchanged", () => {
    assert.equal(parseCodexJsonl("plain text"), "plain text");
  });

  test("extracts agent_message events", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
      '{"type":"other"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"world"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "hello\nworld");
  });

  test("extracts legacy message+content events", () => {
    const raw = '{"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"hi"}]}}';
    assert.equal(parseCodexJsonl(raw), "hi");
  });

  test("skips malformed JSON lines", () => {
    const raw = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"a"}}',
      'not json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"b"}}',
    ].join("\n");
    assert.equal(parseCodexJsonl(raw), "a\nb");
  });
});

// --- parseGeminiJson -------------------------------------------------------

describe("parseGeminiJson", () => {
  test("unwraps single response envelope", () => {
    assert.equal(parseGeminiJson('{"response":"hello"}'), "hello");
  });

  test("joins array of response envelopes", () => {
    assert.equal(parseGeminiJson('[{"response":"a"},{"response":"b"}]'), "a\nb");
  });

  test("passes through non-envelope output", () => {
    assert.equal(parseGeminiJson("plain text"), "plain text");
  });
});

// --- isPlainObject ---------------------------------------------------------

describe("isPlainObject", () => {
  test("true for plain objects", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject({ a: 1 }), true);
  });
  test("false for arrays, null, primitives", () => {
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("s"), false);
    assert.equal(isPlainObject(1), false);
  });
});

// --- shouldFallbackToApiKey -----------------------------------------------

describe("shouldFallbackToApiKey", () => {
  test("matches known ADC failure patterns", () => {
    assert.equal(shouldFallbackToApiKey("UNAUTHENTICATED"), true);
    assert.equal(shouldFallbackToApiKey("DefaultCredentialsError: ..."), true);
    assert.equal(shouldFallbackToApiKey("got 403 from server"), true);
  });
  test("returns false for unrelated stderr", () => {
    assert.equal(shouldFallbackToApiKey("connection refused"), false);
  });
});

// --- VALID_AGENTS sanity --------------------------------------------------

describe("VALID_AGENTS", () => {
  test("contains exactly the three known agents", () => {
    assert.deepEqual([...VALID_AGENTS].sort(), ["claude", "codex", "gemini"]);
  });
});

// --- run(): timeout must always settle -------------------------------------

// Regression: run() resolved only once child "close" fired, and "close" needs
// every stdio pipe to end. A descendant that inherits stdout and outlives the
// kill therefore hung the promise forever. Reproduce with a backgrounded
// sleeper holding stdout past its parent's exit.
test("run(): a timed-out child whose descendant holds stdout still settles", async () => {
  const started = Date.now();
  const res = await run("sh", ["-c", "sleep 30 & echo up; sleep 30"], {
    timeoutSec: 1,
  });
  const elapsed = Date.now() - started;
  assert.equal(res.timedOut, true);
  assert.match(res.stdout, /up/);
  assert.ok(
    elapsed < 25_000,
    `run() took ${elapsed}ms — the last-resort settle did not fire`,
  );
});
