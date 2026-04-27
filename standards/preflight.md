# Skill Preflight Protocol

Standard environment validation that every skill runs before doing real work.
Skills point at this doc instead of inlining the pattern.

## Invocation

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
"$PYTHON" "$SCRIPTS/preflight.py" --workflow <skill-slug> --json
```

The skill provides its own `<skill-slug>` (e.g. `stark-review`, `stark-team-review`).

## Result handling

Parse the JSON `overall` field:

| `overall` | Action |
|-----------|--------|
| `ready` | Continue silently. |
| `degraded` | Print a one-line warning naming the failing checks, then continue. |
| `blocked` | Print the failing checks and stop. Do not proceed. |

## Non-interactive automation

When the skill runs from automation (CCR triggers, scheduled jobs, CI), a
`blocked` result MUST also:

1. Emit a `preflight_check` event with `status=blocked` via `emit_queue.py`.
2. Append an entry to `~/.claude/code-review/alerts.jsonl`.
3. Exit non-zero so the trigger is marked failed.

Interactive skill invocations skip steps 1–3 and just print + stop.

## Constants

`SCRIPTS` and `PYTHON` set above are reused throughout the skill body — define
them once in this preflight block and rely on them later.
