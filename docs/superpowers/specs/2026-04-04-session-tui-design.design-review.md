# Design Review — Session TUI

**File:** `docs/superpowers/specs/2026-04-04-session-tui-design.md`
**Mode:** standard (2 agents × 12 domains)
**Rounds:** 2 fix + 1 final

---

## Summary

**Issues found:** 46 | **Noise:** 42 | **Ignored:** 19
**Signal-to-noise:** 52%

### Fixed (Round 1 — 28 issues)

| Domain | Finding | Severity |
|--------|---------|----------|
| security | Terminal injection via unsanitized external strings | high |
| api-design | All render inputs were untyped dicts | high |
| api-design | BannerData/DiffSummary parameter inconsistency | high |
| data-modeling | SessionState.name backward compatibility unspecified | high |
| completeness | Triage extraction migration verification missing | high |
| test-plan | SKILL.md integration untested | high |
| test-plan | No error/failure path tests | high |
| accessibility | PR status conveyed by symbol alone | high |
| consistency | Core API extraction list disagreed with implementation | medium |
| accessibility | TERM=dumb not in auto-detection | medium |
| completeness | started_at format ambiguity (ISO8601 vs HH:MM) | medium |
| completeness | Session name algorithm unspecified | medium |
| completeness | Banner overflow/truncation rules missing | medium |
| resilience | Data collection failures could abort briefing | medium |
| general | Integration mechanism SKILL.md→TUI unspecified | medium |
| consistency | "Rendering-only" claim contradicted by state change | medium |
| + 12 more medium findings | | |

### Fixed (Round 2 — 18 issues)

| Domain | Finding | Severity |
|--------|---------|----------|
| consistency | --plain mapped to wrong config flag (no_color) | critical |
| api-design | BannerData(total=False) can't enforce required fields | high |
| accessibility | Board item status conveyed by symbol alone | high |
| completeness | Architecture diagram names plain_text() but API says strip_ansi() | high |
| completeness | test_session_state.py absent from file inventory | high |
| data-modeling | started_at timezone requirement unenforced | medium |
| general | Session name fallback when all priorities fail | medium |
| resilience | No subprocess timeout for data collection | high |
| completeness | json_mode behavior for session TUI unspecified | medium |
| + 9 more medium findings | | |

### Unresolved (Final Round — recurring themes, by-design)

| Theme | Count | Rationale |
|-------|-------|-----------|
| Session naming is scope creep | 3 | User explicitly requested naming — not scope creep |
| TypedDicts too rigid / no extensibility | 5 | Intentional for V1 — extend when second consumer exists |
| tui_core.py creates SPOF | 2 | Rendering code — acceptable blast radius |
| Session state concurrency/corruption | 3 | Single-user CLI tool — no concurrent sessions |
| LLM-interpreted flag detection non-deterministic | 4 | Inherent to SKILL.md architecture — works well in practice |
| Test matrix too large for feature size | 2 | Tests are proportionate to the extraction risk |
| No end-to-end acceptance tests | 3 | SKILL.md is LLM-interpreted, not script-testable |

### Noise & False Positives (42)

Majority were speculative hardening suggestions for a single-user CLI tool (concurrent session locking, schema versioning, session state file permissions), premature extensibility (plugin system for sections, version contracts for internal modules), and findings that re-raised user-approved design decisions (naming, shared core extraction).

---

## Metrics

```
Total duration:     ~25 min
Phases:
  Phase 1 (Setup):        5s
  Phase 2 (Review-Fix):   ~18 min
    Round 1 dispatch:     ~5 min
    Round 1 classify+fix: ~3 min
    Round 2 dispatch:     ~5 min
    Round 2 classify+fix: ~2 min
  Phase 3 (Final):        ~5 min
  Phase 4 (Summary):      30s
  Phase 5 (Output):       30s

Issues found:        46 (46 fixed, 0 unresolved actionable)
Noise:               42
Agents:              72 dispatched, 71 succeeded, 1 failed
Rounds:              2 fix + 1 final
```

No improvement opportunities detected.
