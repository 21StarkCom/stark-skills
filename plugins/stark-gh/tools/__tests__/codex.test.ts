import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexJsonl, buildCodexArgv } from "../lib/codex.ts";

test("buildCodexArgv composes the production invocation", () => {
  const argv = buildCodexArgv({ model: "gpt-5.5", reasoningEffort: "medium" });
  assert.deepEqual(argv, [
    "exec",
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="medium"',
    "--ephemeral",
    "--json",
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "-",
  ]);
});

test("parseCodexJsonl extracts agent_message text", () => {
  const jsonl = [
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello world" } }),
    JSON.stringify({ type: "other.event" }),
  ].join("\n");
  assert.equal(parseCodexJsonl(jsonl), "hello world");
});

test("parseCodexJsonl falls back to raw on non-JSONL", () => {
  assert.equal(parseCodexJsonl("plain text"), "plain text");
});
