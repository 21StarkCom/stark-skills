---
name: stark-skill-analytics
description: >-
  Skill usage and adoption metrics across sessions: rankings, quality signals, recommendations. Use for skill analytics.
argument-hint: "[--skill <name>] [--format table|full]"
disable-model-invocation: true
model: haiku
allowed-tools: Read, Grep, Glob, Bash, Write
---

# stark-skill-analytics

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Cross-references invocation history from `~/.claude/history.jsonl` with run quality data from `~/.claude/code-review/history/` to produce a comprehensive analytics report.

This skill focuses on **skill usage patterns** — which skills are invoked, how often, by which projects, and with what quality. For agent-level performance metrics (findings, FP rates, prompt tuning), use `/stark-metrics` instead.

## Arguments

- `[--skill <name>]` — detailed report for a single skill (e.g., `--skill stark-team-review`)
- `[--format table|full]` — `table` = summary rankings only, `full` = detailed per-skill breakdown (default: `full`)
- No arguments = full report across all skills

**Raw input:** `$ARGUMENTS`

## Constants

```
HISTORY_JSONL = ~/.claude/history.jsonl
HISTORY_DIR   = ~/.claude/code-review/history
INSIGHTS_DIR  = ~/.claude/code-review/insights/skills
BENCHMARK     = ~/.claude/code-review/scripts/benchmarks/codex_benchmark_results.json
CLAUDE_MD     = the CLAUDE.md in the current repo (for registered skills list)
```

## Phase 1: Collect Usage Data from history.jsonl

### 1.1 Read and parse history.jsonl

Read `~/.claude/history.jsonl`. Each line is a JSON object with at minimum:
- `display` — the prompt text
- `timestamp` — millisecond epoch
- `project` — absolute path to the project
- `sessionId` — session identifier

If the file doesn't exist or is empty, error: "No history.jsonl found at ~/.claude/history.jsonl. Claude Code session history is required."

Parse all lines. Skip malformed JSON lines with a warning count.

### 1.2 Extract skill invocations

Filter entries where `display` starts with `/` (a slash command). For each:

- Extract the skill name: the first whitespace-delimited token after `/`. E.g., `/stark-team-review 42` → `stark-team-review`, `/stark-review-plan docs/spec.md` → `stark-review-plan`.
- Extract arguments: everything after the skill name (may be empty).
- Classify as:
  - **quick** — no arguments (standalone `/skill-name`)
  - **parameterized** — has arguments

Store each invocation as:
```json
{
  "skill": "stark-team-review",
  "args": "42",
  "type": "parameterized",
  "timestamp": 1742500000000,
  "project": "/Users/aryeh/git/Evinced/widget-system",
  "sessionId": "abc123"
}
```

### 1.3 Compute per-skill usage stats

For each unique skill name, compute:
- **invocation_count** — total invocations
- **projects** — set of unique project paths
- **first_used** — earliest timestamp (format as YYYY-MM-DD)
- **last_used** — latest timestamp (format as YYYY-MM-DD)
- **quick_count** — invocations without arguments
- **parameterized_count** — invocations with arguments
- **trend** — compare last 30 days vs prior 30 days: "rising", "stable", "declining", or "new" (if all invocations within last 30 days)

### 1.4 Detect skill sequences

Group invocations by `sessionId`. Within each session, sort by timestamp. Identify consecutive skill pairs (skill A followed by skill B within the same session). Count pair frequencies.

Report the top 10 most common sequences.

## Phase 2: Collect Quality Data from History Files

Scan `~/.claude/code-review/history/` for run history JSON files. Parse per-skill quality stats (runs, durations, success rates), review-specific metrics (agent success, timeouts, findings), and codex benchmark data. For detailed field specs, see [references/quality-metrics.md](references/quality-metrics.md).

## Phase 3: Cross-Reference and Analyze

### 3.1 Discover unregistered skills

Read the CLAUDE.md in the current repo (or `~/.claude/code-review/` fallback). Extract the list of registered skill names from the Skills section (lines matching `- /skill-name`).

Compare against skills found in Phase 1.2 (actually invoked). Report:
- **Used but unregistered** — skills invoked in history.jsonl but not in CLAUDE.md
- **Registered but never invoked** — skills listed in CLAUDE.md but never seen in history.jsonl

### 3.2 Project affinity

For each project path, list which skills it uses and how often. Identify:
- Projects that use only a subset of available skills
- Projects with heavy skill usage vs light usage

### 3.3 Adoption timeline

Sort skills by their `first_used` date. Show when each skill was first adopted and its growth trajectory.

### 3.4 Quality signals

Cross-reference usage (Phase 1) with quality (Phase 2):
- Skills with high timeout rates (> 20%)
- Skills with high failure rates (> 10%)
- Skills that produce empty results frequently
- Skills whose quality has degraded over time (compare recent vs historical)

### 3.5 Generate recommendations

Based on the analysis, produce actionable recommendations:
- **Remove:** Dead skills (registered but never invoked in 60+ days)
- **Promote:** Underused skills that have good quality metrics
- **Fix:** Skills with high error/timeout rates
- **Investigate:** Skills used heavily but with no quality data (no history files)
- **Sequence:** Common sequences that could be combined into a workflow skill

## Phase 4: Generate Report

### 4.1 Create output directory

```bash
mkdir -p ~/.claude/code-review/insights/skills
```

### 4.2 Generate report content

If `--skill <name>` was provided, generate a single-skill deep-dive report. Otherwise, generate the full report.

If `--format table` was provided, output only the Usage Rankings table and skip per-skill details.

#### Full report format

Save to `~/.claude/code-review/insights/skills/skill-analytics.md`. Includes: usage rankings, adoption timeline, per-skill details, quality signals, skill sequences, discovery, project affinity, and recommendations. For the complete template, see [references/report-format.md](references/report-format.md).

#### Single-skill report format

Save to `~/.claude/code-review/insights/skills/skill-analytics-{name}.md`. Includes: usage stats, usage over time, quality data, common sequences, and argument analysis. For the template, see [references/report-format.md](references/report-format.md).

### 4.3 Print report to terminal

After saving, print the full report content to the terminal.

## Observability & Operations

For log line templates, metrics block format, implementation notes, failure modes (7 scenarios), and scope limitations, see [references/observability.md](references/observability.md).
