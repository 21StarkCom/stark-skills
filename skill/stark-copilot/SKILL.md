---
name: stark-copilot
description: >-
  Autonomous lead/wing implementation: lead subagent implements, wing subagent reviews, fix-loop until wing approves. Use for copilot, paired build.
argument-hint: '<plan-or-prompt> [--plan-slug SLUG] [--test-command CMD] [--lead claude|codex|gemini] [--wing claude|codex|gemini] [--max-rounds N] [--timeout N] [--sequential] [--parallel] [--ready] [--dry-run]'
disable-model-invocation: true
model: opus
revision: 63a8c794adafa2df8a713b4dcf9743a09e3c7cfc
revision_date: 2026-05-18T19:17:41Z
---

## Help

If `$ARGUMENTS` requests help (a standalone `--help`, `-h`, or `help` token),
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

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
- `--parallel` — force-treat ALL steps as mutually independent (one wave), overriding the dependency DAG. Use only when you know the deps metadata is over-conservative. Parallelism within a wave is otherwise **on by default** via the execution DAG (§1.4); see [Parallel waves](#parallel-waves-default).
- `--sequential` — disable DAG-driven parallelism entirely; run every step one at a time in dependency order (the pre-DAG behavior).
- `--ready` (alias `--no-draft`) — open the impl PR ready-for-review instead of draft. Draft is the repo default (§2.6 lands the impl PR as a draft unless this is passed). `open_ready` (used in §2.6) is non-empty when either token is present in `$ARGUMENTS`.
- `--dry-run` — show what would happen without executing

If `--lead` and `--wing` resolve to the same agent, error and stop:
> Error: --lead and --wing must be different agents.

If both `--parallel` and `--sequential` are given, error and stop:
> Error: --parallel and --sequential are mutually exclusive.

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

When a plan file path is available, retain it as `plan_path` for the approach contract step. When in inline mode, leave `plan_path` unset. Retain the raw `<plan-or-prompt>` positional value itself (flags stripped) as `plan_or_prompt` — §1.7 uses it as the inline-mode branch-name fallback.

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

7. **Derive steps from the task DAG (chain-collapse).** A step is the dispatch unit — one worktree, one lead/wing loop. Steps are NOT fixed at phase granularity; they come from the **task-level** dependency graph (each task's `## Dependencies` `#NNN` links), per phase:
   - An edge to a `CLOSED` task is satisfied — drop it (reconnect its predecessors to its dependents).
   - An edge to an **open human-led** task is unsatisfiable this run — skip the dependent task and everything downstream of it, warning with the blocking issue: skipped-because-human ≠ done; never build on work that doesn't exist yet.
   - **Collapse chains:** merge task B into task A's step when A is B's only in-phase dependency and B is A's only dependent. A fully-linear phase collapses to exactly **one step** (today's behavior — shared context, one dispatcher loop, zero extra overhead); genuinely independent tasks or branches become separate steps that can share a wave (§1.4).

**Plan-file mode / Inline mode:**

Parse the plan into an ordered list of steps. If the sections carry dependency metadata, apply the same chain-collapse; otherwise each section is one step.

Regardless of mode, each step contains:
- `step_id` — the phase slug when the phase collapsed to one step (e.g., `phase-1-data-model`); otherwise `<phase-slug>--<first-task-slug>` (e.g., `phase-2-api--rest-endpoints`)
- `title` — the phase name, or `{phase name}: {first task title} (+K more)` for a multi-step phase
- `task` — the raw step task description (the step's issue bodies concatenated in chain order, or the parsed plan section, or the inline prompt). Saved to `step-$step_id-task.md` for the dispatcher.
- `prompt` — the lead's full implement prompt (composed from the agent-specific `implement.md` template + previous-step context + `task`). Saved to `step-$step_id-implement.md`.
- `issue_numbers` — issue numbers covered by the step
- `depends_on` — step ids this step's tasks depend on (external edges, projected onto steps)

### 1.3 Detect test command

If `--test-command` provided, use it. Otherwise, auto-detect:
```bash
[ -f "package.json" ] && grep -q '"test"' package.json && echo "npm test"
[ -f "pyproject.toml" ] && echo "pytest"
[ -f "Makefile" ] && grep -q '^test:' Makefile && echo "make test"
```

If no test command found, warn: "No test command detected. Wing review will rely on semantic evaluation only."

### 1.4 Plan the execution — dependency DAG → waves

Before showing the battle plan, compute an **execution plan**: level the §1.2 steps into **waves**. Steps in the same wave have no dependency edge between them and run **concurrently** (each in its own worktree via the Workflow fan-out — see [Parallel waves](#parallel-waves-default)); waves run sequentially, each branching from the previous wave's merged result.

**Edges, per mode:**

- **Issue-driven:** the projected task-level edges from §1.2.7 (`step.depends_on`), **plus phase barriers**: every step in phase P depends on every step of the phases P `depends_on`. Phases stay checkpoints — waves never span a phase boundary; the parallelism unlock is *within* a phase, where `/stark-plan-to-tasks` wrote explicit task deps. (Cross-phase pipelining from task metadata alone would trust silence; barriers are the fail-closed reading.)
- **Plan-file:** parse each step section for an explicit `Dependencies:` / `depends_on:` line. If the plan carries no dependency metadata at all, do NOT infer independence from silence — read each step's task text and mark an edge wherever a step names files, modules, interfaces, or outputs another step creates. When you cannot rule a dependency out, keep the edge.
- **Inline:** you decomposed the steps yourself — declare `depends_on` per step as you decompose.

**Leveling (Kahn):** wave 1 = steps with no unmet edges; wave N = steps whose edges all land in waves < N. A cycle is a plan defect — print the cycle and stop (do not guess an order).

**Fail-closed default:** ambiguous or missing dependency info ⇒ dependent (sequential). Wrong-parallel corrupts merges; wrong-sequential only costs wall-clock. `--sequential` collapses every step into its own wave; `--parallel` collapses all steps into one wave (explicit operator override only). Passing both is a contradiction — error and stop.

Record the result as `waves = [[step, ...], ...]` and carry it into Phase 2.

### 1.5 Show battle plan

```
stark-copilot — Battle Plan
───────────────────────────
Mode:         issue-driven (plan:widget-system, 11 tasks across 4 phases → 5 steps in 4 waves, 2 skipped)
Lead:         claude   (implementer)
Wing:         codex    (reviewer)
Max rounds:   4 fix rounds (up to 5 reviews per step)
Test command: pytest
Timeout:      900s lead / 600s wing

Wave 1: phase-1-data-model            (#37 → #38 → #39, chain)
Wave 2: phase-2-api--rest-endpoints   (#40 → #41)   ∥   phase-2-api--graphql (#42)
Wave 3: phase-3-cli                   (#43 → #44)
Wave 4: phase-4-docs                  (#45)
Skipped: #46 (human-led, open) and its dependent #47

Each step: lead implements in worktree → wing reviews diff → fix-loop until approved → merge
Steps sharing a wave run concurrently; waves run in order.
Widest wave: 2 steps — in goal mode that is up to 2 × $10 goal budget in flight at once.
```

In plan-file or inline mode, replace the Mode line with `Mode: plan-file` or `Mode: inline`.

**No-op case:** If every phase is skipped (all tasks closed or human-led), still print the banner with `Steps: 0` and a `(no actionable steps)` line in place of the per-step list, followed by a `Skipped phases:` block enumerating each skipped phase with the phase number, issue number, and `(N/M closed)` count. Then exit with a clear "Nothing to do — all tasks already implemented." message. Do not invoke the dispatcher.

If `--dry-run`, stop here.

### 1.6 Approach Contract

Only when `plan_path` is set (plan-file or issue-driven mode that originated from a plan file). Inline mode skips this step.

```bash
[ -n "$plan_path" ] && node --experimental-strip-types --no-warnings ${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/code-review}/tools/approach_contract.ts --plan-file "$plan_path" --force-confirm
```

### 1.7 Prepare the impl branch

Historically copilot committed every step directly onto whatever branch was checked out and never opened a PR — forge had no impl PR number to record or merge. Fix that here, **before any step commits**: adopt-or-create a deterministic impl branch so §2g's per-step commits land somewhere reachable, and resolve the repo + default branch §2.6 needs to land the PR.

```bash
repo="${ORG_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)}"
default_branch=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
default_branch=${default_branch:-main}

# fallback_slug only matters in inline mode — issue-driven and plan-file mode
# already derived PLAN_SLUG in §1.1. Slugify the raw <plan-or-prompt> arg.
fallback_slug=$(printf '%s' "$plan_or_prompt" | tr '[:upper:]' '[:lower:]' \
  | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-|-$//g' | cut -c1-40)

branch=$(node --experimental-strip-types "$TOOLS/copilot_land.ts" branch-name \
  --plan-slug "${PLAN_SLUG:-}" --fallback-slug "$fallback_slug")

node --experimental-strip-types "$TOOLS/copilot_land.ts" prepare-branch \
  --branch "$branch" --json
```

`branch-name` is deterministic (`copilot/<slug>`) — a re-invocation with the same plan slug (or, in inline mode, the same raw input) always names the same branch, and `prepare-branch` adopts it (ff-only merge against a matching local/remote branch; a genuinely diverged local branch is a hard error, never forced — see `tools/copilot_land_lib.ts`). Don't re-implement this logic in prose; both subcommands are the single source of truth.

## Phase 2: Execute Waves

**Clean-tree precondition:** before the first wave, `git status --porcelain` on `$REPO_ROOT` must be empty. If it isn't, stop and tell the user to commit or stash first — §2g's `git add -A` would sweep unrelated files into a step commit, and §2f's rollback path is only provably safe on a tree that was clean before the apply.

Execute the waves from §1.4 **in order**. Within a wave:

- **Single-step wave** — run §2a0–§2j inline, exactly as below.
- **Multi-step wave** — fan the steps out concurrently via the **Workflow** tool (see [Parallel waves](#parallel-waves-default)), then apply each approved diff and commit **in a deterministic order** (step order within the wave), running §2e–§2g1 per step and §2h cleanup. A non-`approved` step's diff is never applied; surface it and — since later waves may depend on it — stop before the next wave unless every remaining wave is provably independent of the failed step.

For each step, sequential or fanned-out:

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
| `blocked` | Stop the run. Print the wing's `summary` and `blocking_findings` from the last round. Do not retry. Clean up worktree (§2h). |
| `aborted` | Lead's first round failed (timeout, empty diff, or CLI error). Stop the run, surface the round-1 `error`. Clean up worktree. |
| `max_rounds_unresolved` | Wing did not approve within `--max-rounds` fix rounds. Stop the run, print all rounds' findings. Clean up worktree. |
| `unresolved` | Loop terminated for another reason (wing parse retry exhausted, empty-diff revision, mid-loop lead failure). Stop the run, surface the `error` field and the latest findings. Clean up worktree. |

In every non-`approved` case, do **not** apply the diff or commit. Surface what's
needed to address the failure manually, then exit.

### 2e. Verify approved diff (MANDATORY — do not skip)

Before applying, the approved diff must pass the import, SDK API, and cross-module
gates. For procedures, see [references/verification-gates.md](references/verification-gates.md).

Run the gates against the lead's worktree (use `worktree_path` from §2c). If a gate fails:

- If the run still has fix budget remaining (i.e., the dispatcher exited with `final_verdict == "approved"` before round `max_rounds + 1`, **and** you choose to invest one more round), run a **seeded re-dispatch** (below) with the gate failure as the findings. This burns one additional dispatcher invocation; surface that explicitly.
- Otherwise, stop the run with the gate failure surfaced. Do not silently fall back. The user must address the gate finding manually or rerun with a higher `--max-rounds`.

**Seeded re-dispatch** (used here and by the fan-out conflict path): a re-dispatch with the same `--step-id` force-recreates the worktree from HEAD — the dispatcher has no resume mode — so the approved work must be seeded back in. Seed it as a **diff file the prompt references by path**, never pasted inline (a diff can run to hundreds of KB):

1. Write the step's approved `final_diff` to `/tmp/stark-copilot-$$/step-$step_id-approved.diff`.
2. Re-stage prompt files under a **suffixed step id** (`$step_id-r2`, so the original run's artifacts and worktree aren't clobbered). The implement prompt uses "REVISION" framing: first `git apply --3way /tmp/stark-copilot-$$/step-$step_id-approved.diff` in your worktree (resolving any conflicts), then address the listed findings.
3. Invoke with `--step-id $step_id-r2 --max-rounds 1` and **without** `--goal-condition` — the retry is one bounded fix round, not a fresh goal loop with a fresh budget.
4. Afterwards run §2h cleanup for **both** step ids.

### 2f. Apply approved diff

Apply the dispatcher's `final_diff` to the main working tree:

`final_diff` is the dispatcher's `--binary --full-index` rendering, so binary and rename-heavy changes replay correctly. The working tree must be clean before applying (guaranteed by the Phase 2 precondition + per-step commits). On failure, **reset before doing anything else** — `git apply --3way` exits non-zero having already written conflict markers/partial hunks into the tree, and §2g's `git add -A` would commit that garbage:

```bash
git apply --3way <<< "$final_diff" || { git reset --hard HEAD && git clean -fd && apply_failed=1; }
```

(`git clean -fd` is safe here **only** because the tree was clean pre-apply — the only untracked files are ones the failed apply just created. That is what the Phase 2 precondition buys.)

On `apply_failed`:

- **Sequential step (HEAD unchanged since the worktree branched):** a conflict is rare here. Fall back to copying changed files from `worktree_path` over to `$REPO_ROOT` — sound only because both trees share the same base.
- **Fan-out step (HEAD moved — a sibling step in this wave already committed):** the file-copy fallback is **forbidden** — the worktree's files are based on the pre-wave HEAD and copying them silently reverts the sibling's committed edits. Instead, re-dispatch this single step against the new HEAD (see the conflict path in [Parallel waves](#parallel-waves-default)), or stop and surface it.

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

Print step summary (lead, wing, rounds count, final verdict, files changed, test result). Move to the next step in the wave, then the next wave.

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

## Phase 2.6: Land the impl PR

Push the branch prepared in §1.7 and adopt-or-open its PR. Steps only commit **locally** (§2g) — this phase is what makes that work reachable as a reviewable PR, and is what fixes copilot never having had an impl PR number to report or merge.

Skip entirely if no step ever reached §2g (every step failed before its first commit) — there is nothing to push. Leave `pr_number` and `prs` unset for Phase 3/4.

```bash
title="Impl: ${PLAN_SLUG:-$(basename -- "${plan_path:-$plan_or_prompt}")}"
body="Autonomous copilot implementation (lead \`$LEAD\`, wing \`$WING\`). $steps_total step(s) across $waves_total wave(s), $rounds_total total review round(s)."

ready_flag=()
[ -n "$open_ready" ] && ready_flag=(--ready)

landed=$(node --experimental-strip-types "$TOOLS/copilot_land.ts" land \
  --repo "$repo" \
  --branch "$branch" \
  --base "$default_branch" \
  --title "$title" \
  --body "$body" \
  --lead "$LEAD" \
  "${ready_flag[@]}" \
  --json)

pr_number=$(printf '%s' "$landed" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).pr.number))')
prs_csv=$(printf '%s' "$landed" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).prs))')
```

`land` pushes plainly — **never** `--force` (`tools/copilot_land_lib.ts`) — then adopts the open PR whose head is `$branch` or opens a fresh one, draft by default (`--ready`/`--no-draft` opts out), authored by the lead's GitHub App. A rejected (non-fast-forward) push is a hard error from the CLI — stop the run and surface it; never force past it.

`pr_number` is this run's branch's PR. `prs_csv` is the JSON array `land` returned — the complete set of impl PRs this run knows about (newly opened plus adopted) — carried into Phase 3's summary, §4b's comment, and the §4c completion line.

## Phase 3: Summary

Print:
- Per-step results: step_id, title, rounds count, final verdict, test pass/fail, files changed
- Aggregate: total rounds across all steps, average rounds per step, lead/wing identities, total duration
- Code stats: lines added/removed, files touched
- Impl PR: `$pr_number` (or "(none — no step committed)" when §2.6 was skipped)

## Phase 4: Persist

### 4a. Save history

```bash
mkdir -p ~/.claude/code-review/history/copilot/{task-slug}
```

Write:
- `steps.json` — per-step dispatcher results (the full JSON from §2c, one per step)
- `summary.md` — human-readable summary
- `review-log.jsonl` — flatten every round across every step into a JSONL audit trail with `{step_id, round, verdict, blocking_findings, summary, parse_retry_used}`

### 4b. Post to PR

Post the summary as a PR comment to the PR §2.6 already resolved (`$pr_number`), under the lead's GitHub App identity. Do **not** re-detect the PR here (e.g. via a second `gh pr view`) — §2.6 is the single source of truth for which PR this run's work landed on, and re-checking would just be a second, potentially divergent story.

| Lead | App identity |
|---|---|
| `claude` | stark-claude |
| `codex` | stark-codex |
| `gemini` | stark-gemini |

Skip this step if `$pr_number` is unset (§2.6 never ran).

For the `gh api` posting snippet, see [references/issue-management.md](references/issue-management.md).

### 4c. Completion line

As the literal last line of output, on **every** path through this skill — success or not — print exactly one `STARK_STAGE_SUMMARY` line (`standards/stage-completion-line.md`). It is additive: everything above it (Phase 3's summary, §4b's comment) is unchanged, and this line is not gated behind any `--json` flag (this skill has none).

```bash
if [ -n "$PLAN_SLUG" ]; then plan_slug_json="\"$PLAN_SLUG\""; else plan_slug_json=null; fi
cat <<EOF
STARK_STAGE_SUMMARY {"skill":"stark-copilot","outcome":"$outcome","plan_slug":$plan_slug_json,"prs":${prs_csv:-[]}}
EOF
```

`outcome` is this run's own terminal verdict: `all_approved` when every step in every wave reached `final_verdict=approved` and §2.6 landed cleanly; otherwise the specific halt reason already in play — `blocked`, `aborted`, `max_rounds_unresolved`, `unresolved` (§2d), `no_actionable_steps` (§1.5's no-op case), or `dry_run` (§1.5's `--dry-run` stop, which precedes everything from §1.7 onward). `plan_slug` mirrors `PLAN_SLUG` verbatim — `null` in inline mode, never re-derived. `prs` is `$prs_csv` from §2.6 — `[]` whenever §2.6 was skipped (dry-run, no-op, or every step failed before its first commit).

## Parallel waves (default)

Multi-step waves from the §1.4 execution DAG fan out via the **Workflow** tool: one `copilot_dispatch.ts` lead/wing loop per step, concurrently, each in its own worktree (the dispatcher already isolates per step, so no extra `isolation` flag is needed beyond distinct `--step-id`s). All worktrees in a wave branch from the same HEAD — the previous wave's merged result — which is exactly what the DAG guarantees is sufficient context.

Stage each step's three prompt files (§2a) and issue transitions (§2a0) **before** invoking the Workflow. Compose each step's §2b command **fully expanded** — concrete absolute paths, no `$TOOLS`/`$step_id` shell variables (the subagent's shell doesn't have the orchestrator's variables) — and redirect its stdout to a per-step result file: `… > /tmp/stark-copilot-$$/step-$step_id-result.json`. A dispatcher `final_diff` can run to hundreds of KB; the redirect keeps it out of model output — the subagent returns only a small verdict record, and the orchestrator reads the full JSON from the file itself. Then run one Workflow per multi-step wave:

```js
export const meta = {
  name: 'copilot-wave',
  description: 'Run one wave of independent copilot lead/wing loops concurrently',
  phases: [{ title: 'Build' }],
}
const VERDICT = {
  type: 'object',
  required: ['step_id', 'final_verdict', 'exit_code'],
  properties: {
    step_id: { type: 'string' },
    final_verdict: { type: 'string' },
    exit_code: { type: 'integer' },
    error: { type: ['string', 'null'] },
  },
}
// args.steps = the current wave: [{step_id, cmd, result_file}]
// cmd is fully expanded and already redirects stdout to result_file.
const results = await parallel(args.steps.map(s => () =>
  agent(`Run this command with Bash (it may take many minutes; a non-zero exit means a non-approved verdict — that is data, not an error to retry): ${s.cmd}
Then Read ${s.result_file} and return {step_id, final_verdict, exit_code, error} extracted from it.`,
        { label: `copilot:${s.step_id}`, phase: 'Build', schema: VERDICT })))
return results.filter(Boolean)
```

After the Workflow returns, read each step's `result_file` for the full §2c JSON (`final_diff`, `worktree_path`, `rounds`), then for each step **in deterministic wave order**: verify gates (§2e) → apply diff (§2f) → commit (§2g) → close issues (§2g1) → cleanup (§2h). Caveats specific to fan-out:

- **Cross-step apply conflicts:** every worktree branched from the same HEAD, so a later step's `git apply --3way` may conflict with an earlier step's just-committed diff (the DAG missed a real file-level overlap). §2f already resets the tree on failure; do NOT hand-merge or file-copy — run a **seeded re-dispatch** (§2e) against the new HEAD, with the conflicting files named alongside the findings. Or stop and surface it.
- **A null result** (skipped/dead subagent) or a missing/unparseable `result_file` is a failed step — treat as non-`approved`.
- **Budget multiplies with wave width:** in goal mode each concurrent step carries its own `--goal-max-budget-usd` (default $10) — a K-wide wave puts up to K × budget in flight. The battle plan surfaces the widest wave; thin it with `--sequential` if that exposure is unacceptable.
- **Test-command collisions:** sibling worktrees run `$test_command` concurrently. A suite that binds fixed ports, writes shared global state, or hits one local DB will flake in parallel — use `--sequential` for such repos (or point tests at per-step resources).

A failed step blocks all downstream waves that depend on it (see Phase 2). **On any halt** (blocked step, apply conflict you don't re-dispatch, stopped run): transition every In-Progress issue whose step never committed back to Todo/Blocked (§2a0 moved the whole wave to In Progress up front — don't leave abandoned work claiming to be active on the board). End-of-run verification (Phase 2.5) runs once, after the last wave.

> `--sequential` disables fan-out entirely; `--parallel` forces one all-steps wave (operator override, sound only when the deps metadata is over-conservative and the steps truly don't overlap).

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
