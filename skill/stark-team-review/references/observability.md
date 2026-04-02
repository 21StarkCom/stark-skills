# Observability Protocol — stark-team-review

**You MUST implement all of the following.** This is not optional — the user relies on this output to understand what's happening during long-running reviews.

## Task-based progress (required)

At skill start, create these tasks to drive the Claude Code progress spinner:

```
TaskCreate: "Phase 1: Setup — auth, fetch PR, create worktree"
            activeForm: "Setting up review environment"
TaskCreate: "Phase 2: Review-Fix Loop (up to N rounds)"
            activeForm: "Running review-fix loop"
TaskCreate: "Phase 3: Final Summary"
            activeForm: "Generating summary"
TaskCreate: "Phase 4: Post & Persist"
            activeForm: "Posting to PR"
TaskCreate: "Phase 5: Cleanup"
            activeForm: "Cleaning up worktree"
```

Set each to `in_progress` BEFORE starting it, `completed` when done. Only one task `in_progress` at a time.

For Phase 2, create **child tasks dynamically** as each round begins:

```
TaskCreate: "Round 1: dispatch 27 sub-agents"
            activeForm: "Dispatching 27 sub-agents (round 1)"
TaskCreate: "Round 1: classify + fix"
            activeForm: "Classifying and fixing findings"
TaskCreate: "Round 1: build + test"
            activeForm: "Running build and tests"
```

Don't pre-create all rounds — the loop may exit early.

## Timestamped log lines (required)

Record `T0` at skill start. Print timestamped lines for every phase transition and key event:

```
[HH:MM:SS] === stark-team-review started ===
[HH:MM:SS] Phase 1: Setup — started
[HH:MM:SS] Phase 1: Setup — done (12s)
[HH:MM:SS] Phase 2: Review-Fix Loop — started
[HH:MM:SS]   ▸ Round 1: dispatching 27 sub-agents
[HH:MM:SS]   ▸ Round 1: 27 complete (23 succeeded, 4 failed: codex:scope, gemini:security, ...) — 127s
[HH:MM:SS]   ▸ Round 1: 7 fix, 3 false positive, 2 noise — fixing
[HH:MM:SS]   ▸ Round 1: build + test — passed
[HH:MM:SS]   ▸ Round 1: commit + push — done
[HH:MM:SS]   ▸ Round 2: dispatching 27 sub-agents
[HH:MM:SS]   ...
[HH:MM:SS] Phase 2: Review-Fix Loop — done (8m 43s)
[HH:MM:SS] Phase 3: Summary — done (5s)
[HH:MM:SS] Phase 4: Post & Persist — done (3s)
[HH:MM:SS] Phase 5: Cleanup — done (2s)
[HH:MM:SS] === stark-team-review completed ===
```

## 5-minute checkpoints (required for runs > 5 min)

If running for 5+ minutes, print a checkpoint at every 5-minute boundary:

```
[HH:MM:SS] ⏱ Checkpoint — 5m elapsed | Phase 2, Round 1 | 6/27 sub-agents complete
[HH:MM:SS] ⏱ Checkpoint — 10m elapsed | Phase 2, Round 2 | fixing 3 findings
```

## Metrics block at end (required)

After the skill completes (success or failure), print:

```
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
  Phase 3 (Summary):         5s
  Phase 4 (Post & Persist):  3s
  Phase 5 (Cleanup):         2s

Issues found:        14 (7 fixed, 5 recurring, 2 unresolved)
Noise:               7 (4 false positive, 3 noise)
Agents:              18 dispatched, 16 succeeded, 2 failed
Rounds:              2 fix + 1 final
Bug issues created:  N
```

## Improvement flags (required)

After the metrics, check and print if applicable:
- Any single phase > 70% of total time → flag as bottleneck
- Agent failure rate > 20% → flag with breakdown by agent
- A round produced 0 new actionable findings → suggest reducing rounds
- Build/test retries > 1 → flag fix quality issue
- Phase 1.9 found more critical issues than Phase 2 agents → flag "runtime verification was more valuable than review agents"
- Signal-to-noise < 20% → flag "review agents producing excessive noise — consider reducing domains or tightening prompts"

If none triggered: `No improvement opportunities detected.`

## Timing in history JSON

Include per-phase timing in `rounds.json`:

```json
{
  "timing": {
    "total_duration_s": 683,
    "phases": [
      {"name": "Setup", "duration_s": 12},
      {"name": "Review-Fix Loop", "duration_s": 523, "rounds": [
        {"round": 1, "dispatch_s": 131, "classify_fix_s": 82, "build_test_s": 45},
        {"round": 2, "dispatch_s": 125, "classify_fix_s": 62, "build_test_s": 38}
      ]},
      {"name": "Summary", "duration_s": 5},
      {"name": "Post & Persist", "duration_s": 3},
      {"name": "Cleanup", "duration_s": 2}
    ],
    "agents": {"dispatched": 18, "succeeded": 16, "failed": 2, "failed_agents": ["codex:scope", "gemini:security"]}
  }
}
```

## Event emission

After the metrics block, emit a completion event to stark-insights:

```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-team-review duration_s=$TOTAL_SECONDS success=$SUCCESS \
  pr_number=$PR findings_total=$TOTAL findings_fixed=$FIXED \
  noise_count=$NOISE agents_dispatched=$AGENTS rounds=$ROUNDS
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.

## Observability in review-only / dry-run mode

When running in review-only mode (no fix loop), adapt the metrics:
- Skip "Rounds" line (there are no fix rounds)
- Show "Review-only mode — no fixes applied"
- Agent counts still apply

## Agent counting

Agent counts are **per-round** (27 dispatched = 3 agents × 9 domains per round). The metrics block shows the **last round's** agent counts. Total dispatches across all rounds go in the phase timing breakdown.
