# CLAUDE.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude, Codex, and Gemini are all enabled by default. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.claude/code-review/scripts/`
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 30 skills), installed as symlinks to `~/.claude/skills/`
- `org/evinced/` — Evinced org config, installed to `~/git/Evinced/.code-review/`
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `automation/` — CCR automation fleet: 12 triggers, prompts, logs, cost tracking, reports
- `.github/workflows/` — GitHub Actions: project sync, gate checks, stale detection, heartbeat
- `docs/` — specs, plans, ADRs, retrospectives, generated skill docs
- `standards/` — org-wide doc templates and workflows, installed to `~/.claude/code-review/standards/`
- `install.sh` — symlinks repo contents to install locations

## Key Files

### Dispatchers & orchestration
- `scripts/dispatcher_base.py` — shared base: config discovery, model resolution, domain/prompt resolution
- `scripts/multi_review.py` — PR review orchestrator (ThreadPoolExecutor, parallel sub-agents)
- `scripts/plan_review_dispatch.py` — plan/design review dispatch (N agents × M domains)
- `scripts/design_to_plan_dispatch.py` — generic generate-and-cross-review dispatch for enabled agents
- `scripts/autopilot_dispatch.py` — tournament-based autonomous implementation (agents compete in worktrees)
- `scripts/tournament.py` — reusable multi-LLM competition engine (semantic, visual, test evaluation)
- `scripts/domain_triage.py` — context-aware domain dispatch engine
- `scripts/triage_orchestrator.py` — triage orchestration with shadow validation support

### Agent utilities
- `scripts/claude_utils.py` — Claude CLI dispatch helpers (Vertex AI env, model pinning)
- `scripts/codex_utils.py` — Codex CLI dispatch helpers (JSONL parsing, reasoning config)
- `scripts/gemini_utils.py` — Gemini CLI dispatch helpers (session isolation, API key fallback)

### Infrastructure
- `scripts/config_loader.py` — central config with lru_cache, typed section accessors, deep merge
- `scripts/runtime_env.py` — isolated subprocess env builder (allowlist, token injection, temp dirs)
- `scripts/github_app.py` — multi-app GitHub auth (stark-claude, stark-codex, stark-gemini)
- `scripts/github_projects.py` — GitHub Projects V2 GraphQL utility (13 public functions)
- `scripts/emit_queue.py` — SQLite-backed durable event queue with dead-letter
- `scripts/session_state.py` — persistent session state management
- `scripts/stark_graph.py` — dependency graph pipeline (parse, diff, blast radius, PR commenting)

### TUI & session
- `scripts/tui_core.py` — shared TUI rendering primitives (box, table, progress)
- `scripts/triage_tui.py` — triage decision TUI renderer
- `scripts/session_tui.py` — session start/end renderer
- `scripts/session_tui_cli.py` — session TUI CLI entry point

### Other
- `scripts/stark_persona.py` — session persona engine (weighted selection, combos, catchphrases)
- `scripts/generate_skill_docs.py` — multi-LLM documentation generator with viz competition
- `scripts/flow_extractor.py` — workflow extraction from SKILL.md files
- `scripts/flow_layout.py` — dagre layout runner for flow diagrams
- `scripts/flow_schema.py` — FlowDiagram Pydantic model
- `scripts/metrics.py` — review performance metrics collection
- `scripts/pr_status.py` — PR analytics dashboard data
- `scripts/plan_to_tasks_validate.py` — plan decomposition validation (3 LLM passes)

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain PR review prompts (9 domains each)
- `global/prompts/{design-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/{design-to-plan,prompt-to-design}/` — per-agent generate + cross-review prompts
- `global/prompts/autopilot/` — per-agent autopilot implementation prompts
- `global/prompts/triage/` — domain triage prompts and manifest
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

- `/stark-forge <path> [--auto-detect] [--dry-run] [--resume] [--workers N]` — end-to-end design pipeline: classify, review, plan, tasks
- `/stark-design "prompt" | <path>` — (archived) generate design doc from requirements; use `superpowers:brainstorm` + `/stark-forge` instead
- `/stark-review-design <path>` — multi-agent design/spec review (N agents × 12 domains, default N=2)
- `/stark-design-to-plan <path>` — generate implementation plan from design doc (enabled agents generate, then cross-review before synthesis)
- `/stark-review-plan <path>` — multi-agent execution plan review (N agents × 10 adversarial domains, default N=2)
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-autopilot <plan-or-prompt> [--plan-slug SLUG]` — autonomous implementation with tournament at every step (all enabled agents compete in worktrees); issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`
- `/stark-forged-review [PR_NUMBER]` — leader + 2nd-opinion PR review with dynamic triage and forge-path escalation (default going forward; replaces `/stark-review`)
- `/stark-review [PR_NUMBER]` — *[deprecated]* single-agent PR code review (1 LLM × 9 domains, fast/cheap). Use `/stark-forged-review` instead.
- `/stark-team-review [PR_NUMBER]` — multi-agent PR code review (all enabled LLMs × 9 domains; default: 2)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-pr-flow` — end-to-end PR workflow: push, create, review, merge
- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-tournament "prompt" [--config file.yaml]` — multi-LLM competition with configurable evaluation strategies
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback

### Project Setup & Docs

- `/stark-onboard-project` — bootstrap new project: git, GitHub, apps, CLAUDE.md
- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs
- `/stark-extract-docs <path-to-spec>` — extract knowledge from specs/reviews into ADRs, retrospectives, reference docs
- `/stark-generate-docs [--skill <name>]` — generate/update skill docs with multi-LLM viz

### Code Intelligence

- `/stark-graph [--stage parse|audit|diff] [--repo PATH]` — dependency graph pipeline: parse docstrings, audit coverage, diff changes, compute blast radius, post PR comments

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
