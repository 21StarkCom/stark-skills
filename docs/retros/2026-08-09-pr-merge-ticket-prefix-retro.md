# Retro — the squash subject that forgot its ticket (STARK-229)

**Date:** 2026-08-09 · **PR:** #859 · **Landed:** `30543ce`

## What broke

`/stark-gh:pr-merge` drafts the squash-commit subject from the **diff**, not from
the PR title. So a PR titled `feat(STARK-193): Human plane slice A — todo store
and CLI` landed on main as `feat: add ClickUp-backed personal todo store and
CLI`. The ticket trail — the whole point of the `type(STARK-<n>):` convention —
was dropped at the last step, on the one commit that survives.

Repairing it after the fact meant lifting main's force-push block and rewriting
history, which orphaned the merge commit the PR still pointed at.

## Why nothing caught it

The convention had exactly one machine enforcement: alfred's GitHub Actions CI,
deleted 2026-08-08. Nothing else looked at the squash subject. A convention with
no check is a habit, and habits do not survive an LLM writing the string.

## The fix

The drafter extracts the prefix from the PR title; `validateDraft` requires it.
A miss is retried once, then aborts at `DRAFT_INVALID` — never a prefix-less
commit on main.

## What the review changed, and the lesson in it

The first cut was ten lines and looked obviously right. An xhigh review found
nine defects, and the two that mattered are the same mistake wearing different
clothes: **a guard that fires on the wrong input is worse than no guard.**

- **The ticket key was `[A-Za-z][A-Za-z0-9]*-\d+`** — which matches `adr-0007`,
  `node-22`, `gpt-5`, `utf-8`. Ordinary conventional scopes. A repo with no
  ticket convention at all would have had merges hard-blocked by a rule written
  for a different repo. Now the key must *look* like a ticket key: upper-case
  project prefix, lower-case type, else no requirement at all.
- **The prefix rule and the 72-char cap shared a two-attempt budget.** The model
  fails attempt 1 on the missing prefix, prepends it on attempt 2, blows 72, and
  the merge dies — on a PR that merged fine the day before. Two constraints that
  can each consume the same retry are one constraint too many. The cap is now
  measured *after* the prefix, so both are satisfiable in a single attempt.

Two smaller ones came from `startsWith` being a string test where a **token**
test was meant: a legitimate `!` breaking marker was rejected, while a doubled
space and a doubled prefix (`feat(X-1): feat(X-1): thing`) both passed straight
through to `gh pr merge --subject`.

## Carry-forwards

- **A validator that can reject must be satisfiable in one attempt.** Count the
  retry budget against the number of independent ways to fail, and make the
  prompt carry the budget the validator actually applies.
- **Fail open on recognition, closed on violation.** Deciding *whether a rule
  applies* must be strict — an over-broad trigger converts a safety net into an
  outage. Deciding *whether the rule was met* can be strict all it likes.
- **The guard is still title-anchored.** Nothing requires a PR title to carry a
  ticket, so a `feat: …` title still merges prefix-less with a green check. That
  needs a title gate, deliberately left out of scope here.
- `/stark-gh:pr-merge` **refuses to merge its own PR** (exit 19, self-modifying
  guard). Changes under `plugins/stark-gh/` merge via plain `gh pr merge`, and
  the CHANGELOG entry gets written by hand — the drafter never runs.
