# Skill Preflight Protocol

Standard environment validation that every skill runs before doing real work.
Skills point at this doc instead of inlining the pattern.

## Invocation

```bash
TOOLS="${STARK_REVIEW_TOOLS:-$HOME/.claude/code-review/tools}"
node "$TOOLS/preflight.ts" --workflow <skill-slug> --json
```

The skill provides its own `<skill-slug>` (e.g. `stark-review`, `stark-terraform-review`).

## Result handling

Parse the JSON `overall` field:

| `overall` | Action |
|-----------|--------|
| `ready` | Continue silently. |
| `degraded` | Print a one-line warning naming the failing checks, then continue. |
| `blocked` | Print the failing checks and stop. Do not proceed. |

## Non-interactive automation

When the skill runs unattended (scheduled jobs, CI), a
`blocked` result MUST also:

1. Append an entry to `~/.claude/code-review/alerts.jsonl`.
2. Exit non-zero so the caller sees the failure.

Interactive skill invocations skip steps 1–2 and just print + stop.

## Constants

`TOOLS` set above is reused throughout the skill body for other TS dispatchers
(`stark_review.ts`, `github_app.ts`, etc.) — define it once in this preflight
block and rely on it later. Skills that still call into Python orchestrators
also need `SCRIPTS=${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}` and a
`PYTHON="$SCRIPTS/.venv/bin/python3"` fallback alongside; preflight itself
no longer requires the Python interpreter.
