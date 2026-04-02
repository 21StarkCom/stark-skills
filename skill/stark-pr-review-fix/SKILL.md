---
name: stark-pr-review-fix
description: >
  Full PR lifecycle: create PR, run multi-agent adversarial review, fix all findings,
  re-review until clean, merge. Chains stark-pr-flow and stark-review into a single
  autonomous pipeline. Use when the user says "PR review fix cycle", "full PR pipeline",
  or invokes /stark-pr-review-fix.
argument-hint: "[PR title override] [--rounds N] [--no-merge]"
---

# stark-pr-review-fix

Autonomous PR lifecycle: push → create PR → multi-agent review → fix all findings → re-review → merge.

Chains `/stark-pr-flow` (Steps 1-3) and `/stark-review` into a single pipeline with a fix loop.

## Arguments

- First positional argument — PR title override (passed to stark-pr-flow)
- `--rounds N` — max fix-review cycles (default: 3, passed to stark-review)
- `--no-merge` — stop after reviews are clean, don't merge
- `--draft` — create PR as draft

## Phase 1: Create PR

Execute `/stark-pr-flow` Steps 1–3 only (push, analyze, create PR). Do NOT proceed to self-review or merge — stark-review handles that better.

Capture `$PR_NUM` and `$REPO` from the output.

## Phase 2: Multi-Agent Review + Fix Loop

Execute `/stark-review $PR_NUM --rounds $ROUNDS`.

This runs 3 LLMs × 9 domains in parallel, collects findings, fixes critical/high issues, and re-reviews until clean or max rounds reached.

## Phase 3: Final Validation

After the review loop completes:

1. Run the full test suite for this project:
   - Python: `pytest` (or project-specific test command from CLAUDE.md)
   - TypeScript: `npm test` or `npx jest`
   - Check CLAUDE.md `## Commands` for the right invocation

2. If tests fail, fix them and push.

3. If tests pass, proceed.

## Phase 4: Merge (unless --no-merge)

If `--no-merge` was passed, stop here and present summary.

Otherwise, execute `/stark-pr-flow` Step 5 (present summary) and Step 6 (merge).

**STOP and wait for user approval before merging** — same as stark-pr-flow.

## Summary Output

```
PR Lifecycle Complete
─────────────────────
PR:           #PR_NUM — [title]
Repo:         $REPO
URL:          [PR URL]

Review Rounds: N
Findings:      X total → Y fixed → Z remaining (low/info only)
Tests:         [pass count] passing

Status:       Ready to merge / Merged / Waiting for approval
```

## Failure Modes

| Failure | Recovery |
|---------|----------|
| PR creation fails | Fall back to stark-pr-flow error handling |
| Review agents fail | Log which agents failed, continue with available results |
| Fix introduces new failures | Count against round limit, continue fixing |
| Tests fail after all rounds | Present status, ask user how to proceed |
| Max rounds reached with remaining issues | Present remaining findings, ask user |
