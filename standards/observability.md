# Skill Observability Protocol

Standard timing, progress tracking, and metrics patterns for all skills. Every skill that runs phases, dispatches agents, or launches background operations MUST follow this protocol.

## Why

Without timing data, you can't tell whether a 20-minute skill run spent 18 minutes in sub-agent dispatch or 18 minutes parsing JSON. Consistent observability across skills enables:
- Identifying bottlenecks across phases and agents
- Comparing run durations across invocations
- Catching regressions (a phase that used to take 30s now takes 5m)
- Giving the user real-time visual feedback on long-running operations

## Protocol

### 1. Task-Based Progress UI (Primary)

Use `TaskCreate` and `TaskUpdate` to drive the native Claude Code progress display. This gives the user a live, updating view of what's happening.

**At skill start:** Create one task per phase/step. Use `activeForm` for the spinner text shown while in-progress.

Example for `/stark-team-review`:

```
TaskCreate: "Phase 1: Setup — auth, fetch PR, create worktree"
            activeForm: "Setting up review environment"
TaskCreate: "Phase 2: Review-Fix Loop (up to 3 rounds)"
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final review round"
            activeForm: "Running final review"
TaskCreate: "Phase 4: Summary + post to PR"
            activeForm: "Generating summary"
TaskCreate: "Phase 5: Cleanup"
            activeForm: "Cleaning up worktree"
```

**As work progresses:** Update each task's status:
- `pending` → task not yet started (default)
- `in_progress` → currently executing (shows spinner with `activeForm` text)
- `completed` → done (shows green checkmark + strikethrough)

**Rules:**
- Set a task to `in_progress` BEFORE starting work on it
- Set it to `completed` immediately when the phase finishes
- Only ONE task should be `in_progress` at a time (unless truly parallel)
- If a phase fails, leave it as `in_progress` — the user sees it stalled

**Nested progress for complex phases:** For phases with sub-steps (like review-fix rounds), create child tasks:

```
TaskCreate: "Round 1: dispatch 27 sub-agents"
            activeForm: "Dispatching 27 sub-agents (round 1)"
TaskCreate: "Round 1: classify findings"
            activeForm: "Classifying findings"
TaskCreate: "Round 1: fix code"
            activeForm: "Fixing 7 findings"
TaskCreate: "Round 1: build + test"
            activeForm: "Running build and tests"
```

Create round tasks dynamically as each round begins — don't pre-create all rounds since the loop may exit early.

### 2. Timestamped Log Lines (Secondary)

Alongside the task UI, print timestamped log lines for key events. These provide a textual record that persists in the conversation:

```
[HH:MM:SS] === stark-team-review started ===
[HH:MM:SS] Phase 1: Setup — started
[HH:MM:SS] Phase 1: Setup — done (12s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching 27 sub-agents
[HH:MM:SS]   ▸ Round 1: 27 complete (23 succeeded, 4 failed) — 127s
[HH:MM:SS]   ▸ Round 1: 7 fix, 3 false positive, 2 noise — fixing
[HH:MM:SS]   ▸ Round 1: build + test — passed
[HH:MM:SS] Phase 2: Review-Fix Loop — done (8m 43s)
```

Record `T0` at skill start. All elapsed time calculations are relative to `T0`.

### 3. Checkpoint Every 5 Minutes

If the skill has been running for 5+ minutes, print a checkpoint at every 5-minute boundary:

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 6/27 sub-agents complete
[HH:MM:SS] ⏱ Checkpoint — 10m elapsed | Phase 2, Round 2 | fixing 3 findings
[HH:MM:SS] ⏱ Checkpoint — 15m elapsed | Phase 3: final review round
```

Include: elapsed time since `T0`, current phase, and a progress indicator. For skills that complete in under 5 minutes, no checkpoints are needed.

### 4. Skill End — Metrics Summary

When the skill completes (success or failure), print a structured metrics block:

```
[HH:MM:SS] === stark-team-review completed ===

Metrics
───────
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):           12s
  Phase 2 (Review-Fix Loop): 8m 43s
    Round 1 dispatch:        2m 11s
    Round 1 classify+fix:    1m 22s
    Round 2 dispatch:        2m 05s
    Round 2 classify+fix:    1m 02s
    Build & test:            1m 43s
  Phase 3 (Final Review):    2m 15s
  Phase 4 (Summary):         8s
  Phase 5 (Cleanup):         3s

Agents:              27 dispatched, 25 succeeded, 2 failed
Findings:            23 total → 14 fixed, 4 false positive, 3 noise, 2 unresolved
Rounds:              2 fix + 1 final
```

Adapt the metrics to the skill. Not every skill has agents or rounds. The structure should reflect the skill's actual phases and operations:

- **stark-team-review / stark-review-plan**: agent counts, per-round timing, finding outcomes
- **stark-session start**: per-health-check timing, context load time
- **stark-update-deps**: dependency count, WebSearch count, verification pass/fail
- **stark-rename-project**: files modified count, sibling repos updated, symlinks fixed
- **stark-init-docs**: files created/skipped counts per mode
- **stark-release**: version bumped, tag created, release published
- **stark-pr-flow**: push/PR/review/merge step timing

### 5. Improvement Flags

After the metrics, if any of these conditions are true, print an improvement flag:

```
Improvement Opportunities
─────────────────────────
⚠ Phase 2 took 73% of total time — sub-agent dispatch is the bottleneck
⚠ 4/27 sub-agents failed — check Gemini CLI auth (3 Gemini failures)
⚠ Round 2 found 0 new issues — could reduce max_rounds to 1 for this repo
⚠ Build step ran 3 times due to fix regressions — fixes need better validation
```

**Conditions to check:**
- Any single phase > 70% of total time → flag as bottleneck
- Agent failure rate > 20% → flag with failure breakdown by agent
- A round produced 0 new actionable findings → suggest reducing rounds
- Build/test retries > 1 → flag fix quality issue
- Total duration > 2× the median for this skill type (if history exists)
- Any phase took > 2× its previous run (if history exists)

If no conditions are met, print: `No improvement opportunities detected.`

### 6. History Integration

If the skill writes to `~/.claude/code-review/history/`, include timing data in the persisted JSON:

```json
{
  "timing": {
    "started_at": "2026-03-20T14:30:00Z",
    "completed_at": "2026-03-20T14:41:23Z",
    "total_duration_s": 683,
    "phases": [
      {"name": "Setup", "duration_s": 12},
      {"name": "Review-Fix Loop", "duration_s": 523, "rounds": [
        {"round": 1, "dispatch_s": 131, "classify_fix_s": 82},
        {"round": 2, "dispatch_s": 125, "classify_fix_s": 62}
      ]},
      {"name": "Final Review", "duration_s": 135},
      {"name": "Summary", "duration_s": 8},
      {"name": "Cleanup", "duration_s": 3}
    ],
    "agents": {"dispatched": 27, "succeeded": 25, "failed": 2}
  }
}
```

Skills that don't write history skip this — the terminal output and task UI are sufficient.

## How Skills Reference This Standard

Each skill includes a one-line reference in its body:

```markdown
## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.
```

If a skill needs additional metrics beyond the standard (e.g., per-sub-agent timing breakdown), it adds them in its own section alongside the reference.

## Task Naming Convention

Task subjects should match this pattern so the UI is consistent across skills:

```
Phase N: <phase name> — <brief description>
```

For sub-tasks within a phase:
```
Round N: <step> — <brief description>
```

The `activeForm` should be a present-continuous verb phrase that fits naturally in the spinner: "Dispatching sub-agents", "Classifying findings", "Running tests".

## Implementation Notes

- Timestamps use `HH:MM:SS` in local time (matches the user's terminal)
- Durations under 60s: show as `Xs` (e.g., `12s`)
- Durations 60s+: show as `Xm Ys` (e.g., `2m 15s`)
- Durations 60m+: show as `Xh Ym` (e.g., `1h 12m`)
- The 5-minute checkpoint timer is wall-clock, not per-phase
- Phase names must match the skill's documented phase names exactly
- On skill failure/abort, still print whatever metrics were collected up to the failure point
- Task UI is the primary feedback mechanism — log lines are secondary but important for the conversation record
