# Quality Metrics — Data Collection Specs

## 2.1 Scan history directory

List all subdirectories of `~/.claude/code-review/history/`. Each subdirectory represents a skill type (e.g., `extract-docs/`, `plan-to-tasks/`, `reviews/`).

For each subdirectory, recursively find all `.json` files.

If `~/.claude/code-review/history/` doesn't exist or is empty, log: "No run history found. Quality metrics will be unavailable." and skip to Phase 3.

## 2.2 Parse run history files

For each JSON history file, extract (fields may vary by skill type):
- `completed_at` or `timestamp` — when the run completed
- `timing` — phase-level duration data (total duration, per-phase breakdowns)
- `status` or infer from content — success/failure
- Output counts (varies by skill):
  - For `extract-docs`: `extractions` counts, `outputs` counts
  - For `plan-to-tasks`: issues created, phases
  - For `reviews`: agent results, findings counts, timeouts

Skip files that fail JSON parsing (log warning count).

## 2.3 Compute per-skill quality stats

For each skill type found in history:
- **runs_count** — total history files
- **avg_duration** — mean total duration in seconds
- **success_rate** — percentage of runs that completed successfully
- **failure_count** — runs that errored
- **output_summary** — skill-specific output averages (e.g., "avg 12 extractions per run" for extract-docs)

## 2.4 Review-specific metrics

For review history files specifically (if `reviews/` subdirectory exists):
- **agent_success_rate** — per agent (claude, codex, gemini): percentage of sub-reviews that completed
- **timeout_rate** — per agent: percentage that timed out
- **avg_findings** — average findings per review round
- **domain_coverage** — which domains are reviewed most/least

## 2.5 Codex benchmark data

If `~/.claude/code-review/scripts/benchmarks/codex_benchmark_results.json` exists, read it and extract:
- Benchmark dates
- Pass/fail rates
- Performance trends

If it doesn't exist, skip silently.
