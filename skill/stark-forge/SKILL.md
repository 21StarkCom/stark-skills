---
name: stark-forge
description: >-
  Multi-phase design pipeline: classify, review design, generate plan, review plan, decompose into GitHub issues. Wraps existing dispatch primitives with domain routing, iron-rule fix loops, and crash-safe state.
argument-hint: '<path> [--auto-detect] [--dry-run] [--resume] [--workers N]'
disable-model-invocation: true
model: opus
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-forge --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue with available agents.
- If `overall` is "ready": continue silently.

# stark-forge

Pipeline that takes a design spec as input and produces reviewed plans and
phased GitHub issues — with per-domain agent routing, iron-rule fix loops,
crash-safe state, and audit metrics collection.

**Pipeline:** classify → design review → plan generation → plan review → tdd (v2) → tasks

The spec is the *input*, not an output: there is no design-generation phase.
The terminal phase is `tasks`, which decomposes the reviewed plan into phased
GitHub issues. Implementation is handed off to `/stark-phase-execute`.

**Exit codes:**
- `0` — pipeline completed successfully
- `1` — pipeline halted (a phase returned `status != "completed"`, e.g. iron-rule findings unresolved)
- `2` — dispatch failure (agent crash, unexpected exception in a phase)
- `3` — invalid input / branch guard / lock conflict

## Arguments

- `<path>` — path to the input design spec (positional, required)
- `--auto-detect` — use heuristic classifier without interactive domain confirmation
- `--dry-run` — run classify + design_review only; stop before plan/plan_review/tasks and skip all commits
- `--resume` — resume from the last completed phase (reads state from `.forge-state.json`)
- `--workers N` — max concurrent agent workers (default: from config, typically 3)

If no path is provided, ask: "What should forge build? Provide a spec file path."

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS  = ~/.claude/code-review/scripts
PYTHON   = $SCRIPTS/.venv/bin/python3
PROMPTS  = ~/.claude/code-review/prompts
HISTORY  = ~/.claude/code-review/history/forge
```

## Invocation

The pipeline is implemented end-to-end in `forge_orchestrator.run_forge`.
You do not need to hand-roll a driver:

```bash
$PYTHON -c "
from pathlib import Path
from forge_orchestrator import run_forge
import sys
sys.exit(run_forge(
    Path('<path>'),
    auto_detect=<bool>,
    dry_run=<bool>,
    resume=<bool>,
    workers=<int>,
))
"
```

`run_forge` handles: branch guard, worktree setup, lock acquisition, state
init/load/backup, spec-hash drift warning, phase dispatch, per-phase atomic
state writes, progress rendering, and JSON summary on stdout when not a TTY.

## Phase 1: Setup

### 1.1 Parse input

Read the input document at `<path>`. Validate:
- File exists and is readable
- File is markdown (`.md`) or text
- File is non-empty

`run_forge` performs its own branch guard (refuses main/master with exit 3)
and lock-file handling. Do not duplicate those checks.

### 1.2 State schema

`init_state` writes `.forge-state.json` inside the forge worktree with this
shape (see `forge_orchestrator.init_state` for the canonical source):

```json
{
  "version": 1,
  "spec_path": "<absolute path>",
  "spec_hash": "<sha256>",
  "phases": {
    "classify":      {"status": "pending"},
    "design_review": {"status": "pending", "rounds": []},
    "plan":          {"status": "pending"},
    "plan_review":   {"status": "pending", "rounds": []},
    "tdd":           {"status": "pending"},
    "tasks":         {"status": "pending"}
  },
  "created_at": "<ISO timestamp>",
  "updated_at": "<ISO timestamp>"
}
```

There is no top-level `tdd`, `current_round`, or `max_rounds` key — those
live inside per-phase sub-objects or come from config at dispatch time.
Each phase transitions `pending → starting → completed | halted | error`;
`starting` phases are re-run on `--resume` (crash recovery).

### 1.3 Config

`run_forge` loads `get_forge_config()` once and threads it through every
phase. Relevant keys: `max_rounds`, `fix_threshold`, `domain_routing`,
`plan_review_routing`, `agent_fallback_order`, `consensus_domains`,
`consensus_threshold`, `workers`, `timeout`.

### 1.4 Worktree

`_setup_worktree` creates `.worktrees/forge-<slug>` and copies the spec
inside. All edits land on the worktree copy, never the original.

## Phase 2: Classify

`forge_classifier.classify_spec` picks which design-review domains to
dispatch using a 3-tier classifier:

1. **Tier 1 (heuristic):** regex patterns from `forge_heuristics.json`.
   Confidence ≥ 0.5 with `--auto-detect` wins immediately.
2. **Tier 2 (LLM):** `domain_triage.triage_domains` chooses domains when
   heuristics are low-confidence.
3. **Tier 3 (interactive):** prompts the user to confirm/adjust when
   `--auto-detect` is off and stdin is a TTY.

Status output: `[RUN] classify: dispatching` → `[OK] classify: completed`.
State records `domains`, `skipped_domains`, `design_type`, `tier_used`,
`confidence`.

## Phase 3: Design Review

`forge_review.run_design_review` runs the iron-rule loop:

1. For each round `1..max_rounds`, dispatch domains grouped by routed agent
   (plus consensus-domain dispatch to multiple agents).
2. Classify findings into `fix` / `noise` / `blocked`. Third-time recurrence
   escalates to `blocked`; two-agent cross-reference promotes to high-confidence `fix`.
3. Dispatch `forge_fix_loop.apply_fixes` to rewrite the spec. **If the rewrite
   produces no changes, the phase halts** rather than committing an empty
   no-op and re-finding the same issues.
4. Commit fixed rounds with `_commit_round`.
5. Round `max_rounds + 1` is the halt round: dispatch all domains one last
   time. Any fix/blocked finding → halt.

On halt: `[HALT] design_review: design review findings unresolved`.

## Phase 4: Plan Generation

`forge_plan.run_plan_phase` dispatches every enabled agent to generate its
own plan, cross-reviews them, selects a winner by average score, writes the
winning plan to `{spec-stem}-plan.md`, and commits it.

## Phase 5: Plan Review

`forge_plan.run_plan_review` runs the same iron-rule shape as design review,
over the 10 plan-review domains: general, completeness, security,
feasibility, operability, sequencing, rollback, risk, gates, timeline.

Same fix-dispatch contract as design review: the loop halts if the LLM
produces a no-op rewrite. Per-round state is persisted after every iteration
so a halt or crash preserves the round log.

## Phase 6: TDD (v2 passthrough)

`forge_tdd.skip_tdd_phase` currently returns `completed` immediately. v2
will populate this with test-first scaffolding.

## Phase 7: Tasks

`forge_tasks.run_tasks_phase` decomposes the reviewed plan into phased
tasks via an LLM call, validates the breakdown with
`plan_to_tasks_validate.dispatch_validators`, and retries up to 3 times on
failure. State records `breakdown` and `task_count`.

GitHub issue creation is a separate step — `create_issues` is called by the
caller after `run_forge` returns. Implementation is handed off to
`/stark-phase-execute <slug>`.

## Finalize

`run_forge` prints a JSON summary on stdout when stdout is not a TTY,
containing the event stream from `ForgeProgress`. The state file at
`.forge-state.json` (mirrored to `.forge-backup/state-backup.json`) has the
full per-phase record, including `findings_fixed`, `commit_shas`, `rounds`,
and `plan_hash`.
