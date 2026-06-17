---
name: stark-copilot
description: >-
  Autonomous lead/wing implementation: lead subagent implements, wing subagent reviews, fix-loop until wing approves. Use for copilot, paired build.
argument-hint: '<plan-or-prompt> [--plan-slug SLUG] [--test-command CMD] [--lead claude|codex|gemini] [--wing claude|codex|gemini] [--max-rounds N] [--timeout N] [--dry-run]'
disable-model-invocation: true
model: opus
revision: 63a8c794adafa2df8a713b4dcf9743a09e3c7cfc
revision_date: 2026-05-18T19:17:41Z
---

## Preflight

Run environment validation before proceeding:
```bash
node --experimental-strip-types ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/preflight.ts --workflow stark-copilot --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue if both the configured lead and wing agents are available.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-copilot

Autonomous implementation with a paired **lead/wing** subagent loop:

- **Lead** (default `claude`) — implements the step in a git worktree
- **Wing** (default `codex`) — reviews the lead's diff and either approves or returns blocking findings

Each step runs a review→fix loop until the wing approves or `--max-rounds` fix rounds are exhausted.

This skill is thin: it orchestrates `tools/copilot_dispatch.ts`, which owns the worktree,
the lead/wing dispatch, the review→fix loop, and the JSON verdict parsing. Do not
re-implement that logic here.

## Arguments

- `<plan-or-prompt>` — path to implementation plan, or inline task description
- `--plan-slug SLUG` — fetch issues labeled `plan:{SLUG}` from GitHub and use as steps (alternative to plan file)
- `--test-command CMD` — test command to run after each lead pass (e.g., `npm test`, `pytest`)
- `--lead AGENT` — lead implementer agent ID (default: `claude`). One of `claude`, `codex`, `gemini`.
- `--wing AGENT` — wing reviewer agent ID (default: `codex`). Must differ from `--lead`.
- `--max-rounds N` — maximum **fix** rounds after the initial implement (default: `4`). The wing reviews up to `N+1` times.
- `--timeout N` — per-lead-invocation timeout in seconds (default: 900)
- `--wing-timeout N` — per-wing-invocation timeout in seconds (default: 600)
- `--no-goal` — disable the goal-driven lead loop. When the lead is `claude` (the default), the lead's implement prompt is prefixed with a `/goal` directive (§2a) so it keeps iterating until tests pass; `--no-goal` reverts to a single bounded pass. Ignored when the lead is `codex`/`gemini` (`/goal` is a Claude Code feature).
- `--parallel` — when the steps are mutually independent (no step builds on another's merged result), fan them out concurrently via a Workflow instead of the sequential Phase 2 loop. See [Parallel steps](#parallel-steps-opt-in).
- `--dry-run` — show what would happen without executing

If `--lead` and `--wing` resolve to the same agent, error and stop:
> Error: --lead and --wing must be different agents.

If no input provided, ask: "What should I build?"

**Raw input:** `$ARGUMENTS`

## Constants

```bash
TOOLS="${STARK_REVIEW_TOOLS:-${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
# LEAD  — resolved from --lead, default claude
# WING  — resolved from --wing, default codex
```

## Phase 1: Setup

### 1.1 Parse input

Three input modes, resolved in this order:

**Issue-driven (preferred — from `/stark-plan-to-tasks` output):** If `--plan-slug SLUG` is provided, or if the input is a `.md` file path, attempt to load steps from GitHub issues:

1. Derive `PLAN_SLUG`:
   - If `--plan-slug` was given, use it directly
   - If a plan file was given, derive from filename: strip `.md`, strip known suffixes (`-design`, `-spec`, `-plan`). Truncate to 47 chars + 3-char hash if >50. Same logic as `/stark-plan-to-tasks` §1.7.

2. Detect target repo (frontmatter → body scan → `git remote -v` → ask user).

3. Fetch issues:
   ```bash
   unset GH_TOKEN
   gh issue list \
     --label "plan:$PLAN_SLUG" \
     --repo $ORG_REPO \
     --state all \
     --json number,title,body,labels,state \
     --limit 200
   ```

4. If issues found: enter **issue-driven mode** (see §1.2).
5. If no issues found and input is a `.md` file: fall back to **plan-file mode** with a warning.
6. If no issues found and `--plan-slug` was explicit: error and stop.

**Plan file (fallback):** If input is a `.md` file and no matching issues were found, read it and extract the step list. Each `## Phase N` or `### Task N` heading becomes a step.

**Inline prompt:** If input is a description (not a file path, no `--plan-slug`), decompose into steps yourself.

When a plan file path is available, retain it as `plan_path` for the approach contract step. When in inline mode, leave `plan_path` unset.

### 1.2 Extract steps

**Issue-driven mode:**

Group fetched issues into phases and tasks:

1. **Identify phase tracking issues** — issues whose title starts with "Phase" and whose body contains a task checklist (`- [ ] #NNN`)
2. **Identify task issues** — all other issues with the `plan:{PLAN_SLUG}` label
3. **Group tasks under phases** by matching the phase reference in each task's Dependencies section or by the task checklist in the phase issue
4. **Order phases** by their dependency links (phase `depends_on` from the issue body)
5. **Filter by ai_suitability** (from the issue body metadata):
   - `autonomous` and `assisted` tasks → include in steps
   - `human-led` tasks → skip with warning:
     > Skipping human-led task #{number}: {title} — requires manual implementation
6. **Skip already-closed tasks** — if `state` is `CLOSED`, skip:
   > Skipping #{number}: {title} — already closed

If ALL tasks in a phase are closed or human-led, skip the entire phase:
> Skipping phase {step_id}: all tasks are closed or human-led.

**Plan-file mode / Inline mode:**

Parse the plan into an ordered list of steps.

Regardless of mode, each step contains:
- `step_id` — phase slug (e.g., `phase-1-data-model`)
- `title` — phase name
- `task` — the raw step task description (issue body sections concatenated, or the parsed plan section, or the inline prompt). Saved to `step-$step_id-task.md` for the dispatcher.
- `prompt` — the lead's full implement prompt (composed from the agent-specific `implement.md` template + previous-step context + `task`). Saved to `step-$step_id-implement.md`.
- `issue_numbers` — issue numbers covered by the step

### 1.3 Detect test command

If `--test-command` provided, use it. Otherwise, auto-detect:
```bash
[ -f "package.json" ] && grep -q '"test"' package.json && echo "npm test"
[ -f "pyproject.toml" ] && echo "pytest"
[ -f "Makefile" ] && grep -q '^test:' Makefile && echo "make test"
```

If no test command found, warn: "No test command detected. Wing review will rely on semantic evaluation only."

### 1.4 Show battle plan

```
stark-copilot — Battle Plan
───────────────────────────
Mode:         issue-driven (plan:widget-system, 12 tasks across 4 phases)
Steps:        4
Lead:         claude   (implementer)
Wing:         codex    (reviewer)
Max rounds:   4 fix rounds (up to 5 reviews per step)
Test command: pytest
Timeout:      900s lead / 600s wing

Step 1: Data Model & Storage (#37, #38, #39)
Step 2: API Layer (#40, #41, #42)
...

Each step: lead implements in worktree → wing reviews diff → fix-loop until approved → merge
```

In plan-file or inline mode, replace the Mode line with `Mode: plan-file` or `Mode: inline`.

**No-op case:** If every phase is skipped (all tasks closed or human-led), still print the banner with `Steps: 0` and a `(no actionable steps)` line in place of the per-step list, followed by a `Skipped phases:` block enumerating each skipped phase with the phase number, issue number, and `(N/M closed)` count. Then exit with a clear "Nothing to do — all tasks already implemented." message. Do not invoke the dispatcher.

If `--dry-run`, stop here.

### 1.5 Approach Contract

Only when `plan_path` is set (plan-file or issue-driven mode that originated from a plan file). Inline mode skips this step.

```bash
[ -n "$plan_path" ] && node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/approach_contract.ts --plan-file "$plan_path" --force-confirm
```

## Phase 2: Execute Steps

For each step (sequentially — each builds on the previous step's merged result):

### 2a0. Transition issues to In Progress

Update issue status and project board. For commands, see [references/issue-management.md](references/issue-management.md).

### 2a. Stage prompt files

Write three files for the dispatcher (replace `$$` with the orchestration PID or any unique tag):

- `/tmp/stark-copilot-$$/step-$step_id-implement.md` — the lead's full implement prompt (composed from `global/prompts/copilot/{LEAD}/implement.md` + previous-step context + step task). Do **not** embed a `/goal` directive in this file — goal mode is enabled via the `--goal-condition` flag in §2b instead (a `/goal` line in a stdin-piped prompt is read as plain text and does **not** loop; verified 2026-06-03, Claude Code 2.1.161). The dispatcher prepends `/goal` and routes the prompt as a `-p` argument for you.
- `/tmp/stark-copilot-$$/step-$step_id-review.md` — the wing's review prompt template (verbatim copy of `global/prompts/copilot/{WING}/review.md`)
- `/tmp/stark-copilot-$$/step-$step_id-task.md` — the step's raw task description (used by the dispatcher to build the wing's review payload and the lead's fix prompts)

### 2b. Dispatch the copilot loop

```bash
node --experimental-strip-types "$TOOLS/copilot_dispatch.ts" \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --implement-prompt-file /tmp/stark-copilot-$$/step-$step_id-implement.md \
  --review-prompt-file /tmp/stark-copilot-$$/step-$step_id-review.md \
  --step-task-file /tmp/stark-copilot-$$/step-$step_id-task.md \
  --lead "$LEAD" \
  --wing "$WING" \
  --max-rounds "$max_rounds" \
  --timeout "$timeout" \
  [--test-command "$test_command"] \
  [--goal-condition "the step is fully implemented and the project's test suite passes" --goal-max-budget-usd "${STARK_GOAL_MAX_BUDGET_USD:-10}"]
```

Pass `--goal-condition` **by default when `LEAD` is `claude`** (omit it when `--no-goal` is set or the lead is `codex`/`gemini`). With it set, the dispatcher prefixes the lead's prompt with `/goal …` and runs it as a `-p`-argument goal loop that iterates until tests pass, bounded by `--goal-max-budget-usd` and `--timeout`. The condition omits "committed" on purpose — rule 6 of the implement prompt keeps the lead from committing; the dispatcher owns git and the wing reviews the worktree diff.

> **Budget guard:** `--goal-max-budget-usd` is mandatory in goal mode. A missing, zero, or non-numeric value never disables the guard — the dispatcher falls back to its built-in default ($10) rather than running unbounded.
>
> **Security note:** the goal loop requires the prompt to be passed as a `-p` **argument** (stdin doesn't trigger `/goal`), so the prompt is visible in `ps`/process listings. The composed prompt carries only issue/plan/task text — **never put secrets in it** (the skills don't interpolate credentials into prompts).

The dispatcher owns the loop. It runs the lead in a worktree (round 1), then up to
`max_rounds` review→fix iterations: wing reviews → if `revise`, lead re-runs in the
same worktree with the wing's blocking findings → wing reviews the new diff. It exits
on the first `approve`, on `block`, on `--max-rounds` exhaustion, on an empty-diff
revision (lead made no changes between rounds), or on any unrecoverable agent error.

The exit code is `0` only when `final_verdict == "approved"`.

### 2c. Parse dispatcher output

The dispatcher prints a JSON object with this shape:

```json
{
  "step_id": "...",
  "lead": "claude",
  "wing": "codex",
  "worktree_path": "/.../.worktrees/copilot-claude-...",
  "final_verdict": "approved | blocked | aborted | max_rounds_unresolved | unresolved",
  "error": null,
  "duration_s": 123.4,
  "rounds": [
    {
      "round": 1,
      "files_changed": ["..."],
      "lines_added": 42,
      "lines_removed": 7,
      "diff_length": 1234,
      "test_passed": true,
      "verdict": "revise",
      "blocking_findings": ["..."],
      "non_blocking_suggestions": ["..."],
      "summary": "...",
      "parse_retry_used": false,
      "duration_s": 60.1,
      "error": null
    }
  ],
  "final_diff": "..."
}
```

Read the lead's diff from `final_diff`. The worktree path is at `worktree_path`.
Per-round metadata (verdict, findings, parse retries) lives in `rounds[]` for the
audit trail (Phase 4).

### 2d. Handle terminal verdicts

| `final_verdict` | Action |
|---|---|
| `approved` | Continue to §2e (verify gates → apply diff → commit). |
| `blocked` | Stop the run. Print the wing's `summary` and `blocking_findings` from the last round. Do not retry. Clean up worktree (§2g). |
| `aborted` | Lead's first round failed (timeout, empty diff, or CLI error). Stop the run, surface the round-1 `error`. Clean up worktree. |
| `max_rounds_unresolved` | Wing did not approve within `--max-rounds` fix rounds. Stop the run, print all rounds' findings. Clean up worktree. |
| `unresolved` | Loop terminated for another reason (wing parse retry exhausted, empty-diff revision, mid-loop lead failure). Stop the run, surface the `error` field and the latest findings. Clean up worktree. |

In every non-`approved` case, do **not** apply the diff or commit. Surface what's
needed to address the failure manually, then exit.

### 2e. Verify approved diff (MANDATORY — do not skip)

Before applying, the approved diff must pass the import, SDK API, and cross-module
gates. For procedures, see [references/verification-gates.md](references/verification-gates.md).

Run the gates against the lead's worktree (use `worktree_path` from §2c). If a gate fails:

- If the run still has fix budget remaining (i.e., the dispatcher exited with `final_verdict == "approved"` before round `max_rounds + 1`, **and** you choose to invest one more round), append the gate failure to the wing's findings format and re-invoke `copilot_dispatch.ts` with `--max-rounds 1` and the wing's prior findings included in the implement prompt's "REVISION" framing. This burns one additional dispatcher invocation; surface that explicitly.
- Otherwise, stop the run with the gate failure surfaced. Do not silently fall back. The user must address the gate finding manually or rerun with a higher `--max-rounds`.

### 2f. Apply approved diff

Apply the dispatcher's `final_diff` to the main working tree:

```bash
git apply --3way <<< "$final_diff"
```

If the diff fails to apply cleanly (rare — the worktree was branched from main's HEAD), fall back to copying changed files from `worktree_path` over to `$REPO_ROOT`.

### 2g. Commit step

```bash
git add -A
git commit -m "feat: [step title] (copilot: $LEAD impl, $WING review, $rounds_count rounds)"
```

`$rounds_count` is `len(rounds)` from §2c.

### 2g1. Transition issues to Done

Close issues with commit reference and update project board. For commands, see [references/issue-management.md](references/issue-management.md).

### 2h. Clean up worktree

```bash
node --experimental-strip-types "$TOOLS/copilot_dispatch.ts" \
  --repo-root $REPO_ROOT \
  --step-id "$step_id" \
  --lead "$LEAD" \
  --cleanup
```

### 2i. Log and continue

Print step summary (lead, wing, rounds count, final verdict, files changed, test result). Move to the next step.

### 2j. Session state update

After each step completes:
```bash
node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/session_state.ts --json 2>/dev/null || true
```
Generate a checkpoint every `context_compaction.checkpoint_interval_minutes` minutes (default 15):
```bash
node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/context_compactor.ts --json 2>/dev/null || true
```

## Phase 2.5: End-of-Run Verification (MANDATORY)

After ALL steps complete, run the full import chain test, smoke test, and SDK API spot-check. For procedures, see [references/verification-gates.md](references/verification-gates.md).

If ANY check fails, fix before proceeding to Phase 3.

## Phase 3: Summary

Print:
- Per-step results: step_id, title, rounds count, final verdict, test pass/fail, files changed
- Aggregate: total rounds across all steps, average rounds per step, lead/wing identities, total duration
- Code stats: lines added/removed, files touched

## Phase 4: Persist

### 4a. Save history

```bash
mkdir -p ~/.claude/code-review/history/copilot/{task-slug}
```

Write:
- `steps.json` — per-step dispatcher results (the full JSON from §2c, one per step)
- `summary.md` — human-readable summary
- `review-log.jsonl` — flatten every round across every step into a JSONL audit trail with `{step_id, round, verdict, blocking_findings, summary, parse_retry_used}`

### 4b. Post to PR (if PR detected)

If the working tree is on a branch with an open PR (detect via `gh pr view --json number,headRefName --jq .number 2>/dev/null`), post the summary as a PR comment under the lead's GitHub App identity:

| Lead | App identity |
|---|---|
| `claude` | stark-claude |
| `codex` | stark-codex |
| `gemini` | stark-gemini |

For the `gh api` posting snippet, see [references/issue-management.md](references/issue-management.md).

## Parallel steps (opt-in)

Active only with `--parallel`, and only sound when the steps are **mutually independent** — no step's implement prompt references a prior step's merged result. The default copilot contract is sequential ("each builds on the previous step's merged result"), so most plans should NOT use this.

When the steps are independent, call the **Workflow** tool and run one `copilot_dispatch.ts` lead/wing loop per step concurrently, each in its own worktree (the dispatcher already isolates per step, so no extra `isolation` flag is needed beyond distinct `--step-id`s):

```js
export const meta = {
  name: 'copilot-parallel',
  description: 'Run independent copilot lead/wing loops concurrently',
  phases: [{ title: 'Build' }],
}
const steps = args.steps // [{step_id, title, ...}]
const results = await parallel(steps.map(s => () =>
  agent(`Dispatch copilot_dispatch.ts for step ${s.step_id} (lead/wing loop) and return its JSON verdict.`,
        { label: `copilot:${s.step_id}`, phase: 'Build', schema: STEP_VERDICT_SCHEMA })))
return results.filter(Boolean)
```

After the Workflow returns, apply each approved diff and commit in a deterministic order (§2e–§2g), then run end-of-run verification (Phase 2.5) once across the combined result. If any step came back non-`approved`, surface it and do not apply that step's diff.

> **Constraint:** parallel mode trades the build-on-previous guarantee for throughput. If any step depends on another, leave `--parallel` off.

## Failure Modes

For the baseline failure modes (worktree, dispatch, agent CLI), see [references/failure-modes.md](references/failure-modes.md). Copilot-specific additions (the dispatcher already handles most of these — listed for orchestrator awareness):

| Scenario | Dispatcher behavior | Orchestrator action |
|---|---|---|
| Lead times out / errors on round 1 | `final_verdict=aborted`, `error` set | Stop the run; surface error |
| Wing times out reviewing | Dispatcher retries once; if still fails, treats as `unresolved` with `error=wing_error:timeout` | Stop the run; surface error |
| Wing returns malformed JSON verdict | Dispatcher retries once with explicit "JSON only" suffix; if still malformed, treats as `revise` and continues the fix loop | Trust the dispatcher; review `parse_retry_used` in audit log |
| `--lead` == `--wing` | `error=lead_eq_wing` returned immediately | Refuse before dispatch in §1; never reach dispatcher |
| Lead's revision round produces empty diff vs prior round | `final_verdict=unresolved`, `error=lead_fix_round_no_change` | Stop the run; surface findings — lead is stuck |
| Wing returns `block` verdict | `final_verdict=blocked`, `error=wing_blocked` | Stop the run; print wing's `summary` and `blocking_findings` |
| Wing mutates the worktree (read-only contract violation) | `final_verdict=unresolved`, `error=wing_mutation_detected`. Worktree is restored to the pre-review snapshot via `git reset --hard <pre-HEAD> && git clean -fd`. | Stop the run; surface the violation. The wing is invoked read-only (claude allowlist; codex `-s read-only`; gemini `approval_mode=plan`), so this is a hard contract bug if it fires. |
| Verification gate fails after wing approval (§2e) | (Out of dispatcher scope) | Either burn one extra dispatcher round with the gate failure as a finding, or stop the run |
