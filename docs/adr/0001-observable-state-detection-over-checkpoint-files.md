# 0001: Observable state detection over checkpoint files

**Date:** 2026-03-20
**Status:** Accepted

## Context

The rename-project skill needs to handle partial failures gracefully — a rename that completes the GitHub API call but fails before renaming the local directory, for example. The standard approach would be to write a checkpoint file tracking which steps have completed, but this introduces state file lifecycle management complexity.

## Decision

Detect partially-completed renames by checking observable system state rather than maintaining checkpoint files. The skill checks the combination of remote URL contents and local directory name to determine where a previous run stopped:

- Remote has new-name, local dir is old-name: resume from local rename
- Remote has old-name, local dir is new-name: resume from GitHub rename
- Both have new-name: resume from symlink cleanup

Each step is idempotent, so re-running a completed step is safe.

## Alternatives Considered

- **Checkpoint/journal file** — Write a JSON file tracking completed steps. Rejected because SKILL.md is a prompt executed by Claude, not a standalone program, and managing state file lifecycle (creation, cleanup, corruption recovery) adds complexity disproportionate to the benefit for a rare, manually-invoked operation.

## Consequences

- **Positive:** No state files to manage, clean up, or worry about corrupting. Each step can verify its own completion independently.
- **Negative:** Detection relies on side effects being visible. If a step has side effects that aren't easily observable, the resume logic can't detect partial completion of that specific step.
