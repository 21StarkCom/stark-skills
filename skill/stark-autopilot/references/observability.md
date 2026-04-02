# Observability

## Task-based progress (required)

At start:
```
TaskCreate: "Phase 1: Setup — parse plan, detect tests"
            activeForm: "Setting up autopilot"
```

Per step (dynamic):
```
TaskCreate: "Step 1: [title] — 3 agents competing"
            activeForm: "Step 1: tournament in progress"
```

## Timestamped log lines (required)

```
[HH:MM:SS] === stark-autopilot started ===
[HH:MM:SS] Phase 1: Setup — 5 steps, pytest detected
[HH:MM:SS] Step 1: [title] — dispatching 3 agents
[HH:MM:SS]   > claude: done — 8 files, +245/-30 [180s]
[HH:MM:SS]   > codex: done — 6 files, +198/-25 [220s]
[HH:MM:SS]   > gemini: done — 7 files, +210/-28 [150s]
[HH:MM:SS]   > Tests: claude=PASS, codex=PASS, gemini=FAIL
[HH:MM:SS]   > Winner: claude (92/100)
[HH:MM:SS]   > Applied + committed
[HH:MM:SS] Step 2: [title] — dispatching 3 agents
...
[HH:MM:SS] === stark-autopilot completed (5/5 steps, 45m 12s) ===
```

## Metrics block at end (required)

```
Metrics
-------
Total duration:     45m 12s
Steps completed:    5/5
Tournaments run:    5
Total agent runs:   15 (5 steps x 3 agents)

Per-agent wins:
  claude:  3 (60%)
  codex:   1 (20%)
  gemini:  1 (20%)

Per-agent avg score:
  claude:  92.0/100
  codex:   85.3/100
  gemini:  82.7/100

Test results:
  Total runs:    15
  Passed:        12 (80%)
  Failed:         3 (20%)

Code output:
  Files changed:  23
  Lines added:    1,450
  Lines removed:  200
  Commits:        5
```
