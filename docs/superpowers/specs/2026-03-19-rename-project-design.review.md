# Plan Review — rename-project Skill Design

**File:** `docs/superpowers/specs/2026-03-19-rename-project-design.md`
**Rounds:** 3 fix rounds + 1 partial final round
**Coverage:** 19-20/21 sub-agents per round (3 LLMs × 7 domains)

## Severity Trend

| Round | Critical | High | Medium | Low | Total |
|-------|----------|------|--------|-----|-------|
| 1 | 4 | 45 | 55 | 21 | 125 |
| 2 | 1 | 43 | 65 | 21 | 130 |
| 3 | 1 | 35 | 62 | 26 | 124 |

Critical dropped from 4→1, high from 45→35 across rounds.

## Fixed Across Rounds

### Round 1 → 2 (major rewrite)
- Input validation: regex for repo names, shell metachar rejection
- Resumable execution: Step 1 detects partial completion state
- Step reordering: uninstall symlinks (4.5) before self-update (5)
- Bare-name replacement: word-boundary regex, restricted to known file types
- Cross-repo scope: restricted to repos matching same org/host
- Post-rename verification step with residual reference scanning
- CI/CD workflow scanning (report, don't fix)
- Auto-commit sibling repo changes
- Concrete GitHub API invocation with error handling
- Dynamic stale symlink detection (readlink-based, not hardcoded)
- Case-only rename handling for macOS

### Round 2 → 3
- Custom lookarounds `(?<![A-Za-z0-9._-])` instead of `\b` for hyphenated names
- Exclude `.github/workflows/` from auto-replacement
- `git add <files>` instead of `git commit -am` for sibling repos
- Resume at Step 4.5 (not 5) when dir already renamed
- Sibling repos must be clean before modification
- install.sh existence checked as prereq in Step 1
- Fallback symlink cleanup uses resolved absolute paths
- `git grep -Il` for text-file detection

### Round 3 → final
- GH_TOKEN export fix (single-line for child process)
- Portable symlink resolution (python3 instead of readlink -f)
- Verification applies same exclusion rules as replacement
- Case-only renames skip local existence check

## Unresolved — Remaining Findings

These findings appeared consistently across rounds but were classified as noise, over-engineering, or intentional design choices:

### Intentional Design Choices (not bugs)

| Finding | Rationale |
|---------|-----------|
| No rollback runbook | Rare operation; git history + resume logic is sufficient |
| No step journal/checkpoint file | Over-engineering for a manually-invoked skill |
| No immutable repo ID comparison | GitHub name-based collision check is adequate |
| No audit trail artifact | Skill output + git commits provide audit trail |
| GitHub Enterprise not supported | Only github.com is used; can be extended later |
| Sibling update not opt-in | User explicitly requested auto-update of sibling repos |
| No exit-code contract | Skill is invoked interactively by Claude, not by automation |

### Acknowledged Limitations

| Finding | Status |
|---------|--------|
| install.sh --uninstall may not clean up correctly after directory rename | Mitigated by dynamic fallback; full fix requires install.sh changes |
| Bare-name heuristic replacement may still have edge cases | Restricted to known file types + custom lookarounds; residual scan catches misses |
| External integrations (webhooks, Slack, Jira) not updated | Documented as out of scope; reported in summary |
| Dry-run doesn't define which read-only operations hit live systems | Minor; validation/API checks are read-only by nature |

## Changes Made

Diff across all fix rounds: spec grew from 100 lines to 169 lines. Added input validation, resumable state, step reordering, precise replacement patterns, cross-repo scoping, verification, and numerous edge case handlers.

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Codex consistently times out (3/4 rounds had codex timeouts) | **Global** | Investigate Codex CLI timeout/retry config |
| Gemini:scope consistently returns parse_error (3/4 rounds) | **Global** | `global/prompts/plan-review/gemini/06-scope.md` |
| All agents fixate on rollback/journal mechanisms for simple specs | **Global** | Reduce operability prompts' emphasis on enterprise rollback patterns |
| Codex:security overfocuses on secrets management and audit trails | **Global** | `global/prompts/plan-review/codex/04-security.md` — calibrate for dev tooling context |
