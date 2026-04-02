# Observability Protocol — stark-extract-docs

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md).

## Task-based progress at start

```
TaskCreate: "Phase 1: Setup — validate input, resolve artifacts"
            activeForm: "Setting up extraction"
TaskCreate: "Phase 2: Pass 1 — Knowledge Extraction"
            activeForm: "Extracting knowledge from artifacts"
TaskCreate: "Phase 3: Pass 2 — Routing & Generation"
            activeForm: "Routing knowledge to doc types"
TaskCreate: "Phase 4: Preview & Write"
            activeForm: "Writing documentation files"
TaskCreate: "Phase 5: Batch Coordination"   (batch mode only)
            activeForm: "Deduplicating across specs"
TaskCreate: "Phase 6: Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 7: Metrics & History"
            activeForm: "Persisting metrics"
```

Set each to `in_progress` before starting, `completed` when done.

## Timestamped log lines

`[HH:MM:SS]` for each phase start/end and key events.

## 5-minute checkpoints

For batch mode — show elapsed time + current spec + progress (N/M specs done).

Record `T0` at skill start. All durations relative to `T0`.
