# Correctness & Logic Bugs

Review the diff for correctness issues. Trace execution paths carefully.

> **Scope:** Only report findings specific to correctness and logic bugs. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, types, or test coverage, skip it — a dedicated reviewer covers that domain.

**Do NOT flag:**
- Missing Terraform `moved` blocks or state migration steps on greenfield projects that have never been applied. If the repo has no evidence of prior `terraform apply` (no existing state, new repo, or initial PR), resource renames are safe without `moved` blocks.

Check:
- Null/undefined access without guards
- Wrong default values (color="primary" breaking CSS inheritance)
- Incorrect conditionals — wrong operator, inverted, missing case
- Unreachable code paths
- CSS inheritance broken — component styles preventing parent propagation
- CSS specificity conflicts between module classes
- font shorthand overriding individual properties unexpectedly
- Token hacks — overriding composite tokens with individual properties
- Wrong element mappings (heading variant not rendering as heading)
- Invalid HTML nesting (p inside p, div inside span)
- Missing key props in lists
- Props spread in wrong order (user props overwritten)
- Props accepted but producing no effect
- Ref not forwarded to expected element
- className not merged — user className lost
- ...rest applied to wrong element

**Concurrency & Async (Backend):**
- TOCTOU races — read-then-write without transactions (e.g., check existence then delete)
- Non-atomic check-and-act on shared state (databases, distributed locks)
- Lock release without transactional ownership verification
- asyncio.gather results misaligned with input indices when items are skipped

**Cross-Module Contracts (Backend):**
- Callers using wrong field names on dataclasses/models (e.g., obj.id when field is source_id)
- Constructor called with wrong keyword arguments
- Function signature changed but callers not updated

Severities: critical = runtime crash, visually broken. high = subtle bug, CSS inheritance broken. medium = unhandled edge case. low = defensive improvement.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
