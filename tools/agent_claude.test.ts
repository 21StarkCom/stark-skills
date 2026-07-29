import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildCommand,
  extractStructuredOutput,
  normalizeOutput,
  serializeJsonSchema,
} from "./agent_claude.ts";

const SCHEMA = {
  type: "object",
  properties: { answer: { type: "number" } },
  required: ["answer"],
  additionalProperties: false,
} as const;

describe("buildCommand --json-schema", () => {
  test("omits the flag when no schema is supplied", () => {
    const { args } = buildCommand("hi");
    assert.equal(args.includes("--json-schema"), false);
  });

  test("omits the flag when ctx carries no schema", () => {
    const { args } = buildCommand("hi", undefined, { cwd: "/tmp" });
    assert.equal(args.includes("--json-schema"), false);
  });

  test("emits --json-schema and its inline JSON as a unit", () => {
    const { args } = buildCommand("hi", undefined, { jsonSchema: SCHEMA });
    const i = args.indexOf("--json-schema");
    assert.ok(i >= 0, "flag present");
    assert.deepEqual(JSON.parse(args[i + 1]!), SCHEMA);
  });

  test("serializes inline — never a file path (the CLI rejects paths)", () => {
    const { args } = buildCommand("hi", undefined, { jsonSchema: SCHEMA });
    const value = args[args.indexOf("--json-schema") + 1]!;
    assert.ok(value.startsWith("{"), "must be inline JSON, not a path");
    assert.doesNotThrow(() => JSON.parse(value));
  });

  test("leaves the pre-existing args untouched", () => {
    const { args } = buildCommand("hi", "haiku", { jsonSchema: SCHEMA });
    for (const expected of ["-p", "--output-format", "json", "--model", "haiku"]) {
      assert.ok(args.includes(expected), `kept ${expected}`);
    }
  });

  test("a falsy-but-present schema still emits the flag", () => {
    // `false` is a legal JSON Schema (matches nothing). Guarding on
    // `!== undefined` rather than truthiness keeps that meaningful.
    const { args } = buildCommand("hi", undefined, { jsonSchema: false });
    assert.equal(args[args.indexOf("--json-schema") + 1], "false");
  });
});

describe("serializeJsonSchema", () => {
  test("rejects a non-serializable schema instead of emitting undefined", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => serializeJsonSchema(cyclic));
  });

  test("rejects a schema over the argv budget", () => {
    const huge = { type: "object", description: "x".repeat(300 * 1024) };
    assert.throws(() => serializeJsonSchema(huge), /argv budget/);
  });
});

describe("extractStructuredOutput", () => {
  test("returns the pre-parsed object from a schema-constrained run", () => {
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"answer":391}',
      structured_output: { answer: 391 },
    });
    assert.deepEqual(extractStructuredOutput(envelope), { answer: 391 });
  });

  test("returns null when the run had no schema", () => {
    const envelope = JSON.stringify({ type: "result", is_error: false, result: "plain text" });
    assert.equal(extractStructuredOutput(envelope), null);
  });

  test("returns null on an errored envelope — a partial object is not a reply", () => {
    const envelope = JSON.stringify({ is_error: true, structured_output: { answer: 1 } });
    assert.equal(extractStructuredOutput(envelope), null);
  });

  test("returns null on non-JSON stdout rather than throwing", () => {
    assert.equal(extractStructuredOutput("not json at all"), null);
    assert.equal(extractStructuredOutput(""), null);
  });

  test("preserves nested arrays of objects", () => {
    const findings = { findings: [{ title: "t", severity: "high" }] };
    const envelope = JSON.stringify({ is_error: false, structured_output: findings });
    assert.deepEqual(extractStructuredOutput(envelope), findings);
  });

  test("null structured_output reads as absent, not as a value", () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: null });
    assert.equal(extractStructuredOutput(envelope), null);
  });
});

describe("normalizeOutput is unchanged by this feature", () => {
  test("still unwraps the plain result envelope", () => {
    const envelope = JSON.stringify({ type: "result", result: "hello" });
    assert.equal(normalizeOutput(envelope), "hello");
  });

  test("still passes through non-envelope text", () => {
    assert.equal(normalizeOutput("bare text"), "bare text");
  });
});
