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
- Unit tests that verify their stated scope are valid. Do NOT flag a unit test for "not exercising the real pipeline" or "using mock data instead of production behavior." Unit tests test units. Evaluate each test against its own stated scope.
- **Before reporting a missing test, verify no existing test covers the symbol.** Search test file names and test function names in the diff context for the class/function/enum name. If a test already exists, do not flag it as missing.

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

**Stack Adaptation:** The React-specific items above (props, refs, className, Stories, getByRole) apply only to frontend code. For Python/backend: check error paths, async behavior, data transformations, external service boundary mocking, and destructive operation safeguards.

Severities:
- **Calibration:** Never `critical` for pure test-quality nits (mock not passed, harness does not prove a flag). Cap at **high**. Use `critical` only when the test story would approve a wrong primary behavior or when an exploitable boundary has no tests.
- critical: Test tests wrong thing, primary use case untested
- high: Missing test for public prop, missing a11y test
- medium: Missing edge case
- low: Nice-to-have test

IMPORTANT: Output ONLY a raw JSON array. Do NOT wrap it in markdown code fences. Do NOT add any text before or after the array.

[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]

If no issues found, output exactly: []
