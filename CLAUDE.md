# CLAUDE.md — stark-skills

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

- `scripts/multi_review.py` — PR review orchestrator (ThreadPoolExecutor, parallel sub-agents)
- `scripts/plan_review_dispatch.py` — plan/design review dispatch (N agents × M domains)
- `scripts/design_to_plan_dispatch.py` — generic generate-and-cross-review dispatch (3 generate + 6 review)
- `scripts/github_app.py` — multi-app GitHub auth (stark-claude, stark-codex, stark-gemini)
- `global/config.json` — default config schema
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain PR review prompts
- `global/prompts/{design-review,plan-review}/` — per-agent × per-domain doc review prompts
- `global/prompts/{design-to-plan,prompt-to-design}/` — per-agent generate + cross-review prompts
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

### Pipeline (end-to-end, in order)

- `/stark-design "prompt" | <path>` — generate design doc from requirements (3 agents generate, 6 cross-reviews, synthesized)
- `/stark-review-design <path>` — multi-agent design/spec review (N agents × 11 domains, default N=2)
- `/stark-design-to-plan <path>` — generate implementation plan from design doc (3 agents, 6 cross-reviews, synthesized)
- `/stark-review-plan <path>` — multi-agent execution plan review (N agents × 10 adversarial domains, default N=2)
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-autopilot <plan-or-prompt>` — autonomous implementation with tournament at every step (3 agents compete in worktrees)
- `/stark-review [PR_NUMBER]` — multi-agent PR code review (3 LLMs × 9 domains)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-pr-flow` — end-to-end PR workflow: push, create, review, merge
- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-tournament "prompt" [--config file.yaml]` — multi-LLM competition with configurable evaluation strategies

### Project Setup & Docs

- `/stark-onboard-project` — bootstrap new project: git, GitHub, apps, CLAUDE.md
- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs
- `/stark-extract-docs <path-to-spec>` — extract knowledge from specs/reviews into ADRs, retrospectives, reference docs
- `/stark-generate-docs [--skill <name>]` — generate/update skill docs with multi-LLM viz

### Maintenance & Analytics

- `/stark-update-deps` — audit and update dependency versions
- `/stark-rename-project <old> <new> [--dry-run]` — rename project + update refs
- `/stark-claude-md-improver` — analyze and improve CLAUDE.md files
- `/stark-pr-status` — PR analytics dashboard
- `/stark-metrics` — review performance metrics
- `/stark-session-insights [--project <name>] [--refresh]` — analyze session history for usage patterns
- `/stark-skill-analytics [--skill <name>] [--format table|full]` — skill usage and adoption metrics

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
