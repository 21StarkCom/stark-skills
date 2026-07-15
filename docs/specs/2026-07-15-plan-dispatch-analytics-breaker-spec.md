# Plan-dispatch analytics + convergence breaker — design

**Date:** 2026-07-15 · **Status:** draft · **Scope:** one PR to `stark-skills`; a single-user playground tool

## Problem

`tools/plan_dispatch.ts` (the `/stark-spec-to-plan` lead/wing generation loop) has
**no growth or convergence instrumentation** — the one thing the doc-review loop
(`tools/stark_review_doc.ts`) got in #674–#676. A live run on the kotodama
`bot-calendar-titles` spec (2026-07-15) exposed the gap: the draft grew
23.8k → 45.8k → 62.4k chars (2.62×) across 3 rounds and terminated
`max_rounds_unresolved` with **no signal** distinguishing "legitimately hard spec,
needs more rounds" from "runaway padding." The operator sees a bare
`max_rounds_unresolved` and a 62k-char plan, with nothing measuring whether the
growth was signal or noise.

The doc-review loop already solved exactly this — soft/hard growth caps,
non-convergence detection, the invent-then-condemn discriminator, health grading,
and a rendered analytics sidecar all live in
`tools/stark_review_doc_analytics_lib.ts`. Plan generation should **reuse that
brain**, not grow a second one.

## What this is not

- NOT a new analytics engine. The breaker logic (`evaluateGuards`, `judgeGrade`,
  `renderAnalyticsMarkdown`, `DEFAULT_ANALYTICS_THRESHOLDS`) is reused **as-is**
  from `stark_review_doc_analytics_lib.ts` — SSOT, one breaker for both loops. If
  the two ever diverge, that is a bug.
- NOT a change to the generate/review/revise **prompts** — those got the
  playground-scope guard in #677/#678 and are the *upstream* fix. This is the
  *backstop*, exactly as #675/#676 was the backstop to the review preambles.
- NOT a hard kill of every large plan. A genuinely intricate spec legitimately
  produces a longer plan; growth **alone** is advisory (warn + ack), never a hard
  stop. Only growth **past the hard cap** or **growth + non-convergence** or
  **invent-then-condemn** aborts.
- NOT a worktree/git rollback. Plan generation is text-in/text-out with no
  committed baseline (unlike doc-review, which reverts a file). The "rollback"
  analog here is *which draft the run emits* — see Design §5.
- NOT an operator-blocking prompt in headless/automated runs. The growth ack is
  surfaced by the `/stark-spec-to-plan` skill via `AskUserQuestion`; a direct
  headless dispatch only warns and continues (the analytics record it either way).

## Design

### 1. Reuse the breaker brain via an adapter (SSOT)

`evaluateGuards(originalChars, roundStats: RoundStat[], thresholds)` and
`judgeGrade(flags)` are already shape-agnostic — they consume `RoundStat`s. The
plan loop already exposes every field they need: `draft_length` (growth),
`blocking_findings.length` (the `to_fix` analog), and — since #678 — the wing
tags scope-inflation findings `over-engineering` (the invent-then-condemn
discriminator). So the entire feature is an **adapter** that maps plan rounds onto
`RoundStat`, plus wiring the verdict into the abort path, the receipt, and a
sidecar.

New module `tools/plan_analytics_lib.ts` (thin — the brain stays in
`stark_review_doc_analytics_lib.ts`; this only adapts + persists):

```
planRoundsToRoundStats(rounds: PlanRoundResult[]): RoundStat[]
buildPlanAnalytics(opts): ReviewAnalytics        // wraps evaluateGuards + judgeGrade
countOverEngineeringFindings(findings: string[]): number
```

### 2. The adapter mapping

Each `PlanRoundResult` → one `RoundStat` with `kind: "review-fix"` (so every plan
round counts as a fix round in `evaluateGuards`; it filters
`roundStats.filter(r => r.kind === "review-fix")`):

| `RoundStat` field | Source (plan round) |
|---|---|
| `kind` | `"review-fix"` (constant) |
| `round` | `round` |
| `doc_chars_before` | prior round's `draft_length` (round 1: its own `draft_length` → per-round ratio 1.0, no false spike) |
| `doc_chars_after` | this round's `draft_length` |
| `to_fix` | `blocking_findings.length` |
| `scope_findings` | `countOverEngineeringFindings(blocking_findings)` |
| `recurring` | `0` (no recurring-classification in generation) |
| `raw_findings` | `blocking_findings.length` |
| `patches_attempted` / `patches_applied` / `patch_failures` | `0` (not applicable — the churn/patch-thrash advisory flags never fire, correct for a text loop) |
| `duration_s` | `duration_s` |

`originalChars` = **round-1 `draft_length`** (the baseline; plan generation has no
pre-existing document, so the first draft is the reference the growth ratio
measures against).

### 3. Over-engineering detection (invent-then-condemn)

The wing (post #678) is instructed to label scope-inflation findings
`over-engineering`. `blocking_findings` is `string[]`, so detection is a host-side
match:

```
countOverEngineeringFindings(findings) =
  findings.filter(f => /over[-\s]?engineer|scope[-\s]?inflat/i.test(f)).length
```

This is the discriminator that keeps a **legitimately** growing plan from tripping
the padding abort: on the kotodama run every finding was a real execution bug and
`scope_findings == 0`, so invent-then-condemn correctly would **not** fire. It
fires only when the doc ballooned **and** the wing itself is condemning the scope
— the review manufactured scope it now flags. (A future refinement could have the
wing emit a structured `category` per finding instead of a text tag; the string
match is the low-friction path and is a strict superset of the labeled findings.)

### 4. Wiring the verdict into the loop

Inside `runPlanDispatch`, after each round is pushed and before deciding whether to
run another revise round, evaluate the guard on the rounds so far:

- **Hard growth cap** (`runaway_growth_hard`, ratio > `hard_doc_growth_ratio`,
  default 3×) → abort the loop immediately, `final_verdict = "aborted"`,
  `error = "padding_hard_growth"`.
- **Invent-then-condemn** (soft-growth breach **and** `scope_findings > 0` on the
  last round) → abort, `error = "padding_invent_then_condemn"`.
- **Growth + non-convergence** (soft-growth breach **and** `blocking_findings` did
  not decline for `non_convergent_rounds` consecutive rounds) → abort,
  `error = "padding_non_convergent"`.
- **Non-convergence alone** (findings not declining, no growth breach) → abort,
  `error = "non_convergent"` (the wing is spinning; more rounds won't help).
- **Soft growth alone, findings declining** → do **not** abort; set
  `growth_ack_required = true`, continue. The run finishes normally but the
  receipt/skill flag it for operator judgment.

These reuse `GuardVerdict.{abort, abort_reason, flags, growth_ack_required,
rollback_recommended}` verbatim — no new predicates.

### 5. Which draft the run emits ("rollback" analog)

Doc-review reverts the file to its pre-review state on a padding abort. Plan
generation has no committed baseline, so the analog is **which draft
`final_plan` carries** when `rollback_recommended` is true (hard-growth or
invent-then-condemn):

- Emit the **pre-balloon draft** — the latest round whose growth ratio was still
  within the soft cap (`≤ max_doc_growth_ratio`), i.e. the last lean draft before
  inflation. If round 1 itself already breached (rare), emit round 1.
- `final_verdict = "aborted"`; the receipt's `analytics.abort_reason` explains it;
  the emitted draft is flagged not-approved so the operator re-runs deliberately
  (now under the #677 scope guard) rather than shipping the padded 62k version.

For non-convergence-only aborts (no padding), keep the latest draft (it may carry
legitimate partial progress) — mirrors doc-review, where convergence-only aborts
do not roll back.

### 6. Persistence + operator surface

- **Receipt:** `PlanDispatchResult` gains an `analytics: ReviewAnalytics | null`
  block (same type the doc-review receipt uses) and a `persistence_errors:
  string[]` field. Null on dispatch failure before round 1.
- **Sidecar:** the `/stark-spec-to-plan` skill writes `<plan>.plan-analytics.md`
  next to the plan (via the existing `renderAnalyticsMarkdown`) and the raw
  `analytics` into its history dir — mirroring the doc-review sidecars. The
  dispatcher stays file-free (emits JSON); the skill owns files.
- **Ack:** when `growth_ack_required` is set and the run otherwise succeeded, the
  skill surfaces the grade + the growth ratio via `AskUserQuestion` before Phase 5
  posts (identical pattern to `/stark-review-spec` #675). Headless/direct dispatch
  logs the warning and proceeds.

## Components & interfaces

| Unit | Depends on | Contract |
|---|---|---|
| `planRoundsToRoundStats` (`plan_analytics_lib.ts`) | `RoundStat` type | `PlanRoundResult[] → RoundStat[]` per §2; pure |
| `countOverEngineeringFindings` | — | `string[] → number`; pure; the §3 regex |
| `buildPlanAnalytics` | `evaluateGuards`, `judgeGrade`, `buildAnalytics`/`renderAnalyticsMarkdown` (reused) | `(rounds, thresholds) → ReviewAnalytics`; no new breaker logic |
| `runPlanDispatch` (edit) | the above | evaluates the guard per round (§4), sets `final_verdict`/`error`, picks the emitted draft (§5), attaches `analytics` to the result |
| `/stark-spec-to-plan` SKILL (edit) | receipt `analytics` | writes the sidecar, surfaces the ack (§6) |

## Config

New `spec_to_plan.analytics` section in `stark_config_lib.ts`, **defaulting to the
same values** as `DEFAULT_ANALYTICS_THRESHOLDS` (`max_doc_growth_ratio: 2`,
`hard_doc_growth_ratio: 3`, `non_convergent_rounds: 2`; the round-growth-spike /
churn / patch-thrash thresholds are inherited but inert for a text loop). Kill
switch `STARK_PLAN_ANALYTICS_KILL` disables the breaker (analytics still recorded,
never aborts) — mirrors the doc-review kill switches. Reusing the same defaults
keeps the two loops calibrated identically unless deliberately overridden.

## Worked example — the kotodama run this spec is motivated by

Rounds: draft `23817 → 45831 → 62359` chars; blocking findings `10 → 5 → 6`;
`scope_findings` `0 → 0 → 0` (every finding a real execution bug).

Under the ported breaker (`max_doc_growth_ratio: 2`, `hard: 3`,
`non_convergent_rounds: 2`):
- growth ratio at round 3 = 62359/23817 = **2.62×** → soft breach (`runaway_growth`
  flag), under the 3× hard cap → no hard abort.
- `scope_findings == 0` → invent-then-condemn does **not** fire (growth was
  legitimate — correct).
- findings `10 → 5 → 6`: declined R1→R2, **rose** R2→R3 → not declining across the
  last 2 rounds → `non_convergent`.
- soft-growth **and** non-convergent → **composite abort**, `error =
  "padding_non_convergent"`, grade `runaway`, emit the pre-balloon draft (round 1,
  the only round ≤ 2×).

So instead of a bare `max_rounds_unresolved` + a 62k plan, the operator gets:
*"aborted round 3 — grew 2.62× while findings stopped declining (10→5→6); this
spec is genuinely intricate, raise `--max-rounds` or split it,"* plus the analytics
sidecar. The signal that was missing.

## Testing

- **Unit (`plan_analytics_lib.test.ts`):** the adapter mapping (`draft_length →
  doc_chars_after`, round-1 baseline, `over-engineering` count); the regex on
  tagged vs untagged findings; `buildPlanAnalytics` grade for the four cases
  (healthy / soft-growth-degraded / non-convergent-runaway / invent-then-condemn);
  the **kotodama replay** vector above pinned as a regression (2.62× + 10→5→6 +
  0 scope → composite abort, emit round 1).
- **Loop (`plan_dispatch` test):** hard-growth round-2 abort; invent-then-condemn
  abort with a tagged finding; growth-alone sets `growth_ack_required` without
  aborting; `STARK_PLAN_ANALYTICS_KILL` records analytics but never aborts;
  non-convergence-only keeps the latest draft, padding-abort emits the pre-balloon
  draft.
- **No new breaker-logic tests** — `evaluateGuards`/`judgeGrade` are already
  covered in `stark_review_doc_analytics_lib.test.ts`; reusing them means their
  coverage covers this too (the SSOT payoff).
- **Live:** re-run `/stark-spec-to-plan` on the kotodama spec; confirm the
  composite abort fires with the pre-balloon draft + sidecar, and that a
  small/clean spec still grades `healthy` and approves.

## Open questions

None blocking. One deferred refinement: structured `category` per wing finding
(replacing the §3 text match) — worth it only if the text tag proves noisy in
practice; the string match ships first.
