import test from "node:test";
import assert from "node:assert/strict";
import { computeDispatchCost } from "./cost_lib.ts";

test("computeDispatchCost: known model uses its rate", () => {
  // gpt-5.5-pro = $25/1M in, $100/1M out
  const cost = computeDispatchCost("gpt-5.5-pro", 1_000_000, 1_000_000);
  assert.equal(cost, 125.0);
});

test("computeDispatchCost: fractional tokens", () => {
  // 200k in, 50k out on gpt-5.5-pro = 0.2*25 + 0.05*100 = 5 + 5 = 10
  assert.equal(computeDispatchCost("gpt-5.5-pro", 200_000, 50_000), 10.0);
});

test("computeDispatchCost: unknown model falls back", () => {
  // _fallback = $100/1M in, $300/1M out
  assert.equal(computeDispatchCost("mystery-model", 1_000_000, 0), 100.0);
});

test("computeDispatchCost: zero tokens is zero", () => {
  assert.equal(computeDispatchCost("claude-opus-4-8", 0, 0), 0);
});
