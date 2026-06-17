---
name: stark-design-to-plan
description: >-
  Convert design docs into phased implementation plans via paired lead/wing agents. Lead drafts, wing reviews, fix-loop until approved. Use for plan from design/spec.
argument-hint: "<path> [--lead claude|codex|gemini] [--wing claude|codex|gemini] [--max-rounds N] [--timeout N] [--wing-timeout N] [--dry-run] [--force]"
disable-model-invocation: true
model: opus
revision: 6943b7a3856c1caabf33b8449f6ed1604d203423
revision_date: 2026-05-19T05:45:53Z
---

## Preflight

Run environment validation before proceeding:
```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/preflight.ts --workflow stark-design-to-plan --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue if both the configured lead and wing agents are available.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-design-to-plan

Generate a phased implementation plan from a design document via a paired **lead/wing** subagent loop:

- **Lead** (default `claude`) — drafts the plan from the design doc
- **Wing** (default `codex`) — reviews the draft, returns approve / revise / block JSON verdict
- **Fix loop** — on `revise`, lead receives the wing's blocking findings + prior draft and emits a revised plan; wing re-reviews. Loops until `approve`, `block`, or `--max-rounds` exhaustion.

This is the cheaper, lower-variance sibling of the prior 3-agent tournament. Paired writing instead of competition.

This skill is thin: it orchestrates `tools/plan_dispatch.ts`, which owns the dispatch, the review→fix loop, and the JSON verdict parsing. Do not re-implement that logic here.

Fills the pipeline gap: `/stark-review-design` → **`/stark-design-to-plan`** → `/stark-review-plan` → `/stark-plan-to-tasks`.

## Arguments

- `<path>` — path to design/spec markdown file (required)
- `--lead AGENT` — lead implementer agent ID (default: `claude`). One of `claude`, `codex`, `gemini`.
- `--wing AGENT` — wing reviewer agent ID (default: `codex`). Must differ from `--lead`.
- `--max-rounds N` — maximum **fix** rounds after the initial draft (default: `4`). The wing reviews up to `N+1` times.
- `--timeout N` — per-lead-invocation timeout in seconds (default: 900)
- `--wing-timeout N` — per-wing-invocation timeout in seconds (default: 600)
- `--dry-run` — generate plan but don't write output files or post to PR
- `--force` — proceed even if design file has uncommitted changes

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

- Confirm `<path>` argument was provided. If not, error: "Usage: /stark-design-to-plan <path>"
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
```

Store for Phase 4 if present.

### 1.3 Authenticate (only if PR detected)

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
  --design-file "$path" \
  --generate-prompt-file "$PROMPTS/design-to-plan/$lead/generate.md" \
  --review-prompt-file "$PROMPTS/design-to-plan/$wing/review.md" \
  --revise-prompt-file "$PROMPTS/design-to-plan/$lead/revise.md" \
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
Design-to-Plan Complete
───────────────────────
Design:        {path}
Lead:          {lead}
Wing:          {wing}
Rounds:        {N} ({verdict-of-each})
Final verdict: approved
Output:        {output_path}
```

### 3b. Write plan file (skip in --dry-run)

Write the approved plan alongside the design file:
- If design is `docs/specs/2026-03-27-auth-design.md`
- Plan goes to `docs/specs/2026-03-27-auth-plan.md`

Naming: replace `-design.md` with `-plan.md`. If the design filename doesn't end with `-design.md`, append `.plan.md`.

### 3c. Write review summary (skip in --dry-run)

Write per-round details to `{design-name}.d2p-review.md` alongside the design file.

Contents:
- Per-round verdict, blocking findings, non-blocking suggestions, summary
- Total duration, round count, lead/wing identities

### 3d. Post to PR (if PR detected and not --dry-run)

Post the summary under the lead's GitHub App identity:

| Lead | App identity |
|---|---|
| `claude` | stark-claude |
| `codex` | stark-codex |
| `gemini` | stark-gemini |

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app $lead_app pr review $pr_number --comment --body "$summary"
```

## Phase 4: Persist history

```bash
mkdir -p ~/.claude/code-review/history/design-to-plan/{design-filename}
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
| No path provided | (Pre-dispatch) | "Usage: /stark-design-to-plan <path>" |
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
| `--max-rounds` exhausted without approval | `final_verdict=max_rounds_unresolved`, all rounds in `rounds[]` | Stop; print every round's blocking_findings; operator decides whether to retry with more rounds or fix the design |
| Tool not found (claude/codex/gemini CLI missing) | `agent_unavailable` | Run installer or check PATH |
