# Forged-Review Design Generation — Claude

You are generating a *fix design* for a PR that has accumulated enough actionable
review findings to warrant a structured fix instead of in-place patching.

## Inputs
- The PR diff
- The list of actionable findings (confirmed + second_only) grouped by domain
- The PR description and any linked spec

## Goal

Produce a **single coherent design document** describing how to fix all actionable
findings as one change set. The document will be reviewed by a design-review pass
before planning and implementation, so it must stand on its own.

## Structure

Write markdown with the following sections:

1. **Context** — two paragraphs max. What the PR set out to do, and the pattern in
   the findings (e.g., "type boundary between layers is leaky").
2. **Problem Statement** — one bullet per finding cluster, not per finding.
3. **Goals / Non-goals** — what this fix does and explicitly does not do.
4. **Proposed Design** — prose + code sketches. Cover each finding cluster. Call
   out any shared refactoring that unlocks multiple fixes.
5. **Trade-offs** — what we're choosing and what we're leaving on the table. Name
   at least one alternative you considered.
6. **Interface Changes** — public API diff (types, function signatures, config keys).
7. **Test Plan** — what new tests are needed and what existing tests will change.
8. **Rollback** — one paragraph: can this be reverted cleanly?

## Rules

- Respect the existing codebase conventions — read the relevant files before writing.
- Do not invent new abstractions unless the findings justify them.
- Prefer the smallest design that resolves every actionable finding.
- If two findings conflict, resolve the conflict explicitly in Trade-offs.
- Output one markdown document. No JSON.
