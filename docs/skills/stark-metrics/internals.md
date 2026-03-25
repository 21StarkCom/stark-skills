# stark-metrics — Internals

Aggregate performance metrics across all stark skill runs. Agent scorecards, finding quality, duration trends, prompt improvement impact, and actionable recommendations. Use when the user says "show metrics", "how are reviews performing", "agent stats", "review quality", or invokes /stark-metrics.

## Architecture

```mermaid

```

![Internal architecture diagram for the stark-metrics skill showing a top-down operator pipeline: invocation with repo, skill, since, and json flags flows into Phase 1 where metrics.py runs from a fixed Python virtualenv and reads review history from ~/.claude/code-review/history/. A decision node branches to failure handling for no history, argument errors, or missing installation. The success path continues through normalization of mixed record formats, filter application, and report generation for scorecards, finding quality, duration trends, prompt-change impact, and recommendations. A second decision asks whether recommendations exist and routes to follow-up actions like /stark-review-improvement or config edits. The page also includes cards for execution boundary, extension seams, output contract, operational risk, observability requirements, internal interfaces, and a table of recovery paths for common failures."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-metrics/SKILL.md`, then run `/stark-generate-docs --skill stark-metrics` to regenerate documentation.
