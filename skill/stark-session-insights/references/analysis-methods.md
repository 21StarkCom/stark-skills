# Analysis Methods

Detailed specifications for each Phase 2 analysis step. Referenced from [../SKILL.md](../SKILL.md).

## 2.1 Basic stats

- **Prompt count**: total number of entries
- **Date range**: earliest to latest timestamp (format: YYYY-MM-DD)
- **Days active**: count of unique dates
- **Prompts per day**: prompt count / days active (1 decimal)
- **Session count**: group by `sessionId`. If `sessionId` is missing, use the 30-minute gap heuristic (sort by timestamp, gap > 30 min = new session).
- **Avg session length**: for each session, time between first and last prompt. Average across sessions. Format as minutes.

## 2.2 Skill/command invocations

Scan `display` text for patterns starting with `/stark-` or `/`:
- Extract the command name (e.g., `/stark-team-review`, `/stark-session`, `/commit`, `/help`)
- Count invocations per command
- Sort by frequency, show top 15

## 2.3 Action word frequency

Count occurrences of action words in `display` text (case-insensitive, whole-word match):
- review, fix, update, push, test, commit, merge, deploy, create, add, remove, delete, check, read, write, run, build, install, refactor, debug, revert, release, rename, move, copy, search, find, list, show, explain, analyze, compare, migrate, upgrade, configure, setup, init, clean, lint, format

Sort by frequency, show top 20.

## 2.4 Activity by hour

Bucket prompts by hour of day (local time -- convert from epoch ms to local). Show distribution as a simple bar chart using block characters:

```
00: ██ (12)
01: █ (5)
...
09: ████████████ (89)
10: ████████████████ (120)
```

## 2.5 Prompt length distribution

Categorize each prompt by character length:
- **Short** (<=50 chars): quick commands, yes/no, go
- **Medium** (51-200 chars): instructions, descriptions
- **Long** (> 200 chars): detailed specs, requirements, pastes

Show count and percentage for each bucket.

## 2.6 Common short responses

From prompts <=20 chars, find the most common patterns:
- Exact matches for: yes, no, y, n, go, ok, done, thanks, lgtm, continue, next, stop, retry
- Show count for each that appears at least twice

## 2.7 Corrections and preferences

Search for correction signals in `display` text:
- Starts with "no" (but not "no arguments", "no changes" -- isolated "no" or "no," or "no!")
- Contains "don't", "stop", "wrong", "not what I", "instead", "actually", "I said", "I meant", "undo", "revert that"
- Starts with "!" or ends with "!"

Collect these prompts with their timestamps. These represent user corrections and preferences -- the most valuable insights.

Show up to 20, sorted by recency.

## 2.8 Key requirements (long prompts)

Collect prompts with > 200 characters. These typically represent:
- Detailed specifications
- Multi-step instructions
- Architecture decisions
- Bug reports with context

Show up to 15, sorted by length (longest first). Truncate each to 300 chars for display, with `...` if truncated.

## 2.9 Day-of-week distribution

Bucket prompts by day of week (Monday-Sunday, using local time). Show count and percentage for each day. This reveals work rhythm -- weekend-heavy vs. weekday-focused, which days are deep work days.

## 2.10 Weekly trends

Group prompts by ISO week. Show a table with week label, prompt count, and a short characterization based on volume change vs. previous week (ramp-up, peak, sustained, tapering). This shows the project's lifecycle arc -- when it started, when it peaked, whether it's growing or winding down.

## 2.11 Skill evolution

If more than 2 weeks of data exist, compare skill usage in the first half vs. second half of the project timeline. Flag skills that appeared, disappeared, or shifted in frequency. This catches migration patterns (e.g., moving from `/code-review` to `/stark-team-review`).

## 2.12 Session shape analysis

Analyze session behavior:
- **How sessions begin**: most common first prompt per session (e.g., `/model`, `What's next?`, a direct command)
- **How sessions end**: most common last prompt per session (e.g., `/clear`, `/exit`, `push`)
- **Session types**: classify each session by its dominant action pattern:
  - *Build/ship* -- dominated by create/add/commit/push actions
  - *Review/fix* -- dominated by review/fix actions
  - *Debug* -- contains error pastes, "still broken", retry patterns
  - *Architecture* -- long sessions with option selections (A/B/C) and questions
  - *Maintenance* -- dominated by clean/delete/rename/update actions
- Show count and percentage for each session type

## 2.13 Correction categorization

Group the corrections from 2.7 into categories:
- **Data/logic errors** -- wrong values, broken output, incorrect behavior ("wrong", "still not working", "broken")
- **UX/direction** -- design preferences, scope changes ("don't want", "instead", "I meant")
- **Process/workflow** -- how Claude should behave ("stop asking", "just do it", "don't write a file")
- **Frustration** -- emphasis, exclamation marks, repeated corrections ("Come on!", "still wrong", "this is not the first time")

Show count per category and highlight the top 3 most recurring themes.

## 2.14 Narrative synthesis

This is the most important analysis step. Using ALL data from 2.1-2.13, write a **3-5 paragraph narrative** that interprets the numbers into a coherent story about how this project was used. The narrative should answer:

- **What kind of project is this?** (from action patterns, topic clusters, key requirements)
- **What's the work rhythm?** (from hourly, daily, weekly patterns -- e.g., "weekend warrior", "evening deep work", "morning architect")
- **How does the user interact with Claude?** (from session shape, short responses, decision patterns -- e.g., "terse commander who delegates via options")
- **What went wrong?** (from corrections, pain points -- e.g., "data accuracy was the main friction point")
- **How did the project evolve?** (from weekly trends, skill evolution, phase detection)

Write this as prose, not bullet points. Be specific -- cite numbers. Be opinionated -- don't hedge. If the data shows something clearly, say it directly.

## 2.15 Recommendations

Based on the full analysis, generate 3-5 actionable recommendations. Each should be tied to a specific data point. Categories:
- **Pain point fixes** -- recurring corrections that could be prevented
- **Workflow optimizations** -- session patterns that suggest a better approach
- **Tool adoption** -- skills that are underused or could help
- **Sustainability** -- work rhythm concerns (e.g., late-night sessions, unsustainable pace)
