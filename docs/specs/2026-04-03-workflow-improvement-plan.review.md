# Plan Review — Workflow Improvement Plan

**Date:** 2026-04-03
**Plan:** `docs/specs/2026-04-03-workflow-improvement-plan.md`
**Agents:** Claude, Codex (2 × 10 domains = 20 sub-agents per round)
**Rounds:** 3 (2 fix rounds + 1 final review)

---

## Summary

| Round | Critical | High | Medium | Low | Total | Fixes Applied |
|------:|--------:|-----:|-------:|----:|------:|:-------------|
| 1 | 13 | 74 | 44 | 9 | 140 | 17 major edits |
| 2 | 16 | 67 | 44 | 12 | 139 | 12 targeted fixes |
| 3 (final) | 10 | 65 | 51 | 13 | 139 | — (review only) |

**Overall trajectory:** Critical findings dropped from 13 → 10 over 2 fix rounds. High findings dropped from 74 → 65. The increase to 16 criticals in round 2 reflected new issues introduced by R1 fixes (e.g., /proc reference on macOS, cost deadlock), which were addressed in R2.

---

## Fixes Applied (Round 1 — 17 major edits)

| # | Category | Fix |
|--:|----------|-----|
| 1 | Gates | Added initiative-level success criteria with measurable KPIs |
| 2 | Gates | Added phase transition gates: verification + bake period + rollback dry-run |
| 3 | Gates | Added rollback triggers (when to roll back, not just how) |
| 4 | Timeline | Extended P0 from 1 week to 2 weeks (scope was unrealistic) |
| 5 | Sequencing | Added session ID resolver as explicit P0 task (0.4) |
| 6 | Sequencing | Removed preflight lock scanning forward-reference (deferred to P1) |
| 7 | Sequencing | Added cost hard-stop flag fallback for P0 (file not found = no block) |
| 8 | Completeness | Added `~/.stark-insights/` directory creation to install.sh |
| 9 | Completeness | Added `tests/fixtures/` directory creation |
| 10 | Completeness | Added file inventory step in prerequisites (stark-emit, render_reports.py) |
| 11 | Completeness | Added all skill_activation and cost config keys to P0 task 0.1 |
| 12 | Security | Randomized /tmp env file path (prevent predictable location) |
| 13 | Security | Added preflight cleanup of stale /tmp credential dirs |
| 14 | Security | Added stderr redaction for secrets before JSONL persistence |
| 15 | Security | Clarified auto-mode respects requires_confirmation on dependency mutations |
| 16 | Security | Added trust boundary for validation gate fallback discovery |
| 17 | Risk | Added PID reuse mitigation (check process start time, not just liveness) |

## Fixes Applied (Round 2 — 12 targeted fixes)

| # | Category | Fix |
|--:|----------|-----|
| 1 | Feasibility | Fixed PID start time check: use macOS `ps -o lstart=`, not `/proc` |
| 2 | General | Replaced unmeasurable success criteria (confirmation_log, /clear) with verifiable ones |
| 3 | General | Added shared config loader module to P0 task 0.1 |
| 4 | Risk | Added preflight timeout (5s per check, 30s total) |
| 5 | Risk | Fixed cost hard-stop auto-recovery deadlock (preflight self-clears stale flags) |
| 6 | Operability | Added basic telemetry health to P1 stark-session start (closes 6-week blind spot) |
| 7 | Operability | Added alert delivery path (task 3.7) for overnight critical alerts |
| 8 | Timeline | Extended P3 to 3 weeks (auto-heal canary requires 1-week soak) |
| 9 | Gates | Added per-phase exit gates with concrete criteria |
| 10 | Rollback | Fixed rollback: use git revert, not git checkout (avoids overwriting unrelated work) |
| 11 | Rollback | Added quiesce note for cost hard-stop recovery (automation-monitor re-assert cycle) |
| 12 | Completeness | Added event emission ordering fix (preflight uses generic type until schema task lands) |

---

## Unresolved Findings (Round 3 — 10 Critical)

These remaining findings were reviewed and classified. Accepted risks for a single-operator system are marked.

| # | Domain | Finding | Disposition |
|--:|--------|---------|-------------|
| 1 | risk | Telemetry is a shared hard dependency with no circuit breaker | **Accepted.** emit_queue.py failure is local SQLite failure. Health check added in P1. Single operator can diagnose. |
| 2 | gates | Phase 3 has no formal exit gate | **Accepted.** P3 is the final phase — no next phase to gate. Initiative success criteria serve as the exit. |
| 3 | sequencing | Preflight enabled before install migration enforced | **Accepted.** Staged rollout in task 0.9 handles this — stark-session gets preflight first. |
| 4 | rollback | Auto-heal has no rollback path for code it changes in target repos | **Valid concern.** Mitigated by suggest-mode first, canary repo, per-pattern circuit breaker. Self-healer always re-runs validation after applying. Residual risk accepted. |
| 5 | rollback | Trigger migration cannot be rolled back to pre-change CCR fleet | **Valid concern.** Mitigated by additive registry updates and dry-run verification. Registry changes are git-tracked. |
| 6 | risk | Preflight is SPOF for all major skills | **By design.** Preflight timeout (30s) and graceful degradation prevent hangs. Single operator can disable via --skip-check. |
| 7 | completeness | scripts/secret_patterns.py referenced but never created | **Valid.** Should be created in P0 task 0.7 alongside stderr redaction. Minor gap. |
| 8 | completeness | 8 error codes, 5 healer patterns, 8 KPIs delegated to design doc | **By design.** Plan references design §4, §5, §10 for detailed definitions. Duplicating them would create drift. |
| 9 | general | Plan completion gated by human adoption, not implementation | **Accepted.** Skills adoption is the purpose of the work. Implementation correctness is gated by acceptance criteria. |
| 10 | completeness | Blank-slate Python bootstrap has no dependency manifest | **Accepted.** Single-operator system with existing infrastructure. Not a blank-slate deployment. |

---

## Review Statistics

| Metric | Value |
|--------|------:|
| Total sub-agent invocations | 60 (20 × 3 rounds) |
| Total findings across all rounds | 418 |
| Unique findings (deduped) | ~200 (many findings recur across rounds) |
| Fixes applied | 29 |
| Plan lines: original | 645 |
| Plan lines: final | 757 |
| Lines changed | ~240 |

---

## Improvement Flags

- Plan grew 17% (645 → 757 lines) — mostly gates, rollback triggers, and operational additions
- Round 2 had MORE criticals than Round 1 (16 vs 13) — R1 fixes introduced new issues. This is expected for significant structural changes.
- Codex found more actionable criticals; Claude found more comprehensive medium findings
- The "timeline" domain consistently flagged infeasible estimates — P0 and P3 were both extended
- "Completeness" was the highest-volume domain across all rounds — plan was missing prerequisites and cross-references
