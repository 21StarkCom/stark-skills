# stark-metrics — Design Spec

**Date:** 2026-03-20
**Status:** Approved
**Goal:** Cross-run metrics aggregation for all stark skills. Operator's tuning dashboard — identify what to fix next.

## Architecture

Two components:

1. **`scripts/metrics.py`** — Python script. Reads all history files, normalizes into unified RunRecords, computes aggregates, outputs human-readable or JSON report. No new dependencies (stdlib only). Runnable outside Claude.

2. **`skill/stark-metrics/SKILL.md`** — Skill wrapper. Calls the script, formats output for terminal. Follows observability protocol.

## Unified RunRecord Schema

Every skill run (past and future) normalizes to this structure:

```python
@dataclass
class PhaseRecord:
    name: str
    duration_s: float
    status: str               # "completed" | "failed" | "skipped"

@dataclass
class AgentResult:
    agent: str                # "claude" | "codex" | "gemini"
    domain: str               # "architecture", "security", etc.
    duration_s: float
    findings_count: int
    error: str | None         # "cli_error" | "empty_output" | "timeout" | None

@dataclass
class AgentSummary:
    dispatched: int
    succeeded: int
    failed: int
    results: list[AgentResult]

@dataclass
class FindingSummary:
    total_raw: int
    deduplicated: int
    by_outcome: dict[str, int]   # fix, noise, false_positive, ignored, recurring
    by_severity: dict[str, int]  # critical, high, medium, low

@dataclass
class RunRecord:
    # Identity
    skill: str                   # "stark-review", "stark-review-plan", etc.
    started_at: str              # ISO 8601 (or file mtime for legacy data)
    completed_at: str | None
    duration_s: float
    outcome: str                 # "success" | "failure" | "partial" | "aborted"

    # Context
    repo: str | None             # "GetEvinced/repo-name"
    ref: str | None              # PR number, plan path, branch, version tag
    mode: str | None             # "review-only", "full", "start", "end", etc.

    # Phases
    phases: list[PhaseRecord]

    # Agents (review skills only)
    agents: AgentSummary | None

    # Findings (review skills only)
    findings: FindingSummary | None

    # Skill-specific metrics
    metrics: dict                # freeform KPIs per skill type

    # Issues encountered
    errors: list[str]
```

### Legacy Normalization

Existing history has 4 JSON variants. The script detects format by field presence:

| Format | Detection | Fields Present |
|--------|-----------|----------------|
| A: Detailed Review | `findings.total_raw` + `issues[]` | Full findings + deduplicated issue list |
| B: Agent Results | `rounds[].results[].duration_s` | Per agent×domain results with timing |
| C: Summary | `rounds[].classifications` + `rounds[].agents` | Per-agent finding counts, no individual results |
| D: Minimal | `total_raw_findings` (top-level) | Counts only, no structure |

All normalize to RunRecord. Missing fields get defaults:
- No timing → `duration_s = 0`, empty phases
- No agent results → `agents = None`
- No findings breakdown → reconstruct from available counts
- No date → use file mtime

## Report Sections

### 1. Overview

```
Stark Metrics Report — 2026-03-20
──────────────────────────────────
Total runs:     24 (14 PR reviews, 10 plan reviews)
Date range:     2026-03-15 → 2026-03-20
Repos covered:  6
Skills used:    stark-review, stark-review-plan
```

### 2. Agent Scorecards

Per-agent (claude, codex, gemini) across all review runs:
- Total dispatches, succeeded, failed, timed out
- Average duration per dispatch
- Average findings per dispatch
- Failure breakdown by error type

Flag: agent failure rate > 20%.

### 3. Finding Quality

- Total raw → deduplicated → by outcome (fix, noise, FP, ignored)
- Signal-to-noise ratio: `fix / total_deduped`
- Cross-agent agreement: % of fix findings flagged by 2+ agents
- Worst false positive sources: agent×domain combos with highest FP count

Flag: signal-to-noise < 30%.

### 4. Duration Trends

- Median, P90, min, max duration
- By phase (median): setup, dispatch, classify+fix, summary
- Dispatch as % of total (bottleneck detection)

Flag: dispatch > 70% of total time.

### 5. Prompt Improvement Impact

- Assessments generated vs applied
- Before/after false positive rates (when measurable)
- Unapplied assessments (actionable)

Flag: unapplied assessments exist.

### 6. Per-Repo Breakdown

- Runs per repo
- Finding rate per repo (findings/run)
- Disabled domains per repo (from config)

### 7. Recommendations

Actionable list derived from flags:
- Timeout/failure patterns → specific CLI/auth fixes
- High FP domains → candidates for `disabled_domains` or prompt tuning
- Zero-finding domains → candidates for removal
- Unapplied assessments → run `/stark-review-improvement`
- Duration regressions → investigate specific phase

## CLI Interface

```bash
PYTHON=~/.claude/code-review/scripts/.venv/bin/python3
SCRIPTS=~/.claude/code-review/scripts

# Full report (human-readable)
$PYTHON $SCRIPTS/metrics.py

# JSON output
$PYTHON $SCRIPTS/metrics.py --json

# Filter by repo
$PYTHON $SCRIPTS/metrics.py --repo GetEvinced/infra-pulse

# Filter by skill type
$PYTHON $SCRIPTS/metrics.py --skill stark-review

# Filter by date range
$PYTHON $SCRIPTS/metrics.py --since 2026-03-15

# Combine filters
$PYTHON $SCRIPTS/metrics.py --repo GetEvinced/infra-pulse --since 2026-03-18 --json
```

Exit codes: 0 = success, 1 = no history data found, 2 = argument error.

## Skill Definition

```yaml
name: stark-metrics
description: >
  Aggregate performance metrics across all stark skill runs. Agent scorecards,
  finding quality, duration trends, prompt improvement impact, and actionable
  recommendations. Use when the user says "show metrics", "how are reviews
  performing", "agent stats", "review quality", or invokes /stark-metrics.
argument-hint: "[--repo REPO] [--skill SKILL] [--since DATE] [--json]"
```

The skill:
1. Calls `$PYTHON $SCRIPTS/metrics.py` with any user-provided filters
2. Formats the output for the terminal
3. Follows the observability protocol (timestamps, task UI)
4. Highlights recommendations that need action

## History Directory

All data reads from `~/.claude/code-review/history/`. Structure:

```
history/
├── GetEvinced/           # PR reviews
│   ├── repo-name/
│   │   └── PR_NUMBER/
│   │       ├── rounds.json
│   │       ├── summary.md
│   │       └── prompt-assessment.md
├── plan-reviews/         # Plan reviews
│   └── plan-name/
│       ├── rounds.json
│       └── summary.md
└── runs/                 # Future: all skill RunRecords
    └── YYYY-MM-DD-HH-MM-SS-skill-name.json
```

The `runs/` directory is new — future skill runs write their RunRecord here. The script reads both legacy locations and `runs/`.

## Non-Goals

- No web dashboard (terminal-only for now)
- No real-time monitoring (on-demand reports only)
- No modification of history data (read-only)
- No cross-machine aggregation (local history only)
