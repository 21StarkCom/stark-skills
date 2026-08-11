# stark-skills

A multi-agent AI engineering system: 30 skills that take you from a napkin idea
to production code, with review where it earns its keep.

## The Pipeline

Two stages, not six. The five-stage chain this page used to describe
(`/stark-review-spec` -> `/stark-spec-to-plan` -> `/stark-review-plan` ->
`/stark-plan-to-tasks` -> `/stark-phase-execute`) was demolished on 2026-07-26:
the 2026-07-25 autopsy measured its LLM-reviews-LLM loops burning tokens without
converging. What replaced it has no such loop anywhere.

> **Stale diagram:** `pipeline.png` below still draws the retired chain. The tool
> that generated it (`/stark-generate-docs`) no longer exists, so the image can
> only be redrawn or dropped — tracked separately. Trust this text, not the picture.

![Pipeline](pipeline.png)

**Stage 1 - `/stark-author`** turns an intent into one self-contained spec in a
single session: time-boxed recon, a structured interview, an EARS-shaped
behaviour contract, and a task DAG whose done-whens are machine-checkable. It
ends at a human gate — you sign the spec off, and the accepted commit is pinned
into it. At most one advisory review pass informs you; it never loops.

**Stage 2 - `/stark-build`** implements that spec autonomously, one fresh session
per task, gated by checks the agent cannot edit: a hook write-protects the spec
and the gated tests, and a stop-gate blocks turn-end while a task's check is red.
Aborting is a first-class outcome — measured to cut cheating from 54% to 9%. One
commit per green task, a draft PR, one cross-vendor advisory review, and exactly
one fix round over its medium+ findings. Anything still open dies at the human.

**`/stark-copilot`** is the alternative execution mode: a paired lead/wing loop
where the lead implements in a worktree and the wing reviews the diff, with one
fix round.

**`/stark-review`** is the PR code review, standalone or during execution — one
agent across triage-selected domains, posted under that agent's bot identity.

## The Ecosystem

![Ecosystem](ecosystem.png)

The pipeline handles the happy path from idea to code. The remaining skills handle everything around it.

**Adversarial review** — `/stark-red-team-spec` and `/stark-red-team-plan` put a design or execution plan through a committee of adversarial personas, surfacing challenges the domain reviews miss. Challenge-only — no fix loop.

**Workflow** — `/stark-session` manages work sessions (briefing on start, cleanup on end). `/stark-release` cuts versioned releases with changelog and tags. `/stark-persona` adds character voices to sessions — weighted selection, date-aware combos, and catchphrases. `/stark-gh-user` switches the active GitHub identity to dodge per-user API rate limits.

**Maintenance** — `/stark-housekeeping` audits stale issues, dead branches, and worktree remnants. `/stark-review-improvement` tunes review prompts based on false-positive analysis; `/stark-review-spec-improvement` does the same for design-review prompts.

**Documentation** — `/stark-init-docs` scaffolds a docs structure (ADRs, runbooks, MkDocs config).

## Detailed Docs

Every skill has two documentation pages: **usage** (how to invoke it, what it does, example output) and **internals** (architecture, data flow, how the pieces fit together). See the [full index](index.md) for links.
