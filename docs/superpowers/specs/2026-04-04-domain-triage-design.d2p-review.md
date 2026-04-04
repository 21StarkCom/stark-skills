# Design-to-Plan Cross-Review — Domain Triage

**Design:** `docs/superpowers/specs/2026-04-04-domain-triage-design.md`
**Plan:** `docs/superpowers/specs/2026-04-04-domain-triage-plan.md`

---

## Cross-Review Scorecard

```
              Complete  Feasible  Phasing  Risk  Testable  Avg
  codex         7         7         7       7       8     7.2 ★
  claude        7         5         6       6       6     6.0
```

**Winner:** codex (7.2/10)

Note: Only 2 agents available (Gemini disabled in config). Each plan received 1 cross-review instead of the usual 2.

---

## Per-Plan Analysis

### Codex Plan (Winner — 7.2/10)

**Strengths:**
- Phase 0 correctly gates the feature on stark-insights schema deployment first
- Phase 1 adds engine + assets without touching existing callers — fully reversible at zero blast radius
- Test file placement (`scripts/test_*.py`) matches actual repo convention
- Domain manifest drift risk identified with concrete mitigation
- Phase 2 dry-run verification uses the actual design spec file as input
- Rollback plan is phase-specific and granular

**Weaknesses addressed in synthesis:**
- `install.sh` never updated in any task → N/A, install.sh already symlinks entire `global/prompts` tree
- Phase 1 verification import path incorrect → Fixed: use `sys.path.insert(0, 'scripts')` pattern
- Phase 2 missing `triage_would_skip` annotation for shadow mode → Added explicit step in orchestrator flow
- Phase 4 no defined output artifact → Added `docs/triage-shadow-validation.md` gate artifact
- Phase 2 sequential dependencies not explicit → Split into Task 2.1 (dispatch), 2.2 (config), 2.3 (orchestrator) with noted ordering

### Claude Plan (6.0/10)

**Strengths:**
- Extremely detailed implementation code (dataclasses, function signatures, step-by-step)
- Comprehensive test tables with setup/assert columns
- Correctly identified that `plan_review_dispatch.py` config loader doesn't know about triage
- Failure-path coverage is strong and design-aligned

**Weaknesses addressed in synthesis:**
- Phase 0 loads prompts from installed path only → Fixed: accept `prompts_root` parameter with installed-path default
- Summarization uses `@@` hunk headers for stats (incorrect) → Fixed: use `diff --git` boundaries + per-file content
- Heuristic rules in prompts contradict design non-goals → Removed: use description-driven classification only
- Argument pass-through incomplete → Fixed: explicit list of forwarded args in orchestrator
- Shadow mode `2>&1` would corrupt JSON → Fixed: stderr to separate file

---

## Synthesis Decisions

| Section | Source | Reason |
|---------|--------|--------|
| Phase structure | codex | Cleaner dependency chain, repo-aware |
| Type definitions | claude | More concrete, includes `prompts_root` parameter |
| Test matrix | claude | Detailed per-test setup/assert tables |
| Verification commands | codex | Correct import paths and venv usage |
| Rollback plan | codex | Per-phase granularity |
| Config handling | codex + claude | Codex identified config gap; claude specified merge ownership |
| install.sh handling | codex | Correctly noted existing symlink coverage |
| Insights emission | codex | Identified existing `emit_queue.py` — plan documents design divergence |
