---
name: stark-review
description: >-
  Single-agent PR review. Uses triage-selected PR review domains by default,
  or one forced agent via `--agent`.
argument-hint: "[PR_NUMBER] [--agent claude|codex|gemini] [--dry-run] [--repo ORG/REPO]"
disable-model-invocation: false
model: opus[1m]
revision: 8a249169623b83c1677dcda2bee230a3dd9fa8d1
revision_date: 2026-04-27T18:17:48Z
---

Cheaper single-agent PR review path. Keep this skill thin: call the Python
dispatchers and use their JSON output; do not recreate prompt or dispatch
logic in `SKILL.md`.

## Preflight

Run [standard preflight](../../standards/preflight.md) with `--workflow stark-review`.

## Arguments

Raw input: `$ARGUMENTS`

- `PR_NUMBER` - optional; detect from current branch with `gh pr view --json number --jq .number`
- `--agent <name>` - force the same review agent across every triage-selected domain. `triage_orchestrator.py` forwards this to `multi_review.py --single --agent`.
- `--repo ORG/REPO` - override repo detection
- `--dry-run` - perform the review without PR comments, commits, or pushes
- If PR detection fails, list open PRs and ask:

  ```bash
  gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'
  ```

## Constants

```bash
SCRIPTS="${STARK_REVIEW_SCRIPTS:-$HOME/.claude/code-review/scripts}"
PYTHON="$SCRIPTS/.venv/bin/python3"
[ -x "$PYTHON" ] || PYTHON=python3
```

## Configuration

When `--agent` is not supplied, `domain_agents` in `config.json` chooses the
default agent per domain. Example:

```json
{
  "domain_agents": {
    "architecture": "codex",
    "accessibility": "codex",
    "correctness": "codex",
    "type-safety": "codex",
    "security": "codex",
    "test-coverage": "codex",
    "spec-conformance": "codex",
    "ui-design-conformance": "codex",
    "regression-prevention": "codex"
  }
}
```

This follows the standard config hierarchy (repo > org > global).

## Setup

1. Verify `gh auth status` succeeds.
2. Provision the review worktree:

   ```bash
   TOOLS="$HOME/.claude/code-review/tools"
   SETUP_JSON=$(node --experimental-strip-types "$TOOLS/review_setup_worktree.ts" \
     --pr "$PR_NUM" --repo "$REPO" --mode single --json)
   ```

   The tool runs `gh pr view` to resolve `branch`, `headSha`, `base`, `isFork`,
   and `maintainerCanModify`; cross-checks the current checkout matches
   `--repo`; force-fetches the base branch and the GitHub PR head ref; and
   creates (or validates-and-reuses) `/tmp/review-<repo-slug>-pr<N>-single`.
   Receipt: `{ worktreePath, pr: {number, branch, headSha, base, isFork,
   maintainerCanModify}, reused }`.

   Exit codes (skill must surface the message and stop on any non-zero):
   `2` gh-cli-failure, `3` repo-mismatch, `4` worktree-dirty,
   `5` worktree-head-mismatch, `6` git-failure.

3. `cd "$WORKTREE_PATH"` (from the receipt) before any review work.

## Dispatch Rules

- Normal mode: use `triage_orchestrator.py --type pr --single --json`. It triages domains and dispatches the actual review.
- `--agent` supplied: keep the orchestrator path and append `--agent "$AGENT"` so triage still selects domains while `multi_review.py` uses one forced reviewer.
- `--dry-run`: first run `triage_orchestrator.py --type pr --single --dry-run --json` to get `triage.dispatched_domains`, then run `multi_review.py --single --dry-run --json-only --domains <csv>` using that domain list. Append `--agent "$AGENT"` to the second command if supplied. `triage_orchestrator.py --dry-run` does not dispatch a review by itself.
- Never pass `--post-raw` when `--dry-run` is active.

## Phase 1: Run Review

### Normal triaged run

```bash
review_args=(
  --type pr
  --pr "$PR_NUM"
  --repo "$REPO"
  --base "$BASE"
  --single
  --json
)
[ -n "${AGENT:-}" ] && review_args+=(--agent "$AGENT")
"$PYTHON" "$SCRIPTS/triage_orchestrator.py" "${review_args[@]}"
```

If the orchestrator fails before returning JSON, log the failure and fall back
to direct single-agent dispatch:

```bash
fallback_args=(
  --pr "$PR_NUM"
  --repo "$REPO"
  --base "$BASE"
  --single
  --json-only
)
[ -n "${AGENT:-}" ] && fallback_args+=(--agent "$AGENT")
"$PYTHON" "$SCRIPTS/multi_review.py" "${fallback_args[@]}"
```

### Dry-run with triage-selected domains

First collect the triage decision without dispatch:

```bash
TRIAGE_JSON=$(
  $PYTHON $SCRIPTS/triage_orchestrator.py \
    --type pr \
    --pr "$PR_NUM" \
    --repo "$REPO" \
    --base "$BASE" \
    --single \
    --dry-run \
    --json
)
DOMAIN_CSV=$(
  printf '%s' "$TRIAGE_JSON" | python3 -c 'import json,sys; print(",".join(json.load(sys.stdin)["triage"]["dispatched_domains"]))'
)
```

If `DOMAIN_CSV` is empty, report that triage selected zero domains and stop.
Otherwise run the real review without PR posting:

```bash
dry_review_args=(
  --pr "$PR_NUM"
  --repo "$REPO"
  --base "$BASE"
  --single
  --dry-run
  --json-only
  --domains "$DOMAIN_CSV"
)
[ -n "${AGENT:-}" ] && dry_review_args+=(--agent "$AGENT")
"$PYTHON" "$SCRIPTS/multi_review.py" "${dry_review_args[@]}"
```

## Phase 2: Parse Output

Handle whichever payload shape you actually executed:

- `triage_orchestrator.py` returns `{triage, dispatch, findings, summary}`.
- `multi_review.py` returns `{repo, pr, base, mode, domain_agents, domains, rounds, summary}`.

Flatten findings from:

- `findings` for the triage-orchestrator payload
- `rounds[*].results[*].findings` for the direct `multi_review.py` payload

Fail closed before classification if any of these are true:

- the review command exits non-zero, even if it printed JSON
- stdout is not valid JSON
- `triage.dispatched_domains` is non-empty but dispatch returned zero result records
- `dispatch.failed > 0` in triage output
- direct `multi_review.py` output has `summary.failed_results > 0`

If `triage.error` is set but dispatch produced result records and
`dispatch.failed == 0`, treat it as a fail-open triage warning rather than a
cleanliness blocker.

In those cases, print the failed domains/agents and stop. Do not report the PR
as clean. Use the actual dispatched domain count from the payload; do not
hard-code `9`.

## Phase 3: Classify and Present

Read the referenced `file:line` in the worktree and classify every finding:

| Classification | Meaning |
|----------------|---------|
| `fix` | Confirmed real issue. Critical/high `fix` findings must be addressed in this run; medium `fix` findings may be fixed immediately or explicitly left as follow-up. |
| `false_positive` | The described issue does not exist in the code. |
| `noise` | Subjective, stylistic, or not actionable. |
| `ignored` | Intentionally not acted on in this run because it is below the action threshold or out of scope. |

Every finding must get both `classification` and `classification_reason`.

Present a summary using the actual run data:

```text
Review Complete - {repo} PR #{pr_num}
-------------------------------------
Domains reviewed: {domain_count}
Findings: X total (C critical, H high, M medium, L low)
Agents used: {agent_names}
Duration: Xs

Findings to fix:
  1. [CRITICAL] file:line - title
  2. [HIGH] file:line - title
```

## Phase 4: Fix Loop

- If `--dry-run` was used, stop after presenting findings. Do not edit files, commit, or push.
- If `IS_FORK` is true, stay review-only unless `maintainerCanModify` is true and you have a verified writable remote for the fork. Do not push fixes to `origin` for fork PRs.
- If there are critical or high `fix` findings:
  1. Fix them in the worktree.
  2. Run the project's test command (from config, `CLAUDE.md` `## Commands`, or the repo's standard package/test files). If no test command can be identified, say so explicitly.
  3. If tests pass, commit and push back to the PR branch:

     ```bash
     git add -A
     git commit -m "fix: address review findings"
     git push origin HEAD:"$BRANCH"
     ```

  4. Re-run the review/classification flow. Stop after 3 rounds total.
  5. If tests fail, keep the worktree and stop. Do not claim the PR is clean.
- If only medium `fix` findings remain, either fix the low-risk ones now or present them explicitly as remaining follow-up items. Do not silently drop them.

## Phase 5: Persist History

`multi_review.py` auto-writes `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json`
at the end of every dispatched round (round number is auto-detected from the
history dir, or set explicitly via `--round N`). Findings land **unclassified**.

After classifying, overwrite the same `round-{N}.json` with the classified
copy by calling `save_round_history()` from `multi_review.py`, or by writing
JSON with the same schema. Pass `--round` to a subsequent dispatch when you
want to re-record the same round number rather than auto-incrementing.

Critical rules:

- Every saved finding must include `classification` and `classification_reason`.
- Preserve the actual `domain_agents` map used for the run, or the forced `--agent` override.
- Save every round, including the final round.
- Pass `--no-persist-history` only when you genuinely don't want an audit trail (rare).

## Phase 6: Cleanup

```bash
cd -
node --experimental-strip-types "$TOOLS/review_cleanup_worktree.ts" \
  --worktree "$WORKTREE_PATH" --head-sha "$HEAD_SHA" --json
```

The tool refuses to delete the worktree on any of: unstaged changes, staged
changes, or HEAD drift from the original PR head. The `head-drift` check
specifically guards against fix commits that were never pushed — without it,
the worktree (and its unpushed commits) would be silently removed. Receipt:
`{ removed, reason: removed | no-such-worktree | unstaged-changes |
staged-changes | head-drift, worktreePath, expectedHead, observedHead }`.

The tool always exits 0; a `removed: false` receipt is a deliberate safety
decision, not a tool failure. Skip cleanup entirely on dispatch failure,
test failure, or unpushed fixes — surface the path and let the user inspect.

## Observability

Standard observability applies: timestamped progress logs, metrics block
(PR number, agents used, domains succeeded/failed, findings by severity,
fix rounds, duration), and completion event via `emit_queue.py`.

See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure | Recovery |
|---------|----------|
| `triage_orchestrator.py` fails in normal mode | Log the failure and fall back to direct `multi_review.py --single` |
| `--agent` override requested | Keep orchestrator triage and forward `--agent` to `multi_review.py` |
| `--dry-run` requested | Do not use orchestrator dispatch; triage first, then run `multi_review.py --dry-run --domains ...` |
| Zero sub-agents run or all dispatched domains fail | Stop and report dispatch failure; never call it clean |
| Triage selects zero domains | Report it and stop cleanly |
| PR not found | Print `PR #{n} not found. Check --repo or run from the correct directory.` |
| Worktree creation fails | Stop; do not fall back to the main checkout |
| Repo mismatch | Stop and ask to run from the matching local checkout |
| Current PR branch has unpushed local changes | Stop and ask for a push/checkpoint before reviewing remote PR head |
| Fork PR | Review-only unless writable fork remote is verified |
| Tests fail after fixes | Present the failure, keep the worktree state, and stop without claiming the PR is clean |
