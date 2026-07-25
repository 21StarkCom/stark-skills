---
name: stark-forge
description: >-
  Thin in-session conductor for the full write-spec through copilot pipeline.
  Runs each stage skill in-session, merges each artifact PR once at the last
  stage that touches it, and drives a crash-resumable state file via
  forge_state.ts. Never re-implements a stage's own logic. Use for end-to-end
  pipeline runs, forge, autonomous spec-to-implementation.
argument-hint: '<path|"intent"> [--red-team] [--from STAGE] [--until STAGE] [--resume [slug]] [--dry-run] [--json]'
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-forge

`/stark-forge` is a **thin conductor**, not a new pipeline engine. It runs the
existing six-to-eight stage skills (`/stark-write-spec` → `/stark-review-spec`
[→ `/stark-red-team-spec`] → `/stark-spec-to-plan` → `/stark-review-plan`
[→ `/stark-red-team-plan`] → `/stark-plan-to-tasks` → `/stark-copilot`)
one after another, in-session, and merges each artifact PR exactly once — after
the **last** stage that touches it, never between a paired author and its
review. All state (chain, merge points, artifact threading, PR registry,
crash recovery) lives in `tools/forge_state.ts` / `forge_state_lib.ts`, which
this skill drives but never re-implements.

**This skill is glue, not logic.** Every stage list, merge point, rendered
command string, base-sync decision, and the default branch name comes from a
`forge_state.ts` subcommand's JSON output or from the recorded `state.json` —
never hardcoded here. If a step below looks like it is computing one of those
values in markdown, it isn't — it is reading a named field off the last tool
call's output.

Full contract: `docs/specs/2026-07-19-stark-forge-spec.md`. Completion-line
contract each stage emits: `standards/stage-completion-line.md`.

## Arguments

- `<path|"intent">` — either an existing `docs/specs/*-spec.md` /
  `docs/plans/*-plan.md` path (auto-detects the entry stage) or a free-text
  intent (starts at `write-spec`). Required unless `--resume` is given.
- `--red-team` — insert `red-team-spec --fold` after `review-spec` and
  `red-team-plan --fold` after `review-plan`. Default off.
- `--from STAGE` / `--until STAGE` — force the chain's start/end stage.
- `--resume [slug]` — resume the latest non-`done`, non-abandoned run (or that
  slug's latest run). Mutually exclusive with a positional, `--from`,
  `--until`, and `--red-team`.
- `--dry-run` — print the resolved chain, merge points, and exact per-stage
  commands; run nothing. Zero side effects (no state file, no LLM, no git).
- `--json` — this skill's own final output is the §9 machine-readable summary
  object; narration stays minimal.

Stage-name tokens (closed enum for `--from`/`--until`): `write-spec`,
`review-spec`, `red-team-spec`, `spec-to-plan`, `review-plan`, `red-team-plan`,
`plan-to-tasks`, `copilot`.

Every invalid combination (`resume_with_positional`, `resume_with_slice`,
`resume_with_red_team`, `empty_chain`, `stage_not_in_chain`,
`from_needs_intent`, `missing_input`, `input_path_unsafe`,
`plan_slug_unresolved`, `entry_input_unavailable`) is validated by
`forge_state.ts resolve` itself (spec §1) — this skill does not pre-validate
or duplicate that table; it surfaces whatever `error.code`/`message` the tool
returns.

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
FORGE="node --experimental-strip-types $TOOLS/forge_state.ts"
NOW() { date -u +%Y-%m-%dT%H:%M:%SZ; }
```

## Preflight

```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/preflight.ts --workflow stark-forge --json
```

Parse the JSON result:
- `overall == "blocked"` → print the failing checks and stop.
- `overall == "degraded"` → warn, then continue.
- `overall == "ready"` → continue silently.

## Phase 1: Resolve

Always call `resolve` with `$ARGUMENTS` **plus a forced `--json`** — appending
`--json` a second time when the caller already passed it is harmless (the flag
is idempotent), and it guarantees a parseable stdout object on every path,
including the fail-fast validation-error branch (which otherwise only emits
JSON when the caller explicitly asked for it):

```bash
$FORGE resolve $ARGUMENTS --json
```

This single call validates the argv (every §1 invalid combination fails fast
with an `error.code`, zero state written), auto-detects the input kind,
resolves the chain + merge points, and returns one of three JSON shapes.
Branch on the parsed object:

1. **`error` is non-null** (`status: "error"`) — print `error.code` +
   `error.message`; if `$ARGUMENTS` requested `--json`, print the object
   verbatim on stdout. Stop.
2. **`status: "dry_run"`** — print the resolved `chain`, `merge_points`, and
   the per-stage `commands` list exactly as returned (or the raw object under
   `--json`). Stop. No `init`, no state file, no git, no LLM call.
3. **`action: "resume"`** — capture `.slug` (may be `null`, meaning "latest
   resumable run"). Skip Phase 2 entirely; go straight to Phase 3 with this
   slug.
4. **`action: "init"`** — capture `slug`, `run_id`, `chain`, `input_kind`,
   `input_value`, `initial_artifacts`, and `mode` verbatim. Go to Phase 2.

## Phase 2: Init (fresh run only — skipped on `--resume`)

```bash
$FORGE init \
  --slug "$slug" --run-id "$run_id" \
  --chain "$(join_csv "${chain[@]}")" \
  --created-at "$(NOW)" \
  --input-kind "$input_kind" --input-value "$input_value" \
  --mode "$mode"
```

`--chain` is the resolved `chain` array from Phase 1, comma-joined verbatim —
never re-derived or re-sliced here. For each key present in Phase 1's
`initial_artifacts` object, add the matching flag with that value (present
keys only — the object already carries exactly the right set for this run's
input kind, so there is no kind-based branching to write):

| `initial_artifacts` key | flag |
|---|---|
| `spec_path` | `--initial-spec-path` |
| `plan_path` | `--initial-plan-path` |
| `plan_slug` | `--initial-plan-slug` |

`init` is retry-idempotent (an identical `(slug, run_id)` replay returns the
existing run unchanged); a genuine conflict fails `init_conflict` — surface it
and stop.

## Phase 3: Execution loop (fresh and resumed runs share this loop)

This is the entire engine. It repeats one step — "ask `forge_state.ts` what to
do next, do exactly that, tell it what happened" — until the run is `complete`
or a stage stops the chain. The **same** loop drives a brand-new run (Phase 2
just handed it a `pending` chain) and a `--resume` run (state already has
progress); `resume-target` treats both cases uniformly.

### 3.1 Ask for the next target

```bash
$FORGE resume-target ${slug:+--slug "$slug"}
```

(Omit `--slug` only on a `--resume` with no slug argument, so the tool
auto-selects the latest resumable run.) The response is the sole
routing/command channel — `{run_id, slug, target_stage, action,
reconciled, requires_base_sync, command}`. Capture `slug`/`run_id` from the
response for every subsequent call in this loop (pins them after the first
iteration of a no-slug resume). `resume-target` has already persisted any
crash reconciliation before returning — trust it; never re-derive what it
just decided.

### 3.2 Act on `action`

- **`complete`** — every chain stage is `done`. Go to Phase 4 (terminal
  output) with a success status.
- **`abandon`** — a documented dead end (the stage's authoring already
  completed but its artifact PR left the shared-PR model unrecoverable for
  this run — see spec `behavior` → Resume reconciliation,
  `author_pr_merged_early`/`artifact_pr_closed`). Fetch and print
  `$FORGE driver-block --slug "$slug"` verbatim — it is the
  one place this exact explanation is rendered. **Do not run `abandon`
  automatically** — that is the operator's call, not this skill's. Stop.
- **`advance` / `reinvoke` / `merge_only`** — continue to 3.3.

### 3.3 Enter running

The re-entry is compare-and-set: read the stage's currently-recorded status
(absent stage record ⇒ `pending`, mirroring the tool's own default) and pass
it as `--from`, so a replayed transition never silently overwrites a status
this skill didn't expect:

```bash
cur_status=$($FORGE get --slug "$slug" --run-id "$run_id" | jq -r --arg s "$target_stage" '(.stages[] | select(.stage == $s) | .status) // "pending"')
$FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" --from "$cur_status" --to running --at "$(NOW)"
```

### 3.4 Base sync — only when `requires_base_sync` is true

Never hardcode which stages need this — it is the `requires_base_sync` field
from 3.1's response, full stop. When true:

```bash
default_branch=$($FORGE get --slug "$slug" --run-id "$run_id" | jq -r .default_branch)
git switch "$default_branch"
git pull --ff-only
```

`default_branch` is read from the recorded run state, never guessed as
`main`. On either command failing:

```bash
$FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" \
  --from running --to failed --gate-reason base_sync_failed --gate-detail "<git error>" --at "$(NOW)"
```

Stop (the transition above persists the failure before this skill stops).

### 3.5 Run the stage command — skipped for `merge_only`

`merge_only` means the stage already finished executing before a prior crash;
its `command` is `null` and nothing runs here — skip straight to 3.6.

Otherwise, invoke `target_stage`'s `command` **verbatim**, in-session, exactly
as returned by 3.1 — this is the stage's real `/stark-...` slash command
(e.g. `/stark-write-spec "add dark mode"`, `/stark-review-spec
docs/specs/2026-07-19-x-spec.md`). Never re-render, re-assemble, or
second-guess this string; `forge_state.ts` is its single owner
(`renderStageCommand`). Its interactive gates (`AskUserQuestion` for
write-spec gap-fill, review growth-ack, ambiguous-fix asks) surface natively
to the operator in this same session — forge never intercepts or pre-answers
them.

When the stage skill finishes, find its last output line matching
`STARK_STAGE_SUMMARY {...}` (`standards/stage-completion-line.md`) and parse
the JSON that follows the prefix.

- **No such line, or the stage's own outcome signals a non-success verdict**
  (its exit was non-zero, or `outcome` reads as a rejection/abort/block/
  unresolved verdict for that stage) — the chain stops here:

  ```bash
  $FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" \
    --from running --to failed --gate-reason "<stage-reported outcome>" --gate-detail "<detail>" --at "$(NOW)"
  ```

  Persist happens as part of that call, before this skill stops — never print
  a stop message first. Go to Phase 4 with a failure status.

- **Success** — map the parsed fields onto `record-output`, per stage, exactly
  per `standards/stage-completion-line.md`'s field→flag table (reproduced
  here for convenience — that file is the SSOT, not this copy):

  | Stage | `record-output` flags |
  |---|---|
  | write-spec | `--artifact-spec-path <spec_path> --prs <pr>` |
  | review-spec / review-plan | `--prs <pr>` |
  | red-team-spec / red-team-plan | `--prs <pr> --fold-prs <fold_prs csv>` |
  | spec-to-plan | `--artifact-plan-path <plan_path> --artifact-plan-slug <plan_slug> --prs <pr>` |
  | plan-to-tasks | `--artifact-issue-numbers <issue_numbers csv>` |
  | copilot | `--prs <prs csv>` |

  ```bash
  $FORGE record-output --slug "$slug" --run-id "$run_id" --stage "$target_stage" <mapped flags> --at "$(NOW)"
  ```

  The stage stays `running` after this call by design — `record-output`
  checkpoints outputs without transitioning, so a crash between here and the
  merge step is reconciled by `resume-target`, never re-runs the stage.

### 3.6 Merge-point check

```bash
mp=$($FORGE get --slug "$slug" --run-id "$run_id" | jq -c --arg s "$target_stage" '.merge_points[] | select(.after_stage == $s)')
```

- **No match / empty** (not a merge point — a paired author stage, or
  `plan-to-tasks`):

  ```bash
  $FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" --from running --to done --at "$(NOW)"
  ```

  Go to 3.1 for the next stage.

- **Match** (this is also where `merge_only` re-enters, since a merge-point
  stage is the only kind that ever produces that action) — capture `.artifact`
  (`spec`/`plan`/`impl`) from `$mp` and go to 3.7.

### 3.7 Merge at a merge point — fold check first, then merge, no shell wrapper

In-session mode merges from **recorded state**, not from `driver-block`'s
rendering. `driver-block` is the driver-mode operator's script — on a fresh
`advance`/`reinvoke` it necessarily prints symbolic `<REPORTED: …>`
placeholders for PR numbers a human is meant to fill in from the stage's
just-printed output; running those tokens as literal arguments in-session
(`gh pr view <REPORTED: fold_pr>`) would be wrong. This skill instead reads
the exact same registry `record-output` already persisted — the state-owned
source, so nothing here is re-derived:

```bash
state=$($FORGE get --slug "$slug" --run-id "$run_id")
artifact=$(echo "$mp" | jq -r '.artifact')
rec=$(echo "$state" | jq -c --arg s "$target_stage" '.stages[] | select(.stage == $s)')
fold_prs=$(echo "$rec" | jq -r '.fold_prs[]?')
merged_prs=$(echo "$rec" | jq -r '.merges[]?.pr')
artifact_prs=$(echo "$state" | jq -r --arg a "$artifact" '.artifact_prs[$a][]?')
remaining_prs=$(comm -23 <(echo "$artifact_prs" | sort -n) <(echo "$merged_prs" | sort -n))
repo_owner=$(echo "$state" | jq -r '.repo.owner')
repo_name=$(echo "$state" | jq -r '.repo.name')
```

(This is the same computation `driver-block` does internally for its
`merge_only` branch, so it is correct for `advance`/`reinvoke` too — after
3.5's `record-output` the registry is already populated either way. You may
instead take these numbers straight from the fields just parsed out of the
stage's `STARK_STAGE_SUMMARY` line in 3.5, when this iteration actually ran
3.5 — same values. But `merge_only` skips 3.5 entirely on this iteration, so
reading `$FORGE get` here is the one path that works uniformly for all three
actions; stay consistent and always read state here.)

The operator deadline (`merge_timeout_s`) is not exposed by any other
subcommand — read the single number `driver-block` renders it as, without
executing any of that block's other (symbolic) lines:

```bash
merge_timeout_s=$($FORGE driver-block --slug "$slug" | grep -oE 'deadline [0-9]+s' | grep -oE '[0-9]+')
```

1. **Fold check first.** For each PR in `$fold_prs`:

   ```bash
   gh pr view <pr> --repo "$repo_owner/$repo_name" --json state --jq .state
   ```

   If any is `OPEN`:

   ```bash
   $FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" \
     --from running --to halted --gate-reason fold_pr_open --gate-detail "<pr>" --at "$(NOW)"
   ```

   Stop — this must happen **before** any merge.

2. **Merge, one PR at a time, in the order listed in `$remaining_prs`**
   (already-merged PRs are excluded by construction, so a resumed
   `merge_only` retries only what's left). For each PR: record the current
   time, invoke `/stark-gh:pr-merge --pr <pr>` **in-session** — it is a slash
   command, so **there is no shell `timeout` wrapper that can bound a nested
   slash-command invocation** — and on return compare elapsed time against
   `$merge_timeout_s`. A merge that never returns is recovered by the crash
   path (kill the session → `/stark-forge --resume` → `merge_only` retries
   only the still-open PRs).
   - **Within deadline and successful** — immediately record it (before
     merging the next one, so a crash between merges never loses
     attribution):

     ```bash
     $FORGE record-output --slug "$slug" --run-id "$run_id" --stage "$target_stage" --merges "<pr>:true" --at "$(NOW)"
     ```

     then continue to the next PR.
   - **Overrun, or `/stark-gh:pr-merge` itself failed**:

     ```bash
     $FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" \
       --from running --to halted --gate-reason merge_timeout --gate-detail "<pr>" --at "$(NOW)"
     ```

     Stop.
3. **All listed PRs merged** — transition to `done` (this call is
   reader-validated: it will itself refuse if anything is still unmerged, so
   this skill does not need to re-verify):

   ```bash
   $FORGE transition --slug "$slug" --run-id "$run_id" --stage "$target_stage" --from running --to done --at "$(NOW)"
   ```

   Go to 3.1 for the next stage.

## Phase 4: Terminal output

Whatever ended the loop (`complete`, a persisted `failed`/`halted` stop, or
an `abandon` dead end), always finish with:

```bash
$FORGE summary --slug "$slug" --run-id "$run_id"
```

Under `--json` in `$ARGUMENTS`, print that object verbatim as this skill's
final stdout payload (the §9 schema) and keep narration minimal. Otherwise
render it as a human summary: chain + per-stage status, merged PRs in merge
order, any still-open fold PRs, and the resume target (if not `completed`) so
the operator knows exactly what `/stark-forge --resume` will do next.

## Driver mode (fallback — only when the resolved `mode` is `"driver"`)

`mode` comes from Phase 1's resolved descriptor (`resolveExecutionMode()`
inside `forge_state.ts`; defaults to in-session, forced to `"driver"` only by
`STARK_FORGE_DRIVER=1`). When it is `"driver"`, this skill does **not** run
Phase 3's loop autonomously. Instead, each time it would act, it:

1. Calls `$FORGE resume-target ${slug:+--slug "$slug"}` to find the target,
   then `$FORGE driver-block --slug "$slug"`.
2. Prints that block **verbatim** — it already contains the compare-and-set
   re-entry, the base-sync prelude (only if applicable), the stage command,
   the exact `record-output` template, and (at a merge point) the fold-check
   and per-PR merge/record commands — and stops.
3. The operator runs the printed commands, then runs `/stark-forge --resume`
   to advance. Repeat until the printed block reports `complete`.

Driver mode uses only the already-defined `record-output`/`transition`
operations; it adds no new state machinery. In-session mode is primary;
driver mode is the documented, fully-functional fallback for when nested
slash-command invocation is unavailable.

## Gates: never auto-accept, never auto-skip

- A stage's interactive gates (`AskUserQuestion`) are answered by the
  operator, live, inside the stage's own invocation — this skill never
  intercepts or pre-answers one.
- A `halted`/`failed` stage stops the chain until `/stark-forge --resume`.
  Nothing here auto-retries, auto-skips, or auto-abandons a stopped stage.
- Every halt/fail transition is persisted (via the `transition` call) strictly
  **before** this skill prints anything implying the run stopped — so a killed
  session and a controlled stop are always distinguishable on `--resume`.

## Failure Modes

| Scenario | Where it surfaces | This skill's action |
|---|---|---|
| Invalid argv combination (§1 table) | `resolve` exits non-zero with `error.code` | Print code/message, stop. No state written. |
| A stage's command fails / rejects / times out | Missing/failing `STARK_STAGE_SUMMARY` | `transition --to failed --gate-reason <outcome>`, stop. |
| `git switch`/`pull --ff-only` fails at a new-artifact stage | Base sync (3.4) | `transition --to failed --gate-reason base_sync_failed`, stop. |
| A fold PR is still open at a merge point | Fold check (3.7.1) | `transition --to halted --gate-reason fold_pr_open`, stop. |
| `/stark-gh:pr-merge` overruns `merge_timeout_s` or fails | Merge loop (3.7.2) | `transition --to halted --gate-reason merge_timeout`, stop. |
| Session killed mid-stage | Next `resume-target` call | Reconciles automatically (`crashed` attempt, `done`/`failed`/`halted`/`merge_only` as appropriate) — never re-runs blindly. |
| Stage's authoring completed but its PR broke the shared-PR model | `resume-target` returns `action: abandon` | Print the `driver-block` explanation, stop; operator runs `forge_state.ts abandon` and starts a fresh run if they choose. |
