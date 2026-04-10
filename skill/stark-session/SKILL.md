---
name: stark-session
description: >-
  Session start (context, git state, briefing) and end (tests, merge, push). Use for session start/end, catch me up.
argument-hint: "[start|end]"
disable-model-invocation: true
model: opus
---

## Preflight

```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-session --json
```
Parse JSON: blocked → print failing checks and stop; degraded → warn and continue; ready → continue silently.

# stark-session

Session lifecycle management: **start** (context load + briefing) and **end** (test + merge + commit + push).

## Arguments

- `/stark-session` or `/stark-session start` — starts a session (default)
- `/stark-session end` — ends a session
- `--plain` — plain text (no ANSI, no emoji, no box-drawing)
- `--no-color` — disable ANSI color only

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Config

Path: `.code-review/config.json` (hierarchical: global → org → repo). Read each level with `test -f <path> && cat <path> || true`. Merge the `session` block; `session.test_command` falls back to top-level `test_command`.

| Key | Default | Notes |
|-----|---------|-------|
| `health_checks` | `[]` | Commands to run on start |
| `build_command` | `null` | Build command for end |
| `test_command` | `null` | Falls back to top-level |
| `doc_paths` | `["docs/", "CLAUDE.md"]` | Paths to stage on end |
| `devlog_path` | `null` | Devlog directory |
| `pr_merge_strategy` | `"squash"` | squash/merge/rebase |

---

## Start Mode

### Phase 0b — Session State

```bash
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```
Display session ID, branch, started_at. Show resume info if `tasks_completed` is non-empty or `last_checkpoint` is set. Skip silently if command fails.

### Phase 0c — Record start HEAD

```bash
START_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
```
Persist `start_head` to session state for end-mode diff summaries.

### Phase 1 — Gather context (silent)

Read and internalize — do NOT display any of this content:
- `CLAUDE.md` from current directory and each parent up to `~`
- Memory files: `~/.claude/projects/*/memory/` matching current project path
- Config hierarchy (see Config section)

### Phase 2 — Git state

```bash
git fetch --prune
git branch --show-current
git status --short  # NEVER use -uall
git log --oneline -5
git stash list
# If on feature branch: git log main..$BRANCH --oneline
```

Fetch open PRs (both non-fatal `|| true`):
```bash
gh pr list --author @me --state open --json number,title,headRefName,reviewDecision,url 2>/dev/null || true
gh pr view --json number,title,state,reviewDecision,statusCheckRollup 2>/dev/null || true
```

### Project Board Context

If `.github/project-config.json` exists: use bot token, query `in_flight` (Status=Agent Working, Agent=Claude), `needs_attention` (Status=Needs Clarification), and `blocked` items. Display in briefing. Unset GH_TOKEN after.

### Phase 2b — Unacknowledged Alerts

```bash
python3 ~/.claude/code-review/scripts/alert_delivery.py --check --json 2>/dev/null || true
```
If `unacknowledged` is non-empty, display prominently **before** the briefing. Non-fatal — continue even if alerts exist.

### Phase 3 — Health checks

Run each `session.health_checks` command. Report pass/fail — non-fatal.

**Built-in: telemetry queue health:**
```bash
python3 ~/.claude/code-review/scripts/emit_queue.py --health 2>/dev/null || true
```
Display `queue_depth` and `last_event_timestamp`. Also check for dead-lettered events:
```bash
python3 -c "
import sys; sys.path.insert(0, '$HOME/git/Evinced/stark-skills/scripts')
from emit_queue import pending_count, dead_letter_count
p, d = pending_count(), dead_letter_count()
if d > 0: print(f'WARN: {d} dead-lettered events, {p} pending')
elif p > 10: print(f'WARN: {p} events pending drain')
else: print(f'OK: queue healthy ({p} pending, {d} dead)')
" 2>/dev/null || true
```

If `~/.claude/code-review/healer.jsonl` exists, show top-5 failure categories:
```bash
python3 -c "
import json, collections, pathlib
log = pathlib.Path.home() / '.claude/code-review/healer.jsonl'
if not log.exists(): exit(0)
cats = collections.Counter(json.loads(l).get('category') for l in log.read_text().splitlines() if l)
if cats:
    print('Failure categories:')
    for cat, n in cats.most_common(5): print(f'  {cat}: {n}')
" 2>/dev/null || true
```

**Built-in: healer canary status:**
```bash
python3 ~/.claude/code-review/scripts/healer_canary.py --status --json 2>/dev/null || true
```
Display circuits open (`circuit == "open"`) and patterns near promotion (`mode == "suggest"`, `successful_suggests >= 3`). Skip silently if fails.

### Phase 4 — Available skills

`ls ~/.claude/skills/*/SKILL.md .claude/skills/*/SKILL.md 2>/dev/null || true`. Extract skill names from paths.

### Phase 4b — Persona Selection

If `/stark-persona` skill exists: `PERSONA_JSON=$(python3 scripts/stark_persona.py select --auto 2>/dev/null)`. If valid JSON, include in briefing: `Persona: {persona} ({source}) — "{catchphrase}"`. Skip silently if fails. 1-in-5 chance survey fires AFTER persona selection, displayed after the briefing.

### Phase 4c — Skill Suggestions

```bash
python3 ~/.claude/code-review/scripts/skill_router.py --context session --json 2>/dev/null || true
```
Display at most 2 suggestions. Skip silently if fails.

### Phase 5 — Structured Briefing

Build flags from `$ARGUMENTS` and `$STARK_PLAIN` env var. Build `PERSONA_ARG` and `NEXT_UP_ARG` from collected data. Invoke:

```bash
$PYTHON $SCRIPTS/session_tui_cli.py start \
    --session-id "$SESSION_ID" --repo "$REPO" \
    --start-head "$START_HEAD" --started-at "$STARTED_AT" \
    $PLAIN_FLAG $NO_COLOR_FLAG $PERSONA_ARG $NEXT_UP_ARG
```

If CLI exits non-zero, fall back to plain-text briefing from collected phase data. The structured briefing shows: git state, PRs, health, alerts, board, next-up items.

### Phase 6 — Session Task List

Build prioritized task list from phases 1–5 in this order:
1. Open PRs needing action (review comments, failing checks, requested changes)
2. Uncommitted changes (dirty tree, staged files, stashes)
3. Failing health checks
4. Project board items assigned to Claude (Status=Agent Working)
5. Stale branches (no commits in 7 days)

Only include categories that actually exist. Ask: **"Task list look right? Say 'go' to start from the top, or tell me what to focus on."** On "go", work sequentially without prompting between tasks — only pause for genuine decisions (merge conflict, ambiguous review, failing test). If empty: "Everything looks clean. What are we working on?"

---

## End Mode

### Phase 0b — Persona Cleanup

If `~/.stark-persona/active.json` exists: `python3 scripts/stark_persona.py session-end 2>/dev/null`. Display fun-fact callout (20% chance) AFTER session summary.

### Phase 1 — Run tests

Get test_command from `session.test_command` or top-level `test_command`. Run test_command and `session.build_command` if set. On failure: warn and ask "Proceed anyway?"

### Phase 2 — Merge open PRs

`gh auth status` — skip with warning if fails. `gh pr list --head $(git branch --show-current) --json number,title,state`. For each open PR: offer to merge via `gh pr merge <number> --<pr_merge_strategy>`. On failure: report and ask "Skip this PR?" Uses user's PAT via `gh` CLI — NOT GitHub App bots.

### Phase 3 — Commit docs

Stage paths from `session.doc_paths`. If `session.devlog_path` configured: prompt for one-line summary, create entry at `<devlog_path>/YYYY-MM-DD.md`, stage the file. Always ask for summary for commit message. Check `git diff --cached --stat` — skip commit if empty. Commit: `git commit -m "docs: session update — <summary>"`

### Phase 3b — Session Checkpoint

```bash
python3 ~/.claude/code-review/scripts/context_compactor.py --json 2>/dev/null || true
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```
Both are best-effort (`|| true`). Note checkpoint path in summary.

### Phase 4 — Project Field Updates

If `.github/project-config.json` exists: extract issue numbers from git log commits in this session. If `docs/` files were modified in commits referencing an issue, update Documentation State to 'Drafted' (only if currently 'Not Started'). Do NOT override 'Reviewed' or 'Complete'. Log warnings — never block session end.

### Phase 5 — Push

If branch has upstream or on main ahead of origin: `git push`. On failure: report and ask how to proceed. If no upstream and not on main: ask "Push to origin?"

### Phase 5.5 — Sync Telemetry

```bash
$PYTHON -c "import sys; sys.path.insert(0, '$SCRIPTS'); from emit_queue import drain_to_buffer; print(drain_to_buffer(batch_size=500))"
SYNC_SCRIPT=~/git/Evinced/stark-insights/scripts/sync_buffer.py
if [ -f "$SYNC_SCRIPT" ]; then ~/git/Evinced/stark-insights/.venv/bin/python3 "$SYNC_SCRIPT" 2>/dev/null; fi
```
If sync fails, note "Telemetry: buffered locally".

### Phase 5.6 — Derive Session Name

In priority order: PRs merged in session → issues closed in session → branch name → most common commit prefix → `session-$SESSION_ID`. Slugify (lowercase, hyphens, max 50 chars).

### Phase 6 — Structured Summary

Build receipt JSON from phases 1–5.5 results (Tests, Build, Push, PRs, Issues, Docs, Telemetry — each with `name`, `passed`, `detail`, `duration`). Invoke:

```bash
$PYTHON $SCRIPTS/session_tui_cli.py end \
    --session-id "$SESSION_ID" --repo "$REPO" --name "$SESSION_NAME" \
    --start-head "$START_HEAD" --started-at "$STARTED_AT" \
    --receipt "$RECEIPT_JSON" $PLAIN_FLAG $NO_COLOR_FLAG $PERSONA_ARG
```

After rendering: persist session name via `session_state.name = session_name; session_state.save()`. Fall back to plain-text summary if CLI exits non-zero.

---

## Observability

Standard observability: create task, emit timestamped logs, record metrics block. Skill-specific metrics:
- **Start:** context load time, git state time, per-health-check duration, total briefing time
- **End:** test duration, build duration, PRs merged, docs committed, project fields updated, push result

Emit completion event:
- **Start:** `$SCRIPTS/stark-emit skill_invocation skill=stark-session args=start duration_s=... branch=... health_passed=... health_total=...`
- **End:** `$SCRIPTS/stark-emit skill_invocation skill=stark-session args=end duration_s=... prs_merged=... docs_committed=... pushed=...`

See [../../standards/observability.md](../../standards/observability.md).

## Failure Modes

| Failure | Recovery |
|---------|----------|
| No CLAUDE.md | Note in briefing — suggest `/stark-onboard-project` |
| No memory files | "No previous session context" — not an error |
| `gh` auth fails | Skip PR sections — show git state only |
| Not a git repo | Skip git and PR sections |
| Health check fails | Report with stderr, continue |
| Test/build fails | Warn, ask whether to proceed |
| PR merge fails | Report error, offer to skip |
| Push fails | Report error, ask how to proceed |
| Project config missing | Skip project board/field sections silently |
| Config missing | Use hardcoded defaults |

> **Warning:** Every command in a parallel batch must exit 0 — one non-zero exit cancels the entire batch. Use `|| true` on any command that might fail (ls with globs, cat on optional files, health checks). Phases 3, 4, and 4b are commonly parallelized — every command there must be failure-safe.
