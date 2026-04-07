# stark-team-review — Internals

Multi-agent PR code review using 3 LLMs × 9 domains with autonomous fix loop. Use when the user says "team review", "review this PR with all agents", "multi-agent review", or invokes /stark-team-review. Also triggers on `/stark-team-review` or `/stark-team-review <number>`.

## Architecture

```mermaid

```

![Internal architecture page for the skill "stark-team-review" showing a top summary strip with control-plane stats, a vertical workflow diagram from invocation through setup, auth gating, worktree isolation, parallel 27-agent review rounds, classification and fixing, summary generation, posting, and cleanup, followed by tables for runtime contracts and decision gates, plus cards for observability, failure recovery, and extension points.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-team-review/SKILL.md`, then run `/stark-generate-docs --skill stark-team-review` to regenerate documentation.
