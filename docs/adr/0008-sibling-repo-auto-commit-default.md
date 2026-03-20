# 0008: Sibling repo auto-commit is default behavior

**Date:** 2026-03-20
**Status:** Accepted

## Context

During multi-agent review, all 3 LLMs flagged auto-committing changes to sibling repositories as risky, arguing the feature should be opt-in with a flag like `--update-siblings`. The concern was that automatically modifying and committing to other repositories could cause unintended side effects.

## Decision

Auto-commit to sibling repos is the default behavior, not opt-in. The user explicitly requested automatic cross-repo updates as part of the skill's core purpose. Safety is ensured by: (1) only modifying repos under the same parent with matching org/host, (2) requiring clean worktrees before modification, (3) committing only specific changed files (not `git commit -am`), and (4) reporting all changes in the summary.

## Alternatives Considered

- **Opt-in flag (--update-siblings)** — Advocated by all review agents. Rejected because it defeats the skill's value proposition of propagating renames across the entire local development environment in a single operation. The user would need to remember to pass the flag every time.

## Consequences

- **Positive:** One-command rename propagation across all related repos. No forgotten siblings with stale references.
- **Negative:** Users who don't want sibling updates must use `--dry-run` to preview, or manually revert commits. Acceptable because the skill is designed for exactly this use case.
