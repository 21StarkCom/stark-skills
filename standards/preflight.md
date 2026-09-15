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

`TOOLS` also locates dispatchers such as `stark_review.ts`.
Preflight checks the existing `gh` login as `aryeh-stark`.
Authentication changes require operator action.
