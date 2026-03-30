# Regression Prevention

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. For any renamed/removed exports, search the codebase for usages: `grep -r "import.*{OldName}" --include="*.ts" --include="*.tsx"`
3. For changed function signatures, find all callers
4. Read the changed files to understand behavioral changes

> **Scope:** Only report regression risk findings. Do not flag new bugs in new code (correctness handles that) or missing tests (test coverage handles that).

**Critical rules:**
- Think about callers, not just the changed code. A renamed export breaks every consumer.
- Do NOT flag additions. New files/functions/exports are not regressions.
- Do NOT flag test-only changes.
- Side-effect changes are subtle and dangerous — changed ordering, new mutations, sync→async.

Then review for regression risk:

**API Surface**
- Renamed or removed exports
- Changed function signatures (new required params, removed params, changed types)
- Changed return types or shapes
- Changed default values
- Changed error types or messages

**Behavioral Changes**
- Different behavior for same input
- Changed ordering of operations
- New or removed side effects
- Schema changes without migration

**Integration Points**
- Changed URL paths, query params, event names
- Changed CSS class names or selectors
- Changed CLI flags or argument parsing

**Severity:**
- critical: Removed public export, changed return type of widely-used function, schema change without migration
- high: Changed default value, changed error behavior, new required parameter
- medium: Changed operation ordering, changed event payload, renamed CSS class
- low: Changed internal-only behavior with narrow blast radius

**Output:**
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. Empty array `[]` if clean.
