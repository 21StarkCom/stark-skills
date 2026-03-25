# stark-session — Internals

Session management — start and end modes. Start: loads context, git state, health checks, briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json hierarchy. Use when the user says "session start", "session end", "start session", "end session", "what was I working on", "catch me up", or invokes /stark-session.

## Architecture

```mermaid

```

![Internal architecture diagram for the stark-session skill showing a central mode dispatch that splits into start mode and end mode. The start side flows through config loading, silent context gathering, git and PR inspection, optional project board read, health checks, skill discovery, and a concise operator briefing. The end side flows through tests and optional build, conditional proceed-anyway decision, optional PR merges through gh, docs staging and optional devlog commit, optional project field updates, push logic, and a final session summary. Supporting cards explain config hierarchy, fail-soft behavior, human checkpoints, extension points, external integrations, observability metrics, and guardrails."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-session/SKILL.md`, then run `/stark-generate-docs --skill stark-session` to regenerate documentation.
