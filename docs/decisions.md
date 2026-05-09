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

- **Date:** 2026-03-28
- **Status:** Decomposed → issues created
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
