# AGENTS.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude, Codex, and Gemini are all enabled (Gemini → `gemini-3.1-pro-preview` on Vertex). The Vertex **project/location are resolved at runtime** by `tools/vertex_config_lib.ts` (env > config > `GOOGLE_CLOUD_PROJECT` > local `gcloud`) — **never hardcoded/committed in source**. Note: `-latest` aliases like `gemini-pro-latest` only resolve via the Generative-Language API-key fallback, **not** Vertex. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Language preference:** Go for backend, TypeScript for scripts. **Avoid Python at all costs** — the repo's tooling is now TypeScript-only (`tools/`); the former Python orchestrators + dispatch infra under `scripts/` were migrated out. Do not introduce new Python.
- **Test live.** Local-only verification is not enough. If a flow touches GCP, exercise the real GCP surface.
- **Always update documentation.** Any change that affects behavior, structure, commands, env vars, or operations must update the relevant docs (this file and `CLAUDE.md` included) in the same change.

## Repo Layout

- `global/` — global config + prompts, installed to `~/.claude/code-review/`
- `scripts/` — shell helpers + JSON (`register_triggers.sh`, `healer_patterns.json`); installed to `~/.claude/code-review/scripts/`. The orchestrators + dispatch infra were migrated to `tools/` (TypeScript).
- `skill/` — all skills (`skill/stark-*/SKILL.md`, 20 skills), packaged as marketplace plugins
- `org/evinced/` — Evinced org config overrides
- `data/` — persona roster, review coverage HTML, generated showcase pages
- `automation/` — CCR automation fleet: 12 triggers, prompts, logs, cost tracking, reports
- `.github/workflows/` — GitHub Actions: project sync, gate checks, stale detection, heartbeat, `marketplace-sync`
- `docs/` — specs, plans, ADRs, retrospectives, generated skill docs
- `standards/` — org-wide doc templates and workflows
- `plugins/stark-gh/` — local plugin source, packaged by the marketplace

## Key Files

### Dispatchers & orchestration
- `tools/dispatcher_base_lib.ts` — shared dispatch base: hierarchical review-config discovery, model resolution, agent registry, domain/prompt resolution
- `tools/multi_review.ts` + `multi_review_lib.ts` — PR review orchestrator (parallel agent×domain sub-agent dispatch)
- `tools/plan_review_dispatch.ts` + `plan_review_dispatch_lib.ts` — plan/spec document review dispatch (N agents × M domains)
- `tools/refactor_planner.ts` + `refactor_planner_lib.ts` — multi-agent repository refactor-planning dispatcher (`/stark-refactor-plan`). Modes `dry-run` / `run` / `validate`; 10 focused subagents over size-capped context packs; deterministic host scan (`refactor_planner_discovery.ts`), context packs (`refactor_planner_context.ts`), provider abstraction with claude/codex/`noop` (`refactor_planner_provider.ts`), host-owned conflict resolution + DAG-valid backlog assembly (`refactor_planner_synth.ts`), 14-section plan + backlog rendering (`refactor_planner_artifacts.ts`), types/validators/gate (`refactor_planner_schemas.ts`). Prompts in `global/prompts/refactor-planner/`. Outputs `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json`; planning-only. Doc: `skill/stark-refactor-plan/references/dispatcher.md`.

### Agent utilities
- `tools/claude_utils_lib.ts` — Claude CLI dispatch helpers (clean env, headless command builder, model pinning)
- `tools/codex_utils_lib.ts` — Codex CLI dispatch helpers (JSONL parsing, reasoning-effort config)
- `tools/gemini_utils_lib.ts` — Gemini CLI dispatch helpers (session isolation, Vertex-AI env, API-key fallback)

### Infrastructure
- `tools/stark_config_lib.ts` — full config reader (DEFAULT_* sections, per-section accessors, deep merge, red_team locked-field enforcement)
- `tools/runtime_env_lib.ts` — isolated subprocess env builder (allowlist, GitHub App token injection, temp dirs)
- `tools/github_projects_lib.ts` + `tools/github_projects.ts` — GitHub Projects V2 GraphQL operations (TS; replaces the deleted `scripts/github_projects.py`)

### Dispatch tools (TS)
- `tools/copilot_dispatch.ts` — `/stark-copilot` lead/wing implementation dispatcher (replaces former `scripts/copilot_dispatch.py`). Owns the worktree + diff + review→fix loop + JSON verdict parsing. Also the canonical home for shared agent-dispatch primitives now imported by `plan_dispatch.ts`: `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`, plus the verdict parsers.
- `tools/plan_dispatch.ts` — `/stark-spec-to-plan` lead/wing plan-generation dispatcher (replaces the deleted `scripts/design_to_plan_dispatch.py`, which used a 3-agent tournament + cross-review). Round 1: lead reads spec + `generate.md`, emits markdown plan draft. Wing reviews via `review.md`, returns `{verdict, blocking_findings[], non_blocking_suggestions[], summary}` JSON. On `revise`, lead receives prior draft + findings + `revise.md`, emits a new draft. Loops until `approve` / `block` / `--max-rounds` / empty-draft / unchanged-from-prior. No worktree (plans are text). Same final-verdict union + JSON output shape as copilot. Defaults: lead=`claude`, wing=`codex`, max-rounds=4, lead-timeout=900s, wing-timeout=600s.

### TUI & session
- `tools/stark_session_lib.ts` + `tools/stark_session.ts` — `/stark-session` data collector. Subcommands `start` and `end` return structured JSON; Claude renders the briefing/summary directly. Session-state, persona, alerts, skill-suggestions, healer-canary collectors hit pure-TS siblings; only `github_projects.py` remains. Replaces the deleted `session_tui*.py` ANSI/box-drawing renderer.
- `tools/stark_handover_lib.ts` + `tools/stark_handover.ts` — `/stark-handover` storage engine. Numbered `handover_{N}.md` chain + rewritten-wholesale `PROGRESS.md` tracker under `{root}/{project}/{worktree}/{task}/` (root: `STARK_HANDOVER_ROOT` env > `handover.root` config > `~/Code/Handovers`) so a session can `/clear` and resume from disk. CLI `resolve|save|resume|list [--all]`, JSON stdout; save requires handover/progress content via `--handover-file`/`--progress-file`, allocates chain files exclusively, stores private-mode outputs, and resume returns `task_slugs`.

### Red-team audit CLIs
- The red-team subsystem is **pure TypeScript** under `tools/`. All Python red-team modules + CLIs were deleted by end of the 2026-05-16 migration. The Responses-API model allowlist + key resolver previously in `scripts/openai_responses.py` are now inlined into `preflight.py::check_red_team_transport_auth` (its only consumer).

### Red-team TS dispatchers
- `tools/red_team_lib.ts` — red-team dispatcher core. Persona/prompt resolution, codex dispatch with sandbox, per-finding validation, sidecar markdown rendering, pre-dispatch sensitive-data gate (scans **untrusted input only** via `untrustedGatePayload`, never the authored preamble — else the preamble's example attacker phrases self-trip it), redaction sanitizer, data-classification gate, `--replay-transcript` support. Fix-plan generation (`resolveFixPlan` + `runRedTeamFixPlan` + `renderFixPlanSection`). All Python shell-outs removed in Phase 5b — audit writes go through `tools/red_team_audit_lib.ts`, DB resolution through `tools/red_team_db_resolver.ts`.
- `tools/red_team_spec.ts` / `tools/red_team_plan.ts` — `/stark-red-team-{spec,plan}` TS dispatcher entry points. Both accept `--fold`: after a successful challenge that wrote a sidecar, they shell out to `red_team_fold.ts` to fold the fix plan into the artifact (non-fatal). `red_team_plan.ts` also threads the spec's `<spec>.red-team.md` sidecar in as a `spec_dispositions` block for plan-stage dedup (task #5).
- `tools/red_team_verify_lib.ts` — refutation/verification pass (task #2). `refuteFindings` challenges each committee finding with a distinct token-less Claude refuter (perspective-diverse lens) that drops/downgrades ONLY what the artifact text refutes (cited span required; fail-safe to uphold; never upgrades; never touches REQUEST_HUMAN_REVIEW). Wired into `dispatchAsync` → sync `dispatch()` via `refinement`; sidecar shows the audit trail. Config `red_team.verify` (locked `enabled`/`model`), kill switch `STARK_RED_TEAM_VERIFY_KILL`. Retired the dead `max_rounds`/`stability_overlap_jaccard_min` keys.
- `tools/red_team_fold.ts` / `tools/red_team_fold_lib.ts` — `/stark-red-team-fold` dispatcher (CLI) + orchestrator. `runFold` resolves the fix plan (`--fix-plan-json` > `--source-run-id` > adjacent `<artifact>.red-team.md` sidecar Run ID → audit DB), runs a **token-less least-privilege Claude decider** (one accept/modify/reject disposition per move), applies the accept/modify patches, writes a `<artifact>.fold.md` decision log, and **audits before any publish**; the CLI then cuts + pushes a branch and opens/edits a **reviewable, never-merged** fold PR (authored by `stark-claude`). Gated by `red_team.fold.enabled`, budget-capped by `red_team.fold.max_cost_usd`; config `red_team.fold` = `{enabled, model, timeout_s, max_input_chars, max_cost_usd, open_pr}` (`fold.enabled`/`fold.model` locked).
- `tools/cost_lib.ts` — `computeDispatchCost(model, inputTokens, outputTokens)`: shared token→USD via `getModelRates` (`_fallback` for unknown models); challenge + fix-plan + fold paths agree on cost.
- `tools/red_team_audit_lib.ts` — SQLite schema + writes (`recordRedTeamRun`, `recordFindings`, `recordPersonaStats`, `pruneRedTeamMetrics`, `initRedTeamTables`, `sanitizeFixPlanJson`, `loadAuditPolicy`) via `node:sqlite`. Multi-statement writes wrap in BEGIN/COMMIT. `recordRedTeamRun` is the only run-row writer — it takes the `fix_plan_*` columns directly (threaded by `auditPersistRun` in `red_team_lib.ts`); the former standalone `recordFixPlan` updater was dead code (zero callers) and was removed. Two **fold** tables back the fold subsystem: `red_team_fold_runs` (one row per fold decision cycle, writer `recordFoldRun`) + `red_team_fix_plan_dispositions` (per-move accept/modify/reject outcome, writer `recordDispositions`).
- `tools/red_team_audit_text_lib.ts` — FU-rt6 retention policy + redaction.
- `tools/red_team_human_review_lib.ts` — FU-rt8 acceptance engine.
- `tools/red_team_status.ts` / `tools/red_team_accept.ts` — operator CLIs for listing / accepting human-review halts.
- `tools/red_team_db_resolver.ts` — Canonical audit DB resolver (`--db` > env > config > default), matches Python `Path.resolve()` symlink semantics on macOS.
- `tools/stark_persona_lib.ts` + `tools/stark_persona.ts` — pure-TypeScript `/stark-persona` (replaces the deleted `scripts/stark_persona.py`). Library: roster grammar, active.json, weight math, fuzzy match, SQLite schema, selection / combo / rating / survey / add. CLI: 11 subcommands (`select` / `deactivate` / `rate` / `survey` / `survey-answer` / `add` / `stats` / `history` / `print-roster` / `print-weights` / `session-end`).
- `tools/session_id_lib.ts` + `tools/session_id.ts` — pure-TS session ID resolver (replaces the deleted `scripts/session_id.py`). Three-tier: CLAUDE_SESSION_ID > newest-mtime marker in `~/.claude/projects/` > uuid4. Consumed by `tools/session_state_lib.ts` and `tools/context_compactor_lib.ts`.
- `tools/session_state_lib.ts` + `tools/session_state.ts` — pure-TS session state machine (replaces the deleted `scripts/session_state.py`). Same on-disk JSON shape, same path sanitization. CLI: `[--session-id ID] [--json]` (Python parity) + `set --field <name|start_head|last_checkpoint> --value VAL` for the SKILL.md mutators.
- `tools/self_healer_lib.ts` + `tools/self_healer.ts` — pattern-based auto-fixer (replaces the deleted `scripts/self_healer.py`). Same gate ladder as the Python (guard → max_per_session → auto-mode allowlist → circuit breaker → suggest/auto branch). Atomic writes. Emits alerts through `alert_delivery_lib`. Consumed by `skill/stark-phase-execute/SKILL.md`.
- `tools/healer_canary_lib.ts` + `tools/healer_canary.ts` — canary rollout for self_healer patterns (replaces the deleted `scripts/healer_canary.py`). CLI: `--status` (Python parity) + new `--check` (oncall paging, exits 2 on tripped auto-pattern), `--close-circuit PATTERN_ID` (manual recovery), `--explain PATTERN_ID` (audit trail). Atomic config writes. Configurable promotion gate.
- `tools/skill_router_lib.ts` + `tools/skill_router.ts` — pure-TS contextual skill suggestions (replaces the deleted `scripts/skill_router.py`). `context → mapped skills → minus suppressed → minus recently-used → ranked → capped`. Consumed by `/stark-session` + `stark-phase-execute`.
- `tools/alert_delivery_lib.ts` + `tools/alert_delivery.ts` — pure-TS alert emit + check (replaces the deleted `scripts/alert_delivery.py`). On-disk contract unchanged: alerts.jsonl + alert-{ts}.marker files in `~/.claude/code-review/`, same-second collision counter. Consumed in-process by `tools/self_healer_lib.ts`; CLI consumed by the `/stark-session` collector.
- `tools/context_compactor_lib.ts` + `tools/context_compactor.ts` — pure-TS session-checkpoint generator (replaces the deleted `scripts/context_compactor.py`). Writes `checkpoint-{ts}.md` under `sessions/{sid}/`, updates `session_state.last_checkpoint`, honors size cap. Loads `context_compaction` config inline (no `config_loader.py` dep). CLI: `[--session-id ID] [--json]`. Consumed by `/stark-session` Phase 3b + stark-copilot / stark-phase-execute end hooks.
- `tools/optimize_skill_description.ts` — skill-description optimizer (replaces the deleted `scripts/optimize_skill_description.py`). Reads SKILL.md frontmatter, scores via the skill-creator plugin's Python `run_eval.py`, asks `claude -p` for a better description based on the failing eval queries. CLI flags and JSON report shape match the Python.

### Other
- `tools/plan_to_tasks_validate.ts` + `plan_to_tasks_validate_lib.ts` — plan decomposition validation (parallel codex/gemini validators)

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain PR review prompts (7 domains: architecture, behavior, type-safety, security, test-coverage, spec-conformance, ssot) + `agent.md` preamble + `classifier.md`; codex also has `fixer.md`
- `global/prompts/{spec-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/spec-to-plan/` — per-agent `generate`/`review`/`revise` plan-generation prompts
- `global/prompts/copilot/` — `/stark-copilot` lead/wing `implement`/`review` prompts
- `global/prompts/triage/` — domain triage prompts and manifest
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Distribution

Skills + tools ship as self-contained Claude Code plugins via the [stark-marketplace](https://github.com/21-Stark-AI/stark-marketplace) — its `catalog/` is generated from this repo by `stark sync`, and each plugin vendors the `tools/` + `global/` it needs (no symlinks, no local install step). `.github/workflows/marketplace-sync.yml` auto-publishes on every push to `main` touching a vendored asset root — `skill/`, `tools/`, `global/`, `scripts/`, `standards/`, or `plugins/stark-gh/`.

```
/plugin marketplace add 21-Stark-AI/stark-marketplace
/plugin install stark-analyze@stark-marketplace   # + stark-plan, stark-implement, stark-gh, stark-ops, ...
/plugin update  stark-analyze@stark-marketplace   # pull the latest published version
```

## Skills

All skills live in `skill/stark-*/SKILL.md` and are packaged into marketplace plugins.

### Pipeline (end-to-end, in order)

- `/stark-review-spec <path>` — multi-agent spec review (N agents × 9 domains, default N=2)
- `/stark-spec-to-plan <path>` — generate implementation plan from spec doc via paired lead/wing loop (default lead `claude`, wing `codex`); lead drafts, wing reviews and emits JSON verdict, fix-loop until approved. Cheaper and lower-variance than the prior 3-agent tournament.
- `/stark-review-plan <path>` — multi-agent execution plan review (N agents × 5 adversarial domains, default N=2)
- `/stark-plan-to-tasks <path> [--dry-run] [--cleanup <slug>]` — decompose plan into phased GitHub issues (3 LLM passes)
- `/stark-phase-execute <plan-slug> [--dry-run]` — autonomous phase execution: implement all tasks, PR, review, merge, release, dashboard
- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents; issue-driven mode when plan has been decomposed via `/stark-plan-to-tasks`
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × triage-selected domains, fast/cheap). Fix-loop `test_command` is auto-detected from the **trusted** `--config-root` (never the PR worktree) via `detectTestCommand()` when unset — no brittle pinned command required.
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or spec/plan review)
- `/stark-review-spec-improvement` — improve spec review prompts (wraps /stark-review-improvement with --prompts-dir spec-review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-handover [save|resume|status] [--task slug]` — cross-`/clear` continuity: save = numbered `handover_{N}.md` chain + `PROGRESS.md` tracker under `~/Code/Handovers/{project}/{worktree}/{task}/`; resume = load both, zero recap. Engine: `tools/stark_handover.ts`
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback
- `/stark-refactor-plan [target-dir]` — planning-only refactor analysis of any repo; emits `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json` (evidence-based, phased, file-by-file). Pure-guidance skill — no dispatcher, never modifies source. Output templates in `skill/stark-refactor-plan/references/`

### Project Setup & Docs

- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs

## Conventions

- Prompts are per-agent: each LLM gets its own version of each domain
- Domain IDs are slugs derived from filenames: `01-architecture.md` → `architecture`
- Config uses JSON, prompts use markdown
- Agent preambles in `agent.md`, domain prompts in `NN-domain.md`

## GitHub Apps

The **21S** apps (act as `aryeh-stark`), installed on both orgs:

| App | App ID | Installation ID (21-Stark-AI / GetEvinced) | Keychain |
|-----|--------|--------------------------------------------|----------|
| stark-claude (Stark Claude 21S) | 4094779 | 141330560 / 141330785 | STARK_CLAUDE_PRIVATE_KEY_21S |
| stark-codex (Stark Codex 21S) | 4094776 | 141330526 / 141330738 | STARK_CODEX_PRIVATE_KEY_21S |
| stark-gemini (Stark Gemini 21S) | 4094781 | 141330618 / 141330831 | STARK_GEMINI_PRIVATE_KEY_21S |

> The Keychain stores **base64-of-PEM** (`github_app_lib` decodes it). For CI secrets / `actions/create-github-app-token`, set the **decoded** PEM:
> `security find-generic-password -s STARK_CLAUDE_PRIVATE_KEY_21S -w | base64 -D | gh secret set STARK_CLAUDE_PRIVATE_KEY --repo 21-Stark-AI/stark-skills`
