# AGENTS.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude and Codex are enabled by default; Gemini is disabled (opt-in via `models.gemini.enabled`). Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Language preference:** Go for backend, TypeScript for scripts. **Avoid Python at all costs** — do not introduce new Python; when touching existing Python (orchestrators under `scripts/`), prefer rewriting in TypeScript (`tools/`) over extending the Python.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Always update documentation.** Any change that affects behavior, structure, commands, env vars, or operations must update the relevant docs (this file and `CLAUDE.md` included) in the same change.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.Codex/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.Codex/code-review/scripts/`
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 30 skills), symlinked to Claude and copied to `~/.codex/skills/`
- `org/evinced/` — Evinced org config, installed to `~/Code/.code-review/`
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `automation/` — CCR automation fleet: 12 triggers, prompts, logs, cost tracking, reports
- `.github/workflows/` — GitHub Actions: project sync, gate checks, stale detection, heartbeat
- `docs/` — specs, plans, ADRs, retrospectives, generated skill docs
- `standards/` — org-wide doc templates and workflows, installed to `~/.Codex/code-review/standards/`
- `install.sh` — symlinks repo contents to Claude/config locations and copies Codex skills

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
- `scripts/claude_utils.py` — Codex CLI dispatch helpers (Vertex AI env, model pinning)
- `scripts/codex_utils.py` — Codex CLI dispatch helpers (JSONL parsing, reasoning config)
- `scripts/gemini_utils.py` — Gemini CLI dispatch helpers (session isolation, API key fallback)

### Infrastructure
- `scripts/config_loader.py` — central config with lru_cache, typed section accessors, deep merge
- `scripts/runtime_env.py` — isolated subprocess env builder (allowlist, token injection, temp dirs)
- `scripts/github_app.py` — multi-app GitHub auth (stark-Codex, stark-codex, stark-gemini)
- `scripts/github_projects.py` — GitHub Projects V2 GraphQL utility (13 public functions)
- `tools/emit_queue_lib.ts` + `tools/emit_queue_cli.ts` — SQLite-backed durable event queue (producer side). Python consumers reach it via `scripts/_emit.py`, a thin subprocess wrapper. The drain side lives in stark-insights.
- `scripts/session_state.py` — persistent session state management

### TUI & session
- `scripts/tui_core.py` — shared TUI rendering primitives (box, table, progress)
- `scripts/triage_tui.py` — triage decision TUI renderer
- `scripts/session_tui.py` — session start/end renderer
- `scripts/session_tui_cli.py` — session TUI CLI entry point

### Red-team audit + emit-queue CLIs (Python shell-out seam; Phase 1a of the TS migration)
- The red-team subsystem is **pure TypeScript** under `tools/`. All Python red-team modules + CLIs were deleted by end of the 2026-05-16 migration. The Responses-API model allowlist + key resolver previously in `scripts/openai_responses.py` are now inlined into `preflight.py::check_red_team_transport_auth` (its only consumer).

### Red-team TS dispatchers
- `tools/red_team_lib.ts` — red-team dispatcher core. Persona/prompt resolution, codex dispatch with sandbox, per-finding validation, sidecar markdown rendering, pre-dispatch sensitive-data gate, redaction sanitizer, data-classification gate, `--replay-transcript` support. Fix-plan generation (`resolveFixPlan` + `runRedTeamFixPlan` + `renderFixPlanSection`), insights emission (`emitRun` / `emitFinding` / `emitFixPlan`). All Python shell-outs removed in Phase 5b — audit writes go through `tools/red_team_audit_lib.ts`, insights events through `tools/emit_queue_lib.ts`, DB resolution through `tools/red_team_db_resolver.ts`.
- `tools/red_team_design.ts` / `tools/red_team_plan.ts` — `/stark-red-team-{design,plan}` TS dispatcher entry points.
- `tools/red_team_audit_lib.ts` — SQLite schema + writes (`recordRedTeamRun`, `recordFindings`, `recordFixPlan`, `recordPersonaStats`, `pruneRedTeamMetrics`, `initRedTeamTables`, `sanitizeFixPlanJson`, `loadAuditPolicy`) via `node:sqlite`. Multi-statement writes wrap in BEGIN/COMMIT.
- `tools/red_team_audit_text_lib.ts` — FU-rt6 retention policy + redaction.
- `tools/red_team_human_review_lib.ts` — FU-rt8 acceptance engine.
- `tools/red_team_status.ts` / `tools/red_team_accept.ts` — operator CLIs for listing / accepting human-review halts.
- `tools/red_team_backfill_lib.ts` + `tools/red_team_backfill.ts` — historical-row backfill into the insights queue.
- `tools/red_team_db_resolver.ts` — Canonical audit DB resolver (`--db` > env > config > default), matches Python `Path.resolve()` symlink semantics on macOS.
- `tools/emit_queue_lib.ts` — canonical TS implementation of the producer queue (`makeEvent` + `enqueue` + `validate` + `health` + `pendingCount` + `deadLetterCount` + `recordContextPct` + `initSchema`). Writes to `~/.stark-insights/queue.db`. Python consumers reach it through `tools/emit_queue_cli.ts` via `scripts/_emit.py`.
- `tools/stark_persona_lib.ts` — Slice 1 of the `/stark-persona` Python→TS port: read-only surface (`PersonaRecord`, `parseRoster`, `loadRoster`, `loadActive`/`writeActive`/`deleteActive`, `computeWeight`, `getDateMatches`, `fuzzyMatchPersona`). Faithful port from `scripts/stark_persona.py`; write paths + CLI follow in Slice 2.

### Other
- `scripts/stark_persona.py` — session persona engine (weighted selection, combos, catchphrases). **Mid-migration to TS** — read-only surface now in `tools/stark_persona_lib.ts`; remains authoritative until the CLI cutover lands in Slice 3.
- `scripts/generate_skill_docs.py` — multi-LLM documentation generator with viz competition
- `scripts/flow_extractor.py` — workflow extraction from SKILL.md files
- `scripts/flow_layout.py` — dagre layout runner for flow diagrams
- `scripts/flow_schema.py` — FlowDiagram Pydantic model
- `scripts/metrics.py` — review performance metrics collection
- `scripts/pr_status.py` — PR analytics dashboard data
- `scripts/plan_to_tasks_validate.py` — plan decomposition validation (3 LLM passes)

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{Codex,codex,gemini}/` — per-agent × per-domain PR review prompts (9 domains each)
- `global/prompts/{design-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/{design-to-plan,prompt-to-design}/` — per-agent generate + cross-review prompts
- `global/prompts/autopilot/` — per-agent autopilot implementation prompts
- `global/prompts/triage/` — domain triage prompts and manifest
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Commands

```bash
./install.sh              # install symlinks/copies
./install.sh --status     # check installation
./install.sh --uninstall  # remove installed symlinks/copies
```

## Skills

All skills live in `skill/stark-*/SKILL.md`; `install.sh` symlinks them for Claude and copies full skill directories to `~/.codex/skills/` for Codex.

### Pipeline (end-to-end, in order)

- `/stark-review-design <path>` — multi-agent design/spec review (N agents × 12 domains, default N=2)
- `/stark-design-to-plan <path>` — generate implementation plan from design doc (enabled agents generate, then cross-review before synthesis)
- `/stark-review-plan <path>` — multi-agent execution plan review (N agents × 10 adversarial domains, default N=2)
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-autopilot <plan-or-prompt> [--plan-slug SLUG]` — autonomous implementation with tournament at every step (all enabled agents compete in worktrees); issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × triage-selected domains, fast/cheap)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback

### Project Setup & Docs

- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs

## Conventions

- Prompts are per-agent: each LLM gets its own version of each domain
- Domain IDs are slugs derived from filenames: `01-architecture.md` → `architecture`
- Config uses JSON, prompts use markdown
- Agent preambles in `agent.md`, domain prompts in `NN-domain.md`

## GitHub Apps

| App | App ID | Installation ID | Keychain |
|-----|--------|----------------|----------|
| stark-Codex | 3066738 | 115648521 | STARK_CLAUDE_PRIVATE_KEY |
| stark-codex | 3066834 | 115648800 | STARK_CODEX_PRIVATE_KEY |
| stark-gemini | 3066689 | 115648971 | STARK_GEMINI_PRIVATE_KEY |
