import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrMergeArgs, classifyError, jitter, evaluateRollup } from "../gh_watch_runs.ts";

test("parsePrMergeArgs: returns null when --on-green absent", () => {
  assert.equal(parsePrMergeArgs([]), null);
  assert.equal(parsePrMergeArgs(["--repo", "o/r", "--pr", "1"]), null);
});

test("parsePrMergeArgs: extracts callback + plan-file + watch-timeout + poll-seconds", () => {
  const r = parsePrMergeArgs(["--on-green", "pr-merge-complete", "--plan-file", "/tmp/p.json", "--watch-timeout", "12", "--poll-seconds", "45"]);
  assert.deepEqual(r, {
    callbackName: "pr-merge-complete",
    planFile: "/tmp/p.json",
    watchTimeoutHours: 12,
    pollSeconds: 45,
  });
});

test("parsePrMergeArgs: defaults watch-timeout=6, poll=30", () => {
  const r = parsePrMergeArgs(["--on-green", "pr-merge-complete", "--plan-file", "/p"]);
  assert.equal(r!.watchTimeoutHours, 6);
  assert.equal(r!.pollSeconds, 30);
});

test("parsePrMergeArgs: --on-green requires --plan-file", () => {
  assert.throws(() => parsePrMergeArgs(["--on-green", "x"]), /requires --plan-file/);
});

test("parsePrMergeArgs: --on-green requires a value", () => {
  assert.throws(() => parsePrMergeArgs(["--on-green"]), /--on-green requires a value/);
});

test("classifyError: 429 → rateLimit", () => {
  const r = classifyError(new Error("HTTP 429: rate limit"));
  assert.equal(r.rateLimit, true);
});

test("classifyError: X-RateLimit-Remaining: 0 → rateLimit", () => {
  const r = classifyError(new Error("got X-RateLimit-Remaining: 0 from gh"));
  assert.equal(r.rateLimit, true);
});

test("classifyError: secondary rate limit", () => {
  const r = classifyError(new Error("you have triggered a secondary rate limit"));
  assert.equal(r.secondaryRateLimit, true);
});

test("classifyError: 5xx transient", () => {
  for (const code of [500, 502, 503, 504]) {
    const r = classifyError(new Error(`HTTP ${code} server error`));
    assert.equal(r.transient, true, `${code} should be transient`);
  }
});

test("classifyError: unknown / 401 → not classified", () => {
  const r = classifyError(new Error("401 unauthorized"));
  assert.equal(r.rateLimit, false);
  assert.equal(r.secondaryRateLimit, false);
  assert.equal(r.transient, false);
});

test("jitter: stays within ±20% by default", () => {
  for (let i = 0; i < 100; i++) {
    const r = jitter(30);
    assert.ok(r >= 24, `${r} >= 24`);
    assert.ok(r <= 36, `${r} <= 36`);
  }
});

test("jitter: clamps to >= 1", () => {
  // Even if base * (1 - pct) would be 0 or negative, output is at least 1.
  const r = jitter(0.1);
  assert.ok(r >= 1);
});

test("evaluateRollup: head_moved on mismatch", () => {
  const r = evaluateRollup({ mismatch: true, contexts: null, headRefOid: "actual-sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "head_moved");
});

test("evaluateRollup: vacuous wait when not allowed", () => {
  const r = evaluateRollup({ mismatch: false, contexts: [], headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
  assert.match(r.reason!, /no required/);
});

test("evaluateRollup: vacuous ready when allowNoRequiredChecks", () => {
  const r = evaluateRollup({ mismatch: false, contexts: [], headRefOid: "sha" }, { allowNoRequiredChecks: true });
  assert.equal(r.kind, "ready");
});

test("evaluateRollup: all-passing → ready", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "CheckRun", name: "lint", isRequired: true, conclusion: "NEUTRAL", status: "COMPLETED" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "ready");
});

test("evaluateRollup: any failing → fatal", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: "SUCCESS", status: "COMPLETED" },
    { kind: "CheckRun", name: "lint", isRequired: true, conclusion: "FAILURE", status: "COMPLETED" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "fatal");
});

test("evaluateRollup: pending → wait", () => {
  const ctx = [
    { kind: "CheckRun", name: "ci", isRequired: true, conclusion: null, status: "IN_PROGRESS" },
  ];
  const r = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r.kind, "wait");
});

test("evaluateRollup: not-required contexts ignored", () => {
  const ctx = [
    { kind: "CheckRun", name: "optional", isRequired: false, conclusion: "FAILURE", status: "COMPLETED" },
  ];
  // No required contexts → vacuous pass behavior.
  const r1 = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: false });
  assert.equal(r1.kind, "wait");        // vacuous → wait without override
  const r2 = evaluateRollup({ mismatch: false, contexts: ctx, headRefOid: "sha" }, { allowNoRequiredChecks: true });
  assert.equal(r2.kind, "ready");
});
