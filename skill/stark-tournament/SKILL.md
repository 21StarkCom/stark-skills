---
name: stark-tournament
description: >-
  Run multi-LLM tournaments: N competitors, judged evaluation, winner declared. Use for tournament, compare LLMs.
argument-hint: '"prompt" | --config tournament.yaml [--strategy semantic|visual|test] [--competitors claude,codex,gemini] [--factors correctness=2.0 quality=1.0] [--judge MODEL] [--timeout N] [--json]'
disable-model-invocation: true
model: opus
---

# stark-tournament

Run N LLM competitors on the same task, evaluate outputs with a judge, pick a winner. Supports semantic, visual, and test-based evaluation strategies.

## Arguments

- `"prompt"` — inline prompt text (positional, quoted)
- `--config PATH` — YAML config file (alternative to inline prompt)
- `--strategy semantic|visual|test` — evaluation strategy (default: semantic)
- `--competitors IDS` — comma-separated competitor IDs (default: claude,codex,gemini)
- `--factors KEY=WEIGHT ...` — evaluation factors as key=weight pairs (e.g., `correctness=2.0 quality=1.0`)
- `--judge MODEL` — judge model name (default: claude-sonnet-4-6)
- `--test-file PATH` — test file path (required for test strategy)
- `--output-dir DIR` — directory for output files
- `--timeout N` — timeout in seconds per competitor (default: 300)
- `--variables KEY=VALUE ...` — key=value pairs for prompt template substitution
- `--keep-all` — keep all competitor outputs, not just winner
- `--json` — output TournamentResult as JSON
- `--dry-run` — print config and exit without running

If neither `"prompt"` nor `--config` is provided, ask the user what they want to compete on.

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS_ROOT = ~/.claude/code-review
SCRIPTS      = $SCRIPTS_ROOT/scripts
PYTHON       = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Parse & Validate

Parse arguments from the user's invocation.

If `--config` is provided, validate the file exists and is readable YAML.

If an inline prompt is provided, pass it via `--prompt`.

Show competition setup before dispatching:

```
Tournament Setup
────────────────
Competitors:  claude, codex, gemini
Strategy:     semantic
Factors:      correctness (×2.0), completeness (×1.0), quality (×1.0)
Judge:        claude-sonnet-4-6
Timeout:      300s
```

If `--dry-run`, stop here.

## Phase 2: Dispatch

```bash
$PYTHON $SCRIPTS/tournament.py [args]
```

Pass through all user-provided flags directly. The script handles parallel dispatch, evaluation, and winner selection.

If `--json` was passed, capture the JSON output for Phase 3 parsing.

If `--json` was NOT passed, the script produces human-readable output — print it directly and skip to Phase 4.

## Phase 3: Display Results

Parse the JSON output and display a formatted results table:

```
Tournament: 3 competitors × semantic evaluation
  ┌──────────┬─────────────┬──────────────┬─────────┬─────────┐
  │ Competitor│ Correctness │ Completeness │ Quality │ Avg     │
  ├──────────┼─────────────┼──────────────┼─────────┼─────────┤
  │ claude   │ 9           │ 8            │ 8       │ 8.5 ★   │
  │ codex    │ 8           │ 9            │ 7       │ 8.1     │
  │ gemini   │ 7           │ 7            │ 9       │ 7.5     │
  └──────────┴─────────────┴──────────────┴─────────┴─────────┘
  Winner: claude (8.5/10) · Quality: good
```

Quality flags based on winning score:
- 9.0+ → `excellent`
- 7.0+ → `good`
- 5.0+ → `acceptable`
- <5.0 → `poor`

Sort competitors by weighted average descending. Mark the winner with a star.

## Phase 4: Report Audit Location

The tournament script writes a JSONL audit record. Report its location:

```
Audit: ~/.claude/code-review/history/tournaments/YYYY-MM-DD-HHMMSS.jsonl
```

If `--keep-all` was used, also note the output directory containing all competitor artifacts.

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- Competitors dispatched / succeeded / failed
- Evaluation strategy and factor count
- Winner ID and score
- Total duration

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No prompt and no config | Ask user: "What should the competitors work on?" |
| Config file not found | "Config file not found: {path}" |
| Invalid YAML in config | "Failed to parse config: {error}" |
| Single competitor fails | Disqualify that competitor, continue with remaining |
| All competitors fail | Error: "All competitors failed. Check timeout (--timeout) and competitor IDs (--competitors)." |
| Judge fails | Use first valid competitor output as fallback, set `eval_failed: true` in audit |
| Script not found | "Run install.sh to set up stark-skills" |
| Timeout exceeded | Disqualify timed-out competitor, continue with completed outputs |
