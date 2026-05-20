# Observability — stark-review-design

**You MUST implement all of the following.** The user relies on this output during long-running design reviews.

## Task-based progress (required)

At skill start, create tasks for the progress spinner:

```
TaskCreate: "Phase 1: Setup — validate design, check history"
            activeForm: "Setting up design review"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Review"
            activeForm: "Running final review round"
TaskCreate: "Phase 4: Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 5: Output & Persist"
            activeForm: "Writing results"
```

Set each to `in_progress` BEFORE starting, `completed` when done.

For Phase 2, create child tasks dynamically per round:

```
TaskCreate: "Round 1: dispatch N×8 sub-agents"
            activeForm: "Dispatching N×8 sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
```

## Timestamped log lines (required)

Record `T0` at skill start. Print for every phase transition and key event:

```
[HH:MM:SS] === stark-review-design started ===
[HH:MM:SS] Phase 1: Setup — done (3s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching N×8 sub-agents
[HH:MM:SS]   ▸ Round 1: N×8 succeeded — 180s
[HH:MM:SS]   ▸ Round 1: 15 fix, 6 noise, 4 FP — fixing design
[HH:MM:SS]   ▸ Round 1: done
[HH:MM:SS]   ▸ Round 2: dispatching N×8 sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: done (11m 30s)
[HH:MM:SS] Phase 3: Final Review — N×8 sub-agents — done (3m 10s)
[HH:MM:SS] Phase 4: Summary — done (5s)
[HH:MM:SS] Phase 5: Output — done (3s)
[HH:MM:SS] === stark-review-design completed ===
```

## 5-minute checkpoints (required for runs > 5 min)

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 18/N×8 sub-agents complete
```

## Metrics block at end (required)

```
Metrics
───────
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   11m 30s
    Round 1 dispatch:     3m 00s
    Round 1 classify+fix: 2m 00s
    Round 2 dispatch:     2m 55s
    Round 2 classify+fix: 1m 45s
  Phase 3 (Final):        3m 10s
  Phase 4 (Summary):      5s
  Phase 5 (Output):       3s

Issues found:        10 (7 fixed, 3 unresolved)
Noise:               11 (7 false positive, 4 noise)
Agents:              30 dispatched, 28 succeeded, 2 failed
Rounds:              2 fix + 1 final
```

## Improvement flags (required)

Check and print:
- Any phase > 70% of total → bottleneck
- Agent failure rate > 20% → flag by agent
- A round produced 0 new findings → suggest reducing rounds
- Dispatch health < 50% → warn about low coverage

If none: `No improvement opportunities detected.`
