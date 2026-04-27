# Multi-Agent Dispatch Failure Handling

Shared semantics for the doc-review skills (`stark-review-design`,
`stark-review-plan`) when a dispatch round returns no usable findings.
Skills point here instead of inlining identical §2d blocks.

## Health check (run after every dispatch round)

Inspect the dispatch JSON's `summary` field:

| Condition | Meaning | Action |
|-----------|---------|--------|
| `summary.succeeded == 0` | Dispatch failure — every sub-agent failed. | Treat as **failure**, NOT a clean doc. Run diagnostics, skip remaining rounds and Phase 3, jump to Phase 4 with a dispatch-failure summary. |
| `summary.succeeded > 0` AND `succeeded / total_sub_agents < 0.5` | Low coverage. | Print `Low coverage — only N/M sub-agents succeeded. Results may be incomplete.` Continue normally. |
| `summary.succeeded > 0` AND coverage healthy | Normal. | Proceed with finding classification. |

Zero findings is **only** "clean" when dispatch was healthy. A dispatch
failure that returns zero findings is a failure, not a pass.

## Diagnostics (when `succeeded == 0`)

```bash
which claude codex gemini
$PYTHON $SCRIPTS/plan_review_dispatch.py --prompts-dir <prompts-dir> \
  --file "$path" --round $round --agents claude --timeout 60
```

`<prompts-dir>` is `design-review` or `plan-review`. The single-agent probe
isolates whether the failure is per-agent (one CLI broken / unauthenticated)
or systemic (all CLIs missing, network down).

## Dispatch-failure summary template

When jumping to Phase 4 due to dispatch failure, use this header instead of
the normal summary:

```markdown
## {Doc} Review — Dispatch Failure

**File:** {path}
**Status:** Review could not complete — {succeeded}/{total} sub-agents succeeded.

### Error Details
| Agent | Domain | Error | Stderr (truncated) |
|-------|--------|-------|-------------------|

### Diagnostics
- CLI availability: claude={yes/no}, codex={yes/no}, gemini={yes/no}
- Single-agent probe: {result}

### Recommendation
{e.g., "Check API keys/auth", "CLI not installed", "Network issue"}
```

Replace `{Doc}` with `Design` or `Plan`.
