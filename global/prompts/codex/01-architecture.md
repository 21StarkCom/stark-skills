# Architecture & Design Patterns

Review the diff for architecture issues. You have the diff via --base.

> **Scope:** Only report findings specific to architecture and design patterns. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about security, correctness, accessibility, types, or test coverage, skip it — a dedicated reviewer covers that domain.

Check:
- Props API consistent with sibling components (size, variant, disabled, as patterns)
- forwardRef correct, ref type matches rendered element
- Polymorphic `as` prop narrows types for element-specific attributes
- Barrel exports clean, no internals leaked
- No circular imports
- Components consume tokens/generated/, never tokens/src/
- CSS Modules — no global leaks, proper class composition
- No god components, proper separation of concerns
- Composition over inheritance, no premature abstractions

Read sibling components to compare patterns.

Do NOT flag: Zero-dependency scripts using regex on controlled input (deliberate trade-off). Editor/IDE configs committed to repo (DX convenience, not build contract — only flag if they affect CI). Single-consumer patterns that are appropriate for their scope (e.g., a utility used by one component doesn't need a generic abstraction).

In **fix PRs** (title starts with `fix:`): only flag architecture issues if the fix introduces a correctness or regression risk. Don't suggest refactoring or restructuring — the PR's goal is a targeted fix, not an architecture improvement.

Severities: critical = broken module boundary, cascading violation. high = API inconsistency, wrong abstraction. medium = non-ideal pattern. low = suggestion.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
