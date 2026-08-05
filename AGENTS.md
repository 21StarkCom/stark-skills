# AGENTS.md — stark-skills

## What This Is

Multi-agent PR code review system. Claude, Codex, and Gemini are all enabled (Gemini → `gemini-3.1-pro-preview` on Vertex). The Vertex **project/location are resolved at runtime** by `tools/vertex_config_lib.ts` (env > config > `GOOGLE_CLOUD_PROJECT` > local `gcloud`) — **never hardcoded/committed in source**. Note: `-latest` aliases like `gemini-pro-latest` only resolve via the Generative-Language API-key fallback, **not** Vertex. Hierarchical config (global → org → repo). Self-improving prompts via review history analysis.

## Operating Principles

This is a **personal playground**, not production. No customers depend on it; the only user is the author.

- **No rollout ceremony.** Skip soaking, gating, smoking, canary, and gradual-rollout patterns. Ship straight to main.
- **Every PR action is `aryeh-stark`; bots only post reviews.** Open/comment/resolve/un-draft/merge, and opening issues, all go through `gh` (logged in as `aryeh-stark`). The `stark-{claude,codex,gemini}` Apps author as bots and are for **review posting only** — three authors = readable multi-LLM attribution. `github_app.ts` no longer offers `pr create` / `pr ready` / `pr merge` / `issue create` (removed 2026-08-04; they exit 2 naming the `gh` command). CI is the exception — it has no human token and mints an app token instead. The other exception is `/stark-gh-user`, a **human-invoked** swap to a relief account when `aryeh-stark`'s rate limit runs dry: `disable-model-invocation: true`, and no tool/skill/hook may call `tools/user_token.ts` — an automated swap would re-author whatever ran next.
- **Draft PRs by default.** Every PR-opening path opens a **draft** so WIP stays out of draft-guarded CI; test locally, then un-draft to merge. The default is owned by the `gh` path (`plugins/stark-gh/tools/gh_pr_open_execute.ts`, shared draft config); opt out with `--ready`/`--no-draft`. Merge paths mark the PR ready-for-review first (`gh pr ready` — fires target CI via `ready_for_review`), then wait for green, then squash-merge. Target-repo `pull_request` workflows need the skip-draft guard for "no CI on WIP" to hold — see `standards/workflows/skip-draft-guard.md`.
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
- `docs/` — specs, ADRs, retrospectives, generated skill docs (`docs/plans/` is a frozen archive — see Conventions)
- `standards/` — org-wide doc templates and workflows
- `plugins/stark-gh/` — local plugin source, packaged by the marketplace
- `runtime-overrides/codex/` — complete Codex-only skill/command variants plus changed support files; mirrors source-relative paths and must never replace canonical Claude files

## Key Files

### Dispatchers & orchestration
- `tools/copilot_land_lib.ts` (pure) + `tools/copilot_land.ts` (CLI) — `/stark-copilot` create-or-adopt impl-PR landing (`branch-name`/`prepare-branch`/`land`; push never `--force`, adopt-by-head-ref, draft-by-default, `--ready` un-drafts). **`prepare-branch --require-base <sha>` — pass it on every call.** Adoption runs `git checkout -B <b> origin/<b>` (or `git checkout <b>` for a local branch), which **resets the checkout onto that branch**: a leftover from an abandoned run silently replaces your pinned base with an older codebase while the tool reports `ok: true`. The flag refuses that before the destructive checkout on both the track and ff paths, and re-asserts HEAD contains the base afterwards. It rejects an empty value, and unknown flags are now a hard error (a typo'd `--requirebase` used to no-op silently). A ref it cannot resolve is reported as `unresolvable`, NOT as stale — never delete a branch on that message. `tools/plan_to_tasks_dedup_lib.ts` (pure) + `tools/plan_to_tasks_dedup.ts` (CLI) — plan-scoped `<!-- stark-task: {plan_slug}/{task_id} -->` marker dedup (fail-closed on `/` in either field), the crash-resume duplicate-issue gate.
- `tools/plan_review_dispatch.ts` + `plan_review_dispatch_lib.ts` — plan/spec document review dispatch (N agents × M domains)
- `tools/refactor_planner.ts` + `refactor_planner_lib.ts` — multi-agent repository refactor-planning dispatcher (`/stark-refactor-plan`). Modes `dry-run` / `run` / `validate`; 10 focused subagents over size-capped context packs; deterministic host scan (`refactor_planner_discovery.ts`), context packs (`refactor_planner_context.ts`), provider abstraction with claude/codex/`noop` (`refactor_planner_provider.ts`), host-owned conflict resolution + DAG-valid backlog assembly (`refactor_planner_synth.ts`), 14-section plan + backlog rendering (`refactor_planner_artifacts.ts`), types/validators/gate (`refactor_planner_schemas.ts`). Prompts in `global/prompts/refactor-planner/`. Outputs `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json`; planning-only. Doc: `skill/stark-refactor-plan/references/dispatcher.md`.

### Agent utilities
- `tools/claude_utils_lib.ts` — Claude CLI dispatch helpers (clean env, headless command builder, model pinning)
- `tools/codex_utils_lib.ts` — Codex CLI dispatch helpers (JSONL parsing, reasoning-effort config)
- `tools/gemini_utils_lib.ts` — Gemini CLI dispatch helpers (session isolation, Vertex-AI env, API-key fallback)

### Infrastructure
- `tools/stark_config_lib.ts` — full config reader (DEFAULT_* sections, per-section accessors, deep merge).
- `tools/runtime_env_lib.ts` — isolated subprocess env builder (allowlist, GitHub App token injection, temp dirs)
- `tools/gemini_auth_lib.ts` — headless-gemini model auth SSOT: `oauth` (default — Code Assist seat via copied oauth creds + `GOOGLE_CLOUD_PROJECT`) vs `vertex` (per-token + ADC) vs `api-key`; `STARK_GEMINI_AUTH` env > `models.gemini.auth` config > `oauth`
- `tools/claude_auth_lib.ts` — headless-claude model auth SSOT: **one mode, `subscription`** (no `ANTHROPIC_API_KEY` ever injected — the CLI uses the logged-in account's OAuth creds). The metered `api` mode was removed 2026-07-24; `STARK_CLAUDE_AUTH` / `models.claude.auth` are accepted-and-ignored, any non-`subscription` value warns. `ANTHROPIC_AGENTS` has no consumer left and is no longer in `subagent_env_allowlist` (PR #847)
- `tools/github_projects_lib.ts` + `tools/github_projects.ts` — GitHub Projects V2 GraphQL operations (TS; replaces the deleted `scripts/github_projects.py`)

### Dispatch tools (TS)
- `tools/copilot_dispatch.ts` — `/stark-copilot` lead/wing implementation dispatcher (replaces former `scripts/copilot_dispatch.py`). Owns the worktree + diff + review→fix loop + JSON verdict parsing. Also the canonical home for shared agent-dispatch primitives now imported by `iac_review_lib.ts`: `run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`, plus the verdict parsers.

### TUI & session
- `tools/stark_session_lib.ts` + `tools/stark_session.ts` — `/stark-session` data collector. Subcommands `start` and `end` return structured JSON; Claude renders the briefing/summary directly. Session-state, persona, alerts, skill-suggestions, healer-canary collectors hit pure-TS siblings; only `github_projects.py` remains. Replaces the deleted `session_tui*.py` ANSI/box-drawing renderer.
- `tools/stark_handover_lib.ts` + `tools/stark_handover.ts` — `/stark-handover` storage engine. Numbered `handover_{N}.md` chain + rewritten-wholesale `PROGRESS.md` tracker under `{root}/{project}/{worktree}/{task}/` (root: `STARK_HANDOVER_ROOT` env > `handover.root` config > `~/Code/Handovers`) so a session can `/clear` and resume from disk. CLI `resolve|save|resume|list [--all]`, JSON stdout; save requires handover/progress content via `--handover-file`/`--progress-file`, allocates chain files exclusively, stores private-mode outputs, and resume returns `task_slugs`.

### TS tools
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
- `global/prompts/copilot/` — `/stark-copilot` lead/wing `implement`/`review` prompts
- `global/prompts/triage/` — domain triage prompts and manifest
- `standards/templates/` — PR template, ADR template, MkDocs scaffold, staleness config
- `standards/index.md` — "Start Here" pitch page for adopting the doc system

## Distribution

Skills + tools ship as separate self-contained Claude Code and native Codex plugin packages via the [bifrost](https://github.com/21StarkCom/bifrost) marketplace. Canonical `skill/`, `plugins/stark-gh/commands/`, and shared assets are the Claude-authored source. Host-specific Codex behavior belongs only under `runtime-overrides/codex/`; Bifrost imports it as runtime overrides and generates a separate `dist/codex-plugins/` tree. Never make a canonical Claude file “portable” to satisfy Codex, and never layer a Codex override into `dist/claude/`. `.github/workflows/marketplace-sync.yml` auto-publishes changes to either source surface.

```
/plugin marketplace add 21StarkCom/bifrost
/plugin install stark-analyze@bifrost   # + stark-plan, stark-implement, stark-gh, stark-ops, ...
/plugin update  stark-analyze@bifrost   # pull the latest published version

codex plugin marketplace add 21StarkCom/bifrost
codex plugin add stark-gh@bifrost
# Start a new thread, then invoke: $cleanup --dry-run
```

## Skills

All skills live in `skill/stark-*/SKILL.md` and are packaged into marketplace plugins.

### Pipeline (end-to-end, in order)

- `/stark-copilot <plan-or-prompt> [--lead AGENT] [--wing AGENT] [--plan-slug SLUG]` — autonomous implementation with paired lead/wing subagents; issue-driven mode when task issues exist
- `/stark-review [PR_NUMBER]` — single-agent PR code review (1 LLM × triage-selected domains, fast/cheap). Fix-loop `test_command` is auto-detected from the **trusted** `--config-root` (never the PR worktree) via `detectTestCommand()` when unset — no brittle pinned command required.
- `/stark-review-improvement [--prompts-dir DIR]` — improve prompts based on review assessment (PR or spec/plan review)

### Workflow & Ops

- `/stark-session [start|end]` — session management: briefing on start, cleanup on end
- `/stark-handover [save|resume|status] [--task slug]` — cross-`/clear` continuity: save = numbered `handover_{N}.md` chain + `PROGRESS.md` tracker under `~/Code/Handovers/{project}/{worktree}/{task}/`; resume = load both, zero recap. Engine: `tools/stark_handover.ts`
- `/stark-release [patch|minor|major]` — cut a release: changelog, tag, GitHub Release
- `/stark-housekeeping [--dry-run] [--aggressive]` — audit and clean up stale issues, dead branches, worktree remnants
- `/stark-persona` — session character voices with weighted selection, combos, catchphrases, and feedback
- `/stark-refactor-plan [target-dir]` — planning-only refactor analysis of any repo; emits `REFACTOR_PLAN.md` + `REFACTOR_BACKLOG.json` (evidence-based, phased, file-by-file). Pure-guidance skill — no dispatcher, never modifies source. Output templates in `skill/stark-refactor-plan/references/`
- `/stark-cc-user [show|list|add <name>|use <name>|remove <name>|prune|reset [--yes]|limits|next [--dry-run] [--best]|order [names...]]` — switch the active Claude Code account when a 5h/7d rate-limit window runs out. Profiles in macOS Keychain (service `stark-cc-token`); logic `tools/cc_account_lib.ts`, CLI `tools/cc_account.ts`. A switch writes **both** halves — the Keychain `Claude Code-credentials` blob and `~/.claude.json`'s `oauthAccount` — and takes effect on the next `claude` launch. **Profiles are keyed by the SEAT — `accountUuid:organizationUuid`**: neither component is unique (one address holds seats in several orgs; one org holds many members) and Team limits are per-member, so each pair has its own budget. See the CLAUDE.md entry for the failure modes the narrower keys caused. Inactive-account headroom comes from statusline snapshots (`~/.claude/.cc-usage-<accountUuid>_<orgUuid>`), ranked `reset` (window provably rolled) > `floor` (live window; usage only rises, so a stale reading is a lower bound) > `unknown` (no data, sorted last). `next` walks a fixed rotation cycle set by `order`; `next --best` uses that ranking instead. `next` switches by DEFAULT (`--dry-run` previews) and **hard-errors on unknown flags** — a typo'd `--dry-run` used to parse as "switch for real". Its dead ends are classified by the pure, tested `classifyNextOutcome`: only an EMPTY registry is fixed by `add`; an unreadable keychain says so and never prescribes `add` (which would overwrite an intact blob); an unknown active seat refuses to switch; only-the-active-seat exits **0** with the same message in both modes. Profiles with a missing record are warned about on stderr, not silently skipped

### Project Setup & Docs

- `/stark-init-docs [--template|--backfill|--upgrade|--clean]` — scaffold dev docs

## Conventions

- **Docs live with the code** under `docs/`, folder per type: `adr/` (`NNNN-<topic>.md`, immutable — supersede, don't edit), `specs/` (`YYYY-MM-DD-<topic>-spec.md`), `retros/` (`YYYY-MM-DD-<topic>-retro.md`). **There is no `docs/plans/`** — since `/stark-author` (2026-08-01) the spec carries the plan (task DAG, done-whens, closing verification command) and `/stark-build` consumes it. Never create `docs/plans/` or a `*-plan.md` doc; the existing ones are historical archive. Tier by blast radius: trivial → PR only · feature → spec · architectural → ADR + spec. Guarded by `tools/doc_convention.test.ts`.
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
