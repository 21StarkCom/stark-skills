# Design-to-Plan Cross-Review — stark-red-team v1.2

**Date:** 2026-05-01
**Design:** [`2026-05-01-stark-red-team-fix-plan-and-insights-design.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-design.md)
**Plan output:** [`2026-05-01-stark-red-team-fix-plan-and-insights-plan.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-plan.md)
**Mode:** `/stark-design-to-plan` (3 agents: claude, codex, gemini)

## Scorecard

| Plan author | Completeness | Feasibility | Phasing | Risk Coverage | Testability | **Avg** |
|---|---|---|---|---|---|---|
| **codex**  | 8.50 | 8.50 | 8.00 | 7.50 | 8.50 | **8.20** ★ |
| claude     | 8.50 | 7.50 | 7.00 | 8.00 | 8.00 | **7.80** |
| gemini     | 7.00 | 6.50 | 7.00 | 6.00 | 6.50 | **6.60** |

**Winner:** codex (8.20) — but margin to claude (7.80) is **0.40 < 0.50** → **declared a tie**, synthesizing both equally per the `/stark-design-to-plan` rule.

## Per-plan summaries

### codex — 8.20 (winner)

**Reviewers:** claude, gemini.

**Strengths flagged by reviewers:**

- *(claude)* Phasing cleanly separates disabled-default ship (Phases 1–9) from calibration (Phase 10) and enable-flip (Phase 11), matching design §13's rollout order and resolving the rt15 calibration-before-flip gate.
- *(claude)* Phase 5 explicitly preserves the §10 invariant that exit/final_status derive solely from `RedTeamResult` and includes a regression test.
- *(claude)* Integration Points section correctly identifies `RedTeamRunContext`, `serialize_findings_envelope`, `fix_plan_json`, and shared dedupe-key construction as the load-bearing contracts.
- *(claude)* Phase 3 migration tasks cover all five required DB states (fresh, v1.0, v1.1, v1.2, partially migrated).
- *(claude)* Rollback plan correctly notes additive SQLite columns should not be destructively rolled back.
- *(gemini)* Accurately captures the precise move-count pruning contract.
- *(gemini)* Properly sequences the disabled-by-default rollout ritual.
- *(gemini)* Recognizes the critical role of `RedTeamRunContext`.
- *(gemini)* Adopts the additive-only, missing-column-gated migration strategy.

**Weaknesses flagged by reviewers:**

- *(claude)* Phase 2 Task 4 misstates the move-count contract; missing post-prune re-check that can demote success → error if drops push below `min_moves`.
- *(claude)* Phase 4 `emit_run` timing relative to fix-plan call unclear; must fire AFTER fix-plan resolves so `fix_plan_status` is accurate.
- *(claude)* Phase 8 lifter smoke-test auth gap admitted but not solved; design §12.3 acceptance not executable without it.
- *(claude)* Phase 6 backfill tests omit the §6.3 server-side dedupe-key-prefixed verification AND the explicit kill-mid-drain resume test.
- *(claude)* Phase 10 calibration tasks lack a structured harness for capturing per-fixture cost/duration/tokens across 30+ runs.
- *(claude)* Phase 5 Task 4 PR-comment truncation order is ambiguous; the §4.2 algorithm should be spelled out (notes first, then per-move rationale to 200 chars).
- *(claude)* No phase explicitly tests the §11.1 worst-case ceiling or asserts `max_output_tokens=32768` wiring.
- *(gemini)* Cross-repo parallelization missed: Phase 8 (stark-insights lifters) is linearly sequenced after backfill, but the design explicitly decouples it.
- *(gemini)* Post-call budget warning omitted from Phase 5; `over_budget_after_fix` is the calibration signal but is missing from the plan.
- *(gemini)* Error template rendering omits the design's required retry instruction (`--no-pr-comment`).

### claude — 7.80 (runner-up, tied)

**Reviewers:** codex, gemini.

**Strengths flagged by reviewers:**

- *(codex)* Preserves the design's core invariant that challenge-call status is independent of fix-plan success or failure.
- *(codex)* Phases 1–3 cover most critical implementation mechanics: config locking, SQLite migration, fix-plan prompt assembly, structured truncation, validation, sidecar rendering, dispatcher gating.
- *(codex)* Backfill and insights sections correctly use stable dedupe keys based on `run_id`.
- *(codex)* Explicitly ships with `fix_plan.enabled=false` and separates the production enable flip.
- *(gemini)* Excellent breakdown of the rollback plan by phase, providing fine-grained recovery options.
- *(gemini)* Thorough validation of all truncation and limit edge cases explicitly called out in Phase 2 and 3 tasks.
- *(gemini)* Smart decoupling of the config flag flip (Phase 7) from the main code merge, reducing rollout risk.

**Weaknesses flagged by reviewers:**

- *(codex)* Phase 1 Task 5 says `record_red_team_run` will persist `pr_number` but Phase 1 Task 4 doesn't migrate that column.
- *(codex)* Phase 5 says backfill should reuse `red_team_insights` builders, but the Phase 4 builders accept `RedTeamResult` / `ctx` dataclasses — backfill has SQLite rows. Need pure builders accepting primitives.
- *(codex)* Phase 4 `emit_fix_plan(ctx, fix_plan)` doesn't accept `fix_plan_md`, but the §5.2 payload requires it.
- *(codex)* Phase 3 Task 2 ambiguates the input-size gate: dispatcher pre-evaluates `findings_serialization_fits` while Phase 2 Task 6 says `run_red_team_fix_plan` performs serialization itself.
- *(codex)* Plan is internally inconsistent on `run_red_team`'s interface: Phase 1 says signature unchanged but Phase 3 says pass `ctx` to it.
- *(codex)* Phase 6 phasing conflicts with the original rollout — calibration after merge instead of before.
- *(codex)* Plan omits `skill/stark-red-team-design/SKILL.md` and `skill/stark-red-team-plan/SKILL.md` updates.
- *(codex)* `over_budget_after_fix` should appear on `red_team_run.payload.warnings` AND `red_team_fix_plan.payload.warnings`; plan only includes the latter.
- *(codex)* Test plan treats cloud-side queue drain and Cloud SQL dedupe checks as ordinary tests — not reliably executable in CI.
- *(codex)* Phases 4 and 7 both contain stark-insights lifter work, creating duplicate ownership.
- *(gemini)* Phase 5 (backfill) strictly dependent on Phase 4 (insights emission); could parallelize via shared envelope builders.
- *(gemini)* Identifies stark-insights retroactive re-lifts risk for backfilled data but leaves it as an open ambiguity.

### gemini — 6.60

**Reviewers:** claude, codex.

**Strengths flagged by reviewers:**

- *(claude)* Phase 1 correctly bundles all schema/config/telemetry plumbing as a single foundational layer that can land independently with `enabled: false`.
- *(claude)* Phase 2 isolates the high-risk pieces (`serialize_findings_envelope` truncation safety and `validate_fix_plan` move-count contract) with targeted unit tests.
- *(claude)* Verification snippets are concrete (actual `sqlite3` PRAGMA queries, `pytest -k` invocations), making each phase's done-criteria executable.
- *(codex)* Identifies that persistence/telemetry and core fix-plan logic can proceed independently, with dispatcher integration after both are available.
- *(codex)* Phase 2 captures the highest-risk core mechanics from the design.
- *(codex)* Includes the disabled-by-default rollout shape, calibration override flow, and async insights emission as separate operational workstreams.

**Weaknesses flagged by reviewers:**

- *(claude)* Phase 1 declares Phase 2 a parallel track but Phase 1 task 4 emits `RedTeamFixPlan` payloads whose dataclass is defined in Phase 2 — circular.
- *(claude)* Plan omits the §3.5 acceptance test requiring byte-identical `RedTeamRunContext` propagation across all sinks (rt2 resolution).
- *(claude)* Phase 4's calibration step lacks the §11.2 hard pre-merge gate semantics — sequences calibration AFTER merge.
- *(claude)* Risk coverage misses the §10 invariant test, the `worst_severity: null` lifter NULL-handling, the §4.2 65 KB truncation cascade.
- *(claude)* Phase 3 testing strategy doesn't enumerate the §4.1 untrusted-content escape cases.
- *(claude)* Backfill resume idempotency mentioned as risk but not as explicit verification step.
- *(claude)* Phase 4 rollback for enablement is underspecified.
- *(codex)* Phase 3 gating under-specified: `fits_safely` is only known after serializing findings inside `run_red_team_fix_plan`; design requires skip status `skipped_input_too_large` without dispatching.
- *(codex)* Plan omits several required dispatcher outputs: PR-comment truncation parity, updated sidecar commit message, all success/error/skip sidecar variants.
- *(codex)* Backfill tasks too vague: doesn't mention `absent_pre_v1_2`, `created_at` as event timestamp, `repo` null-to-`unknown`, exact dedupe keys, forward-scope reconstruction, malformed-row skip.
- *(codex)* Telemetry implementation incomplete: doesn't require canonical payload schemas, `warnings` always present, success-only fix-plan emission, `fix_plan_md` in event.
- *(codex)* stark-insights work not executable as written: references files in a separate repo without addressing cross-repo deployment.
- *(codex)* Acceptance coverage incomplete: omits `SKILL.md` updates, `skill-creator` structural eval, fixture-enabled CI/calibration acceptance split.
- *(codex)* Some verification commands unsafe: implies live API use for tests that the design says should mock.
- *(codex)* Rollback coverage shallow for telemetry and migration side effects.

## Synthesis Decisions

The synthesized plan in `2026-05-01-stark-red-team-fix-plan-and-insights-plan.md` makes the following merge decisions:

| Element | Source | Reason |
|---|---|---|
| 11-phase structure | codex base | Highest score on phasing (8.0); cleanly separates ship → calibrate → flip |
| Cross-repo parallelization (Phase 8 ⟂ Phases 1–7) | gemini→codex review | Producer-consumer decoupling per design §5.3 |
| Move-count post-prune re-check (Phase 2 Task 4) | claude→codex review | Validates design §3.4 invariant |
| `max_output_tokens=32768` wiring test (Phase 2 Task 5) | claude→codex review | Closes worst-case ceiling gap |
| `preflight_findings_envelope` centralized helper (Phase 2 Task 6) | codex→claude review | Resolves dispatcher/core decision-point ambiguity |
| Pure builders + thin emit wrappers (Phase 4 Task 1) | codex→claude review | Backfill needs primitive-accepting builders |
| `emit_run` AFTER fix-plan (Phase 5 Task 7) | claude→codex review | Ensures `fix_plan_status` accuracy |
| `over_budget_after_fix` on BOTH payloads (Phase 5 Task 3) | gemini→codex + codex→claude reviews | Calibration signal visible from either dashboard |
| Error template retry hint (Phase 5 Task 4) | gemini→codex review | Surfaces the `--no-pr-comment` recovery path |
| Explicit PR-comment truncation algorithm (Phase 5 Task 5) | claude→codex review | Removes ambiguity on truncation order |
| Phase 8 Task 0 (auth path investigation) | claude→codex review | Closes hand-wavy lifter smoke-test |
| Backfill manifest + kill-mid-drain test (Phase 6) | both reviewers | Idempotency verification + targeted rollback |
| Calibration harness script (Phase 10 Task 2) | claude→codex review | Replaces fragile manual aggregation |
| Calibration BEFORE merge (Phase 10 ⊥ Phase 11) | codex base | Matches design rt15 + §13 rollout order |
| Local `pr_number` column (Phase 3 Task 1) | codex→claude review | Closes consistency gap with payload requirement |
| Rollback table + ambiguities-flagged section | claude plan | Higher risk_coverage strength (8.0 vs 7.5) |

## What got dropped

Findings flagged by both reviewers of the same plan:
- gemini's circular Phase 1↔Phase 2 dependency was dropped (we use codex's clean linear ordering).
- gemini's calibration-after-merge sequencing was dropped (we use codex's calibration-before-merge per design rt15).

Findings flagged by only one reviewer that introduced ambiguity rather than substance:
- claude's "Phase 5 strictly dependent on Phase 4" critique of gemini was preserved as the basis for our pure-builder split (Phase 4 Task 1).
