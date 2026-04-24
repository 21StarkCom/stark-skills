---
name: stark-review
description: >-
  Single-agent PR review. Uses triage-selected PR review domains by default,
  or one forced agent via `--agent`.
argument-hint: "[PR_NUMBER] [--agent claude|codex|gemini] [--dry-run] [--repo ORG/REPO]"
disable-model-invocation: true
model: opus[1m]
---

Cheaper single-agent PR review path. Keep this skill thin: call the Python
dispatchers and use their JSON output; do not recreate prompt or dispatch
logic in `SKILL.md`.

## Preflight

Run environment validation before proceeding:

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-review --json
```

Parse the JSON result:

- If `overall` is `blocked`: print the failing checks and stop.
- If `overall` is `degraded`: print a warning with the failing checks, then continue.
- If `overall` is `ready`: continue silently.

## Arguments

Raw input: `$ARGUMENTS`

- `PR_NUMBER` - optional; detect from current branch with `gh pr view --json number --jq .number`
- `--agent <name>` - force the same agent across every reviewed domain. Important: for PR reviews, `triage_orchestrator.py` does not propagate PR agent overrides to `multi_review.py`, so this flag must bypass the orchestrator and call `multi_review.py` directly.
- `--repo ORG/REPO` - override repo detection
- `--dry-run` - perform the review without PR comments, commits, or pushes
- If PR detection fails, list open PRs and ask:

  ```bash
  gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'
  ```

## Constants

```bash
SCRIPTS=~/.claude/code-review/scripts
PYTHON=$SCRIPTS/.venv/bin/python3
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
2. Resolve `PR_NUM`, `REPO`, `BASE`, and `BRANCH`.
3. Confirm the current checkout matches `REPO`. If `--repo` points at a different repository than the current checkout, stop and ask the user to run from that repo.
4. Create an isolated worktree from the PR head. Example:

   ```bash
   BRANCH=$(gh pr view "$PR_NUM" --repo "$REPO" --json headRefName --jq .headRefName)
   BASE=$(gh pr view "$PR_NUM" --repo "$REPO" --json baseRefName --jq .baseRefName)
   WORKTREE=$(mktemp -d)
   git fetch origin "$BRANCH"
   git worktree add --detach "$WORKTREE" "origin/$BRANCH"
   cd "$WORKTREE"
   ```

If worktree creation fails, stop. Do not review in the main checkout.

## Dispatch Rules

- Normal mode without `--agent`: use `triage_orchestrator.py --type pr --single --json`. It triages domains and dispatches the actual review.
- `--agent` supplied: call `multi_review.py --single --agent "$AGENT" --json-only` directly, and append `--dry-run` if requested.
- `--dry-run` without `--agent`: first run `triage_orchestrator.py --type pr --single --dry-run --json` to get `triage.dispatched_domains`, then run `multi_review.py --single --dry-run --json-only --domains <csv>` using that domain list. `triage_orchestrator.py --dry-run` does not dispatch a review by itself.
- Never pass `--post-raw` when `--dry-run` is active.

## Phase 1: Run Review

### Normal triaged run

```bash
$PYTHON $SCRIPTS/triage_orchestrator.py \
  --type pr \
  --pr "$PR_NUM" \
  --repo "$REPO" \
  --base "$BASE" \
  --single \
  --json
```

If the orchestrator fails, log the failure and fall back to direct single-agent
dispatch:

```bash
$PYTHON $SCRIPTS/multi_review.py \
  --pr "$PR_NUM" \
  --repo "$REPO" \
  --base "$BASE" \
  --single \
  --json-only
```

### Forced single-agent override

Use direct dispatch so the override is honored. Append `--dry-run` here too if
the user requested it:

```bash
$PYTHON $SCRIPTS/multi_review.py \
  --pr "$PR_NUM" \
  --repo "$REPO" \
  --base "$BASE" \
  --single \
  --agent "$AGENT" \
  --json-only
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
$PYTHON $SCRIPTS/multi_review.py \
  --pr "$PR_NUM" \
  --repo "$REPO" \
  --base "$BASE" \
  --single \
  --dry-run \
  --json-only \
  --domains "$DOMAIN_CSV"
```

## Phase 2: Parse Output

Handle whichever payload shape you actually executed:

- `triage_orchestrator.py` returns `{triage, dispatch, findings, summary}`.
- `multi_review.py` returns `{repo, pr, base, mode, domain_agents, domains, rounds, summary}`.

Flatten findings from:

- `findings` for the triage-orchestrator payload
- `rounds[*].results[*].findings` for the direct `multi_review.py` payload

Use the actual dispatched domain count from the payload. Do not hard-code `9`.

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
- If there are critical or high `fix` findings:
  1. Fix them in the worktree.
  2. Run the project's test command (from config or `CLAUDE.md` `## Commands`).
  3. If tests pass, commit and push back to the PR branch:

     ```bash
     git add -A
     git commit -m "fix: address review findings"
     git push origin HEAD:"$BRANCH"
     ```

  4. Re-run the review/classification flow. Stop after 3 rounds total.
- If only medium `fix` findings remain, either fix the low-risk ones now or present them explicitly as remaining follow-up items. Do not silently drop them.

## Phase 5: Persist History

After each round, persist classified review history.

Prefer calling `save_round_history()` and `save_review_summary()` from
`multi_review.py` via a short Python snippet so the history schema stays aligned
with the runtime. If that is impractical, write equivalent JSON to:

- `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json`
- `~/.claude/code-review/history/{org}/{repo}/{pr}/rounds.json`

Critical rules:

- Every saved finding must include `classification` and `classification_reason`.
- Preserve the actual `domain_agents` map used for the run, or the forced `--agent` override.
- Save every round, including the final round.

## Phase 6: Cleanup

```bash
cd -
git worktree remove "$WORKTREE" --force
```

## Observability

Standard observability applies: timestamped progress logs, metrics block
(PR number, agents used, domains succeeded/failed, findings by severity,
fix rounds, duration), and completion event via `emit_queue.py`.

See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure | Recovery |
|---------|----------|
| `triage_orchestrator.py` fails in normal mode | Log the failure and fall back to direct `multi_review.py --single` |
| `--agent` override requested | Skip the orchestrator; direct dispatch only |
| `--dry-run` requested | Do not use orchestrator dispatch; triage first, then run `multi_review.py --dry-run --domains ...` |
| Triage selects zero domains | Report it and stop cleanly |
| PR not found | Print `PR #{n} not found. Check --repo or run from the correct directory.` |
| Worktree creation fails | Stop; do not fall back to the main checkout |
| Repo mismatch | Stop and ask to run from the matching local checkout |
| Tests fail after fixes | Present the failure, keep the worktree state, and stop without claiming the PR is clean |
