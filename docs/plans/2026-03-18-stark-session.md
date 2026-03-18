# `/stark-session` Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a unified `/stark-session` skill with `start` and `end` modes, replacing the existing standalone `/session-start`.

**Architecture:** Single SKILL.md with two modes. Config lives in the existing `.code-review/config.json` hierarchy. No new Python scripts — pure skill instructions. install.sh updated to symlink the skill and backup the old one.

**Tech Stack:** Claude Code skills (SKILL.md), JSON config, Bash (install.sh)

**Spec:** `docs/specs/2026-03-18-stark-session-design.md`

---

## Task 1: Add Session Config Defaults

Add the `"session"` key to `global/config.json`.

**Files:**
- Modify: `global/config.json`

- [ ] **Step 1: Read the current config**

Read `global/config.json` to see current structure.

- [ ] **Step 2: Add session defaults**

Add the `"session"` key with all defaults from the spec:

```json
{
  "agents": ["claude", "codex", "gemini"],
  "fix_threshold": "medium",
  "test_command": null,
  "build_command": null,
  "verify_before_clean": true,
  "disabled_domains": [],
  "extra_domains": [],
  "severity_overrides": {},
  "github_apps": {
    "claude": "stark-claude",
    "codex": "stark-codex",
    "gemini": "stark-gemini"
  },
  "session": {
    "health_checks": [],
    "build_command": null,
    "test_command": null,
    "doc_paths": ["docs/", "CLAUDE.md"],
    "devlog_path": null,
    "pr_merge_strategy": "squash"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add global/config.json
git commit -m "feat: add session config defaults to global config"
```

---

## Task 2: Create `/stark-session` SKILL.md

The main skill file with both `start` and `end` modes.

**Files:**
- Create: `skill/stark-session/SKILL.md`

- [ ] **Step 1: Read existing skills for format reference**

Read `skill/stark-review-plan/SKILL.md` and the old session-start skill at `~/.claude/skills/session-start/SKILL.md` for format and style guidance.

- [ ] **Step 2: Write the skill definition**

Create `skill/stark-session/SKILL.md` with YAML front matter:

```yaml
---
name: stark-session
description: >
  Session management — start and end modes. Start: loads context, git state, health checks,
  briefing. End: runs tests, merges PRs, commits docs, pushes. Config via .code-review/config.json
  hierarchy. Use when the user says "session start", "session end", "start session", "end session",
  "what was I working on", "catch me up", or invokes /stark-session.
---
```

The skill body must include:

**Arguments section:**
- `/stark-session` or `/stark-session start` — starts a session
- `/stark-session end` — ends a session

**Config section:**
- Path: `.code-review/config.json` (hierarchical: global → org → repo)
- Key: `"session"` block
- Fallback: `session.test_command` falls back to top-level `test_command` (the same key `/stark-review` uses)
- List all config keys with defaults and descriptions
- Security note: commands execute through Claude Code's standard permission system

**Start mode — 5 phases:**

Phase 1 — Gather context (silent):
- Read CLAUDE.md from current dir and parent directories (internalize, don't display)
- Read memory files: check `~/.claude/projects/*/memory/` for directories matching the current project path. Read `MEMORY.md` and any memory files found.
- Read `.code-review/config.json` hierarchy for session config (use the `discover_config()` merge pattern — check repo `.code-review/config.json`, then org, then global `~/.claude/code-review/config.json`)

Phase 2 — Git state:
- `git branch --show-current`
- `git status --short` (never use `-uall`)
- `git log --oneline -5`
- `git stash list`
- If on feature branch: `git log main..<branch> --oneline`

Phase 3 — Health checks:
- Run each command in `session.health_checks` from config
- Capture stdout/stderr on failure
- Report pass/fail — non-fatal, never blocking

Phase 4 — Available skills:
- List global: `ls ~/.claude/skills/*/SKILL.md`
- List project-local: `ls .claude/skills/*/SKILL.md`

Phase 5 — Briefing format:
```
Branch: feature/xyz (3 ahead, clean)
PRs: #42 (open, 2 approvals)
Health: ✓ tests, ✓ lint, ✗ build (error: ...)
Skills: /stark-review, /stark-session, /init-docs, ...

Recent: 3 commits today on this branch
Memory: [key context from memory files]
```
Then: "What are we working on?"
Condense or omit empty sections.

**End mode — 5 phases:**

Phase 1 — Run tests:
- Get `test_command`: use `session.test_command` if set, else fall back to top-level `test_command`
- Run `test_command` if set
- Run `session.build_command` if set
- If either fails: warn, ask "Proceed anyway?"

Phase 2 — Merge open PRs:
- `gh auth status` — if fails, skip with warning
- `gh pr list --head <branch> --json number,title,state`
- For each open PR: offer to merge via `gh pr merge <number> --<strategy>`
  - Strategy from `session.pr_merge_strategy` (default: squash)
- On merge failure: report error, ask "Skip this PR and continue?"

Phase 3 — Commit docs:
- For each path in `session.doc_paths`: check if path exists, then `git add <path>`
- If `session.devlog_path` is configured:
  - Prompt user: "One-line summary for the devlog and commit message?"
  - Create devlog entry at `<devlog_path>/YYYY-MM-DD.md` with summary
  - Stage the devlog file too
- If no devlog, still ask for a summary for the commit message
- `git diff --cached --stat` — if empty, skip commit
- Commit: `git commit -m "docs: session update — <summary>"`

Phase 4 — Push:
- If branch has upstream: `git push`
- If on main and ahead: `git push`
- On push failure: report error, ask how to proceed
- Otherwise: ask "Push to origin?"

Phase 5 — Summary:
```
Tests: ✓ passed
PRs: #42 merged (squash)
Docs: committed (3 files)
Pushed: main → origin/main

Session complete.
```

**Failure modes table:**
| Failure | Recovery |
|---------|----------|
| No CLAUDE.md | Note in briefing — suggest `/onboard-project` |
| No memory files | "No previous session context" — not an error |
| `gh` auth fails | Skip PR sections — show git state only |
| Not a git repo | Skip git and PR sections |
| Health check fails | Report failure with stderr, continue |
| Test/build fails | Warn, ask whether to proceed |
| PR merge fails | Report error, offer to skip |
| Push fails | Report error, ask how to proceed |
| Config missing | Use hardcoded defaults |

**Mistakes to avoid:**
- Don't dump full CLAUDE.md — internalize it
- Don't use `git status -uall` — can cause memory issues
- Don't block on any failure — always offer to continue
- Don't commit if there are no staged changes
- Don't push without asking if not on a tracked branch

- [ ] **Step 3: Commit**

```bash
git add skill/stark-session/
git commit -m "feat: create /stark-session skill with start and end modes"
```

---

## Task 3: Update `install.sh`

Add the new skill symlink and backup the old session-start.

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Read install.sh for current structure**

Read `install.sh` to find the skills section.

- [ ] **Step 2: Add stark-session skill symlink**

After the existing `init-docs` skill block (around line 140), add:

```bash
mkdir -p "$HOME/.claude/skills/stark-session"
if [ -f "$REPO_DIR/skill/stark-session/SKILL.md" ]; then
    link_dir "$REPO_DIR/skill/stark-session/SKILL.md" "$HOME/.claude/skills/stark-session/SKILL.md" "Skill: stark-session"
else
    warn "Skill file not found at $REPO_DIR/skill/stark-session/SKILL.md"
fi

# Backup old session-start if it exists (not a symlink — it was a standalone file)
if [ -f "$HOME/.claude/skills/session-start/SKILL.md" ] && [ ! -L "$HOME/.claude/skills/session-start/SKILL.md" ]; then
    mv "$HOME/.claude/skills/session-start/SKILL.md" "$HOME/.claude/skills/session-start/SKILL.md.bak"
    info "Old session-start: backed up to SKILL.md.bak"
elif [ -f "$HOME/.claude/skills/session-start/SKILL.md" ]; then
    info "Old session-start: exists (symlink, not backing up)"
fi
```

- [ ] **Step 3: Add stark-session to uninstall function**

In `uninstall()`, add:

```bash
unlink_dir "$HOME/.claude/skills/stark-session/SKILL.md" "Skill: stark-session"
```

- [ ] **Step 4: Add stark-session to status function**

In `status()`, add:

```bash
check_dir "$HOME/.claude/skills/stark-session/SKILL.md" "Skill: stark-session"
```

- [ ] **Step 5: Commit**

```bash
git add install.sh
git commit -m "feat: add stark-session to install.sh, backup old session-start"
```

---

## Task 4: Update CLAUDE.md

Add the new skill to repo documentation.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md**

Read `CLAUDE.md` to find the Skills section.

- [ ] **Step 2: Add stark-session to Skills list**

Add after the `/init-docs` line:

```markdown
- `/stark-session [start|end]` — session management: briefing on start, test/merge/commit/push on end
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add /stark-session to CLAUDE.md skills list"
```

---

## Task 5: Run Install and Verify

**Files:** None (verification only)

- [ ] **Step 1: Run install**

```bash
./install.sh
```

Expected: all existing items green + new "Skill: stark-session" green + "Old session-start: backed up to SKILL.md.bak".

- [ ] **Step 2: Verify symlink**

```bash
ls -la ~/.claude/skills/stark-session/SKILL.md
```

Expected: symlink pointing to the repo's `skill/stark-session/SKILL.md`.

- [ ] **Step 3: Verify old skill backup**

```bash
ls ~/.claude/skills/session-start/SKILL.md.bak
```

Expected: file exists (the backed-up old skill).

- [ ] **Step 4: Run status**

```bash
./install.sh --status
```

Expected: all items reported as installed, including stark-session.

- [ ] **Step 5: Verify config**

```bash
cat ~/.claude/code-review/config.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session',{}))"
```

Expected: prints the session defaults dict.
