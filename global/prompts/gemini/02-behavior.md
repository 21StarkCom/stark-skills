# Behavior — Correctness & Regression

First, run these commands:
1. `git diff <base>...HEAD` to see what changed
2. Read each changed file in full
3. For renamed/removed exports, search the codebase: `grep -r "import.*{OldName}" --include="*.ts" --include="*.tsx"`
4. For changed function signatures, find all callers
5. Read related files to understand how changed code is consumed

> **Scope:** Only report findings about runtime behavior. Skip architecture, security, types, test coverage, or spec conformance — dedicated reviewers cover those.

**Critical rules:**
- **Prefer fail-fast over silent fallbacks, retries, or compatibility shims.** Self-use tooling, single environment, full control: a clear error today beats a silently-wrong result tomorrow. Flag added try/except-and-continue, default fallbacks that mask config errors, and v1/v2 shims kept for hypothetical migrations.
- **For pure additions (new files only, no edits to existing code), skip the regression checklist** — additions cannot regress existing behavior.
- **When changing existing code, think about callers.** A renamed export breaks every consumer.
- **Do NOT flag test-only changes** as regressions.

Then review for behavioral defects:

## New-code bugs

**Runtime Errors**
- Null/undefined access without guards
- Wrong default values (color="primary" breaking CSS inheritance)
- Functions called with wrong arguments
- Unhandled promise rejections

**Logic**
- Incorrect conditionals — wrong operator, inverted, missing case
- Sort direction vs access pattern mismatch (e.g., sort ascending + pop from end = wrong priority)
- Unreachable code paths
- State mutations where immutability expected

**CSS & Styling**
- CSS inheritance broken — component styles preventing parent propagation
- CSS specificity conflicts
- font shorthand overriding individual properties
- Token hacks — overriding composite tokens with individual properties instead of defining proper tokens

**HTML & DOM**
- Wrong element mappings (heading variant not rendering as heading)
- Invalid nesting (p inside p, div inside span)
- Missing key props in lists
- Props spread in wrong order (user props overwritten by internal)

**Component Behavior**
- Props accepted but producing no effect
- Ref not forwarded to expected element
- className not merged — user className lost
- ...rest applied to wrong element

**Framework Generator Protocols**
- For Strawberry SchemaExtension hooks, verify that yield-based generators receive the expected value — `contextlib.contextmanager` sends `None` on `yield`, not the execution result. Code that does `result = yield` inside a `@contextmanager` always gets `None`.
- For any framework that uses generator-based middleware (ASGI, Starlette, Strawberry), confirm the yield/send contract matches the framework's actual behavior.

**Concurrency & Async (Backend)**
- TOCTOU races — read-then-write without transactions (e.g., check existence then delete)
- Non-atomic check-and-act on shared state (databases, distributed locks)
- Lock release without transactional ownership verification
- asyncio.gather results misaligned with input indices when items are skipped

**Cross-Module Contracts (Backend)**
- Callers using wrong field names on dataclasses/models (e.g., obj.id when field is source_id)
- Constructor called with wrong keyword arguments
- Function signature changed but callers not updated
- Database enum columns guarantee value validity at the storage layer — do not flag Python enum construction from DB enum values as unsafe coercion

## Existing-code regressions

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
- critical: Runtime crash, visually broken, removed public export, changed return type of widely-used function, schema change without migration
- high: Subtle bug, CSS inheritance broken, changed default, changed error behavior, new required parameter
- medium: Edge case not handled, changed operation ordering, changed event payload, renamed CSS class
- low: Defensive improvement, changed internal-only behavior with narrow blast radius

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
