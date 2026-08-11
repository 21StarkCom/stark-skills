# Skill Documentation Index

## Pipeline Skills

The ordered five-stage chain this section listed was retired on 2026-07-26.
The pipeline is now `/stark-author` -> `/stark-build`; see the repo README.

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-copilot` | Paired lead/wing autonomous implementation — lead implements, wing reviews, fix-loop | [source](../../skill/stark-copilot/SKILL.md) |

## Workflow & Ops

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-review-improvement` | Improve review prompts from assessment feedback | [usage](stark-review-improvement/usage.md) · [internals](stark-review-improvement/internals.md) |
| `/stark-review` | Single-agent PR code review — 1 agent × triage-selected domains | [source](../../skill/stark-review/SKILL.md) |
| `/stark-session` | Session management: briefing on start, cleanup on end | [usage](stark-session/usage.md) · [internals](stark-session/internals.md) |
| `/stark-release` | Cut a release: changelog, tag, GitHub Release | [usage](stark-release/usage.md) · [internals](stark-release/internals.md) |
| `/stark-housekeeping` | Audit and clean stale issues, dead branches, and worktree remnants | [source](../../skill/stark-housekeeping/SKILL.md) |
| `/stark-persona` | Session character voices with weighted selection and combos | [source](../../skill/stark-persona/SKILL.md) |

## Project Setup & Docs

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-init-docs` | Scaffold dev docs structure | [usage](stark-init-docs/usage.md) · [internals](stark-init-docs/internals.md) |
