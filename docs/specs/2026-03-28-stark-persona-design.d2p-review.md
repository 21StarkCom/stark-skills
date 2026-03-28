# Design-to-Plan Cross-Review — stark-persona

**Design:** `docs/specs/2026-03-28-stark-persona-design.md`
**Date:** 2026-03-28

## Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         8.5       9.5      8.0     8.5    9.0     8.7 ★
  claude        7.5       5.0      7.0     5.5    6.5     6.3
  gemini        6.0       6.0      7.0     5.0    5.5     5.9
```

**Winner:** codex (8.7/10)

## Per-Plan Analysis

### codex (winner)
**Strengths:** Python helper CLI keeps SKILL.md thin and testable. Correctly identified stark-emit limitations and dedupe_key mismatch. Phase ordering (local-first → analytics → session) is sound. Phase-granular rollback.
**Weaknesses:** Bundles too many features into Phase 3 Task 3. Defers roster to Phase 6. Missing pop-up survey.

### claude (runner-up)
**Strengths:** Front-loads full roster completion. Voice mechanism well-specified. Good separation of concerns per phase.
**Weaknesses:** Relies on SKILL-only logic for SQLite operations (fragile). Uses stark-emit which can't handle list/null payloads. Verification steps use probabilistic checks.

### gemini (third)
**Strengths:** Parallel roster creation as a separate track. Python helper decision. Critical path identification.
**Weaknesses:** Incomplete command coverage (many modes not addressed). Missing combo feedback rules. Missing pop-up survey. Rollback plan too destructive.

## Synthesis Decisions

| Element | Source | Reason |
|---------|--------|--------|
| Python helper CLI architecture | codex | Testable, deterministic, keeps SKILL.md thin |
| Phase ordering (local → analytics → session) | codex | Usable increment at each boundary |
| Roster expansion as parallel track | gemini + claude | Front-loads content creation, unblocks Phase 6 quality gate |
| Pop-up survey in Phase 3 | claude (review finding) | Missing from all plans, caught in cross-review |
| Direct JSON POST (not stark-emit) | codex | stark-emit can't handle persona_event payload shape |
| dedupe_key instead of event_id | codex | Matches actual stark-insights envelope behavior |
