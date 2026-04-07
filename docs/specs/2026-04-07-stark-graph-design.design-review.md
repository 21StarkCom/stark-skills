# Design Review — stark-graph

**File:** `docs/specs/2026-04-07-stark-graph-design.md`
**Date:** 2026-04-07
**Mode:** Standard (2 agents × 12 domains)
**Rounds:** 2 fix + 1 final

---

**Issues found:** 26 | **Noise:** 77 | **Ignored:** 0
**Signal-to-noise:** 25%

## Fixed (Round 1 — 21 issues)

| # | Agent(s) | Domain | Severity | Title | Outcome |
|---|----------|--------|----------|-------|---------|
| 1 | claude×2, codex×2 | api-design, data-modeling, extensibility | critical/high | No schema_version on JSON artifacts | Fixed — added schema_version to all envelopes |
| 2 | claude×2, codex×2 | completeness, data-modeling, general | critical/high | Main-branch graph storage undefined | Fixed — defined CI artifact storage + worktree-based base graph |
| 3 | claude×3, codex | completeness, scalability, data-modeling | high | Blast radius algorithm unspecified | Fixed — BFS with depth cap 5, cycle-safe, documented |
| 4 | claude, codex | api-design | critical | Inter-stage data contracts missing | Fixed — defined .stark-graph/ workdir convention |
| 5 | claude×3, codex×2 | api-design, completeness, resilience | high | Stage error contracts undefined | Fixed — exit 0/1/2 contract, graceful degradation |
| 6 | claude×4, codex×2 | test-plan | critical | No test strategy | Fixed — added testing section with unit/integration/acceptance |
| 7 | claude×2 | consistency | high | Module node ID format inconsistent | Fixed — defined 2-part (module) vs 3-part (class) convention |
| 8 | claude×3, codex×2 | general, consistency, api-design | high | changed_edges.detail not producible from model | Fixed — deferred to Phase 2 |
| 9 | codex×3, claude | general, data-modeling, extensibility | high | Short-name matching ambiguity | Fixed — switched to qualified names |
| 10 | codex×2, claude | api-design, completeness, consistency | high | No --audit mode in CLI | Fixed — added --stage audit |
| 11 | claude×2, codex | general, resilience | high | No --warn mode / phased rollout | Fixed — added --warn flag and bootstrap phasing |
| 12 | claude | consistency | high | Stage count says 7, only 6 defined | Fixed — corrected to 4 MVP stages |
| 13 | claude, codex | completeness, consistency | high | Cross-repo described in MVP and Phase 2 | Fixed — clarified merge is Phase 2 only |
| 14 | codex | consistency | high | Publishes/Called-by vs edge types mismatch | Fixed — explicit node fields, not edge types |
| 15 | claude×2, codex×2 | test-plan, general | high | No acceptance criteria | Fixed — added per-component criteria |
| 16 | claude, codex×2 | scalability | medium | No capacity baseline | Fixed — added expected file/node/edge counts |
| 17 | claude×2 | resilience | high | Pipeline crash blocks all reviews | Fixed — exit 2 triggers graceful degradation |
| 18 | claude | resilience | high | Concurrent PR race on graph file | Fixed — PR-specific working directories |
| 19 | claude | completeness | high | /stark-graph skill undescribed | Fixed — added skill command table |
| 20 | claude, codex | scope | high | SVG renderer unjustified in MVP | Fixed — moved to Phase 2 |
| 21 | codex | security | high | Prompt injection from untrusted docstrings | Fixed — grammar constraint + escaping |

## Fixed (Round 2 — 5 issues)

| # | Agent(s) | Domain | Severity | Title | Outcome |
|---|----------|--------|----------|-------|---------|
| 22 | codex | api-design | high | --warn mode not in CLI | Fixed — added to CLI with behavior spec |
| 23 | claude | completeness | high | Concurrent working directory collisions | Fixed — .stark-graph/{slug}/ convention |
| 24 | claude | consistency | high | Stage numbering inconsistent | Fixed — corrected to 4 stages |
| 25 | claude | completeness | high | CI integration unspecified | Fixed — added CI section with GH Actions sketch |
| 26 | codex | completeness | high | Skipped files create coverage gaps | Fixed — coverage threshold with warning |

## Unresolved (Final Round)

| # | Agent(s) | Domain | Severity | Title | Status |
|---|----------|--------|----------|-------|--------|
| U1 | claude | general | high | BFS direction (forward vs reverse) not specified | Accept — will clarify in implementation plan |
| U2 | claude | completeness | high | --include flag referenced but not in CLI | Accept — implementation detail, not spec gap |
| U3 | codex | security | critical | CI runs untrusted branch code with write secret | Non-issue — `pull_request` trigger runs on base commit; write token only for bot comments |
| U4 | codex | data-modeling | critical | Event subscribers not first-class entities | Accept — acknowledged as approximation, Phase 2 |

## Noise & False Positives

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Phase 2 concern applied to MVP** | 38 | Design clearly scopes MVP vs Phase 2 — review prompts should weight scope section |
| **Extensibility over-engineering** | 22 | Prompts ask for extension points; MVP intentionally avoids premature abstraction |
| **Repeated finding from prior round** | 12 | Some agents re-flag addressed issues — round context not carried forward |
| **Design philosophy disagreement** | 5 | "Required docstrings = too heavy" contradicts the system's core value proposition |

## Changes Made

```
Round 1: +279 -124 lines (major restructure)
Round 2: +52 -3 lines (targeted fixes)
Total:   +331 -127 lines
```

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Codex consistently flags MVP scope as over-engineered despite explicit scoping | Global | `global/prompts/design-review/codex/04-scope.md` — add "respect the stated MVP boundary" |
| Both agents flag Phase 2 items as current issues | Global | All domain prompts — add "distinguish MVP from Phase 2 when scope section exists" |
| Codex extensibility domain produces ~6 findings per round regardless of design quality | Global | `global/prompts/design-review/codex/09-extensibility.md` — calibrate severity for MVP-stage designs |

No improvement opportunities detected for: accessibility, resilience, security, test-plan.

## Metrics

```
Total duration:     ~18m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   14m 4s
    Round 1 dispatch:     2m 10s
    Round 1 classify+fix: 3m 50s
    Round 2 dispatch:     4m 5s
    Round 2 classify+fix: 2m 0s
  Phase 3 (Final):        3m 8s
  Phase 4 (Summary):      30s
  Phase 5 (Output):       10s

Issues found:        26 (26 fixed, 4 unresolved)
Noise:               77
Signal-to-noise:     25%
Agents:              72 dispatched (24×3 rounds), 72 succeeded, 0 failed
Rounds:              2 fix + 1 final
```

### Improvement Flags
- Phase 2 dispatch (R2) was 4m5s — 23% of total. Normal for 24 agents.
- Noise ratio high at 75% — extensibility and scope prompts are the main contributors.
- No dispatch failures across all 72 sub-agent invocations.
