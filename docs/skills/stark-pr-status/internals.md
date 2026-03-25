# stark-pr-status — Internals

PR analytics dashboard — review rounds, findings by severity, signal-vs-noise, time-to-merge, participants, and most impactful comments. Combines GitHub API data with stark-review history. Use when the user says "PR status", "show PR stats", "how is this PR doing", "PR dashboard", "what happened on PR 15", or invokes /stark-pr-status. Also use when the user asks about review cycles, merge times, or finding quality for specific PRs.

## Architecture

```mermaid

```

![A polished internal architecture page for the `stark-pr-status` skill with a large title, a legend of colored node types, summary cards explaining purpose and data blend, a vertical flow diagram from CLI entry through repo detection, GitHub and history ingestion, lifecycle normalization, output branching, and suggestion heuristics, followed by data-contract tables, failure-mode cards, and observability and extension-point notes."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-pr-status/SKILL.md`, then run `/stark-generate-docs --skill stark-pr-status` to regenerate documentation.
