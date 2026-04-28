import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, summarizeDiff, withinBudget } from "../lib/budget.ts";

test("estimateTokens returns roughly bytes/4", () => {
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("summarizeDiff replaces hunks with shortstat per file", () => {
  const diff = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,3 +1,4 @@",
    "+added",
    "-removed",
    "diff --git a/y.ts b/y.ts",
    "@@ -10,2 +10,5 @@",
    "+three more lines",
  ].join("\n");
  const s = summarizeDiff(diff);
  assert.match(s, /^x\.ts: \+\d+ -\d+/m);
  assert.match(s, /^y\.ts: \+\d+ -\d+/m);
});

test("withinBudget returns false when over cap", () => {
  assert.equal(withinBudget(40_000, 32_000), false);
  assert.equal(withinBudget(8_000, 32_000), true);
});
