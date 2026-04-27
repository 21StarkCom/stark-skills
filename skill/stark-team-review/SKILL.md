---
name: stark-team-review
description: >-
  Multi-agent PR code review: all enabled LLMs x N domains with autonomous fix loop. Use for team review, multi-agent review.
argument-hint: "[PR_NUMBER] [--rounds N] [--dry-run] [--repo ORG/REPO]"
disable-model-invocation: false
context: fork
model: opus[1m]
workflow_path: references/workflow.md
revision: 31916a19c29d4dac9f4f4606ecb288cb4810f890
revision_date: 2026-04-25T11:50:10+03:00
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-team-review --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue.
- If `overall` is "ready": continue silently.
- In non-interactive automation contexts, a blocked preflight must emit a `preflight_check` event with `status=blocked`, append an entry to `~/.claude/code-review/alerts.jsonl`, and exit non-zero so the trigger is marked failed.

# stark-team-review

Multi-agent PR review: all enabled LLMs across 9 domain specializations dispatched in parallel. Default install runs Claude + Codex; Gemini participates when enabled in config. Autonomous fix-review loop until clean or max rounds.

## Arguments

- `<number>` — PR number (e.g., `/stark-team-review 91`)
- `--rounds N` — max fix-review cycles (default: 3)
- `--repo ORG/REPO` — override repo detection
- `--dry-run` — review only, no fixes, no GitHub posting
- If number omitted, detect from current branch: `gh pr view --json number --jq .number`
- If detection fails (e.g., on `main`), list open PRs and ask: `gh pr list --json number,title,headRefName --jq '.[] | "#\(.number) \(.title) (\(.headRefName))"'`

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

To call github_app.py: `$PYTHON $SCRIPTS/github_app.py <args>`
To call multi_review.py: `$PYTHON $SCRIPTS/multi_review.py <args>`

## Workflow

See [references/workflow.md](references/workflow.md) for the full phased procedure:

- **Phase 1 — Setup:** detect repo, authenticate, fetch PR metadata, determine mode (full vs review-only), push local changes, create isolated worktree, rebase over base, capture test baseline.
- **Phase 1.9 — Runtime Verification (MANDATORY):** import-chain test, SDK API spot-check, cross-module interface trace. Failures here become critical findings before any review agent runs.
- **Phase 2 — Review-Fix Loop:** dispatch multi-agent review, classify findings (fix / recurring / false_positive / noise / ignored), fix, build + test (regressions only), commit/push, persist round, stop check.
- **Phase 3 — Final Summary:** headline counts, findings table, misalignment analysis, prompt improvement assessment.
- **Phase 3b — Skill Suggestions:** surface follow-up skills via `skill_router.py`.
- **Phase 4 — Post & Persist:** orchestrator summary comment, bug issues (user PAT, capped at 5), review-rounds project tracking, v2 history schema files.
- **Phase 5 — Cleanup:** remove worktree and review branch (best-effort).

## Observability

See [references/observability.md](references/observability.md) for the full observability protocol (tasks, timestamped logs, checkpoints, metrics block, improvement flags, timing JSON, event emission).

## Review Guidelines

- Don't suggest adding tests unless there's a concrete logic bug risk
- Flag actual security issues (XSS, injection, auth bypass)
- Don't comment on missing JSDoc/comments
- Be specific: include file paths, line numbers, and concrete fix suggestions
- Distinguish between "this will break" (critical) and "this could be better" (suggestion/nit)
- If the project has PR review guidelines in CLAUDE.md, those take precedence

### Signal-to-Noise Optimization

See [references/signal-to-noise.md](references/signal-to-noise.md) for learnings from real-world data (runtime verification vs review agents, interface mismatches, SDK assumptions).

## Debugging Dispatch Failures

See [references/debugging-dispatch.md](references/debugging-dispatch.md) for CLI flags per agent, error detection, and smoke tests.
