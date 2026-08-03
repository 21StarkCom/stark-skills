import { test, describe } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildCommand,
  extractStructuredOutput,
  normalizeOutput,
  parseOutput,
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

  test("rejects a non-object schema the CLI would exit 1 on", () => {
    // The CLI accepts a JSON *object* only — `false`, `null`, a string and an
    // array each make it print "--json-schema must be a JSON object" and exit 1
    // (verified against 2.1.220). Fail here, attributed, instead of there.
    for (const bad of [false, null, 0, "{}", [{ type: "object" }]]) {
      assert.throws(
        () => buildCommand("hi", undefined, { jsonSchema: bad }),
        /--json-schema: schema must be a JSON object/,
        `rejected ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe("serializeJsonSchema", () => {
  test("rejects a cyclic schema with an attributed error, not a bare TypeError", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // Without the try/catch around JSON.stringify this throws
    // "Converting circular structure to JSON", naming neither the flag nor the
    // argument — the matcher is what makes the guard load-bearing.
    assert.throws(
      () => serializeJsonSchema(cyclic),
      /--json-schema: schema is not JSON-serializable/,
    );
  });

  test("rejects a schema whose toJSON erases it", () => {
    const erasing = { toJSON: () => undefined } as unknown;
    assert.throws(
      () => serializeJsonSchema(erasing),
      /--json-schema: schema is not JSON-serializable/,
    );
  });

  test("rejects a schema over the argv budget", () => {
    const huge = { type: "object", description: "x".repeat(300 * 1024) };
    assert.throws(() => serializeJsonSchema(huge), /argv budget/);
  });

  test("the budget stays under the Linux per-argv-string cap (128 KiB)", () => {
    // MAX_ARG_STRLEN = 32 * PAGE_SIZE = 131072 bytes for a *single* argument.
    // A schema at the budget must therefore still spawn; probe the boundary.
    const atCap = { type: "object", description: "x".repeat(118 * 1024) };
    const s = serializeJsonSchema(atCap);
    assert.ok(Buffer.byteLength(s, "utf8") < 128 * 1024, "under MAX_ARG_STRLEN");
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

  test("throws on an errored envelope, carrying the CLI's own message", () => {
    // Returning null here would make an exhausted account indistinguishable
    // from "no schema was passed", sending the caller off to scrape prose that
    // will never contain the reply.
    const envelope = JSON.stringify({
      is_error: true,
      result: "Credit balance is too low",
      structured_output: { answer: 1 },
    });
    assert.throws(() => extractStructuredOutput(envelope), /Credit balance is too low/);
  });

  test("throws with a fallback detail when an errored envelope has no result text", () => {
    const envelope = JSON.stringify({ is_error: true, subtype: "error_max_turns" });
    assert.throws(() => extractStructuredOutput(envelope), /error_max_turns/);
  });

  test("null on a normalizeOutput-ed envelope is a caller mistake, documented as such", () => {
    // normalizeOutput unwraps to `.result`, dropping structured_output — this
    // pins that the composition returns null so the JSDoc's "pass RAW stdout"
    // warning stays honest.
    const envelope = JSON.stringify({
      type: "result",
      is_error: false,
      result: '{"answer":391}',
      structured_output: { answer: 391 },
    });
    assert.equal(extractStructuredOutput(normalizeOutput(envelope)), null);
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

describe("parseOutput reads a schema-constrained reply", () => {
  const FINDING = {
    domain: "behavior", agent: "claude", severity: "high",
    file: "a.ts", line: 3, title: "t", body: "b",
  };

  test("reads findings out of a { findings: [...] } structured_output", () => {
    const envelope = JSON.stringify({
      type: "result", is_error: false,
      result: JSON.stringify({ findings: [FINDING] }),
      structured_output: { findings: [FINDING] },
    });
    const { findings, parseErrors } = parseOutput(envelope);
    assert.equal(parseErrors.length, 0);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, "t");
    assert.equal(findings[0]!.severity, "high");
  });

  test("reads findings out of a bare-array structured_output", () => {
    const envelope = JSON.stringify({
      is_error: false, structured_output: [FINDING, { ...FINDING, title: "u" }],
    });
    const { findings } = parseOutput(envelope);
    assert.deepEqual(findings.map((f) => f.title), ["t", "u"]);
  });

  test("an empty structured findings list is a no-findings ack, not a failed domain", () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: { findings: [] } });
    const res = parseOutput(envelope);
    assert.equal(res.findings.length, 0);
    assert.equal(res.noFindingsAck, true);
  });

  test("surfaces the CLI's error text instead of an empty parse", () => {
    const envelope = JSON.stringify({ is_error: true, result: "Credit balance is too low" });
    const { findings, parseErrors } = parseOutput(envelope);
    assert.equal(findings.length, 0);
    assert.match(parseErrors[0]!.reason, /Credit balance is too low/);
  });

  test("reports an unrecognized structured shape rather than parsing nothing", () => {
    const envelope = JSON.stringify({ is_error: false, structured_output: { answer: 391 } });
    const { findings, parseErrors } = parseOutput(envelope);
    assert.equal(findings.length, 0);
    assert.match(parseErrors[0]!.reason, /neither an array of findings/);
  });

  test("the pre-existing JSONL path is untouched when no schema was used", () => {
    const envelope = JSON.stringify({
      type: "result", is_error: false, result: JSON.stringify(FINDING),
    });
    const { findings, parseErrors } = parseOutput(envelope);
    assert.equal(parseErrors.length, 0);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.title, "t");
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

describe("buildCommand effort + tool isolation", () => {
  test("emits neither --effort nor --tools by default", () => {
    const { args } = buildCommand("hi");
    assert.equal(args.includes("--effort"), false);
    assert.equal(args.includes("--tools"), false);
  });

  test("ctx without the new fields leaves the command byte-for-byte unchanged", () => {
    assert.deepEqual(buildCommand("hi", "m", { cwd: "/tmp" }).args, buildCommand("hi", "m").args);
  });

  test("emits --effort <level> in the CLI's documented form", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"]) {
      const { args } = buildCommand("hi", undefined, { effort: level });
      const i = args.indexOf("--effort");
      assert.ok(i >= 0, `--effort present for ${level}`);
      assert.equal(args[i + 1], level);
    }
  });

  test("blank effort is treated as absent, never an empty --effort value", () => {
    const { args } = buildCommand("hi", undefined, { effort: "   " });
    assert.equal(args.includes("--effort"), false);
  });

  test("disableTools emits --tools with the empty-string value that disables all tools", () => {
    const { args } = buildCommand("hi", undefined, { disableTools: true });
    const i = args.indexOf("--tools");
    assert.ok(i >= 0, "--tools present");
    assert.equal(args[i + 1], "");
  });

  test("disableTools: false stays off", () => {
    const { args } = buildCommand("hi", undefined, { disableTools: false });
    assert.equal(args.includes("--tools"), false);
  });

  test("--tools is variadic: whatever follows it must start with a dash", () => {
    const { args } = buildCommand("hi", undefined, { disableTools: true, jsonSchema: SCHEMA });
    const after = args[args.indexOf("--tools") + 2];
    assert.ok(after === undefined || after.startsWith("-"), `variadic swallow guard, got ${after}`);
  });

  test("effort, tool lockdown, model and schema compose in one command", () => {
    const { args } = buildCommand("hi", "claude-opus-5", {
      effort: "max", disableTools: true, jsonSchema: SCHEMA,
    });
    assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5");
    assert.equal(args[args.indexOf("--effort") + 1], "max");
    assert.equal(args[args.indexOf("--tools") + 1], "");
    assert.deepEqual(JSON.parse(args[args.indexOf("--json-schema") + 1]!), SCHEMA);
  });
});
