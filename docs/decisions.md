# Decisions

## 2026-03-22 — GitHub Projects V2 Integration

- **Date:** 2026-03-22
- **Status:** Decomposed → issues created
- **Tracking:** #3, #4, #5, #6
- **Story Points:** 47 total (14 tasks across 4 phases)
- **Summary:** Replace label-based workflow tracking with GitHub Projects V2 as the canonical state machine. New `github_projects.py` module wraps GraphQL operations. Three GitHub Actions enforce PR-triggered transitions, composite release gates, and stale detection. Five skills modified for project integration. Migration is additive — labels continue alongside fields.
- **Knowledge extracted to:** `docs/adr/0010-graphql-for-projects-v2.md`, `docs/adr/0011-fail-closed-mutations-fail-open-reads.md`, `docs/adr/0012-additive-migration-labels-to-project-fields.md`, `docs/glossary.md`

## 2026-03-25 — Skill Documentation & Visualization System

- **Date:** 2026-03-25
- **Status:** Decomposed → issues created
- **Tracking:** #52, #53, #54, #55, #56, #57
- **Story Points:** 44 total (14 tasks across 6 phases)
- **Summary:** Multi-LLM documentation generator for stark-skills. 3 LLMs compete to generate HTML visualizations per skill, Claude judges PNG screenshots, markdown docs include Mermaid diagrams and PNG embeds. Two audience splits per skill (usage guide + internals). Routing guide with Mermaid decision trees. HTML sanitization via html.parser (not regex). Staleness detection with per-audience quality flags. Flat ThreadPoolExecutor (MAX_WORKERS=6).
- **Knowledge extracted to:** `docs/decisions.md`

## 2026-03-28 — Self-Maintaining Automation Fleet

- **Date:** 2026-03-28
- **Status:** Decomposed → issues created
- **Tracking:** #107, #108, #109, #110, #111, #112
- **Story Points:** 100 total (23 tasks across 6 phases)
- **Summary:** 12 Claude Code Remote Triggers (CCR) forming a closed-loop self-maintaining platform across 6 GetEvinced repos. Four tiers: self-improvement (model evolution, review quality analysis), health & drift (CLI compatibility, dependency audit, Terraform config drift, API contract monitoring), cross-repo intelligence (ecosystem scanning, CLAUDE.md consistency), reporting & meta (weekly digest, observability config coverage, fleet self-monitoring, hooks auditing). Git as primary persistence with prepend-only logs. External GHA watchdog for CCR outage detection. PAT-based auth in V1 with GitHub App migration path for V2.
- **Knowledge extracted to:** `docs/adr/0013-ccr-over-github-actions.md`, `docs/decisions.md`

## 2026-03-26 — Reusable Tournament Engine (`/stark-tournament`)

- **Date:** 2026-03-26
- **Status:** Decomposed → issues created
- **Tracking:** #85, #86, #87
- **Story Points:** 29 total (9 tasks across 3 phases)
- **Summary:** Extract the tournament pattern from `generate_skill_docs.py` into a reusable `scripts/tournament.py` module. Adds `TournamentConfig` (YAML + dict), `TournamentResult` (dataclass), `Tournament` (orchestrator class) with visual, semantic, and test evaluation strategies. CLI with argparse, `/stark-tournament` skill. Final step refactors `generate_skill_docs.py` to use the Tournament API. Custom evaluation strategy deferred to v2.
- **Knowledge extracted to:** `docs/decisions.md`

## 2026-03-28 — stark-insights: AI CLI Observability System

> **Reverted (2026-05-30):** stark-insights collection decommissioned; the local emit queue producers and `~/.stark-insights/queue.db` were removed (see ADR-0014). Entry retained as history.

- **Date:** 2026-03-28
- **Status:** Reverted (2026-05-30) — was: Decomposed → issues created
- **Tracking:** GetEvinced/stark-insights#2, #3, #4, #5, #6, #7, #8, #9
- **Story Points:** 137 total (40 tasks across 8 phases)
- **Summary:** Local-first, cloud-synced observability for AI CLI interactions. Docker container with FastAPI + MCP server, SQLite write-ahead buffer syncing to Cloud SQL Postgres. Key decisions: write-ahead buffer for all events (not just offline), ADC auth (no SA key files), source-stable dedupe keys, HTTP/SSE MCP transport, monthly partitioned events table, priority-based buffer eviction.
- **Knowledge extracted to:** Target repo (GetEvinced/stark-insights) — knowledge lives in issue bodies since the project is new.

## 2026-03-28 — stark-agents: Domain-Specialized Code Review Agents

- **Date:** 2026-03-28
- **Status:** Decomposed → issues created
- **Tracking:** GetEvinced/stark-agents#1, #2, #3, #4, #5, #6, #7, #8, #9
- **Story Points:** 149 total (38 tasks across 9 phases)
- **Summary:** Six domain-specialized review agents (DevOps, Accessibility, Dependency, Docs, APICompat, Cost) on GCP Cloud Run with MCP server interface. Python MCP SDK, Cloud SQL + pgvector for RAG knowledge, Firestore for control plane (agent configs, findings, cost tracking). Ensemble scoring: 3 LLMs × semantic dedup × consensus confidence. Key decisions: Cloud SQL Python connector (not Auth Proxy), text-embedding-3-small (1536 dims), Playwright + axe-core for Accessibility browser runner, remediation disabled by default, cost agent as post-dispatch hook not file-pattern agent. Phased rollout: DevOps first (48h canary), Accessibility second (multi-agent validation), then remaining four agents one at a time.
- **Knowledge extracted to:** Target repo (GetEvinced/stark-agents) — knowledge lives in issue bodies since the project is new.

## 2026-03-28 — stark-automations: GCP Cloud Functions Automation Fleet

- **Date:** 2026-03-28
- **Status:** Decomposed → issues created
- **Tracking:** GetEvinced/stark-automations#1, #2, #3, #4, #5, #6, #7, #8
- **Story Points:** 151 total (43 tasks across 8 phases)
- **Summary:** Migrate 9 automation triggers from CCR to GCP Cloud Functions Gen2 with Pub/Sub ingress, custom container images (python:3.12-slim + shell binaries), and Terraform-managed infrastructure. Key decisions: single codebase deployed 9 times via Terraform for_each on triggers.yaml, bundled prompts (no runtime GitHub fetch), two service accounts for read/write permission tiers, three model-facing tools (github_api, slack_post, shell_exec) with sandbox isolation, ifGenerationMatch=0 for lock acquisition, Eventarc-managed subscriptions (no manual Pub/Sub subscriptions), canary deploys (sentinel first), 6-day incremental scheduler activation with R/W triggers last.
- **Knowledge extracted to:** Target repo (GetEvinced/stark-automations) — knowledge lives in issue bodies since the project is new. ADR creation is task #9.

## 2026-03-28 — stark-persona (Session Persona System)

- **Date:** 2026-03-28
- **Status:** Decomposed → issues created
- **Tracking:** GetEvinced/stark-skills#145-#150 (6 phases), #151-#169 (19 tasks)
- **Story Points:** 71 total (19 tasks across 6 phases)
- **Summary:** Claude Code skill that assigns movie/comedy character personas via weighted random selection. Python helper CLI + thin SKILL.md wrapper. Local SQLite for state, stark-insights for analytics. Learns preferences over time via like/hate/survey feedback. Supports combo mashups and date-aware selection.
- **Knowledge extracted to:** docs/adr/ (no new ADRs needed — design decisions captured in the design spec)

## 2026-04-03 — Workflow Improvement (stark-skills Ecosystem)

- **Date:** 2026-04-03
- **Status:** Decomposed → issues created
- **Tracking:** #179, #180, #181, #182
- **Story Points:** 173 total (34 tasks across 4 phases)
- **Summary:** Four-phase improvement stack for the stark-skills ecosystem: (P0) unified runtime config with shared loader, preflight environment validation, approach contracts, agent environment isolation, event schema v2; (P1) post-generation code validation gate, failure classification with 8 canonical codes, self-healing with 5 patterns in suggest mode, PID-aware exclusive write locks; (P2) persistent session state surviving /clear, context compaction checkpoints, learning capture from structured metadata, contextual skill suggestions with 13 trigger rules, old config removal; (P3) HTML operator dashboard with 8 KPIs, automation fleet trigger migration, cost controls with hard-stop and auto-recovery, healer auto-mode with per-pattern circuit breaker, alert delivery path.
- **Knowledge extracted to:** `docs/adr/0015-additive-config-migration-three-step.md`, `docs/adr/0016-single-session-id-resolver.md`, `docs/adr/0017-pid-aware-exclusive-write-locks.md`, `docs/glossary.md`

## 2026-04-04 — Domain Triage (Review Cost Optimization)

- **Date:** 2026-04-04
- **Status:** Decomposed → issues created
- **Tracking:** #220, #221, #222, #223, #224, #225
- **Story Points:** 67 total (19 tasks across 6 phases)
- **Summary:** LLM-based domain triage for the multi-agent review system. A triage engine calls one LLM to classify which review domains are relevant to a given input (PR diff, design doc, plan doc), then the orchestrator dispatches only relevant domains. Two modes: aggressive (explicit yes needed) and conservative (confident no needed, threshold 0.8). Fail-open on all triage failures. Conservative-first rollout: conservative default → 5-day bake → shadow validation (20 PRs + 10 docs, gate: 40% skip rate, 0 missed critical/high, p95 <10s) → single-repo canary → global aggressive promotion. Triage telemetry via stark-insights triage_decision events. TUI with color/plain/no-color modes. Skills route through orchestrator with || fallback to direct dispatch.
- **Knowledge extracted to:** `docs/adr/0018-fail-open-triage-as-optimization.md`, `docs/glossary.md`

## 2026-04-04 — Session TUI (Structured Terminal Output)

- **Date:** 2026-04-04
- **Status:** Decomposed → issues created
- **Tracking:** #245, #246, #247, #248, #249, #250
- **Story Points:** 45 total (13 tasks across 6 phases)
- **Summary:** Replace the plain text briefing in `/stark-session start` and `/stark-session end` with structured, color-coded terminal output. Extract shared rendering primitives from `triage_tui.py` into `tui_core.py` (TUIConfig, ANSI helpers, banners, section headers, sanitize_text, slugify). Build `session_tui.py` as a pure rendering layer with TypedDict inputs. Add `session_tui_cli.py` as a CLI bridge with ThreadPoolExecutor data collection (45s budget, 15s per source), error redaction, and graceful degradation. Extend `session_state.py` with optional `name` and `start_head` fields for session identity and scoped diffs. Session naming uses priority order: merged PRs → closed issues → branch name → commit prefix → fallback. Same NO_COLOR/non-TTY/--plain behavior as triage TUI. Zero triage behavior regression gated by byte-for-byte parity.
- **Knowledge extracted to:** `docs/decisions.md`


## 2026-05-09 — TypeScript /stark-review Rewrite (REST-only, V1+V1.1)

- **Date:** 2026-05-09
- **Status:** Decomposed → issues created
- **Tracking:** #438, #439, #440, #441, #442, #443, #444, #445, #446
- **Story Points:** 170 total (43 tasks across 9 phases)
- **Summary:** Rewrite single-agent /stark-review as a TypeScript pipeline (`tools/stark_review.ts` + `tools/stark_review_lib.ts` + `tools/agent_*.ts`). V1 ships REST-only GitHub interactions (no GraphQL), Codex-only dispatch with claude/gemini fail-fast stubs, classifier stage with path validation and 5-error abort, idempotency lock with O_EXCL + heartbeat + run-hash marker, anchor-rejection 422 fallback (demote to body, never drop), structured receipts, history schema-compatible with multi_review.py, and the SKILL.md wrapper migration that captures CONFIG_ROOT before worktree setup. V1.1 adds Claude/Gemini ports, per-agent GitHub App token resolution for poster identity, and an authorization-gated fix loop with explicit-path staging, trusted test_command (config-only, never PR-controlled), GIT_ASKPASS-based fork pushes (no URL-embedded tokens, no extraheader argv), and append-only audit log. Enforcement: `tools/check-rest-only.sh` greps `tools/stark_review*.ts`+`tools/agent_*.ts` for `gh api graphql|/graphql`, wired into `npm test`.
- **Knowledge extracted to:** `docs/adr/0019-rest-only-stark-review-with-trusted-config-and-askpass.md`


## 2026-05-11 — stark-gh:cleanup (Branch + PR Cleanup Command)

- **Date:** 2026-05-11
- **Status:** Decomposed → issues created
- **Tracking:** #499, #500, #501, #502, #503, #504
- **Story Points:** 147 total (33 tasks across 6 phases)
- **Summary:** Two-stage TypeScript command under `plugins/stark-gh`: **preflight** parses raw slash-command arguments, resolves PR/branch/audit/stale candidates into a secure plan-file (mode 0600); **execute** consumes that plan to close stale PRs, delete remote refs, remove worktrees, and delete local branches with per-action failure isolation. Defense-in-depth re-validation at execute time (auth identity, repo nodeId, cwd anchor + canonicalised origin URL, protected list, self-worktree gate) prevents stale plans, identity swaps, and hand-crafted plans from bypassing safety. `closePrWithComment` uses re-fetch-then-act idempotency (single `gh pr close --comment`; re-fetch on non-zero exit to detect already-closed). Auto-discovered candidates (audit-pr, audit-gone-branch, stale-only) default-skip on dirty worktrees and local-ahead (overridable with `--include-dirty`); explicit `--pr`/`--branch` modes force-remove with a stderr warning per design. Multi-PR-on-same-head-ref iterates all stale PRs in Step 2 before remote delete (plan-review H22). JSON envelope on stdout (`{planFile, dryRun, truncated}`) replaces $ARGUMENTS substring matching in the wrapper. Audit log lockfile (`O_CREAT|O_EXCL`) with 2s retry, stale-lock recovery, warn-and-continue on contention, 10MB / 90-day rotation. Cross-repo mode (`--repo OWNER/NAME`) skips local-side steps at the per-step level (not action level — preserves liveActionable counting). gh ≥ 2.40 hard requirement when `--stale-days` or `needsPrClose` actions present. NO `--force` flag (`git branch -D` already refuses to delete the checked-out branch). Plan-file is the data carrier, NOT the sole authorisation source.
- **Knowledge extracted to:** `docs/adr/0020-cleanup-defense-in-depth-revalidation.md`, `docs/adr/0021-cleanup-refetch-then-act-pr-closure.md`


## 2026-07-17 — stark-write-spec (Contract-Bounded Spec Authoring)

- **Date:** 2026-07-17
- **Status:** Decomposed → issues created
- **Tracking:** #688, #689, #690, #691, #692, #693
- **Story Points:** 57 total (16 tasks across 6 phases)
- **Summary:** Build the pipeline's missing stage 0 — a `/stark-write-spec` skill + headless lead/wing dispatcher (`tools/write_spec.ts` + `write_spec_lib.ts` + `write_spec_land.ts` + `write_spec_land_lib.ts`) that turns intent into a spec satisfying a fixed 9-section **Spec Contract**, then hands off to `/stark-review-spec`. Mirrors `plan_dispatch.ts` (lead drafts text, wing returns a JSON verdict, bounded revise loop, no worktree, no tool use), reusing `copilot_dispatch.ts` primitives. Key decisions: completeness is a **closed contract, not an open critique** (wing emits one status per section from a closed enum; host drops unknown ids, recomputes `done` host-side, never trusts the wing); the 9 section ids are a **host-side typed literal** (`SECTION_IDS`) bound to `contract.md` by test (asset is prose authority, code is runtime authority); a **distinct verdict schema** (`items`/`done`/`summary`) needs its own extractor (`extractContractVerdictJson`) since `extractVerdictJson` requires a `verdict` key; agents are **text-in/text-out with no tool access** (repo `NO_TOOLS` least-privilege command config, asserted by test); slug is **host-derived from `--out`** (`deriveSlugFromOut`), never model-chosen; **only the PR is App-authored**, the commit uses repo git identity; PR body is **merged not overwritten** (owned `<!-- stark-write-spec -->` marker block). Config `write_spec` section (timeouts 900/600 from sibling dispatchers, max_rounds=3, max_input_chars=200000, history_keep_runs=20). v1 supports claude+codex only (gemini rejected at both layers). Fatal spec/receipt writes vs non-fatal history writes; incremental per-round history with retention; per-agent cost accounting (codex token_count events are cumulative — read the last, never sum). Skill-layer gap resolution (answer-once / accept-with-gaps / abort) emits a summary JSON that echoes the dispatcher receipt byte-for-byte. Live e2e + 4 DoD checks are a dedicated task (#708) per the repo's "Test live" rule.
- **Knowledge extracted to:** ADR `docs/adr/0023-spec-authoring-contract-bounded.md` — deferred to implementation task #709 (task-6-1), which also updates CLAUDE.md + AGENTS.md in the same change.


## 2026-07-19 — /stark-forge Pipeline Orchestrator

- **Date:** 2026-07-19
- **Status:** Decomposed → issues created
- **Tracking:** #739, #740, #741, #742, #743, #744, #745
- **Story Points:** 100 total (32 tasks across 7 phases)
- **Summary:** Thin conductor `/stark-forge` over the six existing pipeline stages plus one new pure-TS state manager. The only real engineering is `forge_state_lib.ts` — a clock-free, network-free, disk-free state machine — and a host CLI `forge_state.ts` that owns all persistence (via the `write_spec`/`stark_review_doc` history helpers), a distinct `forge_pipeline` config section (NOT the existing review-routing `forge` section), and the orchestrator skill. Key decisions: **a Phase-0 feasibility spike gates everything** — in-session stage invocation is the load-bearing unproven assumption, so a two-stage write-spec→review-spec spike selects `in-session` vs `driver` mode before any mode-dependent orchestration; **strict pure-lib/host split** (the lib mutates only in-memory `RunState` and returns it; all disk I/O lives in the host); **reconciliation is one atomic primitive** (`reconcileRunningStage` is the sole writer of a `crashed` attempt and does the resolving transition in the same call, so no episode double-archives); **merge points are a pure derivation** (`mergePointsFor`); **`artifact_prs` is a write-once single-owner registry** (impl is the one incremental-union artifact; spec/plan write-once even for sliced-chain review openers → `adoption_mismatch` on drift); **the ResumeTarget descriptor is the sole command/routing channel** both executors consume (lib alone calls `renderStageCommand`/`requiresBaseSync`); **base-sync is scoped to new-artifact stages only** via `requiresBaseSync`; **plan-to-tasks completion marker is recorded `issue_numbers`** (no invented completion field). Phase 6 makes each §4 completion channel real (spec-to-plan authoritative `plan_path`+`plan_slug`+PR producer; copilot gains a full idempotent impl-PR landing flow it lacks today) and closes the plan-to-tasks duplicate-issue crash window as a **build gate** (plan-scoped marker dedup, not repo-wide title match). Two validation rounds (codex) converged the decomposition; validator-flagged fixes applied: split the 8-pt resume-target task, `ResolvedInput` vs `ResolvedRun` type split, summary-subcommand de-overlap, authoritative PR-seed branch-pattern mapping, copilot landing split into its own task, and missing skill-md dependencies wired. Playground-tier: no cloud infra/HA/migration/E2E ceremony; the whole deterministic surface is `node:test` unit-tested with an injected PR reader (zero network), live-run per the "test live" rule.
- **Knowledge extracted to:** the plan's decisions are captured in `docs/plans/2026-07-19-stark-forge-plan.md` and (on implementation) CLAUDE.md + AGENTS.md via Phase 6 task 4; no new ADR (thin-orchestrator feature tier).
