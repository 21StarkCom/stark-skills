---
name: stark-review
description: >-
  [DEPRECATED] Single-agent PR code review: 1 LLM x 9 domains. Use /stark-forged-review instead.
argument-hint: "[PR_NUMBER] [--agent claude|codex|gemini] [--dry-run] [--repo ORG/REPO]"
disable-model-invocation: true
model: opus[1m]
---

> **⚠ Deprecated.** This skill is superseded by `/stark-forged-review`, which
> runs leader + second-opinion per domain with dynamic triage and optional
> forge-path escalation. `/stark-review` remains functional during the rollout
> window (see `docs/specs/2026-04-12-stark-forged-review-design.md` §11) and
> will be removed after validation.

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-review --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue.
- If `overall` is "ready": continue silently.

# stark-review

Single-agent PR review: 1 LLM × 9 domains dispatched in parallel. Each domain uses its configured default agent (from `domain_agents` in config.json), or an inline override.

For cross-validation across all enabled agents, use `/stark-team-review` instead.

## Arguments

- `<number>` — PR number (e.g., `/stark-review 91`)
- `--agent <name>` — override agent for all domains: `claude`, `codex`, or `gemini`
- `--repo ORG/REPO` — override repo detection
- `--dry-run` — review only, no GitHub posting
- If number omitted, detect from current branch: `gh pr view --json number --jq .number`
- If detection fails, list open PRs and ask: `gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'`

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Configuration

The `domain_agents` map in `config.json` controls which agent reviews each domain:

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

This map follows the standard config hierarchy (repo > org > global). Override per-domain in a repo's `.code-review/config.json`:

```json
{
  "domain_agents": {
    "security": "claude",
    "correctness": "claude"
  }
}
```

## Phase 1: Setup

1. Verify `gh auth status` succeeds.
2. Detect or accept `$PR_NUM` and `$REPO`.
3. Detect base branch: `gh pr view $PR_NUM --json baseRefName --jq .baseRefName`
4. Create a temporary worktree for the PR branch:
   ```bash
   git push origin HEAD  # ensure remote is up to date
   BRANCH=$(gh pr view $PR_NUM --json headRefName --jq .headRefName)
   WORKTREE=$(mktemp -d)
   git worktree add "$WORKTREE" "$BRANCH"
   ```

## Phase 2: Run Review

Run the triage orchestrator in single-agent mode (falls back to direct dispatch if orchestrator fails):

```bash
cd "$WORKTREE"
$PYTHON $SCRIPTS/triage_orchestrator.py --type pr --pr $PR_NUM --single --json || $PYTHON $SCRIPTS/multi_review.py --pr $PR_NUM --single --json-only --post-raw
```

If `--agent` was specified by the user, pass it through:

```bash
$PYTHON $SCRIPTS/triage_orchestrator.py --type pr --pr $PR_NUM --single --json || $PYTHON $SCRIPTS/multi_review.py --pr $PR_NUM --single --agent $AGENT --json-only --post-raw
```

If `--dry-run` was specified, add `--dry-run` (no GitHub posting).

Parse the JSON output. The orchestrator posts per-agent findings to the PR via the appropriate GitHub App bot.

## Phase 3: Classify and Present

From the JSON output, classify **every** finding by reading the referenced `file:line` in the worktree:

| Classification | Criteria |
|----------------|----------|
| `fix` | Severity >= medium AND the issue actually exists in the code |
| `false_positive` | The described problem doesn't exist in the code |
| `noise` | Subjective, style preference, or not actionable |
| `ignored` | Below fix threshold (low severity) |

For each finding, set `classification` and `classification_reason` (one sentence explaining why).

Present a summary:

```
Review Complete — {repo} PR #{pr_num}
──────────────────────────────────────
Domains:  9 (1 agent each)
Findings: X total (C critical, H high, M medium, L low)
Agent:    {agent name(s) used}
Duration: Xs

Findings to fix:
  1. [CRITICAL] file:line — title
  2. [HIGH] file:line — title
```

## Phase 4: Fix Loop (if findings)

If there are critical or high findings:

1. Fix each finding in the worktree.
2. Run the project's test command (from config or CLAUDE.md `## Commands`).
3. If tests pass, commit and push:
   ```bash
   git add -A && git commit -m "fix: address review findings"
   git push origin HEAD
   ```
4. Re-run Phase 2 (max 3 rounds total). If still not clean after 3 rounds, present remaining findings and stop.

## Phase 5: Persist History

After each round (including the final one), save classified data using the orchestrator's history functions:

```python
from multi_review import save_round_history, save_review_summary

# After classifying findings in round N:
save_round_history(repo, pr_number, round_obj, mode="single", domain_agents=da_map)

# After ALL rounds complete:
save_review_summary(repo, pr_number, base, all_rounds, mode="single", domain_agents=da_map)
```

The skill doesn't call these Python functions directly — instead, it writes the equivalent JSON to:
- `~/.claude/code-review/history/{org}/{repo}/{pr}/round-{N}.json` — per-round data
- `~/.claude/code-review/history/{org}/{repo}/{pr}/rounds.json` — full summary

**Critical for optimization:** Every finding MUST have `classification` and `classification_reason` set before saving. Unclassified findings are tracked but cannot improve the system. The `quality.per_agent_domain` section in the summary is what `/stark-metrics` uses to recommend `domain_agents` tuning.

The history schema (v2) includes:
- `mode`: "single" or "team"
- `domain_agents`: the agent map used (for single mode)
- `classification_summary`: fix/noise/false_positive/ignored counts
- `quality.per_agent`: signal rate per agent
- `quality.per_agent_domain`: signal rate per agent×domain (the key optimization input)
- `quality.per_domain`: which agents found real bugs per domain

## Phase 6: Cleanup

```bash
cd -
git worktree remove "$WORKTREE" --force
```

## Observability

Standard observability: timestamped progress logs, record metrics block (PR number, agent used, domains succeeded/failed, findings by severity, fix rounds, duration). Emit completion event via `emit_queue.py`. See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure | Recovery |
|---------|----------|
| Agent CLI not installed | Error message: "Install {agent} CLI" |
| Agent timeout | Log which domain timed out, continue with remaining results |
| All domains fail | Present error, suggest `--agent <other>` or `/stark-team-review` |
| PR not found | "PR #{n} not found. Check --repo or run from the correct directory." |
| Worktree creation fails | Fall back to reviewing in current directory |
| Tests fail after fix | Count against round limit, continue fixing |
