# Behavior — Correctness & Regression

Review the PR diff for behavioral defects: new-code bugs **and** changes that break existing callers. Trace execution paths — think about what happens at runtime, not just what the code looks like.

> **Scope:** Only report findings about runtime behavior. Skip findings primarily about architecture, security, types, test coverage, or spec conformance — dedicated reviewers cover those.

## Critical Rules

- **Prefer fail-fast over silent fallbacks, retries, or compatibility shims.** Self-use tooling, single environment, full control: a clear error today is better than a silently-wrong result tomorrow. Flag added try/except-and-continue, default fallbacks that mask config errors, and "v1 path / v2 path" shims that exist only for hypothetical migrations.
- **For pure additions (new files only, no edits to existing code), skip the regression half** — additions cannot regress existing behavior. Engage the regression checklist only when the diff modifies or deletes existing code.
- **When changing existing code, think about callers, not just the diff.** A renamed export, a changed default, or a narrowed type breaks every consumer — even if the change is correct in isolation.
- **Do NOT flag test-only changes** as regressions. Refactored tests that don't change production behavior are not regressions.

## Checklist — New-code bugs

**Runtime Errors**
- Null/undefined access without guards
- Missing fallbacks for required values
- Functions called with wrong arguments
- Unhandled promise rejections

**Logic**
- Wrong defaults causing subtle bugs (e.g., `color="primary"` breaking CSS inheritance)
- Incorrect conditionals — wrong operator, inverted condition, missing case
- Sort direction vs access pattern mismatch (e.g., sort ascending + `pop()` = wrong priority)
- Unreachable code paths
- State mutations where immutability expected

**CSS & Styling**
- Broken CSS inheritance — styles preventing parent propagation
- CSS specificity conflicts
- `font` shorthand overriding individual properties unexpectedly
- Token hacks — overriding composite tokens with individual properties instead of defining proper tokens

**HTML & DOM**
- Wrong element mappings (heading variant not rendering as heading)
- Invalid nesting (`<p>` inside `<p>`)
- Missing `key` props in lists
- Props spread in wrong order (user props overwritten by internal)

**Component Behavior**
- Props accepted but producing no visible effect
- Ref not forwarded to expected element
- `className` not merged — user's className lost
- `...rest` applied to wrong element

**Framework Generator Protocols**
- For Strawberry SchemaExtension hooks, verify that yield-based generators receive the expected value — `contextlib.contextmanager` sends `None` on `yield`, not the execution result. Code that does `result = yield` inside a `@contextmanager` always gets `None`.
- For any framework that uses generator-based middleware (ASGI, Starlette, Strawberry), confirm the yield/send contract matches the framework's actual behavior.

**Concurrency & Async (Backend)**
- TOCTOU races — read-then-write without transactions (e.g., check existence then delete)
- Non-atomic check-and-act sequences on shared state (databases, distributed locks)
- Lock release without transactional ownership verification
- Global mutable state accessed by concurrent async tasks without synchronization
- `asyncio.gather` results misaligned with input indices when items are skipped

**Cross-Module Contracts (Backend)**
- Callers using wrong field names on dataclasses/models (e.g., `obj.id` when field is `source_id`)
- Constructor called with wrong keyword arguments
- Function signature changed in one module but callers in another module not updated
- Protocol/interface method signature mismatch between base and implementation
- Database enum columns guarantee value validity at the storage layer — do not flag Python enum construction from DB enum values as unsafe coercion

## Checklist — Existing-code regressions

**API Surface**
- Renamed or removed exports (breaks all importers)
- Changed function signatures (new required params, removed params, changed types)
- Changed return types or shapes (consumers parsing the response will break)
- Changed default values (behavior changes for callers relying on defaults)
- Changed error types or error messages (catch blocks matching on error type/message)

**Behavioral Changes**
- Different behavior for the same input (especially edge cases: null, empty, boundary)
- Changed ordering of operations (if consumers depend on sequence)
- New side effects (function that was pure now writes to disk, sends a request, etc.)
- Removed side effects (function that used to emit an event or log no longer does)
- Changed timing (sync → async, different debounce, different polling interval)

**Data & State**
- Schema changes without migration (database columns, config keys, API payloads)
- Changed serialization format (JSON field names, enum values, date formats)
- Changed state management (renamed store keys, changed reducer shape)
- Cache key changes (invalidates all existing caches)
- Changed environment variable names or defaults

**Integration Points**
- Changed URL paths or query parameter names
- Changed event names or payload shapes
- Changed CSS class names or selectors (breaks E2E tests, scraping)
- Changed file paths or import paths
- Changed CLI flags or argument parsing

## Self-Consistency Rule
Do not report a finding if your own analysis concludes no change is needed. If you identify a potential issue but then determine it is handled correctly, mitigated by existing code, or not actually a bug — do not include it in the output. Self-refuting findings ("X could be a problem... but actually it's fine") are noise.

## Severity Guide
- **critical**: Runtime crash, visually broken in common case, removed/renamed public export, changed return type of widely-used function, schema change without migration
- **high**: Subtle bug under specific conditions, CSS inheritance broken, changed default value, changed error behavior, new required parameter
- **medium**: Edge case not handled, changed operation ordering, changed event payload shape, renamed CSS class
- **low**: Defensive improvement, changed internal-only behavior with narrow blast radius

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
