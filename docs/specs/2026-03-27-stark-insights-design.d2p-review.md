# Design-to-Plan Cross-Review — stark-insights

**Date:** 2026-03-27
**Design:** `docs/specs/2026-03-27-stark-insights-design.md`

## Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         8.5       8.0      7.5     8.0    8.0     8.0 ★
  claude        7.0       6.5      7.0     6.5    7.5     6.9
  gemini        —         —        —       —      —       N/A (failed)
```

**Winner: codex (8.0/10)**

## Per-Plan Assessment

### Codex Plan (Winner)

**Strengths:**
- Phase 0 explicitly locks the three design contradictions (scheduler cadence, auth model, bearer token) as decision gates before coding starts
- Buffer-first ordering: storage → ingest → scrapers → query — no phase assumes infrastructure from a later phase
- Per-phase rollback is concrete and operationally actionable
- Integration Points section identifies the five cross-cutting contracts that break silently
- `stark_insights_summary` deferred to Phase 6 with explicit "no LLM-generated summaries" gate

**Weaknesses (addressed in synthesis):**
- Missing explicit Terraform provisioning task → added to Phase 1
- Observability deferred to Phase 5 → moved scaffolding to Phase 0
- Session reconciliation in Phase 3 is too early → moved to Phase 6
- API token tied to Docker packaging → moved to Phase 2 startup
- Missing partition maintenance job → added monthly job in Phase 3 scheduler
- Incomplete discard priority map → full 11-type priority defined in Phase 2

### Claude Plan (Runner-up)

**Strengths:**
- Richer per-task detail: exact file paths, function signatures, verification curl commands
- Phase 3 scraper tasks correctly advance high-water marks only after commit
- Shared-process architecture (FastAPI + MCP + scheduler) well-documented
- Testing strategy with testcontainers-python for real Postgres integration tests

**Weaknesses (addressed in synthesis):**
- Missing Terraform as discrete task — lumped into Phase 2
- Partition maintenance deferred to "note to add a monthly cron"
- MCP query fallback to SQLite undefined for Postgres-specific SQL
- Bearer token not threaded through verification examples
- `gh api /user` at startup makes startup brittle
- MVP boundary doesn't match design's definition (missing sentinel integration)

## Synthesis Decisions

| Section | Source | Rationale |
|---------|--------|-----------|
| Phase 0 (design lock) | Codex | Prevents the most common implementation drift |
| Observability placement | Codex weakness fix | Moved to Phase 0 so all phases instrument from start |
| Task detail and file paths | Claude | More implementation-ready |
| Terraform as discrete task | Claude weakness fix | Explicit provisioning step before schema migration |
| Integration contracts | Codex | Better-structured failure mode analysis |
| Testing strategy ordering | Codex | Correct: storage before API before scrapers |
| Session reconciliation timing | Gemini review of Codex | Deferred to Phase 6 per design's phasing |
| Docker hardening | Both | Combined verification approach |
| Rollback plan structure | Codex | Per-phase with concrete commands |
