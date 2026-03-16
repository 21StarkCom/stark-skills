# Correctness & Logic Bugs

Review the PR diff for correctness issues. Trace execution paths — think about what happens at runtime, not just what the code looks like.

## Checklist

**Runtime Errors**
- Null/undefined access without guards
- Missing fallbacks for optional values
- Functions called with wrong arguments
- Unhandled promise rejections

**Logic**
- Wrong defaults causing subtle bugs (e.g., `color="primary"` breaking CSS inheritance)
- Incorrect conditionals — wrong operator, inverted condition, missing case
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

## Severity Guide
- **critical**: Runtime crash, visually broken in common case
- **high**: Subtle bug under specific conditions, CSS inheritance broken
- **medium**: Edge case not handled
- **low**: Defensive improvement

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
