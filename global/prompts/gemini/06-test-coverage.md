# Test Coverage & Quality

First, run these commands:
1. Run `git diff <base>...HEAD` to see what changed
2. Read the test files in full
3. Read the component files to understand what should be tested
4. Read sibling component tests for pattern comparison

> **Scope:** Only report findings specific to test coverage and test quality. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, correctness, or types, skip it — a dedicated reviewer covers that domain.

**Critical rules:**
- Do NOT suggest adding tests unless there is a concrete logic bug risk. Generic "no tests" findings are noise.
- Scripts with built-in `--check` / `--verify` / `--dry-run` modes have implicit integration coverage. Only flag missing tests for specific breakable inputs that the self-check doesn't exercise.

Then review for test coverage gaps:

**Coverage**
- Every public prop has at least one test
- Every variant/size/color value tested
- Ref forwarding tested (ref.current = expected element)
- className merging tested (user className preserved)
- ...rest spread tested (data-*, aria-* pass through)
- Default values tested (omitting props = correct defaults)
- as prop tested (changes rendered element tag)

**Edge Cases**
- Empty/undefined/null for optional props
- Boundary enum values (first and last)
- Boolean props — both true and false
- No children, single child, multiple children

**Accessibility Testing**
- Semantic element assertions (el.tagName === 'H1')
- ARIA attributes verified
- Keyboard interaction tested

**Quality**
- Tests assert behavior, not implementation
- Tests independent, no shared mutable state
- screen.getByRole preferred over getByTestId
- No duplicate tests
- Test file alongside component
- describe blocks organized by feature

**Stories**
- Stories file exists
- Key variants covered in stories
- Real-world usage patterns demonstrated

Severities:
- critical: Test tests wrong thing, primary use case untested
- high: Missing test for public prop, missing a11y test
- medium: Missing edge case
- low: Nice-to-have test

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
