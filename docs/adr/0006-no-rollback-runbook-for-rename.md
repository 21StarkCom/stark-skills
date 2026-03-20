# 0006: No rollback runbook for rename operations

**Date:** 2026-03-20
**Status:** Accepted

## Context

During multi-agent review, all 3 LLMs across 4 rounds flagged the absence of a formal rollback mechanism for failed renames. Agents advocated for rollback runbooks, undo scripts, or automated reversal procedures.

## Decision

Intentionally omit a formal rollback runbook. Recovery from a failed rename relies on: (1) git history — all changes are committed and can be reverted, (2) GitHub API — the repo can be renamed back via the same PATCH endpoint, (3) resume logic — the skill detects partial completion and can continue from where it stopped. A dedicated rollback runbook would over-engineer a rare, manually-invoked operation.

## Alternatives Considered

- **Formal rollback script** — An automated undo that reverses each step. Advocated by all review agents. Rejected because it doubles the implementation surface for a low-frequency operation, and the individual recovery mechanisms (git revert, API rename-back, resume) are sufficient.
- **Pre-rename snapshot** — Save full state before starting. Rejected as unnecessary given git history provides this implicitly.

## Consequences

- **Positive:** Simpler implementation. No rollback code to maintain or test.
- **Negative:** Recovery from partial failures requires manual judgment about which recovery mechanism to use. Acceptable because the skill is always invoked interactively with Claude providing guidance.
