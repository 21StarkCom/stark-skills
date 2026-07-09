---
name: stark-spec-to-plan
description: >-
  Convert spec docs into phased implementation plans via paired lead/wing agents. Lead drafts, wing reviews, fix-loop until approved. Use for plan from spec.
argument-hint: "<path> [--lead claude|codex|gemini] [--wing claude|codex|gemini] [--max-rounds N] [--timeout N] [--wing-timeout N] [--dry-run] [--force]"
disable-model-invocation: true
model: opus
revision: 6943b7a3856c1caabf33b8449f6ed1604d203423
revision_date: 2026-05-19T05:45:53Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

## Preflight

Run environment validation before proceeding:
```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/preflight.ts --workflow stark-spec-to-plan --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue if both the configured lead and wing agents are available.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-spec-to-plan

Generate a phased implementation plan from a spec document via a paired **lead/wing** subagent loop:

- **Lead** (default `claude`) — drafts the plan from the spec doc
- **Wing** (default `codex`) — reviews the draft, returns approve / revise / block JSON verdict
- **Fix loop** — on `revise`, lead receives the wing's blocking findings + prior draft and emits a revised plan; wing re-reviews. Loops until `approve`, `block`, or `--max-rounds` exhaustion.

This is the cheaper, lower-variance sibling of the prior 3-agent tournament. Paired writing instead of competition.

This skill is thin: it orchestrates `tools/plan_dispatch.ts`, which owns the dispatch, the review→fix loop, and the JSON verdict parsing. Do not re-implement that logic here.

Fills the pipeline gap: `/stark-review-spec` → **`/stark-spec-to-plan`** → `/stark-review-plan` → `/stark-plan-to-tasks`.

## Arguments

- `<path>` — path to spec markdown file (required)
- `--lead AGENT` — lead implementer agent ID (default: `claude`). One of `claude`, `codex`, `gemini`.
- `--wing AGENT` — wing reviewer agent ID (default: `codex`). Must differ from `--lead`.
- `--max-rounds N` — maximum **fix** rounds after the initial draft (default: `4`). The wing reviews up to `N+1` times.
- `--timeout N` — per-lead-invocation timeout in seconds (default: 900)
- `--wing-timeout N` — per-wing-invocation timeout in seconds (default: 600)
- `--dry-run` — generate plan but don't write output files or post to PR
- `--force` — proceed even if spec file has uncommitted changes

If `--lead` and `--wing` resolve to the same agent, error and stop:
> Error: --lead and --wing must be different agents.

**Raw input:** `$ARGUMENTS`

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/scripts}"
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
PROMPTS="${STARK_REVIEW_PROMPTS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/prompts}"
```

## Phase 1: Setup

### 1.1 Validate input

- Confirm `<path>` argument was provided. If not, error: "Usage: /stark-spec-to-plan <path>"
- Confirm file exists and is readable. If not found and path looks like a partial name (no directory separator), search:
  ```bash
  find docs/ -name "*${path}*" -o -name "*${path}*.md" 2>/dev/null | head -5
  ```
  If candidates found, list them and ask. If none, error and abort.
- Check uncommitted changes:
  ```bash
  git diff --name-only -- "$path"
  ```
  If dirty AND `--force` not passed, warn and abort.

### 1.2 Detect PR context

```bash
pr_number=$(gh pr view --json number --jq .number 2>/dev/null)
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)
```

Store both for Phase 3. **Every run's plan + review summary must land on a PR** (workspace rule: reviews/comments live on a PR). If a PR already exists it's reused; **if none exists, Phase 3 opens one** and pushes the generated plan + review summary (skipped only under `--dry-run`).

### 1.3 Authenticate

The plan/summary always post to a PR (existing or freshly opened) unless `--dry-run`, so authenticate whenever `--dry-run` is not set. The token is re-minted under the **lead's** GitHub App at post time (Phase 3d) so the PR and its comment share one identity; this early mint is just to fail fast on auth problems:

```bash
export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)
```

Auth failure → warn, continue without PR posting.

### 1.4 Approach Contract

Before dispatching the lead/wing loop, confirm the approach:
```bash
node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/approach_contract.ts --plan-file <path> --force-confirm
```

## Phase 2: Lead/Wing Loop

Dispatch the paired lead/wing loop. The dispatcher runs the lead in round 1, then up to `max_rounds` review→fix iterations: wing reviews → if `revise`, lead re-runs with the wing's blocking findings → wing reviews the new draft. It exits on the first `approve`, on `block`, on `--max-rounds` exhaustion, on an empty-draft revision, on an unchanged-from-prior revision, or on any unrecoverable agent error.

```bash
node --experimental-strip-types "$TOOLS/plan_dispatch.ts" \
  --spec-file "$path" \
  --generate-prompt-file "$PROMPTS/spec-to-plan/$lead/generate.md" \
  --review-prompt-file "$PROMPTS/spec-to-plan/$wing/review.md" \
  --revise-prompt-file "$PROMPTS/spec-to-plan/$lead/revise.md" \
  --lead "$lead" \
  --wing "$wing" \
  --max-rounds "$max_rounds" \
  --timeout "$timeout" \
  --wing-timeout "$wing_timeout"
```

The exit code is `0` only when `final_verdict == "approved"`.

The dispatcher prints a JSON object on stdout:

```json
{
  "lead": "claude",
  "wing": "codex",
  "final_verdict": "approved | blocked | aborted | max_rounds_unresolved | unresolved",
  "error": null,
  "duration_s": 123.4,
  "rounds": [
    {
      "round": 1,
      "draft_length": 6234,
      "verdict": "revise",
      "blocking_findings": ["..."],
      "non_blocking_suggestions": ["..."],
      "summary": "...",
      "parse_retry_used": false,
      "duration_s": 60.1,
      "error": null
    }
  ],
  "final_plan": "# ...full markdown plan..."
}
```

Read the final plan from `final_plan`. Per-round metadata (verdict, findings, parse retries) lives in `rounds[]` for the audit trail (Phase 4).

### Handle terminal verdicts

| `final_verdict` | Action |
|---|---|
| `approved` | Continue to Phase 3 (output + persist). |
| `blocked` | Stop. Print the wing's `summary` and `blocking_findings` from the last round. Do not write output files. |
| `aborted` | Lead's round-1 generate failed (timeout, empty draft, or CLI error). Stop, surface the round-1 `error`. |
| `max_rounds_unresolved` | Wing did not approve within `--max-rounds` fix rounds. Stop, print all rounds' findings. |
| `unresolved` | Loop terminated for another reason (wing parse retry exhausted, empty-draft revision, mid-loop lead failure). Stop, surface the `error` field and the latest findings. |

In every non-`approved` case, do **not** write the plan file or post to the PR. Surface what's needed to address the failure manually, then exit.

## Phase 3: Output & Persist

### 3a. Terminal summary

Print:
```
Spec-to-Plan Complete
───────────────────────
Spec:          {path}
Lead:          {lead}
Wing:          {wing}
Rounds:        {N} ({verdict-of-each})
Final verdict: approved
Output:        {output_path}
```

### 3b. Write plan file (skip in --dry-run)

Write the approved plan alongside the spec file:
- If the input spec is `docs/specs/2026-03-27-auth-design.md`
- Plan goes to `docs/specs/2026-03-27-auth-plan.md`

Naming: replace `-design.md` with `-plan.md`. If the input filename doesn't end with `-design.md`, append `.plan.md`. Store the result as `$plan_path` (referenced in 3d).

### 3c. Write review summary (skip in --dry-run)

Write per-round details to `{spec-name}.s2p-review.md` alongside the spec file. Store the result as `$review_summary_path` (referenced in 3d).

Contents:
- Per-round verdict, blocking findings, non-blocking suggestions, summary
- Total duration, round count, lead/wing identities

### 3d. Open-or-reuse the PR and post the review summary (skip in --dry-run)

The plan + review summary always land on a PR. If a PR already exists, post the summary comment to it. **If none exists, open one** — cut a branch, push the generated plan + review summary, and create the PR — so the findings live with the plan. All of 3d is skipped under `--dry-run`.

Resolve the lead's GitHub App identity (the PR and its comment share one identity):

| Lead | App identity |
|---|---|
| `claude` | stark-claude |
| `codex` | stark-codex |
| `gemini` | stark-gemini |

```bash
lead_app="stark-$lead"   # stark-claude | stark-codex | stark-gemini

# Open a fresh PR this run? Only when none exists (never in --dry-run — 3d is skipped entirely there).
open_pr=0
[ -z "$pr_number" ] && open_pr=1
```

**3d.i — Ensure a working branch (never commit to the default branch).** The spec is already committed (Phase 1 aborts on a dirty spec without `--force`); the plan + summary written in 3b/3c are new files to land on a branch:

```bash
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
default_branch=${default_branch:-main}
stem=$(basename -- "$path" | sed -E 's/\.[^.]+$//')
cur=$(git branch --show-current)
if [ "$cur" = "$default_branch" ] || [ -z "$cur" ]; then
  branch="spec-to-plan/${stem}-$(date +%Y%m%d-%H%M%S)"
  git switch -c "$branch"
else
  branch="$cur"
fi
```

Commits use the repo's own `user.name`/`user.email` (per workspace policy, `21-Stark-AI` repos commit as `Aryeh Stark <aryeh@21stark.com>`).

**3d.ii — Commit the plan + review summary** (path-pathspec form; never `git commit -a`):

```bash
git add -- "$plan_path" "$review_summary_path"
git commit -m "docs(plan): implementation plan for $(basename -- "$path")

Lead: $lead · Wing: $wing · Rounds: $rounds ($final_verdict)" \
  -- "$plan_path" "$review_summary_path"
```

If the commit fails (hook rejection, nothing new to commit), warn and continue — the files are already on disk from 3b/3c.

**3d.iii — Open the PR and push (only when none exists):**

```bash
if [ "$open_pr" = 1 ]; then
  git push -u origin HEAD
  created=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app "$lead_app" \
      --repo "$REPO" pr create \
      --head "$branch" \
      --base "$default_branch" \
      --title "Plan: $(basename -- "$path")" \
      --body "Implementation plan generated from \`$path\` (lead \`$lead\`, wing \`$wing\`). Plan at \`$plan_path\`; per-round review summary at \`$review_summary_path\`.")
  pr_number=$(printf '%s\n' "$created" | grep -oE '#[0-9]+' | head -n1 | tr -d '#')
fi
```

Push/create failure → warn and continue; the commit is durable locally and the user can open the PR manually. For an **existing** PR, do **not** push — the user controls when the branch goes up; the comment below still posts via the API.

**3d.iv — Post the review summary comment** under the lead's App (skip if there's still no `pr_number`, e.g. the open in 3d.iii failed). Post as an issue comment (`pr comment`), not a PR review — review comments live under `/pulls/N/reviews` and are harder to surface:

```bash
export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app "$lead_app" token)
[ -n "$pr_number" ] && node --experimental-strip-types "$TOOLS/github_app.ts" --app "$lead_app" \
  pr comment "$pr_number" --body "$summary"
```

## Phase 4: Persist history

```bash
mkdir -p ~/.claude/code-review/history/spec-to-plan/{spec-filename}
```

Write:
- `dispatch.json` — full JSON from the dispatcher (lead, wing, final_verdict, rounds[], final_plan)
- `plan.md` — final plan content (same as the file written in 3b)
- `summary.md` — human-readable summary
- `rounds.jsonl` — one JSONL entry per round (round, verdict, blocking_findings, summary, parse_retry_used)

## Failure Modes

Most failure modes are owned by the dispatcher (listed for orchestrator awareness):

| Scenario | Dispatcher behavior | Orchestrator action |
|---|---|---|
| No path provided | (Pre-dispatch) | "Usage: /stark-spec-to-plan <path>" |
| File not found | (Pre-dispatch) | Search docs/ for candidates |
| Uncommitted changes | (Pre-dispatch) | "Commit or stash first, or use --force" |
| `--lead` == `--wing` | `error=lead_eq_wing` returned immediately | Refuse before dispatch in §1; never reach dispatcher |
| Lead times out / errors on round 1 | `final_verdict=aborted`, `error` set | Stop the run; surface error |
| Lead emits empty draft on round 1 | `final_verdict=aborted`, `error=lead_round1_empty_draft` | Stop; investigate generate prompt |
| Wing times out reviewing | Dispatcher retries once; if still fails, treats as `unresolved` with `error=wing_error:timeout` | Stop; surface error |
| Wing returns malformed JSON verdict | Dispatcher retries once with explicit "JSON only" suffix; if still malformed, treats as `revise` and continues the fix loop | Trust the dispatcher; review `parse_retry_used` in audit log |
| Wing returns `block` verdict | `final_verdict=blocked`, `error=wing_blocked` | Stop the run; print wing's `summary` and `blocking_findings` |
| Lead's revision produces empty draft | `final_verdict=unresolved`, `error=lead_fix_round_empty_draft` | Stop; surface findings — lead is stuck |
| Lead's revision is identical to prior round | `final_verdict=unresolved`, `error=lead_fix_round_no_change` | Stop; surface findings — lead made no progress |
| Lead errors mid-loop | `final_verdict=unresolved`, `error=lead_fix_round_failed:*` | Stop; surface error |
| `--max-rounds` exhausted without approval | `final_verdict=max_rounds_unresolved`, all rounds in `rounds[]` | Stop; print every round's blocking_findings; operator decides whether to retry with more rounds or fix the spec |
| Tool not found (claude/codex/gemini CLI missing) | `agent_unavailable` | Run installer or check PATH |
