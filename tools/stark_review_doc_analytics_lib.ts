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
  | "patch_thrash";       // most attempted patches failed to apply

export type HealthGrade = "healthy" | "degraded" | "runaway";

export interface GuardVerdict {
  /** True when the dispatcher should stop the fix loop now. */
  abort: boolean;
  /** Human-readable reason for the abort (null when abort is false). */
  abort_reason: string | null;
  /** All flags raised so far (abort-worthy or advisory). */
  flags: HealthFlag[];
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

  // Abort: total growth vs original.
  if (last && ratio(last.doc_chars_after, originalChars) > thresholds.max_doc_growth_ratio) {
    flags.add("runaway_growth");
    abort = true;
    abortReason = `doc grew ${ratio(last.doc_chars_after, originalChars).toFixed(2)}x vs original (limit ${thresholds.max_doc_growth_ratio}x)`;
  }

  // Abort: non-convergence — to_fix did not decline for N consecutive rounds.
  const n = thresholds.non_convergent_rounds;
  if (!abort && fixRounds.length >= n + 1) {
    let stuck = 0;
    for (let i = fixRounds.length - n; i < fixRounds.length; i++) {
      const cur = fixRounds[i]!;
      const prev = fixRounds[i - 1]!;
      if (cur.to_fix > 0 && cur.to_fix >= prev.to_fix) stuck++;
    }
    if (stuck >= n) {
      flags.add("non_convergent");
      abort = true;
      abortReason = `findings did not decline for ${n} consecutive rounds (last: ${last?.to_fix ?? 0} to fix)`;
    }
  }

  return { abort, abort_reason: abortReason, flags: [...flags] };
}

// ─── Final judgment ──────────────────────────────────────────────────────

export function judgeGrade(flags: readonly HealthFlag[]): HealthGrade {
  if (flags.includes("runaway_growth") || flags.includes("non_convergent")) return "runaway";
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
}): ReviewAnalytics {
  const guard = evaluateGuards(opts.originalDoc.length, opts.roundStats, opts.thresholds);
  const flags = [...new Set([...guard.flags, ...(opts.extraFlags ?? [])])];
  if (!hasNetConvergence(opts.roundStats) && !flags.includes("non_convergent")) {
    flags.push("no_net_convergence");
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
    notes,
  };
}

// ─── Sidecar rendering ───────────────────────────────────────────────────

const GRADE_BADGE: Record<HealthGrade, string> = {
  healthy: "🟢 healthy",
  degraded: "🟡 degraded",
  runaway: "🔴 runaway",
};

export function renderAnalyticsMarkdown(a: ReviewAnalytics): string {
  const lines: string[] = [
    `# Review process analytics — ${a.doc}`,
    "",
    `- **Grade:** ${GRADE_BADGE[a.grade]}${a.flags.length > 0 ? ` (${a.flags.join(", ")})` : ""}`,
    `- **Pipeline:** ${a.prompts_dir}`,
    `- **Doc size:** ${a.original.lines} → ${a.final.lines} lines (${a.original.chars} → ${a.final.chars} chars, ${a.growth_ratio}x)`,
    `- **Rounds:** ${a.rounds.length}${a.aborted_early ? ` — **stopped early:** ${a.abort_reason}` : ""}`,
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
