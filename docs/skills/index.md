# Skill Documentation Index

## Pipeline Skills (in order)

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-review-design` | Multi-agent design/spec review — N agents × 12 domains with fix loop | [source](../../skill/stark-review-design/SKILL.md) |
| `/stark-design-to-plan` | Generate implementation plan from design — 3 agents generate, 6 cross-review, synthesize | [usage](stark-design-to-plan/usage.md) · [internals](stark-design-to-plan/internals.md) |
| `/stark-red-team-design` | Adversarial 5-persona challenge of a design doc | [source](../../skill/stark-red-team-design/SKILL.md) |
| `/stark-review-plan` | Multi-agent plan review — N agents × 10 adversarial domains with fix loop | [usage](stark-review-plan/usage.md) · [internals](stark-review-plan/internals.md) |
| `/stark-red-team-plan` | Adversarial 5-persona challenge of an execution plan | [source](../../skill/stark-red-team-plan/SKILL.md) |
| `/stark-plan-to-tasks` | Decompose plan into phased GitHub issues with story points | [usage](stark-plan-to-tasks/usage.md) · [internals](stark-plan-to-tasks/internals.md) |
| `/stark-phase-execute` | Autonomous phase execution — implement, PR, review, merge | [usage](stark-phase-execute/usage.md) · [internals](stark-phase-execute/internals.md) |
| `/stark-autopilot` | Tournament implementation — agents compete per step in worktrees | [usage](stark-autopilot/usage.md) · [internals](stark-autopilot/internals.md) |

## Workflow & Ops

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-review-improvement` | Improve review prompts from assessment feedback | [usage](stark-review-improvement/usage.md) · [internals](stark-review-improvement/internals.md) |
| `/stark-review-design-improvement` | Improve design review prompts from assessment feedback | [source](../../skill/stark-review-design-improvement/SKILL.md) |
| `/stark-review` | Single-agent PR code review — 1 agent × 9 domains | [source](../../skill/stark-review/SKILL.md) |
| `/stark-session` | Session management: briefing on start, cleanup on end | [usage](stark-session/usage.md) · [internals](stark-session/internals.md) |
| `/stark-release` | Cut a release: changelog, tag, GitHub Release | [usage](stark-release/usage.md) · [internals](stark-release/internals.md) |
| `/stark-housekeeping` | Audit and clean stale issues, dead branches, and worktree remnants | [source](../../skill/stark-housekeeping/SKILL.md) |
| `/stark-persona` | Session character voices with weighted selection and combos | [source](../../skill/stark-persona/SKILL.md) |

## Project Setup & Docs

| Skill | Description | Docs |
|-------|-------------|------|
| `/stark-init-docs` | Scaffold dev docs structure | [usage](stark-init-docs/usage.md) · [internals](stark-init-docs/internals.md) |
