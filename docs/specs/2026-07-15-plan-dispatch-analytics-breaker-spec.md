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
  produces a longer plan; **soft** growth **alone** (past the soft cap, still under
  the hard cap) is advisory (warn + ack), never a hard stop. Growth **above the
  hard cap** aborts independently — it is unambiguous runaway. The other **padding
  aborts** are **growth + non-convergence** and **invent-then-condemn**; separately,
  **non-convergence alone** (findings not declining, no growth breach) also aborts
  as a loop-safety stop. See Design §4 for the full, authoritative abort list.
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
buildPlanAnalytics(opts: BuildPlanAnalyticsOptions): ReviewAnalytics   // wraps evaluateGuards + judgeGrade
countOverEngineeringFindings(findings: string[]): number

// one exported options type — used consistently wherever buildPlanAnalytics is referenced
interface BuildPlanAnalyticsOptions {
  rounds: PlanRoundResult[];          // required; the completed plan rounds
  thresholds: AnalyticsThresholds;    // required; the spec_to_plan.analytics block (defaults per Config)
  enforced: boolean;                  // required; false when STARK_PLAN_ANALYTICS_KILL is set
}
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

**Metric normalization (one deterministic contract).** `draft_length` is **derived
host-side** as the character length of the exact emitted draft text — never read
from model output — so every metric the adapter consumes (`draft_length`,
`blocking_findings.length`, `duration_s`) is a host-measured finite non-negative
integer; there are no model-supplied numbers that could be malformed or non-finite.
A round whose draft text is empty or missing is a **deterministic dispatch
failure**, not a zero-length round: a **blank round-1 draft is rejected**
(`dispatch_error = "empty_first_draft"`, `analytics: null`), so `originalChars ≥ 1`
always holds and the cumulative growth ratio `chars ÷ originalChars` is always
finite and well-defined. There is no `0 ÷ 0` or `0 → positive` case to resolve — the
zero-baseline state cannot survive round 1. A later round that emits an empty draft
(after a non-empty round 1) yields a finite ratio of `0`.

### 3. Over-engineering detection (invent-then-condemn)

The wing (post #678) is instructed to prefix scope-inflation findings with an
**exact, anchored, machine-readable marker** — the literal token `[over-engineering]`
at the start of the finding string — which is the **sole authority** for the
category. The host never independently infers scope-inflation from free prose;
there is **one owner** (the wing emits the tag), **one exact matcher** (the adapter
reads it), and **one shared exported constant** so the two vocabularies cannot
drift. `blocking_findings` is `string[]`, so detection matches only that anchored
marker:

```
OVER_ENGINEERING_TAG = "[over-engineering]"   // shared exported constant; the wing prompt and the adapter reference the same token
countOverEngineeringFindings(findings) =
  findings.filter(f => f.trimStart().startsWith(OVER_ENGINEERING_TAG)).length
```

Anchoring on the exact tag (not a broad regex) means a negation, explanatory
prose, or a complaint *about* a missing tag can never false-match and spuriously
increment `scope_findings` — which drives an abort + rollback, so a false match
would change control flow. The tag match is therefore correctness-preserving, not
merely a superset.

This is the discriminator that keeps a **legitimately** growing plan from tripping
the padding abort: on the kotodama run every finding was a real execution bug and
`scope_findings == 0`, so invent-then-condemn correctly would **not** fire. It
fires only when the doc ballooned **and** the wing itself tagged the scope
— the review manufactured scope it now flags. (A fuller refinement — the wing
emitting a fully structured `category` field per finding — is deferred; the shared
`[over-engineering]` tag constant is the low-friction path that already gives one
authoritative source.)

> **§3 caveat — the tag is a co-occurrence proxy, not proven provenance.** An
> `[over-engineering]` tag proves the wing classified a *current* finding as scope
> inflation; it does **not** prove that the aborting round *introduced* that scope
> (the flagged scope could have been present since round 1). So invent-then-condemn
> is honestly "the doc breached the soft cap **and** the wing is now flagging scope
> inflation" — a co-occurrence strong enough to stop and roll back to the
> pre-balloon draft (which the operator then re-runs deliberately under the #677
> scope guard), not a proof of causation. Per-revision provenance (diffing the
> flagged scope against the prior draft) is the same deferred refinement as the
> structured `category` field: it would tighten this from co-occurrence to
> causation but is not needed for a backstop that only rolls back to a draft the
> operator re-inspects. This mirrors the §4 convergence-proxy honesty — a
> conservative stop-and-let-the-operator-decide signal, not a verdict.

### 4. Wiring the verdict into the loop

Inside `runPlanDispatch`, after each round is pushed and before deciding whether to
run another revise round, evaluate the guard on the rounds so far. Every abort below
sets the immutable dispatcher fields `dispatch_verdict = "aborted"` and the named
`dispatch_error` (§6); the `error = …` labels below are those `dispatch_error`
codes:

- **Hard growth cap** (`runaway_growth_hard`, ratio > `hard_doc_growth_ratio`,
  default 3×) → abort the loop immediately, `error = "padding_hard_growth"`.
- **Invent-then-condemn** (soft-growth breach **and** `scope_findings > 0` on the
  last round) → abort, `error = "padding_invent_then_condemn"`.
- **Growth + non-convergence** (soft-growth breach **and** `blocking_findings` did
  not decline for `non_convergent_rounds` consecutive rounds) → abort,
  `error = "growth_non_convergent"`. This is a **loop-safety** stop, not proven
  padding — it names the composite honestly (the doc grew *and* stopped
  converging) without claiming the extra scope was inventory padding. Because a
  growth breach is present, `rollback_recommended` is set and it emits the
  pre-balloon draft (§5).
- **Non-convergence alone** (findings not declining, no growth breach) → abort,
  `error = "non_convergent"`. The count trajectory is a **proxy** for a spinning
  loop, inherited verbatim from the doc-review brain (SSOT); it is the signal to
  stop and let the operator raise `--max-rounds` or split the spec, not a proof
  that more rounds cannot help (see the §4 note).
- **Soft growth alone, findings declining** → do **not** abort; set
  `growth_ack_required = true`, continue. The run finishes normally but the
  receipt/skill flag it for operator judgment.

These reuse `GuardVerdict.{abort, abort_reason, flags, growth_ack_required,
rollback_recommended}` verbatim — no new predicates.

> **§4 note — convergence is a count proxy, deliberately.** `evaluateGuards`
> judges convergence from the blocking-findings *count* trajectory (and this
> adapter sets `recurring = 0`), so a `10 → 5 → 6` movement cannot distinguish
> "the same findings stayed unresolved" from "the original findings were fixed and
> new, legitimate ones surfaced." Carrying per-finding identity + per-round
> disposition would **fork the reused brain and defeat the SSOT payoff**, so it is
> out of scope here — this loop inherits the exact same count heuristic (and the
> same limitation) as doc-review. The non-convergence abort is therefore a
> conservative *stop-and-ask-the-operator* signal, not a proof; the operator
> decides whether to raise `--max-rounds` or split the spec.

### 5. Which draft the run emits ("rollback" analog)

Doc-review reverts the file to its pre-review state on a padding abort. Plan
generation has no committed baseline, so the analog is **which draft
`final_plan` carries** when `rollback_recommended` is true. `rollback_recommended`
is set on **every abort that carries a growth breach** — the three growth-breach
aborts: hard-growth (`runaway_growth_hard`), invent-then-condemn, and the composite
growth + non-convergence (`growth_non_convergent`). It is **not** set for
non-convergence alone (no growth breach → keep the latest draft).

- Emit the **pre-balloon draft** — the latest round whose **cumulative** growth
  ratio (that round's `draft_length ÷ originalChars`) was still within the soft
  cap (`≤ max_doc_growth_ratio`), i.e. the last draft before growth crossed the
  soft line. Round 1's cumulative ratio is exactly `1.0` by construction
  (`originalChars` **is** round-1 `draft_length`, and a blank round 1 is rejected
  per §2), so round 1 is always soft-cap-eligible and there is always at least one
  emittable pre-balloon draft — the impossible "round 1 already breached" case
  cannot occur.
- `dispatch_verdict = "aborted"`; the receipt's `analytics.abort_reason` explains it;
  the emitted draft is flagged not-approved so the operator re-runs deliberately
  (now under the #677 scope guard) rather than shipping the padded 62k version.
- **Lineage (so the emitted plan is never mistaken for the last analytics round).**
  Because on a growth abort `final_plan` carries an *earlier* draft while `analytics`
  spans rounds through the aborting one, `PlanDispatchResult` records
  `last_observed_round` (the final round the loop ran), `emitted_round` (which round
  supplied `final_plan`), and `emitted_draft_length` (its measured char length).
  Consumers read `emitted_round`, never "the last analytics round", and can verify
  the rollback holds (`emitted_draft_length ÷ originalChars ≤ max_doc_growth_ratio`).
  The selected draft snapshot is retained across iterations so the persisted plan
  matches the recorded `emitted_round`.

For non-convergence-only aborts (no growth breach, `rollback_recommended = false`),
keep the latest draft (it may carry legitimate partial progress) — mirrors
doc-review, where convergence-only aborts do not roll back.

### 6. Persistence + operator surface

**Field ownership — immutable dispatcher result, authoritative envelope.** The
dispatcher's `PlanDispatchResult` is **immutable** once returned; the skill
**never mutates it**. All decision-dependent outcome state lives **only** on the
outer `SpecToPlanReceipt` envelope. This removes the two-owner contradiction — there
is exactly one authoritative home for the final verdict.

- **Dispatcher receipt (`PlanDispatchResult`, immutable):** owns the *dispatch*
  outcome under distinctly-named fields — `dispatch_verdict`
  (`approve`/`aborted`, as the loop itself terminated) and `dispatch_error` — plus
  `analytics: ReviewAnalytics | null` (same type the doc-review receipt uses;
  `null` on dispatch failure before round 1, no baseline yet), the lineage fields
  (§5), and `growth_ack_required: boolean`. The dispatcher **never asks** and never
  learns the ack outcome, so it carries no `growth_ack` and no `effective_*` field.
  It is file-free — no `persistence_errors` here.
- **Skill envelope (`SpecToPlanReceipt`) — sole owner of the final outcome:** embeds
  the immutable `PlanDispatchResult` verbatim and **owns** the authoritative
  `effective_verdict`, `effective_error`, `growth_ack`, and `persistence_errors:
  string[]`. Every downstream consumer (renderer, history, Phase 5 gate) reads
  `effective_*`; the embedded `dispatch_*` is provenance, never the live decision.
  When no ack was required, `effective_verdict = dispatch_verdict` (copied, not
  mutated) and `effective_error = dispatch_error`.

**Two-phase persistence (write the plan first, finalize after the answer).** Because
the sidecar and history analytics must reflect the *final* `growth_ack`, they are
**not** written before the prompt — this closes the stale-analytics gap:

1. **Phase A — preserve the plan.** The moment the loop returns, write the plan
   draft (`final_plan`) to disk. Nothing downstream can lose the generated plan,
   regardless of the ack answer or a later write failure.
2. **Phase B — ask (only if `growth_ack_required`).** Surface the grade + growth
   ratio via `AskUserQuestion` (skill only; headless/direct dispatch has no Phase B
   and no Phase 5).
3. **Phase C — finalize once.** Construct the authoritative envelope (`effective_*`
   + `growth_ack`), stamp `growth_ack` into a **copy** of the analytics record, then
   **atomically** (tmp+rename per file) write the analytics JSON to history, render
   `<plan>.plan-analytics.md` **from that final envelope**, then `receipt.json`.
   The sidecar/history therefore carry the real decision on their first and only
   write — no stale pre-ack analytics on disk, no second rewrite.
   `persistence_errors` collects one entry per failed Phase-C write (empty = all
   succeeded); if the envelope itself cannot be persisted the skill still returns it
   in-memory and logs to stderr — the Phase-A plan on disk is never lost.

**Ack state machine.** When `growth_ack_required` is set and the run otherwise
succeeded, the plan is written **first** (Phase A above), the skill surfaces the
grade + growth ratio via `AskUserQuestion` (Phase B), then the finalized envelope is
persisted (Phase C) before Phase 5 posts (identical pattern to `/stark-review-spec`
#675). Every field below is the **envelope's** `effective_*` / `growth_ack`; the
embedded `dispatch_verdict`/`dispatch_error` are left untouched:

| Response (`AskUserQuestion` option id) | Effect |
|---|---|
| **Continue** (`ack_continue`) | Phase 5 posts; `growth_ack = "accepted"`; `effective_verdict = dispatch_verdict` (`approve`), `effective_error = null`. |
| **Stop** (`ack_stop`) | Phase 5 **suppressed** (no PR post); `growth_ack = "rejected"`, `effective_verdict = "held"`, `effective_error = "growth_ack_rejected"`. Plan + sidecar stay on disk — nothing discarded; the operator re-runs or ships by hand. |
| No answer / cancelled (non-TTY or timeout) | Treated as **Stop** for posting (fail-closed: never auto-post an un-acked growth), `growth_ack = "unattended"`, `effective_verdict = "held"`, `effective_error = "growth_ack_unattended"`, warning logged; artifacts remain on disk. |

Headless/direct dispatch (the dispatcher invoked without the skill) has no Phase B
and no Phase 5: `dispatch_verdict` stays as the loop set it, the analytics still
record `growth_ack_required`, and a warning is logged — there is no envelope and no
posting to gate. The skill's non-TTY path is the "No answer" row above (`unattended`
→ `held`). The final `growth_ack` is written into the persisted analytics copy in
Phase C (not a separate later rewrite), so the decision is auditable on disk, not
only in the returned envelope.

## Components & interfaces

| Unit | Depends on | Contract |
|---|---|---|
| `planRoundsToRoundStats` (`plan_analytics_lib.ts`) | `RoundStat` type | `PlanRoundResult[] → RoundStat[]` per §2; pure |
| `countOverEngineeringFindings` | shared `OVER_ENGINEERING_TAG` constant | `string[] → number`; pure; exact anchored-tag match per §3 (never prose inference) |
| `buildPlanAnalytics` | `evaluateGuards`, `judgeGrade`, `buildAnalytics`/`renderAnalyticsMarkdown` (reused) | `(opts: BuildPlanAnalyticsOptions) → ReviewAnalytics` where `BuildPlanAnalyticsOptions = { rounds, thresholds, enforced }` (§1); sets `analytics.enforced`/`would_abort`/`abort`; no new breaker logic |
| `runPlanDispatch` (edit) | the above | evaluates the guard per round (§4), sets the **immutable** `dispatch_verdict`/`dispatch_error`, records lineage + `growth_ack_required`, picks the emitted draft (§5), attaches `analytics` to the result — never touched again after return |
| `/stark-spec-to-plan` SKILL (edit) | receipt `analytics` | writes the plan (Phase A), runs the ack state machine (Phase B), then finalizes the `SpecToPlanReceipt` envelope that **solely owns** `effective_verdict`/`effective_error`/`growth_ack`/`persistence_errors` and renders the sidecar + history from it (Phase C, §6) |

## Config

New `spec_to_plan.analytics` section in `stark_config_lib.ts`. Its defaults are
**constructed from `DEFAULT_ANALYTICS_THRESHOLDS`** (spread the shared constant,
then layer any plan-specific overrides) — the numeric values `2 / 3 / 2` are
**never re-typed** in `stark_config_lib.ts`, so the two loops cannot drift and stay
calibrated identically unless deliberately overridden. If importing the constant
from `stark_review_doc_analytics_lib.ts` would create a dependency cycle, the shared
threshold definition moves to a neutral module both libraries import. (The
round-growth-spike / churn / patch-thrash thresholds are inherited but inert for a
text loop.)

Kill switch `STARK_PLAN_ANALYTICS_KILL` disables **enforcement** only — analytics
are still computed and recorded, guards never abort — mirroring the doc-review kill
switches. `buildPlanAnalytics` receives the resolved `enforced` flag via
`BuildPlanAnalyticsOptions` (false when the switch is set) and sets
`analytics.enforced` + `analytics.abort = would_abort && enforced` from it. To keep
a kill-switched receipt unambiguous, the analytics record carries an explicit
**enforcement state**: `analytics.enforced: boolean`, and the counterfactual
`analytics.would_abort` is kept separate from the applied `analytics.abort`. With
the switch on, `would_abort` may be `true` while `analytics.abort` is `false` and
`dispatch_verdict` is a success — a renderer or history consumer reads `enforced:
false` and interprets the verdict correctly instead of seeing a contradictory
`abort: true` + `approve`.

**Ack under the kill switch:** enforcement-off means **no gating of any kind** — the
guard's `growth_ack_required` is recorded only as the counterfactual
`analytics.would_require_ack`, while the applied `growth_ack_required` is forced
`false`, so the skill neither prompts (Phase B) nor suppresses Phase 5. The run
posts exactly as an un-instrumented run would; the counterfactual stays on the
record for audit. A test pins this (the kill switch never holds a run via the ack
path).

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
  last 2 rounds → non-convergent.
- soft-growth **and** non-convergent → **composite abort**, `error =
  "growth_non_convergent"` (a loop-safety stop, not a claim the extra scope was
  padding), grade `runaway`. Because a growth breach is present,
  `rollback_recommended` is set → emit the **pre-balloon draft**: the latest round
  whose cumulative ratio is `≤ 2×`, which is **round 2** (45831/23817 = **1.92×**,
  still within the soft cap; round 3 at 2.62× is the first over-cap draft, round 1
  is 1.0×).

So instead of a bare `max_rounds_unresolved` + a 62k plan, the operator gets the
pre-balloon round-2 draft (1.92×, not the padded 62k round-3 one) plus:
*"aborted round 3 — grew 2.62× while findings stopped declining (10→5→6); this
spec is genuinely intricate, raise `--max-rounds` or split it,"* and the analytics
sidecar. The signal that was missing.

## Testing

- **Unit (`plan_analytics_lib.test.ts`):** the adapter mapping (`draft_length →
  doc_chars_after`, round-1 baseline, `over-engineering` count); the **exact-tag**
  matcher on tagged vs untagged findings — including the false-match guards (a
  negation, a finding *complaining about* a missing tag, the token mid-string
  rather than anchored → all count `0`); `buildPlanAnalytics` grade for the four
  cases (healthy / soft-growth-degraded / non-convergent-runaway /
  invent-then-condemn); the **kotodama replay** vector above pinned as a regression
  (2.62× + 10→5→6 + 0 scope → composite `growth_non_convergent` abort, emit
  **round 2**, the 1.92× pre-balloon draft).
- **Edge cases (unit):** a **blank/empty round-1 draft is rejected** as a
  deterministic dispatch failure (`dispatch_error = "empty_first_draft"`,
  `analytics: null`) — pinned, not left to implementation choice — so
  `originalChars ≥ 1` and no ratio is ever `NaN`/`Infinity`; a later empty draft
  after a non-empty round 1 yields a finite ratio of `0`; empty `blocking_findings`
  list; and because every metric is host-derived (§2), there is **no**
  malformed/non-finite model metric to normalize — the emitted analytics JSON is
  asserted finite + serializable in every case.
- **Threshold wiring (unit):** `spec_to_plan.analytics` defaults compare **equal**
  to `DEFAULT_ANALYTICS_THRESHOLDS` (guards the "derived from the constant, not
  re-typed" claim); a custom `spec_to_plan.analytics` override propagates into the
  guard; and the exact **boundary semantics** — a cumulative ratio *exactly at* 2×
  and 3× vs *just above* — pin whether each cap comparison is `>` or `≥`; plus
  "latest soft-cap-eligible draft" selection when several rounds qualify.
- **Loop (`plan_dispatch` test):** hard-growth round-2 abort; invent-then-condemn
  abort with a tagged finding; growth-alone sets `growth_ack_required` without
  aborting; `STARK_PLAN_ANALYTICS_KILL` records analytics (with `enforced: false` +
  the counterfactual `would_abort`) but never aborts; non-convergence-only keeps the
  latest draft, growth-breach abort emits the pre-balloon draft; **dispatch failure
  before round 1 returns `analytics: null`**; a **blank round-1 draft** is rejected
  with `dispatch_error = "empty_first_draft"` + `analytics: null`.
- **Skill integration (`spec_to_plan` skill test, temp files + mocked
  `AskUserQuestion`):** covers healthy (approves, no prompt), growth-ack **Continue**
  (Phase 5 posts, `growth_ack = "accepted"`, `effective_verdict = "approve"`),
  growth-ack **Stop** (posting suppressed, `effective_verdict = "held"`, artifacts
  still on disk), and headless-non-TTY (`growth_ack = "unattended"`,
  `effective_verdict = "held"`, warning logged, no prompt, no post) — asserting
  sidecar + history contents, the **Phase-A-plan-then-Phase-C-finalize** ordering
  (the on-disk sidecar/history carry the **final** `growth_ack`, written once, never
  a stale pre-ack value), Phase 5 gating, immutability of the embedded
  `dispatch_verdict`/`dispatch_error`, and that a Phase-C persistence-write failure
  surfaces deterministically in the envelope's `persistence_errors` while the plan
  on disk and `effective_verdict` are preserved.
- **Abort classes through the skill boundary:** one skill-level case per abort class
  (hard-growth, invent-then-condemn, **growth_non_convergent**,
  non-convergence-only), asserting the **exact** plan written to disk (the selected
  `emitted_round` draft for growth-breach aborts, the latest draft for
  non-convergence-only), `effective_verdict = "aborted"` + the specific
  `effective_error`, the sidecar + history contents, and **zero Phase 5 posts** — so
  a regression that posts an explicitly unapproved plan is caught automatically, not
  only by the manual kotodama replay.
- **Failures after round 1 (loop test):** scripted generation / wing-review /
  revision failures *after* ≥1 completed round assert that completed-round analytics
  are retained (not reset to `null`), the intended draft is emitted, and the
  pre-existing `dispatch_error` is **not** overwritten by the guard wiring (error
  precedence pinned).
- **Tag contract end-to-end (not just below the boundary):** a test that renders the
  real wing prompt and asserts it contains the shared `OVER_ENGINEERING_TAG` token,
  feeds a wing response carrying a tagged finding through the **real** response
  parser into a `PlanRoundResult`, and confirms the resulting `scope_findings > 0`
  drives invent-then-condemn — so the model→adapter path can't silently report
  `scope_findings = 0` and disable detection while the injected-string matcher tests
  still pass.
- **Kill-switch ack (loop/skill):** with `STARK_PLAN_ANALYTICS_KILL` set on a
  soft-growth run, assert applied `growth_ack_required = false`, counterfactual
  `would_require_ack = true`, no prompt, and Phase 5 posts.
- **No new breaker-logic tests** — `evaluateGuards`/`judgeGrade` are already
  covered in `stark_review_doc_analytics_lib.test.ts`; reusing them means their
  coverage covers this too (the SSOT payoff).
- **Live:** re-run `/stark-spec-to-plan` on the kotodama spec; confirm the composite
  abort fires with the pre-balloon round-2 draft + sidecar, and that a small/clean
  spec still grades `healthy` and approves.

## Open questions

None blocking. One deferred refinement: a fully structured `category` field per
wing finding (replacing the §3 `[over-engineering]` tag) — worth it only if the tag
proves insufficient in practice; the shared tag constant ships first.
