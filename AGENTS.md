# AGENTS.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude, Codex, and Gemini are all enabled (Gemini → `gemini-3.1-pro-preview` on Vertex). The Vertex **project/location are resolved at runtime** by `tools/vertex_config_lib.ts` (env > config > `GOOGLE_CLOUD_PROJECT` > local `gcloud`) — **never hardcoded/committed in source**. Note: `-latest` aliases like `gemini-pro-latest` only resolve via the Generative-Language API-key fallback, **not** Vertex. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Draft PRs by default.** Every PR-opening path opens a **draft** so WIP stays out of draft-guarded CI; test locally, then un-draft to merge. Owned by the `pr create` CLI default (`github_app_lib::prCreate`, `draft ?? true`); opt out with `--ready`/`--no-draft`. Merge paths mark the PR ready-for-review first (`github_app.ts pr ready` / `gh pr ready` — fires target CI via `ready_for_review`), then wait for green, then squash-merge. Target-repo `pull_request` workflows need the skip-draft guard for "no CI on WIP" to hold — see `standards/workflows/skip-draft-guard.md`.
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
- `tools/copilot_land_lib.ts` (pure) + `tools/copilot_land.ts` (CLI) — `/stark-copilot` create-or-adopt impl-PR landing (`branch-name`/`prepare-branch`/`land`; push never `--force`, adopt-by-head-ref, draft-by-default, `--ready` un-drafts). `tools/plan_to_tasks_dedup_lib.ts` (pure) + `tools/plan_to_tasks_dedup.ts` (CLI) — plan-scoped `<!-- stark-task: {plan_slug}/{task_id} -->` marker dedup (fail-closed on `/` in either field), the crash-resume duplicate-issue gate.
- `tools/dispatcher_base_lib.ts` — shared dispatch base: hierarchical review-config discovery, model resolution, agent registry, domain/prompt resolution
- `tools/plan_review_dispatch.ts` + `plan_review_dispatch_lib.ts` — plan/spec document review dispatch (N agents × M domains)
- `tools/review_doc_findings.ts` + `review_doc_findings_lib.ts` — per-finding post/resolve layer for `/stark-review-spec` + `/stark-review-plan` (every finding → resolvable PR thread → fixed → resolved). `post` threads every receipt finding (auto-resolving wing-fixed ones), `resolve` replies+resolves a thread after a fix, `list` prints open findings; `collectFindings` derives each finding's fix status from the dispatcher receipt. **Each finding thread is authored by the reviewing LLM's App** (finding `agent`: codex→stark-codex, claude→stark-claude, gemini→stark-gemini) for analytics attribution; `resolve` uses the same per-entry App. `--app` is only the fallback (default `stark-claude`)
- `tools/refactor_planner.ts` + `refactor_planner_lib.ts` — multi-agent repository refactor-planning dispatcher (`/stark-refactor-plan`). Modes `dry-run` / `run` / `validate`; 10 focused subagents over size-capped context packs; deterministic host scan (`refactor_planner_discovery.ts`), context packs (`refactor_planner_context.ts`), provider abstraction with claude/codex/`noop` (`refactor_planner_provider.ts`), host-owned conflict resolution + DAG-valid backlog assembly (`refactor_planner_synth.ts`), 14-section plan + backlog rendering (`refactor_planner_artifacts.ts`), types/validators/gate (`refactor_planner_schemas.ts`). Prompts in `global/prompts/refactor-planner/`. Outputs `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json`; planning-only. Doc: `skill/stark-refactor-plan/references/dispatcher.md`.

### Agent utilities
- `tools/claude_utils_lib.ts` — Claude CLI dispatch helpers (clean env, headless command builder, model pinning)
- `tools/codex_utils_lib.ts` — Codex CLI dispatch helpers (JSONL parsing, reasoning-effort config)
- `tools/gemini_utils_lib.ts` — Gemini CLI dispatch helpers (session isolation, Vertex-AI env, API-key fallback)

### Infrastructure
- `tools/stark_config_lib.ts` — full config reader (DEFAULT_* sections, per-section accessors, deep merge).
- `tools/runtime_env_lib.ts` — isolated subprocess env builder (allowlist, GitHub App token injection, temp dirs)
- `tools/gemini_auth_lib.ts` — headless-gemini model auth SSOT: `oauth` (default — Code Assist seat via copied oauth creds + `GOOGLE_CLOUD_PROJECT`) vs `vertex` (per-token + ADC) vs `api-key`; `STARK_GEMINI_AUTH` env > `models.gemini.auth` config > `oauth`
- `tools/claude_auth_lib.ts` — headless-claude model auth SSOT: `subscription` mode (default, no `ANTHROPIC_API_KEY` — CLI uses the logged-in account's OAuth creds) vs `api` mode (inject key from `ANTHROPIC_AGENTS`); `STARK_CLAUDE_AUTH` env > `models.claude.auth` config > `subscription`
- `tools/github_projects_lib.ts` + `tools/github_projects.ts` — GitHub Projects V2 GraphQL operations (TS; replaces the deleted `scripts/github_projects.py`)

### Dispatch tools (TS)
- `tools/copilot_dispatch.ts` — `/stark-copilot` lead/wing implementation dispatcher (replaces former `scripts/copilot_dispatch.py`). Owns the worktree + diff + review→fix loop + JSON verdict parsing. Also the canonical home for shared agent-dispatch primitives now imported by `iac_review_lib.ts`: `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`, plus the verdict parsers.

### TUI & session
- `tools/stark_session_lib.ts` + `tools/stark_session.ts` — `/stark-session` data collector. Subcommands `start` and `end` return structured JSON; Claude renders the briefing/summary directly. Session-state, persona, alerts, skill-suggestions, healer-canary collectors hit pure-TS siblings; only `github_projects.py` remains. Replaces the deleted `session_tui*.py` ANSI/box-drawing renderer.
- `tools/stark_handover_lib.ts` + `tools/stark_handover.ts` — `/stark-handover` storage engine. Numbered `handover_{N}.md` chain + rewritten-wholesale `PROGRESS.md` tracker under `{root}/{project}/{worktree}/{task}/` (root: `STARK_HANDOVER_ROOT` env > `handover.root` config > `~/Code/Handovers`) so a session can `/clear` and resume from disk. CLI `resolve|save|resume|list [--all]`, JSON stdout; save requires handover/progress content via `--handover-file`/`--progress-file`, allocates chain files exclusively, stores private-mode outputs, and resume returns `task_slugs`.

### TS tools
- `tools/cost_lib.ts` — `computeDispatchCost(model, inputTokens, outputTokens)`: shared token→USD via `getModelRates` (`_fallback` for unknown models); challenge + fix-plan + fold paths agree on cost.
- `tools/stark_persona_lib.ts` + `tools/stark_persona.ts` — pure-TypeScript `/stark-persona` (replaces the deleted `scripts/stark_persona.py`). Library: roster grammar, active.json, weight math, fuzzy match, SQLite schema, selection / combo / rating / survey / add. CLI: 11 subcommands (`select` / `deactivate` / `rate` / `survey` / `survey-answer` / `add` / `stats` / `history` / `print-roster` / `print-weights` / `session-end`).
- `tools/session_id_lib.ts` + `tools/session_id.ts` — pure-TS session ID resolver (replaces the deleted `scripts/session_id.py`). Three-tier: CLAUDE_SESSION_ID > newest-mtime marker in `~/.claude/projects/` > uuid4. Consumed by `tools/session_state_lib.ts` and `tools/context_compactor_lib.ts`.
- `tools/session_state_lib.ts` + `tools/session_state.ts` — pure-TS session state machine (replaces the deleted `scripts/session_state.py`). Same on-disk JSON shape, same path sanitization. CLI: `[--session-id ID] [--json]` (Python parity) + `set --field <name|start_head|last_checkpoint> --value VAL` for the SKILL.md mutators.
- `tools/self_healer_lib.ts` + `tools/self_healer.ts` — pattern-based auto-fixer (replaces the deleted `scripts/self_healer.py`). Same gate ladder as the Python (guard → max_per_session → auto-mode allowlist → circuit breaker → suggest/auto branch). Atomic writes. Emits alerts through `alert_delivery_lib`.
- `tools/healer_canary_lib.ts` + `tools/healer_canary.ts` — canary rollout for self_healer patterns (replaces the deleted `scripts/healer_canary.py`). CLI: `--status` (Python parity) + new `--check` (oncall paging, exits 2 on tripped auto-pattern), `--close-circuit PATTERN_ID` (manual recovery), `--explain PATTERN_ID` (audit trail). Atomic config writes. Configurable promotion gate.
- `tools/skill_router_lib.ts` + `tools/skill_router.ts` — pure-TS contextual skill suggestions (replaces the deleted `scripts/skill_router.py`). `context → mapped skills → minus suppressed → minus recently-used → ranked → capped`. Consumed by `/stark-session`.
- `tools/alert_delivery_lib.ts` + `tools/alert_delivery.ts` — pure-TS alert emit + check (replaces the deleted `scripts/alert_delivery.py`). On-disk contract unchanged: alerts.jsonl + alert-{ts}.marker files in `~/.claude/code-review/`, same-second collision counter. Consumed in-process by `tools/self_healer_lib.ts`; CLI consumed by the `/stark-session` collector.
- `tools/context_compactor_lib.ts` + `tools/context_compactor.ts` — pure-TS session-checkpoint generator (replaces the deleted `scripts/context_compactor.py`). Writes `checkpoint-{ts}.md` under `sessions/{sid}/`, updates `session_state.last_checkpoint`, honors size cap. Loads `context_compaction` config inline (no `config_loader.py` dep). CLI: `[--session-id ID] [--json]`. Consumed by `/stark-session` Phase 3b + stark-copilot end hooks.
- `tools/optimize_skill_description.ts` — skill-description optimizer (replaces the deleted `scripts/optimize_skill_description.py`). Reads SKILL.md frontmatter, scores via the skill-creator plugin's Python `run_eval.py`, asks `claude -p` for a better description based on the failing eval queries. CLI flags and JSON report shape match the Python.

### Other

### Config & prompts
- `global/config.json` — default config schema (models, runtime, triage, cost, etc.)
- `global/prompts/{claude,codex,gemini}/` — per-agent × per-domain PR review prompts (7 domains: architecture, behavior, type-safety, security, test-coverage, spec-conformance, ssot) + `agent.md` preamble + `classifier.md`; codex also has `fixer.md`
- `global/prompts/{spec-review,plan-review}/` — per-agent + shared `domains/` doc review prompts
- `global/prompts/copilot/` — `/stark-copilot` lead/wing `implement`/`review` prompts
- `global/prompts/triage/` — domain triage prompts and manifest
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Distribution

Skills + tools ship as self-contained Claude Code plugins via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace — its `catalog/` is generated from this repo by `stark sync`, and each plugin vendors the `tools/` + `global/` it needs (no symlinks, no local install step). `.github/workflows/marketplace-sync.yml` auto-publishes on every push to `main` touching a vendored asset root — `skill/`, `tools/`, `global/`, `scripts/`, `standards/`, or `plugins/stark-gh/`.

```
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-gh, stark-ops, ...
/plugin update  stark-analyze@bifrost   # pull the latest published version
```

## Skills

All skills live in `skill/stark-*/SKILL.md` and are packaged into marketplace plugins.

### Pipeline (end-to-end, in order)

- `/stark-write-spec <path|"intent"> [--out PATH] [--lead claude|codex] [--wing claude|codex] [--lead-model ID] [--wing-model ID] [--max-rounds N] [--dry-run] [--ready] [--no-pr] [--json]` — **stage 0: contract-bounded spec authoring** upstream of review (`tools/write_spec.ts`). Turns intent (prompt, notes, and/or distilled conversation) into a spec satisfying a **fixed Spec Contract** (`global/prompts/write-spec/contract.md`, 9 sections inverting the review-spec domains), then hands off to the still-mandatory `/stark-review-spec`. Headless lead/wing loop mirroring `plan_dispatch.ts`: lead drafts/revises, wing returns **one closed-enum status per section (not free-form findings)** — the host drops unknown section ids and **recomputes `done` over the full 9-id set, never trusting the wing** (partial verdicts fail closed). No growth breakers/coherence/analytics grading — the contract bounds it by construction. Five terminal verdicts (`contract_satisfied | max_rounds_unsatisfied | lead_empty_draft | unchanged_revision | wing_unparseable`); `max_rounds_unsatisfied` offers answer-the-gaps / accept-with-gaps (append to Open Questions) / abort. Lands on a **draft PR** via create-or-adopt idempotent landing (`write-spec/<slug>`, commit-on-top, never force-push); handoff `next: /stark-review-spec <spec>`. ADR: `docs/adr/0023-spec-authoring-contract-bounded.md`.
- `/stark-review-spec <path> [--fable] [--lead-agent codex|claude] [--lead-model ID] [--wing-agent claude|codex] [--wing-model ID]` — lead/wing spec review over 9 domains (`tools/stark_review_doc.ts`): lead reviewer defaults to codex (gpt-5.5, xhigh), wing/fixer defaults to claude (opus-5 1m); `--fable`/`--lead-agent claude` runs the lead on Fable 5, `--wing-agent codex` runs the fixer on codex — lead and wing are independent. Every finding is posted as its own resolvable PR thread, fixed (asking the operator when ambiguous), and resolved with the fix — via `tools/review_doc_findings.ts`. Every run also emits **process analytics** (per-round doc growth + findings trajectory, health grade healthy/degraded/runaway, `<doc>.review-analytics.md` sidecar + receipt `analytics` block), aborts pathological loops early via growth/non-convergence circuit breakers — including a **round-spike tripwire** (first round growing the doc >1.5x with non-declining findings halts-for-ack) and a per-round scope-growth revert; an explicit V1 boundary in the doc ("What this is NOT" / "deferred to Phase 2") is **binding** on reviewers and the wing; wing batches cap at `max_fixes_per_round` (12), `max_rounds` defaults to 2, growth is measured against a pinned first-staged baseline, and the dispatcher runs in the background by default; cross-domain refractions dedup into one `cross_validated_by` finding before counting/fixing, prior findings + dispositions thread into later rounds (re-raise only broken resolutions), the wing fixes deletion-first with an in-round compress pass past 1.15x growth, and spec-review prompts are contract-anchored (zero findings is a valid output), and runs a net-reducing **coherence pass** (contradictions/repetitions/fluff/leftovers) before the final review (`--no-coherence` to skip).
- `/stark-review-plan <path> [--fable] [--lead-agent codex|claude] [--lead-model ID] [--wing-agent claude|codex] [--wing-model ID]` — lead/wing execution plan review over 5 adversarial domains (same `tools/stark_review_doc.ts --prompts-dir plan-review`): lead defaults to codex (gpt-5.5, xhigh), wing defaults to claude (opus-5 1m); `--fable`/`--lead-agent claude` runs the lead on Fable 5, `--wing-agent codex` runs the fixer on codex. Every finding is posted as its own resolvable PR thread, fixed (asking the operator when ambiguous), and resolved with the fix — via `tools/review_doc_findings.ts`. Every run also emits **process analytics** (per-round doc growth + findings trajectory, health grade healthy/degraded/runaway, `<doc>.review-analytics.md` sidecar + receipt `analytics` block), aborts pathological loops early via growth/non-convergence circuit breakers — including a **round-spike tripwire** (first round growing the doc >1.5x with non-declining findings halts-for-ack) and a per-round scope-growth revert; an explicit V1 boundary in the doc ("What this is NOT" / "deferred to Phase 2") is **binding** on reviewers and the wing; wing batches cap at `max_fixes_per_round` (12), `max_rounds` defaults to 2, growth is measured against a pinned first-staged baseline, and the dispatcher runs in the background by default; cross-domain refractions dedup into one `cross_validated_by` finding before counting/fixing, prior findings + dispositions thread into later rounds (re-raise only broken resolutions), the wing fixes deletion-first with an in-round compress pass past 1.15x growth, and spec-review prompts are contract-anchored (zero findings is a valid output), and runs a net-reducing **coherence pass** (contradictions/repetitions/fluff/leftovers) before the final review (`--no-coherence` to skip).
- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents; issue-driven mode when task issues exist
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
- **Every skill honors `--help`** — each `skill/*/SKILL.md` opens with a `## Help` block after its frontmatter pointing at `standards/help.md`; a standalone `--help`/`-h`/`help` token prints the skill's purpose + usage + arguments and stops (no preflight, no phases). Guarded by `skill_smoke_test.test.ts`.

## GitHub Apps

The **21S** apps (act as `aryeh-stark`), installed on both orgs:

| App | App ID | Installation ID (21-Stark-AI / GetEvinced) | Keychain |
|-----|--------|--------------------------------------------|----------|
| stark-claude (Stark Claude 21S) | 4094779 | 141330560 / 141330785 | STARK_CLAUDE_PRIVATE_KEY_21S |
| stark-codex (Stark Codex 21S) | 4094776 | 141330526 / 141330738 | STARK_CODEX_PRIVATE_KEY_21S |
| stark-gemini (Stark Gemini 21S) | 4094781 | 141330618 / 141330831 | STARK_GEMINI_PRIVATE_KEY_21S |

> The Keychain stores **base64-of-PEM** (`github_app_lib` decodes it). For CI secrets / `actions/create-github-app-token`, set the **decoded** PEM:
> `security find-generic-password -s STARK_CLAUDE_PRIVATE_KEY_21S -w | base64 -D | gh secret set STARK_CLAUDE_PRIVATE_KEY --repo 21-Stark-AI/stark-skills`
