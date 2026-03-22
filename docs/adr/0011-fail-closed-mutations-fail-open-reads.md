# ADR 0011: Fail-Closed Mutations, Fail-Open Reads

**Date:** 2026-03-22
**Status:** Accepted
**Context:** Error handling strategy for GitHub Projects V2 operations

## Decision

Mutations (status transitions, field updates) fail-closed: raise on error, halt the operation. Read-only queries (get_items, get_field) fail-open: retry once, then log warning and continue with cached/default values.

## Rationale

- A failed mutation means the state machine is inconsistent — the project board shows one state while the actual work is in another. This is worse than stopping.
- A failed read is recoverable — the caller can proceed with defaults or cached data, and the next run will re-read.
- This matches the spec's position that the project board is the source of truth for workflow state.

## Consequences

- Skills must handle RuntimeError from mutation calls
- Partial multi-field updates are possible (e.g., Status set but Phase not) — reconciliation job detects these
- Read failures produce warnings in logs, not errors
