---
name: stark-forged-review
description: >-
  Multi-agent PR review with leader + second-opinion per domain, dynamic triage, and forge-style escalation on non-trivial findings. Replaces stark-review.
argument-hint: "[PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]"
disable-model-invocation: true
model: opus[1m]
---

See `README.md` for the full behavioral reference, pipeline diagram, and observability details.

## Preflight

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json
```

- `overall: blocked` — print failing checks and stop.
- `overall: degraded` — warn and continue.
- `overall: ready` — continue silently.

## Arguments

Raw input: `$ARGUMENTS`

- `PR_NUMBER` — optional; auto-detected from current branch if omitted
- `--dry-run` — review only, no commits/pushes/merge
- `--repo ORG/REPO` — override repo detection
- `--resume` — resume from an existing `.forged-review-state.json`
- `--no-escalate` — forbid the forge path
- `--force-escalate` — always take the forge path

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Run

```bash
$PYTHON $SCRIPTS/forged_review.py $ARGUMENTS
```

Orchestrator prints one JSON object to stdout, progress to stderr.

## Handle stdout JSON

Shape: `{status, pr_number, repo, needs_merge_confirmation, message, summary}`. `status` is `clean | dry_run_complete | awaiting_fixes`. All three still emit JSON on stdout — `awaiting_fixes` exits with code 1 but the JSON is valid, so always read stdout before reacting to the exit code. Only codes 2/3 (dispatch / invalid input) skip JSON entirely.

- **`clean` + `needs_merge_confirmation: true`** — print summary, ask `Clean. Merge PR #<pr_number>? [Y/n]`. On yes/empty:

  ```bash
  unset GH_TOKEN && gh pr merge <pr_number> --squash --delete-branch --repo <repo>
  ```

  On no, print `PR left open at user request` and exit 0.
- **`clean` + `needs_merge_confirmation: false`** — print summary, exit 0.
- **`awaiting_fixes`** — print message + findings; do NOT merge; exit with orchestrator's code.
- **`dry_run_complete`** — print summary, exit 0.
- anything else — print summary, exit with orchestrator's code.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean / dry-run complete |
| 1 | Halted / awaiting fixes |
| 2 | Dispatch failure |
| 3 | Invalid input |
