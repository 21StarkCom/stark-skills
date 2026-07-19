# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
<!-- stark-gh:pr-merge pr=686 runId=d4abae4b-3672-48a1-8077-08a09fd06560 -->
- Add the reviewed implementation plan for the `stark-write-spec` workflow.
<!-- stark-gh:pr-merge pr=685 runId=fa8a1089-bd46-48ab-aaef-eb15553543d9 -->
- Document the bounded authoring-review feedback loop and review lenses in the write-spec contract.
<!-- stark-gh:pr-merge pr=682 runId=156c6897-aac1-41b1-9470-58a61765dab7 -->
- Add the contract-bounded `/stark-write-spec` authoring-stage specification with structured verification, gap resolution, and crash-safe run history.

### Fixed
- write-spec: `write_spec.ts` and `write_spec_land.ts` now resolve their entry guard through `realpathSync`, matching the other 42 CLI tools. Skills invoke these through the `~/.claude/code-review/tools` symlink, where the old raw `pathToFileURL(process.argv[1])` comparison never matched — so `main()` silently never ran and the process **exited 0 having done nothing**. Every `/stark-write-spec` run was a false green at the `validate-out`, `prepare-branch`, and `publish` steps. Regression-tested by spawning each CLI tool through a symlink (`entry_guard.test.ts`).
- stark-gh: the pr-merge self-modifying gate now fires only in the stark-skills repo itself — the generic guarded prefixes (`tools/`, `scripts/`, …) no longer block merges in unrelated repos that happen to have those directories (hit by Atlas PR #162's `tools/CLAUDE.md`).
- stark-gh: the secret scanner scores the two sides of a `NAME=value` token independently (tolerating a leading diff marker), so `KEY=/filesystem/path` doc and `.env`-style lines no longer false-positive as high-entropy; a real 40+-char secret on either side still flags.

## [v0.8.0] - 2026-07-15

### Added
- **Review convergence system (ADR 0022) — no mutation goes unreviewed.** Closes the structural hole where the operator's Phase 5b hand-fixes (the largest, least-constrained edits of a run) landed *after* the final review round. Shipped in slices (#671 plan + ADR):
  - **Coverage honesty (#672):** the receipt tracks per-domain completion across the whole run (`coverage`, `coverage_gaps`) — a domain that never completed a review in any round fails the run (`ok=false`, exit 1, `error.code=coverage_gap`, analytics grade capped at `degraded`) instead of masquerading as clean; transient failures that recovered only warn. Lead timeouts scale with doc size (`scaleTimeoutForDocSize`, cap 3×) and escalate per-domain on retry (`nextDomainTimeout`, 600→1200→1800).
  - **Run-record durability (#673):** doc-review history is per-run (`history/{spec,plan}-reviews/<slug>/<run-id>/` + `latest` pointer + `history_keep_runs` retention) — re-runs never clobber earlier records; `rounds.json` + `analytics.json` persist incrementally after every round via atomic tmp+rename (a killed process leaves partials, `partial:true` until the final write); the full receipt lands as `receipt.json`; write failures surface in receipt `persistence_errors`. **PR-cycle analytics parity:** `buildCodeReviewAnalytics` aggregates each run's `round-N.json` into per-domain time/outcome/classification + coverage gaps (`analytics-rX-rY.{json,md}` + receipt `analytics` block).
  - **Convergence pass (#674):** the receipt records `last_reviewed_sha` (+ `final-reviewed-doc.md` snapshot); `--converge --base <sha>` reviews ONLY the delta since the last-reviewed state (contradiction / broken cross-reference / falsified claim / resolved-in-prose-only; zero findings valid); both doc skills gain **Phase 6 — Converge** with an explicit `Converged / NOT converged` claim (silence is no longer a terminal state), findings flowing through the standard resolvable-thread contract, recursion bounded to one extra pass on `high`/`critical`. The PR cycle mirrors it: a final-round pushed fix triggers one review-only pass over the new HEAD (receipt `convergence` block). Validated by reproducing the original incident — a hand-injected contradiction after the final review was caught as `high`.
- **Process analytics + circuit breakers + coherence pass for doc reviews (#668, #669):** every `/stark-review-spec`·`/stark-review-plan` run computes per-round stats, judges itself (`healthy`/`degraded`/`runaway`, incl. the decline-then-rise `no_net_convergence` flag), writes `analytics.json` + a `<doc>.review-analytics.md` sidecar, and stops pathological loops early; a net-reducing coherence pass runs before the final review round.
- **Findings-on-PR contract for doc reviews:** every finding posts as its own resolvable review thread, gets fixed, gets resolved (`tools/review_doc_findings.ts`, #644); each thread is authored by the reviewing LLM's GitHub App for per-reviewer analytics (#648); posting is rate-limit-resilient with cross-org thread reads (#654); the skills auto-open a PR when none exists and the retired `docs/superpowers/**` tree relocates (#642).
- **Red-team noise war:** per-finding refutation pass — a distinct Claude agent tries to refute each committee finding per lens, drop/downgrade requires a cited verbatim span (#630); persona noise cuts + plan-stage spec-disposition dedup (#629); injection-FP + severity-inflation cuts (#627, #628); fix-plan **fold** subsystem — token-less decider triages each move, patches the doc, never-merged fold PR + audit (#626); challenges auto-open PRs and comment findings via the run's GH App (#611).
- **New skills:** `stark-ssot` (SSOT discipline + auto-fired review domain, #639); `stark-gha-cost` (GHA/GHAS cost optimizer + meridian/bifrost/visibility lesson packs, #659–#663); `stark-refactor-plan` (multi-agent planning-only refactor dispatcher, #607); **multi-agent `stark-terraform-review` + `stark-terragrunt-review`** (#612); `stark-adr` + docs-convention reconcile (#617); `stark-blog-sharpen` (#615); `stark-voice`; `remember` (#636); `stark-logging` + central model-limits registry (#632); `/stark-handover` cross-`/clear` save/resume (#641).
- **`/stark-spec-to-plan` authoring craft (#634):** per-task Interfaces, Global Constraints, right-sizing, named proving Tests, SSOT gate; plans always land on a PR.
- **Draft PRs by default (#662):** every PR-opening path opens a draft (`--ready` opt-out); `pr-merge` un-drafts → CI → squash-merge.
- **Model/agent upgrades:** Gemini enabled with runtime-resolved Vertex project/location (#609); codex default bumped to `gpt-5.6-sol` (#649); `--fable`/`--lead-agent claude` runs doc-review leads on Fable 5 + every skill honors `--help` (#646).
- `/stark-review` auto-detects `test_command` (#610) and runs the fix loop on the final round too; marketplace auto-publish + location-aware skills/tools via the `asset_root_lib` seam (#605); housekeeping self-heals orphaned `~/.claude` asset symlinks (#666); statusline overhaul — per-account-tier gradients, shaded gauges, fork-free hot path (#619–#625).

### Fixed
- **Growth breaker no longer punishes legitimate growth (#675):** growth past the ratio limit alone warns + sets `analytics.growth_ack_required` (operator judges gap-filling vs padding via AskUserQuestion; headless = stop); growth AND non-convergence together hard-stop with a composite reason. A real 2.63× gap-filling spec review no longer aborts.
- Red-team: `openai_token` pattern word-boundaried to stop false positives (#667); pre-dispatch sensitive-gate scans untrusted input only, not the preamble that quotes attack phrases as examples (#628); prompts/config resolve via the asset-root seam instead of hardcoded paths (#613, #616, #655); refutation-table cell sanitization completed (#631).
- Skill frontmatter newline mangled by #664 restored (#665); refactor-planner escapes backslashes before pipes in table cells (#653); copilot goal-mode prompt staged to a file + lead timeout made terminal (#633, #635); agent PATH backfilled to prevent spawn ENOTDIR; stale GetEvinced install-ID assertion updated (#638); `review_doc_findings.ts` null-narrowing tsc errors fixed (in #673) — `tsc -p .` is clean again.

### Changed
- **Marketplace repo renamed** `stark-marketplace` → `stark-bifrost` → **`bifrost`** (#652, #657); GitHub Apps dual-keyed for the `21StarkCom` org rename with a WIF identity SSOT (+ tyr) (#651, #656); workspace paths re-pointed after the `~/Code` reorg (#650); automation fleet re-targeted to the migrated org (#614).
- **Doc-review exit-code semantics (#672):** exit 1 now means terminal failure OR coverage gap; transient dispatch failures that recovered no longer fail the run — the skills' Phase 4 gate blocks on gaps and warns on transients.
- All skills set `disable-model-invocation: true` — explicit invocation only (#664); `stark-*-design` skills renamed to `stark-*-spec` (#618); branch+PR-with-findings-on-PR workflow codified in the docs (#608).
- CI economics: Actions run volume cut (daily stale cron, superseded-run cancellation, #658); daily mirrors to `Infra-Group` for stark-skills + bifrost (#670).

### Removed
- **BREAKING: `install.sh` removed — distribution is now marketplace-only.** The symlink-based local installer (and its `--select` TUI, `--status`, `--uninstall`, git-hook/manifest/infra provisioning) is deleted; skills + tools ship exclusively as self-contained Claude Code plugins via stark-marketplace. Each plugin already vendors `tools/` + `global/`, so no symlinks are needed. Trade-off: editing a file in this repo is no longer instantly live — publish (merge → `marketplace-sync` PR → merge) and `/plugin update <bundle>@stark-marketplace` to pick it up. Assets plugins don't cover (`~/.claude/settings.json`, statusline, output-styles, `org/evinced` overrides, mutable-state dirs, git hooks) are now managed by hand. `asset_root_lib.ts` keeps the `~/.claude/code-review` fallback for direct non-plugin invocations (automation-fleet crons). Docs (README, AGENTS.md, CLAUDE.md) updated to the marketplace-only flow.

## [v0.7.0] - 2026-06-03

### Added
- **Goal-driven implement loops + Workflow parallelism** for `/stark-copilot` and `/stark-phase-execute` (#599). The implement step runs as a Claude Code `/goal` loop (argument-form `claude -p` — stdin does not trigger the loop) that iterates until tests pass, bounded by `--max-budget-usd`; `--no-goal` reverts to the bounded subagent. New `--parallel` mode fans independent tasks/steps out via a Workflow, each in its own worktree. `copilot_dispatch.ts` gains `--goal-condition` / `--goal-max-budget-usd`.
- **`release_changelog.ts` parses the Keep-a-Changelog `### Removed` category** (#603). A Removed-only `[Unreleased]` section no longer reads as empty and falls back to git-log; `removed[]` is threaded through the receipt and rendered, with `### Removed` → patch by default (`**BREAKING:**` → major).
<!-- stark-gh:pr-merge pr=594 runId=8a4f660b-d78c-4027-9856-655cdf7c48b8 -->
- Added the vendored Caveman plugin for token-efficient Claude Code and Codex communication.
- **`/stark-design-to-plan` lead/wing port** — `tools/plan_dispatch.ts` replaces the deleted `scripts/design_to_plan_dispatch.py` (3-agent tournament + cross-review → paired lead/wing loop, sibling of `tools/copilot_dispatch.ts`). Round 1: lead reads design + agent-specific `generate.md`, emits markdown plan draft. Wing reviews via new agent-specific `review.md`, returns `{verdict, blocking_findings[], non_blocking_suggestions[], summary}` JSON. On `revise`, lead receives prior draft + findings + new agent-specific `revise.md`, emits a new draft. Loops until `approve` / `block` / `--max-rounds` exhaustion / empty-draft / unchanged-from-prior. Same final-verdict union + JSON output shape as copilot. Defaults: lead=`claude`, wing=`codex`, max-rounds=4. New `review.md` / `revise.md` prompt files added per agent; `cross-review.md` deleted per agent. SKILL.md rewritten: `--agents` → `--lead`/`--wing`/`--max-rounds`/`--wing-timeout`; Phases 2+3+4 collapsed into one dispatch call; failure-modes table swapped to copilot's set. 15-test TS suite (`plan_dispatch.test.ts`) covers defaults, prompt builders, preflight rejections (lead==wing, invalid agent), and CLI smoke. The 3 design_to_plan-specific tests in `scripts/test_dispatch_routing.py` deleted (Python they tested is gone; equivalent behavior covered by the TS test file). `scripts/dispatcher_base.py` consumer list updated. Bonus: `copilot_dispatch.ts` exports its agent-dispatch primitives (`run`, `buildAgentEnv`, `setupGeminiHome`, `makeGeminiEnv`, `tryGeminiApiKeyFallback`, `releaseAgentTempDir`) so `plan_dispatch.ts` doesn't duplicate them.
<!-- stark-gh:pr-merge pr=580 runId=ccea06f7-93af-4864-887a-c3a0bb7391dd -->
- Added canonical hook tool arguments in settings to match installer output.
<!-- stark-gh:pr-merge pr=579 runId=10021f64-b216-4d1d-84f1-b5f4e7eab425 -->
- Ignore Claude-managed worktree checkouts under `.claude/worktrees/`.
<!-- stark-gh:pr-merge pr=577 runId=19828674-92cb-4b32-9f24-4ce6093e548e -->
- Added Go `stark hook` wiring for Claude Code hooks and removed stale deleted Python hook blocks.
- **stark-session TS data collector** — `tools/stark_session_lib.ts` + `tools/stark_session.ts` collect git/gh/board/alerts/health/queue/healer/persona/skills state into a single JSON payload that `/stark-session` renders directly via Claude. Replaces the deleted Python TUI subsystem.

### Changed
- **Goal-loop budget guard** default raised to $10 and pinned in settings env as `STARK_GOAL_MAX_BUDGET_USD` (#600, #601). A missing/`0`/`NaN` budget never disables the guard — it falls back to the built-in default; the CLI rejects non-positive values.
- **Auto-compaction threshold** set via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (settings env) to 80% filled (#604) — the override is lower-only vs the ~83% default.
- **`github_app`** finalized as TS-only. `scripts/github_app.py` (744 LOC) + `scripts/test_github_app.py` (145 LOC) deleted; `tools/github_app{,_lib}.ts` is now the sole implementation. Remaining Python orchestrators (`scripts/runtime_env.py`, `scripts/multi_review.py`) shell out to `node --experimental-strip-types tools/github_app.ts ... token` for installation-token mints instead of importing the deleted Python module. `scripts/healer_patterns.json::auth-stale.verify_command` swept to the TS CLI; dead `GITHUB_APP` constant in `tournament.py` removed. `scripts/conftest.py` and `scripts/test_runtime_env.py` stub the new `runtime_env._get_token_via_ts` subprocess wrapper instead of monkeypatching the deleted module. The on-disk token cache (`~/.cache/github-app-tokens/`) keeps its JSON shape so any cached tokens minted by the Python remain valid.
- **`self_healer`** ported from Python to TypeScript. `scripts/self_healer.py` (407 LOC) deleted; replaced by `tools/self_healer_lib.ts` + `tools/self_healer.ts`. Python had zero tests for a module that auto-applies fixes to files; the TS port establishes the contract with 28 tests covering every gate (guard, max_per_session, auto-mode allowlist, circuit breaker, suggest/auto branch, requires_confirmation, success/failure circuit updates, critical-alert on circuit trip). Atomic writes for `healer-session.json` + `healer-circuits.json`. `heal_attempt` events emit directly via `tools/emit_queue_lib.ts`; warning/critical alerts emit directly via `tools/alert_delivery_lib.ts` — no Python re-imports. CLI surface preserved (`--pattern-id` / `--stderr-file` / `--mode` / `--json`); result JSON shape unchanged. `scripts/autopilot_dispatch.py` (Python orchestrator) + `skill/stark-phase-execute/SKILL.md` cut over to the TS CLI in the same slice.
- **`healer_canary`** ported from Python to TypeScript + improved. `scripts/healer_canary.py` (310 LOC) deleted; replaced by `tools/healer_canary_lib.ts` + `tools/healer_canary.ts`. Original Python had **zero** tests; the TS port establishes the contract with 44 new tests. Original CLI surface (`--status`, `--promote`, `--demote`, `--json`) preserved with byte-identical `--status` JSON shape. **Improvements:**
  - **Atomic config writes** — the Python's `_write_config` was naive read-modify-write of the multi-writer `~/.claude/code-review/config.json`. The TS version writes a `.tmp` sibling and atomically renames. 100-iteration concurrent-write stress test added.
  - **Configurable promotion gate** via new `config.self_heal.{min_successful_suggests, abort_window_days, circuit_open_hours}` keys (defaults: 5 / 7 / 24 — preserves the Python's hard-coded literals).
  - **New `--check` subcommand**: exits 0 when all auto-mode pattern circuits are closed, exits 2 (with the offender list) when any auto-pattern is tripped. Designed for oncall paging — a suggest-mode trip is normal canary behavior and intentionally does NOT trigger a failure.
  - **New `--close-circuit PATTERN_ID` subcommand**: manually resets a tripped circuit (clears `tripped_at` and `consecutive_failures`, stamps `last_reset_at`, preserves `ever_tripped` as historical record). Replaces "wait 24h or hand-edit `healer-circuits.json`."
  - **New `--explain PATTERN_ID` subcommand**: full audit trail for a single pattern — every matching log entry, current circuit state, computed stats, mode, and (for suggest-mode patterns) eligibility + blockers.
  - **New `healer_canary` insights event type** added to `tools/emit_queue_lib.ts` allowlist. Every promote / demote / close-circuit operation emits one (action + pattern_id + context). Distinct from `heal_attempt` (the per-attempt signal self_healer emits) — this is the canary control-plane signal.
  - `tools/stark_session_lib.ts:collectCanaryStatus` cut over to the TS CLI.
- **`skill_router`** ported from Python to TypeScript. `scripts/skill_router.py` (215 LOC) deleted; replaced by `tools/skill_router_lib.ts` + `tools/skill_router.ts` + 21 new TS tests (no Python tests existed for this module). Inline `skill_activation` config loader — no `config_loader.py` dependency. `skill_suggestion` events emit directly via `tools/emit_queue_lib.ts` (no `scripts/_emit.py` shim). CLI surface preserved (`--context {review|implementation|session|debug} [--json]`), JSON shape unchanged (the internal `_suppressed_count` field still stripped before output). `tools/stark_session_lib.ts:collectSkillSuggestions` + `skill/stark-phase-execute/SKILL.md` cut over to the TS CLI.
- **`alert_delivery`** ported from Python to TypeScript. `tools/alert_delivery_lib.ts` + `tools/alert_delivery.ts` become the TS-canonical implementation; same on-disk contract (`~/.claude/code-review/alerts.jsonl` JSONL log + `alert-{unix-ts}[-{counter}].marker` files in the same dir, including the same-second collision counter). `tools/stark_session_lib.ts:collectAlerts` cut over to the TS CLI. `scripts/alert_delivery.py` stays in place — `scripts/self_healer.py` and `scripts/healer_canary.py` still import `emit_alert` in-process; both sides write/read the same marker dir, so cross-language interop works without any coordination. Verified: a critical emitted by the Python is visible to `--check --json` from the TS CLI, and vice versa.
- **`context_compactor`** ported from Python to TypeScript. `tools/context_compactor_lib.ts` + `tools/context_compactor.ts` replace `scripts/context_compactor.py`. Same checkpoint shape (`checkpoint-{ts}.md` markdown under `sessions/{sanitized-id}/`), same `session_state.last_checkpoint` update on every write, same size cap (`max_checkpoint_size_kb`). `config_loader.py` not pulled in — the `context_compaction` section is loaded inline directly from `~/.claude/code-review/config.json` with the same defaults the Python ships. CLI surface preserved (`[--session-id ID] [--json]`). 4 SKILL.md files cut over (stark-autopilot, stark-copilot, stark-phase-execute, stark-session). Three skill files that still shelled `python3 .../session_state.py --json` (missed in the prior slice) also cut over to the TS CLI.
- **`session_state`** ported from Python to TypeScript. `tools/session_state_lib.ts` + `tools/session_state.ts` replace `scripts/session_state.py` as the source of truth for `~/.claude/code-review/sessions/{id}.json` persistence (same path-traversal sanitization, same on-disk JSON shape, same load/save semantics). New `set --field <name|start_head|last_checkpoint> --value VAL` subcommand replaces the inline `python3 -c "from session_state import …"` blocks in `/stark-session` SKILL.md Phase 3 + Phase 6. `tools/stark_session_lib.ts:collectSessionState` cut over to the TS CLI (drops one Python subprocess hop per `/stark-session start|end`). `scripts/session_state.py` stays in place — `scripts/context_compactor.py` still imports `SessionState` as a Python class; both get deleted in the context-compactor port.
- **`session_id` resolver** ported from Python to TypeScript. `tools/session_id_lib.ts` + `tools/session_id.ts` CLI replace `scripts/session_id.py` as the source of truth for the three-tier resolver (CLAUDE_SESSION_ID > `~/.claude/projects/` newest-mtime marker > uuid4). `tools/emit_queue_lib.ts` now delegates to the shared lib instead of inlining a partial version (drops the `// Skip the projects-dir resolution path` debt, so every TS producer now reports the same session ID the Python session_state machine sees). `/stark-session` SKILL.md preamble cut over to the new CLI. The Python `scripts/session_id.py` stays in place pending the `session_state.py` port — `session_state.py` still imports it — and will be deleted in that slice.
- **`optimize_skill_description`** ported from Python to TypeScript. `scripts/optimize_skill_description.py` (323 lines) + `scripts/test_optimize_skill_description.py` (86 lines) deleted; replaced by `tools/optimize_skill_description.ts` + 14 TS tests covering frontmatter parsing, improve-prompt assembly (with 200-char truncation parity), and the `ANTHROPIC_AGENTS → ANTHROPIC_API_KEY` env allowlist. CLI surface preserved (same flags, same JSON report shape). Scoring still shells out to the skill-creator plugin's Python `run_eval.py` — that lives outside this repo.
- **stark-persona** ported from Python to TypeScript. `scripts/stark_persona.py` (1504 lines) + `scripts/test_stark_persona.py` (1191 lines) deleted; replaced by `tools/stark_persona_lib.ts` + `tools/stark_persona.ts` + 44 TS tests (25 lib + 19 CLI smoke). SKILL.md (and `/stark-session` start/end hooks + `tools/stark_session_lib.ts` collector) cut over to `node --experimental-strip-types tools/stark_persona.ts`. JSON shape of `select --auto` preserved (still parsed by `/stark-session`). Insights events now write directly to `~/.stark-insights/queue.db` via `tools/emit_queue_lib.ts` under the new `persona_event` allowlist entry (no HTTP, no token file, no `_emit.py` shim). Persona DB at `~/.stark-persona/persona.db` and `active.json` schema unchanged — pre-existing rows are reused as-is.

### Removed
- **stark-release Step 5.5 `generate-viz.py` regeneration** (#602) — a dangling reference to a script that only ever existed in consumer repos (no-op here) that failed the skill smoke test.
- **Session TUI subsystem** — `scripts/session_tui.py`, `scripts/session_tui_cli.py`, `scripts/test_session_tui.py`. The structured briefing/end-summary are now produced by Claude from the JSON returned by `tools/stark_session.ts`. `--plain` / `--no-color` CLI flags are gone with the renderer.
- **stark-graph** code, tests, workflows, docs, and config keys (`graph_enriched_domains`, `graph_gate_mode`, `graph_max_parse_workers`, `graph_coverage_threshold`).
- `scripts/stark_persona.py` and `scripts/test_stark_persona.py` — replaced by `tools/stark_persona{,.test,_lib,_lib.test,_writes.test}.ts`.
- `scripts/optimize_skill_description.py` and `scripts/test_optimize_skill_description.py` — replaced by `tools/optimize_skill_description{,.test}.ts`.
- `scripts/context_compactor.py`, `scripts/test_context_compactor.py`, `scripts/session_state.py`, `scripts/test_session_state.py`, `scripts/session_id.py` — all replaced by their `tools/*_lib.ts` + `tools/*.ts` TS counterparts. context_compactor was the last Python consumer of session_state and session_id, so all five files came out in one slice.
- `scripts/skill_router.py` — replaced by `tools/skill_router{,.ts,_lib.ts,_lib.test.ts}`. No Python tests existed; 21 new TS tests added to cover the routing logic.
- `scripts/healer_canary.py` — replaced by `tools/healer_canary{,.ts,_lib.ts,_lib.test.ts}` (the port adds three new subcommands; see `### Changed`).
- `scripts/self_healer.py` — replaced by `tools/self_healer{,.ts,_lib.ts,_lib.test.ts}`.
- `scripts/alert_delivery.py` + `scripts/test_alert_delivery.py` — cascaded by the self_healer port: self_healer was the last consumer of `from alert_delivery import emit_alert`. The TS `tools/alert_delivery_lib.ts` (added earlier) is now the canonical implementation; its on-disk contract (alerts.jsonl + alert-*.marker files) is unchanged.

## [v0.6.2] - 2026-04-24

### Added
- **stark-red-team v1** — architect committee layer for forge pipelines (#310)
- **stark-forged-review** — multi-agent leader + second-opinion PR review skill (#309)
- forged-review: telemetry for auto-vs-explicit invocation source
- forged-review: truncate oversized diffs with head+tail window
- forged-review: cache triage decisions by diff hash
- scripts: Vertex-compatible skill description optimizer + skill optimizer tooling

### Fixed
- forged-review: preserve worktree on `awaiting_fixes` so `--resume` works (#311)
- forged-review: stderr heartbeat keeps parent stream alive during long rounds
- forge: real pipeline dispatch, working fix-loops, classifier word boundaries
- drain_to_buffer v2 schema + surface silent failures (#314)
- honor global red-team locked config
- clean installer and release skill drift
- reasoning-effort validation, reuse-proposal key gate, schema/runtime alignment, delete delta
- mode validation, fence escaping, timeout budget, status docs
- drain_to_buffer/red-team/skill-optimizer review rounds 2–33: envelope types, replay fault tolerance, auth redaction, race guards, recovery preservation, retry fixes, loopback and symlink guards, IPv6 loopback, dead-letter split, dim preservation on replay, permanent/transient split, UUID pass-through, CI-root allowlist, atomic staging, strict v2 probe, and related hardening

### Changed
- chore: un-deprecate `/stark-review`; fix stark-codex installation id (#316)
- Switch Claude to Anthropic API, Gemini to ADC+Vertex; bump to opus-4-7 (#315)
- docs: align stark-review skill with runtime
- docs: skill-optimizer — API mode requires explicit `--skill` target
- docs(stark-forged-review): trim SKILL.md to 71 lines; fix v1 drift in Observability/state/delta sections
- docs(retros): brainstorm-to-merge session pattern retrospective
- install: relax disable-model-invocation validation to warning
- chore: allow stark-data-core PR workflow; merge pending repo cleanup updates

## [v0.6.1] - 2026-04-11

### Added
- **stark-forge** — end-to-end design-to-tasks pipeline: 9 Python modules (`forge_orchestrator`, `forge_classifier`, `forge_review`, `forge_plan`, `forge_tdd`, `forge_tasks`, `forge_audit`, `forge_improve`, `config_loader` extension), isolated prompt trees (`forge-design-review/` with 13 domains, `forge-plan-review/` with 10 domains), seed heuristics, and SKILL.md with `--auto-detect`, `--dry-run`, `--resume`, `--workers` flags
- 3-tier domain classifier: heuristic pattern matching (Tier 1), LLM-based classification with poisoning guard (Tier 2), interactive terminal confirmation (Tier 3)
- Iron Rule review loop: severity-based finding classification, cross-reference high-confidence detection, recurrence tracking (3rd occurrence blocks), targeted re-dispatch for changed sections, consensus judging for security domains
- Crash-safe orchestrator: atomic state writes (`tmp` + `os.replace`), backup mirroring, PID-based lock file with liveness check, spec hash change detection on resume
- Self-improvement module: SNR-threshold prompt improvement queuing, metadata-only firewall, heuristic consolidation trigger
- Forge config section in `global/config.json` with domain routing, plan review routing, consensus settings, and threshold configuration
- `/stark-design` archived in favor of `superpowers:brainstorm` + `/stark-forge`

### Changed
- Skill count updated from 29 to 30
- CLAUDE.md updated with `/stark-forge` in pipeline and skills table

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
