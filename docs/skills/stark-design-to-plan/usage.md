# stark-design-to-plan

Use this skill when the user wants to turn a design document, spec, or reviewed architecture doc into a phased implementation plan. Triggers whenever someone has a finished design/spec file and needs it converted into actionable phases, tasks, dependencies, rollback procedures, or risk mitigations. Covers requests like "create a plan from this design", "turn this spec into an implementation plan", "generate phases from my design doc", or any variation where input is a design/spec and desired output is an execution or implementation plan. Also triggers on `/stark-design-to-plan <path>`. Works by dispatching 3 independent AI agents to each produce a plan, then cross-reviewing all plans to synthesize the best one. This is the natural next step after design review (`/stark-review-design`).

## Workflow Overview

```mermaid

```

![A polished single-page visualization for the `stark-design-to-plan` skill with a blue-green hero banner, quick-start command, KPI tiles showing 3 plans and 6 reviews, a vertical workflow diagram from setup through synthesis and output, argument and failure tables, cards for prerequisites and common usage patterns, and clear emphasis that the skill turns a reviewed design markdown file into a phased implementation plan."}}](usage.png)

## When to Use

Use this skill when the user wants to turn a design document, spec, or reviewed architecture doc into a phased implementation plan. Triggers whenever someone has a finished design/spec file and needs it converted into actionable phases, tasks, dependencies, rollback procedures, or risk mitigations. Covers requests like "create a plan from this design", "turn this spec into an implementation plan", "generate phases from my design doc", or any variation where input is a design/spec and desired output is an execution or implementation plan. Also triggers on `/stark-design-to-plan <path>`. Works by dispatching 3 independent AI agents to each produce a plan, then cross-reviewing all plans to synthesize the best one. This is the natural next step after design review (`/stark-review-design`).

## Prerequisites

*See SKILL.md*

## Arguments

`<path> [--agents claude,codex,gemini] [--timeout N] [--dry-run] [--force]`



## Quick Start

/stark-design-to-plan

## Common Patterns



## Troubleshooting



## Related Skills


