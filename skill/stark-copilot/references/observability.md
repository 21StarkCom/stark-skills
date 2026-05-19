# Observability

## Task-based progress (required)

At start:
```
TaskCreate: "Phase 1: Setup — parse plan, detect tests"
            activeForm: "Setting up copilot"
```

Per step (dynamic):
```
TaskCreate: "Step 1: [title] — lead/wing loop"
            activeForm: "Step 1: lead implementing"
```

## Timestamped log lines (required)

```
[HH:MM:SS] === stark-copilot started ===
[HH:MM:SS] Phase 1: Setup — 5 steps, pytest detected, lead=claude wing=codex
[HH:MM:SS] Step 1: [title] — lead implementing
[HH:MM:SS]   > round 1: claude impl — 8 files, +245/-30 [180s]
[HH:MM:SS]   > round 1: codex review — revise (3 blocking findings) [40s]
[HH:MM:SS]   > round 2: claude impl (revision) — 8 files, +260/-32 [150s]
[HH:MM:SS]   > round 2: codex review — approve [35s]
[HH:MM:SS]   > Tests: PASS
[HH:MM:SS]   > Verified gates → applied + committed
[HH:MM:SS] Step 2: [title] — lead implementing
...
[HH:MM:SS] === stark-copilot completed (5/5 steps, 45m 12s) ===
```

## Metrics block at end (required)

```
Metrics
-------
Total duration:     45m 12s
Steps completed:    5/5
Lead:               claude (implementer)
Wing:               codex  (reviewer)

Rounds per step:
  step 1: 2
  step 2: 1
  step 3: 3
  step 4: 1
  step 5: 2

Aggregate:
  Avg rounds/step:    1.8
  Total rounds:       9
  Wing parse retries: 0
  Empty-diff aborts:  0

Test results:
  Total runs:    9
  Passed:        9 (100%)
  Failed:        0

Code output:
  Files changed:  23
  Lines added:    1,450
  Lines removed:  200
  Commits:        5
```
