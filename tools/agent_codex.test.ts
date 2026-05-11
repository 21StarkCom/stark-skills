import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildCommand, extractLastAgentText, parseOutput } from "./agent_codex.ts";

test("buildCommand: emits codex exec --json with high reasoning effort via -c", () => {
  const built = buildCommand("hello prompt");
  assert.equal(built.cmd, "codex");
  assert.deepEqual(built.args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
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

test("parseOutput: silently skips non-finding JSON noise (no severity, no title)", () => {
  // Agents under high reasoning effort sometimes emit reasoning/status/summary
  // JSON objects between actual findings. These have no severity and no title.
  // They are NOT malformed findings — they're framing chatter — so they must
  // not pollute parseErrors.
  const finding = { domain: "d", severity: "high", title: "real finding", body: "details" };
  const lines = [
    JSON.stringify({ thought: "Looking at the diff..." }),
    JSON.stringify(finding),
    JSON.stringify({ summary: "Found 1 issue" }),
    JSON.stringify({ status: "analyzing" }),
    JSON.stringify({ reasoning: "The change looks suspicious" }),
    JSON.stringify({ phase: 2, step: "check security" }),
  ].join("\n");
  const { findings, parseErrors } = parseOutput(lines);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0, `expected 0 parse errors, got ${parseErrors.map((e) => e.reason).join("; ")}`);
});

test("parseOutput: still flags malformed findings (has title or severity)", () => {
  // Lines that DO have a finding-shaped key (severity or title) must still be
  // strictly validated, so genuine typos don't slip through.
  const lines = [
    JSON.stringify({ severity: "high" }),                        // has severity, missing title
    JSON.stringify({ title: "x" }),                              // has title, missing severity
    JSON.stringify({ severity: "high", title: "x" }),            // has both, missing domain
    JSON.stringify({ severity: "bogus", title: "x", domain: "d" }), // invalid severity enum
  ].join("\n");
  const { findings, parseErrors } = parseOutput(lines);
  assert.equal(findings.length, 0);
  assert.equal(parseErrors.length, 4);
});

test("parseOutput: no_findings sentinel sets noFindingsAck and is not a parse error", () => {
  const sentinel = JSON.stringify({ no_findings: true, domain: "security", agent: "codex" });
  const { findings, parseErrors, noFindingsAck } = parseOutput(sentinel);
  assert.equal(findings.length, 0);
  assert.equal(parseErrors.length, 0);
  assert.equal(noFindingsAck, true);
});

test("parseOutput: sentinel + findings → ack stays true alongside findings", () => {
  // Defensive: agent emits both. We accept both — findings are still parsed,
  // ack is still set. Dispatcher rule already prefers findings.length > 0.
  const f = { domain: "d", severity: "high", title: "t", body: "b" };
  const lines = [
    JSON.stringify({ no_findings: true, domain: "d" }),
    JSON.stringify(f),
  ].join("\n");
  const { findings, parseErrors, noFindingsAck } = parseOutput(lines);
  assert.equal(findings.length, 1);
  assert.equal(parseErrors.length, 0);
  assert.equal(noFindingsAck, true);
});

test("parseOutput: empty stdout → no ack set", () => {
  const r = parseOutput("");
  assert.equal(r.findings.length, 0);
  assert.equal(r.parseErrors.length, 0);
  assert.equal(r.noFindingsAck, undefined);
});

test("extractLastAgentText: returns only the final agent_message, dropping reasoning preambles", () => {
  const ev = (text: string) => JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
  const stdout = [
    ev("Reading the affected files..."),
    ev("Now planning the fix..."),
    ev('{"modified_files":["a.ts"],"summary":"done"}'),
  ].join("\n");
  assert.equal(
    extractLastAgentText(stdout),
    '{"modified_files":["a.ts"],"summary":"done"}',
  );
});

test("extractLastAgentText: handles legacy message/output_text shape", () => {
  const ev = (text: string) => JSON.stringify({
    type: "item.completed",
    item: { type: "message", content: [{ type: "output_text", text }] },
  });
  const stdout = [
    ev("intermediate"),
    ev("final answer"),
  ].join("\n");
  assert.equal(extractLastAgentText(stdout), "final answer");
});

test("extractLastAgentText: returns raw input when no JSONL framing is present", () => {
  assert.equal(extractLastAgentText("plain text"), "plain text");
});
