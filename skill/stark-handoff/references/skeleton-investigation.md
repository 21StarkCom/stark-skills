# Investigation skeleton — `fix`

The executor is a session in (usually) another repo, chasing one bounded bug.
Start from [spine.md](spine.md), then fill these sections in order.

## 1. Locator block

Everything needed to be looking at the right code within a minute:

- Repo (normalized `org/name` or absolute path), branch.
- Failing test: `path/to/test_file:line`, test name.
- Implementation under suspicion: `path/to/impl:line`.
- The command that reproduces (or attempts to).

## 2. What happened

Evidence only: run ids, exit codes, and the **verbatim failure text** — quoted,
not summarized.

## 3. Established vs NOT established

- **Established:** the proven part of the mechanism, each claim **source-quoted**
  (file + line + the quoted span).
- **NOT established:** what stays unproven, including the honest **non-repro
  attempts** — tabulate them: attempt · setup · result. A failed repro is data.

## 4. The decisive experiment — FIRST

The one experiment that discriminates between "the model is right" and "the
model is wrong". Give the exact command and both branches:

- **If it fails as predicted** → mechanism confirmed, proceed to the fixes.
- **If it still passes** → **your model is wrong. STOP.** Report back with what
  you saw; do not start patching on a broken model.

This section comes before any fix discussion. Order is the point.

## 5. Candidate fixes

Each: what it changes, what it costs, what it risks. Then **one explicit
recommendation** and the **design point that drives it** — the principle, not
a preference.

## 6. Deliverables

Issue + PR (branch, draft, ticket) and the evidence requirements: RED→GREEN
proof with real output, run ids, no "it works".

## 7. Constraints

Binding rules for the target repo: what may not be touched, CI shape, lint
traps, and the anti-goals from the spine restated in this repo's terms.
