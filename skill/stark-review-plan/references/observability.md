# Observability

**You MUST implement all of the following.** The user relies on this output during long-running plan reviews.

## Task-based progress (required)

At skill start, create tasks for the progress spinner:

```
TaskCreate: "Phase 1: Setup -- validate plan, check history"
            activeForm: "Setting up plan review"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"   [or "Phase 2T: Tournament" if --tournament]
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Review"                        [skip if --tournament]
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

For Phase 2T (tournament):

```
TaskCreate: "Tournament: dispatch 3 full-document reviews"
            activeForm: "Dispatching tournament competitors"
TaskCreate: "Tournament: judge evaluation"
            activeForm: "Judge evaluating reviews (2 passes)"
TaskCreate: "Tournament: synthesize winner"
            activeForm: "Synthesizing best-of-all findings"
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

In tournament mode:

```
[HH:MM:SS] Phase 2T: Tournament -- started
[HH:MM:SS]   > Dispatching 3 full-document reviews
[HH:MM:SS]   > Reviews complete -- claude: 180s, codex: 210s, gemini: 195s
[HH:MM:SS]   > Judge evaluation pass 1 -- done (45s)
[HH:MM:SS]   > Judge evaluation pass 2 (swapped order) -- done (42s)
[HH:MM:SS]   > Winner: {agent} (score: {score}/100)
[HH:MM:SS]   > Synthesis: {N} findings merged from non-winner reviews
[HH:MM:SS] Phase 2T: done (7m 12s)
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
Mode:               normal | tournament
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

In tournament mode, replace Agents/Rounds rows with:

```
Tournament winner:   {agent} ({score}/100)
Runner-up:           {agent} ({score}/100)
Merged findings:     {N} from non-winner reviews
```

## Improvement flags (required)

Check and print:
- Any phase > 70% of total -> bottleneck
- Agent failure rate > 20% -> flag by agent
- A round produced 0 new findings -> suggest reducing rounds
- Dispatch health < 50% -> warn about low coverage
- Tournament: score gap < 5 points -> "results too close to call -- review manually"

If none: `No improvement opportunities detected.`
