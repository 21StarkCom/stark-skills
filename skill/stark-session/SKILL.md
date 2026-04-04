---
name: stark-session
description: >-
  Session start (context, git state, briefing) and end (tests, merge, push). Use for session start/end, catch me up.
argument-hint: "[start|end]"
disable-model-invocation: true
model: opus
---

## Preflight

Run environment validation before proceeding:
```bash
python3 ~/.claude/code-review/scripts/preflight.py --workflow stark-session --json
```
Parse the JSON result:
- If `overall` is "blocked": print the failing checks and stop. Do not proceed.
- If `overall` is "degraded": print a warning with the failing checks, then continue.
- If `overall` is "ready": continue silently.

# stark-session

Session lifecycle management with two modes: **start** (context load + briefing) and **end** (test + merge + commit + push).

## Arguments

- `/stark-session` or `/stark-session start` — starts a session (default mode)
- `/stark-session end` — ends a session
- `--plain` — plain text mode (no ANSI, no emoji, no box-drawing)
- `--no-color` — disable ANSI color only (keep emoji and box-drawing)

**Raw input:** `$ARGUMENTS`

## Constants

```
SCRIPTS = ~/.claude/code-review/scripts
PYTHON  = $SCRIPTS/.venv/bin/python3
```

## Config

Path: `.code-review/config.json` (hierarchical: global → org → repo).

Read config by checking these locations in order (later overrides earlier):

1. `~/.claude/code-review/config.json` (global)
2. Walk parent directories from the current repo root looking for `.code-review/config.json` (org level)
3. Repo root `.code-review/config.json`

Guard each read with `test -f <path> && cat <path> || true` — missing config files are normal, not errors.

Merge the `session` block from each level. If `session.test_command` is null, fall back to the top-level `test_command`.

| Key | Default | Notes |
|-----|---------|-------|
| `health_checks` | `[]` | Commands to run on start |
| `build_command` | `null` | Build command for end |
| `test_command` | `null` | Falls back to top-level `test_command` |
| `doc_paths` | `["docs/", "CLAUDE.md"]` | Paths to stage on end |
| `devlog_path` | `null` | Devlog directory |
| `pr_merge_strategy` | `"squash"` | squash/merge/rebase |

Security note: all commands execute through Claude Code's standard permission system.

---

## Start Mode

### Phase 0b — Session State

```bash
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```

Parse the JSON output:
- Display: `Session: {session_id} | Branch: {branch} | Started: {started_at}`
- If `tasks_completed` is non-empty (resuming): display `Resuming session: {N} tasks completed`
- If `last_checkpoint` is set: display `Last checkpoint: {last_checkpoint}`

If the command fails, skip silently — session state is optional.

### Phase 0c — Record start HEAD

Record the current HEAD SHA for session-scoped diffs at end time:

```bash
START_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "")
```

Persist `start_head` to session state if session state was loaded. This is used by `/stark-session end` for accurate diff summaries.

### Phase 1 — Gather context (silent)

Read and internalize — do NOT display any of this content.

- Read `CLAUDE.md` from current directory and each parent directory up to `~`
- Read memory files: check `~/.claude/projects/*/memory/` for directories matching the current project path. Read `MEMORY.md` and any other memory files found.
- Read config hierarchy for session settings (see Config section above)

### Phase 2 — Git state

```bash
git fetch --prune   # clean up stale remote-tracking refs
git branch --show-current
git status --short  # NEVER use -uall
git log --oneline -5
git stash list

# If on feature branch:
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ]; then
    git log main..$BRANCH --oneline 2>/dev/null
fi
```

Fetch open PRs:

```bash
gh pr list --author @me --state open --json number,title,headRefName,reviewDecision,url 2>/dev/null || true
gh pr view --json number,title,state,reviewDecision,statusCheckRollup 2>/dev/null || true
```

Both commands are non-fatal — `|| true` ensures exit code 0 even when there's no PR for the current branch.

### Project Board Context

If `.github/project-config.json` exists in the repo root:

1. Use bot token: `export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)`
2. Query in-flight work:
   ```python
   in_flight = github_projects.get_items(config['project_id'], Status='Agent Working', Agent='Claude')
   ```
3. Query items needing attention:
   ```python
   needs_attention = github_projects.get_items(config['project_id'], Status='Needs Clarification')
   blocked = github_projects.get_items(config['project_id'], Status='Blocked')
   ```
4. Display in briefing:
   ```
   📋 Project Board:
     In-flight (Agent Working): {count}
     {for each: #N — title (SP: X, Risk: Y)}

     Needs Clarification: {count}
     {for each: #N — title}

     Blocked: {count}
     {for each: #N — title (reason)}
   ```
5. `unset GH_TOKEN`

If project config is missing, skip silently.

### Phase 2b — Unacknowledged Alerts

Check for unacknowledged critical alerts before proceeding:

```bash
python3 ~/.claude/code-review/scripts/alert_delivery.py --check --json 2>/dev/null || true
```

Parse the JSON. If `unacknowledged` is non-empty, display prominently **before** the briefing:

```
ALERT: {N} unacknowledged alert(s) require attention:
  {for each: marker path}
Run: python3 ~/.claude/code-review/scripts/alert_delivery.py --check
```

Non-fatal — continue with session start even if alerts exist. If the command fails, skip silently.

### Phase 3 — Health checks

Run each command in `session.health_checks` from config. Capture stdout/stderr on failure for display in briefing. Report pass/fail — non-fatal, never blocking.

**Built-in check — telemetry queue health:**

```bash
python3 ~/.claude/code-review/scripts/emit_queue.py --health 2>/dev/null || true
```

Parse the JSON output (`queue_depth`, `last_event_timestamp`) and display:
- `queue_depth`: number of events pending delivery
- `last_event_timestamp`: ISO8601 timestamp of the most recent event

Also run the queue depth check:

```bash
python3 -c "
import sys; sys.path.insert(0, '$HOME/git/Evinced/stark-skills/scripts')
from emit_queue import pending_count, dead_letter_count
p, d = pending_count(), dead_letter_count()
if d > 0: print(f'WARN: {d} dead-lettered events, {p} pending — run: python3 -c \"from emit_queue import retry_dead_letters; retry_dead_letters()\"')
elif p > 10: print(f'WARN: {p} events pending drain — stark-insights may be down')
else: print(f'OK: queue healthy ({p} pending, {d} dead)')
" 2>/dev/null || true
```

If `~/.claude/code-review/healer.jsonl` exists, show a failure category summary:

```bash
python3 -c "
import json, collections, pathlib
log = pathlib.Path.home() / '.claude/code-review/healer.jsonl'
if not log.exists(): exit(0)
cats = collections.Counter()
for line in log.read_text().splitlines():
    try:
        e = json.loads(line)
        cat = e.get('category')
        if cat: cats[cat] += 1
    except Exception: pass
if cats:
    print('Failure categories (last session):')
    for cat, n in cats.most_common(5): print(f'  {cat}: {n}')
" 2>/dev/null || true
```

**Built-in check — healer canary status:**

```bash
python3 ~/.claude/code-review/scripts/healer_canary.py --status --json 2>/dev/null || true
```

Parse the JSON (`patterns` array). Display any notable items:
- Any pattern with `circuit == "open"`: `WARN: healer circuit open: {id}`
- Any pattern with `mode == "suggest"` and `successful_suggests >= 3`: `Near promotion: {id} ({n}/5 suggests)`

Skip silently if command fails or output is empty.

Report all results in the Health line of the briefing. Non-fatal — never blocking.

### Phase 4 — Available skills

```bash
ls ~/.claude/skills/*/SKILL.md 2>/dev/null || true
ls .claude/skills/*/SKILL.md 2>/dev/null || true
```

Extract skill names from directory paths.

### Phase 4b — Persona Selection

If `/stark-persona` skill is available (check `~/.claude/skills/stark-persona/SKILL.md` exists):

```bash
PERSONA_JSON=$(python3 scripts/stark_persona.py select --auto 2>/dev/null)
```

If the command succeeds and returns valid JSON, include in the briefing:
```
Persona: {persona} ({source}) — "{catchphrase}"
```

If it fails, skip silently — persona is optional, never blocks session start.

The random pop-up survey (1-in-5 chance) fires AFTER persona selection, not before. If the survey triggers, present ONE question after the briefing.

### Phase 4c — Skill Suggestions

```bash
python3 ~/.claude/code-review/scripts/skill_router.py --context session --json 2>/dev/null || true
```

Parse the JSON. If `suggestions` is non-empty, display at most 2:
```
Suggested: /stark-housekeeping, /stark-skill-analytics
```
If the command fails or returns no suggestions, skip silently.

### Phase 5 — Structured Briefing

Render the session briefing using the TUI CLI. Build the command from data collected in Phases 0b–4b:

```bash
# Build flags from $ARGUMENTS
PLAIN_FLAG=""
NO_COLOR_FLAG=""
[[ "$ARGUMENTS" == *"--plain"* ]] && PLAIN_FLAG="--plain"
[[ "$ARGUMENTS" == *"--no-color"* ]] && NO_COLOR_FLAG="--no-color"

# Also check environment
[[ -n "$STARK_PLAIN" ]] && PLAIN_FLAG="--plain"

# Build persona JSON if available
PERSONA_ARG=""
if [ -n "$PERSONA_JSON" ]; then
    PERSONA_ARG="--persona '$PERSONA_JSON'"
fi

# Build next-up JSON from task list items discovered in phases 2-4
# Format: [{"label": "Address review comments on #42", "priority": "action", "issue": "#42"}, ...]
NEXT_UP_ARG=""
if [ -n "$NEXT_UP_JSON" ]; then
    NEXT_UP_ARG="--next-up '$NEXT_UP_JSON'"
fi

$PYTHON $SCRIPTS/session_tui_cli.py start \
    --session-id "$SESSION_ID" \
    --repo "$REPO" \
    --start-head "$START_HEAD" \
    --started-at "$STARTED_AT" \
    $PLAIN_FLAG $NO_COLOR_FLAG $PERSONA_ARG $NEXT_UP_ARG
```

If the CLI exits non-zero, fall back to plain-text briefing using the data already collected in earlier phases. Log the error but do not show the raw traceback.

The structured briefing replaces the previous plain text output with color-coded sections for git state, PRs, health, alerts, board, and next-up items. Environment behavior (NO_COLOR, TERM=dumb, non-TTY) is handled automatically by the CLI's `make_config()`.

### Phase 6 — Session Task List

After the briefing, propose a prioritized task list built from what was discovered in phases 1–5. Sources, in priority order:

1. **Open PRs needing action** — review comments to address, failing checks, requested changes
2. **Uncommitted changes** — dirty working tree, staged files, stashes
3. **Failing health checks** — test failures, build errors from Phase 3
4. **Project board items** — issues assigned to Claude with status "Agent Working" (if project config exists)
5. **Stale branches** — local branches with no commits in the last 7 days

Only include items that actually exist — skip empty categories. Format:

```
Suggested task list:
  1. [PR] Address review comments on #42
  2. [Fix] 3 failing tests in scripts/
  3. [Git] Uncommitted changes in 2 files
  4. [Board] #18 — Add retry logic (Agent Working)
  5. [Stale] feature/old-thing — no activity for 12 days
```

Then ask: **"Task list look right? Say 'go' to start from the top, or tell me what to focus on."**

When the user says "go" (or equivalent approval), work through the list sequentially. Auto-continue between tasks without prompting "what's next?" after each one. Only pause between tasks if a genuine decision is needed (e.g., a merge conflict, an ambiguous review comment, a failing test that could be skipped or fixed).

If the task list is empty (everything is clean), fall back to: "Everything looks clean. What are we working on?"

---

## End Mode

### Phase 0b — Persona Cleanup

If `~/.stark-persona/active.json` exists:

```bash
python3 scripts/stark_persona.py session-end 2>/dev/null
```

This handles: 20% chance fun-fact callout, active.json deletion, cleanup confirmation.

If the fun-fact block is returned, display it AFTER the session summary (as a closing flourish).

### Phase 1 — Run tests

- Get test_command: use `session.test_command` if set, else top-level `test_command`
- Run test_command if set
- Run `session.build_command` if set
- If either fails: warn, ask "Proceed anyway?"

### Phase 2 — Merge open PRs

```bash
gh auth status
```

If auth fails, skip with warning.

```bash
gh pr list --head $(git branch --show-current) --json number,title,state
```

For each open PR: offer to merge via `gh pr merge <number> --<strategy>` where strategy comes from `session.pr_merge_strategy` (default: squash).

On merge failure: report error, ask "Skip this PR and continue?"

Uses user's PAT via `gh` CLI — NOT the GitHub App bots.

### Phase 3 — Commit docs

- For each path in `session.doc_paths`: check if exists, then `git add <path>`
- If `session.devlog_path` is configured:
  - Prompt user: "One-line summary for the devlog and commit message?"
  - Create devlog entry at `<devlog_path>/YYYY-MM-DD.md` with summary
  - Stage the devlog file
- If no devlog configured, still ask for a summary for commit message
- `git diff --cached --stat` — if empty, skip commit
- Commit: `git commit -m "docs: session update — <summary>"`

### Phase 3b — Session Checkpoint

Generate a final checkpoint for context window recovery:

```bash
python3 ~/.claude/code-review/scripts/context_compactor.py --json 2>/dev/null || true
```

Parse the JSON and note: `Checkpoint written: {checkpoint_path}`

If the command fails, skip silently — checkpointing is optional.

Record the end-of-session state (including the checkpoint path just written):

```bash
python3 ~/.claude/code-review/scripts/session_state.py --json 2>/dev/null || true
```

This loads the current session state, which triggers an auto-save — persisting the final snapshot (tasks completed, last checkpoint, end-of-session context). If it fails, skip silently.

### Phase 4 — Project Field Updates

If `.github/project-config.json` exists in the repo root:

1. For each issue touched in this session (from git log):
   - Extract issue numbers from commit messages
   - Check if `docs/` files were modified in commits referencing that issue
   - If docs modified: update Documentation State to 'Drafted' (if currently 'Not Started')
2. Do NOT override manually-set Documentation State values ('Reviewed', 'Complete')
3. Verify artifact links: for medium/high risk issues, check if `## Artifacts` section has URLs

Failure handling: log warnings, never block session end.

If project config is missing, skip silently.

### Phase 5 — Push

- If branch has upstream: `git push`
- If on main and ahead of origin: `git push`
- On push failure: report error, ask how to proceed
- Otherwise (no upstream, not on main): ask "Push to origin?"

### Phase 5.5 — Sync Telemetry

Flush the event queue to the local buffer, then sync to Cloud SQL if available:

```bash
# 1. Drain queue.db → buffer.db (always works, no network needed)
$PYTHON -c "import sys; sys.path.insert(0, '$SCRIPTS'); from emit_queue import drain_to_buffer; print(drain_to_buffer(batch_size=500))"

# 2. Sync buffer.db → Cloud SQL (best-effort, skips if no DATABASE_URL or no network)
SYNC_SCRIPT=~/git/Evinced/stark-insights/scripts/sync_buffer.py
if [ -f "$SYNC_SCRIPT" ]; then
    ~/git/Evinced/stark-insights/.venv/bin/python3 "$SYNC_SCRIPT" 2>/dev/null
fi
```

Report result in Phase 6 summary. If sync fails, note "Telemetry: buffered locally (will sync next session)".

### Phase 5.6 — Derive Session Name

Choose a meaningful session name based on what was accomplished (priority order):

1. PRs merged during the session: `gh pr list --state merged --search "merged:>=$(echo $STARTED_AT | cut -dT -f1)" --json number,title,mergedAt 2>/dev/null` — filter results where mergedAt > $STARTED_AT
2. Issues closed: `gh issue list --state closed --search "closed:>=$(echo $STARTED_AT | cut -dT -f1)" --json number,title,closedAt 2>/dev/null` — same timestamp filter
3. Branch name: `git branch --show-current`
4. Most common commit prefix: `git log $START_HEAD..HEAD --format=%s 2>/dev/null`
5. Fallback: `session-$SESSION_ID`

Pass the chosen name through `slugify()` (or use the CLI which does it internally). The name must match `[a-z0-9-]{1,50}`.

### Phase 6 — Structured Summary

Build the receipt JSON from end-mode operation outcomes:

```bash
# Build receipt from phases 1-5.5 results
# Each item: {"name": "...", "passed": true|false|null, "detail": "...", "duration": seconds|null}
RECEIPT_JSON='[
    {"name": "Tests", "passed": '$TESTS_PASSED', "detail": "'$TESTS_DETAIL'", "duration": '$TESTS_DURATION'},
    {"name": "Build", "passed": '$BUILD_PASSED', "detail": "'$BUILD_DETAIL'", "duration": '$BUILD_DURATION'},
    {"name": "Push", "passed": '$PUSH_PASSED', "detail": "'$PUSH_DETAIL'", "duration": null},
    {"name": "PRs", "passed": '$PRS_PASSED', "detail": "'$PRS_DETAIL'", "duration": null},
    {"name": "Issues", "passed": null, "detail": "'$ISSUES_DETAIL'", "duration": null},
    {"name": "Docs", "passed": '$DOCS_PASSED', "detail": "'$DOCS_DETAIL'", "duration": null},
    {"name": "Telemetry", "passed": '$TELEMETRY_PASSED', "detail": "'$TELEMETRY_DETAIL'", "duration": null}
]'

$PYTHON $SCRIPTS/session_tui_cli.py end \
    --session-id "$SESSION_ID" \
    --repo "$REPO" \
    --name "$SESSION_NAME" \
    --start-head "$START_HEAD" \
    --started-at "$STARTED_AT" \
    --receipt "$RECEIPT_JSON" \
    $PLAIN_FLAG $NO_COLOR_FLAG $PERSONA_ARG
```

After rendering, persist the session name:
```python
session_state.name = session_name
session_state.save()
```

If the CLI exits non-zero, fall back to a plain-text summary listing the operation results.

The structured summary shows: session banner with name/duration/end time, receipt checklist, session-scoped diff summary, and next-up items for the next session.

---

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- **Start mode**: context load time, git state time, per-health-check duration (pass/fail), total briefing time
- **End mode**: test duration (pass/fail), build duration (pass/fail), PRs merged count, docs committed count, project fields updated count, push result

### Event emission

After the briefing (start mode) or summary (end mode), emit a completion event to stark-insights:

**Start mode:**
```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-session args=start duration_s=$TOTAL_SECONDS success=true \
  branch=$BRANCH health_passed=$PASSED health_total=$TOTAL
```

**End mode:**
```bash
$SCRIPTS/stark-emit skill_invocation \
  skill=stark-session args=end duration_s=$TOTAL_SECONDS success=$SUCCESS \
  prs_merged=$MERGED_COUNT docs_committed=$DOC_COUNT pushed=$PUSHED
```

Substitute actual values from the run. If stark-insights is not running, this fails silently.

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
| Project API call fails | Log warning, continue — never block |
| Config missing | Use hardcoded defaults |

## Mistakes to Avoid

- Don't dump full CLAUDE.md — internalize it
- Don't use `git status -uall`
- Don't block on any failure — always offer to continue
- Don't commit if no staged changes
- Don't push without asking if not on a tracked branch
- Don't use GitHub App bots — session ops use user's PAT via `gh`
- **Every command in a parallel batch must exit 0** — one non-zero exit cancels the entire batch. Use `|| true` on any command that might fail (ls with globs, cat on optional files, health checks). Phases 3, 4, and 4b are commonly parallelized — every command there must be failure-safe.
