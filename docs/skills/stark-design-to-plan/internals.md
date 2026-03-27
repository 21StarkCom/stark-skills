# stark-design-to-plan — Internals

Use this skill when the user wants to turn a design document, spec, or reviewed architecture doc into a phased implementation plan. Triggers whenever someone has a finished design/spec file and needs it converted into actionable phases, tasks, dependencies, rollback procedures, or risk mitigations. Covers requests like "create a plan from this design", "turn this spec into an implementation plan", "generate phases from my design doc", or any variation where input is a design/spec and desired output is an execution or implementation plan. Also triggers on `/stark-design-to-plan <path>`. Works by dispatching 3 independent AI agents to each produce a plan, then cross-reviewing all plans to synthesize the best one. This is the natural next step after design review (`/stark-review-design`).

## Architecture

```mermaid

```

![Internal architecture diagram for the stark-design-to-plan skill showing a five-phase pipeline from CLI input and setup validation through three-agent plan generation, cross-review scoring, local synthesis, and final output persistence, with callouts for quorum decisions, degraded failure paths, observability requirements, configuration flags, and extension points."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-design-to-plan/SKILL.md`, then run `/stark-generate-docs --skill stark-design-to-plan` to regenerate documentation.
