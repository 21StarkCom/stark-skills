# Spec: `/stark-session` — Unified Session Skill

**Date:** 2026-03-18
**Status:** Draft (rev 2 — addresses stark-review-plan findings)
**Author:** Aryeh + Claude

## Problem

Session management skills (`/session-start`, `/session-end`) exist as independent copies across multiple repos with no shared structure. Each project has its own conventions for health checks, doc commits, PR merging, and devlogs. There's no global `/session-end` at all. The existing global `/session-start` is a plain file at `~/.claude/skills/session-start/SKILL.md` — not in any repo, not version-controlled, not part of the stark-review ecosystem.

## Goals

1. Unify `/session-start` and `/session-end` into a single `/stark-session` skill with `start` and `end` modes
2. Use the existing `.code-review/config.json` hierarchy (global → org → repo) for session configuration
3. Standardize doc handling around the dev docs structure (from the dev-docs-management spec)
4. Allow project-level overrides via config (preferred) or full SKILL.md replacement (fallback)
5. Use the user's own PAT (`gh` CLI) for all session operations — no GitHub App bot

## Non-Goals

- Migrating existing project-local session skills immediately (they stay as-is, migrated gradually)
- Writing memory at session end (Claude's built-in memory handles this)
- Bot-based PR operations (session ops are user-facing, not bot-facing)

## Solution

### Config Schema

A `"session"` key in `.code-review/config.json` at any hierarchy level:

```json
{
  "test_command": "pnpm test",
  "session": {
    "health_checks": ["pnpm test", "pnpm lint"],
    "build_command": "pnpm build",
    "doc_paths": ["docs/", "CLAUDE.md"],
    "devlog_path": "docs/devlog/",
    "pr_merge_strategy": "squash"
  }
}
```

Note: `session.test_command` is optional. If not set, the skill uses the top-level `test_command` (the same key `/stark-review` uses for fix loops). This avoids duplicating the test command in two places.

**Defaults (in `global/config.json`):**

| Key | Default | Notes |
|-----|---------|-------|
| `health_checks` | `[]` | Project must opt in |
| `build_command` | `null` | |
| `test_command` | `null` | Falls back to top-level `test_command` outside the `session` block |
| `doc_paths` | `["docs/", "CLAUDE.md"]` | Paths to stage on session end (directories are `git add <dir>`) |
| `devlog_path` | `null` | No devlog unless configured |
| `pr_merge_strategy` | `"squash"` | Valid values: `squash`, `merge`, `rebase` |

Config merges follow the existing `discover_config()` pattern — repo overrides org overrides global, key by key.

**Security note:** Commands from `health_checks`, `build_command`, and `test_command` are executed by Claude Code, which shows each command to the user for approval via its permission system. The skill does not bypass this — it relies on Claude Code's standard command execution flow.

### `/stark-session start`

**Invocation:** `/stark-session start` or `/stark-session` (defaults to start)

**Phase 1 — Gather context (silent)**
- Read CLAUDE.md (project + parent directories)
- Read memory files from `~/.claude/projects/<path>/memory/`
- Read `.code-review/config.json` hierarchy for session config

**Phase 2 — Git state**
- Current branch, clean/dirty status, stash count
- Recent commits (last 5 on current branch)
- Open PRs via `gh pr list`

**Phase 3 — Health checks**
- Run each command in `health_checks` array from config
- Capture stdout/stderr on failure for display in the briefing
- Report pass/fail for each
- Non-fatal — a failing check is reported, not blocking

**Phase 4 — Available skills**
- List global skills from `~/.claude/skills/`
- List project-local skills from `.claude/skills/`

**Phase 5 — Briefing**

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

### `/stark-session end`

**Invocation:** `/stark-session end`

**Phase 1 — Run tests**
- Run `test_command` from config (if set)
- Run `build_command` from config (if set)
- If either fails, warn but don't block — ask whether to proceed

**Phase 2 — Merge open PRs**
- Check for open PRs on current branch via `gh pr list --head <branch>`
- If found, offer to merge each via `gh pr merge --<strategy>` (strategy from config, default squash)
- If merge fails (conflicts, failed checks, permissions), report the error and ask: "Skip this PR and continue?"
- Uses user's PAT via `gh` CLI, not a GitHub App bot
- If `gh auth status` fails, skip PR operations with a warning

**Phase 3 — Commit docs**
- Stage files matching `doc_paths` from config (default: `docs/`, `CLAUDE.md`). Skip paths that don't exist.
- If `devlog_path` is configured, prompt the user: "One-line summary for the devlog and commit message?" Use their response for both.
- Commit with message: `docs: session update — <user-provided summary>`
- Only commit if there are actually staged changes

**Phase 4 — Push**
- If current branch has a remote tracking branch, push
- If on main and ahead of origin, push
- If push fails (protected branch, stale ref), report the error and ask how to proceed
- Otherwise ask

**Phase 5 — Summary**

```
Tests: ✓ passed
PRs: #42 merged (squash)
Docs: committed (3 files)
Pushed: main → origin/main

Session complete.
```

### Project-Level Overrides

**Config override (preferred):** Set project-specific values in the repo's `.code-review/config.json`. The global skill reads them automatically via hierarchy merge.

**Full SKILL.md override (fallback):** If `.claude/skills/stark-session/SKILL.md` exists in a repo, it replaces the global skill entirely. Used for projects with complex session logic that can't be expressed in config (e.g., design-system-core's sub-skill invocations).

**Resolution order — two separate mechanisms:**

1. **Skill selection:** If `.claude/skills/stark-session/SKILL.md` exists in the repo, it is used exclusively. Otherwise, the global skill is used.
2. **Config merging (for the global skill):** repo `.code-review/config.json` > org config > `global/config.json` > hardcoded defaults. Keys merge via `discover_config()` — repo overrides org overrides global, key by key.

### Where This Lives

```
stark-review/
  skill/
    stark-session/
      SKILL.md              # /stark-session skill definition
  global/
    config.json             # Add "session" key with defaults
```

`install.sh` symlinks `skill/stark-session/SKILL.md` → `~/.claude/skills/stark-session/SKILL.md`.

The old `/session-start` at `~/.claude/skills/session-start/SKILL.md` is renamed to `SKILL.md.bak` after the new skill is installed (preserving any user customizations for reference).

### Auth

All session operations use the user's own credentials via `gh` CLI:
- PR listing: `gh pr list`
- PR merging: `gh pr merge`
- Git push: standard git (SSH/HTTPS as configured)

No GitHub App (stark-claude/stark-codex/stark-gemini) is involved. Session operations are user-facing actions, not bot actions.

## Integration Points

| System | Integration |
|--------|-------------|
| `.code-review/config.json` | Add `"session"` key to global defaults. Existing `discover_config()` merges it. |
| `install.sh` | Add stark-session skill symlink. Remove old session-start. |
| Dev docs system | Session end commits to `doc_paths` matching the standard structure. |
| `gh` CLI | All PR and git operations use user's PAT. |

## Migration Path

1. Install `/stark-session` globally via `install.sh`
2. Backup old `/session-start` to `SKILL.md.bak` in `~/.claude/skills/session-start/`
3. Existing project-local session skills continue working — they take precedence over the global skill
4. When touching a project, migrate its local session skill to config overrides and delete the local SKILL.md
5. Projects with genuinely complex session logic keep their local SKILL.md override
