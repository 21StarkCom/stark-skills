# stark-session — Internals

Session management — start and end modes. Start: loads context, git state, health checks, briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json hierarchy. Use when the user says "session start", "session end", "start session", "end session", "what was I working on", "catch me up", or invokes /stark-session.

## Architecture

```mermaid

```

![A clean internal architecture diagram for the “stark-session” skill showing two parallel workflow narratives: Start Mode on top with config resolution, silent context gathering, git and PR inspection, health checks, skill discovery, and a briefing output; and End Mode below with tests/build, optional PR merges, docs/devlog commit, project field updates, push decision logic, and a final session summary. Blue nodes mark phases, green nodes mark config and policy, purple marks decision points, amber marks user-visible outputs, gray callouts mark external systems like git, gh, and project config, and tables below document config hierarchy, session keys, extension points, and failure recovery behavior."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-session/SKILL.md`, then run `/stark-generate-docs --skill stark-session` to regenerate documentation.
