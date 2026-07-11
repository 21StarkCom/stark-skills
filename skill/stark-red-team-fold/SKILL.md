---
name: stark-red-team-fold
description: >-
  Fold a red-team fix plan back into its design/spec/plan doc. A least-privilege
  Claude decider triages every proposed move (accept / modify / reject with a
  rationale), writes the revised artifact + a `.fold.md` decision log, and opens
  a reviewable PR — never auto-merged. This is the explicit opt-in *fold* step:
  the challenge skills (`/stark-red-team-spec`, `/stark-red-team-plan`) only
  surface a proposed fix plan; they do NOT apply it. Use for fold red-team fix
  plan, apply red-team fix plan, accept red-team counter-proposals into the doc.
argument-hint: "<artifact> [--source-spec <path>] [--fix-plan-json <path>] [--source-run-id <id>] [--force-stale] [--model <id>] [--dry-run] [--no-pr] [--ready] [--json]"
disable-model-invocation: true
model: opus
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

# stark-red-team-fold

Fold a red-team **fix plan** back into the artifact it was generated against.
The challenge skills (`/stark-red-team-spec`, `/stark-red-team-plan`) attack a
doc and render a `## Proposed Fix Plan` — but they are **challenge-only** and
never touch the doc. This skill is the deliberate, opt-in step that turns that
proposed plan into an actual doc revision.

The fold is **selective and reviewable, never automatic**:

- A least-privilege **Claude decider** triages each proposed move independently
  and returns one disposition per move — `accept`, `modify`, or `reject` — each
  with a rationale. Accepted/modified moves patch the doc; rejected moves are
  logged with the reason.
- The revised artifact and a `<artifact>.fold.md` **decision log** are written,
  and the run is **audited before anything is published**.
- For a real doc diff the dispatcher commits + pushes a branch and **opens/edits
  a fold PR** (authored by `stark-claude`) so a human reviews the change. It
  **never merges.** All-rejected / no-diff folds write the decision log + audit
  and skip the doc PR.

Answers the question: **"Which of the red-team's proposed fixes do we actually
take into the doc — and can a human see exactly what changed and why?"**

## Preflight

```bash
TOOLS="${STARK_RED_TEAM_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
node --experimental-strip-types "$TOOLS/preflight.ts" --workflow stark-red-team-fold --json
```

- `overall == "blocked"` → print failing checks, stop. In automation contexts,
  emit a `preflight_check` event with `status=blocked` and exit non-zero.
- `overall == "degraded"` → warn, continue.
- `overall == "ready"` → continue silently.

Preflight doesn't ship a `stark-red-team-fold`-specific profile, and its check
registry is workflow-independent — so a fold run still executes the **critical**
red-team **challenge**-transport checks `check_red_team_transport_auth` and
`check_red_team_model_rates`. Those require `OPENAI_API_KEY` for the challenge
model (`red_team.model`, default `gpt-5.5-pro` on the Responses API), even though
the fold **decider** is Claude-only and never needs it. So a Claude-only
environment — all the decider actually requires — reports `blocked` on transport
auth. Run the fold with `--skip-check check_red_team_transport_auth
check_red_team_model_rates` to drop the two challenge-only checks (the preflight
CLI supports a repeatable `--skip-check`).

## Arguments

Raw input: `$ARGUMENTS`

- `<artifact>` — required. Path to the design/spec/plan markdown doc to fold the
  fix plan into. The doc is rewritten in place (on the fold branch), so it must
  be the same artifact the fix plan was generated against.
- `--source-spec <path>` — optional. The source requirements/spec the artifact
  is meant to satisfy, folded into the decider prompt as context.
- `--fix-plan-json <path>` — optional. An explicit fix-plan JSON file. **Highest
  precedence** — overrides sidecar/DB resolution entirely.
- `--source-run-id <id>` — optional. Name the prior red-team run whose fix plan
  to fold. **Takes precedence when supplied** — the resolver uses the passed id
  over the sidecar's `Run ID`: it's the DB source when the sidecar can't name the
  run, and overrides the sidecar's Run ID when it can.
- `--force-stale` — fold even when the fix plan's recorded artifact hash no
  longer matches the current artifact (i.e. the doc moved on since the challenge).
  **Forward-looking (v1):** the challenge doesn't yet record an artifact hash, so
  the staleness guard always passes and `stale_fix_plan` never fires through the
  CLI — this flag is a no-op today, threaded through for when challenge-side
  hashing lands. Once it does, a stale plan is **refused** (`stale_fix_plan`)
  unless this flag is set, rather than silently folded into a doc it no longer
  describes. (Full caveat under Operational controls.)
- `--model <id>` — optional. Override the decider model (`red_team.fold.model`).
  **Claude CLI only** — the decider is always Claude, so this does not change the
  transport or the posting identity.
- `--dry-run` — triage only: no writes, no audit, no git, no PR. Renders the
  dispositions and counts so you can preview what the fold would do.
- `--no-pr` — the dispatcher still writes the revised artifact + decision log and
  audits, but does **no git and no PR**. Use to fold locally and stage the PR
  yourself.
- `--ready` (alias `--no-draft`) — open the fold PR ready-for-review. By default
  the fold PR opens as a **draft** (it's reviewable-and-never-merged, so draft is
  its natural state and keeps draft-guarded CI idle).
- `--json` — emit the fold envelope as a single JSON object on stdout (the skill
  renders from this).

## Constants

```
TOOLS = ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools
```

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<artifact>` was provided. If not: `Usage: /stark-red-team-fold <artifact>`.
- Confirm the file exists. If not, search candidates:
  ```bash
  find docs/ -name "*${name}*" -o -name "*${name}*.md" 2>/dev/null | head -5
  ```
  Ask "Did you mean one of these?" if any match.

### 1.2 Locate the fix plan (sidecar → DB)

The fix plan resolves by precedence — the skill does not pick the source, it
just makes sure one is reachable:

1. `--fix-plan-json <path>` — explicit override.
2. `--source-run-id <id>` — the audit DB's `fix_plan_json` for that run.
3. Adjacent **`<artifact>.red-team.md` sidecar** — the dispatcher parses its
   `Run ID` header and looks the fix plan up in the audit DB.

If none of these can name a run, the fold reports `no_fix_plan_found` (exit 0) —
run `/stark-red-team-spec` or `/stark-red-team-plan` first to generate one, or
pass `--fix-plan-json` / `--source-run-id`. Verify the sidecar exists when
relying on path 3:

```bash
sidecar="${artifact%.md}.red-team.md"
[ -f "$sidecar" ] || echo "note: no adjacent sidecar — pass --fix-plan-json or --source-run-id"
```

### 1.3 Resolve source-spec (optional)

If `--source-spec` was passed, confirm the file exists; the dispatcher folds it
into the decider prompt as context. The dispatcher validates this too and errors
(exit 2) if the path is missing.

### 1.4 PR context + posting identity

The dispatcher detects the repo and opens/edits the fold PR itself; the skill
does not need to pass a PR number. Note the posting identity for the summary:

- The fold PR and its decision-log comment are **always authored by
  `stark-claude`** — the decider/author is Claude by construction. This is
  fixed; `--model` only swaps the decider's Claude model, not the identity
  (unlike the challenge skills, whose posting app follows the committee model).
- The **decider itself runs token-less (rt1).** Its subprocess gets a
  least-privilege env — `scrubEnv()` + `HOME` + `ANTHROPIC_API_KEY` only, with
  `GITHUB_TOKEN`/`GH_TOKEN`/`OPENAI_*` deliberately absent — and the mutating/
  network tools (`Bash`/`Edit`/`Write`/`Read`/`WebFetch`/`WebSearch`/`Task`/
  `NotebookEdit`) disabled. Even a jailbroken decider cannot run a command,
  touch the filesystem, or reach the repo. The host mints the GitHub token
  **after** the audit, when it opens the PR.

Skip all PR expectations if `--dry-run` or `--no-pr`.

## Phase 2: Dispatch

### 2.1 Run the dispatcher

```bash
# Fold dispatcher lives at `tools/red_team_fold.ts` (Task 11). It wraps
# `runFold` (writes + audits, openPr:false) and owns the git + PR side.
flags=()
[ -n "$source_spec" ]   && flags+=(--source-spec "$source_spec")
[ -n "$fix_plan_json" ] && flags+=(--fix-plan-json "$fix_plan_json")
[ -n "$source_run_id" ] && flags+=(--source-run-id "$source_run_id")
[ -n "$force_stale" ]   && flags+=(--force-stale)
[ -n "$model_override" ] && flags+=(--model "$model_override")
[ -n "$dry_run" ]       && flags+=(--dry-run)
[ -n "$no_pr" ]         && flags+=(--no-pr)

# TOOLS is set in the preflight preamble; the TS entry self-locates its lib
# via import.meta.url, so no env plumbing is needed.
output=$(node --experimental-strip-types "$TOOLS/red_team_fold.ts" \
    --artifact "$artifact" \
    "${flags[@]}" \
    --json)
```

The dispatcher:

1. Resolves the fix plan (§1.2 precedence) and applies the **staleness guard**:
   a plan whose recorded artifact hash no longer matches would be refused as
   `stale_fix_plan` unless `--force-stale` is set. *(Forward-looking in v1: the
   challenge records no artifact hash yet, so this guard always passes — see the
   caveat under Operational controls.)*
2. Runs the **least-privilege Claude decider** once, which returns one
   disposition per move (`accept` / `modify` / `reject`, each with a rationale).
3. Applies the `accept` + `modify` patches to the doc; logs `reject` (and any
   patch that failed to apply, as `apply_failed`).
4. Writes the revised artifact + a `<artifact>.fold.md` decision log (unless
   `--dry-run`).
5. **Audits the run to the red-team SQLite before any publish** (unless
   `--dry-run`). The audit precedes the PR by design (rt1).
6. For a real doc diff — and unless `--dry-run` / `--no-pr` — cuts a branch,
   commits the artifact + decision log, pushes, and opens/edits the fold PR
   (find-by-marker, edit-or-create; authored by `stark-claude`). **Never merges.**
7. Emits a single JSON object on stdout.

### 2.2 Parse JSON

Envelope fields:
- `status`: one of `ok`, `no_moves`, `no_fix_plan_found`, `stale_fix_plan`,
  `source_run_id_required`, `skipped_budget_exhausted_fold`,
  `decider_dispatch_failed` (or `error` on an arg/file failure).
- `fold_run_id`, `source_run_id`, `decider_model`.
- `applied_count` (accepted), `modified_count`, `rejected_count`,
  `apply_failed_count`.
- `dispositions[]`: each has `move_id`, `disposition`, and the rationale/patch.
- `cost_usd`, `duration_s`.
- `revised_doc`: the folded artifact text.
- `artifact`: absolute path of the folded artifact.
- `branch`: the fold branch (or `null` when no PR was opened).
- `pr_url`: the fold PR URL (or `null`).

If `status == "error"` or `status == "decider_dispatch_failed"`, halt and report
the error/status verbatim. Do not retry within the skill — re-run after fixing
the underlying issue (missing fix plan, Claude CLI not installed, stale plan
without `--force-stale`, ambiguous DB resolution needing `--source-run-id`).

## Phase 3: Render

Print the consolidated summary to the terminal:

```markdown
# Red-team fold — {artifact-name}

**Status:** {status}
**Source run:** {source_run_id}
**Decider model:** {decider_model}
**Dispositions:** {applied} accepted / {modified} modified / {rejected} rejected / {apply_failed} apply-failed
**Cost / duration:** ${cost} / {duration}s

## Decision log
`{artifact-stem}.fold.md`

## Dispositions
| # | Move | Disposition | Rationale |
|---|------|-------------|-----------|
...

**Branch:** {branch}
**PR:** {pr_url}
```

For each disposition render its rationale; for a `modify` show what changed from
the proposed move. When `--dry-run`, note that nothing was written/audited/pushed
(triage preview only). When no doc changes landed (all moves rejected/failed),
note that the decision log + audit were still written and the doc PR was skipped.

## Phase 4: Persist

The dispatcher owns **all** persistence — the skill only surfaces the results
from the JSON envelope. There is no bash git/PR block here (unlike the challenge
skills). The dispatcher's order is fixed and rt1-safe:

- **Decision log** — `<artifact>.fold.md` on disk (skipped on `--dry-run`).
- **Audit** — one local red-team SQLite row via `tools/red_team_audit_lib.ts`,
  written **before** any publish (skipped on `--dry-run`). This is the only audit
  surface — no remote/queue emit. The audit does not control the skill's status.
- **Branch + commit + push + PR** — only for a real doc diff, and only when not
  `--dry-run` / `--no-pr`. The dispatcher cuts a `red-team-fold/<stem>-<ts>`
  branch (never the default branch), commits the artifact + decision log
  (path-pathspec, `Co-Authored-By` trailer), pushes, and opens/edits the fold PR
  via the GitHub App (`stark-claude`), find-by-marker so a re-run edits the one
  fold comment in place. **It never merges** — a human reviews and merges.
- Surface `branch` and `pr_url` from the envelope. If they're `null` on a real
  fold, the dispatcher already logged why (no origin remote, push failed, or the
  fold was all-rejected/no-diff) — relay that note, don't re-attempt.

## Output Contract

| Status | Exit | Meaning |
|--------|------|---------|
| `ok` | 0 | Decider ran; dispositions applied. Check the counts — `ok` with `applied==modified==0` means every move was rejected or apply-failed (decision log + audit written, doc PR skipped). |
| `no_moves` | 0 | The fix plan had no moves to triage. |
| `no_fix_plan_found` | 0 | No fix plan resolved (no sidecar `Run ID`, no `--fix-plan-json`/`--source-run-id`, or DB miss). Generate one first. |
| `stale_fix_plan` | 0 | The fix plan's artifact hash no longer matches the current doc. Re-run with `--force-stale` to fold anyway. **Forward-looking (v1): not reachable via the CLI** — the challenge records no artifact hash, so the staleness check always passes. |
| `source_run_id_required` | 0 | DB resolution is ambiguous — pass `--source-run-id`. **Forward-looking (v1): not reachable on the normal CLI path.** |
| `skipped_budget_exhausted_fold` | 0 | Fold budget exhausted; the decider was not dispatched. |
| `decider_dispatch_failed` | 1 | The Claude decider subprocess failed (unavailable, timeout, or unparseable output). See the status/error. |
| `error` | 2 | Argument/file error (artifact / source-spec / fix-plan-json not found, or a bad flag). An unexpected internal throw in `runFold` also emits `{status:"error"}` but exits **1**. |

The skill does **not** halt the calling pipeline — exit codes are advisory.
Manual invocation is informational; the fold PR is the reviewable output.

## Operational controls

- **`--dry-run`** — triage-only preview. No writes, no audit, no git, no PR;
  the dispositions + counts are rendered so you can see what a real fold would do.
- **`--no-pr`** — write the revised artifact + decision log and audit, but do no
  git/PR. Use to fold locally and open the PR yourself.
- **`--source-run-id <id>`** — name the prior red-team run explicitly when the
  sidecar can't (or when the run reports `source_run_id_required`). Feeds the
  audit-DB `fix_plan_json` lookup.
- **`--force-stale`** — override the staleness guard and fold a fix plan whose
  recorded artifact hash no longer matches the current doc. **Forward-looking
  (v1):** the red-team challenge doesn't yet record an artifact hash, so the
  guard always passes and `stale_fix_plan` never fires through the CLI — this
  flag is a no-op today, threaded through for when challenge-side hashing lands.
  Until then a doc edited after its challenge still folds; the mitigation is that
  the decider triages against the **current** doc text and every fold lands as a
  never-merged, reviewable PR. Once challenge-side hashing lands the guard goes
  live — its point is to stop folding counter-proposals into a doc that has since
  moved on — and `--force-stale` becomes the deliberate override.

## Notes

- **Selective + reviewable, never automatic.** The decider judges each move on
  its own merits (accept/modify/reject) and every fold lands as a PR for human
  review. Nothing is auto-merged.
- **Fold ≠ challenge.** `/stark-red-team-spec` and `/stark-red-team-plan` are
  challenge-only — they surface a proposed fix plan but never apply it. This
  skill is the explicit opt-in that folds an already-generated plan into the doc.
- **Token-less decider (rt1).** The decider subprocess has model auth only (no
  GitHub/OpenAI token) and mutating/network tools disabled, so it cannot reach
  the repo or the filesystem. The GitHub token is minted by the host **after**
  the audit, when it opens the PR.
- **Locked config fields.** `red_team.fold.*` (and the shared `red_team` locked
  set — `model`, `personas`, `enabled`, `agent`, `min_severity_to_block`,
  `halt_on_unresolved`, `allow_human_review_halt`, `stages`) can't be overridden
  at org/repo levels — only the global config surface is authoritative. `--model`
  overrides the decider model at runtime for ad-hoc runs but does not persist.
