# Observability Protocol — stark-phase-execute

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md).

## Task-based progress

```
TaskCreate: "Phase 0: Initialize"
            activeForm: "Initializing phase execution"
TaskCreate: "Phase 1: Task Loop ({N} tasks)"
            activeForm: "Executing task loop"
TaskCreate: "Phase 2: Regression Testing"
            activeForm: "Running regression tests"
TaskCreate: "Phase 3: Release & Deploy"
            activeForm: "Releasing and deploying"
TaskCreate: "Phase 4: Dashboard"
            activeForm: "Generating dashboard"
TaskCreate: "Phase 5: Housekeeping"
            activeForm: "Updating memory and docs"
```

Create child tasks dynamically per issue as each begins. Only one task `in_progress` at a time.

## Timestamped logs

```
[09:15:00] === stark-phase-execute: observability-v2 ===
[09:15:02]   Phase 0: Initialize (5 tasks, repo: GetEvinced/infra-pulse)
[09:15:05]   ▸ Task #42: Add retry logic to API client
[09:15:05]     Branch: phase/observability-v2/issue-42-add-retry-logic
[09:17:30]     Implementation complete (2m 25s)
[09:17:35]     PR #57 created
[09:17:40]     Worktree: /tmp/review-infra-pulse-pr57
[09:18:00]     Review round 1: 8 findings (2 high, 4 medium, 2 low)
[09:19:15]     Review round 2: 2 findings (2 low — noise)
[09:19:18]     Worktree cleaned up
[09:19:20]     ✓ Merged PR #57 (4m 15s)
[09:19:22]   ▸ Task #43: Instrument request tracing
...
[09:45:00]   Phase 2: Regression — 142/142 tests passing
[09:45:10]   Phase 3: CHANGELOG updated (3 added, 1 fixed)
[09:45:30]   Phase 3: Release v1.4.0 (minor)
[09:46:00] === Phase complete: 4/5 tasks merged, 1 failed ===
```

## 5-minute checkpoints

At each phase transition where wall time > 5 minutes since T0, print:

```
[09:20:00] ⏱ Checkpoint: 5m elapsed, task 2/5 in progress (review round 1)
```

## Metrics block

Printed as part of the dashboard (Phase 4). Includes per-phase timing breakdown, agent stats, and improvement flags per the observability protocol.

## Improvement flags

- Any single phase > 70% of total time → flag as bottleneck
- Task failure rate > 30% → flag with breakdown
- Agent failure rate > 20% → flag with agent breakdown
- A review round produced 0 new actionable findings → suggest reducing rounds
- CI bypassed on any merge → flag with details

## Event emission

After the dashboard (Phase 4), emit a completion event to stark-insights:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-phase-execute duration_s=$TOTAL_SECONDS success=$SUCCESS \
  phase=$SLUG tasks_completed=$DONE tasks_failed=$FAILED prs_merged=$MERGED
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.
