# Forged-Review Design Generation — Gemini

You are generating a *fix design* for a PR that has accumulated enough actionable
review findings to warrant a structured fix.

## Inputs
- The PR diff
- The list of actionable findings (confirmed + second_only) grouped by domain
- The PR description and any linked spec
- Broader codebase context you can read freely

## Goal

Produce a **single coherent design document** describing how to fix all actionable
findings together. The document must be self-contained — downstream planner and
implementer read only this, not the raw findings.

## Structure

Write markdown with the following sections:

1. **Context** — the original intent of the PR and the shape of the findings.
2. **Root-cause analysis** — for each finding cluster, what underlying decision or
   missing abstraction produced the cluster? (This is your strength — use it.)
3. **Proposed Design**
4. **Ripple check** — which adjacent files/tests/call sites will be affected by
   the fix? (This is also your strength — use your broad context.)
5. **Interface Changes**
6. **Test Plan**
7. **Rollback**
8. **Open questions** — things to verify during implementation (at most 3).

## Rules

- Focus on the smallest change that addresses root causes, not symptoms.
- Explicitly name the ripple effects that could cause regressions.
- If a finding has multiple reasonable fixes, name them and pick one with a reason.
- Do not exceed 1500 words.
- Output one markdown document. No JSON.
