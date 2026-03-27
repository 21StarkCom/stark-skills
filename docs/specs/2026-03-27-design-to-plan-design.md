# Design: stark-design-to-plan

**Date:** 2026-03-27
**Status:** Approved

## Problem

The stark-skills pipeline has a gap between design review and plan execution:

```
/stark-review-design → ??? → /stark-review-plan → /stark-plan-to-tasks → /stark-phase-execute
```

There's no skill that takes a reviewed design document and produces a phased implementation plan.

## Solution

A new skill `/stark-design-to-plan` that uses all 3 agents (Claude, Codex, Gemini) in a generate-then-cross-review pattern:

- **Phase 1 — Generate:** 3 agents each independently produce an implementation plan from the design doc (3 parallel dispatches)
- **Phase 2 — Cross-review:** Each plan is reviewed by the other 2 agents (6 parallel dispatches). Claude's plan reviewed by Codex + Gemini, etc.
- **Phase 3 — Synthesize:** Claude Code (orchestrator) reads all 3 plans + 6 reviews, picks the best-scoring plan as base, merges superior elements from others.

Output: one implementation plan markdown file, ready for `/stark-review-plan`.

## Architecture

### Dispatch Layer (Python)

New `design_to_plan_dispatch.py` in `scripts/`, reusing patterns from `plan_review_dispatch.py`:
- `generate_plans(design_content, agents, timeout)` — dispatches 3 agents in parallel via ThreadPoolExecutor, each returns a markdown plan
- `cross_review_plans(design_content, plans, timeout)` — dispatches 6 agents in parallel, each reviews one plan they didn't write
- Reuses: Gemini auth fallback, Codex JSONL parsing, retry logic, structured error handling

### Prompts

New prompt directory `global/prompts/design-to-plan/{agent}/`:
- `generate.md` — instructions for generating an implementation plan from a design doc
- `cross-review.md` — instructions for reviewing another agent's plan against the original design

### SKILL.md Orchestration

The skill manages:
1. Input validation, PR detection, auth
2. Calling `design_to_plan_dispatch.py --mode generate` (Phase 1)
3. Calling `design_to_plan_dispatch.py --mode cross-review` (Phase 2)
4. Synthesis (Phase 3) — done by Claude Code itself
5. Output: write plan file, post to PR, save history

### Scoring

Cross-reviewers score each plan on 5 dimensions (1-10):
- **Completeness** — does the plan cover all design requirements?
- **Feasibility** — can each step actually be executed?
- **Phasing** — is the work correctly ordered and parallelized?
- **Risk coverage** — are risks identified with mitigations?
- **Testability** — does each phase have verification criteria?

Overall score = average of 5 dimensions. Synthesis uses the highest-scoring plan as base.

### Synthesis Strategy

1. Rank plans by average cross-review score
2. Use winner as base document
3. For each section where a non-winner scored higher on a specific dimension, merge that section's approach
4. Discard elements that both cross-reviewers flagged as problematic
5. Output: single coherent implementation plan

## Integration

- Input: design doc (output of brainstorming or `/stark-review-design`)
- Output: implementation plan (input to `/stark-review-plan`)
- History: `~/.claude/code-review/history/design-to-plan/{design-filename}/`
- Prompts: `~/.claude/code-review/prompts/design-to-plan/{agent}/`
