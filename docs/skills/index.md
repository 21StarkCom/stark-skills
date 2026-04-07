# Skill Documentation Index

## Overview Visuals

- [Pipeline](pipeline.html)
- [Ecosystem](ecosystem.html)

## Pipeline Skills (in order)

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-design` | Generate design doc from requirements — 3 agents generate, 6 cross-review, synthesize winner | [usage](stark-design/usage.md) · [internals](stark-design/internals.md) |
| `/stark-review-design` | Multi-agent design/spec review — N agents × 12 domains with fix loop | [usage](stark-review-design/usage.md) · [internals](stark-review-design/internals.md) |
| `/stark-design-to-plan` | Generate implementation plan from design — 3 agents generate, 6 cross-review, synthesize | [usage](stark-design-to-plan/usage.md) · [internals](stark-design-to-plan/internals.md) |
| `/stark-review-plan` | Multi-agent plan review — N agents × 10 adversarial domains with fix loop | [usage](stark-review-plan/usage.md) · [internals](stark-review-plan/internals.md) |
| `/stark-plan-to-tasks` | Decompose plan into phased GitHub issues with story points | [usage](stark-plan-to-tasks/usage.md) · [internals](stark-plan-to-tasks/internals.md) |
| `/stark-phase-execute` | Autonomous phase execution — implement, PR, review, merge | [usage](stark-phase-execute/usage.md) · [internals](stark-phase-execute/internals.md) |
| `/stark-autopilot` | Tournament implementation — 3 agents compete per step in worktrees | [usage](stark-autopilot/usage.md) · [internals](stark-autopilot/internals.md) |
| `/stark-review` | Multi-agent PR code review — 3 agents × 9 domains | [usage](stark-review/usage.md) · [internals](stark-review/internals.md) |

## Workflow & Ops

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-review-improvement` | Improve review prompts from assessment feedback | [usage](stark-review-improvement/usage.md) · [internals](stark-review-improvement/internals.md) |
| `/stark-review-design-improvement` | Improve design review prompts from assessment feedback | — |
| `/stark-pr-flow` | End-to-end PR workflow: push, create, review, merge | [usage](stark-pr-flow/usage.md) · [internals](stark-pr-flow/internals.md) |
| `/stark-session` | Session management: briefing on start, cleanup on end | [usage](stark-session/usage.md) · [internals](stark-session/internals.md) |
| `/stark-release` | Cut a release: changelog, tag, GitHub Release | [usage](stark-release/usage.md) · [internals](stark-release/internals.md) |
| `/stark-tournament` | Multi-LLM competition with configurable evaluation | [usage](stark-tournament/usage.md) · [internals](stark-tournament/internals.md) |
| `/stark-persona` | Session character voices with weighted selection and combos | [showcase](stark-persona/index.html) |

## Project Setup & Docs

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-onboard-project` | Bootstrap new project: git, GitHub, apps, CLAUDE.md | [usage](stark-onboard-project/usage.md) · [internals](stark-onboard-project/internals.md) |
| `/stark-init-docs` | Scaffold dev docs structure | [usage](stark-init-docs/usage.md) · [internals](stark-init-docs/internals.md) |
| `/stark-extract-docs` | Extract knowledge from specs into ADRs, retros, docs | [usage](stark-extract-docs/usage.md) · [internals](stark-extract-docs/internals.md) |
| `/stark-generate-docs` | Generate skill docs with multi-LLM viz | [usage](stark-generate-docs/usage.md) · [internals](stark-generate-docs/internals.md) |
| `/stark-claude-md-improver` | Analyze and improve CLAUDE.md files | [usage](stark-claude-md-improver/usage.md) · [internals](stark-claude-md-improver/internals.md) |

## Maintenance & Analytics

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-update-deps` | Audit and update dependency versions | [usage](stark-update-deps/usage.md) · [internals](stark-update-deps/internals.md) |
| `/stark-rename-project` | Rename project locally + GitHub + sibling refs | [usage](stark-rename-project/usage.md) · [internals](stark-rename-project/internals.md) |
| `/stark-metrics` | Review performance metrics | [usage](stark-metrics/usage.md) · [internals](stark-metrics/internals.md) |
| `/stark-pr-status` | PR analytics dashboard | [usage](stark-pr-status/usage.md) · [internals](stark-pr-status/internals.md) |
| `/stark-skill-analytics` | Skill usage and adoption metrics | [usage](stark-skill-analytics/usage.md) · [internals](stark-skill-analytics/internals.md) |
| `/stark-session-insights` | Analyze session history for patterns | [usage](stark-session-insights/usage.md) · [internals](stark-session-insights/internals.md) |
