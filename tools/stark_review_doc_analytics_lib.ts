/**
 * Analytics + process-health judgment for the doc-review dispatcher
 * (`stark_review_doc.ts`).
 *
 * Pure functions only — no I/O. The dispatcher feeds per-round stats in as
 * they happen; this module (a) decides inline whether the loop has gone
 * pathological and should stop (circuit breakers), and (b) assembles the
 * final analytics payload + markdown sidecar that monitors and judges the
 * whole run.
 *
 * Motivating failure mode: a 200-line spec that balloons to 80k lines over
 * 10 rounds because every round's fixes create next round's findings. The
 * guards catch that at round 2-3 instead of round 10.
 */
import type { DomainCoverage } from "./stark_review_doc_lib.ts";

// ─── Types ───────────────────────────────────────────────────────────────

export type RoundKind = "review-fix" | "final-review" | "coherence";

export interface RoundStat {
  round: number;
  kind: RoundKind;
  doc_chars_before: number;
  doc_chars_after: number;
  doc_lines_before: number;
  doc_lines_after: number;
  raw_findings: number;
  to_fix: number;
  recurring: number;
  patches_attempted: number;
  patches_applied: number;
  patch_failures: number;
  duration_s: number;
}

export interface AnalyticsThresholds {
  /** Abort when final doc chars exceed this multiple of the original. */
  max_doc_growth_ratio: number;
  /** Flag (degraded) when a single round grows the doc by more than this multiple. */
  max_round_growth_ratio: number;
  /** Abort when `to_fix` fails to decline for this many consecutive review-fix rounds. */
  non_convergent_rounds: number;
  /** Flag (degraded) when recurring findings are more than this share of to_fix. */
  churn_recurring_share: number;
}

export const DEFAULT_ANALYTICS_THRESHOLDS: AnalyticsThresholds = {
  max_doc_growth_ratio: 2.0,
  max_round_growth_ratio: 1.5,
  non_convergent_rounds: 2,
  churn_recurring_share: 0.5,
};

export type HealthFlag =
  | "runaway_growth"      // doc grew past max_doc_growth_ratio × original
  | "round_growth_spike"  // a single round grew the doc past max_round_growth_ratio
  | "non_convergent"      // to_fix did not decline for N consecutive rounds
  | "no_net_convergence"  // the run ended with as many findings as it started with
  | "churn"               // recurring findings dominate — fixes aren't sticking
  | "patch_thrash"        // most attempted patches failed to apply
  | "coverage_gap";       // ≥1 domain never completed a review in any round

export type HealthGrade = "healthy" | "degraded" | "runaway";

export interface GuardVerdict {
  /** True when the dispatcher should stop the fix loop now. */
  abort: boolean;
  /** Human-readable reason for the abort (null when abort is false). */
  abort_reason: string | null;
  /** All flags raised so far (abort-worthy or advisory). */
  flags: HealthFlag[];
  /** Growth breached the ratio limit but findings are converging — the run
   * continues, but the operator must ack the growth before findings are
   * posted (the skills' Phase 4 gate). */
  growth_ack_required: boolean;
}

export interface ReviewAnalytics {
  doc: string;
  prompts_dir: string;
  generated_at: string;
  original: { chars: number; lines: number };
  final: { chars: number; lines: number };
  /** final.chars / original.chars (1.0 when original is empty). */
  growth_ratio: number;
  rounds: RoundStat[];
  flags: HealthFlag[];
  grade: HealthGrade;
  aborted_early: boolean;
  abort_reason: string | null;
  /** Doc grew past the ratio limit while findings kept declining — the run
   * completed, but the operator must ack the growth before Phase 5 posts. */
  growth_ack_required: boolean;
  /** Domains that never completed a review in any round (coverage gaps). */
  coverage_gaps: string[];
  /** Per-domain completion counts across the whole run (null when the
   * dispatcher predates coverage tracking or errored before round 1). */
  coverage: Record<string, DomainCoverage> | null;
  /** Free-form judged observations rendered into the sidecar. */
  notes: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function ratio(after: number, before: number): number {
  if (before <= 0) return after > 0 ? Number.POSITIVE_INFINITY : 1;
  return after / before;
}

// ─── Inline circuit breakers ─────────────────────────────────────────────

/**
 * Evaluate the process-health guards after a review-fix round.
 *
 * `roundStats` must contain only completed rounds (review-fix ones drive the
 * convergence check; coherence/final rounds are ignored for it). Aborts on:
 *   - runaway growth vs the ORIGINAL doc (the compounding case), or
 *   - `to_fix` not declining for `non_convergent_rounds` consecutive rounds.
 * Everything else (round spike, churn, patch thrash) is advisory — flagged
 * but not loop-stopping.
 */
export function evaluateGuards(
  originalChars: number,
  roundStats: readonly RoundStat[],
  thresholds: AnalyticsThresholds,
): GuardVerdict {
  const flags = new Set<HealthFlag>();
  let abort = false;
  let abortReason: string | null = null;

  const fixRounds = roundStats.filter((r) => r.kind === "review-fix");
  const last = fixRounds[fixRounds.length - 1];

  // Advisory: single-round growth spike + patch thrash + churn.
  for (const r of fixRounds) {
    if (ratio(r.doc_chars_after, r.doc_chars_before) > thresholds.max_round_growth_ratio) {
      flags.add("round_growth_spike");
    }
    if (r.patches_attempted >= 3 && r.patch_failures / r.patches_attempted > 0.5) {
      flags.add("patch_thrash");
    }
    if (r.to_fix > 0 && r.recurring / r.to_fix > thresholds.churn_recurring_share) {
      flags.add("churn");
    }
  }

  // Growth vs original — a real signal but NOT a hard stop on its own:
  // legitimate gap-filling on a thin document is indistinguishable from
  // padding by this ratio alone (a real spec review tripped at 2.63× while
  // findings were declining — correct behavior, punished). Growth alone
  // demands an operator ack; growth AND non-convergence together abort.
  const growthRatio = last ? ratio(last.doc_chars_after, originalChars) : 0;
  const growthBreach = growthRatio > thresholds.max_doc_growth_ratio;
  if (growthBreach) flags.add("runaway_growth");

  // Non-convergence — to_fix did not decline for N consecutive rounds: the
  // wing is spinning its wheels. Aborts on its own.
  const n = thresholds.non_convergent_rounds;
  let nonConvergent = false;
  if (fixRounds.length >= n + 1) {
    let stuck = 0;
    for (let i = fixRounds.length - n; i < fixRounds.length; i++) {
      const cur = fixRounds[i]!;
      const prev = fixRounds[i - 1]!;
      if (cur.to_fix > 0 && cur.to_fix >= prev.to_fix) stuck++;
    }
    nonConvergent = stuck >= n;
  }
  if (nonConvergent) flags.add("non_convergent");

  if (nonConvergent && growthBreach) {
    abort = true;
    abortReason = `doc grew ${growthRatio.toFixed(2)}x vs original (limit ${thresholds.max_doc_growth_ratio}x) AND findings did not decline for ${n} consecutive rounds — the loop is padding, not converging`;
  } else if (nonConvergent) {
    abort = true;
    abortReason = `findings did not decline for ${n} consecutive rounds (last: ${last?.to_fix ?? 0} to fix)`;
  }

  return {
    abort,
    abort_reason: abortReason,
    flags: [...flags],
    growth_ack_required: growthBreach && !abort,
  };
}

// ─── Final judgment ──────────────────────────────────────────────────────

export function judgeGrade(flags: readonly HealthFlag[]): HealthGrade {
  // Growth alone is degraded, not runaway: it needs an operator's judgment
  // (gap-filling vs padding), not a verdict. Non-convergence — with or
  // without growth — is the loop demonstrably failing: runaway.
  if (flags.includes("non_convergent")) return "runaway";
  if (flags.length > 0) return "degraded";
  return "healthy";
}

/**
 * Net-convergence check across the WHOLE run (advisory, not loop-stopping —
 * it needs the final review, which only exists after the loop).
 *
 * The consecutive-rounds breaker misses the decline-then-rise shape
 * (44 → 35 → 45): each pair alternates so `stuck` never reaches N, yet the
 * run ends with as many open findings as it started with. Judge that here:
 * the last measured findings count (the final review's `to_fix` when present,
 * else the last fix round's) must be meaningfully below round 1's, or the
 * review process spent its rounds treading water.
 */
export function hasNetConvergence(roundStats: readonly RoundStat[]): boolean {
  const fixRounds = roundStats.filter((r) => r.kind === "review-fix");
  if (fixRounds.length < 2) return true; // too short to judge
  const first = fixRounds[0]!;
  if (first.to_fix === 0) return true;
  const finalReview = [...roundStats].reverse().find((r) => r.kind === "final-review");
  const last = finalReview ?? fixRounds[fixRounds.length - 1]!;
  return last.to_fix < first.to_fix * 0.8;
}

export function buildAnalytics(opts: {
  doc: string;
  promptsDir: string;
  originalDoc: string;
  finalDoc: string;
  roundStats: RoundStat[];
  thresholds: AnalyticsThresholds;
  abortedEarly: boolean;
  abortReason: string | null;
  extraFlags?: HealthFlag[];
  coverage?: Record<string, DomainCoverage> | null;
  coverageGaps?: string[];
}): ReviewAnalytics {
  const guard = evaluateGuards(opts.originalDoc.length, opts.roundStats, opts.thresholds);
  const flags = [...new Set([...guard.flags, ...(opts.extraFlags ?? [])])];
  if (!hasNetConvergence(opts.roundStats) && !flags.includes("non_convergent")) {
    flags.push("no_net_convergence");
  }
  const coverageGaps = opts.coverageGaps ?? [];
  if (coverageGaps.length > 0 && !flags.includes("coverage_gap")) {
    flags.push("coverage_gap");
  }
  const originalChars = opts.originalDoc.length;
  const finalChars = opts.finalDoc.length;

  const notes: string[] = [];
  const fixRounds = opts.roundStats.filter((r) => r.kind === "review-fix");
  if (fixRounds.length > 0) {
    const first = fixRounds[0]!;
    const last = fixRounds[fixRounds.length - 1]!;
    notes.push(
      `Findings trajectory: ${fixRounds.map((r) => r.to_fix).join(" → ")} across ${fixRounds.length} fix round(s).`,
    );
    if (last.to_fix < first.to_fix) notes.push("Convergence: declining — the loop is working.");
    else if (fixRounds.length > 1) notes.push("Convergence: NOT declining — later rounds are generating as much work as they resolve.");
  }
  const coherence = opts.roundStats.find((r) => r.kind === "coherence");
  if (coherence) {
    const delta = coherence.doc_chars_after - coherence.doc_chars_before;
    notes.push(`Coherence pass: ${coherence.patches_applied} patch(es), ${delta <= 0 ? "removed" : "added"} ${Math.abs(delta)} chars.`);
  }
  if (guard.growth_ack_required) {
    notes.push(`Growth ack required: the doc grew ${(opts.finalDoc.length / Math.max(1, opts.originalDoc.length)).toFixed(2)}x (limit ${opts.thresholds.max_doc_growth_ratio}x) while findings kept declining. The breaker did not stop the run — legitimate gap-filling on a thin doc looks like this — but the operator must judge growth vs padding before findings are posted.`);
  }
  if (coverageGaps.length > 0) {
    const detail = coverageGaps
      .map((d) => {
        const c = opts.coverage?.[d];
        return c ? `${d} (0/${c.attempts} rounds${c.timeouts > 0 ? `, ${c.timeouts} timeouts` : ""})` : d;
      })
      .join(", ");
    notes.push(`Coverage gap: ${detail} never completed a review in ANY round — zero findings from these domains means "never ran", not "clean". The grade is capped and the run is not ok until they complete.`);
  }
  if (flags.includes("no_net_convergence")) notes.push("No net convergence: the run ended with roughly as many open findings as round 1 started with — the rounds spent their budget treading water. Consider tighter prompts or reviewing the unresolved list by hand instead of more rounds.");
  if (flags.includes("churn")) notes.push("Churn: a large share of findings recur across rounds — fixes are not sticking or reviewers keep re-flagging authored content.");
  if (flags.includes("patch_thrash")) notes.push("Patch thrash: most wing patches failed unique-match validation.");
  if (flags.includes("round_growth_spike")) notes.push("At least one round grew the document sharply — fixes are adding prose instead of tightening it.");

  return {
    doc: opts.doc,
    prompts_dir: opts.promptsDir,
    generated_at: new Date().toISOString(),
    original: { chars: originalChars, lines: countLines(opts.originalDoc) },
    final: { chars: finalChars, lines: countLines(opts.finalDoc) },
    growth_ratio: originalChars > 0 ? Number((finalChars / originalChars).toFixed(3)) : 1,
    rounds: opts.roundStats,
    flags,
    grade: judgeGrade(flags),
    aborted_early: opts.abortedEarly,
    abort_reason: opts.abortReason,
    growth_ack_required: guard.growth_ack_required,
    coverage_gaps: coverageGaps,
    coverage: opts.coverage ?? null,
    notes,
  };
}

// ─── Sidecar rendering ───────────────────────────────────────────────────

const GRADE_BADGE: Record<HealthGrade, string> = {
  healthy: "🟢 healthy",
  degraded: "🟡 degraded",
  runaway: "🔴 runaway",
};

function renderCoverageLine(a: ReviewAnalytics): string {
  if (a.coverage_gaps.length > 0) {
    const detail = a.coverage_gaps
      .map((d) => {
        const c = a.coverage?.[d];
        return c ? `${d} (0/${c.attempts}${c.timeouts > 0 ? `, ${c.timeouts} timeouts` : ""})` : d;
      })
      .join("; ");
    return `- **Coverage:** ⚠️ GAP — never completed: ${detail}`;
  }
  if (a.coverage && Object.keys(a.coverage).length > 0) {
    return `- **Coverage:** all ${Object.keys(a.coverage).length} domains completed`;
  }
  return `- **Coverage:** not tracked (pre-coverage run)`;
}

export function renderAnalyticsMarkdown(a: ReviewAnalytics): string {
  const lines: string[] = [
    `# Review process analytics — ${a.doc}`,
    "",
    `- **Grade:** ${GRADE_BADGE[a.grade]}${a.flags.length > 0 ? ` (${a.flags.join(", ")})` : ""}`,
    `- **Pipeline:** ${a.prompts_dir}`,
    `- **Doc size:** ${a.original.lines} → ${a.final.lines} lines (${a.original.chars} → ${a.final.chars} chars, ${a.growth_ratio}x)`,
    `- **Rounds:** ${a.rounds.length}${a.aborted_early ? ` — **stopped early:** ${a.abort_reason}` : ""}`,
    ...(a.growth_ack_required ? [`- **⚠️ Growth ack required:** ${a.growth_ratio}x growth with declining findings — operator must judge gap-filling vs padding`] : []),
    renderCoverageLine(a),
    `- **Generated:** ${a.generated_at}`,
    "",
    "| Round | Kind | Findings raw→fix (recurring) | Patches applied/attempted (failed) | Doc lines | Duration |",
    "|-------|------|------------------------------|------------------------------------|-----------|----------|",
  ];
  for (const r of a.rounds) {
    lines.push(
      `| ${r.round} | ${r.kind} | ${r.raw_findings}→${r.to_fix} (${r.recurring}) | ${r.patches_applied}/${r.patches_attempted} (${r.patch_failures}) | ${r.doc_lines_before}→${r.doc_lines_after} | ${r.duration_s.toFixed(0)}s |`,
    );
  }
  if (a.notes.length > 0) {
    lines.push("", "## Judgment", "");
    for (const n of a.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─── PR-cycle (code review) analytics ────────────────────────────────────

/** One review round of the PR cycle, as recorded in its round-N.json history
 * files (`stark_review.ts` writeRoundHistory). Structural — pass the parsed
 * history payloads straight in. */
export interface CodeReviewRoundInput {
  round: number;
  results: ReadonlyArray<{
    agent: string;
    domain: string;
    duration_s: number;
    error: string | null;
    findings: ReadonlyArray<{ domain?: string; classification?: string }>;
  }>;
}

export interface CodeReviewAnalytics {
  kind: "code-review";
  repo: string;
  pr: number;
  generated_at: string;
  grade: HealthGrade;
  flags: HealthFlag[];
  /** Domains that never completed a review in any round of this run. */
  coverage_gaps: string[];
  per_domain: Record<string, {
    attempts: number;
    completions: number;
    timeouts: number;
    total_duration_s: number;
    findings_by_classification: Record<string, number>;
  }>;
  rounds: number;
  total_findings: number;
  total_duration_s: number;
  notes: string[];
}

/** Aggregate a PR-review run's rounds into the two answers the operator asks:
 * where did the time go (per-domain durations + outcomes) and who produces
 * signal vs noise (per-domain classification counts). Coverage gaps cap the
 * grade exactly like the doc cycle. */
export function buildCodeReviewAnalytics(opts: {
  repo: string;
  pr: number;
  rounds: readonly CodeReviewRoundInput[];
}): CodeReviewAnalytics {
  const per: CodeReviewAnalytics["per_domain"] = {};
  let totalFindings = 0;
  let totalDuration = 0;
  const bucket = (domain: string) =>
    per[domain] ?? (per[domain] = {
      attempts: 0, completions: 0, timeouts: 0,
      total_duration_s: 0, findings_by_classification: {},
    });
  for (const round of opts.rounds) {
    for (const r of round.results) {
      const b = bucket(r.domain);
      b.attempts++;
      b.total_duration_s += r.duration_s;
      totalDuration += r.duration_s;
      if (r.error === null) b.completions++;
      else if (r.error === "timeout") b.timeouts++;
      for (const f of r.findings) {
        const c = f.classification ?? "unclassified";
        const fb = bucket(f.domain ?? r.domain);
        fb.findings_by_classification[c] = (fb.findings_by_classification[c] ?? 0) + 1;
        totalFindings++;
      }
    }
  }
  const gaps = Object.keys(per)
    .filter((d) => per[d]!.attempts > 0 && per[d]!.completions === 0)
    .sort();
  const flags: HealthFlag[] = gaps.length > 0 ? ["coverage_gap"] : [];
  const notes: string[] = [];
  if (gaps.length > 0) {
    notes.push(`Coverage gap: ${gaps.join(", ")} never completed a review in this run — zero findings from these domains means "never ran", not "clean".`);
  }
  const noisy = Object.entries(per)
    .map(([d, b]) => {
      const fx = b.findings_by_classification;
      const noise = (fx.noise ?? 0) + (fx.false_positive ?? 0);
      const total = Object.values(fx).reduce((a, n) => a + n, 0);
      return { d, noise, total };
    })
    .filter((x) => x.total >= 3 && x.noise / x.total > 0.5);
  for (const n of noisy) {
    notes.push(`Noisy domain: ${n.d} — ${n.noise}/${n.total} findings classified noise/false_positive. Candidate for /stark-review-improvement.`);
  }
  return {
    kind: "code-review",
    repo: opts.repo,
    pr: opts.pr,
    generated_at: new Date().toISOString(),
    grade: judgeGrade(flags),
    flags,
    coverage_gaps: gaps,
    per_domain: per,
    rounds: opts.rounds.length,
    total_findings: totalFindings,
    total_duration_s: Number(totalDuration.toFixed(1)),
    notes,
  };
}

export function renderCodeReviewAnalyticsMarkdown(a: CodeReviewAnalytics): string {
  const lines: string[] = [
    `# Review process analytics — ${a.repo}#${a.pr}`,
    "",
    `- **Grade:** ${GRADE_BADGE[a.grade]}${a.flags.length > 0 ? ` (${a.flags.join(", ")})` : ""}`,
    `- **Rounds:** ${a.rounds} — ${a.total_findings} findings, ${a.total_duration_s.toFixed(0)}s total review time`,
    a.coverage_gaps.length > 0
      ? `- **Coverage:** ⚠️ GAP — never completed: ${a.coverage_gaps.join("; ")}`
      : `- **Coverage:** all ${Object.keys(a.per_domain).length} domains completed`,
    `- **Generated:** ${a.generated_at}`,
    "",
    "| Domain | Runs (ok/timeout) | Time | fix | noise | fp | ignored |",
    "|--------|-------------------|------|-----|-------|----|---------|",
  ];
  for (const [d, b] of Object.entries(a.per_domain).sort()) {
    const fx = b.findings_by_classification;
    lines.push(
      `| ${d} | ${b.completions}/${b.attempts}${b.timeouts > 0 ? ` (${b.timeouts} t/o)` : ""} | ${b.total_duration_s.toFixed(0)}s | ${fx.fix ?? 0} | ${fx.noise ?? 0} | ${fx.false_positive ?? 0} | ${fx.ignored ?? 0} |`,
    );
  }
  if (a.notes.length > 0) {
    lines.push("", "## Judgment", "");
    for (const n of a.notes) lines.push(`- ${n}`);
  }
  lines.push("");
  return lines.join("\n");
}
