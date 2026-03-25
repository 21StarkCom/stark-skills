# stark-skill-analytics — Internals

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Reads ~/.claude/history.jsonl and skill run history files to produce adoption curves, usage rankings, quality signals, and recommendations. Use when the user says "skill analytics", "skill usage", "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.

## Architecture

```mermaid

```

![A clean internal architecture diagram for the `stark-skill-analytics` skill, showing a top-down pipeline from argument parsing into four phases: usage extraction from `~/.claude/history.jsonl`, quality aggregation from run-history JSON files, cross-reference analysis against `CLAUDE.md` and benchmarks, and final markdown report generation. Blue nodes mark workflow phases, green marks configuration, purple marks decision points, amber marks outputs, red marks failure or degraded paths, and dashed gray nodes represent external files. Supporting tables summarize data contracts, arguments, failure handling, and extension points for contributors."}}](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-skill-analytics/SKILL.md`, then run `/stark-generate-docs --skill stark-skill-analytics` to regenerate documentation.
