# stark-agents Design-to-Plan Cross-Review

## Scorecard

| Author | Complete | Feasible | Phasing | Risk | Testable | Avg |
|--------|----------|----------|---------|------|----------|-----|
| **codex** | 8.5 | 8.0 | 8.0 | 8.0 | 8.5 | **8.2** |
| claude | 7.5 | 6.5 | 6.5 | 6.5 | 7.5 | 6.9 |
| gemini | 6.0 | 5.5 | 6.0 | 6.0 | 6.0 | 5.9 |

**Winner:** codex (8.2/10)

## Synthesis Decisions

| Section | Source | Reason |
|---------|--------|--------|
| 9-phase structure, infra-first ordering | codex | Strongest on GCP realism and verification commands |
| Upfront design resolution (embedding model, Drive scope) | gemini | Front-loads decisions that otherwise block later phases |
| Atomic acceptance criteria per task | claude | More testable phase gates |
| Knowledge sync before DevOps rollout | claude + codex reviewers | Both flagged that shipping DevOps before RAG validation skips the full pipeline |
| Split Phase 5 into 6 tasks | claude reviewers | Monolithic "build everything" task is untestable |
| Cost agent as post-dispatch middleware in Phase 5 | codex reviewers | Needs to be in the LLM dispatch layer, not a separate agent rollout |
| Alembic-only schema management | codex reviewers | Dual ownership (manual SQL + Alembic) breaks on first deploy |
| Real-provider integration tests | claude reviewers | Mock-only tests create the mock/prod divergence the design warns about |

## Per-Plan Strengths

### codex (winner)
- Phase 1 forces design gap resolution before infrastructure
- Preserves additive-only constraint via fail-open in multi_review.py
- Integration points section names exact files and cascading failure modes
- Per-phase rollback is concrete (Terraform destroy, Firestore toggle, Cloud Run revision)

### claude (runner-up)
- Granular task breakdown with acceptance criteria
- Health endpoints implemented early (Phase 4)
- Explicit test scenarios mapped to design Section 7
- Observability instrumented from Phase 4

### gemini
- Aggressive parallelization of infrastructure + code
- All open questions resolved upfront
- Integration points table with auth mechanisms
- Phase 6 as the convergence/E2E gate

## Key Weaknesses Addressed in Synthesis

1. **Knowledge sync ordering** (claude + gemini): Both had DevOps rollout before knowledge sync. Moved sync to Phase 6, rollout to Phase 7.
2. **Monolithic Phase 5** (codex): Split context assembler, provider adapters, tool runner, ensemble scorer, and workspace into separate tasks.
3. **Cost agent timing** (all three): Was buried in final phase. Moved to Phase 5 as LLM dispatch middleware.
4. **Schema management** (codex): Manual SQL + Alembic conflict. Made Alembic the sole owner.
5. **Accessibility browser runner** (all three): Left as open question. Resolved in Phase 1 as Playwright + axe-core.
6. **Private repo cloning** (codex reviewer): Workspace only tested against public repos. Added GitHub App token auth for private repos.
