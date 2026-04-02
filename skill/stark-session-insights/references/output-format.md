# Output Format

Complete markdown templates for Phase 3 output files. Referenced from [../SKILL.md](../SKILL.md).

## Per-project file

Write `{OUTPUT_DIR}/{slug}.md` with the following template:

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

## Weekly Trends

{table from 2.10: Week, Prompts, Trend}

## Day of Week

{table from 2.9: Day, Count, %}

## Skill Evolution

{from 2.11 — migration patterns, new/disappeared skills. Omit if < 2 weeks of data}

## Session Behavior

### How Sessions Start
{top 5 first-prompt patterns from 2.12}

### How Sessions End
{top 5 last-prompt patterns from 2.12}

### Session Types
{table from 2.12: Type, Count, %}

## Corrections & Preferences

These represent moments where the user corrected course — the most valuable signals for understanding working style.

### By Category
{category summary from 2.13: category, count, top themes}

### Details
| Date | Prompt |
|------|--------|
{rows from 2.7, date as YYYY-MM-DD HH:MM}

## Key Requirements

Long prompts (>200 chars) that represent detailed specifications or decisions.

{numbered list from 2.8, each as a blockquote with date prefix}

## Narrative

{3-5 paragraph prose synthesis from 2.14 — the "so what?" interpretation of all data above}

## Recommendations

{3-5 actionable recommendations from 2.15, each tied to a specific data point}
```

## Summary index

Write `{OUTPUT_DIR}/index.md` with the following template:

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
