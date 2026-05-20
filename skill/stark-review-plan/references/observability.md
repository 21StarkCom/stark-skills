# Observability

**You MUST implement all of the following.** The user relies on this output during long-running plan reviews.

## Task-based progress (required)

At skill start, create tasks for the progress spinner:

```
TaskCreate: "Phase 1: Setup -- validate plan, check history"
            activeForm: "Setting up plan review"
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
TaskCreate: "Round 1: dispatch NxM sub-agents"
            activeForm: "Dispatching NxM sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
```

## Timestamped log lines (required)

Record `T0` at skill start. Print for every phase transition and key event:

```
[HH:MM:SS] === stark-review-plan started ===
[HH:MM:SS] Phase 1: Setup -- done (3s)
[HH:MM:SS] Phase 2: Review-Fix Loop -- started
[HH:MM:SS]   > Round 1: dispatching NxM sub-agents
[HH:MM:SS]   > Round 1: NxM succeeded -- 145s
[HH:MM:SS]   > Round 1: 12 fix, 5 noise, 3 FP -- fixing plan
[HH:MM:SS]   > Round 1: done
[HH:MM:SS]   > Round 2: dispatching NxM sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: done (9m 12s)
[HH:MM:SS] Phase 3: Final Review -- NxM sub-agents -- done (2m 30s)
[HH:MM:SS] Phase 4: Summary -- done (5s)
[HH:MM:SS] Phase 5: Output -- done (3s)
[HH:MM:SS] === stark-review-plan completed ===
```

## 5-minute checkpoints (required for runs > 5 min)

```
[HH:MM:SS] Checkpoint -- 5m elapsed | Phase 2, Round 1 | 18/NxM sub-agents complete
```

## Metrics block at end (required)

```
Metrics
-------
Total duration:     Xm Ys
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   9m 12s
    Round 1 dispatch:     2m 25s
    Round 1 classify+fix: 1m 30s
    Round 2 dispatch:     2m 20s
    Round 2 classify+fix: 1m 15s
  Phase 3 (Final):        2m 30s
  Phase 4 (Summary):      5s
  Phase 5 (Output):       3s

Issues found:        8 (5 fixed, 3 unresolved)
Noise:               9 (6 false positive, 3 noise)
Agents:              30 dispatched, 27 succeeded, 3 failed
Rounds:              2 fix + 1 final
Domains:             10
```

## Improvement flags (required)

Check and print:
- Any phase > 70% of total -> bottleneck
- Agent failure rate > 20% -> flag by agent
- A round produced 0 new findings -> suggest reducing rounds
- Dispatch health < 50% -> warn about low coverage

If none: `No improvement opportunities detected.`
