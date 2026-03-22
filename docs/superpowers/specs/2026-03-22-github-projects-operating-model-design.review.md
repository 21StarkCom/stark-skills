# Plan Review — GitHub Projects Operating Model Design

**File:** `docs/superpowers/specs/2026-03-22-github-projects-operating-model-design.md`
**Date:** 2026-03-22
**Agents:** Claude, Codex (Gemini unavailable)
**Domains:** general, feasibility, completeness, security, operability, scope, api-design
**Sub-agents:** 14 per round (2 agents × 7 domains)
**Rounds:** 2 fix + 1 final

---

**Issues found:** 14 | **Noise:** 43 | **False Positive:** 25 | **Ignored:** 54
**Signal-to-noise:** 17%

---

## Fixed (14 issues resolved across 2 rounds)

### Round 1 — 6 high-confidence cross-agent fixes

| # | Severity | Section | Issue | Fix |
|---|----------|---------|-------|-----|
| 1 | Critical | Automation Layer | `projects_v2_item` not a GitHub Actions trigger — entire Tier 1 unimplementable | Collapsed Tier 1/2 into unified Responsibility Matrix. Actions handle PR/schedule events only. |
| 2 | High | Automation Layer | Merge/release conflation — PR merge skips `ready to release` gates | Added `release-gate` required status check. PR merge blocked until Status = `ready to release`. |
| 3 | High | Error Handling | Fail-open on GraphQL mutation failure contradicts Projects as source of truth | Changed to fail-closed for status transitions. Read-only queries still fail-open with warning. |
| 4 | High | Transition Rules | `changes_requested` always routes to `agent working` even for human-led work | Branch on AI Suitability field: `human-led` → `human working`, otherwise → `agent working`. |
| 5 | High | GitHub Actions | `check_suite.completed` unreliable for compound gate conditions | Replaced with composite gate on `check_run.completed` / `pull_request.synchronize` / `pull_request_review.submitted`. |
| 6 | High | Automation Layer | No atomic claim — two agents can pick same task | Documented accepted risk. Mitigations: branch name collision, stale detection, sequential execution in practice. |

### Round 2 — 8 new fixes

| # | Severity | Section | Issue | Fix |
|---|----------|---------|-------|-----|
| 7 | High | State Machine | No exit path from `blocked` state | Added `blocked → previous state` transition, human-owned. |
| 8 | High | Project Fields | Approval State serves two gates with no reset | Split into `Spec Approval` and `Release Approval` — separate fields, separate lifecycles. |
| 9 | High | Pre-requisites | `auto-set-status-on-close` conflicts with owned `done` transition | Disabled auto-set-status-on-close. We own `done` via Action. |
| 10 | High | State Machine | No handling for PR state regression (new commits after approval) | Added: `pull_request.synchronize` resets Status to `human review`, clears Release Approval to `pending`. |
| 11 | High | Spec Completeness Gate | Human-led work bypasses spec gate | Gate now applies to BOTH `ready for agent` AND `human working`. |
| 12 | Medium | Gate Validations | Gate inputs (artifacts, rollout notes) have no machine-validatable location | Defined: `## Artifacts`, `## Rollout`, `## Rollback`, `## Verification` sections in issue body. |
| 13 | Medium | GitHub Actions | Actions have no mechanism to find correct Project item from PR event | Added lookup mechanism: extract `Closes #N`, query `projectItems`, cache field IDs. |
| 14 | Medium | Transition Rules | Rejected Approval State has no defined recovery path | Added: rejection → `needs spec` (rework) or `blocked` (hard stop). Human chooses. |

## Recurring (3 issues partially fixed in round 1, addressed again in round 2)

| # | Issue | Round 1 Attempt | Round 2 Resolution |
|---|-------|-----------------|--------------------|
| R1 | Approval State double-use | Added lifecycle description | Split into two separate fields (Spec Approval, Release Approval) |
| R2 | Concurrent agent claim race | Added "atomic claim" language | Acknowledged as accepted risk with documented mitigations |
| R3 | Merge/release conflation | Added `ready to release` state | Added `release-gate` status check + per-repo deploy override |

## Unresolved (from final review — remaining at or above threshold)

The final round produced 54 critical/high findings. After classification:
- 0 genuinely new issues
- ~12 re-raises of already-fixed issues in different framing (false positive)
- ~42 noise (scope complaints, security concerns outside spec scope, implementation-detail requests)

**No unresolved issues at fix threshold.**

## Noise & False Positives — Root Cause Analysis

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Scope mismatch** | 29 | Reviewers apply production-system security/monitoring criteria to a dev-tooling design spec. Add context preamble to plan-review prompts: "This is a developer tooling spec, not a production service spec." |
| **Already addressed** | 18 | Findings reference issues fixed in earlier rounds. Reviewers don't see prior fixes. Consider passing a "changes since round N" diff to round N+1. |
| **Overcounting fields/states** | 12 | "13 fields is too many" / "11 statuses is too much." These are judgment calls, not spec defects. |
| **Implementation detail requests** | 9 | Requests for type signatures, monitoring dashboards, deployment scripts. Belong in implementation tickets. |

## Changes Made

See diff above — 14 substantive changes across state machine, transition rules, automation layer, error handling, gate mechanisms, and migration plan.

Key additions:
- Responsibility Matrix with single-owner per transition
- `human working` state for human-led path
- Split Approval State into Spec Approval + Release Approval
- `release-gate` status check bridging Project state into branch protection
- State regression handling (new commits reset approval)
- Blocked state exit path
- Gate input locations (machine-validatable issue body sections)
- Actions → Project item lookup mechanism
- Fail-closed error handling for mutations
- Migration rollback plan
- Concurrency: accepted risk with documented mitigations

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Both agents over-flag security concerns in dev-tooling specs | **Global** | `global/prompts/plan-review/*/security.md` — add context-awareness for spec type |
| Both agents request implementation details in design specs | **Global** | `global/prompts/plan-review/*/feasibility.md` — distinguish design-level from implementation-level concerns |
| Codex generates more noise on scope/complexity | **Repo** | Consider adjusting `fix_threshold` for codex in plan reviews |
| Round-over-round false positives (re-raising fixed issues) | **Orchestrator** | `plan_review_dispatch.py` — pass prior-round fixes as context to subsequent rounds |

---

## Metrics

```
Total duration:     ~43m
Phases:
  Phase 1 (Setup):        6s
  Phase 2 (Review-Fix):   ~25m
    Round 1 dispatch:     2m 49s (14/14 succeeded)
    Round 1 classify+fix: ~8m
    Round 2 dispatch:     3m 46s (14/14 succeeded)
    Round 2 classify+fix: ~7m
  Phase 3 (Final):        2m 49s (14/14 succeeded)
  Phase 4 (Summary):      ~3m
  Phase 5 (Output):       <1m

Issues found:        14 (14 fixed, 0 unresolved)
Noise:               68 (25 false positive, 43 noise)
Agents:              14 dispatched per round, 14 succeeded per round (100%)
Rounds:              2 fix + 1 final
Signal-to-noise:     17%
```

### Improvement Flags

- Signal-to-noise at 17% → prompt tuning recommended (security + feasibility domains)
- No agent failures — healthy dispatch
- Round 2 introduced 0 genuinely new issues in final round — early termination was appropriate
- Round-over-round finding stability (147 → 139 → 136) suggests most real issues caught in round 1
