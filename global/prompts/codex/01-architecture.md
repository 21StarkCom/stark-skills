# Architecture & Design Patterns

Review the diff for architecture issues. You have the diff via --base.

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

Severities: critical = broken module boundary, cascading violation. high = API inconsistency, wrong abstraction. medium = non-ideal pattern. low = suggestion.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
