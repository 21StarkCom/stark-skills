// The watcher's fetch + error-handling layer: everything that talks to GitHub
// or shapes retry timing. The pure decision logic lives in watcher_classifier.ts;
// this module supplies the impure inputs it decides over.
import { fetchRequiredCheckRollup, type Context } from "./checks_graphql.ts";
import * as ghLib from "./gh.ts";
import { readPrMergePlan, type PrMergePlan } from "./plan.ts";
import {
  evaluateRollup,
  applyMergeStateGate,
  mergeStateBlocksFiring,
  type PollOutcome,
} from "./watcher_classifier.ts";

export { readPrMergePlan, type PrMergePlan };

// ---------------------------------------------------------------------------
// Legacy pr-open mode check helpers (gh pr checks, not the required rollup).
// ---------------------------------------------------------------------------

export function* backoffSchedule(initial: number, cap: number): Generator<number> {
  for (let i = 0; i < 5; i++) yield initial;
  let cur = initial * 2;
  while (true) {
    yield cur;
    cur = Math.min(cur * 2, cap);
    if (cur === cap) break;
  }
  while (true) yield cap;
}

export interface CheckRecord {
  state?: string;
  conclusion?: string | null;
}

export function isTerminal(checks: CheckRecord[]): boolean {
  if (checks.length === 0) return false;
  return checks.every(c => {
    const state = String(c.state ?? c.conclusion ?? "").toUpperCase();
    return state !== "" && !["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING"].includes(state);
  });
}

export function summarize(checks: CheckRecord[]) {
  const counts = { total: checks.length, success: 0, failure: 0, cancelled: 0, skipped: 0, neutral: 0 };
  for (const r of checks) {
    const state = String(r.state ?? r.conclusion ?? "").toUpperCase();
    if (state === "SUCCESS" || state === "PASS") counts.success++;
    else if (state === "FAILURE" || state === "FAIL" || state === "ERROR" || state === "ACTION_REQUIRED" || state === "TIMED_OUT") counts.failure++;
    else if (state === "CANCELLED" || state === "CANCELED") counts.cancelled++;
    else if (state === "SKIPPED") counts.skipped++;
    else if (state === "NEUTRAL") counts.neutral++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// pr-merge mode: required-check rollup poll + retry-error classification.
// ---------------------------------------------------------------------------

export function jitter(seconds: number, pct = 0.2): number {
  const delta = seconds * pct;
  return Math.max(1, seconds + (Math.random() * 2 - 1) * delta);
}

export interface BackoffState {
  consecErrors: number;
  rateLimitDelaySec: number;
}

export function classifyError(err: Error): { rateLimit: boolean; secondaryRateLimit: boolean; transient: boolean } {
  const msg = err.message;
  if (/X-RateLimit-Remaining: 0/i.test(msg) || /\b429\b/.test(msg)) return { rateLimit: true, secondaryRateLimit: false, transient: false };
  if (/secondary rate limit/i.test(msg)) return { rateLimit: false, secondaryRateLimit: true, transient: false };
  if (/\b50[0-9]\b/.test(msg)) return { rateLimit: false, secondaryRateLimit: false, transient: true };
  return { rateLimit: false, secondaryRateLimit: false, transient: false };
}

export async function pollOnce(
  plan: PrMergePlan,
  deps: {
    fetchMergeState?: (prNumber: number, repoSlug: string) => string;
    fetchReviewDecision?: (prNumber: number, repoSlug: string) => string;
  } = {},
): Promise<PollOutcome> {
  const r = await fetchRequiredCheckRollup({
    owner: plan.pr.headRepositoryOwner,
    repo: plan.pr.headRepositoryName,
    prNumber: plan.pr.number,
    expectedHeadOid: plan.pushedHeadOid!,
  });
  const outcome = evaluateRollup(r as { mismatch: boolean; contexts: Context[] | null; headRefOid: string }, {
    allowNoRequiredChecks: plan.execute.allowNoRequiredChecks,
    allowSkippedChecks: plan.execute.allowSkippedChecks === true,
  });
  // Spend the extra mergeability call on exactly two rollup readings, both of
  // which GitHub's own verdict is needed to interpret (see applyMergeStateGate):
  //   READY   — the rollup can read green over a required set that has not fully
  //             registered, and GitHub still BLOCKs (STARK-579).
  //   VACUOUS  — zero required contexts is ambiguous: pre-registration/dropped
  //             trigger (GitHub BLOCKs) vs a genuinely unprotected base (STARK-1053).
  // Never on the pending/failing/skipped paths — those the rollup decides alone.
  const isVacuousWait = outcome.kind === "wait" && outcome.vacuous === true;
  if (outcome.kind !== "ready" && !isVacuousWait) return outcome;
  const fetchMergeState =
    deps.fetchMergeState ?? ((n: number, slug: string) => ghLib.prMergeStateStatus(n, slug));
  const mergeState = fetchMergeState(plan.pr.number, plan.pr.nameWithOwner);
  // reviewDecision is needed ONLY to gate the vacuous re-fire (a review block is
  // not re-fireable). One extra call, on the rare vacuous path only.
  let reviewDecision: string | undefined;
  if (isVacuousWait && mergeStateBlocksFiring(mergeState)) {
    const fetchReviewDecision =
      deps.fetchReviewDecision ?? ((n: number, slug: string) => ghLib.prReviewDecision(n, slug));
    reviewDecision = fetchReviewDecision(plan.pr.number, plan.pr.nameWithOwner);
  }
  return applyMergeStateGate(outcome, mergeState, { reviewDecision });
}
