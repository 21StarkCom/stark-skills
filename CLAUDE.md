# CLAUDE.md — stark-review

## What This Is

Multi-agent PR code review system. 3 AI CLI tools (Claude, Codex, Gemini) × N domain specializations = 3N parallel sub-agent reviews per PR. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.claude/code-review/scripts/`
- `skill/` — all skills (`skill/stark-*/SKILL.md`), installed as symlinks to `~/.claude/skills/`
- `org/evinced/` — Evinced org config, installed to `~/git/Evinced/.code-review/`
- `docs/specs/` — design spec
- `standards/` — org-wide doc templates and workflows, installed to `~/.claude/code-review/standards/`
- `install.sh` — symlinks repo contents to install locations

## Key Files

- `scripts/multi_review.py` — orchestrator engine (ThreadPoolExecutor, parallel sub-agents)
- `scripts/github_app.py` — multi-app GitHub auth (stark-claude, stark-codex, stark-gemini)
- `global/config.json` — default config schema
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain review prompts
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Commands

```bash
./install.sh              # install (symlink to ~/.claude/code-review/)
./install.sh --status     # check installation
./install.sh --uninstall  # remove symlinks
```

## Skills

All skills live in `skill/stark-*/SKILL.md` and are symlinked to `~/.claude/skills/` via install.sh.

- `/stark-review [PR_NUMBER]` — multi-agent PR review (3 LLMs × 6 domains)
- `/stark-review-plan <path>` — multi-agent plan/spec review (3 LLMs × 7 domains)
- `/stark-review-improvement` — improve prompts based on review assessment
- `/stark-review-deployment-plan` — adversarial infra/deployment plan review
- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-pr-flow` — end-to-end PR workflow: push, create, review, merge
- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs
- `/stark-onboard-project` — bootstrap new project: git, GitHub, apps, CLAUDE.md
- `/stark-rename-project <old> <new> [--dry-run]` — rename project + update refs
- `/stark-update-deps` — audit and update dependency versions
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-extract-docs <path-to-spec>` — extract knowledge from specs/reviews into ADRs, retrospectives, reference docs
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-claude-md-improver` — analyze and improve CLAUDE.md files
- `/stark-session-insights [--project <name>] [--refresh]` — analyze session history for usage patterns, skill invocations, corrections

## Conventions

- Prompts are per-agent: each LLM gets its own version of each domain
- Domain IDs are slugs derived from filenames: `01-architecture.md` → `architecture`
- Config uses JSON, prompts use markdown
- Agent preambles in `agent.md`, domain prompts in `NN-domain.md`

## GitHub Apps

| App | App ID | Installation ID | Keychain |
|-----|--------|----------------|----------|
| stark-claude | 3066738 | 115648521 | STARK_CLAUDE_PRIVATE_KEY |
| stark-codex | 3066834 | 115650994 | STARK_CODEX_PRIVATE_KEY |
| stark-gemini | 3066689 | 115648971 | STARK_GEMINI_PRIVATE_KEY |
