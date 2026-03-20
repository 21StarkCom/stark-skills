---
name: stark-session
description: >
  Session management — start and end modes. Start: loads context, git state, health checks,
  briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json
  hierarchy. Use when the user says "session start", "session end", "start session", "end session",
  "what was I working on", "catch me up", or invokes /stark-session.
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

### Phase 3 — Health checks

Run each command in `session.health_checks` from config. Capture stdout/stderr on failure for display in briefing. Report pass/fail — non-fatal, never blocking.

### Phase 4 — Available skills

```bash
ls ~/.claude/skills/*/SKILL.md 2>/dev/null
ls .claude/skills/*/SKILL.md 2>/dev/null
```

Extract skill names from directory paths.

### Phase 5 — Briefing

Present a concise briefing:

```
Branch: feature/xyz (3 ahead, clean)
PRs: #42 (open, 2 approvals)
Health: ✓ tests, ✓ lint, ✗ build (error: ...)
Skills: /stark-review, /stark-session, /init-docs, ...

Recent: 3 commits today on this branch
Memory: [key context from memory files]
```

Then ask: "What are we working on?"

Condense or omit empty sections. Don't dump full CLAUDE.md. Keep it concise.

---

## End Mode

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

### Phase 4 — Push

- If branch has upstream: `git push`
- If on main and ahead of origin: `git push`
- On push failure: report error, ask how to proceed
- Otherwise (no upstream, not on main): ask "Push to origin?"

### Phase 5 — Summary

```
Tests: ✓ passed
PRs: #42 merged (squash)
Docs: committed (3 files)
Pushed: main → origin/main

Session complete.
```

---

## Observability

Follow the [Skill Observability Protocol](~/.claude/code-review/standards/observability.md) for all timing, checkpoints, and metrics reporting.

Additional skill-specific metrics:
- **Start mode**: context load time, git state time, per-health-check duration (pass/fail), total briefing time
- **End mode**: test duration (pass/fail), build duration (pass/fail), PRs merged count, docs committed count, push result

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
| Config missing | Use hardcoded defaults |

## Mistakes to Avoid

- Don't dump full CLAUDE.md — internalize it
- Don't use `git status -uall`
- Don't block on any failure — always offer to continue
- Don't commit if no staged changes
- Don't push without asking if not on a tracked branch
- Don't use GitHub App bots — session ops use user's PAT via `gh`
