---
name: stark-forged-review
description: >-
  Multi-agent PR review with leader + second-opinion per domain, dynamic triage, and forge-style escalation on non-trivial findings. Replaces stark-review.
argument-hint: "[PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]"
disable-model-invocation: true
model: opus[1m]
---

See [README.md](README.md) for the full behavioral reference, pipeline diagram, and observability details.

## Preflight

Run:

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json
```

Parse the JSON result:
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

Invoke the orchestrator:

```bash
$PYTHON $SCRIPTS/forged_review.py $ARGUMENTS
```

It prints a single JSON object to stdout and progress to stderr. Capture the stdout JSON and the exit code.

## Handle stdout JSON

Expected shape:

```text
{status, pr_number, repo, needs_merge_confirmation, message, summary}
```

`status` is one of `clean | dry_run_complete | awaiting_fixes | failed`.

- **`clean` + `needs_merge_confirmation: true`**
  1. Print the summary.
  2. Ask `Clean. Merge PR #<pr_number>? [Y/n]`
  3. On yes/empty, run:

     ```bash
     unset GH_TOKEN && gh pr merge <pr_number> --squash --delete-branch --repo <repo>
     ```

  4. On no, print `PR left open at user request` and exit 0.
- **`clean` + `needs_merge_confirmation: false`** — print the summary and exit 0.
- **`awaiting_fixes`**
  - Print the message and findings summary.
  - Do NOT merge.
  - Exit with the orchestrator's exit code.
- **`dry_run_complete`** — print the summary and exit 0.
- **anything else** — print the summary and exit with the orchestrator's exit code.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Clean / dry-run complete |
| 1 | Halted / awaiting fixes |
| 2 | Dispatch failure |
| 3 | Invalid input |

## Observability

- Emits `forged_review.*` events via `emit_queue.py`.
- Records per-run metrics to `~/.claude/code-review/history/forged-review/forged_review_metrics.db`.
- Prints `[forged-review] …` progress lines to stderr.
