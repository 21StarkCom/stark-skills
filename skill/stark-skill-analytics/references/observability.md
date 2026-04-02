# Observability & Operations

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
