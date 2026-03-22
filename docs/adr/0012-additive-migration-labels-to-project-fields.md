# ADR 0012: Additive Migration from Labels to Project Fields

**Date:** 2026-03-22
**Status:** Accepted
**Context:** Transitioning workflow tracking from GitHub labels to Projects V2 custom fields

## Decision

Migration is additive through Phase 2 — project fields are written IN ADDITION to labels, not instead of. Label removal happens only after the project-based workflow is validated and stable. Skills that write `sp:*`, `risk:*`, `confidence:*` labels continue to do so alongside setting project fields.

## Rationale

- Labels are the existing fallback for skills and queries that haven't been updated yet
- Rollback path: if project integration fails, revert skills to label-only mode with no data loss
- Cross-project queries can still use labels as a fallback (e.g., `plan:{slug}` label works across repos)

## Consequences

- Temporary duplication: same data in labels and project fields during migration
- Label cleanup is a separate, explicit task after validation
- Skills must handle both modes: project-field-first with label fallback
