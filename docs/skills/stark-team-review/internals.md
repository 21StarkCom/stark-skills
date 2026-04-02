# stark-review — Internals

Multi-agent PR code review using 3 LLMs × N domains with autonomous fix loop. Use when the user says "stark review", "review this PR with all agents", "multi-agent review", or invokes /stark-review. Also triggers on `/stark-review` or `/stark-review <number>`.

## Architecture

```mermaid

```

![A clean internal architecture page for the skill \"stark-review\" showing a top summary strip with control-plane stats, a vertical workflow diagram from invocation through setup, auth gating, worktree isolation, parallel 18-agent review rounds, classification and fixing, summary generation, posting, and cleanup, followed by tables for runtime contracts and decision gates, cards for observability, failure recovery, and extension points, all color-coded by phase, decision, config, output, failure, and external dependency."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-review/SKILL.md`, then run `/stark-generate-docs --skill stark-review` to regenerate documentation.
