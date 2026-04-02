# Report Format Templates

## Full report format

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

## Single-skill report format

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
