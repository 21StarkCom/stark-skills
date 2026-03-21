---
name: stark-session-insights
description: >
  Analyze Claude Code session history to extract usage patterns, skill invocations,
  action frequencies, corrections, and preferences — grouped by project. Reads
  ~/.claude/history.jsonl and generates per-project insight files. Use when the user
  says "session insights", "analyze sessions", "usage patterns", "what do I do most",
  or invokes /stark-session-insights.
argument-hint: "[--project <name>] [--refresh]"
---

# stark-session-insights

Analyze `~/.claude/history.jsonl` to extract session insights and save them grouped
by project/repo to `~/.claude/code-review/insights/sessions/`.

## Arguments

- `[--project <name>]` — process a single project (partial match on path)
- `[--refresh]` — regenerate even if insights file exists and inputs haven't changed
- No arguments = process all projects

## Constants

```
HISTORY_FILE = ~/.claude/history.jsonl
OUTPUT_DIR   = ~/.claude/code-review/insights/sessions
SESSION_GAP  = 30  # minutes — gap threshold for new session
```

## Phase 1: Load & Parse

### 1.1 Read history file

Read `~/.claude/history.jsonl`. Each line is a JSON object with at least:

```json
{
  "display": "the prompt text",
  "timestamp": 1742000000000,
  "project": "/Users/aryeh/git/Evinced/infra-pulse",
  "sessionId": "abc123"
}
```

- `timestamp` is milliseconds since epoch.
- `project` is an absolute path.
- `sessionId` groups prompts within a single Claude Code session.

If the file doesn't exist or is empty, error: "No history file found at ~/.claude/history.jsonl" and abort.

Parse all lines. Skip malformed lines with a warning count.

### 1.2 Group by project

Group entries by `project` field.

Derive a short project name from the path by taking the last two path segments:
- `/Users/aryeh/git/Evinced/infra-pulse` → `Evinced/infra-pulse`
- `/Users/aryeh/git/personal/dotfiles` → `personal/dotfiles`
- `/Users/aryeh/git/Evinced/stark-review` → `Evinced/stark-review`

If `--project <name>` was given, filter to projects whose path contains `<name>` (case-insensitive partial match). If no match, error: "No project matching '{name}' found. Available: {list of short names}" and abort.

### 1.3 Skip logic

For each project, derive a slug from the short name: replace `/` with `--`, lowercase. E.g., `Evinced/infra-pulse` → `evinced--infra-pulse`.

If `--refresh` was NOT passed:
- Check if `{OUTPUT_DIR}/{slug}.md` exists.
- If it exists, compare the file's first line timestamp comment (`<!-- generated: YYYY-MM-DDTHH:MM:SS, entries: N -->`) against the current entry count for this project.
- If the entry count matches, skip: "Insights for {short-name} are current ({N} entries). Use --refresh to regenerate."

## Phase 2: Analysis

For each project to process, run the following analyses using inline Python (via `python3 -c` or a heredoc script). Do NOT create a separate Python file — embed the analysis in bash.

### 2.1 Basic stats

- **Prompt count**: total number of entries
- **Date range**: earliest → latest timestamp (format: YYYY-MM-DD)
- **Days active**: count of unique dates
- **Prompts per day**: prompt count / days active (1 decimal)
- **Session count**: group by `sessionId`. If `sessionId` is missing, use the 30-minute gap heuristic (sort by timestamp, gap > 30 min = new session).
- **Avg session length**: for each session, time between first and last prompt. Average across sessions. Format as minutes.

### 2.2 Skill/command invocations

Scan `display` text for patterns starting with `/stark-` or `/`:
- Extract the command name (e.g., `/stark-review`, `/stark-session`, `/commit`, `/help`)
- Count invocations per command
- Sort by frequency, show top 15

### 2.3 Action word frequency

Count occurrences of action words in `display` text (case-insensitive, whole-word match):
- review, fix, update, push, test, commit, merge, deploy, create, add, remove, delete, check, read, write, run, build, install, refactor, debug, revert, release, rename, move, copy, search, find, list, show, explain, analyze, compare, migrate, upgrade, configure, setup, init, clean, lint, format

Sort by frequency, show top 20.

### 2.4 Activity by hour

Bucket prompts by hour of day (local time — convert from epoch ms to local). Show distribution as a simple bar chart using block characters:

```
00: ██ (12)
01: █ (5)
...
09: ████████████ (89)
10: ████████████████ (120)
```

### 2.5 Prompt length distribution

Categorize each prompt by character length:
- **Short** (≤ 50 chars): quick commands, yes/no, go
- **Medium** (51-200 chars): instructions, descriptions
- **Long** (> 200 chars): detailed specs, requirements, pastes

Show count and percentage for each bucket.

### 2.6 Common short responses

From prompts ≤ 20 chars, find the most common patterns:
- Exact matches for: yes, no, y, n, go, ok, done, thanks, lgtm, continue, next, stop, retry
- Show count for each that appears at least twice

### 2.7 Corrections and preferences

Search for correction signals in `display` text:
- Starts with "no" (but not "no arguments", "no changes" — isolated "no" or "no," or "no!")
- Contains "don't", "stop", "wrong", "not what I", "instead", "actually", "I said", "I meant", "undo", "revert that"
- Starts with "!" or ends with "!"

Collect these prompts with their timestamps. These represent user corrections and preferences — the most valuable insights.

Show up to 20, sorted by recency.

### 2.8 Key requirements (long prompts)

Collect prompts with > 200 characters. These typically represent:
- Detailed specifications
- Multi-step instructions
- Architecture decisions
- Bug reports with context

Show up to 15, sorted by length (longest first). Truncate each to 300 chars for display, with `...` if truncated.

## Phase 3: Generate Output

### 3.1 Per-project file

For each processed project, generate `{OUTPUT_DIR}/{slug}.md`:

```markdown
<!-- generated: {ISO-8601-timestamp}, entries: {N} -->
# Session Insights — {short-name}

**Period:** {first-date} → {last-date}
**Prompts:** {N} across {session-count} sessions ({days-active} days)

## Activity Profile

- **Prompts/day:** {N}
- **Peak hours:** {top 3 hours with counts}
- **Avg session:** {N} minutes ({min}–{max} range)
- **Prompt length:** {short}% short, {medium}% medium, {long}% long

### Hourly Distribution

{hour chart from 2.4}

## Skill Usage

| Skill | Count |
|-------|-------|
{rows from 2.2}

## Action Patterns

| Action | Count |
|--------|-------|
{rows from 2.3}

## Short Responses

| Response | Count |
|----------|-------|
{rows from 2.6}

## Corrections & Preferences

These represent moments where the user corrected course — the most valuable signals for understanding working style.

| Date | Prompt |
|------|--------|
{rows from 2.7, date as YYYY-MM-DD HH:MM}

## Key Requirements

Long prompts (>200 chars) that represent detailed specifications or decisions.

{numbered list from 2.8, each as a blockquote with date prefix}
```

### 3.2 Summary index

Generate `{OUTPUT_DIR}/index.md`:

```markdown
<!-- generated: {ISO-8601-timestamp} -->
# Session Insights Index

**History file:** ~/.claude/history.jsonl
**Total entries:** {N}
**Projects:** {N}
**Generated:** {YYYY-MM-DD HH:MM}

## Projects

| Project | Prompts | Sessions | Days | Period | Top Action |
|---------|---------|----------|------|--------|------------|
{one row per project, sorted by prompt count descending}

## Cross-Project Summary

- **Most active project:** {name} ({N} prompts)
- **Total sessions:** {N}
- **Total days active:** {N} unique dates across all projects
- **Most used skill:** {name} ({N} invocations)
- **Most common action:** {word} ({N} occurrences)
```

## Phase 4: Write & Report

### 4.1 Create output directory

```bash
mkdir -p ~/.claude/code-review/insights/sessions
```

### 4.2 Write files

Write all generated markdown files using the Write tool.

### 4.3 Report

Print summary:

```
[HH:MM:SS] === stark-session-insights completed ===

Projects processed: {N}
Projects skipped:   {N} (current)
Output directory:   ~/.claude/code-review/insights/sessions/

Files written:
  {list of files}
```

## Edge Cases

- **Empty history file** — error and abort, not a silent skip
- **Project with only 1 prompt** — show stats but session length = 0
- **Malformed JSONL lines** — skip with warning, don't abort
- **Missing fields** — `display` defaults to empty string, skip entries without `timestamp`
- **Very long display text** — truncate to 300 chars in output, never show full text of extremely long prompts
- **Unicode in prompts** — preserve as-is in output
- **No corrections found** — show section with "No corrections detected."
- **No skills used** — show section with "No skill invocations found."

## What This Skill Does NOT Do

- Modify or delete history.jsonl
- Send data anywhere — all output is local files
- Analyze prompt content for security/sensitive data
- Compare across users (single-user tool)
- Create GitHub issues or PRs
