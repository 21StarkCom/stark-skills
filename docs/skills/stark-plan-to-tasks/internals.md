# stark-plan-to-tasks — Internals

Decompose a spec/design document into phased GitHub issues with story points, risk, and confidence labels. Extracts domain knowledge to project docs and deletes the plan. Use when the user says "plan to tasks", "decompose plan", "break down this plan", "create issues from spec", "create tasks from plan", or invokes /stark-plan-to-tasks.

## Architecture

```mermaid

```

![A clean internal architecture infographic for the stark-plan-to-tasks skill showing a vertical workflow spine from setup through quality gate, decomposition, validation, issue creation, optional GitHub Project integration, knowledge extraction, and summary. Blue nodes mark core phases, purple nodes mark decision loops like reruns and validation retries, green nodes show config and auth inputs, amber nodes show artifacts such as the breakdown JSON and run manifest, and red nodes mark abort or warning states. Below the flow are cards and tables explaining data contracts, config hierarchy, auth switching, failure semantics, and extension points for contributors."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-plan-to-tasks/SKILL.md`, then run `/stark-generate-docs --skill stark-plan-to-tasks` to regenerate documentation.
