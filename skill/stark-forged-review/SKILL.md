---
name: stark-forged-review
description: >-
  Multi-agent PR review with leader + second-opinion per domain, dynamic triage, and forge-style escalation on non-trivial findings. Replaces stark-review.
argument-hint: "[PR_NUMBER] [--dry-run] [--repo ORG/REPO] [--resume] [--no-escalate] [--force-escalate]"
disable-model-invocation: true
model: opus[1m]
---

## Preflight

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forged-review --json
```

Parse the JSON result:
- `overall: blocked` → print failing checks and stop.
- `overall: degraded` → warn and continue.
- `overall: ready` → continue silently.

## Arguments

See `skill/stark-forged-review/README.md` for full details.

- `PR_NUMBER` — optional; auto-detected from current branch if omitted
- `--dry-run` — review only, no commits/pushes/merge
- `--repo ORG/REPO` — override repo detection
- `--resume` — resume from an existing `.forged-review-state.json`
- `--no-escalate` — forbid the forge path
- `--force-escalate` — always take the forge path

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Run

Invoke the Python orchestrator with the user's arguments. It prints a single JSON object to stdout.

```bash
$PYTHON $SCRIPTS/forged_review.py $ARGUMENTS
```

Capture the exit code and JSON.

## Merge confirmation

Parse the orchestrator's stdout JSON. Expected shape:

```json
{
  "status": "clean | dry_run_complete | awaiting_fixes | failed",
  "pr_number": 123,
  "repo": "GetEvinced/foo",
  "needs_merge_confirmation": true,
  "message": "",
  "summary": "..."
}
```

If `status == "clean"` AND `needs_merge_confirmation == true`:

1. Print the summary.
2. Ask the user: `Clean. Merge PR #<pr_number>? [Y/n]` (default yes).
3. On yes (or empty input):
   ```bash
   unset GH_TOKEN
   gh pr merge <pr_number> --squash --delete-branch --repo <repo>
   ```
4. On no: print `PR left open at user request` and exit 0.

If `status == "awaiting_fixes"`: print the message and the findings summary. Do NOT merge. Exit with the orchestrator's exit code.

If `status == "dry_run_complete"`: print the summary. Exit 0.

Otherwise: print the summary and exit with the orchestrator's exit code.

## Failure reporting

Map orchestrator exit codes to messages:

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Clean / dry-run complete | merge confirmation or summary |
| 1 | Halted / awaiting fixes | print findings, exit 1 |
| 2 | Dispatch failure | print error, suggest re-run |
| 3 | Invalid input | print usage hint |

## Observability

The orchestrator emits `forged_review.*` events via `emit_queue.py` and records per-run metrics to `~/.claude/code-review/history/forged-review/forged_review_metrics.db`. See README for the metrics schema.
