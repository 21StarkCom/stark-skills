# stark-skills

A multi-agent AI engineering system. 17 skills that take you from a napkin idea to production code, with adversarial review at every stage.

## The Pipeline

The core of stark-skills is a 6-step pipeline where each skill's output feeds the next. You can enter at any point — if you already have a design, skip straight to step 1.

![Pipeline](pipeline.png)

Two patterns recur throughout. **Generate** skills (blue) dispatch 3 agents to independently produce a document, then have each agent cross-review the other two — 3 competing outputs, 6 adversarial reviews, one synthesized winner. **Review** skills (orange) dispatch N agents across M specialized domains in parallel, classify the findings, fix the document, and repeat until clean.

Designs are produced by `superpowers:brainstorming` (outside this repo). From there:

**Step 1 — `/stark-review-design`** puts that design through 12 domain specialists (general, completeness, security, scope, api-design, data-modeling, consistency, scalability, extensibility, resilience, accessibility, test-plan) running across 2-3 agents. It fixes issues autonomously for up to 3 rounds, then runs a final review-only pass.

**Step 2 — `/stark-design-to-plan`** converts the reviewed design into a phased implementation plan. 3-generate + 6-cross-review pattern, scoring on completeness, feasibility, phasing, risk coverage, and testability.

**Step 3 — `/stark-review-plan`** reviews the implementation plan through 10 adversarial domains (general, completeness, security, feasibility, operability, sequencing, rollback, risk, gates, timeline). It assumes the plan will fail and hunts for where it will break.

**Step 4 — `/stark-plan-to-tasks`** decomposes the reviewed plan into phased GitHub issues with story points, risk labels, and confidence scores. Three LLM passes ensure consistency.

**Step 5 — `/stark-phase-execute`** picks up those issues and autonomously implements them — for each issue: implement, create PR, run multi-agent review, fix findings, merge. Zero user intervention. `/stark-copilot` is the alternative execution mode: a paired lead/wing build loop where the lead implements in a worktree and the wing reviews the diff until it approves.

**Step 6 — `/stark-review`** is the PR code review that runs during execution (or standalone). One agent across triage-selected domains, posted to GitHub under the agent's bot identity.

## The Ecosystem

![Ecosystem](ecosystem.png)

The pipeline handles the happy path from idea to code. The remaining skills handle everything around it.

**Adversarial review** — `/stark-red-team-design` and `/stark-red-team-plan` put a design or execution plan through a committee of adversarial personas, surfacing challenges the domain reviews miss. Challenge-only — no fix loop.

**Workflow** — `/stark-session` manages work sessions (briefing on start, cleanup on end). `/stark-release` cuts versioned releases with changelog and tags. `/stark-persona` adds character voices to sessions — weighted selection, date-aware combos, and catchphrases. `/stark-gh-user` switches the active GitHub identity to dodge per-user API rate limits.

**Maintenance** — `/stark-housekeeping` audits stale issues, dead branches, and worktree remnants. `/stark-review-improvement` tunes review prompts based on false-positive analysis; `/stark-review-design-improvement` does the same for design-review prompts.

**Documentation** — `/stark-init-docs` scaffolds a docs structure (ADRs, runbooks, MkDocs config).

## Detailed Docs

Every skill has two documentation pages: **usage** (how to invoke it, what it does, example output) and **internals** (architecture, data flow, how the pieces fit together). See the [full index](index.md) for links.
