# Implementation Plan — `/stark-forge` Pipeline Orchestrator

## 1. Overview

Forge is a **thin conductor** over six existing pipeline skills plus one new pure-TS state manager. The only real engineering is `forge_state_lib.ts` — a deterministic, clock-free, network-free, disk-free state machine — plus a host CLI wrapper (`forge_state.ts`) that owns all persistence, a config section, and the orchestrator skill markdown. Everything else (LLM work, git, merges) is delegated to stages that already exist and own their own contracts — **except where a stage does not yet report an output §4 requires; those gaps are closed by concrete stage-side tasks in this plan, not assumed away.**

Key architectural decisions:
- **The feasibility spike gates everything.** In-session invocation of the stage skills is the load-bearing unproven assumption (spec `intent`). A two-stage spike (write-spec → review-spec) is **Phase 0** — it runs *before* any mode-dependent orchestration and selects `in-session` vs `driver` mode, so the risky assumption is retired first and the driver-mode fallback is a designed branch, not a bolt-on.
- **State machine is the whole build.** The load-bearing correctness (crash-resumable per-stage progress, merge-at-artifact-boundaries, reconciliation) all lives in a pure lib with an injected PR-state reader, fully unit-testable with zero network. It is mode-independent — the same lib backs both in-session and driver execution — so it is built after the spike but does not depend on the spike's outcome.
- **Pure lib vs. host split is strict.** `forge_state_lib.ts` mutates only in-memory `RunState` and returns the new state; it never touches disk, the clock, git, or the network. **All disk I/O — `persistState`/`loadState`/`resolveLatest` — lives in the host module `tools/forge_state.ts`, never in the lib.**
- **Reconciliation is one atomic primitive, not two writers.** A single `reconcileRunningStage()` owns the crash path — it appends exactly one `crashed` attempt *and* performs the resolving transition in one call, so no episode is ever double-archived.
- **Merge points are a pure derivation** (`mergePointsFor(chain)`), read by execution, dry-run, and summary.
- **The skill is glue, not logic.** No dispatcher; it invokes existing slash-commands in-session (or prints them in driver mode) and calls `forge_state.ts` — including a single `resolve` subcommand that bridges raw `/stark-forge` argv to validation/resolution/dry-run.
- **Stage completion channels are made real, not assumed.** §4 requires each stage to report specific fields (`spec_path` + spec PR, plan_path + plan_slug + plan PR, adopted PR, fold PRs, `issue_numbers`, impl PRs). Where a stage does not yet emit its required field, **this plan changes that stage** — concretely, `skill/stark-spec-to-plan/SKILL.md` today prints a plan Output path but no authoritative `plan_slug` and no plan PR number, and its path convention differs from the spec, so a dedicated task makes it the authoritative producer of `plan_path`, `plan_slug`, and the plan PR number (Phase 6 task 1). Every other §4 channel is checked confirm-**or-fix**, never confirm-only.
- **plan-to-tasks crash-window closure is a build gate, not a deferral.** Success criterion 5 forbids duplicate side effects. Phase 6 either confirms plan-to-tasks's existing title-dedup or **implements it here with a crash-window test**; if neither is done, **the build halts before SKILL.md wiring and the live run** — filing a follow-up alone does not let Phase 6 continue.
- **plan-to-tasks completion conforms to the spec's closed contract:** the completion marker is `artifacts.issue_numbers` being recorded (spec §6/§7). Forge invents no `issue_creation_complete` field, no `resume_partial` action, and no `--issue-creation-complete` flag — the reconcile enum stays the spec's `reinvoke | advance | complete | merge_only | abandon`.

Phases: 7. (0) feasibility spike → mode selection → (1) library core → (2) chain/merge/threading → (3) host persistence + config → (4) reconciliation + resume → (5) CLI incl. argv bridge + driver renderer → (6) stage-output conformance (spec-to-plan producer fix + §4 confirm-or-fix), plan-to-tasks dedup closure (build gate), skill, docs, live run.

## 2. Prerequisites

- Node with `--experimental-strip-types` (repo already uses it), `node:test`. No `node:sqlite` — state is JSON.
- Existing exports in `write_spec_lib.ts`: `writeJsonAtomic`, `updateLatestPointer`, `pruneRunDirs` — confirm signatures before Phase 3.
- `asset_root_lib.ts::stateRoot()`, `stark_config_lib.ts` DEFAULT_* + accessor pattern, `github_projects_lib.ts::isLegalTransition` (transition-throw pattern to mirror), `stark_session_lib.ts` injected-`run` pattern.

**Parallel with Phase 1 — audit the six §4 completion channels confirm-or-fix (feeds Phase 2 threading + Phase 6 stage fixes, does not block the state-machine core):** read each stage skill's completion output and record, per channel, whether the field forge's `record-output` needs is *already emitted* or *must be added*:

| §4 channel | Field forge needs | Verified source | If missing → fix (owner phase) |
|---|---|---|---|
| write-spec | `spec_path` + spec PR number | `WriteSpecReceipt.spec_path`; `write_spec_land` PR output | Add PR-number emission to `write_spec_land` output (Phase 6 task 1b) |
| review-spec / review-plan | adopted/opened artifact PR number | stage PR output | Add PR-number line if absent (Phase 6 task 1b) |
| red-team-spec / red-team-plan | artifact PR number + `fold_prs` | challenge PR output + `red_team_fold` fold-PR output | Add fold-PR-number emission if absent (Phase 6 task 1b) |
| **spec-to-plan** | **`plan_path` + `plan_slug` + plan PR number** | **today prints only an Output path, no authoritative `plan_slug`/PR, convention differs from spec** | **Make it the authoritative producer (Phase 6 task 1a) — blocking** |
| plan-to-tasks | `issue_numbers` | issue-create output | Add explicit `issue_numbers` emission on finish if absent (Phase 6 task 1b) |
| copilot | impl PR number(s) | copilot PR output | Add PR-number emission if absent (Phase 6 task 1b) |

The audit produces a written confirm-or-fix list in the PR; any channel marked "must be added" becomes a concrete Phase 6 task 1 subtask, not an assumption.

## 2.5 Global Constraints

- Language: **TypeScript only, no Python** (repo tooling is TS-only).
- Pure lib `forge_state_lib.ts` takes **no clock** — `Date.now()` is never called inside it; all timestamps host-supplied via an `at` parameter.
- Pure lib makes **no LLM calls, no git mutations, and no disk I/O** — every mutating lib function returns the **new `RunState`**; reading, writing, and pruning state files is the host CLI's (`tools/forge_state.ts`'s) job.
- **`persistState` / `loadState` / `resolveLatest` live in `tools/forge_state.ts`** (the host CLI), not in `forge_state_lib.ts`. Nothing in the pure lib imports `fs`, `stateRoot()`, or the write-spec history helpers.
- State files written **mode `0600`** under `stateRoot()`, never in the repo.
- Stage-name enum (closed): `write-spec`, `review-spec`, `red-team-spec`, `spec-to-plan`, `review-plan`, `red-team-plan`, `plan-to-tasks`, `copilot`.
- `StageArtifacts` is the spec's closed shape — `{spec_path?, plan_path?, plan_slug?, issue_numbers?}` — with **no added completion field**; `artifacts.issue_numbers` being recorded **is** plan-to-tasks's completion marker (spec §6).
- Resume-target `action` enum is exactly the spec's closed set: `reinvoke | advance | complete | merge_only | abandon`. No `resume_partial`.
- History path: `stateRoot()/history/forge/<slug>/<run-id>/state.json` with per-slug `latest` pointer, retention `history_keep_runs` (default `20`).
- `merge_timeout_s` default `1800`; forge is the single deadline owner.
- Slug is path-traversal-sanitized before forming a directory name.
- **Every §4 field forge records must be emitted by its producing stage.** Forge never reconstructs a path/slug/PR-number a stage should report. Where a stage does not yet emit it, the stage is changed (Phase 6 task 1) — the plan carries no "confirm the field exists" step without a paired "or fix it" branch.
- **spec-to-plan is the sole authoritative producer of `plan_path` and `plan_slug`.** plan-to-tasks and copilot consume the recorded `plan_slug`, never re-deriving it from a filename (the sole sanctioned filename read is the §4 import contract for a plan-path start where spec-to-plan is out of the chain).
- **Base sync is scoped to new-artifact stages only.** Exactly the three stages that begin a new artifact — `spec-to-plan`, `plan-to-tasks`, `copilot` — run `git switch <default-branch>` + `git pull --ff-only` as the first act of **every** transition into `running` (including `failed→running`/`halted→running` re-entry, so a `base_sync_failed` retry cannot bypass it); the stage skill is invoked only after the sync succeeds, and a failed sync → `running→failed` with `gate.reason = "base_sync_failed"`. The same-artifact continuation stages — `review-spec`, `red-team-spec`, `review-plan`, `red-team-plan` — and `write-spec` **never** sync; they run against the still-open shared PR branch. This is the spec `behavior` step 3f contract verbatim.
- Every skill honors `--help` via a `## Help` block referencing `standards/help.md`; frontmatter `name: stark-forge` matches the dir.
- Config accessed only via `getForgeConfig()`; state location only via `stateRoot()` — never hardcode `~/.claude/code-review/...`.
- **Exactly one crash attempt per crashed episode**, appended only by the reconciliation primitive; normal episode-end transitions append their own single attempt — the two paths never both fire for one episode.

## 3. Phases

---

## Phase 0: Feasibility spike + mode selection (gating)
**Goal:** Prove (or disprove) that forge, as a live skill, can invoke the stage skills in-session with `AskUserQuestion` gates reaching the operator — the spec's load-bearing feasibility gate — and **select `in-session` vs `driver` mode before any mode-dependent orchestration is built.**
**Dependencies:** none — this gates the mode-dependent work in Phases 5–6, not the mode-independent lib.
**Estimated effort:** S

### Tasks

1. **Two-stage in-session invocation spike**
   - What: from a live throwaway/spike skill (or a manual live driver), invoke `/stark-write-spec "<throwaway intent>"` then `/stark-review-spec <resulting-spec-path>` **in-session**, and confirm each stage's interactive gate (write-spec gap-fill `AskUserQuestion`, review growth-ack/ambiguous-fix asks) surfaces to the operator and its answer flows back into the running stage. This is the spec `open-questions` blocking spike, executed first.
   - Files: throwaway spike skill or documented manual live test; record the observed behavior (which gates surfaced, whether answers threaded) in the PR description.
   - Interfaces — **Produces:** a recorded verdict `in-session-works: true|false` that sets the default `mode` for Phase 6's skill (`"in-session"` or `"driver"`).
   - Acceptance: the verdict is recorded in the PR. **In-session works** → Phase 6 ships the in-session flow as primary (`mode` default `"in-session"`). **In-session fails** → Phase 6 ships `mode` default `"driver"` and the Phase 5 driver renderer is the primary execution path. Either branch is buildable on the same lib — the lib work (Phases 1–4) is unchanged by the outcome.

### Risks
- Spike is inconclusive (partial gate surfacing) → treat as failure and default to driver mode; the lib + CLI still deliver deterministic chain resolution, merge timing, and crash-resumable state (spec's "no branch leaves the operator worse off").

### Verification
- PR records the spike outcome and the selected default `mode` before Phase 6 wiring begins.

---

## Phase 1: State-machine core (pure lib)
**Goal:** The transition matrix, status model, attempts-archive semantics, record-output patch semantics, and the atomic crash-reconciliation primitive — fully tested with no I/O. Mode-independent.
**Dependencies:** none (may proceed in parallel with Phase 0; only Phases 5–6 consume the spike verdict)
**Estimated effort:** L

### Tasks

1. **Types + enums + `StageRecord`/run-object shapes**
   - What: define `Stage`, `RunState`, `StageRecord`, `Attempt`, `MergePoint`, `initial_artifacts`, `artifact_prs`, `input` shapes exactly per spec §5. `StageArtifacts` is the spec's closed shape — no completion boolean.
   - Files: `tools/forge_state_lib.ts` (new).
   - Interfaces — **Produces:** `type Stage`, `type StageStatus = "pending"|"running"|"halted"|"done"|"failed"`, `type RunState`, `type StageRecord`, `type MergePoint = {after_stage: Stage; artifact: "spec"|"plan"|"impl"}`, `type Attempt = {started_at: string; ended_at: string|null; outcome: "halted"|"failed"|"crashed"}`, `type StageArtifacts = {spec_path?: string; plan_path?: string; plan_slug?: string; issue_numbers?: number[]}`, `type PrReader = (pr: number) => "open"|"merged"|"closed"`.
   - Acceptance: types compile; no runtime code yet.

2. **`isLegalTransition(from,to)` + `transition()`**
   - What: closed matrix per spec §6 (`pending→running`; `running→{done,halted,failed}`; `halted→running`; `failed→running`; `done→∅`). `transition()` throws with the allowed-set in the message on illegal move (mirror `github_projects_lib.ts::isLegalTransition`). Compare-and-set via `expectedStatus`; re-issuing a transition whose `to` equals stored status is a **no-op reprint** preserving timestamps/attempts. **`transition()` owns the normal (non-crash) episode-end append only:** `running→halted` and `running→failed` each append exactly one `Attempt` (`outcome` = target status), `running→done` appends nothing, `halted/failed→running` appends nothing. It never appends `crashed` — that outcome is reachable only through `reconcileRunningStage` (task 6).
   - Interfaces — **Consumes:** the type shapes. **Produces:** `isLegalTransition(from: StageStatus, to: StageStatus): boolean`, `transition(state: RunState, args: {stage: Stage; expectedStatus?: StageStatus; to: StageStatus; prs?: number[]; foldPrs?: number[]; gate?: {reason: string; detail: string}; artifacts?: Partial<StageArtifacts>; at: string}, readPr?: PrReader): RunState`.
   - Test: `transition matrix: every illegal transition throws with the allowed set` (test #4) — asserts throw + message contains allowed set for `done→running`, `pending→done`, `running→pending`, etc. Plus no-op-reprint on same-status.
   - Acceptance: matrix test green.

3. **Attempts-archive + episode semantics (normal path)**
   - What: verify the append behavior wired into `transition` (task 2): one `Attempt` at normal episode end (`running→halted`, `running→failed`); `halted/failed→running` clears `gate`, resets `ended_at`, preserves `prs`/`fold_prs`/`artifacts`, appends **nothing**; `running→done` archives nothing.
   - Interfaces — **Consumes:** `transition()`. No new export.
   - Test: `attempts archive exactly once, at episode end — re-entry appends nothing` (test #5) — exact array asserted, length 1 per episode, no double append.
   - Acceptance: test #5 green.

4. **`recordOutput` patch semantics**
   - What: field-wise patch — omitted unchanged; arrays (`prs`, `fold_prs`, `issue_numbers`) **union dedup first-seen order**; `merges` keyed by `pr`, monotonic (`merged_by_forge: true` never overwritten by `false`); scalar artifacts (`spec_path`/`plan_path`/`plan_slug`) **write-once** → `artifact_conflict` on conflict; a PR contradicting the seeded `artifact_prs` entry → `adoption_mismatch`; identical re-report = no-op. No status change. Also seeds `artifact_prs[artifact]` the first time an opening stage reports its PR(s) (artifact derived via a `stageArtifact(stage)` helper).
   - Interfaces — **Produces:** `recordOutput(state: RunState, args: {stage: Stage; prs?: number[]; foldPrs?: number[]; merges?: {pr: number; merged_by_forge: boolean}[]; artifacts?: Partial<StageArtifacts>; at: string}): RunState`, `stageArtifact(stage: Stage): "spec"|"plan"|"impl"|null`.
   - Test: `record-output patch semantics: unions, write-once scalars, registry validation` (test #22) — includes `issue_numbers` union-dedup incremental persistence, write-once scalar `artifact_conflict`, and `adoption_mismatch` on a divergent PR.
   - Acceptance: test #22 green.

5. **`running→done` merge/marker gate**
   - What: a merge-point stage cannot reach `done` unless every `artifact_prs` PR for its artifact is merged (injected reader) and no `fold_prs` open; **`plan-to-tasks→done` requires `artifacts.issue_numbers` recorded (non-empty)** — the spec's completion marker; non-merge-point stages have no PR gate. Enforced inside `transition(..., readPr)`.
   - Interfaces — **Consumes:** `PrReader`. **Produces:** the gate check inside `transition`.
   - Test: `done requires all artifact PRs merged, no open fold at a merge point, and recorded issue_numbers for plan-to-tasks` (test #6) — includes plan-to-tasks `→done` failing when `issue_numbers` is absent/empty and succeeding when recorded.
   - Acceptance: test #6 green.

6. **`reconcileRunningStage` — the single atomic crash primitive**
   - What: the **one and only** writer of a `crashed` attempt. Given a stage currently `running` (a crash episode), it appends **exactly one** `Attempt{started_at, ended_at: null, outcome: "crashed"}` and applies the resolving transition **in the same call**, bypassing `transition`'s normal episode-end append so the episode is archived once, never twice. Resolving targets: `done` (reconciled — merge/PR gate and, for plan-to-tasks, the `issue_numbers` gate still enforced), `failed` (with `gate.reason`, e.g. `reconciled_after_crash`), or `halted` (with `gate.reason`, e.g. `merge_pending`/`fold_pr_open`/`author_pr_merged_early`). For a `→done` reconciliation it records each observed merge that has **no existing `merges` entry** as `{pr, merged_by_forge: false}` (monotonic — never demotes an existing `true`). Illegal target status throws.
   - Interfaces — **Consumes:** `RunState`, `PrReader`. **Produces:** `reconcileRunningStage(state: RunState, args: {stage: Stage; to: "done"|"failed"|"halted"; gate?: {reason: string; detail: string}; observedMerges?: {pr: number}[]; at: string}, readPr: PrReader): RunState`.
   - Test: `reconcile primitive appends exactly one crashed attempt and never double-archives` — for each target asserts `attempts[]` gained exactly one `crashed` entry with no `failed`/`halted` twin; a subsequent `failed→running` re-entry appends nothing (part of test #2/#5 assertions).
   - Acceptance: reconcile-primitive test green; grep confirms `outcome: "crashed"` is produced only inside `reconcileRunningStage`.

### Risks
- Two writers (`transition` + reconciliation) both archiving one episode → **eliminated by design**: `crashed` is producible only by `reconcileRunningStage`, and that primitive does the transition itself. The named test asserts the invariant.
- Getting monotonic `merges` attribution wrong silently miscredits externally-merged PRs → strict test #22 + reconcile-primitive assertions cover it.

### Verification
- `npm test` — tests #4, #5, #6, #22 + reconcile-primitive green; lib has zero imports of anything network/clock/disk.

---

## Phase 2: Chain, merge-point, threading resolution (pure lib)
**Goal:** Deterministic resolution of what a run does — chain from input+flags, merge points, per-stage command rendering, artifact threading.
**Dependencies:** Phase 1
**Estimated effort:** M

### Tasks

1. **Chain resolver**
   - What: default 6-stage / `--red-team` 8-stage insertion; `--from`/`--until` slicing; auto-detection (spec-path→`review-spec`, plan-path→`review-plan`, else intent→`write-spec`).
   - Interfaces — **Consumes:** `{inputKind: "intent"|"spec-path"|"plan-path"; redTeam: boolean; from?: Stage; until?: Stage}`. **Produces:** `resolveChain(args): Stage[]`.
   - Test: `chain resolution: red-team inserts + --from/--until slicing` (test #7).

2. **`mergePointsFor(chain)`**
   - What: pure — spec merge after last present of {review-spec, red-team-spec}; plan merge after last present of {review-plan, red-team-plan}; no merge for plan-to-tasks; one `impl` merge after copilot; chain ending at an author stage → no merge for that artifact.
   - Interfaces — **Consumes:** `Stage[]`. **Produces:** `mergePointsFor(chain: Stage[]): MergePoint[]`.
   - Test: `merge points: mergePointsFor derives one merge per artifact at the last touching stage` (test #8).

3. **Command renderer + threading (against verified §4 fields)**
   - What: render each stage's exact command from spec §2 table using recorded `artifacts`/`initial_artifacts`; `copilot --plan-slug` reads **spec-to-plan's** `plan_slug` only; both red-team commands carry `--fold`. The threading helper `nextInputFor` reads only the recorded `StageArtifacts` fields — it **assumes those fields are populated by the producing stage**, which Phase 6 task 1 guarantees by making each producer emit them (the confirm-or-fix audit from Prerequisites is the input to this task). No renderer path re-derives a path/slug the producing stage should report.
   - Interfaces — **Consumes:** `RunState`, `Stage`. **Produces:** `renderStageCommand(state: RunState, stage: Stage): string`, `nextInputFor(state: RunState, stage: Stage): StageArtifacts` threading helper.
   - Test: `artifact threading: each producer's reported path/slug is recorded and every stage command renders exactly` (test #10) — asserts `copilot --plan-slug` reads spec-to-plan's recorded `plan_slug` (never a filename re-derivation) and both red-team commands carry `--fold`.

### Risks
- Slug re-derivation leaking in → guarded: renderer reads only recorded/imported values (test #10 asserts copilot slug comes from spec-to-plan's `artifacts.plan_slug`).
- A producing stage not actually emitting the field the renderer reads → **not deferred**: closed by Phase 6 task 1 (spec-to-plan producer fix + §4 confirm-or-fix), keyed off the Prerequisites audit.

### Verification
- Tests #7, #8, #10 green.

---

## Phase 3: Host persistence, config, slug safety (host layer, `tools/forge_state.ts`)
**Goal:** Durable on-disk state — owned entirely by the host CLI module, reusing write-spec helpers; config section; slug safety. The pure lib stays disk-free.
**Dependencies:** Phase 1
**Estimated effort:** M

### Tasks

1. **`forge` config section**
   - What: `DEFAULT_FORGE = {history_keep_runs: 20, merge_timeout_s: 1800}` + `getForgeConfig()` in `stark_config_lib.ts` (mirror existing section pattern).
   - Files: `tools/stark_config_lib.ts`.
   - Interfaces — **Produces:** `getForgeConfig(): {history_keep_runs: number; merge_timeout_s: number}`.
   - Test: minimal assertion in the lib test that defaults resolve.

2. **Slug sanitization**
   - What: kebab, path-traversal-safe (no `/`, `..`, leading dot) — mirror `stark_session_lib.ts`/`stark_handover_lib.ts`. Pure function; lives in `forge_state_lib.ts` (no I/O).
   - Interfaces — **Produces:** `sanitizeSlug(raw: string): string`.
   - Test: `slug sanitization: a path-traversal intent cannot escape the history dir` (test #14).

3. **History persistence — in `tools/forge_state.ts` (host module), not the pure lib**
   - What: create `tools/forge_state.ts` and put the disk layer here so `forge_state_lib.ts` stays pure. `persistState`/`loadState`/`resolveLatest` **are defined in `tools/forge_state.ts`** and consume `writeJsonAtomic`/`updateLatestPointer`/`pruneRunDirs` from `write_spec_lib.ts` (do not reimplement) plus `asset_root_lib.ts::stateRoot()`. Write `state.json` under `stateRoot()/history/forge/<slug>/<run-id>/`, maintain the per-slug `latest` pointer, apply `history_keep_runs` retention, mode 0600. This file is built across two phases: **Phase 3 delivers persistence; Phase 5 adds the CLI subcommands to the same file.** The pure lib never imports it.
   - Files: `tools/forge_state.ts` (new — persistence half).
   - Interfaces — **Consumes:** `write_spec_lib.ts::{writeJsonAtomic, updateLatestPointer, pruneRunDirs}`, `asset_root_lib.ts::stateRoot()`, `forge_state_lib.ts` types. **Produces (all in `tools/forge_state.ts`):** `persistState(state: RunState): void`, `loadState(slug: string, runId?: string): RunState`, `resolveLatest(slug: string): string`.
   - Test: `atomic write leaves no partial state on failure` (#11), `retention prunes to history_keep_runs, keeps latest pointer` (#12), `state files are written 0600` (#15) — against the host functions with a temp `stateRoot()`.

### Risks
- write-spec helper signature drift → confirm in prereqs; adapt call-site rather than fork.
- Persistence leaking back into the pure lib → guarded: grep asserts `forge_state_lib.ts` imports no `fs`/`stateRoot`/history helper.

### Verification
- Tests #11, #12, #14, #15 green; grep confirms no reimplemented history helper and no disk import in `forge_state_lib.ts`.

---

## Phase 4: Reconciliation + resume-target (pure lib, injected reader)
**Goal:** Close the crash window — the correctness payoff.
**Dependencies:** Phases 1–3
**Estimated effort:** L

### Tasks

1. **`resumeTarget()` + reconciliation — returns reconciled state, not just a descriptor**
   - What: per spec `behavior` → Resume reconciliation. `resumeTarget` inspects the run; if the target stage is `running` (crashed), it calls `reconcileRunningStage` (Phase 1 task 6) and **returns the reconciled `RunState` alongside the target descriptor** so the caller can durably persist the mutation before acting. Branch logic: checkpoint-present vs absent decides `reinvoke` vs `merge_only`; merge-point stage queries each registry PR (via `readPr`) and passes observed merges into the primitive; non-merge-point author stage with an externally-merged PR → `author_pr_merged_early` halt → `action: abandon`; **plan-to-tasks via the `issue_numbers` marker** (task 4); a checkpoint-absent stage → `reconcileRunningStage(→failed, reconciled_after_crash)` then descriptor `action: reinvoke`. Read-only on git/GitHub (only `readPr` queries). **Re-entry ownership:** reconciliation always ends at `done`/`halted`/`failed` — the compare-and-set `halted/failed → running` re-entry belongs to the **resume executor** (SKILL.md in-session, or the operator-run driver block), never to `resumeTarget`; it is the first transition of every `reinvoke`/`merge_only` execution, so `record-output` and the final `--from running` transition always run against a `running` stage.
   - **Return shape:** `{state: RunState; target: {run_id: string; slug: string; target_stage: Stage; action: "reinvoke"|"advance"|"complete"|"merge_only"|"abandon"; reconciled: boolean}}`. `state` is the reconciled run state when `reconciled` is true, else the input unchanged. The pure lib performs **no persistence** — it hands the mutated state back for the CLI (Phase 5) to write.
   - Interfaces — **Consumes:** `PrReader`, `RunState`, `reconcileRunningStage`. **Produces:** `resumeTarget(state: RunState, readPr: PrReader): {state: RunState; target: ResumeTarget}`.
   - Test: #1 (merged→done/advance; author early-merge→abandon), #2 (checkpoint reinvoke vs merge_only), #3 (plan-to-tasks marker; task 4), #16 (multi-impl-PR merge_only), #17 (fold PR blocks then unblocks), #20 (crash-before-output every input kind); each asserts the **returned `state`** carries the reconciliation mutation.

2. **`abandon` semantics**
   - What: run-level `abandoned_at`; excluded from resume selection and `resumeTarget`; summary `status: abandoned`.
   - Interfaces — **Produces:** `abandonRun(state: RunState, at: string): RunState`, `selectResumeRun(runs: RunState[]): RunState|null`.
   - Test: `resume-target selects latest non-done, non-abandoned run` (#13), plus abandon path in #1.

3. **Gate/stop invariants**
   - What: a failed/halted stage stops the chain; resume target is that same stage; no downstream entry.
   - Test: `gate handling: a failed/halted stage stops the chain and is never auto-skipped` (#18).

4. **plan-to-tasks reconciliation via the `issue_numbers` marker (spec-conformant)**
   - What: reconcile a `running` `plan-to-tasks` stage by the spec's completion marker — `artifacts.issue_numbers` being recorded:
     - **`issue_numbers` recorded (non-empty)** → issues were created before the crash → `reconcileRunningStage(→done)` (the `done` gate re-checks the marker), advance — **no re-run** (spec §6/behavior).
     - **`issue_numbers` absent/empty** → nothing recorded → `reconcileRunningStage(→failed, reconciled_after_crash)`, `action: reinvoke` (the resume executor performs the `failed → running` re-entry — task 1's re-entry ownership rule; reconciliation itself never re-enters). Re-invocation is `/stark-plan-to-tasks <plan-path>` (its documented `<path>` form); duplicate protection is the stage's own title-dedup **on that bare re-entry path**, confirmed or implemented by Phase 6 task 2 (a build gate, not an assumption). Forge introduces **no skip-set flag** — none exists in the documented stage contract.
   - Interfaces — **Consumes:** `resumeTarget`, `reconcileRunningStage`, recorded `artifacts.issue_numbers`. No new export (branch inside `resumeTarget`).
   - Test: `reconcile: running plan-to-tasks resolves via the issue_numbers marker` (#3) — recorded → `done` no re-run; absent → `failed→running`/`reinvoke`.

### Risks
- Reconciliation mutating state that never gets persisted → **eliminated by the `{state, target}` return**: the mutation is handed to the caller, and the CLI's `resume-target` (Phase 5 task 4) persists it before printing.
- The narrow "issues created but `issue_numbers` not yet recorded" window → **closed by Phase 6 task 2 as a build gate** (title-dedup confirmed or implemented with a crash-window test), not assumed.

### Verification
- Tests #1, #2, #3, #13, #16, #17, #18, #20 green.

---

## Phase 5: `forge_state.ts` CLI — argv bridge, validation, summary, driver renderer
**Goal:** The operator/skill surface over the lib, added to the same `tools/forge_state.ts` that holds persistence. Its `resolve` subcommand bridges raw `/stark-forge` arguments to validation/resolution/dry-run; `resume-target` persists reconciled state before printing. The driver renderer is built here so both spike outcomes have their execution surface ready.
**Dependencies:** Phases 1–4
**Estimated effort:** M

### Tasks

1. **`resolve` subcommand — the SKILL.md → library bridge**
   - What: the callable entry the SKILL.md invokes with the raw forge argv. In one call: (a) `validateArgs(argv)` — every spec §1 invalid-combination row fails-fast with the exact `error.code`, non-zero exit, **zero state writes**, and (under `--json`) a single stdout error object per §9 with narration on stderr; (b) on valid args, resolves `inputKind` (auto-detect + `--from`/`--until`), `resolveChain`, `mergePointsFor`, the sanitized slug, and the `initial_artifacts` import for path-based starts (`plan_slug` from the `docs/plans/YYYY-MM-DD-<slug>-plan.md` filename, else `plan_slug_unresolved`); (c) for `--dry-run`, renders the §9 `dry_run` summary (resolved `chain` + `merge_points` + per-stage commands via `renderStageCommand`) and exits **without persisting**; (d) otherwise prints a resolved-init descriptor the SKILL.md feeds straight into `init`. Human narration → stderr; machine payload → single stdout JSON object under `--json`.
   - Files: `tools/forge_state.ts` (CLI half added to the file created in Phase 3).
   - Interfaces — **Consumes:** `validateArgs`, `resolveChain`, `mergePointsFor`, `sanitizeSlug`, `renderStageCommand`, `buildSummary`. **Produces:** the `resolve` subcommand + `validateArgs(argv: string[]): {ok: true; resolved: ResolvedRun} | {ok: false; error: {code: string; message: string}}`.
   - Test: `CLI validation: every invalid combination fails-fast with its error.code and writes no state` (#9) — drives each §1 row through `resolve`, asserts exit code, `error.code`, no run dir created, and the `--json` error shape; plus `resolve --dry-run` renders the §9 `dry_run` object and creates no run dir.
   - Acceptance: #9 green; `resolve --dry-run --json` emits exactly one stdout object with `status: "dry_run"` and creates zero files.

2. **State-mutating subcommands**
   - What: `init`, `record-output`, `transition`, `get`, `abandon`, `summary` per spec §7; JSON stdout; injected PR-state reader (real `gh pr view --json state,mergedAt` wrapper, injectable for tests). Timestamps `--at` host-supplied. Each wraps the corresponding pure-lib function and persists the returned `RunState` via `persistState` (Phase 3). `record-output` accepts `--artifact-issue-numbers <csv>` (spec §7) — **no `--issue-creation-complete` flag**; recording `issue_numbers` is the completion marker.
   - Interfaces — **Consumes:** all Phase 1–4 lib exports, `persistState`/`loadState` (Phase 3).
   - Test: exercised via lib tests + a `--help` smoke (skill_smoke_test picks up the CLI).

3. **`--json` summary + `red_team` derivation**
   - What: spec §9 schema; `red_team` **derived from chain**; `merged_prs` only `merged_by_forge:true` in merge order; `open_fold_prs` filtered through reader; `dry_run`/`error` shapes.
   - Interfaces — **Produces:** `buildSummary(state: RunState, readPr: PrReader): SummaryObject`.
   - Test: `--json summary shape matches §9 for completed, halted, and failed runs` (#19).

4. **`resume-target` subcommand — persists reconciled state before printing**
   - What: loads the selected run (`selectResumeRun` for no-arg, `--slug` otherwise), calls `resumeTarget(state, readPr)`, and — when `target.reconciled` is true — **`persistState(returned.state)` before printing** the `target` descriptor, so a subsequent resume can never repeat reconciliation or lose an observed merge record. Prints the descriptor (action ∈ the spec's closed enum) as one stdout JSON object; narration on stderr.
   - Interfaces — **Consumes:** `resumeTarget`, `persistState`, `loadState`, the `gh pr view` reader.
   - Test: `resume-target persists reconciliation before printing` — a run with a crashed merge-point stage; first call reconciles + writes; a second `loadState` shows the stage already resolved (one `crashed` attempt, not two) and the second call is a no-op reprint. Complements #1/#2/#3.

5. **Driver-mode command-block renderer**
   - What: emit stage command + `record-output` + `transition` (carrying `--from`). **Every `reinvoke`/`merge_only` block opens with the compare-and-set re-entry** (`transition --from failed|halted --to running`) — the Phase 4 task 1 re-entry ownership rule — so everything after it runs against a `running` stage. Then, for a **new-artifact stage** (spec-to-plan/plan-to-tasks/copilot), the block prints the base-sync (`git switch <default-branch>` + `git pull --ff-only`) and the `transition running→failed --gate-reason base_sync_failed` fallback — re-entry included, so a retried new-artifact stage never skips its sync; for a merge-point stage the block inserts fold-check + per-PR `/stark-gh:pr-merge` + `--merges` recording; the `merge_only` block omits the stage command. Same-artifact stages omit the base-sync lines.
   - Interfaces — **Consumes:** `renderStageCommand`, `resumeTarget`. **Produces:** `renderDriverBlock(state: RunState, target: ResumeTarget): string`.
   - Test: `driver mode emits exact command blocks and advances only on reported transitions` (#21) — asserts new-artifact stages carry the base-sync lines and same-artifact stages do not.

### Risks
- Import contract for path starts reading a filename slug — bounded to `resolve` init-time only; validation refuses (`plan_slug_unresolved`) rather than starting an unfinishable chain (test #9).

### Verification
- Tests #9, #19, #21 + `resume-target persists reconciliation` green; `forge_state.ts --help` exits clean under smoke test.

---

## Phase 6: Stage-output conformance, plan-to-tasks dedup closure (build gate), skill, docs, live run
**Goal:** Make every §4 completion channel actually emit the field forge records (including the spec-to-plan producer fix), close the blocking plan-to-tasks duplicate-issue window as a build gate, wire the orchestrator skill in the mode the Phase 0 spike selected, and run end-to-end.
**Dependencies:** Phases 0–5
**Estimated effort:** M

### Tasks

1. **Stage-output conformance — make §4 producers emit what forge records (confirm-**or-fix**)**

   **1a. spec-to-plan authoritative producer (BLOCKING — §4 SSOT).**
   - What: `skill/stark-spec-to-plan/SKILL.md` today prints a plan Output path but **no authoritative `plan_slug`, no plan PR number, and uses a path convention differing from the spec's `docs/plans/YYYY-MM-DD-<slug>-plan.md`.** Change the skill so, on successful plan landing, it prints a **single machine-readable completion line** carrying the three fields forge threads: the plan path (in the spec's convention), the `plan_slug` it derived from the spec slug, and the plan PR number it opened/adopted. `plan_slug` is derived once from the spec slug in the skill (its authoritative owner) and printed verbatim — not left to any downstream re-derivation. Reconcile the skill's plan-path convention to `docs/plans/YYYY-MM-DD-<slug>-plan.md` so the printed path, the on-disk path, and the spec's import convention (§4 path-based start) agree.
   - Files: `skill/stark-spec-to-plan/SKILL.md`; the dispatcher/lib it prints from if the path/slug is emitted there (`tools/plan_dispatch.ts` / `plan_dispatch_lib.ts` — inspect which owns the final print); any `plan_dispatch` test asserting the output shape; the spec-to-plan skill doc/CLAUDE.md line describing its output.
   - Interfaces — **Consumes:** the spec slug (from the spec path). **Produces:** a spec-to-plan completion line exposing `plan_path`, `plan_slug`, `plan_pr` that forge reads into `record-output --stage spec-to-plan --artifact-plan-path … --artifact-plan-slug … --prs <plan_pr>`.
   - Test: `spec-to-plan reports authoritative plan_path + plan_slug + plan PR in the spec convention` — a plan_dispatch test (or a golden-output assertion) confirming the completion line carries all three fields, the path matches `docs/plans/YYYY-MM-DD-<slug>-plan.md`, and `plan_slug` equals the spec-slug derivation (not a plan-filename re-parse).
   - Acceptance: spec-to-plan emits the three fields; forge's `record-output` for the spec-to-plan stage consumes them with no filename re-derivation; test green.

   **1b. Confirm-or-fix the other five §4 channels.**
   - What: for each remaining channel from the Prerequisites audit — write-spec (`spec_path` + spec PR from `write_spec_land`), review-spec/review-plan (adopted/opened PR number), red-team-spec/red-team-plan (artifact PR + `fold_prs`), plan-to-tasks (`issue_numbers` on finish), copilot (impl PR number(s)) — **confirm the field is emitted; if not, add the emission** to that stage's output. Each channel marked "must be added" in the audit becomes a concrete edit here (e.g. add the plan/spec PR number to `write_spec_land`'s printed output; add fold-PR-number emission to `red_team_fold`'s output if absent). Record the confirm-or-fix disposition per channel in the PR.
   - Files: whichever of `tools/write_spec_land.ts` / `stark_review_doc.ts` / `red_team_fold.ts` / the plan-to-tasks skill / copilot skill require an added emission (only those the audit flagged); their tests/docs in the same change.
   - Interfaces — **Produces:** for each channel, the exact reported field forge's `record-output` reads (§4 completion-output-sources list).
   - Test: for any channel that required a code change, a golden-output/assertion test that the field is now emitted; channels already emitting need only the recorded PR disposition.
   - Acceptance: every §4 field forge records is emitted by its producing stage; no forge code path reconstructs a stage-owned path/slug/PR-number; dispositions recorded in the PR.

2. **plan-to-tasks duplicate-issue crash window — confirm dedup or implement it (BLOCKING BUILD GATE — success criterion 5)**
   - What: inspect the exact plan-to-tasks issue-creation path — `skill/stark-plan-to-tasks/SKILL.md`'s Pass-2 `gh issue create` code path (and `tools/plan_to_tasks_validate_lib.ts`) — and determine empirically whether issue creation **dedups by title on re-run**, and how `--cleanup <slug>` behaves.
     - **Branch A — title-dedup confirmed on the actual re-entry path** (re-invoking bare `/stark-plan-to-tasks <plan-path>` — the exact command crash reconciliation issues, with **no `--cleanup`** — skips issues whose titles already exist): the crash window is closed by the existing contract. Record the observed behavior in the PR and proceed to task 3. `--cleanup <slug>` does **not** qualify — reconciliation never passes it, so cleanup cannot prevent the duplicate on the re-run that actually happens.
     - **Branch B — title-dedup NOT confirmed:** the closure is not spec-conformant without a stage change. **Do not proceed to task 3 with a bare follow-up + known-gap note** — that does not satisfy criterion 5. Instead, **implement the dedup here**: add a titled `gh issue list --search "in:title <exact title>"` pre-check to plan-to-tasks's Pass-2 create path so an existing-title issue is skipped (idempotent re-run), **with a crash-window test** proving that re-invoking `/stark-plan-to-tasks <plan-path>` after a marker-absent crash creates zero duplicate issues when the titles already exist. Forge invents no skip-set flag — the fix lives in plan-to-tasks itself, matching the documented `<path>`/`--cleanup` contract.
     - **Hard gate:** the build does **not** advance to task 3 (SKILL.md wiring) or task 5 (live run) until Branch A is confirmed **or** Branch B is implemented and its crash-window test is green. A filed follow-up alone does not unblock Phase 6.
     - Forge records `issue_numbers` via `record-output --stage plan-to-tasks --artifact-issue-numbers <csv>` **when the skill reports it finished creating all issues** (the spec's completion marker), so a crash mid-creation leaves `issue_numbers` unrecorded and reconciliation re-invokes — safely, because the re-invocation is now dedup-protected.
   - Files: read `tools/plan_to_tasks_validate_lib.ts`, `skill/stark-plan-to-tasks/SKILL.md`; under Branch B, edit the Pass-2 create path + add `plan_to_tasks_dedup.test.ts` (or extend the existing test file) with the crash-window test.
   - Interfaces — **Consumes:** `record-output --artifact-issue-numbers` (spec §7), the `issue_numbers`-marker reconcile (Phase 4 task 4). **Produces:** either a recorded confirmation (Branch A) or the titled-pre-check dedup in plan-to-tasks (Branch B).
   - Test (Branch B): `plan-to-tasks re-run after marker-absent crash creates no duplicate issues` — simulate an existing-title issue set, re-invoke the create path, assert zero new issues. Plus `plan-to-tasks marker: absent issue_numbers reconciles to reinvoke, recorded reconciles to done` (pairs with #3/#6).
   - Acceptance: Branch A confirmed-and-recorded, or Branch B implemented with the crash-window test green; only then is the phase permitted to continue.

3. **`skill/stark-forge/SKILL.md`**
   - What: thin orchestrator — `## Help` block → `standards/help.md`; frontmatter `name: stark-forge`; resolvable tool refs (`tools/forge_state.ts`). Flow: call `forge_state.ts resolve <argv>` (validation + resolution + dry-run bridge) → `init` from the resolved descriptor → per stage:
     - `transition pending→running`;
     - **if the stage is `spec-to-plan`, `plan-to-tasks`, or `copilot`**: base-sync as the first act (`git switch <default-branch>` + `git pull --ff-only`); on failure `transition running→failed --gate-reason base_sync_failed` and stop. **Same-artifact stages (review-spec, red-team-spec, review-plan, red-team-plan) and write-spec skip the sync** and run against the shared PR branch;
     - execute the stage's `/stark-...` command in-session (or, in driver mode, print the Phase 5 driver block and stop for the operator);
     - `record-output` the reported artifacts/PRs from the stage's now-verified completion channel (spec-to-plan: `plan_path`+`plan_slug`+plan PR per task 1a; plan-to-tasks: the `issue_numbers` completion marker on finish);
     - **at a merge point only**: merge the artifact PR(s) via `/stark-gh:pr-merge` bounded by `merge_timeout_s`, recording each `--merges` result;
     - `transition running→done` → advance;
     - on resume, call `resume-target` and act on its `action` (`reinvoke`/`advance`/`complete`/`merge_only`/`abandon`); for `reinvoke`/`merge_only`, **first apply the compare-and-set `halted/failed → running` re-entry** (the resume executor owns it — Phase 4 task 1), then the base-sync when the target is a new-artifact stage, then the stage command (or, for `merge_only`, only the merge retry); never auto-accept/auto-skip.
     The default `mode` is the Phase 0 spike verdict (`in-session` if it worked, else `driver`).
   - Interfaces — **Consumes:** `forge_state.ts` subcommands (`resolve`/`init`/`record-output`/`transition`/`resume-target`/`summary`), `/stark-gh:pr-merge`, the six stage skills (with the task-1 output fixes in place).
   - Acceptance: passes `skill_smoke_test.test.ts` (frontmatter, name-matches-dir, tool refs resolve, referenced CLIs `--help` clean).

4. **Docs in the same change**
   - What: add `/stark-forge` entry to repo `CLAUDE.md` + `AGENTS.md` pipeline sections; note the new `forge` config section and `forge_state{,_lib}.ts` tools, the `resolve` argv-bridge subcommand, the pure-lib-vs-host persistence split, the base-sync scoping (new-artifact stages only), the spec-to-plan authoritative-producer output change (task 1a), and — under Branch B — the plan-to-tasks title-dedup addition.
   - Files: `CLAUDE.md`, `AGENTS.md`; the spec-to-plan and (Branch B) plan-to-tasks skill doc lines already updated in tasks 1–2.
   - Acceptance: entries present, accurate.

5. **Live run (repo "test live" rule)**
   - What: run `/stark-forge --dry-run --json "<intent>"` (assert zero side effects, one stdout JSON object, narration on stderr), then a real `/stark-forge "<intent>"` end-to-end (or driver-mode equivalent if the spike failed). Verify success criteria 1–7 by inspection of `state.json` and the merged PRs — including that spec-to-plan's completion line threaded `plan_slug` into `copilot --plan-slug` with no filename re-derivation, and that a killed-and-resumed plan-to-tasks stage created no duplicate issues.
   - Acceptance: spec PR merged once after last spec stage, plan PR once after last plan stage, plan-to-tasks no merge, impl PR(s) merged last; `--resume` continues a killed run without re-doing merged stages; base-sync fires only for spec-to-plan/plan-to-tasks/copilot; no duplicate issues on a resumed plan-to-tasks.

### Risks
- Spike (Phase 0) selected driver mode → this phase wires driver as primary; already designed and tested (#21), no loss of core value.
- Shared-PR adoption drift (review stage opens a 2nd PR) → `adoption_mismatch` detects it; confirm each review/red-team skill adopts by branch during this phase (open-question owner: implementer).
- spec-to-plan output change breaks an existing plan_dispatch consumer → guarded by updating the plan_dispatch output test in task 1a and keeping the completion line additive (new machine-readable line, existing human output preserved).
- plan-to-tasks dedup unconfirmed → **Branch B implements it with a crash-window test; the build gate forbids advancing without confirmation or implementation** (criterion 5 honored, not deferred).

### Verification
- `npm test` fully green (incl. task 1a/1b output tests and, under Branch B, the plan-to-tasks crash-window test); smoke test green; live `--dry-run --json` clean; live end-to-end satisfies success criteria 1–7.

## 4. Integration Points

- **`forge_state.ts resolve` ↔ SKILL.md:** the executable bridge — SKILL.md passes raw `/stark-forge` argv to `resolve`, which validates, resolves the chain/merge points, renders dry-run, and returns the init descriptor. The stdout/stderr contract is owned here.
- **`forge_state_lib.ts` ↔ `forge_state.ts`:** the pure lib returns mutated `RunState`; the host module owns `persistState`/`loadState`/`resolveLatest` and is the sole disk writer. The lib imports nothing disk/clock/network.
- **`forge_state.ts` ↔ stage skills:** the skill reads each stage's completion channel (spec §4) and calls `record-output`/`transition`. **The channels are made real in Phase 6 task 1** — spec-to-plan emits authoritative `plan_path`+`plan_slug`+plan PR; every other channel is confirmed-or-fixed to emit its §4 field. Forge reads what they now report; plan-to-tasks reports its created `issue_numbers` on finish (the completion marker), consumed via the documented `--artifact-issue-numbers` flag, with re-run duplicate protection guaranteed by Phase 6 task 2.
- **`forge_state.ts` ↔ `/stark-gh:pr-merge`:** one invocation per artifact PR, bounded by `merge_timeout_s` (forge is the single deadline owner).
- **`forge_state.ts` ↔ `write_spec_lib.ts`:** the host module consumes the three history helpers — shared owner of history-dir layout, atomic write, latest-pointer, retention.

## 5. Testing Strategy

Playground-proportional: the entire deterministic surface (state machine, atomic reconciliation primitive, resume reconciliation incl. the `issue_numbers`-marker plan-to-tasks path, chain/merge resolution, CLI validation + argv bridge, threading, host persistence, permissions, summary, driver renderer with base-sync scoping, slug safety) is unit-tested in `forge_state_lib.test.ts` under `node:test`/`npm test`, PR-state reader injected → zero network. That's tests #1–#22 plus the reconcile-primitive, `resume-target persists reconciliation`, and the plan-to-tasks marker test mapped above. **Two stage-side tests land alongside:** `spec-to-plan reports authoritative plan_path + plan_slug + plan PR` (Phase 6 task 1a), and — under Branch B — `plan-to-tasks re-run after marker-absent crash creates no duplicate issues` (Phase 6 task 2, the crash-window test success criterion 5 requires). No integration/E2E pyramid — the stage skills own their remaining coverage. Live-only checks (the Phase 0 in-session spike, real merge-when-green, dry-run non-mutation, JSON stream separation, driver fallback) are cheap manual assertions per the repo's "test live" rule.

Write tests first per task (TDD) — each test names the break scenario it guards, mirroring the spec's test-plan.

*(Rollback Plan and dedicated infra-provisioning sections omitted — playground tier: no cloud infra, no shared state, no migrations; a `git revert` of the branch and deleting a local `state.json` fully undoes any run.)*
