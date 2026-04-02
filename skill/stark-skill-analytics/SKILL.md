---
name: stark-skill-analytics
description: >
  Analyze skill usage patterns and quality metrics across all Claude Code
  sessions. Reads ~/.claude/history.jsonl and skill run history files to
  produce adoption curves, usage rankings, quality signals, and
  recommendations. Use when the user says "skill analytics", "skill usage",
  "which skills are used", "adoption metrics", or invokes /stark-skill-analytics.
argument-hint: "[--skill <name>] [--format table|full]"
---

# stark-skill-analytics

Analyze skill usage patterns and quality metrics across all Claude Code sessions. Cross-references invocation history from `~/.claude/history.jsonl` with run quality data from `~/.claude/code-review/history/` to produce a comprehensive analytics report.

This skill focuses on **skill usage patterns** — which skills are invoked, how often, by which projects, and with what quality. For agent-level performance metrics (findings, FP rates, prompt tuning), use `/stark-metrics` instead.

## Arguments

- `[--skill <name>]` — detailed report for a single skill (e.g., `--skill stark-team-review`)
- `[--format table|full]` — `table` = summary rankings only, `full` = detailed per-skill breakdown (default: `full`)
- No arguments = full report across all skills

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

### 2.1 Scan history directory

List all subdirectories of `~/.claude/code-review/history/`. Each subdirectory represents a skill type (e.g., `extract-docs/`, `plan-to-tasks/`, `reviews/`).

For each subdirectory, recursively find all `.json` files.

If `~/.claude/code-review/history/` doesn't exist or is empty, log: "No run history found. Quality metrics will be unavailable." and skip to Phase 3.

### 2.2 Parse run history files

For each JSON history file, extract (fields may vary by skill type):
- `completed_at` or `timestamp` — when the run completed
- `timing` — phase-level duration data (total duration, per-phase breakdowns)
- `status` or infer from content — success/failure
- Output counts (varies by skill):
  - For `extract-docs`: `extractions` counts, `outputs` counts
  - For `plan-to-tasks`: issues created, phases
  - For `reviews`: agent results, findings counts, timeouts

Skip files that fail JSON parsing (log warning count).

### 2.3 Compute per-skill quality stats

For each skill type found in history:
- **runs_count** — total history files
- **avg_duration** — mean total duration in seconds
- **success_rate** — percentage of runs that completed successfully
- **failure_count** — runs that errored
- **output_summary** — skill-specific output averages (e.g., "avg 12 extractions per run" for extract-docs)

### 2.4 Review-specific metrics

For review history files specifically (if `reviews/` subdirectory exists):
- **agent_success_rate** — per agent (claude, codex, gemini): percentage of sub-reviews that completed
- **timeout_rate** — per agent: percentage that timed out
- **avg_findings** — average findings per review round
- **domain_coverage** — which domains are reviewed most/least

### 2.5 Codex benchmark data

If `~/.claude/code-review/scripts/benchmarks/codex_benchmark_results.json` exists, read it and extract:
- Benchmark dates
- Pass/fail rates
- Performance trends

If it doesn't exist, skip silently.

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

Save to `~/.claude/code-review/insights/skills/skill-analytics.md`:

```markdown
# Skill Analytics Report

**Generated:** {YYYY-MM-DD HH:MM}
**Data range:** {first invocation date} to {last invocation date}
**Total skill invocations:** {N}
**Unique skills:** {N}
**Sessions analyzed:** {N}

## Usage Rankings

| Rank | Skill | Invocations | Projects | First Used | Last Used | Trend |
|------|-------|-------------|----------|------------|-----------|-------|
| 1 | /stark-team-review | 142 | 8 | 2025-11-01 | 2026-03-21 | stable |
| ... | ... | ... | ... | ... | ... | ... |

## Skill Adoption Timeline

{Chronological list of when each skill was first used, grouped by month}

### {YYYY-MM}
- /skill-name — first used {date}, now at {N} invocations

## Per-Skill Details

### /stark-team-review
- **Invocations:** {N} ({quick}% quick, {param}% parameterized)
- **Projects:** {list}
- **Run history:** {N} runs, avg {duration}s, {success_rate}% success
- **Agent success rates:** claude {N}%, codex {N}%, gemini {N}%
- **Timeout rate:** {N}% (claude {N}%, codex {N}%, gemini {N}%)
- **Avg findings per round:** {N}

### /stark-extract-docs
- **Invocations:** {N}
- **Projects:** {list}
- **Run history:** {N} runs, avg {duration}s
- **Avg extractions per run:** {N}
- **Output breakdown:** {N} ADRs, {N} retros, {N} glossary entries

{repeat for each skill}

## Quality Signals

### Timeout Rates
| Skill | Overall | Claude | Codex | Gemini |
|-------|---------|--------|-------|--------|
{only for skills with agent data}

### Error Rates
| Skill | Runs | Failures | Rate |
|-------|------|----------|------|

### Empty Results
| Skill | Runs | Empty | Rate |
|-------|------|-------|------|

## Skill Sequences

Most common skill sequences within sessions:

| Sequence | Count | Example Session |
|----------|-------|-----------------|
| /stark-team-review -> /stark-review-improvement | 12 | {sessionId} |
| ... | ... | ... |

## Discovery

### Used But Unregistered
{skills found in history.jsonl but not in CLAUDE.md}

### Registered But Never Invoked
{skills in CLAUDE.md but never seen in history.jsonl}

## Project Affinity

| Project | Skills Used | Total Invocations | Most Used |
|---------|-------------|-------------------|-----------|

## Recommendations

{numbered list of actionable recommendations with rationale}

1. **Remove /skill-name** — registered but not invoked in {N} days
2. **Fix /skill-name** — {N}% timeout rate, investigate agent failures
3. **Promote /skill-name** — used by {N} projects with {N}% success, but only {N} invocations
4. **Combine /skill-a + /skill-b** — invoked together in {N}% of sessions
```

#### Single-skill report format

When `--skill <name>` is provided, save to `~/.claude/code-review/insights/skills/skill-analytics-{name}.md`:

```markdown
# Skill Analytics: /{name}

**Generated:** {date}
**Data range:** {first} to {last}

## Usage
- Total invocations: {N}
- Quick: {N} | Parameterized: {N}
- Projects: {list with per-project counts}
- Trend: {rising|stable|declining|new}

## Usage Over Time
| Month | Invocations | Projects |
|-------|-------------|----------|

## Quality
{run history stats if available, or "No run history data available"}

## Common Sequences
{sequences involving this skill}

## Arguments Analysis
{most common argument patterns}
```

### 4.3 Print report to terminal

After saving, print the full report content to the terminal.

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md).

**Timestamped log lines:** `[HH:MM:SS]` for each phase start/end and key events.

```
[HH:MM:SS] Phase 1: Parsing history.jsonl...
[HH:MM:SS] Phase 1: Found {N} entries, {M} skill invocations, {K} malformed lines skipped
[HH:MM:SS] Phase 2: Scanning history directory...
[HH:MM:SS] Phase 2: Found {N} history files across {M} skill types
[HH:MM:SS] Phase 3: Cross-referencing usage and quality data...
[HH:MM:SS] Phase 4: Generating report...
[HH:MM:SS] Report saved to {path}
```

**Metrics block at end:**

```
Metrics
-------
Total duration:     Xm Ys
History entries:    {N}
Skill invocations:  {N}
History files:      {N}
Report sections:    {N}
Recommendations:    {N}
```

## Implementation Notes

- Use inline Python via bash for JSON parsing and data aggregation. Do NOT create standalone Python scripts.
- For large history.jsonl files, process line-by-line (streaming), don't load entire file into memory at once.
- All date formatting uses YYYY-MM-DD.
- Project paths should be shortened for display: strip common prefix, show `org/repo` where possible.
- Trend calculation: compare invocation count in [now-30d, now] vs [now-60d, now-30d]. Rising = >20% increase, declining = >20% decrease, stable = within 20%, new = all within last 30 days.

## Failure Modes

| Failure | Recovery |
|---------|----------|
| history.jsonl doesn't exist | Error message, abort |
| history.jsonl is empty | Error: "No session history found" |
| No skill invocations found | Report with "No skill invocations found in history" |
| History dir doesn't exist | Skip quality metrics, report usage only |
| Corrupt JSON in history files | Skip file, increment warning count, continue |
| --skill name not found | "Skill '{name}' not found in history. Available: {list}" |
| Insights dir not writable | Print report to terminal only, warn about save failure |

## What This Skill Does NOT Do

- Modify any history files or skill configurations
- Execute or invoke other skills
- Access GitHub or any external APIs
- Analyze prompt content or review findings (that's `/stark-metrics`)
- Track non-skill Claude Code usage (only slash-command invocations)
