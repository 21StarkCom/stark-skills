# Design-to-Plan Cross-Review Summary

**Design:** `docs/specs/2026-04-07-stark-graph-design.md`
**Date:** 2026-04-07
**Agents:** claude, codex (gemini disabled)

## Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         7.0       8.0      8.0     7.0    7.0     7.4 ★
  claude        5.0       4.0      6.0     5.0    6.0     5.2
```

**Winner:** codex (7.4/10)

## Per-Plan Analysis

### codex (winner)

**Strengths:**
- Grounded in actual codebase: named real files (`triage_orchestrator.py`, `multi_review.py`, `_run_subagent_inner`)
- Design gaps surfaced and resolved upfront (script location, test layout, per-file timeout, config key)
- Bootstrap phasing correctly sequences audit → warn → strict
- Concrete rollback plan per phase (specific file changes, not vague "revert")
- Worktree cleanup in `finally` path explicitly called out

**Weaknesses (addressed in synthesis):**
- Prompt injection safety mitigations not assigned as tasks → added to Phase 2 and Phase 5
- Test files referenced in verification but not in task lists → added test creation tasks
- Coverage threshold should warn (not fail) per design → aligned
- Docstring convention docs missing → added to Phase 6
- Commenter tests need mock path for local dev → added mock GitHub API tests

### claude

**Strengths:**
- Pydantic-first architecture (all stage outputs validated against models)
- Detailed task specificity (5 tasks per phase with exact acceptance criteria)
- Strong test fixtures planned programmatically (not dependent on real repos)
- Parallel bootstrap workflow alongside code phases

**Weaknesses (not carried into synthesis):**
- Parser only extracts `Depends:` edges, not `Publishes:` and `Called by:` node fields
- `NO_DOCSTRING` check defined incorrectly (no depends edge vs no docstring)
- Audit mode conflated with warn mode (should be separate)
- Assumed `github_app.py` works unchanged in CI (Keychain not available on ubuntu-latest)
- Config comments in strict JSON file
- Skill frontmatter requirements not addressed

## Synthesis Decisions

| Section | Source | Reason |
|---------|--------|--------|
| Phase structure (7 phases) | codex | Better sequencing of bootstrap/rollout |
| Task specificity + acceptance criteria | claude | More precise definition of done |
| Design gaps section | codex | Grounded in actual repo structure |
| Validator qualified-name resolution | codex | Addresses ambiguity reporting |
| BFS direction (reverse) | claude | Correctly computes callers, not callees |
| Test strategy (mock GitHub) | claude | Enables local testing without credentials |
| Prompt injection tasks | synthesis | Neither plan had explicit tasks; added per review feedback |
| Docstring convention docs | synthesis | Both plans omitted; added to Phase 6 |
