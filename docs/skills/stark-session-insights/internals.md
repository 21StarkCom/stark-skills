# stark-session-insights — Internals

Analyze Claude Code session history to extract usage patterns, skill invocations, action frequencies, corrections, and preferences — grouped by project. Reads ~/.claude/history.jsonl and generates per-project insight files. Use when the user says "session insights", "analyze sessions", "usage patterns", "what do I do most", or invokes /stark-session-insights.

## Architecture

```mermaid
graph TD
  history[~/.claude/history.jsonl] --> load[Phase 1: Load & Parse]
  load --> group[Group by Project & Format Slug]
  group --> filter[Filter via --project]
  filter --> skip{Skip if current & no --refresh?}
  skip -- Yes --> done[Skip Project]
  skip -- No --> analyze[Phase 2: Inline Python Analysis]
  
  analyze --> stats[Usage Metrics & Action Words]
  analyze --> time[Temporal & Rhythm Analysis]
  analyze --> session[Session Typing & Corrections]
  analyze --> narrative[Narrative Synthesis]
  
  stats --> gen[Phase 3: Generate Markdown]
  time --> gen
  session --> gen
  narrative --> gen
  
  gen --> write[Phase 4: Write Outputs]
  write --> out1[sessions/slug.md]
  write --> out2[sessions/index.md]
```

![An architectural flow diagram of the stark-session-insights skill showing the data pipeline from reading Claude's history.jsonl through parsing, inline Python analysis phases like action patterns and session shape, to writing localized markdown insight files.](internals.png)

## Phases

*See SKILL.md*

## Config

*No config*

## Failure Modes

*See SKILL.md*

## How to Modify This Skill

Edit `skill/stark-session-insights/SKILL.md`, then run `/stark-generate-docs --skill stark-session-insights` to regenerate documentation.
