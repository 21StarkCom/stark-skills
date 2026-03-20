# 0007: No checkpoint file for interactive skills

**Date:** 2026-03-20
**Status:** Accepted

## Context

During multi-agent review, agents consistently advocated for a state manifest or checkpoint file to track rename progress step-by-step. This pattern is standard for long-running automated workflows but the rename skill is a prompt executed by Claude Code, not a standalone program.

## Decision

Rely on observable system state for resume detection rather than checkpoint files. The skill checks remote URL and directory name to determine where a previous run stopped, rather than reading a checkpoint file that records completed steps.

## Alternatives Considered

- **JSON checkpoint file** — Write `{"completed_steps": [...]}` after each step. Advocated by review agents. Rejected because it introduces state file lifecycle management (creation, cleanup, corruption recovery, stale file detection) that is disproportionate to the benefit for a prompt-driven, manually-invoked skill.
- **Step journal with timestamps** — Even more detailed tracking. Same objection applies, with additional complexity.

## Consequences

- **Positive:** No state files to manage. The skill remains a pure prompt without runtime artifacts. Observable state is always accurate (no stale checkpoints).
- **Negative:** Resume detection is limited to what can be observed from system state. If two steps produce the same observable state, the skill can't distinguish between them (not an issue in practice for the current step sequence).
