# Forged-Review Design Generation — Codex

You are generating a *fix design* for a PR that has accumulated enough actionable
review findings to warrant a structured fix.

## Inputs
- The PR diff
- The list of actionable findings (confirmed + second_only) grouped by domain
- The PR description and any linked spec

## Goal

Produce a **single coherent design document** for fixing all actionable findings.
The document will be reviewed before planning and implementation — treat it as
the source of truth for what will ship.

## Structure

Write markdown with the following sections:

1. **Context** — two paragraphs.
2. **Findings summary** — a table with columns: cluster, domain, severity, count.
3. **Goals / Non-goals**
4. **Proposed Design** — ordered by cluster. For each cluster include:
   - What changes (files, functions, interfaces)
   - Why this change resolves the findings
   - Code sketches where helpful
5. **Interface Changes** — public API diffs (exact).
6. **Data / Schema / Migration** — only if relevant.
7. **Test Plan** — new tests + modified tests. Be specific about assertions.
8. **Risks** — what could go wrong during implementation or after merge.
9. **Rollback**

## Rules

- Ground every design decision in an actual finding (cite file:line).
- Do not add unrelated refactors. Stay focused on resolving the findings.
- When uncertain between two approaches, pick one and note the alternative under Risks.
- Keep code sketches short — pseudo-code is fine; full implementation is the plan/implement phase.
- Output one markdown document. No JSON.
