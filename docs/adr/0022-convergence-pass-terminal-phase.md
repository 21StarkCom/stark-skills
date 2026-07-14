# 0022. Convergence pass is the terminal review phase

- **Status:** Proposed (flips to Accepted when slice 3 of [the convergence plan](../plans/review-convergence-and-analytics-2026-07-14.md) merges)
- **Date:** 2026-07-14

## Context

All three review cycles (`/stark-review-spec`, `/stark-review-plan`, `/stark-review`) share a contract in which a **final review-only round is terminal**: `review → fix → … → final review`. Two classes of mutation land *after* that final review:

1. **Phase 5b operator fixes.** The skill hands the operator every still-open finding and instructs "fix every one of them by hand." These are the largest, least-constrained edits of the entire run, and nothing reviews them.
2. **The PR cycle's final fix round.** Non-final fixes are re-reviewed by the next round against the new HEAD; the final round's fix is verified only by `test_command` — tests, not review.

This produced a real incident (`21StarkCom/stark-stream-deck-sdk` PR #2, 2026-07-14): 33 hand-applied plan fixes, one of which falsified a sentence elsewhere in the same document ("no `AbortSignal` is threaded anywhere"); the contradiction was caught by luck, in a credential-lifecycle section where a miss becomes expensive once OAuth is half-built.

The structural statement of the bug: **every fix these skills apply is reviewed — except the last one.** The "final review" is not final; it precedes the biggest mutation.

## Decision

Every review run ends with a **convergence pass** — a diff-scoped review of the delta between the last-reviewed state and the final committed artifact — and that pass is the new terminal phase.

- The dispatcher records `last_reviewed_sha` (plus a content snapshot in the run's history dir) at the end of the final review round.
- A re-entrant CLI mode (`stark_review_doc.ts --converge --base <sha>`) reviews only the delta, answering one question: did these edits introduce a contradiction, a broken cross-reference, a claim the rest of the document now falsifies, or a finding "resolved" in prose but not substance?
- The doc-review skills gain **Phase 6 — Converge**, which runs after Phase 5b/5c. Its findings are normal findings: posted as resolvable threads, fixed, resolved — the existing posting contract extends to them unchanged.
- Recursion is bounded: one convergence pass; a second only if the first produced `high`/`critical` findings; never a third.
- The summary must carry an explicit claim: `Converged — delta reviewed, N findings (all resolved)` / `Converged — delta reviewed, clean` / `NOT converged — delta unreviewed` (on dispatch failure). Silence is no longer a valid terminal state.
- The PR cycle mirrors the design: the **final** round's applied fix gets a convergence review of its diff (one fixer pass + test gate if findings clear the threshold; no further recursion). Non-final rounds are untouched.

## Alternatives Considered

- **Forbid post-review manual edits (make the wing the only mutator).** Rejected: Phase 5b exists precisely because operator judgment outperforms the wing on ambiguous findings; removing it degrades outcomes to save review cost.
- **Re-run the full review after Phase 5b.** Rejected: unbounded cost and latency (another N-domain × M-round loop), and it re-reviews 95% unchanged content to cover a small delta.
- **Move Phase 5b before the final review round.** Rejected: 5b consumes the final round's still-open findings — it cannot precede the round that produces them; and operator edits made after any reordering would still be terminal and unreviewed.
- **Status quo (rely on the operator noticing contradictions).** Rejected: the incident demonstrates it fails silently, and the failure mode compounds (contradictions surface later, in implementation).

## Consequences

- **Positive:** no unreviewed mutation exists in any cycle; "is the plan ready?" gets an explicit, honest answer ("converged, delta reviewed") instead of silence; convergence findings inherit the full post/fix/resolve contract, so nothing bypasses the PR trail.
- **Cost:** one extra lead dispatch per run (two worst-case), kept cheap by scoping to the diff; measured by the run analytics.
- **Contract churn:** the "final review round is terminal" assumption is load-bearing in both doc-review SKILL.mds and the PR-cycle skill; phase numbering changes and every receipt consumer is swept in the same slice.
- **New failure surface:** a convergence dispatch failure must degrade loudly (`NOT converged`) rather than silently passing — the summary claim is part of the contract.
- Supersedes the implicit terminal-phase contract; recorded here rather than edited in silently.
