---
name: stark-session-insights
description: >-
  Analyze Claude Code session history for usage patterns, corrections, and preferences by project. Use for session insights.
argument-hint: "[--project <name>] [--refresh]"
disable-model-invocation: true
model: haiku
allowed-tools: Read, Grep, Glob, Bash, Write
revision: 6b87ca62ee8dd55dc36bf48842dc93d2db763258
revision_date: 2026-04-02T14:29:50+03:00
---

# stark-session-insights

Analyze `~/.claude/history.jsonl` to extract session insights and save them grouped
by project/repo to `~/.claude/code-review/insights/sessions/`.

## Arguments

- `[--project <name>]` — process a single project (partial match on path)
- `[--refresh]` — regenerate even if insights file exists and inputs haven't changed
- No arguments = process all projects

**Raw input:** `$ARGUMENTS`

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
- `/Users/aryeh/git/Evinced/stark-skills` → `Evinced/stark-skills`

If `--project <name>` was given, filter to projects whose path contains `<name>` (case-insensitive partial match). If no match, error: "No project matching '{name}' found. Available: {list of short names}" and abort.

### 1.3 Skip logic

For each project, derive a slug from the short name: replace `/` with `--`, lowercase. E.g., `Evinced/infra-pulse` → `evinced--infra-pulse`.

If `--refresh` was NOT passed:
- Check if `{OUTPUT_DIR}/{slug}.md` exists.
- If it exists, compare the file's first line timestamp comment (`<!-- generated: YYYY-MM-DDTHH:MM:SS, entries: N -->`) against the current entry count for this project.
- If the entry count matches, skip: "Insights for {short-name} are current ({N} entries). Use --refresh to regenerate."

## Phase 2: Analysis

For each project to process, run the following analyses using inline Python (via `python3 -c` or a heredoc script). Do NOT create a separate Python file — embed the analysis in bash.

Run the following analyses (for detailed specifications of each, see [references/analysis-methods.md](references/analysis-methods.md)):

1. Basic stats (prompts, sessions, dates, averages)
2. Skill/command invocations (top 15 by frequency)
3. Action word frequency (top 20)
4. Activity by hour (bar chart distribution)
5. Prompt length distribution (short/medium/long)
6. Common short responses (≤20 chars)
7. Corrections and preferences (signal detection)
8. Key requirements (long prompts >200 chars)
9. Day-of-week distribution
10. Weekly trends (volume + characterization)
11. Skill evolution (first half vs second half)
12. Session shape analysis (begin/end/type)
13. Correction categorization (4 categories)
14. Narrative synthesis (3-5 paragraph prose)
15. Recommendations (3-5 actionable items)

## Phase 3: Generate Output

### 3.1 Per-project file

Write `{OUTPUT_DIR}/{slug}.md` with activity profile, skill usage, action patterns, weekly trends, session behavior, corrections, key requirements, narrative, and recommendations. For the complete template, see [references/output-format.md](references/output-format.md).

### 3.2 Summary index

Write `{OUTPUT_DIR}/index.md` with cross-project summary table. For the template, see [references/output-format.md](references/output-format.md).

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

### Event emission

After the report summary, emit a completion event to stark-insights:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-session-insights duration_s=$TOTAL_SECONDS success=$SUCCESS \
  projects_processed=$N total_entries=$ENTRIES
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.

## Edge Cases & Limitations

For edge case handling (empty files, malformed JSON, single-prompt projects) and scope limitations, see [references/edge-cases.md](references/edge-cases.md).
