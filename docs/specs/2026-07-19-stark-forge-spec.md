# `/stark-forge` — Pipeline Orchestrator Skill

## intent — Intent & Soundness

**Problem.** The stark-skills repo has a complete spec→plan→implementation pipeline, but it is six discrete skills (eight with red-team) that a human must run one after another: invoke `/stark-write-spec`, read its receipt for the spec path, invoke `/stark-review-spec` (which adopts write-spec's PR), un-draft and merge that spec PR, invoke `/stark-spec-to-plan`, thread the plan path forward, review and merge the plan PR, and so on down to `/stark-copilot`. The artifact threading is manual and error-prone (which receipt field holds the plan slug?), the merges happen at non-obvious points (once per artifact, *not* once per stage), and a crash mid-chain leaves no record of how far the run got — the operator restarts from memory.

**Solution.** `/stark-forge` is a **thin in-session orchestrator** that runs the existing chain end-to-end, one stage after another, autonomously, with a resumable state file. It is a *conductor* over the six existing skills — it does not re-implement any stage, add a dispatcher, or introduce a new quality layer. Each stage keeps its own dispatcher, gates, circuit breakers, and analytics untouched. Forge's only new machinery is a state manager (`tools/forge_state.ts` + `tools/forge_state_lib.ts`) that records per-stage progress atomically so a crash loses nothing.

**The pipeline is paired author→review stages sharing one PR per artifact, not a merge after every stage.** This is the design's load-bearing correctness fact and every other section is consistent with it:

- **write-spec** opens a **draft spec PR** (branch `write-spec/<slug>`). **review-spec** *adopts that same PR in place* (posts findings, fixes, resolves threads); with `--red-team`, **red-team-spec** also edits that same spec PR in place. The **spec PR is merged exactly once** — after the last spec stage in the chain completes.
- **spec-to-plan** opens a **plan PR**. **review-plan** (and, with `--red-team`, **red-team-plan**) adopt that same plan PR in place. The **plan PR is merged exactly once** — after the last plan stage.
- **plan-to-tasks** produces **GitHub issues, no mergeable PR** — it has no merge step.
- **copilot** produces the terminal **implementation PR(s)**, merged last.

Forge therefore merges at **artifact boundaries** (spec PR, plan PR, implementation PR), not after each of the six/eight stages. Between an author stage and its review stage there is no merge — they collaborate on one open PR.

**Why this design over the alternatives.**
- **In-session execution, not headless `claude -p` children.** The stage skills' interactive gates (`AskUserQuestion` for write-spec gap-fill, review growth-ack, ambiguous-fix asks) can only reach the operator from the *live* session. A headless child could not surface a gate; it would either block forever or auto-answer — both unacceptable. The stage dispatchers already background their heavy LLM work, so running them in-session keeps context manageable. Rejected: a headless multi-session engine.
- **No TS pipeline engine.** Re-implementing the skill layers in TypeScript would duplicate six dispatchers and drift from them. Forge trusts each stage's own contract. The only new TS is the state manager, which performs **no LLM calls and no git mutations**. Rejected: a machine-readable gate contract bolted onto every stage skill.
- **Merge each *artifact* PR when green, then run the next artifact's stages from updated `main`.** This matches the repo's standing "merge straight to main once the PR is green" playground rule, preserves each artifact's full PR review trail (author + review + red-team all on one PR), and avoids open-PR sprawl across a run.

**Feasibility gate (the load-bearing assumption).** The design's soundness rests on one capability that is not yet proven: forge, running as a live skill, can invoke `/stark-write-spec`, `/stark-review-spec`, … as in-session slash-commands whose interactive gates (`AskUserQuestion`) reach the operator. The rest of the design — chain resolution, merge-point derivation, crash-resumable state — is deterministic and independently sound, but the *autonomous end-to-end run* depends on this capability. The spec therefore makes the assumption explicit and **gates the build on it: a two-stage spike (write-spec → review-spec) must prove in-session invocation before the full chain is implemented** (tracked as the blocking open question). If the spike succeeds, the design solves the problem as stated. If it fails, forge degrades — with no loss of core value — to a **documented driver mode**: it still resolves the chain, derives the merge points, and owns the resumable state file exactly as designed, but instead of invoking each stage it prints the next exact command + resolved artifact path for the operator to run, advancing state as the operator reports completion. Either branch delivers deterministic chain resolution, correct merge timing, and crash-resumable progress — the problem is solved in the proven case and materially eased (not abandoned) in the unproven one. That is what makes the design sound despite the open feasibility question: no branch leaves the operator worse off than today's fully-manual chain. The driver-mode protocol is specified concretely in `behavior` → Driver mode (activation via the run-level `mode` field, the printed-command + operator-run `record-output`/`transition` reporting loop, and the per-stage result fields required to advance), so the fallback is buildable, not merely named.

**Success criteria** (objective — an engineer can determine correctness):
1. `/stark-forge "<intent>"` runs write-spec → review-spec → spec-to-plan → review-plan → plan-to-tasks → copilot; merges the **spec PR** after review-spec, the **plan PR** after review-plan, does **not** merge between an author stage and its paired review stage, treats plan-to-tasks as issue-producing (no merge), and ends by merging the implementation PR(s) from copilot.
2. Given an existing `docs/specs/*-spec.md` path, the run starts at review-spec; given a `docs/plans/*-plan.md` path, at review-plan. `--from`/`--until` override.
3. `--red-team` inserts red-team-spec (with `--fold`) after review-spec and red-team-plan (with `--fold`) after review-plan; the spec PR then merges after red-team-spec and the plan PR after red-team-plan (the last stage touching each artifact).
4. After every stage transition, `state.json` reflects the new status atomically; killing the session and running `/stark-forge --resume` continues from the halted/failed/running stage without re-doing completed, merged stages.
5. A stage found `running` at resume is reconciled before any re-invocation: artifact PR(s) merged → `done`; execution checkpointed but merge incomplete → `merge_only` retry of the merge **without re-invoking the stage**; no checkpoint → re-entered idempotently. No blind re-runs, no duplicate side effects.
6. Forge never auto-accepts a gate on the operator's behalf and never skips a failed stage to continue.
7. If in-session invocation is unavailable, `/stark-forge` still resolves the chain, derives the merge points, and drives the run in documented **driver mode** (prints the next command + resolved path, advances state on operator-reported completion) — it never silently no-ops.

**Assumptions.**
- Every stage skill is **create-or-adopt idempotent**: a re-run adopts the existing branch/PR, commits on top, and never force-pushes. review-spec and red-team-spec adopt the write-spec spec PR; review-plan and red-team-plan adopt the spec-to-plan plan PR. Forge's resume safety depends on this existing contract.
- `/stark-gh:pr-merge` owns the un-draft → wait-for-CI-green → squash-merge flow. Forge invokes it once per artifact PR, does not reimplement it.
- Stage completions surface the artifact path/slug forge needs to thread forward: write-spec exposes `spec_path` in its receipt JSON; **spec-to-plan is the single authoritative producer of both the plan path and the plan slug** (it derives them from the spec slug via the `docs/plans/YYYY-MM-DD-<slug>-plan.md` convention and reports them on completion); plan-to-tasks and copilot **consume** that reported plan slug — they do not re-derive it.

## scope — Scope & Boundaries

**Tier: Playground.** Single-user personal tooling — forge orchestrates the stark-skills repo's own pipeline, for the repo's sole author. It is not a product. The absence of monitoring/alerting, HA, auth hardening, budget circuit-breakers, notification integrations, and scheduling is **correct restraint**, not a gap. The repo's standing quality bar still applies: per-run crash-proof state, unit tests for the new TS lib, docs updated in the same change.

**In scope (V1):**
- `skill/stark-forge/SKILL.md` — the thin orchestrator skill, with the standard `## Help` block referencing `standards/help.md`, frontmatter `name: stark-forge` matching the dir, and resolvable tool references.
- `tools/forge_state.ts` (CLI) + `tools/forge_state_lib.ts` (pure library) + `tools/forge_state_lib.test.ts` (unit tests).
- The state manager: per-run history under `stateRoot()/history/forge/<slug>/<run-id>/state.json` with a `latest` pointer and `history_keep_runs` retention, reusing write-spec's exported history helpers where practical.
- A minimal `forge` config section (`{history_keep_runs, merge_timeout_s}`).
- Docs: repo `CLAUDE.md` + `AGENTS.md` pipeline sections gain the `/stark-forge` entry, in the same change.

**Out of scope (binding V1 boundary — "What this is NOT"):**
- **NOT a headless multi-session engine** — no `claude -p` child sessions per stage, no per-stage machine-readable gate contract added to the stage skills.
- **NOT a new review/quality layer** — forge adds no findings, breakers, or analytics of its own; it trusts each stage's.
- **NOT a replacement for `/stark-phase-execute`** — copilot is the terminal implementation stage; phase-execute is deliberately not in the chain.
- **NO stage pass-through flags** at V1 — no `--lead`/`--wing`/`--fable`/`--model`/`--max-rounds` forwarding matrix. Stage tuning stays in each stage's own config section.
- **NO cross-stage parallelism** — the chain is strictly sequential by design; each stage consumes the previous stage's artifact (merged, for cross-artifact transitions; the open shared PR, within a paired author→review pair).

The deferred concerns above are safe to defer even undeveloped: forge with a minimal CLI and sequential chain is a complete, usable tool; the deferred machinery would add complexity a single operator does not need.

## interfaces — Interfaces & Contracts

### 1. The `/stark-forge` CLI (skill entry point)

```
/stark-forge <path|"intent"> [--red-team] [--from STAGE] [--until STAGE]
             [--resume [slug]] [--dry-run] [--json]
```

| Arg | Type | Required | Meaning |
|-----|------|----------|---------|
| positional | string | yes (unless `--resume`) | Either a free-text intent (→ full chain from write-spec) or an existing artifact path. |
| `--red-team` | flag | no | Insert `red-team-spec --fold` after `review-spec` and `red-team-plan --fold` after `review-plan`. Default off. Mutually exclusive with `--resume` (a resumed run replays its stored chain). |
| `--from STAGE` | enum | no | Force the chain to start at STAGE, overriding auto-detection. |
| `--until STAGE` | enum | no | Force the chain to stop after STAGE (inclusive). |
| `--resume [slug]` | optional-arg flag | no | No arg → resume the latest non-`done` run. With `slug` → resume that slug's latest run. Mutually exclusive with a positional, `--from`, and `--until`. |
| `--dry-run` | flag | no | Print the resolved stage list + resolved merge points + exact per-stage commands and run nothing — no branch, no state file, no LLM. |
| `--json` | flag | no | Emit the machine-readable final summary (§9) on stdout; narration goes to stderr. |

**Stage-name tokens** (the closed enum for `--from`/`--until`, and the `stage` field in state):
`write-spec`, `review-spec`, `red-team-spec`, `spec-to-plan`, `review-plan`, `red-team-plan`, `plan-to-tasks`, `copilot`.

**Input auto-detection** (overridden by `--from`):
- Matches `docs/specs/*-spec.md` on disk → start at `review-spec`.
- Matches `docs/plans/*-plan.md` on disk → start at `review-plan`.
- Any other string (including a non-existent path) → treated as free-text intent → start at `write-spec`.

A path is only classified as an artifact if it is a **clean renderable token** (`isRenderableArg` — §2 argument transport: no whitespace, quotes, backslashes, or a leading `-`), because an imported artifact path is threaded **bare** into the entry stage's command. A path that exists on disk as a `*-spec.md`/`*-plan.md` but is not a renderable bare token (e.g. it contains whitespace) is **not** silently re-classified as intent — it fails fast at classification (`input_path_unsafe`), rather than being accepted and then failing unrenderable at the first command. This narrows the import grammar to exactly what the renderer can emit.

**Invalid argument combinations (fail-fast before any state write, non-zero exit, `error.code` given):**

| Combination | `error.code` | Reason |
|-------------|--------------|--------|
| `--resume` **and** a positional | `resume_with_positional` | Resume targets a stored run; a positional would start a new one. |
| `--resume` **and** `--from`/`--until` | `resume_with_slice` | A resumed run replays its stored `state.chain`; slicing is fixed at init and cannot be re-sliced. |
| `--resume` **and** `--red-team` | `resume_with_red_team` | Red-team membership is fixed in the stored `state.chain` at init; a resume cannot add or remove stages. |
| `--from` X **and** `--until` Y with X after Y in the resolved order | `empty_chain` | Produces an empty chain. |
| `--from`/`--until` names a stage **not present** in the resolved chain (e.g. `--until red-team-spec` without `--red-team`) | `stage_not_in_chain` | The named stage does not exist for this run. |
| `--from write-spec` **and** the positional is an existing `*-spec.md`/`*-plan.md` artifact | `from_needs_intent` | `write-spec` consumes free-text intent, not an existing artifact path. |
| positional omitted **and** `--resume` absent | `missing_input` | Nothing to run. |
| positional is an existing `*-spec.md`/`*-plan.md` whose path is not a clean renderable token (whitespace / quote / backslash / leading `-`) | `input_path_unsafe` | An artifact path is threaded bare into the entry stage's command; a non-renderable path could not be rendered. Refuse at classification rather than accept an import that fails at the first command (§2 argument transport). |
| positional is an existing `*-plan.md` whose slug cannot be resolved for import (§4 import contract) | `plan_slug_unresolved` | A plan-path start must reach `copilot`, which needs `plan_slug`; if it cannot be imported, refuse rather than start an unfinishable chain. |
| `--from` names an entry stage whose required inputs cannot be seeded from the positional's input kind (e.g. intent + `--from review-plan`, spec path + `--from copilot`) | `entry_input_unavailable` | The entry stage's required artifacts (§4 import contract) are not derivable from this input; refuse rather than resolve a chain whose commands cannot be constructed. |

`--until` short of `copilot` produces a partially-advanced pipeline: every artifact PR whose last stage was reached is merged; an artifact whose review stage was **not** reached is left as an open (draft) PR for the operator — forge never merges an unreviewed artifact PR (see `behavior` → Merge points).

### 2. The resolved stage chain

Default (6 stages): `write-spec → review-spec → spec-to-plan → review-plan → plan-to-tasks → copilot`.
With `--red-team` (8 stages): `write-spec → review-spec → red-team-spec → spec-to-plan → review-plan → red-team-plan → plan-to-tasks → copilot`.
`--from`/`--until` slice this list. The resolved list is computed once at run start and stored verbatim in `state.chain` — it is the single source of what this run will do.

Per-stage invocation (the exact command forge runs in-session):

| Stage | Command |
|-------|---------|
| `write-spec` | `/stark-write-spec "<intent>"` |
| `review-spec` | `/stark-review-spec <spec-path>` |
| `red-team-spec` | `/stark-red-team-spec <spec-path> --fold` |
| `spec-to-plan` | `/stark-spec-to-plan <spec-path>` |
| `review-plan` | `/stark-review-plan <plan-path>` |
| `red-team-plan` | `/stark-red-team-plan <plan-path> --fold` |
| `plan-to-tasks` | `/stark-plan-to-tasks <plan-path> --plan-slug <recorded-plan-slug>` |
| `copilot` | `/stark-copilot --plan-slug <slug>` |

**Argument transport (the two value classes, and their exact decode contracts).** The rendered command is consumed by the **in-session slash-command parser** (Claude reading a skill's `$ARGUMENTS`), not a POSIX shell, so POSIX quoting is not the model. Two transports, each with a single owner in `forge_state_lib.ts`:

- **Threaded artifact tokens** (`spec-path`, `plan-path`, `recorded-plan-slug`) are emitted **bare** and MUST be clean renderable tokens — they match the renderable-argument grammar `^[A-Za-z0-9._:=/][A-Za-z0-9._:=/-]*$` (no whitespace, quotes, backslashes, or a leading `-`). This is a **producer/import contract**, not something quoting can paper over: a value that is option-shaped or metacharacter-bearing is a contract violation (`unsafe_threaded_arg`). The `isRenderableArg(value)` predicate is the single owner of this grammar — the §4 import/classification path (§1) and the renderer both enforce it, so a value the importer accepts is guaranteed renderable.
- **Intent transport** — the write-spec free-text `"<intent>"` is the one quoted field. Forge emits it as a single double-quoted token, escaping `\`→`\\` and `"`→`\"`. The guarantee is deliberately **one-sided**: forge is responsible only for emitting a well-formed, single-line quoted token, and `encodeIntent` is the single owner of that rendering. Forge defines **no bespoke decoder and requires no change in `stark-write-spec`**, which already accepts a quoted positional — inventing a wire protocol between the two would couple a shipped skill to an orchestrator for no gain. Because the rendered command is one line, an intent carrying a control or Unicode line/paragraph-separator character is refused up front (`intent_unencodable`) rather than silently corrupting the command; intents are authored as a single line.

### 3. PR ownership and merge points (per artifact, not per stage)

PRs are owned by **artifact**, not by stage. Multiple stages collaborate on one PR; forge merges each artifact PR exactly once, after the **last stage in the resolved chain that touches that artifact** completes.

| Artifact PR | Branch owner | Opened by | Adopted in place by | Merged by forge after |
|-------------|--------------|-----------|---------------------|-----------------------|
| **Spec PR** | `write-spec/<slug>` | `write-spec` | `review-spec`, `red-team-spec` | the last present of {`review-spec`, `red-team-spec`} |
| **Plan PR** | spec-to-plan branch | `spec-to-plan` | `review-plan`, `red-team-plan` | the last present of {`review-plan`, `red-team-plan`} |
| **(none)** | — | `plan-to-tasks` | — | *no merge — produces GitHub issues, not a PR* |
| **Implementation PR(s)** | copilot branch(es) | `copilot` | — | after `copilot` — **each** PR copilot reports, when green |

`mergePointsFor(chain)` is a **pure function** in `forge_state_lib.ts` that, given a resolved chain, returns the ordered list of `{ after_stage, artifact: "spec" | "plan" | "impl" }` merge points. It is derived once and is the single source of when merges fire; execution and `--dry-run` both read it. Stages not listed above (plan-to-tasks) produce no merge point. The `impl` merge point covers **all** of copilot's implementation PRs (see `behavior` → Multiple implementation PRs).

**PR identity is owned at the run level, not per stage.** The run-level `artifact_prs` registry (§5) is the canonical record of each artifact's PR number(s): it is seeded when an artifact's **opening** stage reports its PR, and every later stage that touches the artifact is validated against it — an adopting stage reporting a *different* PR fails fast (`adoption_mismatch`, `running → failed`) instead of silently forking the one-PR-per-artifact model. Merging, reconciliation, and the summary consume the registry; stage-level `prs` are observations.

**Path-based starts (no author stage in the chain).** When the run starts at `review-spec`/`review-plan` from an existing artifact, the review stage is the PR **opener** by its own create-or-adopt contract: it opens the artifact PR (feature branch + push, authored by stark-claude) if none is open, else adopts the open one; forge records the resulting PR number in that stage's `prs` from the stage's reported output, seeds `artifact_prs` for the artifact, and derives the artifact merge point against the registry. The artifact branch is owned by the review stage in this mode. (An artifact whose file is already fully on `main` yields an empty review diff — the fully-merged-input case is parked in `open-questions`.)

Red-team `--fold` fold PRs are a **separate, never-merged** PR (branch `red-team-fold/<stem>-<ts>`). Forge does **not** merge fold PRs; it records them in `fold_prs` and, per `behavior` → Red-team fold PRs, halts the artifact merge (`fold_pr_open`) while any fold PR for that artifact is open.

### 4. Artifact threading contract (reported paths, not guesswork)

Forge reads each stage's reported output to obtain the next stage's input — it never reconstructs a path from a naming convention it invented:

| Producer (authoritative owner) | Reported source consumed | Recorded on | Threads into |
|--------------------------------|--------------------------|-------------|--------------|
| `write-spec` | receipt JSON field `spec_path` (a real `WriteSpecReceipt` field) | write-spec `artifacts.spec_path` | `review-spec`, `red-team-spec`, `spec-to-plan` |
| `spec-to-plan` | the plan path **and** plan slug the skill wrote — `docs/plans/YYYY-MM-DD-<slug>-plan.md`, deterministically derived by spec-to-plan from the spec slug and reported on completion (the dispatcher `PlanDispatchResult` carries `final_verdict` but no path field, so forge records the skill-reported values). **spec-to-plan is the sole owner of both the plan path and the plan slug.** | spec-to-plan `artifacts.plan_path` + `artifacts.plan_slug` | `review-plan`, `red-team-plan`, `plan-to-tasks` (plan path); `plan-to-tasks`, `copilot` (plan slug — plan-to-tasks gained `--plan-slug <recorded-plan-slug>` per the §2 amendment) |
| `plan-to-tasks` | the created GitHub issue numbers (its completion marker — see `behavior`) | plan-to-tasks `artifacts.issue_numbers` | *no artifact threading — issues are terminal; `copilot --plan-slug` reads spec-to-plan's `plan_slug`, never plan-to-tasks* |

**Stage completion output sources (what forge reads to populate `record-output`).** Each stage exposes its result through a defined channel: **write-spec** → receipt JSON `spec_path` **plus the spec PR number its landing step (`write_spec_land`) reports** (seeds `artifact_prs.spec`); **review-spec / review-plan** → the adopted (or opened) artifact PR number from the stage's PR output (validated against — or, for a path-based start, seeding — the registry); **red-team-spec / red-team-plan** → the same artifact PR number plus any `fold_prs` from the fold skill's fold-PR output; **spec-to-plan** → the skill-reported `plan_path` + `plan_slug` printed on completion (`PlanDispatchResult` carries no path field) **plus the plan PR number it opened** (seeds `artifact_prs.plan`); **plan-to-tasks** → the created `issue_numbers` from its issue-create output; **copilot** → the implementation PR number(s) it opened (seed `artifact_prs.impl`). Forge records exactly these — no stage needs a new machine-readable gate contract.

The plan slug has exactly one producer (spec-to-plan) and is consumed from its recorded `artifacts.plan_slug`; plan-to-tasks and copilot never re-derive it from the plan filename independently (see `ssot`). Each resolved artifact is recorded on the producing stage's state record under `artifacts` so resume can re-thread without re-reading the receipt.

**Import contract for path-based starts (the one sanctioned filename read).** When the run starts from an existing artifact (no in-run producer for it), forge performs a one-time **import** at `init` that seeds the run-level `initial_artifacts` (§5): a `spec-path` start seeds `spec_path`; a `plan-path` start seeds `plan_path` **and** resolves `plan_slug` from the `docs/plans/YYYY-MM-DD-<slug>-plan.md` filename — the sole place forge reads the slug from a filename, permitted precisely because spec-to-plan (its normal owner) is not in the sliced chain to report it. A plan filename that does not match the convention fails `plan_slug_unresolved` rather than starting a chain that cannot construct `copilot --plan-slug`. Import is a bounded init-time exception, not the runtime re-derivation `ssot` forbids. `--from` starts validate that every required input for the entry stage is present (seeded or reported).

### 5. `state.json` schema

Stored at `stateRoot()/history/forge/<slug>/<run-id>/state.json`, with a `latest` pointer file per slug and `history_keep_runs` retention (reusing `write_spec_lib.ts` helpers `writeJsonAtomic` / `updateLatestPointer` / `pruneRunDirs` where practical). File mode private (0600), mirroring write-spec history.

Run-level object:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `slug` | string | yes | Sanitized run slug (kebab, path-traversal-safe). |
| `run_id` | string | yes | Unique per run (timestamp-derived; supplied by the host, not generated inside the pure lib). |
| `input` | `{ kind: "intent" \| "spec-path" \| "plan-path"; value: string }` | yes | The original positional input, stored immutably so a crash before the first stage reports artifacts can reconstruct intent (the lossy slug never has to be reversed). |
| `initial_artifacts` | `{ spec_path?: string; plan_path?: string; plan_slug?: string }` | no | Seeded at init for a path-based start (§4 import contract): a spec-path start seeds `spec_path`; a plan-path start seeds `plan_path` + the imported `plan_slug`. Empty for an intent start. |
| `mode` | `"in-session" \| "driver"` | yes | Execution mode (default `"in-session"`); `"driver"` selects the fallback protocol (`behavior` → Driver mode). |
| `chain` | `Stage[]` | yes | The resolved, ordered stage list for this run (incl. red-team inserts / `--from`/`--until` slicing). Immutable after init. |
| `merge_points` | `MergePoint[]` | yes | The `mergePointsFor(chain)` output, stored verbatim; `MergePoint = { after_stage: Stage, artifact: "spec" \| "plan" \| "impl" }`. Immutable after init. |
| `artifact_prs` | `{ spec?: integer[]; plan?: integer[]; impl?: integer[] }` | yes | **The canonical per-artifact PR registry (SSOT).** Starts `{}`; each artifact's entry is seeded once, when its opening stage reports its PR(s). Merging, reconciliation, and the summary consume this registry; stage-level `prs` are observations validated against it — a mismatch fails `adoption_mismatch`. |
| `created_at` | ISO-8601 string | yes | Host-supplied. |
| `abandoned_at` | ISO-8601 string \| null | no | Set by the `abandon` subcommand (§7). Non-null = the run is terminally abandoned: excluded from `--resume`/`resume-target`, summary `status` = `abandoned`. Null otherwise. |
| `stages` | `StageRecord[]` | yes | One record per entry in `chain`, same order. |

`StageRecord`:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `stage` | Stage enum | yes | The stage-name token. |
| `status` | `pending \| running \| halted \| done \| failed` | yes | State-machine status. |
| `prs` | integer[] | yes | Artifact PR number(s) this stage opened or adopted — an **observation** validated against the canonical `artifact_prs` registry (mismatch → `adoption_mismatch`); empty `[]` until a PR exists and permanently for `plan-to-tasks` (no PR). A single-PR artifact stage (spec/plan) holds one element; `copilot` may hold several (its multiple implementation PRs). |
| `merges` | `{ pr: integer; merged_by_forge: boolean }[]` | no | Per-PR merge disposition, recorded when forge observes or performs a merge at this stage's merge point. `merged_by_forge` distinguishes a PR forge squash-merged from one it observed already merged during reconciliation, so the summary's `merged_prs` never miscredits an externally-merged PR. Drives the "all PRs merged" gate on `running → done`. |
| `fold_prs` | integer[] | no | Red-team stages only: the separate never-merged `red-team-fold/*` PR number(s) opened by `--fold`. Empty/absent otherwise. Forge never merges these. |
| `artifacts` | `{ spec_path?: string; plan_path?: string; plan_slug?: string; issue_numbers?: integer[] }` | no | Resolved artifacts this stage produced. `issue_numbers` is plan-to-tasks's completion marker. |
| `gate` | `{ reason: string; detail: string }` \| null | no | Set only when `halted` or `failed`; null otherwise. |
| `started_at` | ISO-8601 string \| null | no | Set on entry to `running`. |
| `ended_at` | ISO-8601 string \| null | no | Set on entry to `done`/`halted`/`failed`; reset to null on re-entry to `running`. |
| `attempts` | `Attempt[]` | yes | Append-only history — **exactly one entry per non-`done` `running` episode, appended at the moment the episode ends** (`running → halted`, `running → failed`, or crash reconciliation). Re-entry (`halted/failed → running`) appends **nothing** — the episode was already archived when it ended, so no episode is ever recorded twice. A `running → done` episode is not archived (its timing lives in `started_at`/`ended_at`). Empty array initially. |

`Attempt` (one per non-`done` `running` episode, appended when the episode ends):

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `started_at` | ISO-8601 string | yes | Copied from the episode's `started_at`. |
| `ended_at` | ISO-8601 string \| null | yes | The episode's `ended_at`; null if the episode ended by a crash (was still `running` at resume). |
| `outcome` | `halted \| failed \| crashed` | yes | Closed enum: `halted` (episode ended `running → halted`), `failed` (ended `running → failed`), `crashed` (found `running` at resume — session died mid-stage; appended exactly once by reconciliation). |

All timestamps are host-supplied (the pure lib takes no clock — `Date.now()` is not called inside `forge_state_lib.ts`), so the library stays deterministic and unit-testable.

### 6. Legal transition matrix (closed, enforced by `forge_state_lib.ts`)

`isLegalTransition(from, to)` returns a boolean; the mutating `transition()` throws with the allowed set in the message on an illegal move (mirroring `github_projects_lib.ts::isLegalTransition`). The graph:

| From | Allowed → |
|------|-----------|
| `pending` | `running` |
| `running` | `done`, `halted`, `failed` |
| `halted` | `running` |
| `failed` | `running` |
| `done` | *(terminal — none)* |

- `running → done` requires the stage completed **and**, if the stage is a merge point's `after_stage`, **all** of its artifact PRs (`prs`) merged **and** no fold PR (`fold_prs`) left open (for `plan-to-tasks`, requires only that issue creation completed and `artifacts.issue_numbers` was recorded — there is no PR). Recording a stage's PRs / merge outcomes / artifacts mid-flight is **not** a transition — it uses the `record-output` operation (interfaces §7) while the stage stays `running`, which is why `running → running` is deliberately absent from the matrix. The "all merged / no open fold" check consults the injected PR-state reader against the canonical `artifact_prs` registry and the recorded `fold_prs` (and forge's own `merges` records).
- `running → halted` requires a `gate {reason, detail}` (e.g. `fold_pr_open`, `merge_pending`, `author_pr_merged_early`) and appends the episode's `Attempt` (`outcome: halted`).
- `running → failed` records `gate` with the failure reason (non-zero exit / CI red / `base_sync_failed` / `adoption_mismatch`) and appends the episode's `Attempt` (`outcome: failed`). `fold_pr_open` is always a **halt**, never a failure.
- `halted → running` and `failed → running` are the **resume** transitions: clear `gate` to null, reset `ended_at` to null, **preserve `prs`, `fold_prs`, and `artifacts`** (idempotent adopt reuses them). They append **nothing** to `attempts[]` — the prior episode was archived when it ended (§5), so one episode is never recorded twice.
- `done` is terminal — no transition out, ever.
- A stage found `running` at resume is **not** re-entered directly; it must first be reconciled (see `behavior`) — reconciliation appends **exactly one** `attempts[]` entry with `outcome: crashed` and moves the stage to `done`, `failed`, or `halted` (the merge-pending / fold cases); then normal rules apply, and the subsequent re-entry appends nothing further.

### 7. `forge_state.ts` CLI (the state manager — no LLM, no git)

| Subcommand | Args | Output (JSON) |
|-----------|------|---------------|
| `init` | `--slug --run-id --chain <csv> --created-at <iso> --input-kind <intent\|spec-path\|plan-path> --input-value <str> --mode <in-session\|driver> [--initial-spec-path --initial-plan-path --initial-plan-slug]` | Validates the arg combination (input kind ↔ initial-artifact args; a `plan-path` start requires `--initial-plan-slug`), computes `merge_points`, writes the initial `state.json` — immutable `input`/`mode`/`initial_artifacts` set, `artifact_prs: {}`, all stages `pending` — atomically; prints the run object. Red-team membership is carried by `--chain` itself — there is no separate red-team argument to disagree with it. |
| `record-output` | `--slug [--run-id] --stage [--prs <csv>] [--fold-prs <csv>] [--merges <pr:merged_by_forge,...>] [--artifact-spec-path --artifact-plan-path --artifact-plan-slug --artifact-issue-numbers <csv>] --at <iso>` | Records a stage's reported PRs / fold PRs / merge outcomes / artifacts **while it stays `running`** (no status change) — the checkpoint `behavior` step 3c takes before any merge begins, so a crash mid-merge is reconcilable. **Field-wise patch semantics:** omitted fields are left unchanged; array fields (`prs`, `fold_prs`, `issue_numbers`) are **unioned** (deduped, first-seen order — safe for incremental issue-number persistence); `merges` entries are keyed by `pr` with **monotonic attribution** — an existing `merged_by_forge: true` entry is never overwritten by `false` (reconciliation adds `false` only for merged PRs with *no* recorded entry, so a crash between forge's merge checkpoint and `running → done` cannot erase forge's attribution); scalar artifact fields (`spec_path`, `plan_path`, `plan_slug`) are **write-once** — a conflicting re-report fails with `artifact_conflict`. A reported PR that contradicts the `artifact_prs` registry fails with `adoption_mismatch`; re-recording identical values is a no-op. |
| `transition` | `--slug [--run-id] --stage [--from <expected-status>] --to <status> [--prs <csv>] [--fold-prs <csv>] [--gate-reason --gate-detail] [--artifact-spec-path --artifact-plan-path --artifact-plan-slug --artifact-issue-numbers <csv>] --at <iso>` + injected PR-state reader | Applies one legal transition atomically; prints the updated stage record. Exits non-zero (throws) on illegal transition. `--to done` at a merge-point stage consults the injected PR-state reader to confirm every registry PR is merged and no `fold_prs` is open before allowing the transition. |
| `get` | `--slug [--run-id]` | Prints the full run object. |
| `abandon` | `--slug [--run-id] --at <iso>` | Marks the **run** abandoned (run-level `abandoned_at` timestamp; terminal — no stage transition involved, the closed §6 matrix is untouched). An abandoned run is excluded from `--resume` selection and `resume-target`, and its summary `status` is `abandoned`. The documented exit for the `author_pr_merged_early` dead end. |
| `resume-target` | `[--slug]` + injected PR-state reader | Prints `{run_id, slug, target_stage, action: reinvoke \| advance \| complete \| merge_only \| abandon, reconciled?: boolean}` — the next stage to run after reconciliation (abandoned runs excluded). `merge_only` is **derived from state**: a merge-point stage with a `record-output` completion checkpoint and an incomplete merge (regardless of gate reason — `fold_pr_open`, `merge_pending`, or `ci_red`) resumes by retrying only the merge, never re-invoking the stage skill; `reinvoke` = a halted/failed stage without a completion checkpoint; `abandon` = a halted **non-merge-point** stage *with* a checkpoint (the `author_pr_merged_early` posture — no in-run continuation exists; the operator runs `abandon` and starts fresh). Every reachable non-`done` state maps to exactly one of these actions. |
| `summary` | `--slug [--run-id]` + injected PR-state reader | Prints the §9 final-summary object for the run. The reader filters recorded `fold_prs` to those **actually still open** for `open_fold_prs` — a fold PR the operator merged/closed stays recorded but is no longer reported open. |

**Transitions are replay-safe.** `transition` accepts `--from <expected-status>` (compare-and-set): the write commits only when the stored status equals `<expected-status>`, and re-issuing a transition whose `--to` already equals the stored status is a **no-op** that reprints the current record — preserving the original `started_at`/`ended_at`/`attempts` — so a lost command result can be retried without tripping the closed matrix (no spurious `running → running`). `record-output` is likewise idempotent.

The PR-state reader used by `resume-target` for reconciliation is an **injected dependency** (the `stark_session_lib.ts` injected-`run` pattern), so reconciliation logic is unit-testable with zero network.

### 8. `forge` config section

Added to `stark_config_lib.ts` (`DEFAULT_FORGE` + `getForgeConfig()`):

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `history_keep_runs` | integer | 20 | Per-slug run-dir retention. |
| `merge_timeout_s` | integer | 1800 | Max wait for an artifact PR's CI to go green during merge-when-green before the merge wait is treated as failed. **Forge is the single deadline owner:** it runs `/stark-gh:pr-merge` bounded by this value and classifies expiry or a non-zero exit as `ci_red`; the merge skill's own CI wait runs *under* forge's deadline, never as an independent competing timeout. |

No stage-tuning knobs live here — those stay in each stage's own config section (see `ssot`).

### 9. `--json` final summary schema

`--json` emits exactly one JSON object on **stdout** (all narration on stderr); the same object is produced by `forge_state.ts summary`. For a fail-fast validation exit (no run yet) `slug`/`run_id`/`resume_target` are `null`, `chain`/`merge_points`/`stages`/`merged_prs` are empty, and `status` = `error`. For a `--dry-run --json` preview, `slug`/`run_id`/`resume_target` are `null`, `chain` and `merge_points` carry the **resolved** values (resolution runs; nothing is persisted), `stages`/`merged_prs` are empty, and `status` = `dry_run`. The object always parses against this schema with the unavailable fields null/empty. Schema:

| Field | Type | Notes |
|-------|------|-------|
| `slug` | string \| null | Run slug; null only when `status` = `dry_run` \| `error` (no run exists). |
| `run_id` | string \| null | This run; null only when `status` = `dry_run` \| `error`. |
| `red_team` | boolean | **Derived from `chain`** (whether a red-team stage is present) — not stored; the chain is the sole owner of stage membership. |
| `status` | `completed \| halted \| failed \| running \| pending \| abandoned \| dry_run \| error` | Overall run status: `completed` = last chain stage `done`; `halted`/`failed` = a stage is halted/failed; `running`/`pending` = an in-progress or not-yet-started run (e.g. a `summary` read of a driver-mode run); `abandoned` = the run carries `abandoned_at` (terminal, excluded from resume); `dry_run` = a `--dry-run --json` preview (no run persisted); `error` = a fail-fast validation exit. |
| `chain` | `Stage[]` | The resolved chain (verbatim from `state.chain`). |
| `merge_points` | `MergePoint[]` | Verbatim from `state.merge_points`. |
| `merged_prs` | `{ artifact: "spec"\|"plan"\|"impl"; pr: integer }[]` | Every PR **forge** merged this run, in merge order — derived from the recorded `merges` entries with `merged_by_forge: true` (an externally-merged PR observed during reconciliation is recorded `merged_by_forge: false` and never miscredited here). |
| `open_fold_prs` | `{ stage: Stage; pr: integer }[]` | Fold PRs **actually still open** — recorded `fold_prs` filtered through the injected PR-state reader (§7 `summary`); a fold PR the operator merged/closed stays recorded but drops out of this list. Empty unless `--red-team` produced folds. |
| `stages` | `StageSummary[]` | One per chain stage, in order (below). |
| `resume_target` | `Stage \| null` | The stage `--resume` would re-enter; null when `status = completed`. |
| `error` | `{ code: string; message: string } \| null` | Set on fail-fast/validation exits (the §1 `error.code` table) and on a failed stage; null otherwise. |

`StageSummary` (the required per-stage completion/PR outputs):

| Field | Type | Notes |
|-------|------|-------|
| `stage` | Stage | The stage token. |
| `status` | `pending \| running \| halted \| done \| failed` | Final status this run. |
| `prs` | integer[] | Artifact PR(s) the stage opened/adopted (empty for plan-to-tasks). |
| `fold_prs` | integer[] | Fold PR(s), red-team stages only. |
| `artifacts` | `{ spec_path?; plan_path?; plan_slug?; issue_numbers?: integer[] }` | Resolved artifacts. |
| `gate` | `{ reason: string; detail: string } \| null` | Set when `halted`/`failed`. |

Per-stage cost is deliberately **not** part of V1 (scope decision): most stage receipts have no audited cost field and forge persists none, so the summary makes no cost promise it cannot keep. Cost reporting returns only if a concrete consumer appears and stage receipts expose a consistent, persistable contract.

## behavior — Behavior & Correctness

### Main chain execution (happy path)

1. Resolve the stage chain from the positional input (auto-detect or `--from`/`--until`) and `--red-team`; validate argument combinations (interfaces §1) and fail-fast on any invalid one before writing state. Sanitize the slug from the intent/artifact. Compute `merge_points = mergePointsFor(chain)`.
2. `init` the state file: all `chain` stages `pending`, `merge_points` stored verbatim.
3. For each stage in order:
   a. `transition` the stage `pending → running` (stamp `started_at`).
   b. Execute the stage's SKILL.md flow in-session (forge runs the actual `/stark-...` command). Interactive gates surface natively as `AskUserQuestion` — the operator answers and the stage continues.
   c. On stage success, record the stage's reported `artifacts` (interfaces §4) and, for a PR-owning stage, the `prs` it opened or adopted (a single element for spec/plan artifact stages; **all** implementation PR numbers for copilot). For a red-team stage run with `--fold`, also record any `fold_prs`.
   d. **If — and only if — this stage is a `merge_points` `after_stage`**, merge its artifact PR(s) when green via `/stark-gh:pr-merge`:
      - **spec/plan artifact:** if any `fold_prs` for that artifact is open, do **not** merge — `transition running → halted` with `gate.reason = "fold_pr_open"` (see Red-team fold PRs). Otherwise merge the single artifact PR (`gh pr ready` → wait ≤ `merge_timeout_s` for CI green → squash-merge).
      - **implementation (copilot):** merge **each** registry PR, in the order copilot reported them, each when green; a red CI past `merge_timeout_s` on any one → `running → failed` with `gate.reason = "ci_red"` and `gate.detail` naming the PR, leaving the already-merged impl PRs merged.
      **Each merge result is recorded as it lands** — `record-output --merges` with `{pr, merged_by_forge: true}` immediately after each successful merge, before continuing — so the summary's `merged_prs` attribution survives a crash between merges. Otherwise (a paired author stage, or `plan-to-tasks`) do **not** merge — the artifact PR stays open for its later review/red-team stage, and `plan-to-tasks` has no PR. Forge never force-pushes.
   e. **If the stage is still `running`** (no halt/failure in 3d), `transition running → done` (stamp `ended_at`). After any halt or failure, the chain **stops** (Gates) — `halted → done` and `failed → done` are illegal; the run ends with the halted/failed summary.
   f. Advance to the next stage. A stage that begins a **new artifact** (spec-to-plan, plan-to-tasks, copilot) runs against `main` updated by the prior artifact's merge — **forge performs the base sync itself, as the stage's first act after *every* transition into `running`** (`pending → running`, and equally `failed → running` / `halted → running` on re-entry, so a `base_sync_failed` retry cannot bypass the prelude): `git switch <default-branch>` + `git pull --ff-only`; the stage skill is invoked **only after the sync succeeds** — a failed sync → `running → failed` (`gate.reason = "base_sync_failed"`), never a run against a stale base. A stage that continues the **same artifact** (review-spec, red-team-spec, review-plan, red-team-plan) runs against the still-open shared PR branch — no sync.
4. After the last stage in `chain` (or the `--until` stage), print the final summary (interfaces §9).

### Multiple implementation PRs (copilot)

copilot may open more than one implementation PR (e.g. one per plan phase). Forge records **all** of them in the copilot stage's `prs` and seeds `artifact_prs.impl`. At the `impl` merge point forge merges each when green, in report order; the stage reaches `done` only when **every** registry PR is merged. A crash after some-but-not-all merged is a **checkpointed** state: reconciliation resolves it to `merge_only` — copilot is **not** re-invoked; forge re-checks each registry PR and retries the merge for only the still-open ones (see Resume reconciliation).

### Red-team fold PRs

With `--fold`, a red-team stage opens a separate `red-team-fold/<stem>-<ts>` PR that the fold skill never merges. **Forge does not merge fold PRs in V1.** It records them in `fold_prs` and, because the fold changes must not be stranded behind a merged artifact, forge **halts the artifact merge** (`gate.reason = "fold_pr_open"`) whenever a fold PR is open at that artifact's merge point. The operator reviews/merges (or closes) the fold PR, then `--resume` continues with action `merge_only` (interfaces §7): because the red-team stage's execution already completed, resume **re-checks each recorded fold PR's live state via the PR-state reader and retries only the halted artifact merge** — a fold PR that was merged/closed no longer blocks even though its number stays recorded in `fold_prs`; the red-team skill is **not** re-invoked (that would rediscover findings and open another fold PR, repeating the halt). The merge proceeds once no fold PR remains open. This is the defined, safe V1 behavior; whether forge should instead wait-and-merge the fold PR into the artifact branch automatically stays an open question (non-blocking for the default, no-`--fold` chain).

### Stages that do not produce a mergeable PR

- **`plan-to-tasks`** produces GitHub issues, not a PR. It is never a merge point: on success forge records the created issue numbers in `artifacts.issue_numbers` (its completion marker) and transitions it `running → done` without any `/stark-gh:pr-merge` call. Its `prs` stays empty.
- A paired **author stage** (write-spec, spec-to-plan) opens a PR but is **not** its own merge point — its PR is merged only after the paired review (and red-team) stage. Reaching only the author stage (via `--until write-spec`/`--until spec-to-plan`) leaves an open draft PR the operator finishes manually; forge does not merge an unreviewed artifact.

### Input auto-detection edge cases

- A positional that is an existing `*-spec.md` under `docs/specs/` → `review-spec` start; existing `*-plan.md` under `docs/plans/` → `review-plan` start.
- A positional that looks like a path but does not exist on disk is treated as **free-text intent** (→ `write-spec`), not an error — the operator may be describing a spec they want authored. This is a deliberate fail-toward-authoring choice; `--from` disambiguates if the operator meant a path.
- `--resume` with a positional, or with `--from`/`--until`, is rejected (interfaces §1) — fail-fast with the listed `error.code`.

### Gates: halt-and-resume (never auto-accept, never auto-skip)

- **While the session is alive**, stage gates surface as native `AskUserQuestion` prompts (write-spec gap-fill, review growth-ack, ambiguous-fix asks). The operator answers; the chain continues. Forge does not intercept or pre-answer them.
- **Halt** = the state file marks the current stage `halted` with `gate {reason, detail}`. Halt/fail triggers:
  - A stage's non-zero exit (e.g. `coverage_gap`, `wing_unparseable`, `max_rounds_unsatisfied` left unanswered) → `running → failed` with the exit code/reason in `gate`.
  - CI staying red past `merge_timeout_s` on a merge point's merge-when-green wait → `running → failed`, `gate.reason = "ci_red"`.
  - An open fold PR at a spec/plan merge point → `running → halted`, `gate.reason = "fold_pr_open"`.
  - The session dying with a gate unanswered → the stage is left `running`; resume reconciles it (below).
- Forge **never auto-accepts** a gate on the operator's behalf and **never skips** a failed stage to continue. A `failed`/`halted` stage stops the chain until `--resume`.

### Resume

- `/stark-forge --resume` (no arg) selects the **latest non-`done`, non-abandoned** run (across slugs, by `created_at`/mtime); `--resume <slug>` targets that slug's latest run. An abandoned run (§7 `abandon`) is never selected.
- Resume acts on `resume-target`'s **`action`**, never unconditionally:
  - **`reinvoke`** — re-run the halted/failed stage from its **own entry point**. Safe because every stage is create-or-adopt idempotent: a re-run adopts the existing branch/PR, commits on top, never force-pushes. `prs`, `fold_prs`, and `artifacts` are preserved across the `halted/failed → running` transition so the adopt targets the right PR/branch.
  - **`merge_only`** — derived from state, not from a gate-reason allowlist: any **merge-point stage whose `record-output` checkpoint exists and whose merge is incomplete** resumes as `merge_only`, whatever ended the episode — the `fold_pr_open` halt, the crash-reconciled `merge_pending`, **and a `ci_red` merge-timeout failure** (execution completed; only the merge wait failed). Resume transitions `halted/failed → running`, re-checks the registry PRs / fold-PR live state, and **retries only the merge** — the stage skill is **not** re-invoked. `reinvoke` applies to halted/failed stages **without** a completion checkpoint.

### Resume reconciliation (the crash window)

A stage found in `status=running` at resume means the session died mid-stage — outcome unknown. Resume **never re-runs it blindly**. Reconciliation, in order, before any re-invocation:

1. **Reconcile a PR-backed stage by its `record-output` checkpoint.** `behavior` step 3c records the stage's `prs`/`artifacts` **before** any merge begins, so a present checkpoint means execution completed and the crash window is only around the merge; an absent one means the crash predates execution completion:
   - **Checkpoint absent (`prs: []`, no `artifacts`)** → the crash predates execution completion → append the single `{outcome: crashed}` attempt, `transition running → failed` (`gate.reason = "reconciled_after_crash"`), then `failed → running` re-invokes the stage via its create-or-adopt idempotent entry point (adopts any existing branch/PR, commit-on-top; duplicate side effects are impossible by the stage skills' existing contract). The stage command is reconstructable from the immutable `input`, `initial_artifacts`, and prior stages' recorded `artifacts` — no receipt re-read needed.
   - **Checkpoint present, stage NOT a merge point** (a paired author stage — its PR is *meant* to stay open until the paired review stage) → execution completed → verify the registry PR is **still open**: open → append `{outcome: crashed}`, `transition running → done` (reconciled), advance — **no re-invocation, no merge**. **Externally merged already** → the shared-PR model is broken (the paired review stage has nothing to adopt) → append `{outcome: crashed}`, `transition running → halted` with `gate.reason = "author_pr_merged_early"` — a premature author-PR merge is never treated as success. **Recovery is a documented dead end for this run, not a repair:** the merged PR cannot reopen and the write-once `artifact_prs` registry deliberately rejects a replacement (`adoption_mismatch`). `resume-target` returns `action: abandon` for this posture (halted non-merge-point stage *with* a checkpoint — no in-run continuation exists); the operator runs `forge_state.ts abandon` (§7), which terminally excludes the run from resume, and continues with a fresh `/stark-forge <artifact-path>` run — auto-detection starts at the review stage, whose create-or-adopt opener seeds a *new* artifact PR in the *new* run's registry. Caveat: the artifact is now fully on `main`, so the fresh run hits the **fully-merged-input case** (empty review diff) parked in `open-questions` — this halt is a concrete trigger for resolving it. Past `abandon`, no CLI operation mutates the old run.
   - **Checkpoint present, stage IS a merge point** → query **each** registry PR read-only (`gh pr view --json state,mergedAt`). **All merged, no open `fold_prs`** → record each observed merge that has **no existing `merges` entry** as `{pr, merged_by_forge: false}` (an entry forge already recorded `true` before the crash is preserved — attribution is monotonic, §7), append `{outcome: crashed}`, `transition running → done` (reconciled), advance. **Any open/unmerged, or an open `fold_prs`** → execution already completed and only the merge remains → append `{outcome: crashed}`, `transition running → halted` (`gate.reason = "merge_pending"`; an open fold PR uses `fold_pr_open`), target `merge_only` — **the stage skill is NOT re-invoked**, so a crash before/during merge never repeats reviews, commits, gates, or implementation work.
2. **Stage is `plan-to-tasks` (no PR)** → reconcile via the completion marker: if `artifacts.issue_numbers` is recorded, the issues were created before the crash → append `{outcome: crashed}`, `transition running → done` (reconciled), advance — **no re-run**. If absent, append `{outcome: crashed}`, `transition running → failed` (`reconciled_after_crash`), then `failed → running` and re-invoke `/stark-plan-to-tasks <plan-path> --plan-slug <recorded-plan-slug>` (spec-to-plan's recorded `plan_path`/`plan_slug`, per the §2 command table — never a filename re-derivation). The narrow window where issues were created but the marker was not yet written before the crash relies on plan-to-tasks's own title-dedup / `--cleanup <slug>` to avoid duplicates (tracked in open-questions).
3. Reconciliation is **read-only** on git/GitHub (queries only); the only writes are state-file transitions.

This closes the crash window for PR-backed stages: PR-merged-but-state-says-`running` resolves to `done` without re-execution; a **checkpointed** stage short of all artifact PRs merged retries **only the merge** (`merge_only` — no stage-skill re-invocation); only a **checkpoint-absent** stage re-enters the stage skill idempotently. plan-to-tasks is closed for the common path by its issue-number marker.

### `--dry-run`

Prints the resolved stage list, the resolved `merge_points` (which stage merges which artifact PR), and the exact per-stage commands (from the interfaces table, with real resolved paths where knowable) and exits. No branch, no state file, no LLM call, no git mutation.

### `--json`

Emits the interfaces §9 final summary object on **stdout** as a single JSON object; all human narration routes to **stderr**, so the stdout stream is a clean machine-readable payload (mirroring the write-spec / review dispatcher receipt discipline).

### Driver mode (fallback protocol, if in-session invocation is unavailable)

If the feasibility spike (`open-questions`) fails, forge runs in **driver mode**: it still resolves the chain, derives merge points, and owns `state.json`, but instead of invoking each stage it drives the operator through the same state machine. The protocol:

1. `init` records the run-level `mode: "driver"` (default `"in-session"`).
2. For the next `pending`/re-entered stage, forge transitions it `→ running` and **prints** (a) the exact stage command from the interfaces §2 table with resolved paths, and (b) the exact `forge_state.ts record-output …` invocation, and (c) the `forge_state.ts transition … --from running --to done|failed|halted …` invocation the operator will run to report the result (every printed transition carries `--from <expected-status>` — the §7 compare-and-set — so a lost result can be safely retried). **If the stage is a merge point**, the block additionally inserts — between `record-output` and the transition — the `fold_prs` open-check and the exact `/stark-gh:pr-merge` invocation for **each** reported artifact PR, plus the `forge_state.ts record-output … --merges …` call to record each merge result; the `--to done` transition is reached (and reader-validated) only after those merges are recorded. It then stops.
3. The operator runs the printed stage command, then reports the outcome by running the printed `record-output` (PR numbers, fold PRs, produced `spec_path`/`plan_path`/`plan_slug`/`issue_numbers`) and then the `transition` (`--to done` on success, `--to failed --gate-reason …` on failure, `--to halted --gate-reason fold_pr_open` when an open fold PR blocks the artifact merge). These map atomically to the same transitions in-session execution would perform; a `done` at a merge point still requires the recorded PRs merged, validated by the injected reader.
4. `/stark-forge --resume` reads the advanced state and prints the next stage's command block — or, when `resume-target` returns `merge_only`, a dedicated **merge-only block** containing only the fold-PR open-check, the remaining `/stark-gh:pr-merge` invocation(s), the `--merges` recording call, and the final reader-validated transition — **no stage command** (the stage's execution already completed). The loop repeats until the chain completes.

Driver mode uses only the already-defined `record-output`/`transition` operations — it adds no new state machinery, and every advance is an operator-run, reader-validated state transition, never an auto-advance.

### Observability

Forge's traceability is the state file itself: every transition (including reconciliation attempts) is durably recorded, so "where did the run get to and why did it stop" is answered by reading `state.json` — no separate logging subsystem. Stage-internal observability stays owned by each stage's own analytics sidecars.

## ssot — Single Source of Truth

- **Stage tuning has exactly one owner: each stage's own config section.** Forge deliberately ships no `--lead`/`--wing`/`--model`/`--max-rounds` pass-through flags and no `forge`-section mirrors of them. A stage's lead/wing agents, models, and round caps are read by that stage's dispatcher from `stark_config_lib.ts` (`write_spec`, `spec_review`, `plan_review`, `red_team`, etc.). Forge never re-states or forwards them — this is the anti-duplication decision baked into "Minimal CLI, config defaults".
- **The resolved chain is computed once and stored once.** `state.chain` is the authoritative record of what this run does; execution, resume, and the final summary all read it. Nothing re-derives the chain from the CLI flags after init.
- **The merge points are derived once and stored once.** `mergePointsFor(chain)` is the one owner of "which stage merges which artifact PR"; execution, `--dry-run`, and the summary read `state.merge_points`. Nothing re-derives merge timing from the stage list at runtime.
- **Artifact PR identity has exactly one owner: the run-level `artifact_prs` registry.** Seeded once by each artifact's opening stage; merging, reconciliation, and the summary consume it. Stage-level `prs` are observations validated against it (`adoption_mismatch` on divergence) — no stage record's copy ever drives a merge.
- **Red-team membership has exactly one owner: `state.chain`.** No `red_team` boolean is stored and `init` accepts none; the summary's `red_team` field is derived from the chain, so stored state can never contradict itself.
- **Artifacts are threaded from producers, never re-guessed, each with exactly one owner.** `spec_path` is owned by **write-spec** (its `spec_path` receipt field). **The plan path and the plan slug are both owned by `spec-to-plan`** — it derives them from the spec slug and reports them on completion; they are recorded once on the spec-to-plan stage's `artifacts` and consumed from there by review-plan/red-team-plan (path) and by both plan-to-tasks (`--plan-slug`) and copilot (slug). plan-to-tasks and copilot **never re-derive** the plan slug from the plan filename — the earlier ambiguity (slug attributed variously to the plan filename, spec-to-plan's output, and plan-to-tasks) is resolved: **spec-to-plan is the single authoritative producer of the plan slug.** plan-to-tasks owns only its `issue_numbers` marker. Forge never reconstructs a path/slug from a naming convention when its owning stage reports it.
- **Per-run history reuses write-spec's helpers, not a parallel implementation.** `writeJsonAtomic` / `updateLatestPointer` / `pruneRunDirs` are consumed from `write_spec_lib.ts` rather than re-implemented, so the history-dir layout, atomic-write, latest-pointer, and retention semantics have one owner across write-spec and forge.
- **`stateRoot()` owns the state-file location.** Forge routes all state writes through `asset_root_lib.ts::stateRoot()`; it never hardcodes `~/.claude/code-review/...`.
- **`/stark-gh:pr-merge` owns the merge flow.** Forge does not reimplement un-draft/wait-green/squash-merge; it invokes the one owner, once per artifact merge point (per PR, for copilot's multiple impl PRs).

## security — Security & Trust

**Tier: Playground — proportional controls only.** Forge is single-operator local tooling; it introduces no network entry point, no service account, no multi-tenant surface. The following are the real, proportional bars:

- **No secrets in state.** Forge itself never writes tokens, keys, or credentials into `state.json` — GitHub App auth is delegated to the stage skills / `github_app_lib.ts`; forge holds none. Two fields do persist provided text verbatim and are scoped accordingly: `gate.detail` is a bounded reason string forge composes (exit code / PR number / stage name), **never raw subprocess output**; `input.value` is operator-typed text stored as-is, protected by the 0600 file mode. The guarantee is "forge introduces no secret material of its own" — not a content scan of the operator's input.
- **State-file permissions.** State files are written 0600 under `stateRoot()` (the `$HOME` tree), matching write-spec history — not world-readable, not in the repo.
- **Slug sanitization.** The run slug (derived from operator intent or artifact path) is path-traversal-sanitized before it forms a directory name, so a crafted intent string cannot escape the history dir (mirroring `stark_session_lib.ts` / `stark_handover_lib.ts` sanitization).
- **Reconciliation is read-only on git/GitHub.** The only privileged operations forge itself performs are `gh pr view` queries; every mutation (branch, commit, push, PR, merge) is delegated to a stage skill or `/stark-gh:pr-merge`, each of which owns its own auth and never force-pushes.
- **The state manager mutates nothing but the state file.** `forge_state.ts`/`_lib.ts` make no LLM calls and no git mutations — the blast radius of a bug in the new TS is a malformed local JSON file.

Deferred (correct restraint for this tier): auth/RBAC, audit trails, secret rotation, adversarial-input hardening beyond slug sanitization, rate limiting. None apply to a single-user local orchestrator.

## test-plan — Test Plan

All new deterministic logic lives in the pure library `forge_state_lib.ts` and is covered by `forge_state_lib.test.ts` (node:test, run under `npm test`). The PR-state reader is an **injected dependency** (the `stark_session_lib.ts` injected-`run` pattern) so every test runs with **zero network**. Each test names the break scenario it guards.

**State machine + reconciliation (pure lib):**

1. **`reconcile: running merge-point stage with merged PR resolves to done and advances`** — state file with a **merge-point** stage N `running`, `prs: [123]`, and `artifact_prs` seeded with `123`; injected PR-state reader returns `merged`; `resumeTarget()` transitions stage N to `done` (reconciled, `attempts[]` gets `outcome: crashed`, the observed merge recorded `merged_by_forge: false` only where no `true` entry exists), returns target stage N+1, action `advance`, and requests **no re-invocation** of N. A **non-merge-point author stage** in the same posture (checkpoint present, PR externally merged) instead halts `author_pr_merged_early` — never `done` — and `resume-target` returns `action: abandon` for it. *Guards:* a crash after merge silently re-running an already-merged stage, a premature author-PR merge reconciled as success, or a dead-end halt with no mapped resume action.
2. **`reconcile: checkpoint decides reinvoke vs merge_only`** — two branches. **(a) Checkpoint absent** (`prs: []`, no `artifacts`): `attempts[]` gets exactly one `crashed` entry, `running → failed` with `gate.reason = "reconciled_after_crash"`, then `failed → running`, target = stage N, action `reinvoke`. **(b) Checkpoint present at a merge point, reader returns `open`** for the registry PR: exactly one `crashed` entry, `running → halted` with `gate.reason = "merge_pending"`, action **`merge_only`** — the stage skill is **not** re-invoked and only the merge is retried. *Guards:* a mid-stage crash skipping to N+1 against an unmerged artifact, and a checkpointed crash re-running completed reviews/implementation work (success criterion 5).
3. **`reconcile: running plan-to-tasks resolves via issue_numbers marker`** — stage is `plan-to-tasks`, `prs: []`; with `artifacts.issue_numbers` recorded, reconciliation transitions `running → done` (reconciled, no re-run); with it absent, it goes `running → failed → running`, action `reinvoke`. *Guards:* a crashed plan-to-tasks either duplicating issues (marker present but re-run) or being wrongly skipped (marker absent but marked done).
4. **`transition matrix: every illegal transition throws with the allowed set`** — for each illegal `(from, to)` pair (`done → running`, `pending → done`, `pending → halted`, `running → pending`, …) `transition()` throws and the message contains `from`'s allowed set. *Guards:* a corrupt state machine advancing or resurrecting a terminal `done` stage.
5. **`attempts archive exactly once, at episode end — re-entry appends nothing`** — `running → halted` and `running → failed` each append the episode's `{started_at, ended_at, outcome}`; the subsequent `halted → running` / `failed → running` clears `gate` to null, resets `ended_at`, leaves `prs`, `fold_prs`, and `artifacts` unchanged, and appends **nothing** — the exact `attempts[]` array is asserted (length 1 per episode, never a `crashed`+`failed` double for one episode). *Guards:* resume losing the PR pointer (adopt targets the wrong branch), clobbering attempt history, or one running episode being archived twice.
6. **`done requires all artifact PRs merged and no open fold only at a merge point`** — a merge-point stage cannot go `running → done` without **all** registry PRs merged and no open `fold_prs`, while a non-merge-point paired author stage can; `plan-to-tasks` `running → done` **fails when `artifacts.issue_numbers` is absent and succeeds when recorded** (the marker is enforced by `transition` itself, not only by crash reconciliation). *Guards:* forge marking a spec/plan artifact `done` before its PR merged (or with a fold PR stranded), blocking plan-to-tasks completion on a nonexistent PR, or marking plan-to-tasks `done` with no issues recorded.

**Chain + merge-point resolution (pure lib):**

7. **`chain resolution: red-team inserts + --from/--until slicing`** — `--red-team` inserts the two red-team stages at the right positions; `--from`/`--until` slice the resolved list correctly (stored verbatim in `state.chain`). *Guards:* a run silently skipping or duplicating a stage.
8. **`merge points: mergePointsFor derives one merge per artifact at the last touching stage`** — for the 6-stage and 8-stage chains and for `--from`/`--until` slices, `mergePointsFor(chain)` places the spec merge after the last present of {review-spec, red-team-spec}, the plan merge after the last present of {review-plan, red-team-plan}, no merge for plan-to-tasks, and one `impl` merge after copilot; a chain ending at an author stage yields **no** merge for that artifact. *Guards:* merging between an author stage and its review (destroying the shared-PR model) or merging an unreviewed artifact.

**CLI argument validation (pure lib, exercised through the CLI arg parser):**

9. **`CLI validation: every invalid combination fails-fast with its error.code and writes no state`** — **every** row of the interfaces §1 invalid-combination table (`resume_with_positional`, `resume_with_slice`, `resume_with_red_team`, `empty_chain`, `stage_not_in_chain`, `from_needs_intent`, `missing_input`, `input_path_unsafe` via an existing `*-spec.md`/`*-plan.md` whose path is not a clean renderable token — e.g. it contains whitespace, `plan_slug_unresolved` via a nonconforming plan filename, `entry_input_unavailable` via an input-kind/`--from` mismatch) exits non-zero with the exact `error.code` and performs **zero** state writes (no run dir created). Under `--json`, each emits exactly one parseable stdout object with `status: "error"`, the exact `error.code`, `slug`/`run_id` null, and narration only on stderr. The Phase 5 CLI test asserts, for each row (including `input_path_unsafe`), the **exact** `error.code`, **zero** state writes (no run dir on disk), and the JSON-stream behavior (one parseable stdout object, narration on stderr only). *Guards:* an ambiguous invocation silently starting the wrong chain, corrupting state, or emitting an unparseable machine payload.

**Artifact threading (pure lib):**

10. **`artifact threading: each producer's reported path/slug is recorded and every stage command renders exactly`** — table-driven over the 6-stage and 8-stage chains and each input kind (intent, existing spec path, existing plan path, path-like nonexistent intent): given a write-spec receipt with `spec_path` and a spec-to-plan skill-reported `plan_path`+`plan_slug`, the corresponding `StageRecord.artifacts` are recorded and **every** stage's fully rendered command matches the §2 table — including both red-team commands carrying `--fold`, `review-spec <spec_path>`, and `copilot --plan-slug <plan_slug>` **from spec-to-plan** (never from plan-to-tasks or a reconstructed path) — and each input kind starts at its §1 auto-detected stage. *Guards:* threading the wrong path forward, re-deriving the plan slug from a filename, a path start entering at the wrong stage, or a red-team command silently dropping `--fold`.

**History / atomicity / permissions (pure lib):**

11. **`atomic write leaves no partial state on failure`** — a simulated mid-write failure leaves the prior `state.json` intact (tmp-file + rename), never a truncated file. *Guards:* a crash mid-transition corrupting the only record of run progress.
12. **`retention prunes to history_keep_runs, keeps latest pointer`** — create > `history_keep_runs` run dirs; pruning keeps the newest N and the `latest` pointer still resolves. *Guards:* unbounded history growth / a dangling latest pointer.
13. **`resume-target selects latest non-done, non-abandoned run`** — several runs across slugs (some fully `done`, one abandoned via `abandon`, one halted); no-arg resume picks the latest non-`done` **non-abandoned** run, `--slug` targets that slug, and the abandoned run's summary reads `status: abandoned`. *Guards:* resume grabbing a completed run, the wrong slug, or endlessly re-selecting a terminally abandoned dead-end run.

**Security-relevant behaviors (pure lib):**

14. **`slug sanitization: a path-traversal intent cannot escape the history dir`** — intents like `../../../etc/passwd`, `a/b/c`, and `..` sanitize to a kebab slug containing no `/`, `..`, or leading dot, so the run dir resolves strictly under `stateRoot()/history/forge/`. *Guards:* a crafted intent writing state outside the history tree.
15. **`state files are written 0600`** — after `init` and after a `transition`, `state.json` (and the run-dir files) have mode `0600`. *Guards:* run state (PR numbers, paths) becoming world-readable.

**Multiple-PR + fold handling (pure lib):**

16. **`multiple implementation PRs: done requires all merged, reconcile retries only the merge`** — copilot stage with a checkpoint (`prs: [101, 102]`, `artifact_prs.impl` seeded); reconciliation with `101` merged + `102` open resolves to `halted`/`merge_pending`, action **`merge_only`** — copilot is **not** re-invoked, the checkpointed outputs are preserved, and the merge retry targets only `102`; the observed `101` merge is recorded `merged_by_forge: false`; with both merged → `done`; the merge-point resolver yields one `impl` merge that iterates every registry entry. *Guards:* forge marking copilot `done` while an implementation PR is still open, re-running completed implementation work after a crash mid-merge, or merging only the first of several impl PRs.
17. **`red-team fold PR blocks the artifact merge — and stops blocking once resolved`** — red-team-spec stage with `fold_prs: [77]` and the injected reader reporting `77` **open** at the spec merge point → the merge step halts with `gate.reason = "fold_pr_open"` instead of merging the spec PR, and the §9 summary lists it under `open_fold_prs`; with `fold_prs` **still recording `[77]`** but the reader reporting it merged/closed, resume proceeds to the artifact merge and `done`, and `open_fold_prs` is empty; with `fold_prs: []` the spec PR merges normally. *Guards:* forge merging a spec/plan artifact PR and stranding unmerged fold changes behind it, or an implementation that checks only `fold_prs.length` halting forever after the operator resolved the fold.

**Gate/failure handling (pure lib):**

18. **`gate handling: a failed/halted stage stops the chain and is never auto-skipped`** — a `running → failed` (non-zero exit) and a `running → halted` (with `gate {reason, detail}`) each leave the chain stopped at that stage; the resume target is that same stage, and no downstream stage is entered. *Guards:* forge skipping a failed stage to keep going.

**Summary schema (pure lib):**

19. **`--json summary shape matches §9 for completed, halted, and failed runs`** — `forge_state.ts summary` over a completed run emits `status: completed`, `resume_target: null`, `red_team` **derived from the stored chain** (a chain with no red-team stage yields `false` regardless of how the run was invoked), `merged_prs` in merge order carrying only `merged_by_forge: true` entries, `open_fold_prs` filtered through the injected reader, and one `StageSummary` per chain stage with `prs`/`fold_prs`/`artifacts`; over a halted/failed run it emits the matching `status`, a non-null `resume_target`, and `error` where applicable. *Guards:* a machine consumer breaking on a missing per-stage completion/PR field, an undefined summary shape, a summary miscrediting an externally-merged PR, or reporting a resolved fold PR as open.

**Reconstruction + driver + patch semantics (pure lib):**

20. **`crash before any output is reconcilable for every input kind`** — for each of an intent start, a spec-path start, and a plan-path start: the entry stage is `running` with no checkpoint; reconciliation reconstructs the exact re-invocation command from the immutable `input` + `initial_artifacts` (+ prior stages' recorded `artifacts` for later stages), action `reinvoke`. *Guards:* an early crash leaving a run that cannot be resumed because nothing but the lossy slug survived (success criteria 4-5).
21. **`driver mode emits exact command blocks and advances only on reported transitions`** — with `mode: "driver"` and a fake reader, the next-step renderer emits the §2 stage command with resolved paths plus the printed `record-output` and `--from`-carrying `transition` invocations — for a non-merge-point stage and, for a merge-point stage, the fold-check + per-PR `/stark-gh:pr-merge` + `--merges` recording block; state advances only after the reported transition, and a `done` at a merge point is still reader-validated. *Guards:* the success-criterion-7 fallback regressing unnoticed in environments where in-session invocation works (no live failure ever exercises it).
22. **`record-output patch semantics: unions, write-once scalars, registry validation`** — omitted fields leave recorded values unchanged; `issue_numbers` re-reports union-dedup (incremental persistence never loses earlier numbers); a conflicting scalar artifact re-report fails `artifact_conflict`; an adopting stage reporting a PR different from `artifact_prs` fails `adoption_mismatch`, while re-reporting the identical PR is a no-op. *Guards:* a partial re-report silently erasing recorded state, or a review stage forking the one-PR-per-artifact model undetected.

**Not automated (playground scope, exercised live per the repo's "test live" rule):** the actual in-session stage execution, the `/stark-gh:pr-merge` merge-when-green flow at each merge point, `--dry-run` producing zero side effects, `--json` stdout/stderr stream separation, and the driver-mode fallback (printing the next command + resolved path and advancing state on operator-reported completion, if in-session invocation proves unavailable) are verified by running `/stark-forge` end-to-end (and `--dry-run --json`) against a real intent — the stage skills own their own test coverage; forge's automated surface is the state machine, chain/merge-point resolution, CLI validation, threading, permissions, and summary logic. The dry-run non-mutation and JSON stream-separation checks are cheap live assertions (`--dry-run` creates no run dir; `--json` stdout parses as one object with narration on stderr).

## accessibility — Accessibility

`n_a` — headless developer tooling: `/stark-forge` is a Claude Code skill + a CLI state manager (`forge_state.ts`) with no user-facing rendered surface (no HTML, no GUI, no rendered UI). Its only output is terminal text and a JSON summary. No semantic-role, keyboard-operability, ARIA, contrast, or focus concerns apply.

## open-questions — Open Questions

- **Can forge invoke the stage skill entry points in-session?** (The feasibility gate in `intent`.) The design assumes forge, as a live skill, can invoke `/stark-write-spec`, `/stark-review-spec`, … as in-session slash-commands whose `AskUserQuestion` gates reach the operator. This is the load-bearing feasibility assumption and is unproven. *Owner:* implementer — prove with the **gating two-stage spike (write-spec → review-spec)** before building the full chain. **Blocking** — if false, forge ships the documented **driver mode** fallback (`intent`: print next command + resolved path, advance state on operator-reported completion) rather than autonomous invocation; the design remains sound either way.
- **Shared PR ownership across paired stages — adoption contract.** V1 relies on review-spec/red-team-spec adopting write-spec's spec PR in place, and review-plan/red-team-plan adopting spec-to-plan's plan PR, so forge merges one PR per artifact. This adoption is the existing create-or-adopt contract of those skills, but forge has not been exercised against the case where a review stage opens a *second* PR instead of adopting (e.g. branch drift). The `artifact_prs` registry now **detects** the break — an adopting stage reporting a different PR fails fast with `adoption_mismatch` instead of silently forking the model — but detection is not adoption: *Owner:* implementer, during copilot — confirm each review/red-team skill adopts by branch and record the observed behavior; **blocking** if adoption is not reliably in-place.
- **Red-team `--fold` fold PR — auto-merge vs. operator-merge.** V1 behavior is now defined and safe: forge never merges the separate `red-team-fold/*` PR, and it **halts the artifact merge with `fold_pr_open`** if a fold PR is open, so fold changes are never stranded behind a merged artifact (see `behavior`). What remains open is only the *convenience* decision — whether a later version should wait-for and auto-merge the fold PR into the artifact branch before the artifact merge, rather than halting for the operator. *Owner:* operator, after the first `--red-team` live run. **Non-blocking** — the halt-for-operator behavior is a complete, safe V1.
- **plan-to-tasks re-entry — the marker crash window.** Crash reconciliation now uses an `artifacts.issue_numbers` completion marker: marker present → reconcile to `done` without re-run; absent → re-invoke (see `behavior`). The one residual gap is the narrow window where issues were created but the marker was not yet persisted before the crash — re-invocation then relies on plan-to-tasks's own title-dedup / `--cleanup <slug>`. *Owner:* implementer, during copilot — confirm plan-to-tasks dedups by title on re-run; if it does not, forge must write the marker incrementally as issues are created (concretely supported: `record-output`'s union-dedup array semantics, §7, make incremental `issue_numbers` appends safe). **Blocking** — success criterion 5 forbids duplicate side effects, so this crash window must be closed before ship: either plan-to-tasks's title-dedup is confirmed, or forge persists each issue number incrementally so reconciliation never re-creates an existing issue.
- **`merge_timeout_s` default calibration.** Proposed 1800s. Real CI green time across target repos hasn't been measured; the default may need tuning after the first live run. *Owner:* operator, post-first-run. Non-blocking.
- **Slug collision across concurrent runs.** V1 assumes a single operator runs one forge chain at a time. Two concurrent runs on the same intent would share a slug and race on the `latest` pointer. Deemed out of scope for the single-user tier — parked, not solved. *Owner:* deferred; revisit only if concurrent runs become a real usage pattern.
- **`--until` on a merged partial pipeline — re-entry as a fresh forge run.** When `--until review-plan` leaves a merged plan on `main`, a later `/stark-forge <plan-path>` (auto-detecting `review-plan`) will re-review an already-reviewed plan. Whether forge should detect "this artifact was already carried by a prior forge run" and skip ahead is deferred — V1 relies on the operator using `--from`. The same fully-merged-input posture (empty review diff) is also the landing spot of the `author_pr_merged_early` → `abandon` → fresh-run recovery (`behavior` → Resume reconciliation), which makes it a concrete trigger for resolving this, not just a convenience. *Owner:* deferred. Non-blocking.