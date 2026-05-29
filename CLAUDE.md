# CLAUDE.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude and Codex are enabled by default; Gemini is disabled (opt-in via `models.gemini.enabled`). Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Language preference:** Go for backend, TypeScript for scripts. **Avoid Python at all costs** — the repo's tooling is now TypeScript-only (`tools/`); the former Python orchestrators + dispatch infra under `scripts/` were migrated out. Do not introduce new Python.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Always update documentation.** Any change that affects behavior, structure, commands, env vars, or operations must update the relevant docs (this file and `AGENTS.md` included) in the same change.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — shell helpers + JSON schemas (`register_triggers.sh`, `skill-telemetry.sh`, `event_schema.json`, `healer_patterns.json`); installed to `~/.claude/code-review/scripts/`. The orchestrator + dispatch infra were migrated to `tools/` (TypeScript) — see the Python→TS migration spec.
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 17 skills), installed as symlinks to `~/.claude/skills/`
- `org/evinced/` — Evinced org config, installed to `~/Code/.code-review/`
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `automation/` — CCR automation fleet: 12 triggers, prompts, logs, cost tracking, reports
- `.github/workflows/` — GitHub Actions: project sync, gate checks, stale detection, heartbeat
- `docs/` — specs, plans, ADRs, retrospectives, generated skill docs
- `standards/` — org-wide doc templates and workflows, installed to `~/.claude/code-review/standards/`
- `install.sh` — symlinks repo contents to install locations

## Key Files

### Dispatchers & orchestration
- `tools/dispatcher_base_lib.ts` — shared dispatch base: hierarchical review-config discovery, model resolution, agent registry, domain/prompt resolution
- `tools/multi_review.ts` + `multi_review_lib.ts` — PR review orchestrator (parallel agent×domain sub-agent dispatch, findings dedup, history persistence, GitHub posting)
- `tools/plan_review_dispatch.ts` + `plan_review_dispatch_lib.ts` — plan/spec document review dispatch (N agents × M domains, bounded 21-worker pool)

### Agent utilities
- `tools/claude_utils_lib.ts` — Claude CLI dispatch helpers (clean env via `runtime_env_lib`, headless command builder, model pinning)
- `tools/codex_utils_lib.ts` — Codex CLI dispatch helpers (JSONL parsing, reasoning-effort config)
- `tools/gemini_utils_lib.ts` — Gemini CLI dispatch helpers (isolated `GEMINI_CLI_HOME`, Vertex-AI env, API-key fallback, JSON output parsing)
- `tools/agent_disabled_error.ts` — shared `AgentDisabledError` raised when an agent is config-disabled

### Infrastructure
- `tools/stark_config_lib.ts` — full config reader (DEFAULT_* sections, per-section accessors, deep merge, red_team locked-field enforcement) — see TS tools section
- `tools/runtime_env_lib.ts` — isolated subprocess env builder (allowlist, GitHub App token injection, process-scoped temp dirs)
- GitHub App auth lives entirely in `tools/github_app{,_lib}.ts` (TS) — mints installation tokens, imported directly by `runtime_env_lib.ts`.
- `tools/emit_queue_lib.ts` + `tools/emit_queue_cli.ts` — SQLite-backed durable event queue (producer side). The drain side lives in stark-insights.

### Observability stack
- `tools/observability_paths_lib.ts` — canonical path helpers + `ensureRoot()` / `ensurePrivateDir()` / `openPrivate()`. Every writer in the observability stack goes through this module so files land at 0600 and dirs at 0700 regardless of the caller's umask. `writerSocketPath(runId)` returns a path under `os.tmpdir()/stark-obs/` (FNV-1a hash of run id) to dodge macOS's 104-byte `sun_path` cap; `writer.pid` and `writer.cap` stay in the per-run dir.
- `tools/observability_hostinfo.ts` — host-side ticker (launchd-managed) that writes `~/.claude/code-review/observability/hostinfo/host.json` every 5 s. **Sole** host-introspection surface — macOS Docker Desktop does not expose `/proc` to containers.
- `tools/observability_install_launchd.ts` — generator for the hostinfo + prune launchd plists. Sets `PATH` portably so `/usr/bin/env node` resolves on both `/opt/homebrew/bin` (Apple Silicon Homebrew) and `/usr/local/bin` (Intel Homebrew / manual installs).
- `tools/observability_redact_lib.ts` — secret redaction. `redact(text)` for one-shot strings, `createStreamRedactor()` for chunked stdout/stderr with overlap buffer (length = longest pattern's `maxLen`), `redactJson(value)` recursive (depth cap 32, per-string cap 1 MiB). Length-preserving (`<REDACTED:NAME>` padded with `*`). Built-in patterns: JWT, ghp_/ghs_/gho_/ghu_/ghr_, sk-ant-, sk-, AKIA, Authorization: Bearer. Operator overrides via `OBSERVABILITY_REDACT_EXTRA_ENV` (literal env-var values) + `~/.claude/code-review/observability/redactors.json` (additional regexes). Disable per-pattern via `OBSERVABILITY_REDACT_DISABLE_PATTERNS` (CSV).
- `tools/observability_writer_daemon.ts` — per-run writer daemon (one process per active run). Owns the writer queue (Promise-chain FIFO, monotonic seq), rotation (`OBSERVABILITY_MAX_FILE_BYTES`, default 100 MB), byte budget (`OBSERVABILITY_PER_RUN_MAX_MB`, default 2 GiB, emits single `chunk-budget-exceeded` marker), run-heartbeat timer (10 s, internal), tracked-parent-pid poll (30 s — on ESRCH writes `run_end {status:"crashed", crashed_reason:"parent_exit"}` + meta.json rewrite + sock/pid cleanup), per-`(subagent_id, stream)` `StreamRedactor` flush-on-end, durability tiers per RT5 (lifecycle + findings + redacted=true → fsync each write; chunks + non-finding progress + heartbeats → group-commit every 50 events or 100 ms). UDS at `tmpdir/stark-obs/<hash>.sock` (mode 0600); first frame is `{op:"hello", cap}` against `writer.cap` (random 32-byte b64url) — same-UID without cap is rejected.
- `tools/observability_emit_lib.ts` — thin emit-lib client. `startRun()` spawns the daemon (`spawn(..., { detached: true, stdio: 'ignore' })` + `child.unref()`), awaits the readiness handshake (socket bound → cap fsynced → initial `run_start` + `run_heartbeat` committed → `ping` replies with all three `*_committed: true`), returns a `RunCtx`. `connectRun(runId)` for child dispatchers when `STARK_OBS_PARENT_RUN_ID` is set. Public surface: `startSubAgent`, `endSubAgent`, `emitProgress`, `attachChild` (returns `{drain}` — drain awaits every UDS-write ack so `endSubAgent` doesn't race the last hundreds of ms of output, E2), `startHeartbeat`, `startRunHeartbeat` (no-op on non-owned ctxs; daemon owns the actual timer), `endRun` (awaits daemon flush + fsync + meta rewrite + sock cleanup before returning). Disabled state: `OBSERVABILITY_DISABLED=1` env + low-disk + mkdir/spawn/handshake failures all yield a stub `RunCtx` whose methods are silent no-ops so dispatcher call sites run unchanged.
- `tools/observability_emit_harness.ts` — synthetic dispatcher harness used by Phase 2 verification + integration tests. `--multi-process` mode starts a run, then spawns a second node process that `connectRun`s into the same daemon — confirms strictly monotonic seq across two writers sharing the daemon.
- `tools/observability_server/` — Dockerized server (multi-stage `node:22-alpine`, `better-sqlite3` + `fastify`). `server/bind.ts` enforces the loopback-vs-LAN bind gates; `server/db.ts` + `migrations/001_init.sql` define the SQLite index. Liveness reads only `/hostinfo/host.json` — see `tools/observability_server/CLAUDE.md`.
- `tools/observability_server/test/load.ts` + `load_report.ts` — Phase 8 load harness. Spawns the in-process server pointed at a tmpdir spool, runs N synthetic sub-agents through the emit harness, attaches M WS subscribers + a 5 s history-query loop, and asserts WS p95 < 2 s, SSFB p95 < 2 s, UDS RTT p95 < 5 ms, commit p95 < 50 ms, memory growth < 50 MB/h. `--spec` switches to the plan-spec profile (N=27, 600 s, 10 KB/s, 2 ws). Reads `/api/health.index_writer.commit_ms_p50/p95` (added on this branch) for the SQLite commit assertion.
- `tools/observability_server/test/failure_paths.test.ts` — Phase 8 failure-path suite. Forces malformed JSONL, deleted spool file mid-tail, parse storm (≥10k bad lines), SQLite commit failure (`error` event), dispatcher SIGKILL, server crash between retention-notify Call A and Call B (`recoverPendingRewrites` finishes forward), and base64 chunk truncation. `node:test` runner (not Vitest — TS-test convention).
- `tools/observability_server/test/live/` — operator-driven Phase 8 live tests (Tasks 3–8): `dispatcher_sigkill.sh` (daemon-written crashed path ≤ 60 s), `dispatcher_and_daemon_sigkill.sh` (sweeper-written ≤ 90 s + 20-tick idempotency), `host_boot_id_change.ts`, `pressure_retention.sh` (mitmproxy notify-schema capture + Keychain Bearer match), `lan_bootstrap.sh` (five-step loopback→LAN dance), `live_run_metadata.ts` (standalone fallback writer for `~/.claude/code-review/observability/test/live-run.json` — primary path is launching the dispatcher under test with `STARK_OBS_WRITE_LIVE_RUN_METADATA=1`, which makes every TS dispatcher built on `observability_dispatcher_helpers.ts::initRunCtx` write the same file natively with the real dispatcher pid, writer pid, and run id, so destructive scripts never need `pgrep`/`tail`).

### TUI & session
- The session-start/end TUI is gone. `/stark-session` now collects state via `tools/stark_session.ts` and Claude renders the briefing/summary itself — see "TS tools" below.

### Red-team subsystem
The red-team subsystem is **pure TypeScript** under `tools/`. All Python red-team modules + CLIs were deleted by end of the 2026-05-16 migration. The Responses-API model allowlist + key resolver previously in `scripts/openai_responses.py` are now inlined into `tools/preflight_lib.ts::checkRedTeamTransportAuth` (its only consumer; was `preflight.py` before the TS port).

### Other
- `tools/plan_to_tasks_validate.ts` + `plan_to_tasks_validate_lib.ts` — plan decomposition validation (parallel codex/gemini validators)

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
- `tools/emit_queue_lib.ts` + `tools/emit_queue_cli.ts` — canonical TS producer for the durable insights queue. Surface: `makeEvent`, `enqueue` (with ADR-0014 source-specific dedupe formulas), `validate`, `pendingCount`, `deadLetterCount`, `health`, `recordContextPct`, `initSchema`. CLI subcommands: `--health`, `--init-schema`, `record-context-pct`, `pending-count`, `dead-letter-count`, `enqueue --type T --payload JSON [...]`. Writes to `~/.stark-insights/queue.db` (`STARK_QUEUE_DIR` env honored). All producers are TypeScript and import `enqueue`/`makeEvent` directly. The drain side lives in stark-insights.
- `tools/github_app_lib.ts` + `tools/github_app.ts` — GitHub App auth (sole implementation; the parallel Python module `scripts/github_app.py` was deleted on 2026-05-19). Mints installation tokens via `node:crypto` RS256 JWT signing (no npm deps), reads private keys from macOS Keychain via `security find-generic-password` with STARK_* env-var fallback for CI and GH_TOKEN fallback last. On-disk token + installation caches under `~/.cache/github-app-tokens/` (same JSON shape the Python wrote, 0600 perms, 5-minute early expiry). Surface includes REST helpers (`apiGet/Post/Put/Patch/Delete`), `graphql()` with single-retry on transient connection errors, and per-owner installation-ID discovery. CLI subcommands: `token`, `repo`, `pr {list|view|create|review|merge|comment}`, `issue {list|create}`. Consumers: every SKILL.md bash snippet that needs a GH App token (swept on 2026-05-18) plus `tools/runtime_env_lib.ts`, which imports `getToken` directly.
- `tools/github_projects_lib.ts` + `tools/github_projects.ts` — GitHub Projects V2 GraphQL operations (parallel TS implementation of the deleted `scripts/github_projects.py`). All GraphQL goes through `tools/github_app_lib.ts::graphql()` so per-app auth + retry-once is inherited. Surface: `findProject`, `addIssueToProject`, `getFieldIds` (per-project field-id cache, lazy), `setField` / `setFields` (100ms throttle between mutations, matches the Python), `getItemFields`, `getItems` (paginated 100/page + client-side `itemMatchesFilters` for top-level + field-bag keys), `findItemForIssue`, `getIssueNodeId`, `isLegalTransition` + `LEGAL_TRANSITIONS` state graph, `transitionStatus` (idempotent no-op when already in target; throws on illegal transition with the allowed-set in the message), `checkSpecCompleteness` (Risk + AI Suitability gates, plus Spec Approval gate for high-risk items), `loadProjectConfig`. CLI ships 12 subcommands mirroring the Python's surface — JSON-first output for `jq` pipelines. The Python module + its tests were deleted as part of this slice (no Python orchestrator imported them; only test files did).
- `tools/preflight_lib.ts` + `tools/preflight.ts` — pre-flight environment validator (replaces the deleted `scripts/preflight.py`). All 14 checks ported with identical statuses (verified by check-by-check JSON diff against the Python on `stark-review` workflow). Same `overall ∈ {ready, degraded, blocked}` aggregation, same critical-vs-non-critical escalation rules, same `~/.claude/code-review/preflight.jsonl` append, same `preflight_check` event emitted to the durable queue (via `emit_queue_lib.ts`, `source: "skill"`). CLI: `--workflow NAME --json --skip-check NAME...`. Pure logic (`aggregateOverall`, `resolveOpenaiApiKey`, `checkCostHardStop`, `checkDeprecatedConfig`, `checkStaleLocks`, `renderTable`) is exported for unit testing; network-touching paths (`checkGithubApp`) and binary-dependent ones (`checkCliClaude` / keychain checks) exercised live.
- `tools/stark_config_lib.ts` — full TS port of the former `scripts/config_loader.py` (Python→TS migration); now the sole config implementation. Reads `~/.claude/code-review/config.json` with deep-merge against built-in DEFAULT_* sections (MODELS, RUNTIME, SELF_HEAL, VALIDATION_GATE, SKILL_ACTIVATION, CONTEXT_COMPACTION, COST, FORGE, FORGED_REVIEW, RED_TEAM, MODEL_RATES) and exposes a section accessor per section plus `getModelId` / `isAgentEnabled`. `getRedTeamConfig()` walks repo/org `.code-review/config.json` overrides with the same two-layer defense as the Python: dotted-path locked fields (`personas`, `model`, `enabled`, `agent`, `min_severity_to_block`, `halt_on_unresolved`, `allow_human_review_halt`, `stages`, all `fix_plan.*`, `audit.retain_full_text`, `audit.excerpt_max_chars`) are rejected with a stderr warning and a `red_team_override_rejected` queue event; non-dict overrides at a locked parent path (e.g. `fix_plan: "off"`) are rejected wholesale to prevent subtree replacement; unknown top-level keys are pruned with a warning. `discoverConfig` is a minimal hierarchical merge that only consumes `cfg.agents` (preflight's only need).
- `tools/lock_helpers_lib.ts` — lock-file staleness helper (`isLockStale`). Same on-disk JSON contract (`{pid, start_time, timestamp, ttl_minutes, ...}`) and staleness rules (malformed timestamp / TTL exceeded / non-integer pid / `kill(pid, 0)` ESRCH / `ps -o lstart=` start-time mismatch → stale). The former `scripts/lock_helpers.py` was deleted on 2026-05-20 — no Python orchestrator imported it.
- `tools/skill_lib.ts` — shared skill discovery + reference parsing
- `tools/skill_audit.ts`, `skill_validate.ts`, `skill_optimize.ts`, `skill_autopilot.ts` — meta-tooling
- `tools/skill_diet.ts` — duplication linter for shared boilerplate (preflight, dispatch-failure, GH App auth)
- `tools/skill_smoke_test.test.ts` — runs on every `npm test`. Walks every `skill/stark-*/SKILL.md`, asserts frontmatter parses + `name:` matches dir name + every in-repo `tools/*.ts` and `scripts/*.py` reference resolves + every distinct TS CLI mentioned by any skill exits cleanly on `--help`. Cross-repo references (e.g. `~/Code/Playground/stark-insights/...`) are filtered by an explicit `CROSS_REPO_PREFIXES` allowlist; add to that list if a skill ever points at another sibling repo.
- `tools/release_changelog.ts`, `release_version_bump.ts` — stark-release Steps 3 + 5
- `tools/review_setup_worktree.ts`, `review_cleanup_worktree.ts` — stark-review worktree provisioning
- `tools/housekeeping_infra.ts` — stark-housekeeping Phase 5 (sessions, locks, log rotation, archival)
- `tools/design_review_summary.ts` — legacy stark-review-design Phase 4 markdown renderer
- `tools/copilot_dispatch.ts` — stark-copilot lead/wing dispatcher (replaces former `scripts/copilot_dispatch.py`). Also the canonical home for shared agent-dispatch primitives now imported by `plan_dispatch.ts` (`run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`, plus the verdict parsers).
- `tools/plan_dispatch.ts` — `/stark-design-to-plan` lead/wing dispatcher. Round 1: lead reads design doc + agent-specific `generate.md`, emits a plan markdown draft. Wing reviews via agent-specific `review.md`, returns `{verdict, blocking_findings[], non_blocking_suggestions[], summary}` JSON. On `revise`, lead receives prior draft + findings + `revise.md` template, emits a new draft. Loops until `approve`, `block`, `--max-rounds` exhaustion, empty-draft, or unchanged-from-prior revision. No worktree (plans are text). Reuses copilot_dispatch.ts's helpers; replaces the deleted `scripts/design_to_plan_dispatch.py` (3-agent tournament + cross-review). Same final-verdict union + JSON output shape as copilot.
- `tools/stark_review_doc.ts` + `stark_review_doc_lib.ts` — lead/wing doc-review dispatcher used by `/stark-review-design` and `/stark-review-plan`. Codex (xhigh) reviews per-domain in parallel; Claude (opus-4-8) wing emits JSON patches that the host applies with unique-match validation. Replaces the former Python `plan_review_dispatch.py` for these two skills.
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

- `/stark-review-design <path>` — lead/wing design/spec review: codex (gpt-5.5, xhigh) reviews 8 domains in parallel (cap 3 concurrent), claude (opus-4-8) wing applies JSON patches. Multi-round fix loop with per-round git commit; final review-only round captures unresolved. Tournament mode removed in the TS port. Delegates to `tools/stark_review_doc.ts`.
- `/stark-red-team-design <path> [--source-spec PATH] [--model ID] [--dry-run]` — adversarial committee challenge of a design doc (5 personas × 1 round, default `gpt-5.5-pro`); writes `<design>.red-team.md` sidecar and posts to PR if detected; challenge-only, no fix loop
- `/stark-design-to-plan <path>` — generate implementation plan from design doc via paired lead/wing loop (default lead `claude`, wing `codex`); lead drafts, wing reviews and emits JSON verdict, fix-loop until approved. Cheaper and lower-variance than the prior 3-agent tournament.
- `/stark-review-plan <path>` — lead/wing execution plan review: codex (xhigh) reviews 4 adversarial domains (`completeness`, `security`, `sequencing`, `viability`), claude wing applies JSON patches. Same TS dispatcher as design review (`tools/stark_review_doc.ts --prompts-dir plan-review`).
- `/stark-red-team-plan <path> [--source-spec PATH] [--model ID] [--dry-run]` — adversarial committee challenge of an execution plan (5 personas × 1 round, default `gpt-5.5-pro`); writes `<plan>.red-team.md` sidecar and posts to PR if detected; challenge-only, no fix loop
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents (default lead `claude`, wing `codex`); lead implements in worktree, wing reviews diff, fix-loop until approved. Issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`.
- `/stark-gh:pr-merge [--pr N] [...]` — rebase + draft squash prose & CHANGELOG entry via Codex + force-push + squash-merge once CI is green
- `/stark-gh:cleanup [--pr N] [--dry-run] [--keep-branch NAME] [--no-rebase] [--no-watcher-cleanup] [--no-config] [--no-gc] [--drop-stale-stashes] [--force] [--json]` — sweep merged/stale branches (local + remote), prune tracking refs, remove worktree leftovers (including detached-HEAD `review-*-prN-*` worktrees for done PRs), clean merged-PR watcher state, surface stale stashes, `git gc` loose objects, and rebase current branch onto upstream so history stays linear. `--pr N` narrows to one PR's head ref + watcher state.
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × 9 domains, fast/cheap)
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or design/plan review)
- `/stark-review-design-improvement` — improve design review prompts (wraps /stark-review-improvement with --prompts-dir design-review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback
- `/stark-gh-user [show|primary|secondary|swap|limits]` — switch GitHub user identity for `gh` calls (rate-limit relief); tokens in macOS Keychain (service `stark-gh-token`); resolver = `tools/user_token.ts`

### Project Setup & Docs

- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs

## Stark Review Observability

### Start

```bash
docker compose -f tools/observability_server/docker-compose.yml up -d
node --experimental-strip-types tools/observability_open.ts
```

`observability_open.ts` runs the bootstrap exchange against the running container, populates `~/.claude/code-review/observability/session.cookie` (0600), mirrors the bootstrap + prune tokens into the macOS Keychain as **two scoped services** (`stark-observability-bootstrap-token` for the UI/main-API Bearer; `stark-observability-prune-token` for the retention listener only), atomically writes `/data/last_bootstrap_at` so subsequent LAN binds are authorized, and opens the UI in the browser unless `--no-browser` is passed. The helper **never prints the raw token** — scripts read from the cookie file or via `security find-generic-password -s <scoped-service> -w`.

### Spool + prune

- Spool root: `~/.claude/code-review/observability/runs/<run_id>/events-NNNN.jsonl`.
- Audit log mount: `~/.claude/code-review/observability/audit/audit.jsonl` (separate volume from `observability_index`, survives DB reset).
- Prune CLI: `node --experimental-strip-types tools/observability_prune.ts`. Reads ONLY the `stark-observability-prune-token` Keychain entry; talks to the retention listener on port 7701, never the main API.

### Liveness contract

The container reads only `/hostinfo/host.json` — there is no `/proc` mount on macOS Docker Desktop. The launchd-managed host ticker (`tools/observability_hostinfo.ts`) refreshes the file every 5 s. The container's liveness sweeper joins on `host.live_pids[]` to decide whether a `running` row is actually alive.

### Crashed-state contract

`runs.parent_pid` is always the **tracked-parent pid** (= dispatcher Node pid for normal dispatchers, = SKILL.md shell pid for `/stark-phase-execute`) — never the writer daemon pid. The daemon pid is `runs.writer_daemon_pid`, diagnostic only. Crash detection runs in two redundant writers, exactly one wins per row:

- **Daemon-written** path (≤ 60 s): the per-run writer daemon polls `kill(parent_pid, 0)` every 30 s; on ESRCH it writes `run_end {status: "crashed", crashed_reason: "parent_exit", ended_at: <ISO ms>}`, rewrites `meta.json`, cleans up its socket + pid, exits 0.
- **Sweeper-written** path (≤ 90 s, fallback for when the daemon is also dead): the container's liveness sweep marks rows whose `parent_pid` is missing from `host.live_pids[]` as crashed via a `status NOT IN (terminal)` UPDATE, with the same TS-bound `ended_at`.

Every `ended_at` and `last_heartbeat_at` value is server-bound `new Date().toISOString()`. SQLite-native clock functions (`strftime`, `datetime('now',...)`) are forbidden — `tools/observability_server/server/grep_assertions.test.ts` enforces this in CI.

### Retention notify protocol

The prune CLI emits **two strictly-ordered calls** per rewritten file to `POST /api/internal/retention/notify` on the retention listener:

1. `action: "pre-rename"` — carries `new_size_bytes` + `truncated[]`; sent BEFORE `rename(2)`; never carries `new_mtime_ns`.
2. `action: "update-mtime"` — carries `new_mtime_ns` (plus identifying keys); sent AFTER the rename + `fstat`; never carries `truncated[]` or `new_size_bytes`.

A failed rename triggers `action: "abort-rewrite"`. SQLite is the sole rewrite transaction log — on server restart, `recoverPendingRewrites` walks `spool_files WHERE rewrite_state IN ('pending','renamed')` and finishes whichever transition the on-disk file matches.

### Writer daemon: one-per-run

Each dispatcher run gets its own writer daemon process. Dispatchers connect via the per-run UDS `tmpdir/stark-obs/<hash>.sock` (mode 0600, short-prefix to dodge macOS's 104-byte `sun_path` cap), present a single-use ephemeral capability minted from `writer.cap` (same-UID + filesystem access = proof of authority), and emit ops over the framed JSONL protocol. Child dispatchers (`STARK_OBS_PARENT_RUN_ID` set) reuse the parent's daemon via `connectRun` rather than spawning their own.

### LAN bootstrap

LAN exposure requires all three of:

1. `OBSERVABILITY_PUBLISHED_HOST=<lan-ip>:7700`
2. `OBSERVABILITY_ALLOW_LAN=1` and `OBSERVABILITY_TLS_TERMINATED=1`
3. `/data/last_bootstrap_at` already present (written on a successful loopback `POST /api/auth/exchange`)

The LAN container bind is via the override file `tools/observability_server/docker-compose.lan.yml.example`; Caddy fronts Node with mkcert TLS on the LAN address; plain HTTP off-loopback is refused. There is no escape hatch around the bootstrap marker — first boot must always be loopback.

### Load test + live test

- `tools/observability_server/test/load.ts --spec` runs the plan-profile load test (N=27 sub-agents × 10 KB/s × 600 s + 2 WS subscribers + 5 s history loop), asserts WS p95 < 2 s + UDS RTT p95 < 5 ms + commit p95 < 50 ms + memory growth < 50 MB/h + chunk-count parity, writes `tools/observability_server/test/load-report.json`. Render with `load_report.ts`.
- `tools/observability_server/test/live/` contains the operator-driven scripts for the daemon-written / sweeper-written crashed paths, host_boot_id change, pressure-retention notify-schema capture, and the LAN bootstrap five-step sequence.

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
