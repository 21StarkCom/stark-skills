# Design-to-Plan Cross-Review — stark-automations

## Scorecard

| Agent | Completeness | Feasibility | Phasing | Risk | Testability | Avg |
|-------|-------------|-------------|---------|------|-------------|-----|
| **codex** | 8.0 | 7.0 | 7.0 | 7.0 | 8.0 | **7.4 ★** |
| claude | 6.0 | 5.0 | 5.0 | 5.0 | 6.0 | 5.4 |
| gemini | — | — | — | — | — | (empty response) |

**Winner:** codex (7.4/10)

Note: Gemini returned empty responses for both generation and cross-review. Scores are from 2 reviews only (claude→codex, codex→claude).

## Codex Plan — Strengths
- "Design Gaps To Resolve Before Coding" section catches prompt-source inconsistency and path mismatches before implementation
- Idempotency/lock management gets a dedicated phase with correct GCS precondition semantics
- Phased scheduler enablement (certify one trigger, then roll out one-at-a-time with 24h windows)
- 7 explicit integration point contracts between components
- Per-phase rollback procedures are concrete and scoped

## Codex Plan — Weaknesses (addressed in synthesis)
- Prompt forking deferred to Phase 7 (moved to Phase 2 as parallel track)
- CI/CD never explicitly tasked (moved to Phase 0)
- Container vs zip packaging deferred to Phase 5 (moved to Phase 0 ADR)
- Network isolation for shell and git URL restrictions missing (documented as v1 known limitation)
- Data exfiltration risk has no corresponding monitoring task (added to Phase 5)
- Retry timeout budget not formalized as a test (added to Phase 2 agent tests)

## Claude Plan — Strengths
- Clean 6-phase structure with clear incremental delivery
- Prompt forking in Phase 1 as parallel workstream (correct sequencing)
- Concrete day-by-day enablement order with risk rationale
- Emergency stop command provided
- Clear separation of prerequisites vs parallel-startable items

## Claude Plan — Weaknesses (addressed in synthesis)
- `prompt_ref` retained in RunRequest despite bundled prompts (removed)
- Monitoring after fleet activation (moved before activation)
- GitHub write idempotency not addressed (documented as residual risk)
- No explicit ADR or decision freeze phase
- Fewer integration points documented

## Synthesis Decisions

| Element | Source | Rationale |
|---------|--------|-----------|
| Phase structure (8 phases) | Codex base + Claude cleanup phase | More granular = better for task decomposition |
| Phase 0 decision freeze | Codex | Both reviewers flagged unresolved architecture choices |
| Prompt forking in Phase 2 (parallel) | Claude | Both reviewers flagged codex deferring this to Phase 7 |
| CI/CD in Phase 0 | Claude + reviewer feedback | Must exist before any code merges |
| Monitoring before activation | Reviewer feedback | Safety net must exist before schedulers enabled |
| Day-by-day enablement order | Claude | Concrete, risk-ordered, with rationale |
| Integration points table | Codex | Rare in plans, high value for drift detection |
| Per-phase rollback | Codex | Concrete and scoped to each phase |
| Remove prompt_ref from v1 | Reviewer feedback | Contradicts bundled-prompt design |
| Emergency stop script | Claude | Practical operational need |
