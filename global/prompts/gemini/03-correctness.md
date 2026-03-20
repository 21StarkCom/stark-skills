# Correctness & Logic Bugs

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Read each changed file in full
3. Read related files to understand how changed code is consumed

> **Scope:** Only report findings specific to correctness and logic bugs. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, types, or test coverage, skip it — a dedicated reviewer covers that domain.

Then review for correctness issues:

**Runtime Errors**
- Null/undefined access without guards
- Wrong default values (color="primary" breaking CSS inheritance)
- Functions called with wrong arguments
- Unhandled promise rejections

**Logic**
- Incorrect conditionals — wrong operator, inverted, missing case
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

Severities:
- critical: Runtime crash, visually broken in common case
- high: Subtle bug, CSS inheritance broken
- medium: Edge case not handled
- low: Defensive improvement

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
