# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.6.0] - 2026-04-10

### Added
- Gemini agent enabled with `gemini-3.1-pro-preview` via Vertex AI global endpoint
- **stark-graph** — pluggable dependency graph pipeline (7 phases): Python parser, audit mode, drift validator, graph diff + blast radius, idempotent PR commenting, review integration, CI workflows
- **Domain triage** — context-aware domain dispatch: triage engine, TUI renderer, orchestrator, shadow validation, `--domains` allowlist for dispatch scripts
- **Session TUI** — rich session start/end rendering: `tui_core.py` shared primitives, `session_tui.py` renderer, `session_tui_cli.py` CLI entry point, `SessionState` name/start_head fields
- Interactive TUI skill picker (`mngt-skills --select`) + global CLI entry point
- `analyze_shadow.py` — shadow validation gate metrics for domain triage
- Multi-org GitHub App routing — per-owner installation IDs with dynamic API discovery
- Adaptive timeout and large-diff triage for large PRs
- `tournament.dispatch_agent_prompt()` — generic agent dispatcher for tournament use (fixes broken `dispatch_competitor` call path)
- `conftest.py` autouse fixture to clear `config_loader.load_config` lru_cache between tests

### Changed
- Prompt consolidation: 40 byte-identical domain files collapsed into shared `domains/` directories
- Top 5 skills compressed 44-57% (phase-execute 665→372 lines, housekeeping 555→239)
- Claude dispatch uses `infra-ai-platform` project with global endpoint + opus default
- `config_loader`: `_SECTION_DEFAULTS` registry replaces 7 identical accessor functions; `_merge_dict` warns on non-dict overrides
- `dispatcher_base`: `resolve_model("claude")` returns real model ID via `CLAUDE_MODEL` constant; OSError on config files now warns to stderr
- `plan_review_dispatch`: uses `resolve_model()` instead of hardcoded `CODEX_MODEL`/`GEMINI_MODEL` constants
- `multi_review`: dedup Pass 3 skips `line=0` findings; `all_findings()` cached in summary construction; dead `codex_output_file` removed
- Review skills routed through triage orchestrator with fallback
- Cross-agent dedup, spec context injection, severity overrides expanded
- Test-coverage severity calibration + vendor-webhook SSRF hints in security prompts

### Fixed
- **Security:** `github_app` atomic token cache writes via `tempfile.mkstemp` + `os.replace` (was briefly world-readable); `gemini_utils.make_gemini_env` strips `ANTHROPIC_API_KEY` (was leaking full env); `autopilot_dispatch` `shell=True` → `shlex.split` (command injection); `session_state.load()` path traversal via `_sanitize_id()`
- **Critical:** `multi_review.deduplicate_findings` mutated Finding objects in-place (corrupted descriptions); `multi_review.review_pr` posted comments as disabled agents; `design_to_plan_dispatch` `int()` crash on non-numeric LLM scores; `emit_queue` `time.monotonic()` → `time.time()` for cross-process SQLite; `generate_skill_docs` HTML sanitizer now suppresses all dangerous tags; `plan_to_tasks_validate` Gemini output double-unwrapping
- **Important:** `github_app.get_token()` raises `RuntimeError` instead of `sys.exit(1)`; `github_projects` SingleSelect parser removed incorrect guard; `tournament.select_winner` `.get()` prevents KeyError; `runtime_env` temp dir injected as `STARK_AGENT_TMPDIR` + cleanup runs once per process; `autopilot_dispatch` uses `"implementation"` operation instead of `"review"` for bot token boundary; `flow_layout` uses `model_copy()` instead of in-place Pydantic mutation
- Symlink path bug in `domain_triage` + plan review fixes
- Dispatch routing audit and docs refresh
- Real wall-clock timestamps required in observability protocol

## [v0.5.1] - 2026-04-03

### Fixed
- Codex `model_id` defaulted to `"codex"` instead of `"gpt-5.4"` — caused 100% CLI failures across all 9 review domains
- YAML frontmatter parsing in `generate_skill_docs.py` — replaced fragile regex with `yaml.safe_load`, fixing block scalars (`>-`) and single-quoted values
- Hanging test in `test_plan_review_dispatch.py` — replaced subprocess dispatch with direct argparse validation
- Codex dispatch `cwd` not passed to subprocess — codex refused to run outside a trusted git directory
- Codex CLI error stderr now persisted to `~/.claude/code-review/logs/` for debugging
- Broken `scripts/.venv` (stale interpreter path from repo rename)

### Changed
- Codex `08-ui-design-conformance.md` prompt strengthened — bolded scope rules, explicit backend early-exit (was producing security/correctness findings on pure backend PRs)
- Cross-domain dedup instruction added to both `claude/agent.md` and `codex/agent.md` — agents now defer to specialized domain reviewers instead of duplicating findings
- Scope calibration added to 4 Claude domain prompts for small PRs
- Design-review domain count updated to 12 (new test-plan domain)

## [v0.5.0] - 2026-04-03

### Added
- `/stark-persona` skill — session character voices with weighted selection, date-aware combos, catchphrases, feedback loop, and `--add`/`--off` flags
- Persona roster: 45 characters across standup comics, comedy-action actors, Tarantino characters, and more
- Persona showcase pages: constellation, deck, periodic, roster HTML views
- `scripts/stark_persona.py` — persona CLI with producer-side JSON emission
- `scripts/flow_extractor.py` — scoped workflow extraction from SKILL.md files with flow-override support
- `scripts/flow_layout.py` — dagre layout runner with timeout
- `scripts/flow_schema.py` — FlowDiagram Pydantic model (dagre@0.8.5)
- Golden-file regression tests for flow extraction and layout
- 4 new PR review domains: spec-conformance, ui-design-conformance, regression-prevention (3 agents × 9 domains = 27 sub-agents total)
- Backend stack coverage in security, correctness, and test-coverage prompts
- Tournament results emission to stark-insights
- `generate_skill_docs.py` wired to push updates to stark-data-core
- Automation fleet: 12 CCR triggers across 4 tiers (self-improvement, health/drift, intelligence, reporting)
- Automation operator runbook (`automation/README.md`)
- Automation heartbeat GitHub Action (`.github/workflows/automation-heartbeat.yml`)
- Jinja2 report templates for MD, HTML, MDX automation reports
- Local validation utilities for automation fleet
- `/stark-design` skill — generate design doc from requirements (3 agents generate, 6 cross-reviews)
- `/stark-design-to-plan` skill — generate implementation plan from design doc
- `/stark-autopilot` skill — tournament-per-step implementation with 3 agents competing in worktrees
- `/stark-review-design-improvement` skill — improve design review prompts
- stark-insights event emission wired into 7 skills
- Review lessons embedded into autopilot, review, and pr-flow skills
- `scripts/config_loader.py` — shared config loader with typed accessors and hierarchical defaults (#183)
- `scripts/session_id.py` — authoritative session ID resolver (#184)
- `scripts/runtime_env.py` — isolated subprocess environment builder (#194)
- `scripts/preflight.py` — environment validation checks with timeout (#201)
- `scripts/emit_queue.py` — SQLite-backed event queue with dead-letter (#202)
- `scripts/event_schema.json` — event schema v2 with session awareness (#202)
- `scripts/validation_gate.py` — post-generation code validation chain (#185)
- `scripts/failure_classifier.py` — error categorization with confidence scoring (#186)
- `scripts/self_healer.py` — pattern-based auto-remediation with circuit breaker (#195, #206)
- `scripts/healer_patterns.json` — 8 healer patterns incl. TypeScript patterns (#195, #205)
- `scripts/lock_helpers.py` — exclusive-write locks with operator unlock (#208)
- `scripts/approach_contract.py` — pre-execution goal confirmation (#211)
- `scripts/session_state.py` — persistent session state management (#188)
- `scripts/context_compactor.py` — session checkpoint generation (#198)
- `scripts/learning_capture.py` — corrections and constraints extraction (#199)
- `scripts/skill_router.py` — contextual skill suggestions based on history (#197)
- `scripts/backfill_history.py` — historical data backfill for metrics baselines (#187)
- `scripts/cost_controls.py` — budget tracking, alerts, hard-stop, credential expiry (#210)
- `scripts/alert_delivery.py` — critical system event delivery path (#215)
- `scripts/dashboard.py` — HTML dashboard with 8 KPIs and fallback rendering (#200)
- Canary rollout framework for healer auto-mode (#213)
- Install provisioning for local infrastructure dirs and SQLite DBs (#193)

### Changed
- PR review coverage expanded from 6 to 9 domains per agent (18 → 27 sub-agents)
- README rewritten with pipeline narrative and full skill tables
- Design/plan review split into separate dispatch modes with tournament support
- `stark-onboard-project` now includes `/onboard-service` pointer for GCP services
- `stark-review-design` auto-commits fixes after each review round
- Config-driven agent enablement — agents respect `models.{agent}.enabled` in config (#203)
- Metrics extended with all 8 KPIs from design (#190, #196)
- Automation registry updated with new triggers and migrations (#191)
- Housekeeping expanded: session, checkpoint, lock, log cleanup, artifact archival (#189, #192)
- 6 SKILL.md files updated: session, housekeeping, phase-execute, autopilot, team-review, design-to-plan
- Config deprecation pipeline: add P0, warn P1, remove P2 (#204, #209, #212)
- Session/compactor/router wired into skill entry points (#207, #214)
- Preflight and approach contract wired into automation triggers (#216)

### Fixed
- Regression test failures from config-driven agent enablement
- Stale test assertions for removed GOOGLE_CLOUD_LOCATION hardcoding
- Persona stderr noise, combo rating, weight seeding
- Persona installed path for script invocation
- Autopilot `${pkg_name}` placeholder replaced with `.rglob` from cwd
- Invalid CLI flags found by spec review
- Stale remote-tracking refs via `git fetch --prune`
- `plan_to_tasks_validate` temp file naming with `$RANDOM`

## [v0.4.0] - 2026-03-26

### Added
- `scripts/tournament.py` — reusable tournament engine extracted from `generate_skill_docs.py` (#88)
- `TournamentConfig` and `TournamentResult` dataclasses with YAML config support (#89)
- `Tournament` orchestrator class with semantic and visual evaluation strategies (#90)
- Test evaluation strategy — run LLM-generated code against pytest test suites (#91)
- Tournament CLI with `--config`, `--prompt`, `--dry-run`, `--json` flags (#92)
- `/stark-tournament` skill for multi-LLM competition (#93)

### Changed
- `generate_skill_docs.py` refactored to use Tournament API (#94)
- Updated CLAUDE.md and README.md with `/stark-tournament` (#95)

## [v0.3.0] - 2026-03-25

### Added
- `generate_skill_docs.py` — multi-LLM documentation generator with visualization competition (#59, #60, #61, #62, #63, #64, #65, #66)
- `/stark-generate-docs` skill for ongoing doc maintenance (#69)
- Skill documentation for all 20 skills — Mermaid diagrams, HTML visualizations, PNG screenshots (#67, #68)
- Routing guide with Mermaid decision trees for skill discovery (#66)
- Git LFS tracking for skill documentation PNGs (#58)
- Shared CSS design system for HTML visualizations (#58)

### Changed
- `CLAUDE.md` — added `/stark-generate-docs` to skills tables (#70)

## [v0.2.0] - 2026-03-22

### Added
- `graphql()` function in `github_app.py` with retry support (#8)
- `github_projects.py` — GitHub Projects V2 GraphQL utility module with 13 public functions (#10)
- `setup_project.py` — one-time CLI script to create a Project with all custom fields (#14)
- `project-pr-sync` GitHub Action — PR events trigger project status transitions (#16)
- `project-gate-check` GitHub Action — composite release gate with `release-gate` status check (#18)
- `project-stale` GitHub Action — hourly detection of stuck agent/clarification items (#20)
- GitHub Projects integration in `stark-plan-to-tasks` — issues added to project with 9 fields set (#22)
- Project-based task fetching in `stark-phase-execute` with label fallback (#24)
- Documentation state advisory check in `stark-pr-flow` before merge (#26)
- Review Rounds field tracking in `stark-review` (#28)
- Project-aware session start/end in `stark-session` — briefing and doc state updates (#30)
- End-to-end integration tests for `github_projects.py` (#34)
- ADRs: 0010 (GraphQL for Projects V2), 0011 (fail-closed mutations), 0012 (additive migration)

### Changed
- `install.sh` now verifies `github_projects.py` and `setup_project.py` (#32)
- Comprehensive test suite for `github_projects.py` — 102 unit tests (#12)
