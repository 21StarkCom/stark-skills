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
- `scripts/domain_triage.py` — context-aware domain dispatch engine
- `scripts/triage_orchestrator.py` — triage orchestration with shadow validation support

### Agent utilities
- `scripts/claude_utils.py` — Claude CLI dispatch helpers (Vertex AI env, model pinning)
- `scripts/codex_utils.py` — Codex CLI dispatch helpers (JSONL parsing, reasoning config)
- `scripts/gemini_utils.py` — Gemini CLI dispatch helpers (session isolation, API key fallback)

### Infrastructure
- `scripts/config_loader.py` — central config with lru_cache, typed section accessors, deep merge
- `scripts/runtime_env.py` — isolated subprocess env builder (allowlist, token injection, temp dirs)
- GitHub App auth lives entirely in `tools/github_app{,_lib}.ts` (TS). The former `scripts/github_app.py` was deleted on 2026-05-19; remaining Python orchestrators (`runtime_env.py`, `multi_review.py`) shell out to `node --experimental-strip-types tools/github_app.ts` for `token` mints — see TS tools section.
- `tools/emit_queue_lib.ts` + `tools/emit_queue_cli.ts` — SQLite-backed durable event queue (producer side). Python consumers reach it via `scripts/_emit.py`, a thin subprocess wrapper. The drain side lives in stark-insights.

### TUI & session
- `scripts/tui_core.py` — shared TUI rendering primitives (box, table, progress) — sole remaining consumer is `triage_tui.py`
- `scripts/triage_tui.py` — triage decision TUI renderer
- The session-start/end TUI is gone. `/stark-session` now collects state via `tools/stark_session.ts` and Claude renders the briefing/summary itself — see "TS tools" below.

### Red-team subsystem
The red-team subsystem is **pure TypeScript** under `tools/`. All Python red-team modules + CLIs were deleted by end of the 2026-05-16 migration. The Responses-API model allowlist + key resolver previously in `scripts/openai_responses.py` are now inlined into `tools/preflight_lib.ts::checkRedTeamTransportAuth` (its only consumer; was `preflight.py` before the TS port).

### Other
- `scripts/plan_to_tasks_validate.py` — plan decomposition validation (3 LLM passes)

### TS tools (`tools/`)
- `tools/red_team_lib.ts` — red-team dispatcher core. Persona/prompt resolution from `global/prompts/red-team/`, codex dispatch with sandbox (env scrubbing + isolated HOME), per-finding validation, sidecar markdown rendering, pre-dispatch sensitive-data gate, redaction sanitizer, data-classification gate (YAML-frontmatter driven; see `docs/specs/red-team-classification-contract-2026-05-16.md`), `--replay-transcript` support. Fix-plan generation lives here too (`resolveFixPlan` + `runRedTeamFixPlan` + `renderFixPlanSection`); gated by `red_team.fix_plan.enabled` (default `false`) and the `STARK_RED_TEAM_FIX_PLAN_KILL` env var. Best-effort insights emission (`emitRun` / `emitFinding` / `emitFixPlan`) writes directly to `~/.stark-insights/queue.db` via `tools/emit_queue_lib.ts`. Audit writes go through `tools/red_team_audit_lib.ts`. DB resolution via `tools/red_team_db_resolver.ts`. **No Python shell-outs.**
- `tools/red_team_design.ts` — `/stark-red-team-design` TS dispatcher. Thin wrapper over `red_team_lib.ts`.
- `tools/red_team_plan.ts` — `/stark-red-team-plan` TS dispatcher. Same shape as design with `--plan` instead of `--design`.
- `tools/red_team_audit_lib.ts` — SQLite schema + writes (`recordRedTeamRun`, `recordFindings`, `recordFixPlan`, `recordPersonaStats`, `pruneRedTeamMetrics`, `initRedTeamTables`, `sanitizeFixPlanJson`, `loadAuditPolicy`) via `node:sqlite` (built-in, no npm dep). Owns the canonical red-team audit DB schema. Multi-statement writes wrap in BEGIN/COMMIT for atomicity.
- `tools/red_team_audit_text_lib.ts` — FU-rt6 retention policy: `policyFromConfig`, `applyToField` (excerpt vs full-text mode with secret + PII redaction), `hashText`. Used by `buildFindingPayload` (insights events) + `red_team_audit_lib.ts` (audit-row inserts).
- `tools/red_team_human_review_lib.ts` — FU-rt8 acceptance: `computeAcceptKey`, `acceptFinding`, `isAccepted`, `filterHumanReviewFindings`, `listPendingHalts`, `lookupFindingMetadata`, `initTable` (with v1→v2 `accept_key` migration).
- `tools/red_team_status.ts` — Read-only CLI: lists pending human-review halts in human or `--json` mode, filterable by `--repo` / `--stage`. TS-native DB resolution.
- `tools/red_team_accept.ts` — Interactive CLI: looks up a stable key, shows the matched concern, optionally prompts (skippable via `--no-confirm`), writes an `INSERT OR IGNORE` accept row. PR-#430 round-3 fix #22 non-TTY refusal preserved.
- `tools/red_team_backfill_lib.ts` + `tools/red_team_backfill.ts` — Pulls historical `red_team_runs` + `red_team_findings` rows out of the audit DB, builds matching insights envelopes, enqueues directly. `--scope all|legacy|forward`, `--limit`, `--dry-run`, `--manifest`.
- `tools/red_team_db_resolver.ts` — Canonical audit DB resolver. Precedence: `--db` > `STARK_RED_TEAM_DB` env > `red_team.audit.db_path` config > default `~/.claude/code-review/history/forged-review/forged_review_metrics.db`. Returns the canonicalized path (collapses symlinks like `/tmp → /private/tmp` on macOS to match Python's `Path.resolve()`).
- `tools/stark_session_lib.ts` + `tools/stark_session.ts` — `/stark-session` data collector. Pure-function collectors (git, gh, board, alerts, health, queue, healer, persona, skills, session_state) with injected `run`/`readFile` deps for testability; CLI subcommands `start` and `end` print structured JSON for Claude to render. Each collector returns its slot or `null` on failure and pushes `{source, message}` to a shared `errors[]` accumulator. Session-state, persona, alerts, skill-suggestions, healer-canary collectors hit pure-TS siblings (`tools/session_state.ts`, `tools/stark_persona.ts`, `tools/alert_delivery.ts`, `tools/skill_router.ts`, `tools/healer_canary.ts`); the last few remaining Python shell-outs are scheduled for their own follow-up slices. Replaces the deleted `scripts/session_tui*.py` ANSI/box-drawing renderer.
- `tools/emit_queue_lib.ts` + `tools/emit_queue_cli.ts` — canonical TS producer for the durable insights queue. Surface: `makeEvent`, `enqueue` (with ADR-0014 source-specific dedupe formulas), `validate`, `pendingCount`, `deadLetterCount`, `health`, `recordContextPct`, `initSchema`. CLI subcommands: `--health`, `--init-schema`, `record-context-pct`, `pending-count`, `dead-letter-count`, `enqueue --type T --payload JSON [...]`. Writes to `~/.stark-insights/queue.db` (`STARK_QUEUE_DIR` env honored). Python consumers reach the queue through `scripts/_emit.py`, a thin subprocess shim around the `enqueue` subcommand. The drain side lives in stark-insights.
- `tools/github_app_lib.ts` + `tools/github_app.ts` — GitHub App auth (sole implementation; the parallel Python module `scripts/github_app.py` was deleted on 2026-05-19). Mints installation tokens via `node:crypto` RS256 JWT signing (no npm deps), reads private keys from macOS Keychain via `security find-generic-password` with STARK_* env-var fallback for CI and GH_TOKEN fallback last. On-disk token + installation caches under `~/.cache/github-app-tokens/` (same JSON shape the Python wrote, 0600 perms, 5-minute early expiry). Surface includes REST helpers (`apiGet/Post/Put/Patch/Delete`), `graphql()` with single-retry on transient connection errors, and per-owner installation-ID discovery. CLI subcommands: `token`, `repo`, `pr {list|view|create|review|merge|comment}`, `issue {list|create}`. Consumers: every SKILL.md bash snippet that needs a GH App token (swept on 2026-05-18) plus the remaining Python orchestrators (`scripts/runtime_env.py`, `scripts/multi_review.py`) which shell out via `node --experimental-strip-types tools/github_app.ts ... token`.
- `tools/github_projects_lib.ts` + `tools/github_projects.ts` — GitHub Projects V2 GraphQL operations (parallel TS implementation of the deleted `scripts/github_projects.py`). All GraphQL goes through `tools/github_app_lib.ts::graphql()` so per-app auth + retry-once is inherited. Surface: `findProject`, `addIssueToProject`, `getFieldIds` (per-project field-id cache, lazy), `setField` / `setFields` (100ms throttle between mutations, matches the Python), `getItemFields`, `getItems` (paginated 100/page + client-side `itemMatchesFilters` for top-level + field-bag keys), `findItemForIssue`, `getIssueNodeId`, `isLegalTransition` + `LEGAL_TRANSITIONS` state graph, `transitionStatus` (idempotent no-op when already in target; throws on illegal transition with the allowed-set in the message), `checkSpecCompleteness` (Risk + AI Suitability gates, plus Spec Approval gate for high-risk items), `loadProjectConfig`. CLI ships 12 subcommands mirroring the Python's surface — JSON-first output for `jq` pipelines. The Python module + its tests were deleted as part of this slice (no Python orchestrator imported them; only test files did).
- `tools/preflight_lib.ts` + `tools/preflight.ts` — pre-flight environment validator (replaces the deleted `scripts/preflight.py`). All 14 checks ported with identical statuses (verified by check-by-check JSON diff against the Python on `stark-review` workflow). Same `overall ∈ {ready, degraded, blocked}` aggregation, same critical-vs-non-critical escalation rules, same `~/.claude/code-review/preflight.jsonl` append, same `preflight_check` event emitted to the durable queue (via `emit_queue_lib.ts`, `source: "skill"`). CLI: `--workflow NAME --json --skip-check NAME...`. Pure logic (`aggregateOverall`, `resolveOpenaiApiKey`, `checkCostHardStop`, `checkDeprecatedConfig`, `checkStaleLocks`, `renderTable`) is exported for unit testing; network-touching paths (`checkGithubApp`) and binary-dependent ones (`checkCliClaude` / keychain checks) exercised live.
- `tools/stark_config_lib.ts` — minimal config-loader subset for preflight (NOT a full port of `scripts/config_loader.py`, which stays in place for ~10 Python orchestrators). Reads `~/.claude/code-review/config.json` with deep-merge against built-in DEFAULT_MODELS / DEFAULT_RED_TEAM / DEFAULT_MODEL_RATES. `getRedTeamConfig()` walks repo/org `.code-review/config.json` overrides with the same two-layer defense as the Python: dotted-path locked fields (`personas`, `model`, `enabled`, `agent`, `min_severity_to_block`, `halt_on_unresolved`, `allow_human_review_halt`, `stages`, all `fix_plan.*`, `audit.retain_full_text`, `audit.excerpt_max_chars`) are rejected with a stderr warning and a `red_team_override_rejected` queue event; non-dict overrides at a locked parent path (e.g. `fix_plan: "off"`) are rejected wholesale to prevent subtree replacement; unknown top-level keys are pruned with a warning. `discoverConfig` is a minimal hierarchical merge that only consumes `cfg.agents` (preflight's only need).
- `tools/lock_helpers_lib.ts` — single-function port of `scripts/lock_helpers.py::is_lock_stale`. Same on-disk JSON contract (`{pid, start_time, timestamp, ttl_minutes, ...}`), same staleness rules (malformed timestamp / TTL exceeded / non-integer pid / `kill(pid, 0)` ESRCH / `ps -o lstart=` start-time mismatch → stale). The full Python lock_helpers (acquire/release/force + audit log) stays for the orchestrators that hold real locks.
- `tools/skill_lib.ts` — shared skill discovery + reference parsing
- `tools/skill_audit.ts`, `skill_validate.ts`, `skill_optimize.ts`, `skill_autopilot.ts` — meta-tooling
- `tools/skill_diet.ts` — duplication linter for shared boilerplate (preflight, dispatch-failure, GH App auth)
- `tools/skill_smoke_test.test.ts` — runs on every `npm test`. Walks every `skill/stark-*/SKILL.md`, asserts frontmatter parses + `name:` matches dir name + every in-repo `tools/*.ts` and `scripts/*.py` reference resolves + every distinct TS CLI mentioned by any skill exits cleanly on `--help`. Cross-repo references (e.g. `~/Code/Playground/stark-insights/...`) are filtered by an explicit `CROSS_REPO_PREFIXES` allowlist; add to that list if a skill ever points at another sibling repo.
- `tools/release_changelog.ts`, `release_version_bump.ts` — stark-release Steps 3 + 5
- `tools/review_setup_worktree.ts`, `review_cleanup_worktree.ts` — stark-review worktree provisioning
- `tools/housekeeping_infra.ts` — stark-housekeeping Phase 5 (sessions, locks, log rotation, archival)
- `tools/design_review_summary.ts` — legacy stark-review-design Phase 4 markdown renderer (kept for the Python `plan_review_dispatch.py` consumers)
- `tools/copilot_dispatch.ts` — stark-copilot lead/wing dispatcher (replaces former `scripts/copilot_dispatch.py`). Also the canonical home for shared agent-dispatch primitives now imported by `plan_dispatch.ts` (`run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`, plus the verdict parsers).
- `tools/plan_dispatch.ts` — `/stark-design-to-plan` lead/wing dispatcher. Round 1: lead reads design doc + agent-specific `generate.md`, emits a plan markdown draft. Wing reviews via agent-specific `review.md`, returns `{verdict, blocking_findings[], non_blocking_suggestions[], summary}` JSON. On `revise`, lead receives prior draft + findings + `revise.md` template, emits a new draft. Loops until `approve`, `block`, `--max-rounds` exhaustion, empty-draft, or unchanged-from-prior revision. No worktree (plans are text). Reuses copilot_dispatch.ts's helpers; replaces the deleted `scripts/design_to_plan_dispatch.py` (3-agent tournament + cross-review). Same final-verdict union + JSON output shape as copilot.
- `tools/stark_review_doc.ts` + `stark_review_doc_lib.ts` — lead/wing doc-review dispatcher used by `/stark-review-design` and `/stark-review-plan`. Codex (xhigh) reviews per-domain in parallel; Claude (opus-4-7) wing emits JSON patches that the host applies with unique-match validation. Replaces the Python `plan_review_dispatch.py` for these two skills (the Python remains for `triage_orchestrator.py` and `plan_to_tasks_validate.py`).
- `tools/stark_persona_lib.ts` + `tools/stark_persona.ts` — pure-TypeScript implementation of `/stark-persona` (replaces the deleted `scripts/stark_persona.py`). Library covers the full surface (PersonaRecord + roster parse, active.json read/write/delete, `computeWeight`, `getDateMatches`, `fuzzyMatchPersona`, `initDb` + schema, `syncWeights`, `selectSinglePersona`, `selectCombo`, `recordRating` with combo dilution, `recordSurveyAnswer`, `addPersona` with sanitization, `makeRandom` Mulberry32, `SURVEY_POOL`). Insights events go straight to `~/.stark-insights/queue.db` via `tools/emit_queue_lib.ts` (no `_emit.py` shim) under the `persona_event` type. CLI ships 11 subcommands: `select` / `deactivate` / `rate` / `survey` / `survey-answer` / `add` / `stats` / `history` / `print-roster` / `print-weights` / `session-end`. `/stark-session` start/end call it via `node --experimental-strip-types tools/stark_persona.ts …`.
- `tools/session_id_lib.ts` + `tools/session_id.ts` — pure-TypeScript session ID resolver (replaces the deleted `scripts/session_id.py`). Three-tier resolver: `CLAUDE_SESSION_ID` env > `~/.claude/projects/` newest-mtime marker scan > uuid4. Consumed by `tools/emit_queue_lib.ts`, `tools/session_state_lib.ts`, and `tools/context_compactor_lib.ts`.
- `tools/session_state_lib.ts` + `tools/session_state.ts` — pure-TypeScript session state machine (replaces the deleted `scripts/session_state.py`). Same on-disk JSON shape under `~/.claude/code-review/sessions/{sanitized-id}.json`, same path-traversal sanitization, same git-derived defaults + GitHub URL normalizer. CLI: `[--session-id ID] [--json]` (Python parity) plus `set --field <name|start_head|last_checkpoint> --value VAL` for the SKILL.md Phase 3 / Phase 6 mutators.
- `tools/self_healer_lib.ts` + `tools/self_healer.ts` — pattern-based auto-fixer (replaces the deleted `scripts/self_healer.py`). Given a stderr capture and a pattern id, walks the gate ladder (guard → max_per_session → auto-mode allowlist → circuit breaker → suggest/auto branch → execute → record outcome → emit alert on critical transitions). Same gates + same on-disk file shapes as the Python; CLI surface unchanged. Atomic writes for session + circuit state. Direct emit through `tools/emit_queue_lib.ts` (`heal_attempt`) and `tools/alert_delivery_lib.ts` — no `_emit.py` shim, no Python `alert_delivery` import. Consumed by `skill/stark-phase-execute/SKILL.md` via subprocess.
- `tools/healer_canary_lib.ts` + `tools/healer_canary.ts` — canary rollout for `self_healer` patterns (replaces the deleted `scripts/healer_canary.py`). Decides when a `suggest`-mode pattern has earned its way to `auto`-mode by reading the on-disk performance log + circuit-breaker state. CLI: `--status` (Python parity) + three new subcommands beyond the port: `--check` (exits 2 for oncall paging if any auto-mode pattern's circuit is open), `--close-circuit PATTERN_ID` (manual recovery), `--explain PATTERN_ID` (audit trail). Atomic config writes (the Python's `_write_config` was naive RMW). Configurable promotion gate via `config.self_heal.{min_successful_suggests, abort_window_days, circuit_open_hours}`. Emits `healer_canary` events to the insights queue on every lifecycle transition.
- `tools/skill_router_lib.ts` + `tools/skill_router.ts` — pure-TS contextual skill suggestions (replaces the deleted `scripts/skill_router.py`). Maps `context ∈ {review, implementation, session, debug}` to skill candidates, skips suppressed + recently-used ones, ranks by `relevance + age` score, caps at `max_suggestions`. Inline `skill_activation` config loader. Emits `skill_suggestion` events directly via `tools/emit_queue_lib.ts` (no `_emit.py` shim). Consumed by `/stark-session` collector + `stark-phase-execute` end hook.
- `tools/alert_delivery_lib.ts` + `tools/alert_delivery.ts` — pure-TS alert emission + check (replaces the deleted `scripts/alert_delivery.py`). On-disk contract unchanged: `~/.claude/code-review/alerts.jsonl` + `alert-{ts}.marker` files in the same dir, same-second collision counter. Consumed in-process by `tools/self_healer_lib.ts`; CLI (`--check [--json]`) consumed by the `/stark-session` collector.
- `tools/context_compactor_lib.ts` + `tools/context_compactor.ts` — pure-TypeScript session-checkpoint generator (replaces the deleted `scripts/context_compactor.py`). Writes `checkpoint-{ts}.md` under `sessions/{sid}/`, updates `session_state.last_checkpoint`, honors `max_checkpoint_size_kb` truncation cap. Loads the `context_compaction` config section inline (no `config_loader.py` dependency). CLI parity preserved (`[--session-id ID] [--json]`). Consumed by `/stark-session` Phase 3b plus stark-copilot and stark-phase-execute end hooks.
- `tools/optimize_skill_description.ts` — skill-description optimizer (replaces the deleted `scripts/optimize_skill_description.py`). Pure helpers (`parseSkillDescription`, `buildImprovePrompt`, `buildCleanEnv`) are unit-tested; scoring still shells out to the skill-creator plugin's Python `run_eval.py` (not owned by this repo), then `proposeImprovement` calls `claude -p` with the failing-query feedback. CLI preserves the Python's flag surface and JSON report shape — operators run it manually, no automation depends on it.

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain PR review prompts (9 domains each)
- `global/prompts/{design-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/{design-to-plan,prompt-to-design}/` — per-agent generate + cross-review prompts
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
- `/stark-design-to-plan <path>` — generate implementation plan from design doc via paired lead/wing loop (default lead `claude`, wing `codex`); lead drafts, wing reviews and emits JSON verdict, fix-loop until approved. Cheaper and lower-variance than the prior 3-agent tournament.
- `/stark-review-plan <path>` — lead/wing execution plan review: codex (xhigh) reviews 4 adversarial domains (`completeness`, `security`, `sequencing`, `viability`), claude wing applies JSON patches. Same TS dispatcher as design review (`tools/stark_review_doc.ts --prompts-dir plan-review`).
- `/stark-red-team-plan <path> [--source-spec PATH] [--model ID] [--dry-run]` — adversarial committee challenge of an execution plan (5 personas × 1 round, default `gpt-5.5-pro`); writes `<plan>.red-team.md` sidecar and posts to PR if detected; challenge-only, no fix loop
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents (default lead `claude`, wing `codex`); lead implements in worktree, wing reviews diff, fix-loop until approved. Issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`.
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
