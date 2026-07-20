# spec-to-plan review summary — stark-forge

- **Spec:** `docs/specs/2026-07-19-stark-forge-spec.md`
- **Plan:** `docs/plans/2026-07-19-stark-forge-plan.md`
- **Lead:** claude · **Wing:** codex (gpt-5.6-sol) · **Duration:** 1347s
- **Dispatcher verdict:** `max_rounds_unresolved` after 4 fix rounds (findings 4→2→4→2→2, draft 20k→49k)
- **Operator disposition:** hand-fix + proceed (operator-confirmed). The 2 round-5 findings were fixed by hand in the landed plan; /stark-review-plan is the next gate.

## Hand-applied fixes (round-5 findings)

1. **Re-entry ownership defined:** reconciliation always ends at done/halted/failed; the compare-and-set `halted/failed → running` re-entry belongs to the resume executor and opens every reinvoke/merge_only block (driver renderer + SKILL.md flow updated), so record-output and `--from running` transitions never run against a halted/failed stage, and retried new-artifact stages never skip base-sync.
2. **Branch A tightened:** plan-to-tasks title-dedup only counts if confirmed on the bare `/stark-plan-to-tasks <plan-path>` re-entry path reconciliation actually issues; `--cleanup` explicitly does not qualify.

## Per-round trail

### Round 1 — revise (draft 20292 chars, 117s)

The architecture and scope match the spec, but reconciliation atomicity, top-level invocation wiring, and the plan-to-tasks crash-window closure need concrete implementation contracts.

**Blocking:**
- Phase 0 Task 3 and Phase 3 Task 1 conflict on crash-attempt recording: `transition(running → failed|halted)` automatically appends a `failed`/`halted` attempt, while reconciliation separately appends `crashed` before making that transition. Define a reconciliation-aware transition parameter or a single atomic reconciliation primitive so one episode produces exactly one `crashed` attempt, and name its exact signature.
- Phase 3 Task 1 declares `resumeTarget(state, readPr)` as returning only the target descriptor even though reconciliation mutates the run and must durably persist those changes before returning. Specify an interface such as `{state, target}` (or an explicit atomic persistence operation) and show how `forge_state.ts resume-target` writes the reconciled state before printing its action; otherwise a subsequent resume can repeat reconciliation or lose observed merge records.
- Phase 4 does not define an executable bridge between `/stark-forge` arguments and the deterministic validation/resolution code. `forge_state.ts` lists only state-manager subcommands, while `validateArgs(argv)`, dry-run resolution, resume selection, and the exact §9 error/dry-run JSON are required for the top-level skill invocation. Identify the callable CLI subcommand or exact SKILL.md-to-library mechanism that receives the raw forge arguments, performs validation before `init`, renders dry-run output, and guarantees the stdout/stderr contract.
- Phase 5 leaves the blocking plan-to-tasks crash window as a conditional note rather than an executable task. Add a concrete pre-ship task that inspects the exact plan-to-tasks implementation files, proves title deduplication with a named test, or—if absent—names the files and integration change that records each issue number incrementally, with a crash-between-issue-creation-and-final-marker test.

### Round 2 — revise (draft 31557 chars, 159s)

The architecture is nearly executable, but partial issue persistence is incorrectly treated as stage completion and the persistence functions need an unambiguous file owner.

**Blocking:**
- Phase 5 Task 2 still does not safely close the plan-to-tasks crash window when title deduplication is absent: it proposes incrementally recording issue numbers, then tests that a running stage with a partial issue_numbers list reconciles to done without re-invocation. A partial list proves only that some issues were created, not that the stage completed, so this can silently skip the remaining issues. Define a durable completion marker or expected issue set and resume unfinished creation while skipping already-recorded issues; only a confirmed complete marker may reconcile directly to done.
- Phase 2 Task 3 does not assign persistState/loadState/resolveLatest to an exact file and conflicts with Global Constraints: the plan says the pure forge_state_lib.ts never touches disk and persistence belongs to the CLI, while Phase 2 introduces disk-writing persistence exports that Phase 4 consumes without naming their owner. Specify whether these functions live in tools/forge_state.ts or another exact TypeScript file, preserving forge_state_lib.ts as the declared pure library.

### Round 3 — revise (draft 38379 chars, 204s)

The core state design is now concrete, but the feasibility gate, plan-to-tasks resume contract, and base-sync wiring must be aligned with the spec before implementation.

**Blocking:**
- Phase 5 Task 1 violates the spec's feasibility-gate ordering: the two-stage in-session invocation spike is scheduled after Phases 0–4, although the spec requires it before the full chain is implemented. Move the spike to a gating Phase 0 and select in-session versus driver mode before building mode-dependent orchestration.
- Global Constraints and Phases 0/3/4 introduce `artifacts.issue_creation_complete`, `resume_partial`, and `--issue-creation-complete`, but none exists in the spec's closed StageArtifacts schema, resume-target action enum, or forge_state.ts CLI contract. Either revise the spec first or conform to its existing `issue_numbers` completion-marker and `reinvoke|advance|complete|merge_only|abandon` contracts.
- Phase 5 Task 2 still lacks an executable plan-to-tasks partial-resume mechanism: the documented stage accepts only `<path>`, `--dry-run`, and `--cleanup <slug>`, yet the plan says forge will pass recorded issue numbers as a skip-set and refers to 'whatever tool it shells to' without naming a flag, signature, or exact implementation file. Confirm existing title dedup before selecting this design, or name and scope the concrete plan-to-tasks code/API change that consumes the skip-set and closes the created-before-recorded crash window.
- Phase 5 Task 3 says `base-sync-before-every-running-entry`, which would also switch review-spec/red-team-spec/review-plan/red-team-plan away from their shared open-PR branches. Scope the prelude exactly to spec-to-plan, plan-to-tasks, and copilot; name `git switch <default-branch>` plus `git pull --ff-only`; and specify the `base_sync_failed` transition before stage invocation.

### Round 4 — revise (draft 39847 chars, 234s)

The state-machine design now converges, but authoritative stage-output reporting and the marker-absent issue-creation crash window still need mandatory pre-ship closure.

**Blocking:**
- Prerequisites / Phase 2 Task 3 / Phase 6 Task 2 assume every stage already reports Forge's required outputs, but the plan only says to 'confirm each reported field exists' and defines no remediation when one is absent. Concretely, skill/stark-spec-to-plan/SKILL.md currently exposes dispatcher JSON without plan_path or plan_slug, later prints an Output path but no authoritative plan_slug, and uses a plan-path convention that differs from the spec. Add an exact task against skill/stark-spec-to-plan/SKILL.md (and any affected tests/docs) that makes it report the authoritative plan_path, plan_slug, and plan PR number consumed by record-output; apply the same confirm-or-fix treatment to the other §4 completion channels.
- Phase 6 Task 1 still leaves the blocking plan-to-tasks crash window unresolved when title dedup is absent: filing a follow-up and recording a known gap does not satisfy success criterion 5, yet the task's acceptance criteria permit Phase 6 to continue. Make the negative branch either implement the exact plan-to-tasks deduplication/change with a crash-window test in this plan, or explicitly halt the build before SKILL.md wiring and the live run until that prerequisite lands.

### Round 5 — revise (draft 49294 chars, 232s)

The plan is nearly executable, but resume transitions must have a single explicit owner and the issue-creation crash gate must require true re-entry idempotency.

**Blocking:**
- Phase 4 Tasks 1 and 4 conflict on the post-reconciliation status: Task 1 leaves a checkpoint-absent stage `failed` and returns `action: reinvoke`, while Task 4 says reconciliation then performs `failed → running`; Phase 5 Task 5 and Phase 6 Task 3 likewise do not explicitly place `halted/failed → running` before a `reinvoke` or `merge_only` block. Define one owner for this transition and make every resume command block include the compare-and-set re-entry before stage execution or merge recording; otherwise `record-output` and the final `--from running` transition execute while the stage remains halted/failed, and new-artifact retries may miss their required post-transition base sync.
- Phase 6 Task 2 Branch A still permits `--cleanup <slug>` as an alternative to confirmed title deduplication, but crash reconciliation re-invokes `/stark-plan-to-tasks <plan-path>` without `--cleanup`; cleanup therefore cannot prevent that re-run from creating duplicate issues. Treat Branch A as satisfied only by verified pre-create idempotency/title dedup on the actual re-entry path, or take Branch B and implement the exact-title pre-check with the named crash-window test.

