# Plan Review — stark-persona

**File:** `docs/specs/2026-03-28-stark-persona-plan.md`
**Date:** 2026-03-28
**Mode:** Standard (2 agents × 10 domains)
**Rounds:** 1 fix + 1 final

---

**Issues found:** 11 | **Noise:** ~112 | **Ignored:** ~20 (low)
**Signal-to-noise:** 9%

## Fixed (Round 1)

| # | Agent(s) | Domain | Title |
|---|----------|--------|-------|
| 1 | claude | feasibility | `--auto` flag undefined |
| 2 | codex | feasibility | Helper path fails from installed skill |
| 3 | claude | gates | No go/no-go gates between phases |
| 4 | claude | completeness | Missing pytest/SQLite setup |
| 5 | claude | sequencing | No deploy step before producer emission |
| 6 | claude,codex | security | `--add` prompt injection risk |
| 7 | claude | risk | No SQLite corruption recovery |
| 8 | claude | risk | No contract test for CLI↔SKILL interface |
| 9 | claude | general | Weight formula not in plan |
| 10 | claude | general | Parallel roster merge conflicts |
| 11 | codex | sequencing | Survey can block session start |

## Unresolved (Classified as Noise)

| Root Cause | Count | Assessment |
|------------|-------|-----------|
| **Timeline overkill** | ~15 | Calendar dates, deadlines, buffer time, backup person — this is a personal tool, not a team project with stakeholders |
| **Operability overkill** | ~12 | Golden signals, dashboards, canary rollout, staged enablement — for a persona selector |
| **Rollback paranoia** | ~10 | Rehearsed rollbacks, L0/L1/L2 levels, point-of-no-return — rolling back means deleting a folder |
| **Gate ceremony** | ~8 | Sign-off requirements, evidence packages, bake periods — single developer, no approval chain |
| **Risk inflation** | ~7 | Circuit breakers, corruption detection, contract versioning — 2s timeout + silent skip already handles this |

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Plan-review prompts apply production-system operability expectations to personal developer tools | Global | `global/prompts/plan-review/*/05-operability.md` — add context awareness for personal vs team tools |
| Timeline domain assumes multi-person team with deadlines | Global | `global/prompts/plan-review/*/10-timeline.md` — don't demand calendar dates for solo projects |
| Rollback domain expects L1/L2 rehearsal levels | Global | `global/prompts/plan-review/*/07-rollback.md` — scale expectations to blast radius |

## Metrics

```
Total duration:     ~10m
Phases:
  Phase 1 (Setup):       2s
  Phase 2 (Review-Fix):  6m 30s
    Round 1 dispatch:    4m 30s
    Round 1 fix:         2m
  Phase 3 (Final):       4m 30s

Issues found:        11 (all fixed in round 1)
Noise:               ~112
Signal-to-noise:     9%
Agents:              40 dispatched, 40 succeeded
Rounds:              1 fix + 1 final
```

No improvement opportunities detected (all agents succeeded).
