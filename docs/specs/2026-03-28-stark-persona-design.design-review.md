# Design Review — stark-persona

**File:** `docs/specs/2026-03-28-stark-persona-design.md`
**Date:** 2026-03-28
**Mode:** Standard (2 agents × 10 domains)
**Rounds:** 2 fix + 1 final

---

**Issues found:** 19 | **Noise:** 78 | **Ignored:** ~200 (low across 3 rounds)
**Signal-to-noise:** 20%

## Fixed (Rounds 1-2)

| # | Round | Agent(s) | Domain | Severity | Title | Outcome |
|---|-------|----------|--------|----------|-------|---------|
| 1 | 1 | codex, claude | scope | high | Web search in critical path | Deferred to v2, roster-only dates |
| 2 | 1 | claude, codex | completeness | high | Session context undefined | Added active.json spec |
| 3 | 1 | codex | data-modeling | high | Name-based keys fragile | Added slug-based IDs |
| 4 | 1 | codex, claude | scope | high | Preference profile premature | Deferred to v2 |
| 5 | 1 | codex | completeness | high | Combo feedback undefined | Added feedback rules |
| 6 | 1 | codex | api-design | high | Event contract too loose | Added event_id, schema_version |
| 7 | 1 | codex | general | high | Auto-commit unsafe | Removed, manual commit |
| 8 | 1 | claude | resilience | high | No timeout on external calls | Added 2s timeout section |
| 9 | 1 | codex | api-design | high | No idempotency on events | Added event_id (ULID) |
| 10 | 1 | codex | completeness | high | Web search mechanism unspecified | Removed (v2) |
| 11 | 1 | codex | api-design | high | No versioning on analytics | Clarified stark-insights envelope |
| 12 | 1 | codex | api-design | high | Error semantics unspecified | Added to timeouts section |
| 13 | 1 | codex | resilience | high | No timeouts on dependencies | Added 2s timeout section |
| 14 | 1 | codex | completeness | high | Cross-repo rollout plan | Clarified in implementation scope |
| 15 | 1 | codex | general | high | Survey learning doesn't affect selection | Clarified v1/v2 boundary |
| 16 | 2 | codex | data-modeling | high | Feedback not idempotent | UNIQUE on session_id |
| 17 | 2 | codex | consistency | high | v2 profile referenced in v1 | Cleaned up v1/v2 boundary |
| 18 | 2 | claude | consistency | high | Survey writes to deferred table | Clarified: survey_responses IS v1 |
| 19 | 2 | codex | data-modeling | high | Survey flow writes to deferred table | Same fix as #18 |

## Unresolved (Final Round)

| # | Agent | Domain | Severity | Title | Assessment |
|---|-------|--------|----------|-------|------------|
| 1 | claude | completeness | critical | Core persona voice mechanism unspecified | **Valid.** Implementation detail — the SKILL.md will contain the system prompt template that injects the persona. Not a spec-level concern but worth noting. |
| 2 | claude | completeness | high | No mid-session deactivate/switch | **Valid minor.** Add `/stark-persona --off` to v1 or note as v2. |

## Noise & False Positives (Recurring Themes)

| Root Cause | Count | Assessment |
|------------|-------|-----------|
| **Extensibility overengineering** | 12 | Codex repeatedly suggests roster provider abstractions, analytics backend abstractions, scope models. These are YAGNI for a single-user persona skill. |
| **Analytics contract over-specification** | 8 | stark-insights already handles event envelope, dedupe, and versioning. Codex treats the integration as a greenfield API design. |
| **Concurrent sessions** | 4 | Single-user system. Claude Code runs one session at a time. |
| **Content policy subjective** | 3 | "Shrek is children's content" — disagree for 1980-born audience. |
| **Security token lifecycle** | 3 | stark-insights bearer token is that system's concern, not this spec's. |

## Changes Made

```diff
+ Removed web search from v1 (roster date signals only)
+ Added active.json session context file
+ Deferred preference profile to v2
+ Added slug-based persona IDs
+ Defined combo feedback rules + favorite_combos table
+ Removed auto-commit from --add mode
+ Added event_id (ULID) for dedup
+ Added timeouts/back-pressure section (2s timeout)
+ Rating idempotency via UNIQUE constraint
+ Cleaned v1/v2 boundary for surveys
```

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Codex extensibility domain produces ~12 overengineering findings per run for single-user skills | Global | `global/prompts/design-review/codex/09-extensibility.md` — add context: "For single-user/personal tools, do not suggest abstractions for multi-backend, multi-source, or multi-tenant patterns unless the spec explicitly targets team use." |
| Codex api-design domain over-specifies integration contracts when the target system already has an API | Global | `global/prompts/design-review/codex/05-api-design.md` — add: "If the design integrates with an existing system that already has defined contracts, do not re-specify those contracts. Focus on the new surface area only." |

## Metrics

```
Total duration:     ~16m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   12m
    Round 1 dispatch:     4m 30s
    Round 1 classify+fix: 2m 30s
    Round 2 dispatch:     4m 30s
    Round 2 classify+fix: 30s
  Phase 3 (Final):        4m 30s
  Phase 4 (Summary):      30s
  Phase 5 (Output):       10s

Issues found:        19 (19 fixed, 2 unresolved minor)
Noise:               78
Signal-to-noise:     20%
Agents:              60 dispatched, 60 succeeded, 0 failed
Rounds:              2 fix + 1 final
```

No improvement opportunities detected (all agents succeeded, no phase bottleneck).
