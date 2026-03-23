# Test Coverage & Quality

Review the PR diff for test coverage gaps and test quality issues. Think about what a future developer would need these tests to catch.

> **Scope:** Only report findings specific to test coverage and test quality. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, correctness, or types, skip it — a dedicated reviewer covers that domain.

## Critical Rules

- **Do NOT suggest adding tests unless there is a concrete logic bug risk.** Generic "this code has no tests" findings are noise. Only flag test gaps where a specific, describable bug could slip through.
- **If you find code that will crash, raise, or produce wrong results at runtime, classify it as a correctness bug** — report the bug itself with a concrete description, not "this needs a test." The correctness reviewer handles bugs; you handle test quality.
- Frame findings as "this behavior is untested and could break in way X" — not "this file has no tests."
- **Scripts with built-in `--check` / `--verify` / `--dry-run` modes have implicit integration coverage.** Only flag missing tests for specific breakable inputs or logic branches that the self-check doesn't exercise.

## Checklist

**Coverage**
- Every public prop has at least one test
- Every variant/size/color value tested (not just default)
- Ref forwarding tested (`ref.current` points to expected element)
- `className` merging tested (user className preserved)
- `...rest` spread tested (data-*, aria-* pass through)
- Default values tested (omitting optional props produces correct defaults)
- `as` prop tested (changes rendered element)

**Edge Cases**
- Empty/undefined/null for optional props
- Boundary values (first and last enum values)
- Boolean props — both true and false
- No children, single child, multiple children
- Very long content, empty content

**Accessibility Testing**
- Semantic elements asserted (`expect(el.tagName).toBe('H1')`)
- ARIA attributes verified
- Keyboard interaction tested
- Screen reader text present

**Quality**
- Tests assert behavior, not implementation details
- Tests independent — no shared mutable state
- Descriptions clearly state expected behavior
- `screen.getByRole`/`getByLabelText` preferred over `getByTestId`
- No duplicate tests

**Structure**
- Test file alongside component
- `describe` blocks by feature/prop
- Async tests properly awaited
- Stories exist and cover key variants

## Severity Guide
- **critical**: Test passes but tests wrong thing, missing test for primary use case
- **high**: Missing test for public prop, missing a11y test for interactive element
- **medium**: Missing edge case, test could be more specific
- **low**: Additional test nice to have

## Output
```json
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
```
JSON array only. No other text. Empty array `[]` if clean.
