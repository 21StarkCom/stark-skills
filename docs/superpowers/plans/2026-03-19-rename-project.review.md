# Plan Review — rename-project Implementation Plan

**File:** `docs/superpowers/plans/2026-03-19-rename-project.md`
**Rounds:** 1 fix round (findings converge with spec review themes)
**Coverage:** 19/21 sub-agents (3 LLMs × 7 domains)

## Round 1 Results

| Critical | High | Medium | Low | Total |
|----------|------|--------|-----|-------|
| 1 | 47 | 59 | 23 | 130 |

## Fixed

1. **REPO_ROOT not established** — Added `git rev-parse --show-toplevel` to anchor execution
2. **Resume table naming mismatch** — Changed "Step 4" → "Phase 3" etc.
3. **Case-only rename idempotency** — Compare name field AND repo ID (GitHub API is case-insensitive)
4. **Repo ID never fetched** — `CURRENT_REPO_ID` stored during validation for collision/idempotency
5. **sed treats `.` as regex** — Switched to Perl `\Q...\E` for literal matching
6. **Fallback symlink cleanup too narrow** — Now scans `~/Code/.code-review` too
7. **Symlink path match too broad** — Exact path or child (`OLD_ABS/` prefix), not substring
8. **Unquoted file lists** — Arrays with `git add -- "${files[@]}"`
9. **Skill path exclusions** — `~/.claude/skills/stark-review/` and install.sh labels excluded from replacement

## Unresolved — Intentional Design Choices

| Finding | Rationale |
|---------|-----------|
| No rollback runbook | Rare operation; git revert + GitHub API rename-back is the recovery path |
| No state manifest/checkpoint file | SKILL.md is a prompt, not a program; resume logic based on observable state is sufficient |
| Sibling commits before verification | User explicitly requested auto-commit; verification happens after |
| GitHub Enterprise not supported | Only github.com is used |
| superpowers skills "not available" | They're a Claude Code plugin, loaded at runtime |
| Single-prompt execution model | This is how all skills in this repo work — by design |
| No machine-readable output contract | Skills output to terminal for human/agent consumption |

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Codex fixates on rollback/checkpoint even for simple tools | Global | `global/prompts/plan-review/codex/05-operability.md` |
| Codex:feasibility flags "superpowers not available" (plugin) | Global | `global/prompts/plan-review/codex/02-feasibility.md` |
| All agents flag sibling auto-commit as risky (user requested it) | N/A | User preference — not a prompt issue |
