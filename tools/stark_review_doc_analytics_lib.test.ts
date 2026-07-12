import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalytics,
  countLines,
  DEFAULT_ANALYTICS_THRESHOLDS,
  evaluateGuards,
  judgeGrade,
  renderAnalyticsMarkdown,
  type RoundStat,
} from "./stark_review_doc_analytics_lib.ts";

function stat(over: Partial<RoundStat>): RoundStat {
  return {
    round: 1,
    kind: "review-fix",
    doc_chars_before: 1000,
    doc_chars_after: 1000,
    doc_lines_before: 50,
    doc_lines_after: 50,
    raw_findings: 5,
    to_fix: 3,
    recurring: 0,
    patches_attempted: 3,
    patches_applied: 3,
    patch_failures: 0,
    duration_s: 60,
    ...over,
  };
}

test("countLines", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\nb\n"), 3);
});

test("healthy run raises no flags and does not abort", () => {
  const rounds = [
    stat({ round: 1, to_fix: 5, doc_chars_after: 1100 }),
    stat({ round: 2, to_fix: 2, doc_chars_before: 1100, doc_chars_after: 1150 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, false);
  assert.deepEqual(v.flags, []);
  assert.equal(judgeGrade(v.flags), "healthy");
});

test("runaway growth vs original aborts", () => {
  const rounds = [
    stat({ round: 1, doc_chars_after: 1400 }),
    stat({ round: 2, to_fix: 2, doc_chars_before: 1400, doc_chars_after: 2100 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, true);
  assert.ok(v.flags.includes("runaway_growth"));
  assert.match(v.abort_reason!, /2\.10x/);
  assert.equal(judgeGrade(v.flags), "runaway");
});

test("non-convergence over N consecutive rounds aborts", () => {
  const rounds = [
    stat({ round: 1, to_fix: 4 }),
    stat({ round: 2, to_fix: 5 }),
    stat({ round: 3, to_fix: 6 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, true);
  assert.ok(v.flags.includes("non_convergent"));
});

test("declining findings do not trip non-convergence", () => {
  const rounds = [
    stat({ round: 1, to_fix: 6 }),
    stat({ round: 2, to_fix: 4 }),
    stat({ round: 3, to_fix: 2 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, false);
});

test("advisory flags: round spike, churn, patch thrash — degraded, no abort", () => {
  const rounds = [
    stat({
      round: 1,
      doc_chars_before: 1000,
      doc_chars_after: 1600, // 1.6x round growth > 1.5
      to_fix: 4,
      recurring: 3, // 0.75 > 0.5 churn share
      patches_attempted: 4,
      patches_applied: 1,
      patch_failures: 3, // 0.75 > 0.5 thrash
    }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, false);
  assert.ok(v.flags.includes("round_growth_spike"));
  assert.ok(v.flags.includes("churn"));
  assert.ok(v.flags.includes("patch_thrash"));
  assert.equal(judgeGrade(v.flags), "degraded");
});

test("coherence and final-review rounds are ignored by the guards", () => {
  const rounds = [
    stat({ round: 1, to_fix: 3 }),
    stat({ round: 2, kind: "coherence", doc_chars_before: 1000, doc_chars_after: 5000, to_fix: 0 }),
    stat({ round: 3, kind: "final-review", to_fix: 9 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, false);
});

test("buildAnalytics assembles payload with trajectory notes", () => {
  const rounds = [
    stat({ round: 1, to_fix: 5, doc_chars_after: 1100 }),
    stat({ round: 2, to_fix: 1, doc_chars_before: 1100, doc_chars_after: 1120 }),
    stat({
      round: 3, kind: "coherence", to_fix: 0,
      doc_chars_before: 1120, doc_chars_after: 1050,
      patches_attempted: 2, patches_applied: 2, patch_failures: 0,
    }),
  ];
  const a = buildAnalytics({
    doc: "docs/specs/x.md",
    promptsDir: "spec-review",
    originalDoc: "a".repeat(1000),
    finalDoc: "a".repeat(1050),
    roundStats: rounds,
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false,
    abortReason: null,
  });
  assert.equal(a.grade, "healthy");
  assert.equal(a.growth_ratio, 1.05);
  assert.ok(a.notes.some((n) => n.includes("5 → 1")));
  assert.ok(a.notes.some((n) => n.startsWith("Coherence pass: 2 patch(es), removed 70")));

  const md = renderAnalyticsMarkdown(a);
  assert.match(md, /🟢 healthy/);
  assert.match(md, /\| 3 \| coherence \|/);
});

test("aborted runaway analytics renders the abort reason", () => {
  const rounds = [
    stat({ round: 1, doc_chars_after: 3000 }),
  ];
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "plan-review",
    originalDoc: "a".repeat(1000),
    finalDoc: "a".repeat(3000),
    roundStats: rounds,
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: true,
    abortReason: "doc grew 3.00x vs original (limit 2x)",
  });
  assert.equal(a.grade, "runaway");
  assert.equal(a.aborted_early, true);
  const md = renderAnalyticsMarkdown(a);
  assert.match(md, /🔴 runaway/);
  assert.match(md, /stopped early/);
});
