# Domain: test-coverage

Flag CHANGED behavior that lacks the specific test that would catch its
specific regression.

## The span rule (this lens's evidence bar)

Name the exact untested changed branch or contract — the file:line of the
changed code and the input that would expose the gap. "Add more tests" without
a named branch is banned.

## Failure modes (flag ONLY these)

1. **New contract untested** — a new schema, response field, flag, or API shape
   has no assertion anywhere.
2. **Changed risky branch untested** — an error path, boundary, or fail-closed
   path this diff changed has no test.
3. **Test masks the behavior** — a test passes for a different reason than its
   name claims (asserts on the wrong actor, over-broad mock, tautology).
4. **Flaky by construction** — a new test depends on wall-clock/period
   boundaries, ordering, or shared state and will intermittently fail.
5. **Removed or weakened assertion** — coverage that existed no longer proves
   the property it used to.

## Out of scope

- Coverage-percentage complaints; tests for unchanged code.
- E2E/test-pyramid demands beyond the change's actual risk (preamble guard).

## Evidence

The preamble contract applies — for this lens the span is the changed code
lines whose behavior is untested, plus the exposing input.
