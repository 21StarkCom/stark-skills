# stark-forge — End-to-End Design-to-Tasks Pipeline

> **ABANDONED — superseded 2026-07-19, then dropped outright 2026-08-07.** This is the FIRST
> stark-forge concept (8 **Python** modules). It was superseded by the 2026-07-19 spec + plan,
> which were themselves abandoned by owner decision; nothing from either shipped.
>
> **Its approach is now forbidden, not merely stale:** the repo is TypeScript-only under
> `tools/` and the former Python orchestrators under `scripts/` were migrated out and deleted.
> Do not implement anything below.

**Date:** 2026-04-11
**Status:** Abandoned (was: Design)
**Approach:** B — Phase-Based Pipeline with 8 Modules
**Schema Version:** 1

## Problem

The current design-to-implementation pipeline is a chain of independent skills (`/stark-review-design` → `/stark-design-to-plan` → `/stark-review-plan` → `/stark-plan-to-tasks`) with several weaknesses:

1. **No domain filtering.** All 12 review domains run on every design regardless of relevance. A backend connector gets accessibility review. A UI reskin gets data-modeling review. This wastes tokens and generates noise.

2. **Suboptimal model routing.** All domains route to the same agent(s) via the shared `domain_agents` config. Claude excels at architectural reasoning, Codex at mechanical correctness tracing, Gemini at cross-section pattern matching — but design review currently uses only the agents listed in `design_review.agents` (default: claude + codex) across all domains identically.

3. **Unresolved findings are tolerated.** The current system produces "unresolved findings" summaries. Findings that can't be fixed are reported but the pipeline continues. This means implementation starts from designs with known gaps.

4. **No crash recovery.** Multi-agent dispatch is memory-intensive. When subagents exhaust system memory and the process crashes, all progress is lost.

5. **No self-improvement loop.** When prompts generate noise, the only remediation is manual prompt editing via `/stark-review-improvement`.

6. **Manual orchestration.** The user must invoke 4+ skills in sequence, passing outputs between them manually.

## Solution

A single orchestrator skill (`/stark-forge`) that takes a design spec and sequences 4 phases through completion, with per-domain model routing, auto-detected domain filtering, crash recovery, and self-improving prompts.

**Pipeline position:** `superpowers:brainstorm → spec.md → /stark-forge → /stark-autopilot`

### The Iron Rule

Every finding classified as a real issue gets fixed. No exceptions, no "unresolved findings."

| Classification | Action |
|---|---|
| `fix` | The orchestrating LLM edits the spec/plan directly to address the finding, then commits |
| `noise` | Not an issue. Fed into the self-improvement loop to reduce future false positives |
| `blocked` | Real issue the system cannot resolve (missing external context, requires human decision). **Pipeline halts immediately** |

Each review phase gets up to 3 fix rounds. Round 4 is a verification-only pass — if ANY findings remain classified as `fix` or `blocked`, the pipeline stops. There is no concept of "unresolved findings."

**How fixes are applied:** The orchestrating LLM (Claude, running the SKILL.md) reads each `fix`-classified finding, reads the referenced section, and edits the document directly using the Edit tool. It does not delegate to a sub-agent. After all fixes in a round are applied, the changes are committed. The next round's reviewers see the committed state.

**How fixes are verified:** In subsequent rounds, reviewers re-examine previously fixed sections. If a reviewer re-flags the same section with the same concern, it's classified as `recurring` (must be re-addressed with a different approach). If it recurs a third time, the orchestrator classifies it as `blocked` — the finding is unfixable by the system, and the pipeline halts. Round 4 dispatches ALL active domains as a full verification pass.

### Isolation Guarantees

- **Always runs in a worktree.** Never in the user's working directory. The skill creates a worktree at startup (reuses existing if `--resume`). All commits happen in the worktree branch.
- **Never runs on main/master.** Hard guard: if the current branch is main or master, refuse to run. The worktree is created on a feature branch: `forge/<spec-name>`.

## Architecture

### Module Layout (8 modules)

```
scripts/
  forge_orchestrator.py   (~250 lines)  Phase sequencing, state machine, crash recovery, progress output
  forge_classifier.py     (~200 lines)  Tiered domain classification (heuristic → LLM → user confirm)
  forge_review.py         (~200 lines)  Phase 1: design review with model routing, Iron Rule, 4-round loop
  forge_plan.py           (~200 lines)  Phase 2: design→plan generation + plan review with Iron Rule
  forge_tdd.py            (~150 lines)  Phase 3: design+plan→TDD spec (v2 — stub in initial release)
  forge_tasks.py          (~150 lines)  Phase 4: plan+TDD→tasks decomposition
  forge_audit.py          (~200 lines)  Metrics per LLM call, signal-to-noise tracking, .forge-audit.json
  forge_improve.py        (~250 lines)  Noise analysis, prompt diff generation, heuristic curation, branch+PR
```

Each module is a focused Python unit (~150-250 lines) that fits in a single LLM context window. Modules import from existing dispatch infrastructure — they wrap and extend, not reimplement.

### Reuse Map

| forge module | imports from existing | what it adds |
|---|---|---|
| `forge_review.py` | `plan_review_dispatch.dispatch_plan_review(global_prompts_dir=DESIGN_REVIEW_DIR)`, `dispatcher_base.discover_domains()` | Must pass `global_prompts_dir` pointing to `prompts/design-review/` (default is `plan-review/`). Per-domain model routing via `agents` parameter override |
| `forge_plan.py` | `design_to_plan_dispatch.generate_plans()` + `cross_review_plans()` for generation; `plan_review_dispatch.dispatch_plan_review()` with `--prompts-dir plan-review` for review | Plan review uses its own domain set (see Phase 2), not design review's |
| `forge_tasks.py` | `plan_to_tasks_validate.dispatch_validators()` for 3-pass validation | Task generation via new LLM call, then validation via existing dispatch, then `gh issue create` for issue creation |
| `forge_classifier.py` | `domain_triage.triage_domains()` for Tier 2 | Tier 1 heuristic matching, heuristic learning |
| `forge_audit.py` | `config_loader` for config access | Per-call metrics, cross-run SNR tracking via SQLite |
| `forge_improve.py` | `config_loader` for config access | Prompt diff generation, heuristic curation, consolidation. PRs created via native `gh` CLI (user's PAT, not bot token — per auth split policy) |

### Input Contract

The input spec must be a markdown file. No specific heading structure is required — the heuristic classifier and LLM reviewers operate on raw content. However, specs that follow the existing convention (Problem → Solution → Architecture → sections) produce better-focused reviews because domain prompts reference these standard sections.

## Phase 0: Domain Classification

Three-tier classification, cheapest first. Determines which of the 12 domains are relevant to this spec.

### Tier 1 — Heuristic (no LLM, instant)

Pattern-match on spec content using rules from `forge_heuristics.json`. Fast, free, handles obvious cases.

**File location:** `~/.claude/code-review/forge_heuristics.json`. Shipped with default rules via `install.sh`. The consolidation pass and Tier 2 learning both modify this file (see Heuristic Learning below).

**Always-included domains:** `general`, `completeness`, `scope`, `consistency` — these apply to every design regardless of type.

**Conditionally-included domains:** Each has a set of keyword patterns and a match threshold.

| Domain | Trigger patterns (examples) | Threshold |
|---|---|---|
| `accessibility` | component, modal, button, screen, UI, frontend, React, ARIA | 3+ matches |
| `api-design` | endpoint, REST, GraphQL, API, route, request, response, payload | 2+ matches |
| `data-modeling` | database, schema, table, migration, SQL, PostgreSQL, index | 2+ matches |
| `security` | auth, token, encryption, TLS, credential, permission, RBAC | 2+ matches |
| `scalability` | cache, queue, partition, replica, load balancer, horizontal | 2+ matches |
| `resilience` | circuit breaker, retry, timeout, failover, health check, recovery | 2+ matches |
| `extensibility` | plugin, hook, adapter, interface, contract, extension point | 3+ matches |
| `test-plan` | test, coverage, assertion, mock, fixture, integration test | 3+ matches |
| `implementation-feasibility` | import, dispatch, validate, existing, reuse, calls, wraps | 2+ matches |

### Tier 2 — LLM Classification (only if heuristics are ambiguous)

When heuristics produce a low-confidence result (e.g., mixed signals, unusual spec structure), a single cheap LLM call (haiku-class) classifies the spec into a design type and returns the relevant domain set.

The classification result is recorded for Tier 1 learning: "spec about X was classified as backend-service, keywords that should have caught it: [list]."

### Tier 3 — User Confirmation (default unless `--auto-detect`)

```
Detected design type: backend-service

  Running:  general, completeness, security, api-design,
            data-modeling, scalability, resilience, scope, consistency
  Skipping: accessibility, test-plan, extensibility

  Override? [Enter=accept / e=edit / a=add domain / r=remove domain]
```

With `--auto-detect`: skip confirmation, use Tier 1/2 result directly. Intended for automation/CI.

### Heuristic Learning

The heuristics file (`forge_heuristics.json`) is a living knowledge base:
- **Growth:** Every Tier 2 LLM classification miss teaches Tier 1 new patterns. The patch records the new pattern, source domain, and timestamp.
- **Curation:** When `patches_since_consolidation` exceeds `heuristic_consolidation_threshold` (default: 5), a consolidation pass rewrites the entire file from scratch — clean, consistent, no redundant patterns
- **Consolidation is a PR:** The rewritten file is committed on an improvement branch and submitted as a PR for human review, not applied directly
- **Poisoning guard:** Tier 2 learning only extracts keyword patterns (single words or bigrams) from the LLM's classification explanation, never from the raw spec content. The LLM is prompted to explain *which existing domain concepts* the spec matched, not to extract arbitrary text from the spec.

### Heuristic File Schema

```json
{
  "version": 1,
  "last_consolidated": "2026-04-11T10:00:00Z",
  "patches_since_consolidation": 0,
  "rules": [
    {
      "domain": "accessibility",
      "patterns": ["component", "modal", "button", "screen", "UI", "frontend"],
      "threshold": 3,
      "source": "manual",
      "added_at": "2026-04-11T10:00:00Z",
      "confidence": 0.9
    }
  ],
  "classification_history": []
}
```

**Classification history** is stored separately in `~/.claude/code-review/forge_classification_log.jsonl` (append-only, one JSON object per line, rotated at 1000 entries). This keeps the heuristics file small and fast to load. Each entry:

```json
{"spec": "new-connector.md", "detected_type": "backend-service", "tier_used": 1, "domains_selected": ["general", "security"], "timestamp": "2026-04-11T10:30:00Z"}
```

## Phase 1: Design Review

### Per-Domain Model Routing

Each domain routes to the LLM(s) best suited for it. The routing table is in `config.json` under `forge.domain_routing`.

| Domain | Agent(s) | Rationale |
|---|---|---|
| `general` | claude | Systemic reasoning, gap identification |
| `completeness` | claude | Notices what's absent, long-context coherence |
| `security` | codex, gemini | Codex: execution tracing; Gemini: pattern matching at scale |
| `scope` | codex | Mechanical YAGNI detection |
| `api-design` | claude | Contract reasoning, spec-to-implementation gap analysis |
| `data-modeling` | codex | Schema correctness, constraint validation |
| `consistency` | gemini | Cross-section pattern recognition, large context |
| `scalability` | codex | Execution path tracing, bottleneck detection |
| `extensibility` | claude | Architectural reasoning, coupling analysis |
| `resilience` | codex | Failure mode enumeration, step-by-step path tracing |
| `accessibility` | claude | WCAG depth, semantic reasoning |
| `test-plan` | codex | Code-structure to test inference |
| `implementation-feasibility` | codex | Verifies referenced APIs, functions, and modules actually exist in the codebase. Catches specs that reference non-existent functions or wrong signatures. |

13 domains total (12 existing + 1 new). Most domains get one agent. Security gets two with consensus.

**The `implementation-feasibility` domain** is new to forge. It addresses a gap discovered during this spec's own review: existing domains review design logic but none verify that the spec's implementation plan references real codebase APIs. This domain's prompt instructs the reviewer to grep for every function, class, and module name referenced in the spec and flag any that don't exist or have different signatures. Routed to Codex for its mechanical execution tracing strength.

### Per-Domain Dispatch Strategy

`forge_review.py` does NOT call `dispatch_plan_review()` once per domain. It groups domains by their routed agent and issues one call per agent group, each with `global_prompts_dir` pointing to `prompts/design-review/`:

```python
# ~3-4 calls instead of 12:
dispatch_plan_review(agents=["claude"], domains=["general", "completeness", "api-design", ...],
                     global_prompts_dir=DESIGN_REVIEW_PROMPTS_DIR)
dispatch_plan_review(agents=["codex"], domains=["scope", "data-modeling", "scalability", ...],
                     global_prompts_dir=DESIGN_REVIEW_PROMPTS_DIR)
dispatch_plan_review(agents=["gemini"], domains=["consistency"],
                     global_prompts_dir=DESIGN_REVIEW_PROMPTS_DIR)
# Security (consensus) dispatches to both agents:
dispatch_plan_review(agents=["codex", "gemini"], domains=["security"],
                     global_prompts_dir=DESIGN_REVIEW_PROMPTS_DIR)
```

This keeps the worker pool flat and avoids nested thread pool explosion. If an agent is disabled in config, its domains fall back to the next agent in `forge.agent_fallback_order` (default: `["claude", "codex", "gemini"]`).

**Single-agent failure handling:** If an agent's call fails after retries (inherited from `plan_review_dispatch.py` — 2 attempts with exponential backoff), the domain is marked as `agent_failed` in the audit and the round continues without it. If >50% of domains fail, the round is treated as a dispatch failure.

### Consensus Domains

Domains listed in `forge.consensus_domains` require multi-agent agreement. For these domains:

1. All listed agents review independently
2. A lightweight LLM judge pass (haiku-class) receives both agents' finding lists and groups semantically similar findings. The judge prompt: "Given these two sets of findings for the same section, which findings describe the same underlying issue? Output pairs." Judge input: finding titles + descriptions only (no spec content). Judge output: list of `{finding_a_index, finding_b_index, confidence}`.
3. Findings confirmed by `consensus_threshold` (default: 2) agents survive as `fix` candidates
4. Single-agent findings in consensus domains are flagged with `consensus: "single_agent"` in the audit but **NOT automatically classified as noise**. Instead, they are presented to the orchestrating LLM with a note: "This finding was flagged by only one agent in a consensus domain. Classify with higher scrutiny — it may be a valid edge case or a false positive."

**Consensus degradation:** If one agent in a consensus domain fails after retries, the domain temporarily falls back to single-agent mode for that round. The audit records `consensus_degraded: true`. Findings from the surviving agent are treated as normal (not auto-noise).

### Iron Rule Review Loop

```
Round 1: dispatch (per routing table) → classify findings → fix all "fix" findings → commit
Round 2: re-dispatch changed domains only → verify fixes, find new issues → fix → commit
Round 3: re-dispatch changed domains only → final fixes → commit
Round 4: re-dispatch ALL active domains → HALT CHECK
  └── 0 findings classified as "fix" or "blocked" → design is clean, proceed to Phase 2
  └── Any findings remain as "fix" or "blocked" → HALT — pipeline stops
```

**Targeted re-dispatch (rounds 2-3):** After fixes, only domains whose sections were modified are re-dispatched. The orchestrator diffs the committed changes to identify which sections changed, maps sections to domains, and dispatches only those domains. Always-included domains (`general`, `consistency`) are re-dispatched every round since they assess holistic properties. Round 4 always dispatches ALL active domains as a full verification pass.

**Finding classification** (done by the orchestrating LLM running the skill):

| Status | Criteria |
|---|---|
| `fix` | Severity >= fix_threshold AND the issue actually exists in the design |
| `noise` | False positive, subjective, stylistic, or contradicted by design intent |
| `blocked` | Real issue but the system cannot fix it (missing context, external dependency) → triggers HALT immediately |

Cross-reference: 2+ agents flagging the same section with the same concern = `high_confidence` → always `fix`.

**Early termination:** If any round produces 0 findings classified as `fix`, skip remaining fix rounds and jump directly to the round 4 full verification pass.

### Fix Mechanism

When the Iron Rule loop classifies findings as `fix`, the orchestrating LLM rewrites the affected spec sections:

**Agent:** Claude (the LLM running the SKILL.md). Hardcoded — this is structural editing, not domain analysis.

**Input per fix call:** The finding (domain, severity, description, section reference), the full text of the referenced section, and the complete spec for cross-reference context.

**Batching:** Multiple `fix` findings targeting the same section are batched into a single fix to avoid conflicting rewrites. Findings targeting different sections are fixed sequentially.

**Commit:** After all fixes in a round are applied, a single commit captures the round.

**Guardrail:** The fix is instructed to resolve the finding and nothing else. If a fix introduces scope creep (new sections, new requirements), the next review round will catch it.

### Finding Identity

Each finding is assigned a stable ID for cross-round tracking:

```
finding_id = sha256(agent + domain + section_heading + title)[:12]
```

This allows the orchestrator to track whether a finding from round N was resolved, persists, or recurred in round N+1. The state file records per-round finding IDs with their classifications.

### Cost Reduction

- Current system: 2 agents × 12 domains = 24 LLM calls per round
- Forge round 1 with 9 active domains (typical backend): ~10 calls (58% reduction)
- Rounds 2-3 with targeted re-dispatch: typically 3-5 calls (further reduction)

## Phase 2: Plan Generation + Plan Review

### Generation

Call `design_to_plan_dispatch.generate_plans()` to produce candidate plans from each enabled agent, then `cross_review_plans()` to have agents cross-review each other's plans and select the best. The winning plan follows the writing-plans skill conventions:
- Bite-sized task granularity (2-5 minute steps)
- No placeholders — every task has exact file paths, actual code, exact commands
- TDD-first: write failing test → implement → verify → commit

### Plan Review

Same Iron Rule loop as Phase 1 (up to 3 fix rounds, round 4 = halt check). Plan review uses its own domain set from `global/prompts/plan-review/domains/`, which is distinct from the design review domains:

| Plan-review domain | Routed agent | Rationale |
|---|---|---|
| `general` | claude | Systemic plan coherence |
| `completeness` | claude | Missing steps, gaps |
| `correctness` | codex | Can each step actually be executed as written? |
| `scope` | codex | YAGNI in plan steps |
| `risk` | claude | Risk identification and mitigation |
| `sequencing` | claude | Dependency ordering, parallelism |
| `testing` | codex | Test coverage in plan steps |
| `integration` | codex | Cross-component integration points |
| `rollback` | codex | Recovery paths if steps fail |
| `observability` | codex | Monitoring, logging, alerting steps |

Phase 0 classification does NOT carry forward to plan review — all 10 plan review domains run by default. Every plan needs correctness, sequencing, and rollback review regardless of design type. The `forge.plan_review_routing` config section controls this routing table (separate from `forge.domain_routing` which is Phase 1 only).

## Phase 3: TDD Specification (v2)

Stubbed in the initial release. Returns a clean skip message:

```
Phase 3: TDD Spec — skipped (available in v2)
```

The `forge_tdd.py` module contains only a skip function (~20 lines). No state schema entry, no terminal output section, no architecture budget beyond the stub.

### v2 Design Intent (informational, not binding)

When implemented, Phase 3 will generate test specifications from the clean design + plan. Detailed requirements will be designed when v2 is scoped.

## Phase 4: Task Decomposition

Two-step process:

1. **Generate tasks:** A new LLM call decomposes the clean plan into phased tasks with acceptance criteria. Output is structured JSON.
2. **Validate tasks:** Call `plan_to_tasks_validate.dispatch_validators()` for 3-pass validation (existing logic — checks completeness, consistency, and implementability across 3 LLM passes).
3. **Create issues:** Call `gh issue create` (native CLI, user's PAT) for each validated task. Phase grouping via GitHub labels for `/stark-autopilot` consumption.

**Idempotent issue creation:** Before creating issues, `forge_tasks.py` searches for existing issues with the same title prefix on the forge branch. If found (e.g., from a previous interrupted run), it skips creation and records the existing issue numbers in the state file as `phases.tasks.issue_numbers: [1, 2, 3]` so that resume never creates duplicates.

Output: GitHub issues created on the forge branch.

## Crash Recovery

### Checkpoint Strategy

State persisted to `.forge-state.json` **in the worktree root** (co-located with the branch, survives crashes).

**Atomic writes:** State file is always written atomically: write to `.forge-state.json.tmp`, then `os.replace()` to `.forge-state.json`. This prevents corruption from crashes during write.

**Backup:** On every state write, a copy is also written to `~/.claude/code-review/history/forge/<spec-name>/state-backup.json`. If the worktree is pruned (by `git worktree prune`, manual cleanup, or `/stark-housekeeping`), the backup allows `--resume` to detect the situation and recreate the worktree from the forge branch (which still exists in git). The backup is a safety net — the worktree state file remains authoritative when it exists.

**Checkpoint sequence:**
1. Before each phase: write status = `"starting"` + phase inputs hash
2. After each review round: write finding IDs and classifications
3. After each commit: record commit SHA
4. Before external side effects: record intent (e.g., "creating issue: title X")
5. Phase completion: write status = `"completed"` + outputs

**Authority split:** Git commits are authoritative for content changes. The state file is authoritative for pipeline progress. On conflict (state says round 1 not completed but git log shows a round 1 commit), trust git.

### State File Schema

```json
{
  "version": 1,
  "spec": "docs/specs/2026-04-11-new-connector.md",
  "spec_hash": "sha256:abc123",
  "worktree": "/tmp/stark-forge-new-connector",
  "branch": "forge/new-connector",
  "started_at": "2026-04-11T10:00:00Z",
  "design_type": "backend-service",
  "domains": ["general", "completeness", "security", "api-design", "data-modeling", "scalability", "resilience", "scope", "consistency"],
  "skipped_domains": ["accessibility", "test-plan", "extensibility"],
  "phases": {
    "classify": { "status": "completed", "duration_s": 2.1 },
    "design_review": {
      "status": "starting",
      "current_round": 2,
      "rounds_completed": [
        {
          "round": 1,
          "findings": [
            {"id": "a1b2c3d4e5f6", "status": "fix", "agent": "claude", "domain": "general", "title": "..."},
            {"id": "f7g8h9i0j1k2", "status": "noise", "agent": "codex", "domain": "scope", "title": "..."}
          ],
          "commit": "a1b2c3d"
        }
      ]
    },
    "plan": { "status": "pending" },
    "tdd": { "status": "pending" },
    "tasks": { "status": "pending", "issue_numbers": [] }
  },
  "halted": false,
  "halt_reason": null
}
```

**Schema versioning:** When `forge_orchestrator.py` reads a state file, it checks the `version` field. If the version is older than the current code expects, it logs a warning and attempts to read with best-effort compatibility (missing fields get defaults). If the version is newer (state file from a newer forge version), it refuses to resume and asks the user to update forge. Version bumps are documented in the forge changelog.

### Resume Logic

On `--resume`:
1. Derive branch name from spec path (see Worktree-to-spec mapping below)
2. Locate worktree via `git worktree list --porcelain`, filtering for the derived branch name. This is more reliable than path derivation since worktree paths can vary.
3. Read `.forge-state.json` from the located worktree (if not found, check backup at `~/.claude/code-review/history/forge/<spec-name>/state-backup.json`; if neither exists: "No forge state found. Run without --resume to start fresh.")
3. **Clean up partial outputs** from any interrupted phase before re-dispatch
4. For each phase:
   - `"completed"` → skip, use cached outputs
   - `"starting"` → phase was interrupted; check git log for commits from this phase to determine actual progress, then re-run the interrupted round on the current file state
   - `"pending"` → run normally

**Worktree-to-spec mapping:** The branch name is derived deterministically from the spec filename:

1. Strip extension (`.md`)
2. Strip leading date prefix (`YYYY-MM-DD-`)
3. Replace spaces and underscores with hyphens
4. Strip characters not in `[a-zA-Z0-9-]`
5. Truncate to 50 characters (git branch name hygiene)
6. Prefix with `forge/`

Example: `2026-04-11-stark-forge-design.md` → `forge/stark-forge-design`
Example: `My Cool Feature_v2.md` → `forge/My-Cool-Feature-v2`

If the derived worktree already exists and `--resume` was NOT passed, abort with: "Worktree forge/X already exists. Use --resume to continue or delete it first." If `--resume` was passed and the worktree doesn't exist, abort with: "No forge worktree found for this spec."

**Concurrent run protection:** Before starting, `forge_orchestrator.py` checks for a lock file (`.forge-lock`) in the worktree. If present, check if the PID recorded in it is still running. If yes, abort with "Another forge run is active on this worktree (PID: N)." If the PID is dead, remove the stale lock and proceed. The lock file is removed on normal completion or HALT.

### Memory Pressure Mitigation

- Phases run sequentially, never in parallel across phases
- Within a phase, `forge.workers` config caps concurrent agent subprocesses (default: 3)
- `--workers N` flag overrides for low-memory situations (e.g., `--workers 1` runs agents sequentially)
- Each phase module releases all subprocess handles before returning

### LLM Call Resilience

All LLM calls (review dispatch, consensus judge, Tier 2 classification) use the retry logic inherited from the existing dispatch scripts (`plan_review_dispatch.py` lines 310-376): 2 attempts with exponential backoff (5s first retry). Gemini has an additional API key fallback path. Codex gets 2x timeout due to reasoning mode.

If a specific agent call fails after retries, the domain is marked as failed in the audit and the round continues without it. This is existing behavior in `plan_review_dispatch.py` — forge inherits it.

## Metrics & Audit

### Per-Call Tracking

Every LLM call is logged to `.forge-audit.json` in the worktree root (co-located with state file):

```json
{
  "calls": [
    {
      "phase": "design_review",
      "round": 1,
      "agent": "claude",
      "domain": "general",
      "duration_s": 12.3,
      "findings_count": 3,
      "findings_fix": 2,
      "findings_noise": 1,
      "error": null
    }
  ],
  "summary": {
    "total_calls": 28,
    "total_duration_s": 498,
    "total_findings_fix": 13,
    "total_findings_noise": 5,
    "signal_to_noise": 0.72,
    "by_domain": {
      "security": { "calls": 4, "fix": 3, "noise": 0, "snr": 1.0 },
      "scope": { "calls": 3, "fix": 1, "noise": 2, "snr": 0.33 }
    },
    "by_agent": {
      "claude": { "calls": 12, "fix": 8, "noise": 1, "snr": 0.89 },
      "codex": { "calls": 10, "fix": 7, "noise": 3, "snr": 0.70 },
      "gemini": { "calls": 6, "fix": 3, "noise": 1, "snr": 0.75 }
    },
    "estimated_cost_usd": 2.40
  }
}
```

**Terminology:** In all audit data, `fix` means findings classified as real issues that were fixed. `noise` means findings classified as false positives. `findings` without qualifier in prose means `fix + noise` (total findings before classification). In structured data, `fix` and `noise` are always separate fields — never ambiguous.

### Signal-to-Noise Tracking (Cross-Run)

Cross-run SNR data is stored in a SQLite database at `~/.claude/code-review/forge_metrics.db` with tables:

- `runs(run_id, spec, design_type, timestamp, total_fix, total_noise, snr)`
- `domain_stats(run_id, domain, agent, fix, noise, snr)`

The self-improvement loop queries the last 10 runs per domain to compute rolling SNR. SQLite handles concurrent reads safely. Writes are serialized per-process (forge runs sequentially within a worktree, and the lock file prevents concurrent runs on the same worktree).

**Retention:** Rows older than 90 days are pruned on each forge run (simple `DELETE WHERE timestamp < ?`).

## Self-Improvement

### Trigger Conditions

1. **Domain noise threshold exceeded:** A domain's false positive rate exceeds 30% across the last 10 runs (queried from `forge_metrics.db`)
2. **Heuristic consolidation needed:** `patches_since_consolidation` in `forge_heuristics.json` exceeds `heuristic_consolidation_threshold`

### Improvement Actions

| Trigger | Action |
|---|---|
| Domain noise high | Generate prompt diff for the noisy domain, commit on improvement branch, create PR |
| Heuristic consolidation | Rewrite `forge_heuristics.json` from scratch using classification log, commit on improvement branch, create PR |

### Security Firewall

`forge_improve.py` generates prompt diffs and routing changes from **run metadata only** — domain IDs, agent IDs, finding counts per severity level, signal-to-noise ratios, and the domain prompt text itself. It NEVER receives raw spec content, finding descriptions, or finding titles. The improvement prompt is: "This domain prompt produced N noise findings and M real findings across the last 10 runs. Here is the current prompt. How should it be adjusted to reduce false positives while maintaining detection of real issues?"

**Routing change firewall:** When proposing model routing changes (e.g., moving a domain from codex to claude), `forge_improve.py` uses the same metadata-only constraint. The routing change prompt receives: domain ID, current agent, per-agent SNR for that domain across 10 runs, and the current routing table. It does NOT receive which specific findings were noise or what specs produced them. This prevents adversarial specs from influencing which models review which domains.

### Consolidation Pass

When the heuristics file accumulates 5+ patches:
1. Load current rules and classification log (`forge_classification_log.jsonl`)
2. LLM rewrites the entire rules file from scratch — clean, consistent, no redundant patterns, no dead rules
3. Diff against current file
4. Commit on improvement branch, create PR for human review

This ensures the heuristics file never becomes a patchwork of incremental additions.

## Configuration

### Config Schema (`config.json` → `forge` section)

```json
{
  "forge": {
    "max_rounds": 3,
    "halt_round": 4,
    "workers": 3,
    "fix_threshold": "medium",
    "domain_routing": {
      "general":       { "agents": ["claude"] },
      "completeness":  { "agents": ["claude"] },
      "security":      { "agents": ["codex", "gemini"] },
      "scope":         { "agents": ["codex"] },
      "api-design":    { "agents": ["claude"] },
      "data-modeling": { "agents": ["codex"] },
      "consistency":   { "agents": ["gemini"] },
      "scalability":   { "agents": ["codex"] },
      "extensibility": { "agents": ["claude"] },
      "resilience":    { "agents": ["codex"] },
      "accessibility":              { "agents": ["claude"] },
      "test-plan":                  { "agents": ["codex"] },
      "implementation-feasibility": { "agents": ["codex"] }
    },
    "agent_fallback_order": ["claude", "codex", "gemini"],
    "plan_review_routing": {
      "general":       { "agents": ["claude"] },
      "completeness":  { "agents": ["claude"] },
      "correctness":   { "agents": ["codex"] },
      "scope":         { "agents": ["codex"] },
      "risk":          { "agents": ["claude"] },
      "sequencing":    { "agents": ["claude"] },
      "testing":       { "agents": ["codex"] },
      "integration":   { "agents": ["codex"] },
      "rollback":      { "agents": ["codex"] },
      "observability": { "agents": ["codex"] }
    },
    "consensus_domains": ["security"],
    "consensus_threshold": 2,
    "noise_improvement_threshold": 0.3,
    "heuristic_consolidation_threshold": 5
  }
}
```

**Valid values:**
- `fix_threshold`: `"low"` | `"medium"` | `"high"` | `"critical"` — minimum severity to classify as `fix`
- `max_rounds`: integer 1-5 — fix rounds before halt check
- `halt_round`: integer, must be `max_rounds + 1` — the verification-only round
- `workers`: integer 1-10 — max concurrent agent subprocesses
- Phase status values: `"pending"` | `"starting"` | `"completed"`

All values are overridable per-repo in `.code-review/config.json`.

## Skill Interface

### Invocation

```
/stark-forge <path> [--auto-detect] [--dry-run] [--resume] [--workers N]
```

| Flag | Effect |
|---|---|
| `<path>` | Path to design spec markdown file (required) |
| `--auto-detect` | Skip domain confirmation, trust classifier |
| `--dry-run` | Review only round (round 1 of Phase 1 only), no fixes, no commits, no downstream phases. Reports findings and exits. |
| `--resume` | Resume from last checkpoint after crash or halt |
| `--workers N` | Override concurrent agent limit (default: 3, use 1 for low-memory) |

**Exit codes (for automation):**
- `0` — pipeline completed successfully
- `1` — pipeline halted (findings remain after max rounds)
- `2` — dispatch failure (agents unavailable)
- `3` — invalid input (file not found, on main branch, etc.)

**Structured output:** When stdout is not a TTY (piped or in CI), the final summary is emitted as JSON to stdout. Progress output always goes to stderr.

### Worktree Lifecycle

```
/stark-forge docs/specs/new-connector.md
  │
  ├── Verify not on main/master (hard guard)
  ├── Create worktree: forge/new-connector (branched from current HEAD)
  │   Branch name: forge/<spec-name-without-date>
  │   Worktree path: <git-root>/.worktrees/forge-<spec-name>
  ├── Copy spec into worktree
  ├── All phases run inside worktree
  ├── All commits on forge/new-connector branch
  │
  ├── On completion:
  │   "Pipeline complete. Branch: forge/new-connector
  │    Worktree: <path>
  │    Next: /stark-autopilot forge/new-connector"
  │
  └── On HALT:
      "Pipeline halted on branch forge/new-connector
       Worktree: <path>
       Fix the spec in the worktree and run:
       /stark-forge docs/specs/new-connector.md --resume"
```

**Worktree cleanup:** The worktree is NOT automatically cleaned up after completion — `/stark-autopilot` needs it. Cleanup happens when `/stark-autopilot` completes or when `/stark-housekeeping` runs. The forge branch name (`forge/<spec-name>`) is the durable identifier; the worktree path is ephemeral.

### Terminal Output

The skill uses Claude's TaskCreate/TaskUpdate for live progress tracking. Additionally, rich text output shows phase progress, round results, and flags.

Progress lines use text labels as the primary status indicator (e.g., `[OK]`, `[FAIL]`, `[SKIP]`, `[HALT]`) with optional emoji as secondary decoration. This ensures readability in all terminal environments.

**Normal completion:**
```
--- /stark-forge ------------------------------------------
  Spec: docs/specs/2026-04-11-new-connector.md
  Worktree: forge/new-connector

  Phase 0: Classify
  [DETECT] backend-service
  [RUN]  general, completeness, security, api-design,
         data-modeling, scalability, resilience, scope, consistency
  [SKIP] accessibility, test-plan, extensibility

  Phase 1: Design Review
  -- Round 1 --
  claude:general [OK]  codex:security [OK]
  gemini:security [OK]  claude:api-design [OK]  ...
  Findings: 7 fix, 3 noise
  Fixing 7 issues... [OK] committed (a1b2c3d)

  -- Round 2 --
  Findings: 2 fix, 1 noise
  Fixing 2 issues... [OK] committed (d4e5f6g)

  -- Round 3 --
  Findings: 0 fix [OK] Design is clean

  Phase 2: Plan Generation + Review
  -- Generate --
  Generating plan... [OK] committed (h7i8j9k)

  -- Round 1 --
  Findings: 4 fix, 1 noise
  Fixing 4 issues... [OK] committed (l0m1n2o)

  -- Round 2 --
  Findings: 0 fix [OK] Plan is clean

  Phase 3: TDD Spec [SKIP] (v2)

  Phase 4: Tasks
  Creating issues... 12 tasks across 3 phases [OK]

  --- Summary ---
  Total rounds: 5 (3 design + 2 plan)
  Issues fixed: 13 | Noise filtered: 5
  Signal-to-noise: 72%
  Cost: ~$2.40 (est.)
  Duration: 8m 23s
  Audit: .forge-audit.json

  FLAG: Noise ratio in 'scope' domain exceeded 30% — improvement queued
-----------------------------------------------------------
```

**HALT output:**
```
  -- Round 4 (HALT CHECK) --
  FLAG: HALT — 2 findings remain after 3 fix rounds

  1. [high] security: "Auth token rotation not specified"
     Could not resolve: design lacks infrastructure context

  2. [medium] api-design: "Pagination strategy undefined"
     Attempted fix in round 2, reviewer rejected in round 3

  Pipeline stopped. Fix manually and run:
  /stark-forge docs/specs/new-connector.md --resume
```

## What This Replaces

| Current skill | Status after forge ships |
|---|---|
| `/stark-design` | **Archive.** Specs come from `superpowers:brainstorm`. This skill will be removed from the install. |
| `/stark-review-design` | Subsumed by forge Phase 1. **Remains available** for standalone use (quick one-off reviews without the full pipeline). |
| `/stark-design-to-plan` | Subsumed by forge Phase 2. **Remains available** for standalone use. |
| `/stark-review-plan` | Subsumed by forge Phase 2. **Remains available** for standalone use. |
| `/stark-plan-to-tasks` | Subsumed by forge Phase 4. **Remains available** for standalone use. |

**Migration:** Users who invoke these skills directly in scripts or documentation should update to `/stark-forge` for the full pipeline. The standalone skills are not deprecated — they serve a different use case (ad-hoc, single-phase work). No backward compatibility shims are needed.

## Test Strategy

### Unit Tests

Each forge module gets a test file in `tests/`:

| Module | Test focus |
|---|---|
| `test_forge_classifier.py` | Tier 1 pattern matching accuracy, threshold logic, heuristic file parsing |
| `test_forge_review.py` | Finding ID generation, targeted re-dispatch section-to-domain mapping |
| `test_forge_audit.py` | Audit JSON schema correctness, SNR calculation, SQLite read/write |
| `test_forge_orchestrator.py` | State machine transitions, atomic write behavior, lock file logic |
| `test_forge_improve.py` | Firewall enforcement (no spec content in improvement prompt) |
| `test_forge_tasks.py` | Idempotent issue detection |

### Integration Tests

- **Crash recovery matrix:** Simulate crashes at each state transition (starting → completed), verify resume produces correct behavior. Test: corrupt state file, missing state file, stale lock file, git commit without state update.
- **End-to-end dry run:** Feed a known spec through `--dry-run`, verify findings output matches expected domains.
- **Security guards:** Verify main branch rejection, worktree isolation, firewall enforcement.

### Acceptance Criteria

Forge v1 is complete when:
1. A spec can be processed through all 4 phases (with Phase 3 stubbed) without manual intervention
2. The Iron Rule holds: either all findings are fixed or the pipeline halts
3. Crash recovery works: kill the process mid-phase, resume produces the same final result
4. Domain classification correctly skips irrelevant domains for backend-only and frontend-only specs
5. Audit file accurately reflects all LLM calls and their outcomes

## Alternatives Considered

- **Approach A — Single Monolithic Orchestrator:** One ~800-1000 line script handling all phases. Simpler wiring but harder to reason about, test, and debug. Rejected for poor maintainability.
- **Approach C — Thin SKILL.md with no Python:** Have the SKILL.md prompt orchestrate phases directly via LLM. Rejected because simple orchestration tasks (state management, config parsing, audit logging) should not consume LLM tokens.

## Open Questions

1. **Phase 3 (TDD) scope and timeline** — Revisit after forge v1 has been used on 5+ specs. **Owner:** Aryeh. **Gate:** Does not block v1 implementation.
2. **Gemini allocation** — Gemini currently routes to only `consistency` and `security` (consensus). Monitor after v1 launch: if Gemini's SNR in these domains is strong, expand to `scalability` and `resilience`. **Owner:** Aryeh. **Gate:** Does not block v1; data-driven decision after 10+ runs.
3. **Cross-repo noise aggregation** — Should self-improvement analyze noise patterns across repos? **Owner:** Aryeh. **Gate:** v2 consideration; single-repo aggregation is sufficient for v1.
