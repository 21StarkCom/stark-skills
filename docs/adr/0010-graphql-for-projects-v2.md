# ADR 0010: GraphQL for GitHub Projects V2

**Date:** 2026-03-22
**Status:** Accepted
**Context:** GitHub Projects V2 integration for workflow state management

## Decision

Use GitHub's GraphQL API exclusively for Projects V2 operations. Add `graphql()` to `github_app.py` following the existing module-level function pattern (no classes). Create `github_projects.py` as a utility module wrapping all GraphQL complexity.

## Rationale

- GitHub Projects V2 has no REST API — GraphQL is the only option
- Module-level functions match `github_app.py` conventions (module-global `_active_app`, `get_token()`, `_headers()`)
- Separating GraphQL queries into `github_projects.py` keeps `github_app.py` as pure auth/transport

## Consequences

- First GraphQL code in the codebase — new pattern for contributors to learn
- Field ID resolution requires an initial query per project (cached in `_field_cache`)
- Client-side filtering is required — GitHub Projects V2 GraphQL doesn't support server-side filtering by custom field values
