---
name: stark-pr-status
description: >-
  PR analytics dashboard: review rounds, findings, time-to-merge, signal-vs-noise. Use for PR status, PR stats, dashboard.
argument-hint: "[PR_NUMBER | --all] [--repo REPO] [--state STATE] [--json]"
disable-model-invocation: true
model: haiku
allowed-tools: Read, Grep, Glob, Bash, Write
---

# stark-pr-status

PR-level analytics dashboard. Pulls data from GitHub API + stark-team-review history
to show the full lifecycle of a PR: reviews, findings, participants, and outcomes.

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Run the Script

```bash
$PYTHON $SCRIPTS/pr_status.py $ARGUMENTS
```

Default (no arguments): all PRs in the current repo across all states.
With a number: single PR dashboard with full detail.

Flags:
- `--pr N` or positional number: single PR
- `--all`: all PRs (default when no number given)
- `--repo org/name`: override repo detection
- `--state open|closed|merged|all`: filter by PR state (default: all)
- `--json`: machine-readable output
- `--limit N`: max PRs to show (default: 20)

If the script exits non-zero:
- Exit 1: no repo detected — tell user to run from a git repo or use `--repo`
- Exit 2: PR not found
- Exit 3: GitHub API error

## Phase 2: Present Results

Print the script output directly — it's pre-formatted for the terminal.

For single-PR mode, the output includes:
- Header: PR title, status, author, dates, time-to-merge
- Review rounds: count, findings per round, improvement delta
- Findings breakdown: by severity, by outcome (fix/noise/FP/ignored)
- Participants: humans + bots with action counts
- Signal analysis: most impactful finding, biggest noise source
- Timeline: key events in chronological order

For all-PRs mode, the output is a summary table with per-PR stats.

## Phase 3: Actionable Suggestions

After presenting, check for patterns:
- PRs open > 7 days with no reviews → suggest `/stark-team-review`
- PRs with high noise ratio → suggest `/stark-review-improvement`
- PRs ready to merge (approved, CI green) → suggest `/stark-pr-flow`

## Observability

Standard observability: record metrics block (PRs analyzed, GitHub API calls, history records loaded, data sources). See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No repo detected | "Run from a git repo or use --repo org/name" |
| PR not found | "PR #N not found in {repo}" |
| GitHub API auth failure | "Run install.sh or check GitHub App credentials" |
| No history for PR | Show GitHub data only, note "No stark-team-review history" |
| Rate limited | "GitHub API rate limited. Try again in a few minutes." |
