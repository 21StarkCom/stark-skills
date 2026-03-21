---
name: stark-metrics
description: >
  Aggregate performance metrics across all stark skill runs. Agent scorecards,
  finding quality, duration trends, prompt improvement impact, and actionable
  recommendations. Use when the user says "show metrics", "how are reviews
  performing", "agent stats", "review quality", or invokes /stark-metrics.
argument-hint: "[--repo REPO] [--skill SKILL] [--since DATE] [--json]"
---

# stark-metrics

Cross-run performance metrics for all stark skills. Reads history from `~/.claude/code-review/history/`, normalizes multiple data formats, and produces an operator's tuning report.

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Run the Script

```bash
$PYTHON $SCRIPTS/metrics.py $ARGUMENTS
```

Pass through any user-provided flags (`--repo`, `--skill`, `--since`, `--json`).

If the script exits non-zero:
- Exit 1: no history data — tell the user to run `/stark-review` first
- Exit 2: argument error — show usage

## Phase 2: Present Results

Print the script output directly — it's already formatted for the terminal.

If running without `--json`, highlight the **Recommendations** section. If there are actionable items, ask:

```
N recommendations found. Want to act on any of them?
  1. [recommendation text] → run /stark-review-improvement
  2. [recommendation text] → edit config
  ...
```

If the user picks one, invoke the relevant skill or make the config change.

## Phase 3: Improvement Flags

After presenting the report, check for meta-observations:

- If this is the first time metrics have been run, note: "Tip: run /stark-metrics periodically to track trends."
- If the report shows improvement since the last prompt change (lower FP rate), flag it as a win.
- If agent failure rates are climbing, flag it as urgent.

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Records loaded: count by skill type
- Filters applied: repo, skill, date
- Report sections generated
- Recommendations count

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No history directory | "No history found. Run /stark-review to generate data." |
| No matching records | "No records match filters. Try broader criteria." |
| Corrupt JSON in history | Script warns on stderr, skips file, continues |
| Script not found | "Run install.sh to set up stark-skills" |
