# 0023. Spec authoring is contract-bounded, not critique-bounded

- **Status:** Accepted (implemented by [the stark-write-spec spec](../specs/2026-07-16-stark-write-spec-spec.md) + [plan](../specs/2026-07-16-stark-write-spec-plan.md))
- **Date:** 2026-07-16

## Context

The pipeline started at *review*: `stark-review-spec → stark-spec-to-plan → stark-plan-to-tasks → phase-execute`. Nothing owned spec **authoring**, so whatever entered review was thin, hand-written intent, and review-spec's 9 adversarial domains filled the gaps by inventing content.

That is the root of the inflation this repo spent weeks building breakers against: 200-line docs ballooning toward 80k lines over 10 rounds (`analytics.max_doc_growth_ratio` / `hard_doc_growth_ratio`), the invent-then-condemn breaker (#676, the review manufacturing scope it later flags as over-engineering), growth-ack gates, rollback-on-hard-growth, coherence passes — all *downstream damage control* for a document that was born incomplete.

The structural cause: **completeness was defined implicitly as "whatever the adversarial reviewers can still find"** instead of explicitly by a contract. An adversarial critic loop is unbounded by construction — there is always one more angle, so the doc ratchets. The fix is to feed review a spec that is already complete *against a fixed contract*; the legitimate gaps disappear, and the existing playground-scope guards (#675–#678) handle the illegitimate ones.

## Decision

Add `/stark-write-spec` as the missing **stage 0** — a contract-bounded authoring stage that turns intent (an inline prompt, a notes file, and/or decisions distilled from the conversation) into a spec satisfying a **fixed Spec Contract**, then hands off to the still-mandatory `/stark-review-spec` gate. Its defining property is that it **cannot ratchet the way review-spec can**, enforced by these choices:

- **Closed-enum, host-owned section verdict.** The wing does not emit free-form findings. It returns one status per contract section from a closed enum, keyed by a fixed 9-id `SECTION_IDS` set (`intent`, `scope`, `interfaces`, `behavior`, `ssot`, `security`, `test-plan`, `accessibility`, `open-questions`). The host parser **drops any section id not in the set** (recorded in `dropped_sections`) — the wing structurally cannot ask for a 10th section. A per-item `note` is advisory, scoped to that section's done-when bar. The contract lives at `global/prompts/write-spec/contract.md` (canonical SSOT, resolved via `assetPromptsDir()`); `test_contract_ids_match_asset` binds the parser enum and agent prompts to it so a rename fails tests instead of silently dropping a section.
- **A bounded lead/wing loop mirroring `plan_dispatch.ts`.** Lead drafts/revises the spec against the contract; wing verifies per-section status. `max_rounds` defaults to **3**: drafting against a fixed checklist converges faster than open review, and if 3 rounds cannot satisfy the contract the *intent* is missing information — a human answer, not a 4th round, is the fix. The loop degrades to exactly one verify pass when the first draft is clean (early exit on `done`).
- **Host-recomputed `done` — never trusted from the wing.** `done` = every item `satisfied | n_a`, recomputed by the host over the **full 9-id set**. A known id absent from `items` is treated as `missing`; a reason-less `n_a` as `underspecified`. A partial or lazy verdict can only fail closed (another round), never produce a false `done`. `n_a` is first-class (a section may be justifiably not-applicable), and `over_scoped` lets the wing say "cut this ceremony", so the gate is bidirectional (the #677 lesson), not an inflation vector.
- **Five terminal verdicts** (`final_verdict`, naming parity with `plan_dispatch.ts`): `contract_satisfied` · `max_rounds_unsatisfied` · `lead_empty_draft` · `unchanged_revision` · `wing_unparseable`. Every non-crash exit still writes the spec file and the receipt; `ok = final_verdict === "contract_satisfied"`, any other verdict exits non-zero.
- **Skill-layer accepted-gaps path.** The dispatcher's exit contract is uniform (`max_rounds_unsatisfied` → `ok=false`). On that verdict the *skill* offers, via `AskUserQuestion`: **answer the gaps** (enrich the brief, re-dispatch once — hard bound), **accept with gaps** (append unsatisfied items to the spec's Open Questions verbatim, record `accepted_gaps[]`, exit 0 — honest and visible to review-spec), or **abort**. Headless/`--json` runs auto-resolve max-rounds to accept-with-gaps.
- **Create-or-adopt, idempotent landing.** Host-computed out path (`docs/specs/YYYY-MM-DD-<slug>-spec.md`, slug via `sanitizeSlug`), one final commit on `write-spec/<slug>`, draft PR via the lead's GitHub App. Re-running an existing slug checks the branch out and commits **on top** (never force-push — review threads must survive), adopting any existing PR; a run that died after commit but before push/PR is retried by re-invoking. The handoff line (`next: /stark-review-spec <spec>`) lands on the same branch/PR trail review-spec reuses.

## Alternatives Considered

- **Let review-spec keep authoring implicitly.** Rejected: that *is* the status quo whose inflation the whole breaker suite fights — the problem, not a solution.
- **Import review's adversarial critique into authoring (a critic wing).** Rejected: it re-creates the unbounded ratchet inside stage 0. The wing verifies a checklist; adversarial critique stays in `/stark-review-spec` (mandatory) and red-team (optional).
- **Make the contract config-overridable.** Rejected: repo/org config could then weaken or drop sections. The contract is a versioned prompt asset; config carries knobs only (models, rounds, timeouts).
- **Trust the wing's `done`.** Rejected: a lazy or partial verdict would produce a false-complete spec. Host recomputation over the full id set fails closed.
- **Tournament / 3-agent authoring.** Rejected: the deleted `design_to_plan_dispatch.py` lesson — paired lead/wing is cheaper and lower-variance.

## Consequences

- **Positive:** specs are *born scoped* — the Scope declaration up front means every downstream playground-scope guard stands down instead of de-scoping in each review round; review-spec sees fewer legitimate gaps, so the growth breakers trip less; the contract is a single tunable interface between authoring and review (a recurring review finding class becomes a tightened done-when bar, operator-driven for v1).
- **Cost:** one lead + one wing dispatch in the good case (single verify pass); the wing runs codex at `xhigh` deliberately — its misses become review-spec findings, exactly where inflation lives.
- **Contract churn:** adding a pipeline stage touches the skill list (CLAUDE.md + AGENTS.md), the prompts layout, and a new `write_spec` config section — swept in this change per the docs-in-the-same-change rule.
- **Deferred:** gemini prompts (claude+codex ship at v1; gemini rejected at argument validation until its prompts land), a shared lead/wing loop lib (rule of three — two consumers don't justify extraction), and automated contract tuning (manual for v1).
- Records the contract-bounded authoring decision here rather than leaving it implicit in the spec.
