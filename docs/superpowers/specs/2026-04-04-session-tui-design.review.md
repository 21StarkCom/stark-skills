# Plan Review — Session TUI Design

**File:** `docs/superpowers/specs/2026-04-04-session-tui-design.md`
**Reviewed:** 2026-04-04
**Rounds:** 3 fix rounds (no final review dispatch — max_rounds reached)
**Agents:** claude + codex (2 agents x 10 domains = 20 sub-agents per round)
**Triage:** Fell back to full mode each round (triage agent timed out — 15s default too short for large doc)

---

## Headline

**Issues found:** ~65 real issues addressed across 3 rounds | **Noise:** ~30 false positives / noise | **Ignored:** ~15 low-severity stylistic
**Signal-to-noise:** ~65% (improved in later rounds as recurring themes were recognized)

---

## Round-by-Round Summary

### Round 1 — 95 findings (2 critical, 39 high, 40 medium, 14 low)

Major structural gaps found and fixed:
- **No CLI entry point** for session_tui.py (critical) — SKILL.md cannot import Python modules
- **30s timeout unenforceable** from LLM-interpreted SKILL.md (high, 5 findings)
- **sanitize_text() missing Unicode bidi** characters (medium, 2 findings)
- **No integration or end-to-end gate** (high, 2 findings)
- **Session name no programmatic validation** (high) — LLM output needs slugify()
- **DiffSummary collection source unspecified** (high)
- **Session-scoped diff missing** — end diff anchored to HEAD~5 instead of session start
- **install.sh not addressed** for new scripts (high)
- **Rollback claims unverified** — session_state.py load() not checked (high)
- **No success criteria** (medium)
- **Error details may expose secrets** (high)
- **Parallel collection not specified** (high, 3 findings)
- **No phasing or timeline** (high)

### Round 2 — 114 findings (6 critical, 55 high, 40 medium, 13 low)

Findings mostly about gaps introduced by Round 1 fixes:
- **session_tui_cli.py not assigned to a phase** (critical) — fixed
- **slugify() missing from tui_core.py API** — was already there, round 2 missed it
- **Test count mismatch** (19 vs 23) — fixed
- **--name CLI flag not defined** — fixed
- **start_head persistence mechanism unspecified** — fixed
- **Pre-upgrade sessions lack start_head** — added fallback to merge-base
- **Phase 2/3 incorrectly declared parallel** — fixed (Phase 3 depends on 2)
- **Phase 4 fallback only handles import failures** — widened to all non-zero exits

### Round 3 — 109 findings (7 critical, 49 high, 41 medium, 12 low)

Final state findings — mix of valid residual issues and adversarial noise:
- **CLI missing session_id, repo, branch args** (critical) — fixed
- **started_at source in start mode undefined** (critical) — fixed
- **GitHub search date filter is day-granular** — fixed with timestamp comparison
- **PR collection command missing status fields** — already fixed in round 1
- **Persona data not collected by CLI** — added --persona flag
- **Python interpreter not specified** — added $PYTHON reference

---

## Fixed Issues (addressed across rounds)

| # | Round | Theme | Description |
|---|-------|-------|-------------|
| 1 | R1 | Architecture | Added `session_tui_cli.py` as CLI entry point bridging SKILL.md → Python |
| 2 | R1 | Security | Extended `sanitize_text()` to strip Unicode bidi overrides and zero-width chars |
| 3 | R1 | Security | Moved sanitization to data ingestion boundary (structural, not per-function) |
| 4 | R1 | Security | Added error redaction — reason codes in TUI, full text only in log with token redaction |
| 5 | R1 | Completeness | Added `slugify()` to tui_core.py for programmatic session name validation |
| 6 | R1 | Completeness | Added `start_head` to SessionState for session-scoped diffs |
| 7 | R1 | Completeness | Specified exact data collection commands for all sources |
| 8 | R1 | Completeness | Specified DiffSummary collection using `git diff --stat {start_head} HEAD` |
| 9 | R1 | Completeness | Specified health check, board, and alert data sources |
| 10 | R1 | Gates | Added success criteria (9 measurable conditions) |
| 11 | R1 | Gates | Added migration parity gate (byte-for-byte triage output match) |
| 12 | R1 | Gates | Added integration gates (pre-SKILL.md, post-SKILL.md, soak) |
| 13 | R1 | Gates | Added pre-extraction scan for private imports |
| 14 | R1 | Gates | Added gate failure path with 2-hour debug cap and fallback |
| 15 | R1 | Operability | Added parallel data collection with 45s wall-clock budget |
| 16 | R1 | Operability | Added `format_duration()` with sub-hour format rules |
| 17 | R1 | Operability | Made git optional in `render_start_briefing()` |
| 18 | R1 | Operability | Added session state recovery path for end mode |
| 19 | R1 | Rollback | Added 4-phase rollback plan with triggers |
| 20 | R1 | Rollback | Added unknown-key tolerance test for rollback safety |
| 21 | R1 | Timeline | Added phasing with gates and dependencies |
| 22 | R1 | Config | Added `STARK_PLAIN=1` env var for deterministic plain mode |
| 23 | R1 | Config | Documented `make_config(plain=True)` forcing `color=False` |
| 24 | R1 | Sequencing | Specified section rendering order in composition helpers |
| 25 | R1 | Sequencing | Specified truncation format for all list types |
| 26 | R1 | Install | Added install.sh and docs regeneration post-change steps |
| 27 | R2 | Completeness | Fixed test count (19 → 23 in success criteria) |
| 28 | R2 | Completeness | Added `--name` flag to CLI spec |
| 29 | R2 | Completeness | Added `--start-head` and `--started-at` CLI flags |
| 30 | R2 | Sequencing | Fixed Phase 2/3 dependency (not parallel) |
| 31 | R2 | Rollback | Widened Phase 4 fallback to handle all non-zero exits |
| 32 | R2 | Gates | Fixed soak gate circularity (merge after Gate 2, soak confirms async) |
| 33 | R2 | Operability | Added error log rotation and directory creation |
| 34 | R2 | Operability | Added ThreadPoolExecutor exception handling spec |
| 35 | R3 | Completeness | Added `--session-id`, `--repo`, `--persona` CLI flags |
| 36 | R3 | Completeness | Specified `started_at` source in start flow |
| 37 | R3 | Completeness | Fixed GitHub search date granularity |
| 38 | R3 | Completeness | Added $PYTHON/$SCRIPTS variables to SKILL.md flows |
| 39 | R3 | Completeness | Added pre-upgrade session fallback for missing start_head |

---

## Unresolved Findings (final round residual)

These remain from Round 3 and are documented design decisions or deferred scope:

| Severity | Theme | Finding | Rationale for Deferral |
|----------|-------|---------|----------------------|
| High | Timeline | No calendar time estimates per phase | Design spec, not execution plan — time estimates belong in the implementation plan |
| High | Gates | No gate owner defined | Single-developer project — author is gate owner |
| High | Operability | No operational telemetry after rollout | Deferred to post-soak. Error log provides initial observability |
| High | Feasibility | Health checks run serially in one thread | Each health check has individual 15s timeout within the pool; wall-clock budget applies to the pool overall |
| Medium | Gates | Soak gate not measurable | Soak criteria defined (rendering defect = blocker); quantifying "defect" further is unnecessary |
| Medium | Rollback | All rollbacks L0 (documented, not rehearsed) | Acceptable for dev tooling; rehearsal deferred to first real rollback need |
| Medium | Security | Health check commands can execute untrusted code | Health checks are configured by the repo owner in config.json, not external input — same trust model as npm scripts |

---

## Noise & False Positives

| Finding | Why Flagged | Why Noise |
|---------|-------------|-----------|
| `_BannerRequired` naming misleads | Python convention for underscore prefix | Standard TypedDict inheritance pattern — well-understood |
| `json_mode` documented dead code | Documented a code path that can't be reached | Acknowledging inherited behavior is documentation, not dead code |
| Session name fallback may exceed 50 chars | UUID-based fallback is 45 chars | Hypothetical future format change; slugify() truncates anyway |
| json_mode=True silent suppression | Accidental json_mode could suppress output | json_mode is never set for sessions; fail-open is correct |
| No communication plan for behavioral change | Users not notified of output format change | Dev tooling for one user — no notification needed |
| Gate 2 "destructive command path" | Invokes /stark-session which changes state | Session state is always created — this is normal operation, not destructive |
| `GH_TOKEN` unset not reliable for testing degraded path | Other auth mechanisms may exist | The test verifies graceful degradation, not absence of auth |

---

## Coverage Matrix

| Vector | general | completeness | security | feasibility | operability | sequencing | rollback | risk | gates | timeline |
|--------|---------|-------------|----------|-------------|-------------|------------|----------|------|-------|----------|
| A. Missing implementation detail | - | X | - | - | - | - | - | - | - | - |
| B. Security gap | - | - | X | - | - | - | - | - | - | - |
| C. Integration failure | - | X | - | X | - | X | - | X | X | - |
| D. Operational failure | - | - | - | - | X | - | - | - | - | - |
| E. Rollback failure | - | - | - | - | - | - | X | - | - | - |
| F. Gate/verification gap | - | - | - | - | - | - | - | - | X | - |
| G. Sequencing error | - | - | - | - | - | X | - | - | - | - |
| H. Timeline/resource risk | - | - | - | - | - | - | - | - | - | X |
| I. Scope creep | X | - | - | - | - | - | - | - | - | - |
| J. Configuration gap | X | X | - | - | X | - | - | - | - | - |

---

## Changes Made

264 lines added, 71 lines removed across the design spec. Major additions:

1. **Success Criteria** section (9 measurable conditions)
2. **Architecture** updated with `session_tui_cli.py` entry point
3. **tui_core.py** API expanded: `sanitize_text()` now strips Unicode bidi/ZWJ, added `slugify()`, documented `make_config` coupling
4. **triage_tui.py** migration: pre-extraction scan, parity gate, gate failure path with 2h debug cap
5. **session_tui.py** render contract: sanitization at ingestion boundary, optional git/diff, explicit section ordering, duration format rules, truncation behavior for all lists
6. **session_tui_cli.py** — new component: CLI entry point with enforced timeouts, parallel collection, error redaction, pre-upgrade fallback
7. **SKILL.md Integration** — concrete commands with all required args (session_id, repo, start-head, started-at, persona)
8. **Session State** — added `start_head` field, specified deserialization verification, slugify enforcement on name
9. **Data Collection** — exact commands for all sources (git, gh PRs, health checks, board, alerts)
10. **File Inventory** — added session_tui_cli.py, updated test counts, install.sh and docs regen steps
11. **Testing Strategy** — 23 tui_core tests (was 17), 21 session_tui tests (was 18), 3 session_state tests (was 1), integration gates
12. **Phasing** section — 4 phases with gates, dependencies, rollback procedures, and triggers

---

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Both agents repeatedly flag "no time estimates" on design specs | **Global** | `global/prompts/plan-review/*/09-timeline.md` — add context that design specs focus on architecture, not scheduling |
| Both agents flag "no gate owner" on single-developer projects | **Global** | `global/prompts/plan-review/*/08-gates.md` — add heuristic for project team size |
| Codex generates high counts of speculative "what if X breaks" findings that are not actionable | **Global** | `global/prompts/plan-review/codex/agent.md` — add instruction to distinguish "plausible failure sequence" from "speculative concern" |
| Triage timeout on large design docs | **Config** | Increase triage timeout from 15s to 30s for plan reviews, or use `--triage-agent codex` (may be faster for structured triage) |

---

## Triage Note

The triage agent (claude-sonnet) timed out on all 3 rounds (15s default, 2 retries each). The design doc is ~660 lines with complex TypedDict definitions — likely exceeded the triage prompt's context budget. All rounds fell back to full mode (10/10 domains dispatched). **Recommendation:** Increase `plan_review.triage.timeout` to 30s in config, or investigate whether the triage prompt can be made more concise for large documents.

---

## Bug Fix Applied During Review

Fixed `scripts/domain_triage.py:20` — `TRIAGE_DIR` used `Path(__file__).parent.parent` which failed when running from the symlinked install location (`~/.claude/code-review/scripts/`). Changed to `Path(__file__).resolve().parent.parent` to follow the symlink back to the repo root.
