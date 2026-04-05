# Plan Review — stark-host-aware-monorepo-plan

**File:** `docs/superpowers/specs/2026-04-05-stark-host-aware-monorepo-plan.md`
**Mode:** standard (2 agents × 10 domains)
**Rounds:** 1 fix + 1 final
**Date:** 2026-04-05

---

## Headline

**Issues found:** 11 fixed | **Unresolved:** 2 | **Noise:** ~110 | **Ignored:** 9
**Signal-to-noise:** ~10% (plan reviews generate more noise than design reviews — agents want implementation detail)

---

## Fixed (Round 1 — 11 issues)

| # | Agent(s) | Domain | Severity | Title | Fix |
|---|----------|--------|----------|-------|-----|
| 1 | claude | general | critical | No plan-level success criteria | Added 5 concrete completion criteria |
| 2 | both | sequencing | critical/high | Prompt move in Phase 1 breaks production | Deferred to Phase 3; Phase 1 uses symlink |
| 3 | both | gates/rollback | critical × 5 | Migration has no write fence / cutover | Added cutover sequence explanation in Phase 2.5 |
| 4 | claude | completeness | critical | CI pipeline never defined | Added Phase 3.6 with CI config task |
| 5 | claude | risk | critical | Prompt move breaks install.sh symlinks | Fixed by deferring move to Phase 3.5 |
| 6 | claude | sequencing | high | Phase 4/5 parallel conflict on stark_install.py | Added coordination note: Phase 4 owns framework, Phase 5 extends |
| 7 | claude | timeline | high | Effort labels undefined | Added S/M/L definitions with calendar time |
| 8 | claude | rollback | high | No rollback trigger criteria | Added trigger criteria to rollback summary |
| 9 | codex | feasibility | high | Worker 300s timeout regresses design workflows | Made timeout configurable per-workflow |
| 10 | claude | timeline | high | Phase 0 Codex decision can block indefinitely | Added 1-week deadline with auto-fallback |
| 11 | claude | risk | high | install.sh removal breaks external consumers | Changed to deprecation period, not immediate removal |

## Unresolved (Final Round)

1. **Migration execution should be an explicit Phase 6 task** (critical, claude/completeness) — The cutover sequence (dry-run → deploy hosts → migrate → verify → update epoch) is documented in Phase 2.5 prose but has no corresponding Phase 6 task. This should be task 6.3a or similar. *Fix during plan execution — add the task when Phase 6 work begins.*

2. **No backup strategy for `~/.stark/runtime/`** (critical, codex/operability) — The runtime is the sole write target for new runs, but the plan has no backup/restore procedure. For a single-user local tool this is low-risk, but a one-liner backup command should be documented. *Fix: add `tar czf ~/.stark/runtime-backup-$(date +%F).tgz ~/.stark/runtime/` to the ops maintenance doc in Phase 6.4.*

## Noise Analysis

The agents generated ~110 noise findings, mostly in these categories:

| Root Cause | Count | Assessment |
|------------|-------|-----------|
| **Migration write fence demand** | ~25 | Agents expect a traditional stop-the-world migration. The design avoids this by construction — host adapters write to Stark once deployed, legacy scripts continue writing to legacy. No dual-write window exists. |
| **Implementation detail in a plan** | ~35 | Agents want schema field lists, exact error codes, retry backoff parameters. These are implementation decisions, not plan-level. |
| **Phase C coupling concerns** | ~15 | Multiple findings about deferred workflows breaking. Phase C is explicitly out of scope — deferred workflows stay Claude-only. |
| **Single-engineer staffing risk** | ~10 | Valid observation that 1 engineer = serial execution = longer timeline. Already noted in effort estimates. |
| **Monitoring/alerting for local tool** | ~10 | Agents want production-grade monitoring. This is a single-user CLI tool, not a service. |

---

## Metrics

```
Total duration:     ~12m
Phases:
  Phase 1 (Setup):       5s
  Phase 2 (Review-Fix):  ~7m
    Round 1 dispatch:    4m 06s (246s)
    Round 1 classify+fix: ~3m
  Phase 3 (Final):       ~4m (review-only dispatch)
  Phase 4+5 (Summary):   ~1m

Issues found:        11 fixed, 2 unresolved
Noise:               ~110
Signal-to-noise:     ~10%
Agents:              40 dispatched (20×2 rounds), 40 succeeded, 0 failed
Rounds:              1 fix + 1 final
```
