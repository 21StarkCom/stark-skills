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

If the invocation arguments contain a standalone `--help`, `-h`, or `help` token,
follow [standard help](../../standards/help.md): print this skill's purpose,
usage, and arguments, then stop — do not run preflight or any phase.

## Preflight

Run environment validation before proceeding:
```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/preflight.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
[ -f "$TOOLS/preflight.ts" ] || { echo "bundled preflight.ts not found" >&2; exit 1; }
node --experimental-strip-types "$TOOLS/preflight.ts" --workflow stark-copilot --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue if both the configured lead and wing agents are available.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a
  `preflight_check` event with `status=blocked`, use the runtime's configured
  alert sink when one exists, and exit non-zero so the caller sees the failure.

# stark-copilot

Autonomous implementation with a paired **lead/wing** subagent loop:

- **Lead** — implements the step in a git worktree
- **Wing** — reviews the lead's diff and either approves or returns blocking findings

Defaults are capability-based: choose the first enabled implementation agent,
preferring the current host, then choose a different enabled review agent. Do
not assume the Claude CLI exists merely because the skill was invoked. If two
different enabled agents are unavailable, stop and ask the user to configure
`--lead` and `--wing`; a paired review cannot safely collapse to self-review.

Each step runs a review→fix loop until the wing approves or `--max-rounds` fix rounds are exhausted.

This skill is thin: it orchestrates `tools/copilot_dispatch.ts`, which owns the worktree,
the lead/wing dispatch, the review→fix loop, and the JSON verdict parsing. Do not
re-implement that logic here.

## Arguments

- `<plan-or-prompt>` — path to implementation plan, or inline task description
- `--plan-slug SLUG` — the run's identity slug (threaded from stark-author's recorded slug). Names the impl branch `copilot/<slug>` (§1.7), the impl PR title (§2.6) and the completion line (§4c). Used verbatim when given, never re-derived from the filename.
- `--test-command CMD` — test command to run after each lead pass (e.g., `npm test`, `pytest`)
- `--lead AGENT` — lead implementer agent ID. One of `claude`, `codex`, `gemini`; default is the first enabled implementation-capable agent, preferring the current host.
- `--wing AGENT` — wing reviewer agent ID. Must differ from `--lead`; default is the first different enabled review-capable agent.
- `--max-rounds N` — maximum **fix** rounds after the initial implement (default: `1`). The wing reviews up to `N+1` times. One round is the evidence-backed default — retry budget past first-failure buys review churn, not fixes (2026-07-25 autopsy); unresolved-after-one goes to the human.
- `--timeout N` — per-lead-invocation timeout in seconds (default: 900)
- `--wing-timeout N` — per-wing-invocation timeout in seconds (default: 600)
- `--no-goal` — disable the optional goal-driven lead loop. Goal mode is considered only when the resolved lead is Claude and that CLI advertises the feature; it is ignored for Codex, Gemini, and native host workers.
- `--parallel` — force-treat ALL steps as mutually independent (one wave), overriding the dependency DAG. Use only when you know the deps metadata is over-conservative. Parallelism within a wave is otherwise **on by default** via the execution DAG (§1.4); see [Parallel waves](#parallel-waves-default).
- `--sequential` — disable DAG-driven parallelism entirely; run every step one at a time in dependency order (the pre-DAG behavior).
- `--ready` (alias `--no-draft`) — open the impl PR ready-for-review instead of draft. Draft is the repo default (§2.6 lands the impl PR as a draft unless this is passed). Set `open_ready` while parsing the current invocation when either token is present.
- `--dry-run` — show what would happen without executing

If `--lead` and `--wing` resolve to the same agent, error and stop:
> Error: --lead and --wing must be different agents.

If both `--parallel` and `--sequential` are given, error and stop:
> Error: --parallel and --sequential are mutually exclusive.

If no input provided, ask: "What should I build?"

Parse the plan/prompt and flags directly from the user's current request after
the explicitly invoked skill name.

## Constants

```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -d "tools" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
[ -d "$TOOLS" ] || { echo "bundled tools directory not found" >&2; exit 1; }
# Resolve LEAD and WING from explicit flags + runtime capabilities in this call.
```

Treat this as a resolution pattern, not persistent shell state. Every later
shell block re-resolves the paths and values it uses.

## Phase 1: Setup

### 1.1 Parse input

Two input modes:

**Plan file:** If the input is a `.md` file path, read it and extract the step list. Each `## Phase N` or `### Task N` heading becomes a step. Resolve `PLAN_SLUG` from `--plan-slug` when given; otherwise derive it from the filename — strip `.md`, strip the known suffixes (`-design`, `-spec`, `-plan`), truncate to 47 chars + a 3-char hash when longer than 50.

**Inline prompt:** If the input is a description rather than a file path, decompose it into steps yourself. `PLAN_SLUG` is whatever `--plan-slug` carried, otherwise unset.

> **There is no issue-driven mode.** Until 2026-07-26 copilot could load steps from GitHub issues labelled `plan:{SLUG}`, created by `stark-plan-to-tasks`. That skill was deleted in the demolition and nothing in the fleet creates task issues any more — `stark-author` writes the task DAG into the spec, `stark-build` executes it from there, and `tools/github_app.ts` refuses `issue create` outright. The mode was removed rather than reframed because its **safety gate could never fire**: §1.2 filtered on `ai_suitability` "from the issue body metadata", but that value never existed in an issue body — the producer's template had 13 sections and none was suitability, its labels were `plan:`/`risk:`/`confidence:` with no `ai:`, and AI Suitability lived only as a GitHub Projects V2 field, invisible to the `gh issue list --json body,labels` this mode ran. A task marked `human-led` would have been run autonomously, silently.

When a plan file path is available, retain it as `plan_path` for the approach contract step. When in inline mode, leave `plan_path` unset. Retain the raw `<plan-or-prompt>` positional value itself (flags stripped) as `plan_or_prompt` — §1.7 uses it as the inline-mode branch-name fallback.

### 1.2 Extract steps

Parse the plan — or your own decomposition — into an ordered list of steps. A step is the dispatch unit: one worktree, one lead/wing loop.

If the sections carry dependency metadata, **collapse chains**: merge section B into section A's step when A is B's only dependency and B is A's only dependent. A fully-linear plan collapses to exactly **one** step (shared context, one dispatcher loop, zero extra overhead); genuinely independent sections or branches become separate steps that can share a wave (§1.4). With no dependency metadata at all, each section is one step and §1.4's fail-closed reading applies.

Each step contains:
- `step_id` — the phase slug when the phase collapsed to one step (e.g., `phase-1-data-model`); otherwise `<phase-slug>--<first-task-slug>` (e.g., `phase-2-api--rest-endpoints`)
- `title` — the phase name, or `{phase name}: {first task title} (+K more)` for a multi-step phase
- `task` — the raw step task description (the parsed plan section, or the inline prompt). Saved to `step-$step_id-task.md` for the dispatcher.
- `prompt` — the lead's full implement prompt (composed from the agent-specific `implement.md` template + previous-step context + `task`). Saved to `step-$step_id-implement.md`.
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

Before showing the battle plan, compute an **execution plan**: level the §1.2 steps into **waves**. Steps in the same wave have no dependency edge between them and run **concurrently** (each dispatcher already owns its own worktree; see [Parallel waves](#parallel-waves-default)); waves run sequentially, each branching from the previous wave's merged result.

**Edges, per mode:**

- **Plan-file:** parse each step section for an explicit `Dependencies:` / `depends_on:` line. If the plan carries no dependency metadata at all, do NOT infer independence from silence — read each step's task text and mark an edge wherever a step names files, modules, interfaces, or outputs another step creates. When you cannot rule a dependency out, keep the edge.
- **Inline:** you decomposed the steps yourself — declare `depends_on` per step as you decompose.

**Leveling (Kahn):** wave 1 = steps with no unmet edges; wave N = steps whose edges all land in waves < N. A cycle is a plan defect — print the cycle and stop (do not guess an order).

**Fail-closed default:** ambiguous or missing dependency info ⇒ dependent (sequential). Wrong-parallel corrupts merges; wrong-sequential only costs wall-clock. `--sequential` collapses every step into its own wave; `--parallel` collapses all steps into one wave (explicit operator override only). Passing both is a contradiction — error and stop.

Record the result as `waves = [[step, ...], ...]` and carry it into Phase 2.

### 1.5 Show battle plan

```
stark-copilot — Battle Plan
───────────────────────────
Mode:         plan-file (docs/specs/2026-08-01-widget-system-spec.md → 5 steps in 4 waves)
Lead:         {resolved lead}   (implementer)
Wing:         {resolved wing}   (reviewer)
Max rounds:   4 fix rounds (up to 5 reviews per step)
Test command: pytest
Timeout:      900s lead / 600s wing

Wave 1: phase-1-data-model            (3 sections, chain-collapsed)
Wave 2: phase-2-api--rest-endpoints   ∥   phase-2-api--graphql
Wave 3: phase-3-cli
Wave 4: phase-4-docs

Each step: lead implements in worktree → wing reviews diff → fix-loop until approved → merge
Steps sharing a wave run concurrently; waves run in order.
Widest wave: 2 steps — in goal mode that is up to 2 × $10 goal budget in flight at once.
```

In plan-file or inline mode, replace the Mode line with `Mode: plan-file` or `Mode: inline`.

**No-op case:** If every phase is skipped (all tasks closed or human-led), still print the banner with `Steps: 0` and a `(no actionable steps)` line in place of the per-step list, followed by a `Skipped phases:` block enumerating each skipped phase with the phase number, issue number, and `(N/M closed)` count. Then exit with a clear "Nothing to do — all tasks already implemented." message. Do not invoke the dispatcher.

If `--dry-run`, stop here.

### 1.6 Approach Contract

Only when `plan_path` is set (plan-file mode). Inline mode skips this step.

```bash
set -euo pipefail
PLAN_PATH="<absolute-plan-path-or-empty>"
if [ -n "$PLAN_PATH" ]; then
  if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/approach_contract.ts" ]; then
    ASSET_ROOT="$(pwd)"
  else
    ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
  fi
  TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
  node --experimental-strip-types --no-warnings "$TOOLS/approach_contract.ts" \
    --plan-file "$PLAN_PATH" --force-confirm
fi
```

### 1.7 Prepare the impl branch

Historically copilot committed every step directly onto whatever branch was checked out and never opened a PR — forge had no impl PR number to record or merge. Fix that here, **before any step commits**: adopt-or-create a deterministic impl branch so §2g's per-step commits land somewhere reachable, and resolve the repo + default branch §2.6 needs to land the PR.

```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/copilot_land.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PLAN_SLUG="<resolved-plan-slug-or-empty>"
PLAN_OR_PROMPT="<raw-positional-input>"
fallback_slug=$(printf '%s' "$PLAN_OR_PROMPT" | tr '[:upper:]' '[:lower:]' \
  | tr -c 'a-z0-9' '-' | sed -E 's/-+/-/g; s/^-|-$//g' | cut -c1-40)

branch=$(node --experimental-strip-types "$TOOLS/copilot_land.ts" branch-name \
  --plan-slug "${PLAN_SLUG:-}" --fallback-slug "$fallback_slug")

base=$(git -C "$REPO_ROOT" rev-parse HEAD)
node --experimental-strip-types "$TOOLS/copilot_land.ts" prepare-branch \
  --branch "$branch" --repo-dir "$REPO_ROOT" --require-base "$base" --json
printf 'branch=%s\nbase=%s\n' "$branch" "$base"
```

Record the printed branch and base; later independent calls receive them as
concrete values rather than relying on this shell's variables.

**`--require-base` is not optional here.** `branch-name` is deterministic, so
a re-run whose earlier attempt was abandoned finds a leftover
`copilot/<slug>` and adopts it via `git checkout -B <b> origin/<b>` — which
**resets `$REPO_ROOT` onto that older codebase** while reporting `ok: true`.
Every later wave then diffs, tests, and commits against the wrong tree.
Copilot runs against the real checkout rather than a throwaway worktree, so
the blast radius is larger than the `stark-build` case this guard was first
added for. Pinning the current `HEAD` is the correct base: a branch that
legitimately continues this work already contains it, and one that doesn't is
precisely the stale branch you must not silently rewind onto.

`branch-name` is deterministic (`copilot/<slug>`) — a re-invocation with the same plan slug (or, in inline mode, the same raw input) always names the same branch, and `prepare-branch` adopts it (ff-only merge against a matching local/remote branch; a genuinely diverged local branch is a hard error, never forced — see `tools/copilot_land_lib.ts`). Don't re-implement this logic in prose; both subcommands are the single source of truth.

## Phase 2: Execute Waves

**Clean-tree precondition:** before the first wave, `git status --porcelain` on `$REPO_ROOT` must be empty. If it isn't, stop and tell the user to commit or stash first — §2g's `git add -A` would sweep unrelated files into a step commit, and §2f's rollback path is only provably safe on a tree that was clean before the apply.

Execute the waves from §1.4 **in order**. Within a wave:

- **Single-step wave** — run §2a–§2j inline, exactly as below.
- **Multi-step wave** — launch the fully staged dispatcher commands concurrently with the portable shell fan-out in [Parallel waves](#parallel-waves-default), then apply each approved diff and commit **in a deterministic order** (step order within the wave), running §2e–§2g1 per step and §2h cleanup. A non-`approved` step's diff is never applied; surface it and — since later waves may depend on it — stop before the next wave unless every remaining wave is provably independent of the failed step.

For each step, sequential or fanned-out:

### 2a. Stage prompt files

Create one unique absolute run directory with `mktemp -d`, record the returned
path as `RUN_DIR`, and stage three files per step. Resolve templates under the
**installed** `prompts/copilot/` layout — never insert an extra source-tree
segment into an installed asset path:

- `$RUN_DIR/step-$STEP_ID-implement.md` — the lead's full implement prompt,
  composed from `$ASSET_ROOT/prompts/copilot/$LEAD/implement.md`, previous-step
  context, and the step task. Do **not** embed a `/goal` directive; the optional
  Claude-only goal mode is enabled through §2b's flag.
- `$RUN_DIR/step-$STEP_ID-review.md` — a verbatim copy of
  `$ASSET_ROOT/prompts/copilot/$WING/review.md`.
- `$RUN_DIR/step-$STEP_ID-task.md` — the raw task description.

Before dispatch, verify both template files exist. If the runtime asset root or
either selected agent's template is unavailable, stop before creating a
worktree. A self-contained resolution example:

```bash
set -euo pipefail
LEAD="<resolved-lead>"
WING="<resolved-wing>"
STEP_ID="<step-id>"
if [ -d "global/prompts" ] && [ -f "skill/stark-copilot/SKILL.md" ]; then
  ASSET_ROOT="$(pwd)/global"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
PROMPT_ROOT="${ASSET_ROOT:+$ASSET_ROOT/prompts/copilot}"
RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stark-copilot.XXXXXX")"
IMPLEMENT_TEMPLATE="$PROMPT_ROOT/$LEAD/implement.md"
REVIEW_TEMPLATE="$PROMPT_ROOT/$WING/review.md"
[ -f "$IMPLEMENT_TEMPLATE" ] && [ -f "$REVIEW_TEMPLATE" ] || {
  echo "copilot prompt templates missing under $PROMPT_ROOT" >&2
  exit 1
}
cp "$REVIEW_TEMPLATE" "$RUN_DIR/step-$STEP_ID-review.md"
# Compose implement.md + previous-step context + task into:
#   "$RUN_DIR/step-$STEP_ID-implement.md"
# Write the raw task into:
#   "$RUN_DIR/step-$STEP_ID-task.md"
printf '%s\n' "$RUN_DIR"
```

Record the printed directory and substitute that absolute path into later
independent shell calls; do not expect `RUN_DIR` to persist between them.

### 2b. Dispatch the copilot loop

```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/copilot_dispatch.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
REPO_ROOT="<absolute-repo-root>"
RUN_DIR="<absolute-run-dir-from-2a>"
STEP_ID="<step-id>"
LEAD="<resolved-lead>"
WING="<resolved-wing>"
MAX_ROUNDS="<max-rounds-or-1>"
TIMEOUT="<timeout-or-900>"
TEST_COMMAND="<test-command-or-empty>"
GOAL_MODE="<true-only-for-supported-claude-goal-mode>"
cmd=(node --experimental-strip-types "$TOOLS/copilot_dispatch.ts"
  --repo-root "$REPO_ROOT"
  --step-id "$STEP_ID"
  --implement-prompt-file "$RUN_DIR/step-$STEP_ID-implement.md"
  --review-prompt-file "$RUN_DIR/step-$STEP_ID-review.md"
  --step-task-file "$RUN_DIR/step-$STEP_ID-task.md"
  --lead "$LEAD"
  --wing "$WING"
  --max-rounds "$MAX_ROUNDS"
  --timeout "$TIMEOUT"
  --diff-out "$RUN_DIR/step-$STEP_ID-final.diff")
[ -n "$TEST_COMMAND" ] && cmd+=(--test-command "$TEST_COMMAND")
if [ "$GOAL_MODE" = "true" ] && [ "$LEAD" = "claude" ]; then
  cmd+=(--goal-condition "the step is fully implemented and the project's test suite passes"
    --goal-max-budget-usd "${STARK_GOAL_MAX_BUDGET_USD:-10}")
fi
"${cmd[@]}"
```

`--test-command` is optional even when the repo has tests: when omitted, the dispatcher auto-detects one from the trusted repo root (`stark_review_lib.ts::detectTestCommand` — Makefile `test:`, `npm test`, `go test`, …) and runs it in the worktree after every round. **A wing `approve` over red or never-ran tests does not land** — the dispatcher returns `unresolved` with `error=approved_but_tests_red`; completion is the runnable check, never the wing's verdict.

Pass `--goal-condition` only when the resolved lead is Claude, the installed CLI
supports goal mode, and `--no-goal` was not supplied. With it set, the dispatcher
uses that vendor-specific loop for round 1. Fix rounds are never goal loops. For
Codex, Gemini, or a host-native lead, omit the flag and run a bounded single
implementation pass before wing review.

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
  "lead": "<resolved-lead>",
  "wing": "<resolved-wing>",
  "worktree_path": "/.../.worktrees/copilot-<lead>-...",
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
  "final_diff": "",
  "final_diff_path": "<absolute-run-dir>/step-<step-id>-final.diff"
}
```

With `--diff-out` (the §2b default), `final_diff` is blanked and the diff lives at
`final_diff_path` — read/apply it from disk; never pull the bytes into context
(diffs run to hundreds of KB). The worktree path is at `worktree_path`.
Per-round metadata (verdict, findings, parse retries) lives in `rounds[]` for the
audit trail (Phase 4).

### 2d. Handle terminal verdicts

| `final_verdict` | Action |
|---|---|
| `approved` | Continue to §2e (verify gates → apply diff → commit). |
| `blocked` | Stop the run. Print the wing's `summary` and `blocking_findings` from the last round. Do not retry. Clean up worktree (§2h). |
| `aborted` | Lead's first round failed (timeout, empty diff, or CLI error). Stop the run, surface the round-1 `error`. Clean up worktree. |
| `max_rounds_unresolved` | Wing did not approve within `--max-rounds` fix rounds. Stop the run, print all rounds' findings. Clean up worktree. |
| `unresolved` | Loop terminated for another reason (wing parse retry exhausted, empty-diff revision, mid-loop lead failure, or `error=approved_but_tests_red` — the wing approved but the host-run test command was red or never ran; the check outranks the verdict). Stop the run, surface the `error` field and the latest findings. Clean up worktree. |

In every non-`approved` case, do **not** apply the diff or commit. Surface what's
needed to address the failure manually, then exit.

### 2e. Verify approved diff (MANDATORY — do not skip)

Before applying, the approved diff must pass the import, SDK API, and cross-module
gates. For procedures, see [references/verification-gates.md](references/verification-gates.md).

Run the gates against the lead's worktree (use `worktree_path` from §2c). If a gate fails:

- If the run still has fix budget remaining (i.e., the dispatcher exited with `final_verdict == "approved"` before round `max_rounds + 1`, **and** you choose to invest one more round), run a **seeded re-dispatch** (below) with the gate failure as the findings. This burns one additional dispatcher invocation; surface that explicitly.
- Otherwise, stop the run with the gate failure surfaced. Do not silently fall back. The user must address the gate finding manually or rerun with a higher `--max-rounds`.

**Seeded re-dispatch** (used here and by the fan-out conflict path): a re-dispatch with the same `--step-id` force-recreates the worktree from HEAD — the dispatcher has no resume mode — so the approved work must be seeded back in. Seed it as a **diff file the prompt references by path**, never pasted inline (a diff can run to hundreds of KB):

1. The approved diff is already on disk at the step's `final_diff_path` (§2b `--diff-out`); copy it to the recorded absolute run directory as `step-<step-id>-approved.diff` (only write it from JSON if the run predates `--diff-out`).
2. Re-stage prompt files under a **suffixed step id** (`<step-id>-r2`, so the original run's artifacts and worktree aren't clobbered). The implement prompt uses "REVISION" framing: first apply the recorded approved-diff path in the new worktree (resolving any conflicts), then address the listed findings.
3. Invoke with the concrete suffixed step id, `--max-rounds 1`, and **without** `--goal-condition` — the retry is one bounded fix round, not a fresh goal loop with a fresh budget.
4. Afterwards run §2h cleanup for **both** step ids.

### 2f. Apply approved diff

Apply the dispatcher's final diff **from disk** (`final_diff_path`, §2b `--diff-out`) to the main working tree — never round-trip the bytes through context:

The diff is the dispatcher's `--binary --full-index` rendering, so binary and rename-heavy changes replay correctly. The working tree must be clean before applying (guaranteed by the Phase 2 precondition + per-step commits). On failure, **reset before doing anything else** — `git apply --3way` exits non-zero having already written conflict markers/partial hunks into the tree, and §2g's `git add -A` would commit that garbage:

```bash
set -euo pipefail
REPO_ROOT="<absolute-repo-root>"
FINAL_DIFF_PATH="<absolute-final-diff-path>"
cd "$REPO_ROOT"
git apply --3way "$FINAL_DIFF_PATH" || {
  git reset --hard HEAD
  git clean -fd
  echo "approved diff failed to apply cleanly" >&2
  exit 1
}
```

(`git clean -fd` is safe here **only** because the tree was clean pre-apply — the only untracked files are ones the failed apply just created. That is what the Phase 2 precondition buys.)

When the self-contained apply command reports failure:

- **Sequential step (HEAD unchanged since the worktree branched):** a conflict is rare here. Fall back to copying changed files from `worktree_path` over to `$REPO_ROOT` — sound only because both trees share the same base.
- **Fan-out step (HEAD moved — a sibling step in this wave already committed):** the file-copy fallback is **forbidden** — the worktree's files are based on the pre-wave HEAD and copying them silently reverts the sibling's committed edits. Instead, re-dispatch this single step against the new HEAD (see the conflict path in [Parallel waves](#parallel-waves-default)), or stop and surface it.

### 2g. Commit step

```bash
set -euo pipefail
REPO_ROOT="<absolute-repo-root>"
LEAD="<resolved-lead>"
WING="<resolved-wing>"
ROUNDS_COUNT="<round-count>"
STEP_TITLE="<step-title>"
git -C "$REPO_ROOT" add -A
git -C "$REPO_ROOT" commit -m \
  "feat: $STEP_TITLE (copilot: $LEAD impl, $WING review, $ROUNDS_COUNT rounds)"
```

`$rounds_count` is `len(rounds)` from §2c.

### 2h. Clean up worktree

```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/copilot_dispatch.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
REPO_ROOT="<absolute-repo-root>"
STEP_ID="<step-id>"
LEAD="<resolved-lead>"
node --experimental-strip-types "$TOOLS/copilot_dispatch.ts" \
  --repo-root "$REPO_ROOT" \
  --step-id "$STEP_ID" \
  --lead "$LEAD" \
  --cleanup
```

### 2i. Log and continue

Print step summary (lead, wing, rounds count, final verdict, files changed, test result). Move to the next step in the wave, then the next wave.

### 2j. Session state update

After each step completes, run both optional state helpers in one self-contained
call. They are best-effort; a runtime without their state backend continues:
```bash
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -d "tools" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
[ -f "$TOOLS/session_state.ts" ] && \
  node --experimental-strip-types --no-warnings "$TOOLS/session_state.ts" --json 2>/dev/null || true
[ -f "$TOOLS/context_compactor.ts" ] && \
  node --experimental-strip-types --no-warnings "$TOOLS/context_compactor.ts" --json 2>/dev/null || true
```

Generate checkpoints according to `context_compaction.checkpoint_interval_minutes`
(default 15); do not assume a Claude session ID exists.

## Phase 2.5: End-of-Run Verification (MANDATORY)

After ALL steps complete, run the full import chain test, smoke test, and SDK API spot-check. For procedures, see [references/verification-gates.md](references/verification-gates.md).

If ANY check fails, fix before proceeding to Phase 3.

## Phase 2.6: Land the impl PR

Push the branch prepared in §1.7 and adopt-or-open its PR. Steps only commit **locally** (§2g) — this phase is what makes that work reachable as a reviewable PR, and is what fixes copilot never having had an impl PR number to report or merge.

Skip entirely if no step ever reached §2g (every step failed before its first commit) — there is nothing to push. Leave `pr_number` and `prs` unset for Phase 3/4.

```bash
set -euo pipefail
if [ -f "skill/stark-copilot/SKILL.md" ] && [ -f "tools/copilot_land.ts" ]; then
  ASSET_ROOT="$(pwd)"
else
  ASSET_ROOT="${STARK_ASSET_ROOT:-${STARK_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
fi
TOOLS="${STARK_REVIEW_TOOLS:-${ASSET_ROOT:+$ASSET_ROOT/tools}}"
REPO_ROOT="<absolute-repo-root>"
REPO="<resolved-org/repo>"
BRANCH="<branch-from-1.7>"
DEFAULT_BRANCH="<resolved-default-branch>"
PLAN_LABEL="<plan-slug-or-input-basename>"
LEAD="<resolved-lead>"
WING="<resolved-wing>"
STEPS_TOTAL="<step-count>"
WAVES_TOTAL="<wave-count>"
ROUNDS_TOTAL="<round-count>"
OPEN_READY="<true-or-false>"
title="Impl: $PLAN_LABEL"
body="Autonomous copilot implementation (lead \`$LEAD\`, wing \`$WING\`). $STEPS_TOTAL step(s) across $WAVES_TOTAL wave(s), $ROUNDS_TOTAL total review round(s)."
ready_flag=()
[ "$OPEN_READY" = "true" ] && ready_flag=(--ready)

landed=$(node --experimental-strip-types "$TOOLS/copilot_land.ts" land \
  --repo "$REPO" \
  --branch "$BRANCH" \
  --base "$DEFAULT_BRANCH" \
  --title "$title" \
  --body "$body" \
  --lead "$LEAD" \
  --repo-dir "$REPO_ROOT" \
  "${ready_flag[@]}" \
  --json)

pr_number=$(printf '%s' "$landed" | node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(0,"utf8")).pr.number))')
prs_csv=$(printf '%s' "$landed" | node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).prs))')
```

`land` pushes plainly — **never** `--force` (`tools/copilot_land_lib.ts`) — then adopts the open PR whose head is the resolved branch or opens a fresh one, draft by default (`--ready`/`--no-draft` opts out), using the authenticated human `gh` identity. Review comments may use agent-specific app identities. A rejected (non-fast-forward) push is a hard error from the CLI — stop the run and surface it; never force past it.

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
STATE_ROOT="${STARK_STATE_ROOT:-$HOME/.stark/code-review}"
TASK_SLUG="<task-slug>"
HISTORY_DIR="$STATE_ROOT/history/copilot/$TASK_SLUG"
mkdir -p "$HISTORY_DIR"
printf '%s\n' "$HISTORY_DIR"
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

Post it with `github_app.ts pr comment` against the impl PR.

### 4c. Completion line

As the literal last line of output, on **every** path through this skill — success or not — print exactly one `STARK_STAGE_SUMMARY` line (`standards/stage-completion-line.md`). It is additive: everything above it (Phase 3's summary, §4b's comment) is unchanged, and this line is not gated behind any `--json` flag (this skill has none).

```bash
OUTCOME="<terminal-outcome>"
PLAN_SLUG="<plan-slug-or-empty>"
PRS_JSON='<json-array-or-[]>'
if [ -n "$PLAN_SLUG" ]; then plan_slug_json="\"$PLAN_SLUG\""; else plan_slug_json=null; fi
cat <<EOF
STARK_STAGE_SUMMARY {"skill":"stark-copilot","outcome":"$OUTCOME","plan_slug":$plan_slug_json,"prs":$PRS_JSON}
EOF
```

`outcome` is this run's own terminal verdict: `all_approved` when every step in every wave reached `final_verdict=approved` and §2.6 landed cleanly; otherwise the specific halt reason already in play — `blocked`, `aborted`, `max_rounds_unresolved`, `unresolved` (§2d), `no_actionable_steps` (§1.5's no-op case), or `dry_run` (§1.5's `--dry-run` stop, which precedes everything from §1.7 onward). `plan_slug` mirrors `PLAN_SLUG` verbatim — `null` in inline mode, never re-derived. `prs` is `$prs_csv` from §2.6 — `[]` whenever §2.6 was skipped (dry-run, no-op, or every step failed before its first commit).

## Parallel waves (default)

Multi-step waves require no host-specific workflow DSL. The portable baseline is
one backgrounded `copilot_dispatch.ts` process per step; each dispatcher already
isolates its worktree. A host may use an equivalent native parallel-worker API,
but lack of that API must not disable the default parallel path.

Stage every step's prompt files and issue transitions before launch. For each
step, write an executable `$WAVE_DIR/run-$STEP_ID.sh` containing a fully expanded
version of §2b: concrete absolute asset, repo, run, prompt, result, and diff
paths; no inherited shell variables. Redirect stdout to
`$WAVE_DIR/step-$STEP_ID-result.json`, stderr to a sibling `.stderr`, and write
the dispatcher exit code to `.exit`. Then launch the wave with this standalone
Bash call (replace the directory placeholder first):

```bash
set -u
WAVE_DIR="<absolute-wave-directory>"
shopt -s nullglob
scripts=("$WAVE_DIR"/run-*.sh)
[ "${#scripts[@]}" -gt 0 ] || { echo "wave has no staged dispatch scripts" >&2; exit 1; }
pids=()
for script in "${scripts[@]}"; do
  bash "$script" </dev/null &
  pids+=("$!")
done
failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then failed=1; fi
done
printf '%s\n' "$failed" > "$WAVE_DIR/wave-had-failures"
```

Do not use `set -e` around the waits: a non-zero dispatcher exit is a
non-approved verdict to parse, not permission to abandon sibling processes.
After every process has returned, read each result and exit file. A missing or
unparseable result is failed. Process approved steps **in deterministic wave
order**: verify gates (§2e) → apply diff (§2f) → commit (§2g) → cleanup (§2h). Caveats specific to fan-out:

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
