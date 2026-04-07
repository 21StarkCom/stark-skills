# Regression Prevention

Review the diff for changes that could break existing behavior. What currently works in production that this PR might silently break?

> **Scope:** Only report regression risk findings. Do not flag new bugs in new code (correctness handles that) or missing tests (test coverage handles that).

Critical rules:
- Think about callers, not just the changed code. A renamed export breaks every consumer.
- Do NOT flag additions. New files/functions/exports are not regressions.
- Do NOT flag test-only changes.
- Side-effect changes are subtle and dangerous — changed ordering, new mutations, sync→async.
- Read the PR description for stated intent. If the PR explicitly says a feature/entrypoint/file is removed because it was broken or never worked, that is intentional cleanup, not a regression. Only flag removals as regressions when they break something that was actually functioning.

Check:
- Renamed or removed exports
- Changed function signatures (new required params, removed params, changed types)
- Changed return types or shapes
- Changed default values
- Changed error types or messages
- Different behavior for same input
- Changed ordering of operations
- New or removed side effects
- Schema changes without migration
- Changed serialization format (JSON fields, enum values, dates)
- Changed URL paths, query params, event names
- Changed CSS class names or selectors
- Changed CLI flags or argument parsing

Severity:
- critical: Removed public export, changed return type of widely-used function, schema change without migration
- high: Changed default value, changed error behavior, new required parameter
- medium: Changed operation ordering, changed event payload, renamed CSS class
- low: Changed internal-only behavior with narrow blast radius

Output:
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. Empty array `[]` if clean.
