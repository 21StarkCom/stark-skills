# Skill Preflight Protocol

Standard environment validation that every skill runs before doing real work.
Skills point at this doc instead of inlining the pattern.

## Invocation

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types "$TOOLS/preflight.ts" --workflow <skill-slug> --json
```

The skill provides its own `<skill-slug>` (e.g. `stark-review`, `stark-review-plan`).

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

1. Append an entry to `~/.claude/code-review/alerts.jsonl`.
2. Exit non-zero so the trigger is marked failed.

Interactive skill invocations skip steps 1–2 and just print + stop.

## Constants

The fallback includes `CLAUDE_PLUGIN_ROOT` deliberately: Bifrost retargets that
portable marker to the runtime's vendored asset root during installation.

Shell state does not persist between independent tool calls. Every later shell
call that needs a dispatcher must resolve `TOOLS` again in that same call; do
not rely on the assignment above surviving. Skills that still call into Python
orchestrators likewise resolve
`SCRIPTS="${STARK_REVIEW_SCRIPTS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/scripts}"`
and `PYTHON="$SCRIPTS/.venv/bin/python3"` in the call that uses them. Preflight
itself no longer requires Python.
