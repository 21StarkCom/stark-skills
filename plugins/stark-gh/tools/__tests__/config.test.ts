import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDraftConfig } from "../lib/config.ts";

test("defaults applied when no overrides", () => {
  const c = resolveDraftConfig({});
  assert.equal(c.agent, "codex");
  assert.equal(c.model, "gpt-5.5");
  assert.equal(c.reasoningEffort, "medium");
  assert.equal(c.timeoutSeconds, 180);
});

test("CLI overrides win over config.json", () => {
  const c = resolveDraftConfig({ model: "gpt-5.4-pro", reasoningEffort: "high" });
  assert.equal(c.model, "gpt-5.4-pro");
  assert.equal(c.reasoningEffort, "high");
});

test("haiku interlock - case-insensitive rejection", () => {
  assert.throws(() => resolveDraftConfig({ model: "claude-haiku-4.5" }), /haiku/i);
  assert.throws(() => resolveDraftConfig({ model: "HAIKU-something" }), /haiku/i);
});

test("low reasoning effort rejected", () => {
  assert.throws(() => resolveDraftConfig({ reasoningEffort: "low" as never }), /effort/i);
});
