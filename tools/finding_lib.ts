/**
 * finding_lib.ts — the finding model shared by every reviewer-adjacent tool.
 *
 * Extracted from `stark_review_lib.ts` when `/stark-review` was buried
 * (STARK-6098 — see the nastrond grave `graves/stark-skills/stark-review`).
 * The dispatcher died; this model did not, because three living consumers hold
 * it up:
 *
 *   - `findings_review_post.ts` — maps `/code-review`'s `ReportFindings`
 *     payload onto `Finding` before posting it to a PR
 *   - `agent_claude.ts` / `agent_codex.ts` / `agent_gemini.ts` — the agent
 *     ports parse subprocess output into `Finding`s; `/stark-jury` imports them
 *   - `review_post_lib.ts` — sorts and partitions findings for posting
 *
 * Pure: types plus deterministic string/number helpers. No I/O, no spawn.
 */
import { createHash } from "node:crypto";

export type AgentName = "claude" | "codex" | "gemini";

export type Severity = "critical" | "high" | "medium" | "low";

export type Classification = "fix" | "false_positive" | "noise" | "ignored";

/**
 * Why a finding is rendered in the review body instead of as an inline thread.
 *
 * Absent is the classic case and stays unlabelled: the finding has no anchor at
 * all, or its file/line is outside the PR's diff. Those are what the body's
 * long-standing "Cross-cutting / out-of-diff findings" heading describes.
 *
 * `generated_path` is the case STARK-5637 introduced and STARK-6096 named: the
 * finding IS in the diff, on a real file and line, and was deliberately held
 * out of a thread because its path is generated output (see
 * `findings_review_post.ts`). Filing those under the out-of-diff heading told a
 * reader they were outside the PR's scope — the exact "downgraded away" reading
 * the split exists to prevent. `buildReviewBody` cannot infer this from
 * file/line, because a withheld in-diff finding and an out-of-diff one look
 * identical by the time they reach it; the caller must state it.
 */
export type BodyReason = "generated_path";

export type Finding = {
  id: string;
  domain: string;
  agent: AgentName;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  body: string;
  classification?: Classification;
  /** Why this finding belongs in the review body rather than on a thread.
   * Only meaningful for findings routed to the body; see {@link BodyReason}. */
  body_reason?: BodyReason;
  classification_reason?: string;
  extra?: Record<string, unknown>;
};

/**
 * Build the HTML-comment marker that prefixes every posted review body. The
 * poster uses this same string for both the POST payload and the GET-marker
 * idempotency check, so the format must be a single source of truth.
 */
export function buildMarker(round: number, agent: AgentName, runHash: string): string {
  return `<!-- stark-review:round=${round}:agent=${agent}:run=${runHash} -->`;
}

// ─── Severity & finding-id helpers ──────────────────────────────────────────

const SEVERITY_RANK: Readonly<Record<Severity, number>> = Object.freeze({
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
});

export function severityMeetsThreshold(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

/** Compare two findings so the higher-severity one sorts first. Ties break by
 * (domain, file, line) for stable, predictable rendering. */
export function compareSeverityDesc<
  T extends { severity: Severity; domain?: string; file?: string | null; line?: number | null },
>(a: T, b: T): number {
  const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (sev !== 0) return sev;
  const da = a.domain ?? "";
  const db = b.domain ?? "";
  if (da !== db) return da < db ? -1 : 1;
  const fa = a.file ?? "";
  const fb = b.file ?? "";
  if (fa !== fb) return fa < fb ? -1 : 1;
  const la = a.line ?? 0;
  const lb = b.line ?? 0;
  return la - lb;
}

/**
 * Stable 12-hex-char id derived from sha256(domain|agent|normalized-title).
 * Title normalization: lowercase, strip ASCII punctuation, collapse whitespace.
 */
export function findingId(domain: string, agent: AgentName, title: string): string {
  const normalized = title
    .toLowerCase()
    .replace(/[!-/:-@\[-`{-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`${domain}|${agent}|${normalized}`)
    .digest("hex")
    .slice(0, 12);
}
