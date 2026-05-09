import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildCommand, parseOutput } from "./agent_codex.ts";

test("buildCommand: emits codex exec --json with high reasoning effort via -c", () => {
  const built = buildCommand("hello prompt");
  assert.equal(built.cmd, "codex");
  assert.deepEqual(built.args, [
    "exec",
    "--json",
    "-c",
    `model_reasoning_effort="high"`,
  ]);
  assert.equal(built.stdin, "hello prompt");
  assert.equal(typeof built.env, "object");
});

test("buildCommand: model flag included only when caller passes one", () => {
  const noModel = buildCommand("p");
  assert.ok(!noModel.args.includes("-m"));

  const withModel = buildCommand("p", "gpt-5.5-pro");
  const i = withModel.args.indexOf("-m");
  assert.ok(i >= 0, "expected -m flag");
  assert.equal(withModel.args[i + 1], "gpt-5.5-pro");
  // model flags appended after the reasoning-effort `-c` override
  const cIdx = withModel.args.indexOf("-c");
  assert.ok(cIdx >= 0, "expected -c flag");
  assert.ok(i > cIdx);
});

test("buildCommand: env contains only allowlisted keys", () => {
  const built = buildCommand("p");
  for (const key of Object.keys(built.env)) {
    assert.ok(
      ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"].includes(key),
      `unexpected env key: ${key}`,
    );
  }
});

test("parseOutput: extracts findings from codex agent_message JSONL framing", () => {
  const finding = {
    id: "sec-001",
    domain: "security",
    agent: "codex",
    severity: "high",
    file: "src/x.ts",
    line: 12,
    title: "Unvalidated input",
    body: "details",
  };
  const codexEvent = {
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(finding) },
  };
  const stdout = JSON.stringify(codexEvent) + "\n";

  const { findings, parseErrors } = parseOutput(stdout);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
  assert.equal(findings[0].title, "Unvalidated input");
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].domain, "security");
});

test("parseOutput: handles legacy message/output_text framing", () => {
  const finding = {
    domain: "architecture",
    severity: "medium",
    title: "Coupling",
  };
  const codexEvent = {
    type: "item.completed",
    item: {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(finding) }],
    },
  };
  const { findings, parseErrors } = parseOutput(JSON.stringify(codexEvent));
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
  assert.equal(findings[0].domain, "architecture");
  assert.equal(findings[0].agent, "codex"); // default-filled
  assert.equal(findings[0].file, null);
  assert.equal(findings[0].line, null);
  assert.equal(findings[0].body, "");
  assert.ok(findings[0].id && findings[0].id.length > 0);
});

test("parseOutput: drops malformed records and routes to parseErrors[]", () => {
  const ok = { domain: "d", severity: "low", title: "ok" };
  const lines = [
    JSON.stringify(ok),
    "{ this is not json",
    JSON.stringify({ domain: "d", severity: "bogus", title: "bad sev" }),
    JSON.stringify({ domain: "d", title: "no severity" }),
    JSON.stringify({ domain: "d", severity: "low" }),
    JSON.stringify({ severity: "low", title: "no domain" }),
    JSON.stringify(["not", "an", "object"]),
  ].join("\n");

  const { findings, parseErrors } = parseOutput(lines);
  assert.equal(findings.length, 1);
  // 6 candidate object-shaped lines; the array literal starts with '[' and is
  // treated as framing chatter (not an attempted finding), so 5 errors.
  assert.equal(parseErrors.length, 5);
  assert.doesNotThrow(() => parseOutput(lines));
});

test("parseOutput: unknown fields land under finding.extra", () => {
  const f = {
    domain: "perf",
    severity: "low",
    title: "t",
    custom_metric: 42,
    cwe: "CWE-79",
  };
  const { findings } = parseOutput(JSON.stringify(f));
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].extra, { custom_metric: 42, cwe: "CWE-79" });
});

test("parseOutput: declared extra is preserved and merged with unknown fields", () => {
  const f = {
    domain: "perf",
    severity: "low",
    title: "t",
    extra: { source: "linter" },
    extra_field_outside: "shadow",
  };
  const { findings } = parseOutput(JSON.stringify(f));
  assert.deepEqual(findings[0].extra, {
    source: "linter",
    extra_field_outside: "shadow",
  });
});

test("parseOutput: passes through raw JSONL when no codex framing detected", () => {
  // raw findings without item.completed wrapping (e.g. dev fixture)
  const f = { domain: "d", severity: "high", title: "x" };
  const { findings } = parseOutput(JSON.stringify(f) + "\n");
  assert.equal(findings.length, 1);
});

test("parseOutput: skips non-JSON status lines without recording errors", () => {
  const finding = { domain: "d", severity: "high", title: "x" };
  const stdout = [
    "Codex CLI v1.2.3",
    "loading model...",
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(finding) },
    }),
  ].join("\n");
  const { findings, parseErrors } = parseOutput(stdout);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
});

test("parseOutput: falsy severities/titles are rejected as missing", () => {
  const empty = { domain: "d", severity: "", title: "" };
  const { findings, parseErrors } = parseOutput(JSON.stringify(empty));
  assert.equal(findings.length, 0);
  assert.equal(parseErrors.length, 1);
});

test("parseOutput: derives id when not provided", () => {
  const f = { domain: "d", severity: "high", title: "Title" };
  const { findings } = parseOutput(JSON.stringify(f));
  assert.match(findings[0].id, /^[0-9a-f]{12}$/);
});
