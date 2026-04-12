# Red-Team Fixture Source Spec

This is the source-spec input used for Week-0 calibration of stark-red-team.

## User intent

Add a "red team" agent to /stark-forge and /stark-forged-review: a super
talented group of architects with expertise in different domains, that
challenge every decision made by the main agents. The red team runs at
design and plan stages (design enabled in v1, plan scaffolded). Single
Codex o3 call with 5 personas producing synthesis + counter-proposals.
Iterative refinement feeds findings back to the design generator. Halt
on stable blocking findings or human-review requests or budget exceedance.

## Goals

- Thorough architectural review beyond what code-level reviewers catch
- Cross-persona synthesis surfacing decisions where concerns collide
- Human-escape-hatch via REQUEST_HUMAN_REVIEW
- Bounded cost via per-run budget circuit breaker

## Non-goals

- Code-level review (existing domains handle that)
- Multi-call per-persona committee (deferred; single-call synthesis first)
