---
name: stark-red-team-plan
description: >-
  Adversarial red-team review of an execution plan doc. 5 personas (security-trust,
  reliability-distsys, data, product-dx, cost-ops) attack the plan and emit
  blocking concerns + counter-proposals. Default model: gpt-5.5-pro. Single
  round, challenge-first; proposed fix plan is disabled by default.
argument-hint: "<plan-path> [--source-spec <path>] [--model <id>] [--dry-run] [--no-pr-comment]"
disable-model-invocation: true
model: opus
revision: d999a7e78187c70724cc35edb0b72188f2e68909
revision_date: 2026-05-17T04:49:07Z
---

# stark-red-team-plan

Adversarial committee challenge of an execution plan document. 5 personas
attack the plan from their viewpoints and emit findings with counter-proposals,
trade-offs, and (optionally) human-review requests.

This is a **challenge-first** skill. The challenge result is always the source
of truth for the terminal status, sidecar status, PR comment status, and exit
code. In v1.2 the dispatcher can also render a `## Proposed Fix Plan` section,
but `red_team.fix_plan.enabled` ships as `false` and stays disabled by default
until a post-calibration rollout flips it globally.

Answers the question: **"Where will this plan break when we actually try
to execute it?"**

## Preflight

```bash
SCRIPTS="${STARK_RED_TEAM_SCRIPTS:-$HOME/.claude/code-review/scripts}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
"$PYTHON" "$SCRIPTS/preflight.py" --workflow stark-red-team-plan --json
```

- `overall == "blocked"` → print failing checks, stop. In automation contexts,
  emit a `preflight_check` event with `status=blocked` and exit non-zero.
- `overall == "degraded"` → warn, continue.
- `overall == "ready"` → continue silently.

## Arguments

Raw input: `$ARGUMENTS`

- `<plan-path>` — required. Path to the plan markdown file under attack.
- `--source-spec <path>` — optional. The source design or requirements the
  plan is meant to execute. If omitted, the plan is used as its own spec
  (matches `forge_orchestrator` fallback behavior).
- `--model <id>` — optional. Override `red_team.model` (default
  `gpt-5.5-pro`). Routed via OpenAI Responses API for `{o3, o3-mini,
  gpt-5.5-pro, gpt-5.4-pro}`; other models go through `codex exec`.
- `--dry-run` — render the sidecar to stdout only; do not write the file
  and do not post to the PR.
- `--no-pr-comment` — skip PR comment posting even if a PR is detected.

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<plan-path>` was provided. If not: `Usage: /stark-red-team-plan <path>`.
- Confirm the file exists. If not, search candidates:
  ```bash
  find docs/ -name "*${name}*" -o -name "*${name}*.md" 2>/dev/null | head -5
  ```
  Ask "Did you mean one of these?" if any match.
- Optional: warn if the file has uncommitted changes
  (`git diff --name-only -- "$path"`). The skill is read-only on the plan
  file, so uncommitted changes are fine — just note it in the summary.

### 1.2 Detect PR context

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
```

If on a feature branch with an open PR, store `pr_number` for Phase 4. Not
having a PR is fine.

### 1.3 Authenticate (only if PR detected)

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

Auth failure → warn, skip PR posting, continue.

### 1.4 Verify red-team API key

The dispatcher resolves `OPENAI_API_KEY` (or `OPENAI_API_KEY_FILE` +
`OPENAI_API_KEY_LABEL`) for Responses-API models. If neither is set and the
configured model needs the Responses API, the dispatch will fail with a
clear error — surface it as the failure mode.

## Phase 2: Dispatch

### 2.1 Run the dispatcher

```bash
# Red-team dispatcher lives at `tools/red_team_plan.ts` (Phases 3/4 of
# the 2026-05-16 TS migration). The former Python dispatcher has been
# deleted.
flags=()
[ -n "$source_spec" ] && flags+=(--source-spec "$source_spec")
[ -n "$model_override" ] && flags+=(--model "$model_override")
[ -n "$dry_run" ] && flags+=(--no-sidecar --no-audit)
[ -n "$classification_override" ] && flags+=(--classification-override "$classification_override")
[ -n "$replay_transcript" ] && flags+=(--replay-transcript "$replay_transcript")

TOOLS="${STARK_RED_TEAM_TOOLS:-$HOME/.claude/code-review/tools}"
[ -d "$TOOLS" ] || TOOLS="$(dirname "$SCRIPTS")/tools"

output=$(node --experimental-strip-types "$TOOLS/red_team_plan.ts" \
    --plan "$plan_path" \
    "${flags[@]}" \
    --json)
```

The dispatcher:

1. Loads `red_team.*` config (model, personas, timeout, budget, severity floor).
2. Runs the committee once via `red_team_lib.ts` (one Codex Responses-API call
   per persona, capped by `red_team.max_concurrent_personas`).
3. Resolves fix-plan status. By default this is `skipped_disabled` because
   `red_team.fix_plan.enabled` is `false`.
4. Writes a `<stem>.red-team.md` sidecar (unless `--no-sidecar`).
5. Writes a `caller="manual"` audit row to the red-team SQLite (unless
   `--no-audit`).
6. Emits best-effort insights audit events: `red_team_run`,
   `red_team_finding`, and, only when a fix plan succeeds,
   `red_team_fix_plan`.
7. Emits a single JSON object on stdout.

### 2.2 Parse JSON

Required fields:
- `status`: one of `clean`, `halted`, `halted_human_review`, `error`
- `total_findings`, `blocking_count`, `human_review_count`
- `cost_usd`, `duration_s`, `model`, `run_id`
- `fix_plan_status`: `skipped_disabled` by default, or another
  `success` / `error` / `skipped_*` state when calibration or rollout enables
  fix-plan execution
- `sidecar_path` (or null if `--dry-run`)
- `findings[]`: each finding has `id`, `persona`, `severity`, `concern`,
  `consequence`, `counter_proposal`, `trade_off`, `reason_for_uncertainty`
- `synthesis`: brief committee synthesis (string)
- `error`: string if dispatch failed, else null

If `status == "error"`, halt and report the error verbatim. Do not retry
within the skill — re-run after fixing the underlying issue (most common:
missing `OPENAI_API_KEY`, codex CLI not installed, model name typo).

## Phase 3: Render

Print the consolidated summary to the terminal:

```markdown
# Red-team review — {plan-name}

**Status:** {status}
**Findings:** {total} — {blocking} blocking (≥ high), {human_review} human-review
**Cost / duration:** ${cost} / {duration}s
**Model:** {model}

## Synthesis
{synthesis}

## Findings (sorted by severity)

| # | Severity | Persona | ID | Concern |
|---|----------|---------|----|---------|
...

## Proposed Fix Plan
**Status:** skipped — skipped_disabled
```

For each finding, include the counter-proposal and trade-off. If
`counter_proposal == "REQUEST_HUMAN_REVIEW"`, render the
`reason_for_uncertainty` instead.

The `## Proposed Fix Plan` section is always present so downstream tooling has
a stable anchor. With the v1.2 default it says `skipped_disabled`. If global
calibration later enables fix-plan execution and the challenge has blocking
findings, the section contains the proposed moves, warnings, unaddressed
finding IDs, and retry guidance on errors. Fix-plan success or failure never
changes the challenge-derived status or exit code.

## Phase 4: Persist

### 4.1 Sidecar

Already written by the dispatcher to `<plan-stem>.red-team.md`.
If `--dry-run`, skip.

The sidecar includes the challenge findings plus the `## Proposed Fix Plan`
section. With the default `red_team.fix_plan.enabled: false`, that section is
rendered as skipped and no second LLM call is made.

### 4.2 PR comment (skipped if `--dry-run`, `--no-pr-comment`, or no PR)

Post the dispatcher-rendered `pr_comment_body` (FU-rt9). It is a single
collapsible-per-persona summary with a critical/high "Highlights" section
on top, deterministic anchors for every finding, and an HTML-comment
marker (`<!-- stark-red-team: stage=plan artifact=... -->`) at the head
so a re-run edits the existing comment in place instead of stacking a
new one per round. The marker is keyed by stage + artifact path (NOT
`run_id`); the dispatcher exposes the exact string as `pr_comment_marker`
in its JSON output, so the lookup below copies the dispatcher's contract
verbatim.

The flow is **find-by-marker, edit-or-create** (FU-rt9 invariant — "one
updatable comment per run"):

```bash
body=$(echo "$output" | "$PYTHON" -c "import sys, json; print(json.load(sys.stdin)['pr_comment_body'], end='')")
marker=$(echo "$output" | "$PYTHON" -c "import sys, json; print(json.load(sys.stdin)['pr_comment_marker'])")

# Keyed on stage + artifact path (NOT run_id) so a fresh dispatcher run still
# matches the prior comment and "edit-or-create" actually edits.
existing_id=$(
  gh api "repos/$REPO/issues/$pr_number/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$marker\")) | .id" \
    | head -n1
)
if [ -n "$existing_id" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$existing_id" \
    -f body="$body" >/dev/null
else
  # Issue comment (NOT a PR review). Reviews live in /pulls/N/reviews and
  # would never show up in the issues-comments API used for the lookup
  # above, so a `pr review --comment` create branch silently broke the
  # FU-rt9 "one updatable comment per run" invariant on every rerun.
  $PYTHON $SCRIPTS/github_app.py --app stark-claude pr comment "$pr_number" \
    --body "$body"
fi
```

The dispatcher already runs `truncate_pr_comment` on the body before
returning it, so the GitHub 65 KB cap is honored without a second pass.
If posting fails, warn and continue.

### 4.2.1 Accepting human-review halts

If the run exits `halted_human_review`, the operator can acknowledge a
specific concern with `node --experimental-strip-types tools/red_team_accept.ts STABLE_KEY` (shown in the
sidecar, the PR comment, and the `tools/red_team_status.ts` display). Accepted
keys persist in the audit DB so subsequent runs no longer halt on the
same concern.

### 4.3 Insights audit

Unless audit is disabled, the dispatcher enqueues best-effort local insights
events for downstream audit: one `red_team_run`, one `red_team_finding` per
finding, and one `red_team_fix_plan` only when the proposed fix-plan call
succeeds. These events do not control the skill's status.

### 4.4 Commit sidecar

Skip if `--dry-run` or no sidecar was written. Otherwise commit only the
sidecar so the findings are durable alongside the plan — even if the user
has unrelated changes staged or in the working tree:

```bash
git add -- "$sidecar_path"
git commit -m "docs(red-team): findings for $(basename -- "$plan_path")

$total_findings findings ($blocking_count blocking, $human_review_count human-review)
Model: $model · Run: $run_id" \
  -- "$sidecar_path"
```

The scoped `git add -- "$sidecar_path"` puts the sidecar (including
first-run, never-tracked files) into the index without touching anything
else, and the path-pathspec form on `git commit ... -- <path>` commits
exactly that path regardless of what else is otherwise staged. The leading
`--` on both commands ensures sidecar paths starting with `-` are not parsed
as flags. Do **not** use an unscoped `git commit -a` or omit the `-- <path>`
on commit — either would sweep in unrelated staged changes.

If the plan file itself has uncommitted changes
(`git diff --quiet -- "$plan_path"` is non-zero, or it appears in
`git status --porcelain`), skip the commit and warn the user that the
findings reference a working-tree version of the plan that is not in
history; let them commit the plan first and re-run, or commit the
sidecar manually.

If the commit fails for any other reason (hook rejection, nothing to commit
because the sidecar is unchanged, etc.), warn and continue — the sidecar
file is already on disk.

Do not push. The user controls when the branch goes up.

## Output Contract

| Status | Exit | Meaning |
|--------|------|---------|
| `clean` | 0 | No blocking findings, no human-review requests. Plan passes. |
| `halted` | 0 | Blocking findings (≥ `min_severity_to_block`, default high). User decides whether to revise. |
| `halted_human_review` | 0 | At least one persona requested human review on a finding too uncertain to counter-propose. |
| `error` | 2 | Dispatch failed (auth, transport, parse). See `error` field. |

The skill does **not** halt the calling pipeline — exit codes are advisory.
Manual invocation is informational.

## Operational controls

- **Disabled by default.** `red_team.fix_plan.enabled` is `false` in v1.2, so
  normal skill runs render `## Proposed Fix Plan` as `skipped_disabled` and do
  not make the second `gpt-5.5-pro` call.
- **Fix-plan kill switch.** Set `STARK_RED_TEAM_FIX_PLAN_KILL=1` (also accepts
  `true` or `yes`) in the operator environment to force
  `fix_plan_status=skipped_kill_switch`, even after a future global enable
  flip or during dispatcher calibration. The challenge run still executes and
  remains the source of truth.

## Notes

- **Single round, by design.** The committee is calibrated for one
  high-quality pass; iterative refinement (multi-round stability check)
  is on the red-team v2 roadmap (`docs/specs/2026-04-27-red-team-followups.md`,
  rt7+).
- **Locked config fields.** `model`, `personas`, `enabled`, `agent`,
  `min_severity_to_block`, `halt_on_unresolved`, `allow_human_review_halt`,
  and `stages` cannot be overridden at org/repo levels — only the global
  config surface is authoritative. `--model` overrides at runtime for
  ad-hoc exploration but does not persist.
- **Cost.** ~$1.90 per run on `gpt-5.5-pro` per the
  `2026-04-27-red-team-v1-calibration` baseline. Budget capped by
  `red_team.per_run_budget_usd` (default $15.00).
- **Relation to `/stark-review-plan`.** `stark-review-plan` is multi-agent
  domain-based (4 domains × N agents) with a fix loop; this skill is a
  single-pass adversarial committee with no fix loop. Use this to surface
  blind spots before kicking off the heavier review/execution.
