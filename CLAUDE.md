# CLAUDE.md — stark-review

## What This Is

Multi-agent PR code review system. 3 AI CLI tools (Claude, Codex, Gemini) × N domain specializations = 3N parallel sub-agent reviews per PR. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.claude/code-review/scripts/`
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

- `/stark-review [PR_NUMBER]` — multi-agent PR review (3 LLMs × 6 domains). Full mode with fix loop requires `test_command` in config. Otherwise review-only.
- `/stark-review-improvement` — improve prompts based on a completed stark-review's Prompt Improvement Assessment. Reads assessment from conversation context or history, edits prompt/orchestrator/config files, validates, logs to `docs/prompt-changelog.md`, and commits.
- `/stark-review-plan <path>` — multi-agent plan/spec review (3 LLMs × 7 domains). Review-fix loop with auto-fixes, then final review-only round. Outputs `.review.md` sibling file.
- `/init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs structure into any repo

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
