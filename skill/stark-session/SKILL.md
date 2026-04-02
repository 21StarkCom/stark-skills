---
name: stark-session
description: >
  Session management — start and end modes. Start: loads context, git state, health checks,
  briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json
  hierarchy. Use when the user says "session start", "session end", "start session", "end session",
  "what was I working on", "catch me up", or invokes /stark-session.
argument-hint: "[start|end]"
---

# stark-session

Session lifecycle management with two modes: **start** (context load + briefing) and **end** (test + merge + commit + push).

## Arguments

- `/stark-session` or `/stark-session start` — starts a session (default mode)
- `/stark-session end` — ends a session

## Config

Path: `.code-review/config.json` (hierarchical: global → org → repo).

Read config by checking these locations in order (later overrides earlier):

1. `~/.claude/code-review/config.json` (global)
2. Walk parent directories from the current repo root looking for `.code-review/config.json` (org level)
3. Repo root `.code-review/config.json`

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
gh pr list --author @me --state open --json number,title,headRefName,reviewDecision,url 2>/dev/null
gh pr view --json number,title,state,reviewDecision,statusCheckRollup 2>/dev/null
```

If `gh` fails, skip PR info — not fatal.

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

### Phase 3 — Health checks

Run each command in `session.health_checks` from config. Capture stdout/stderr on failure for display in briefing. Report pass/fail — non-fatal, never blocking.

**Built-in check — telemetry queue health:**

```bash
python3 -c "
import sys; sys.path.insert(0, '$HOME/git/Evinced/stark-skills/scripts')
from emit_queue import pending_count, dead_letter_count
p, d = pending_count(), dead_letter_count()
if d > 0: print(f'WARN: {d} dead-lettered events, {p} pending — run: python3 -c \"from emit_queue import retry_dead_letters; retry_dead_letters()\"'); sys.exit(1)
elif p > 10: print(f'WARN: {p} events pending drain — stark-insights may be down'); sys.exit(1)
else: print(f'OK: queue healthy ({p} pending, {d} dead)')
"
```

Report result in the Health line of the briefing. Non-fatal.

### Phase 4 — Available skills

```bash
ls ~/.claude/skills/*/SKILL.md 2>/dev/null
ls .claude/skills/*/SKILL.md 2>/dev/null
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

### Phase 5 — Briefing

Present a concise briefing:

```
Branch: feature/xyz (3 ahead, clean)
PRs: #42 (open, 2 approvals)
Health: ✓ tests, ✓ lint, ✗ build (error: ...)
Skills: /stark-team-review, /stark-session, /init-docs, ...

Recent: 3 commits today on this branch
Memory: [key context from memory files]
```

Condense or omit empty sections. Don't dump full CLAUDE.md. Keep it concise.

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

### Phase 6 — Summary

```
Tests: ✓ passed
PRs: #42 merged (squash)
Docs: committed (3 files)
Project: 2 issues updated (Documentation State → Drafted)
Pushed: main → origin/main
Telemetry: 42 events synced to Cloud SQL (0 remaining)

Session complete.
```

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
