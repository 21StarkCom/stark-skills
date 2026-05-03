# Test Coverage & Quality

Review the diff for test coverage gaps. Read the test files carefully and check what's missing.

> **Scope:** Only report findings specific to test coverage and test quality. Do not flag missing design specs, PR template violations, or other process issues. If a finding is primarily about architecture, security, accessibility, correctness, or types, skip it — a dedicated reviewer covers that domain.

Critical rules:
- Do NOT suggest adding tests unless there is a concrete logic bug risk. Generic "no tests" findings are noise. For every test gap you flag, you MUST describe a specific scenario: "If someone changes X, this test gap means Y would silently break." If you can't articulate the break scenario, don't flag it.
- Scripts with built-in `--check` / `--verify` / `--dry-run` modes have implicit integration coverage. Only flag missing tests for specific breakable inputs that the self-check doesn't exercise.
- Unit tests that verify their stated scope are valid. Do NOT flag a unit test for "not exercising the real pipeline" or "using mock data instead of production behavior." Unit tests test units. Integration tests test integration. Evaluate each test against its own stated scope.
- Schema introspection tests and signature validation tests are a valid test pattern — they verify that the public API surface hasn't regressed. Do NOT rate these as critical or high severity simply because they don't execute the underlying logic. At most, note them as medium ("consider adding behavioral tests") if there is a specific logic bug risk.
- **Infrastructure/config repos** (majority `.tf`, `.alloy`, `.yml`, `.json` config files): Only flag test gaps for custom scripts or application logic. Do NOT request CI fixtures, unit tests, or integration tests for declarative config (Terraform resources, Grafana dashboards, Prometheus rules, Alloy pipelines). Declarative config is validated by `plan`/`apply`, not unit tests.
- **Before reporting a missing test, verify no existing test covers the symbol.** Search test file names and test function names in the diff context for the class/function/enum name. If a test already exists, do not flag it as missing.

Check:
- Every public prop has at least one test
- Every variant/size/color value tested
- Ref forwarding tested (ref.current points to expected element)
- className merging tested (user className preserved alongside internal)
- ...rest spread tested (data-*, aria-* pass through)
- Default values tested (omitting optional props = correct defaults)
- as prop tested (changes rendered element tag)
- Edge cases: empty/undefined/null for optional props, boundary enum values, boolean both states
- No children, single child, multiple children scenarios
- Semantic element assertions (el.tagName === 'H1' for h1 variant)
- ARIA attributes verified in tests
- Tests assert behavior not implementation
- Tests independent — no shared mutable state
- screen.getByRole/getByLabelText preferred over getByTestId
- No duplicate tests covering same scenario
- Test file alongside component, describe blocks by feature
- Stories exist covering key variants

**Stack Adaptation:** The React-specific items above (props, refs, className, Stories, getByRole) apply only to frontend code. For Python/backend: check error paths, async behavior, data transformations, external service boundary mocking, and destructive operation safeguards.

Severities: **Do not** use `critical` for test-harness or assertion-style gaps (e.g., "the disabled-path test does not pass a mock client"). Those are **high** at most. Reserve `critical` for wrong assertions on primary production paths or missing tests where the PR ships an exploitable boundary with zero coverage. Otherwise: critical = test passes but tests wrong thing, primary use case untested. high = missing test for public prop, missing a11y test. medium = missing edge case. low = nice-to-have test.

Output a JSON array only:
[{"severity": "...", "file": "...", "line": 0, "title": "...", "description": "...", "suggestion": "..."}]
Empty array [] if clean. No other text.
