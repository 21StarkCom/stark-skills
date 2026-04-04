# Plan Review — Domain Triage Implementation Plan

**File:** `docs/superpowers/specs/2026-04-04-domain-triage-plan.md`
**Mode:** standard (2 agents × 10 adversarial domains)
**Rounds:** 1 fix + 1 final

---

## Headline

**Issues found:** 28 | **Noise:** 47 | **Ignored:** 42
**Signal-to-noise:** 37%

---

## Round 1 — Fix Round

**Dispatch:** 20/20 sub-agents succeeded (claude × 10, codex × 10)
**Findings:** 117 total — 14 critical, 54 high, 39 medium, 10 low
**Fixed:** 28 | **False positive:** 25 | **Noise:** 22 | **Ignored:** 42

### Fixed (28 — major themes)

1. **Gate criteria contradictory** — "critical/high" vs "medium+" resolved to "critical/high only"
2. **No timeline** — Added weekly targets with 5-day bake period
3. **No owner** — Added Aryeh as owner + go/no-go authority
4. **Phase 0 not in Phase 2 deps** — Made explicit dependency
5. **Shadow posts live PR comments** — `--shadow` now implies `--dry-run`
6. **Shadow only validates PRs** — Added design (5 docs) + plan (5 docs) validation
7. **Fallback is a comment** — Changed to `|| fallback` executable pattern
8. **triage_would_skip schema undefined** — Added to shadow output schema
9. **15s timeout too aggressive** — Changed to 45s
10. **PR input mismatch** — Changed to `git diff {base}...HEAD` (same as dispatch)
11. **design-review needs --prompts-dir** — Added review-type-to-dispatch mapping
12. **--tournament not supported** — Stays on direct dispatch for V1
13. **Zero-domain = silent exit** — Changed to fallback to full
14. **Phase 5 global flip** — Added canary stage (one repo first)
15. **Insights auth missing** — Added Bearer token from api-token file
16. **Pre-flight checks** — Added for claude_utils, JSON stdout, domain field
17. **Domain slug alignment** — Added verification step
18. **Eval/golden discovery** — Added find command
19. **Atomic commit** — SKILL.md + golden in same commit
20. **Rollback triggers** — Defined for each phase
21. **Bake period** — Added 5-day minimum between Phase 3 and 4
22. **analyze_shadow.py** — Added as gate metric computation tool
23. **Per-review-type config** — Added plan_review.triage block
24. **insights_url configurable** — Added to triage config
25. **Dispatch execution timeout** — Added 10-minute default
26. **--round pass-through** — Listed as forwarded arg
27. **Contract preservation** — Orchestrator JSON must be wire-compatible
28. **Phase 5 rollback triggers** — Defined fallback rate / latency thresholds

---

## Final Review (Round 2)

**Dispatch:** 20/20 sub-agents succeeded
**Findings:** 114 total — 9 critical, 52 high, 41 medium, 12 low

### Unresolved (notable, implementation-level)

| # | Severity | Title | Assessment |
|---|----------|-------|------------|
| 1 | critical | PR checkout/worktree gap | Valid — orchestrator runs `git diff base...HEAD` in CWD, but for cross-repo PRs this requires checking out the target repo. Implementation detail — add `--repo-dir` to orchestrator. |
| 2 | critical | `--dry-run` semantics contradictory | Skill context: dispatch-but-don't-post. Orchestrator context: triage-only. Resolve: `--dry-run` means "no GitHub posting" everywhere. `--triage-only` for triage-without-dispatch. |
| 3 | critical | Canary duration 1 day vs 3-5 days | Timeline says "1 day canary → 1 day global" but Phase 5.1 says "3-5 days". Fix in implementation: 3-5 days. |
| 4 | high | `||` fallback can replay partial review | Valid — if orchestrator crashes mid-dispatch, fallback re-runs entire review. Mitigate: orchestrator sets exit code 0 on successful dispatch, non-zero only on pre-dispatch failure. Fallback only fires on pre-dispatch crash. |
| 5 | high | `analyze_shadow.py` has no implementation spec | Valid — define during Phase 4 implementation. Input: directory of JSON files. Output: markdown + pass/fail exit code. |
| 6 | high | Shell variables in Phase 4 commands are undefined | Valid — these are pseudocode. Phase 4 tasks will use concrete PR numbers from historical data. |
| 7 | high | Prompt injection can suppress security domain | Addressed in design (structural delimiters). Future: add "always-relevant" domain list. Not blocking V1 — conservative mode retains domains with < 0.8 confidence. |

---

## Metrics

```
Total duration:     ~25m
Phases:
  Phase 1 (Setup):        2s
  Phase 2 (Review-Fix):   ~14m
    Round 1 dispatch:     ~6m
    Round 1 classify+fix: ~8m
  Phase 3 (Final):        ~7m
  Phase 4 (Summary):      2m
  Phase 5 (Output):       30s

Issues found:        28 (28 fixed, 7 unresolved in final)
Noise:               47 (25 false positive, 22 noise)
Signal-to-noise:     37%
Agents:              40 dispatched, 40 succeeded, 0 failed
Rounds:              1 fix + 1 final
```

### Improvement Flags

- Signal-to-noise at 37% — adversarial review generates more noise than design review (expected).
- "Single engineer critical path" flagged as risk — this is a one-person project, not a team concern.
- Telemetry durability concern flagged repeatedly — known design decision to use direct POST for V1, documented.
- No improvement bottleneck detected (no phase > 70% of total).
