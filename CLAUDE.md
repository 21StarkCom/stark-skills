# CLAUDE.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude and Codex are enabled by default; Gemini is disabled (opt-in via `models.gemini.enabled`). Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Language preference:** Go for backend, TypeScript for scripts. **Avoid Python at all costs** — do not introduce new Python; when touching existing Python (orchestrators under `scripts/`), prefer rewriting in TypeScript (`tools/`) over extending the Python.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Always update documentation.** Any change that affects behavior, structure, commands, env vars, or operations must update the relevant docs (this file and `AGENTS.md` included) in the same change.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — Python orchestrator + GitHub App auth, installed to `~/.claude/code-review/scripts/`
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 30 skills), installed as symlinks to `~/.claude/skills/`
- `org/evinced/` — Evinced org config, installed to `~/Code/.code-review/`
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

### TUI & session
- `scripts/tui_core.py` — shared TUI rendering primitives (box, table, progress)
- `scripts/triage_tui.py` — triage decision TUI renderer
- `scripts/session_tui.py` — session start/end renderer
- `scripts/session_tui_cli.py` — session TUI CLI entry point

### Red-team audit + emit-queue CLIs (Phase 1a of the TS migration)
- `scripts/red_team_audit_cli.py` — canonical cross-language seam for the red-team audit SQLite. Subcommands: `resolve-db` (single source of truth for the DB path: `--db` > `STARK_RED_TEAM_DB` env > `red_team.audit.db_path` config > default `~/.claude/code-review/history/forged-review/forged_review_metrics.db`), `ensure-schema` (atomic temp-then-rename create / empty-DB recovery / pre-marker bootstrap / verify+refresh, all under a singleton `schema_meta` marker + `PRAGMA user_version`), `assert-schema-version` (writer gate), `migrate --stamp-current`, `preflight-credentials` (stark-claude/codex/gemini Keychain + installation-token mint smoke), and Phase 1a bodies for `record-run` / `record-findings` / `update-run-status` (allowed-transition guard incl. forbidden terminal→in-progress + `--from` mismatch) / `read-run` / `get-findings`. All Phase-1 subcommands carry `--replay-transcript PATH` so the Phase 2 `--help` parity gate passes. Every body runs the canonical resolver → `ensure-schema` → `assert-schema-version` preflight before any read/write. Stdout discipline: exactly one JSON envelope per call; logs go to stderr. See `docs/specs/red-team-audit-schema-2026-05-16.md` and `docs/specs/red-team-cli-contract-2026-05-16.md`. Frozen schema version: 1.
- `scripts/red_team_emit_queue_cli.py` — canonical wrapper over `scripts/emit_queue.py` for the red-team subsystem. Subcommands: `enqueue --type T [--dedupe-key K]` (idempotent on `dedupe_key`), `peek [--source pending|dead-letter] [--limit N]`, `mark-done --event-id ID|--dedupe-key K` (idempotent), `dead-letter --event-id ID|--dedupe-key K [--reason R]` (idempotent). JSON in / JSON out, one envelope per call.
- `scripts/red_team_design_dispatch.py` + `scripts/red_team_plan_dispatch.py` now expose `--replay-transcript PATH`. Schema in `tools/fixtures/replays/sample-design-replay.json`. The flag bypasses live Codex/Responses-API dispatch and feeds the recorded transcript through the parsing → aggregation → sidecar → audit-write path — the deterministic seam the Phase 2 TS port will use for byte-level parity testing.

### Other
- `scripts/stark_persona.py` — session persona engine (weighted selection, combos, catchphrases)
- `scripts/plan_to_tasks_validate.py` — plan decomposition validation (3 LLM passes)

### TS tools (`tools/`)
- `tools/skill_lib.ts` — shared skill discovery + reference parsing
- `tools/skill_audit.ts`, `skill_validate.ts`, `skill_optimize.ts`, `skill_autopilot.ts` — meta-tooling
- `tools/skill_diet.ts` — duplication linter for shared boilerplate (preflight, dispatch-failure, GH App auth)
- `tools/release_changelog.ts`, `release_version_bump.ts` — stark-release Steps 3 + 5
- `tools/review_setup_worktree.ts`, `review_cleanup_worktree.ts` — stark-review worktree provisioning
- `tools/housekeeping_infra.ts` — stark-housekeeping Phase 5 (sessions, locks, log rotation, archival)
- `tools/design_review_summary.ts` — legacy stark-review-design Phase 4 markdown renderer (kept for the Python `plan_review_dispatch.py` consumers)
- `tools/copilot_dispatch.ts` — stark-copilot lead/wing dispatcher (replaces former `scripts/copilot_dispatch.py`)
- `tools/stark_review_doc.ts` + `stark_review_doc_lib.ts` — lead/wing doc-review dispatcher used by `/stark-review-design` and `/stark-review-plan`. Codex (xhigh) reviews per-domain in parallel; Claude (opus-4-7) wing emits JSON patches that the host applies with unique-match validation. Replaces the Python `plan_review_dispatch.py` for these two skills (the Python remains for `triage_orchestrator.py` and `plan_to_tasks_validate.py`).

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

- `/stark-review-design <path>` — lead/wing design/spec review: codex (gpt-5.5, xhigh) reviews 8 domains in parallel (cap 3 concurrent), claude (opus-4-7) wing applies JSON patches. Multi-round fix loop with per-round git commit; final review-only round captures unresolved. Tournament mode removed in the TS port. Delegates to `tools/stark_review_doc.ts`.
- `/stark-red-team-design <path> [--source-spec PATH] [--model ID] [--dry-run]` — adversarial committee challenge of a design doc (5 personas × 1 round, default `gpt-5.5-pro`); writes `<design>.red-team.md` sidecar and posts to PR if detected; challenge-only, no fix loop
- `/stark-design-to-plan <path>` — generate implementation plan from design doc (enabled agents generate, then cross-review before synthesis)
- `/stark-review-plan <path>` — lead/wing execution plan review: codex (xhigh) reviews 4 adversarial domains (`completeness`, `security`, `sequencing`, `viability`), claude wing applies JSON patches. Same TS dispatcher as design review (`tools/stark_review_doc.ts --prompts-dir plan-review`).
- `/stark-red-team-plan <path> [--source-spec PATH] [--model ID] [--dry-run]` — adversarial committee challenge of an execution plan (5 personas × 1 round, default `gpt-5.5-pro`); writes `<plan>.red-team.md` sidecar and posts to PR if detected; challenge-only, no fix loop
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-autopilot <plan-or-prompt> [--plan-slug SLUG]` — autonomous implementation with tournament at every step (all enabled agents compete in worktrees); issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`
- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents (default lead `claude`, wing `codex`); lead implements in worktree, wing reviews diff, fix-loop until approved. Cheaper, lower-variance sibling of autopilot.
- `/stark-gh:pr-merge [--pr N] [...]` — rebase + draft squash prose & CHANGELOG entry via Codex + force-push + squash-merge once CI is green
- `/stark-gh:cleanup [--pr N] [--dry-run] [--keep-branch NAME] [--no-rebase] [--no-watcher-cleanup] [--no-config] [--force] [--json]` — sweep merged/stale branches (local + remote), prune tracking refs, remove worktree leftovers, clean merged-PR watcher state, and rebase current branch onto upstream so history stays linear. `--pr N` narrows to one PR's head ref + watcher state.
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × 9 domains, fast/cheap)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback
- `/stark-gh-user [show|primary|secondary|swap|limits]` — switch GitHub user identity for `gh` calls (rate-limit relief); tokens in macOS Keychain (service `stark-gh-token`); resolver = `scripts/user_token.py`

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
| stark-claude | 3066738 | 115648521 | STARK_CLAUDE_PRIVATE_KEY |
| stark-codex | 3066834 | 115648800 | STARK_CODEX_PRIVATE_KEY |
| stark-gemini | 3066689 | 115648971 | STARK_GEMINI_PRIVATE_KEY |
