import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildAnalytics,
  countLines,
  DEFAULT_ANALYTICS_THRESHOLDS,
  evaluateGuards,
  hasNetConvergence,
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

test("growth alone (findings declining) warns + requires ack — no abort, degraded", () => {
  // The 2026-07-14 incident shape: 2.1× growth while findings decline 3 → 2.
  const rounds = [
    stat({ round: 1, doc_chars_after: 1400 }),
    stat({ round: 2, to_fix: 2, doc_chars_before: 1400, doc_chars_after: 2100 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, false);
  assert.equal(v.growth_ack_required, true);
  assert.ok(v.flags.includes("runaway_growth"));
  assert.equal(judgeGrade(v.flags), "degraded");
});

test("growth AND non-convergence together hard-stop with a composite reason", () => {
  const rounds = [
    stat({ round: 1, to_fix: 4, doc_chars_after: 1400 }),
    stat({ round: 2, to_fix: 5, doc_chars_before: 1400, doc_chars_after: 1800 }),
    stat({ round: 3, to_fix: 6, doc_chars_before: 1800, doc_chars_after: 2100 }),
  ];
  const v = evaluateGuards(1000, rounds, DEFAULT_ANALYTICS_THRESHOLDS);
  assert.equal(v.abort, true);
  assert.equal(v.growth_ack_required, false);
  assert.ok(v.flags.includes("runaway_growth"));
  assert.ok(v.flags.includes("non_convergent"));
  assert.match(v.abort_reason!, /AND findings did not decline/);
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

test("decline-then-rise trajectory flags no_net_convergence and grades degraded", () => {
  // The Atlas spec-review shape: 44 → 35 → 45 fix rounds, 48 unresolved at final.
  const rounds = [
    stat({ round: 1, to_fix: 44 }),
    stat({ round: 2, to_fix: 35 }),
    stat({ round: 3, to_fix: 45 }),
    stat({ round: 4, kind: "final-review", to_fix: 48 }),
  ];
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "spec-review",
    originalDoc: "a".repeat(1000),
    finalDoc: "a".repeat(1300),
    roundStats: rounds,
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false,
    abortReason: null,
  });
  assert.ok(a.flags.includes("no_net_convergence"));
  assert.equal(a.grade, "degraded");
  assert.ok(a.notes.some((n) => n.startsWith("No net convergence")));
});

test("real convergence does not trip no_net_convergence", () => {
  const rounds = [
    stat({ round: 1, to_fix: 20 }),
    stat({ round: 2, to_fix: 8 }),
    stat({ round: 3, kind: "final-review", to_fix: 3 }),
  ];
  const a = buildAnalytics({
    doc: "d.md", promptsDir: "spec-review",
    originalDoc: "a".repeat(1000), finalDoc: "a".repeat(1100),
    roundStats: rounds, thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false, abortReason: null,
  });
  assert.ok(!a.flags.includes("no_net_convergence"));
  assert.equal(a.grade, "healthy");
});

test("single fix round never trips no_net_convergence", () => {
  assert.equal(hasNetConvergence([stat({ round: 1, to_fix: 40 }), stat({ round: 2, kind: "final-review", to_fix: 40 })]), true);
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
  // Non-convergence is the abort-worthy runaway; growth alone is degraded +
  // ack (see the composite-signal tests above).
  const rounds = [
    stat({ round: 1, to_fix: 4 }),
    stat({ round: 2, to_fix: 5 }),
    stat({ round: 3, to_fix: 6 }),
  ];
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "plan-review",
    originalDoc: "a".repeat(1000),
    finalDoc: "a".repeat(1100),
    roundStats: rounds,
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: true,
    abortReason: "findings did not decline for 2 consecutive rounds (last: 6 to fix)",
  });
  assert.equal(a.grade, "runaway");
  assert.equal(a.aborted_early, true);
  const md = renderAnalyticsMarkdown(a);
  assert.match(md, /🔴 runaway/);
  assert.match(md, /stopped early/);
});

test("growth-ack analytics: degraded grade, field set, sidecar warns", () => {
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "plan-review",
    originalDoc: "a".repeat(1000),
    finalDoc: "a".repeat(3000),
    roundStats: [stat({ round: 1, to_fix: 3, doc_chars_after: 2000 }), stat({ round: 2, to_fix: 1, doc_chars_before: 2000, doc_chars_after: 3000 })],
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false,
    abortReason: null,
  });
  assert.equal(a.grade, "degraded");
  assert.equal(a.growth_ack_required, true);
  assert.ok(a.notes.some((n) => n.includes("Growth ack required")));
  assert.match(renderAnalyticsMarkdown(a), /Growth ack required/);
});

// ─── Coverage gaps in analytics ──────────────────────────────────────────

test("coverage gap caps the grade at degraded and renders in the sidecar", () => {
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "plan-review",
    originalDoc: "x".repeat(1000),
    finalDoc: "x".repeat(1100),
    roundStats: [stat({ to_fix: 3 }), stat({ round: 2, to_fix: 1 })],
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false,
    abortReason: null,
    coverage: {
      viability: { attempts: 3, completions: 0, timeouts: 3, last_error: "timeout" },
      security: { attempts: 3, completions: 3, timeouts: 0, last_error: null },
    },
    coverageGaps: ["viability"],
  });
  assert.equal(a.grade, "degraded");
  assert.ok(a.flags.includes("coverage_gap"));
  assert.deepEqual(a.coverage_gaps, ["viability"]);
  assert.ok(a.notes.some((n) => n.includes("Coverage gap")));
  const md = renderAnalyticsMarkdown(a);
  assert.match(md, /Coverage:.*GAP.*viability \(0\/3, 3 timeouts\)/);
});

test("clean coverage stays healthy and renders the all-domains line", () => {
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "plan-review",
    originalDoc: "x".repeat(1000),
    finalDoc: "x".repeat(1100),
    roundStats: [stat({ to_fix: 3 }), stat({ round: 2, to_fix: 1 })],
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: false,
    abortReason: null,
    coverage: { security: { attempts: 2, completions: 2, timeouts: 0, last_error: null } },
    coverageGaps: [],
  });
  assert.equal(a.grade, "healthy");
  assert.ok(!a.flags.includes("coverage_gap"));
  assert.match(renderAnalyticsMarkdown(a), /all 1 domains completed/);
});

test("runaway stays runaway even with coverage gaps (gap does not downgrade)", () => {
  const a = buildAnalytics({
    doc: "d.md",
    promptsDir: "spec-review",
    originalDoc: "x".repeat(1000),
    finalDoc: "x".repeat(1100),
    roundStats: [
      stat({ round: 1, to_fix: 4 }),
      stat({ round: 2, to_fix: 5 }),
      stat({ round: 3, to_fix: 6 }),
    ],
    thresholds: DEFAULT_ANALYTICS_THRESHOLDS,
    abortedEarly: true,
    abortReason: "findings did not decline for 2 consecutive rounds (last: 6 to fix)",
    coverage: { viability: { attempts: 1, completions: 0, timeouts: 1, last_error: "timeout" } },
    coverageGaps: ["viability"],
  });
  assert.equal(a.grade, "runaway");
  assert.ok(a.flags.includes("coverage_gap"));
});

// ─── PR-cycle analytics ──────────────────────────────────────────────────

import { buildCodeReviewAnalytics, renderCodeReviewAnalyticsMarkdown } from "./stark_review_doc_analytics_lib.ts";

test("buildCodeReviewAnalytics aggregates per-domain time, noise, and coverage", () => {
  const a = buildCodeReviewAnalytics({
    repo: "o/r",
    pr: 7,
    rounds: [
      {
        round: 1,
        results: [
          { agent: "codex", domain: "security", duration_s: 120, error: null,
            findings: [{ domain: "security", classification: "fix" }, { domain: "security", classification: "noise" }] },
          { agent: "codex", domain: "behavior", duration_s: 600, error: "timeout", findings: [] },
        ],
      },
      {
        round: 2,
        results: [
          { agent: "codex", domain: "security", duration_s: 100, error: null,
            findings: [{ domain: "security", classification: "false_positive" }] },
          { agent: "codex", domain: "behavior", duration_s: 600, error: "timeout", findings: [] },
        ],
      },
    ],
  });
  assert.equal(a.kind, "code-review");
  assert.deepEqual(a.coverage_gaps, ["behavior"]);
  assert.equal(a.grade, "degraded");
  assert.equal(a.per_domain.security!.total_duration_s, 220);
  assert.equal(a.per_domain.behavior!.timeouts, 2);
  assert.equal(a.per_domain.security!.findings_by_classification.fix, 1);
  assert.equal(a.total_findings, 3);
  const md = renderCodeReviewAnalyticsMarkdown(a);
  assert.match(md, /GAP — never completed: behavior/);
  assert.match(md, /\| security \| 2\/2 /);
});

test("buildCodeReviewAnalytics: clean run is healthy with no notes about gaps", () => {
  const a = buildCodeReviewAnalytics({
    repo: "o/r",
    pr: 8,
    rounds: [
      { round: 1, results: [{ agent: "codex", domain: "security", duration_s: 60, error: null, findings: [] }] },
    ],
  });
  assert.equal(a.grade, "healthy");
  assert.deepEqual(a.coverage_gaps, []);
  assert.match(renderCodeReviewAnalyticsMarkdown(a), /all 1 domains completed/);
});
