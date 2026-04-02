# Dashboard Format — stark-phase-execute

## Task Summary Table

```
┌─────┬────────┬──────────────────────────────────┬────────┬─────────┬──────────┬───────┬────────┐
│  #  │ Issue  │ Title                            │ PR     │ Status  │ Duration │ Finds │ Fixed  │
├─────┼────────┼──────────────────────────────────┼────────┼─────────┼──────────┼───────┼────────┤
│  1  │ #42    │ Add retry logic to API client     │ #57    │ merged  │ 5m 42s   │ 8     │ 6/8    │
│  2  │ #43    │ Instrument request tracing        │ #58    │ merged  │ 8m 15s   │ 12    │ 10/12  │
│  3  │ #44    │ Add health check endpoint         │ #59    │ failed  │ 3m 20s   │ —     │ —      │
└─────┴────────┴──────────────────────────────────┴────────┴─────────┴──────────┴───────┴────────┘
```

## Aggregate Stats

```
Phase: {SLUG}
Duration: {total}
Tasks: {completed}/{total} ({failed} failed, {skipped} skipped)
PRs merged: {N}
Review findings: {total} ({critical} crit, {high} high, {medium} med, {low} low)
Fix rate: {fixed}/{actionable} ({pct}%)
Noise rate: {noise}/{total} ({pct}%)
Regression: {passed}/{total} tests passing
Release: v{version} ({bump_level})
Deploy: {status}
```

## Agent Scorecard

```
┌─────────┬──────────┬───────┬───────┬─────────┬───────────┐
│ Agent   │ Findings │ Fixed │ Noise │ Unique  │ Accuracy  │
├─────────┼──────────┼───────┼───────┼─────────┼───────────┤
│ Claude  │ 15       │ 12    │ 3     │ 5       │ 80%       │
│ Codex   │ 12       │ 10    │ 2     │ 3       │ 83%       │
│ Gemini  │ 11       │ 9     │ 2     │ 4       │ 82%       │
└─────────┴──────────┴───────┴───────┴─────────┴───────────┘
```

## Failed Tasks

For each failed task: error message, which step failed, suggested recovery action.
