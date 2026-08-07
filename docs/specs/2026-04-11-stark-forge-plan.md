# stark-forge Implementation Plan

> **ABANDONED — do NOT implement this plan.** Superseded 2026-07-19, then stark-forge was
> dropped outright by owner decision 2026-08-07. Nothing shipped from any iteration.
>
> The instruction that used to sit here told an agentic worker to execute the plan
> task-by-task. It is removed rather than left below this banner, because a worker that reads
> a directive and stops has already started — and what it would build is **8 Python modules**,
> in a repo that is TypeScript-only under `tools/` and deleted its Python orchestrators.
>
> Design: `2026-04-11-stark-forge-design.md`. Later iteration: `2026-07-19-stark-forge-spec.md`
> + `docs/plans/2026-07-19-stark-forge-plan.md`. All abandoned.

**Goal:** Build `/stark-forge` as 8 Python modules + 1 skill that wraps existing dispatch primitives into an end-to-end design-to-tasks pipeline with per-domain model routing, crash recovery, and self-improvement.

**Architecture:** Phase-based pipeline orchestrator (`forge_orchestrator.py`) sequences 4 design phases, delegates domain dispatch to existing `plan_review_dispatch.py` / `design_to_plan_dispatch.py` / `plan_to_tasks_validate.py`, manages crash-safe state via atomic `.forge-state.json`, and never touches main/master.

**Tech Stack:** Python 3.11+, SQLite (stdlib), pytest, git worktrees, `gh` CLI (native auth)

**Source plan:** Codex (7.9/10), with audit-first phasing from Gemini (5.8/10) and cross-review weakness fixes from all 4 reviewers.

---

## Prerequisites

- `python3`, `pytest`, `git`, `gh` (authenticated with user PAT), `sqlite3` (Python stdlib)
- Enabled agent CLIs: `claude`, `codex`, optional `gemini`
- Writable `~/.claude/code-review/` and `~/.claude/skills/`
- Repo baseline: `./install.sh && gh auth status`

**Design decisions to lock before coding:**

1. **Prompt isolation:** Forge uses its own prompt trees (`global/prompts/forge-design-review/` and `global/prompts/forge-plan-review/`) to avoid silently changing `/stark-review-design` or `/stark-review-plan`. Prompts can be symlinked to existing files where identical, but the directory must be separate. Use **absolute symlinks** (not relative) to avoid breakage when install.sh copies files to `~/.claude/code-review/prompts/`.
2. **Test location:** Follow existing repo convention: `scripts/test_forge_*.py`.
3. **State schema for TDD stub:** Include `"tdd": {"status": "pending"}` in state — keep the schema stable for v2. The stub sets it to `"completed"` immediately. (This overrides the design spec's "no state schema entry" statement — the plan's approach is correct for v2 compatibility.)
4. **Domain dict format:** `dispatch_plan_review()` signature is `dispatch_plan_review(plan_content: str, round_num: int, ..., agents: list[str] | None, domains: dict[str, dict[str, Any]] | None, ...)`. Both `plan_content` and `round_num` are required positional args. `domains` is a dict, not a list. Forge builds filtered domain dicts from `discover_domains()` output.
5. **SQLite WAL mode:** All connections to `forge_metrics.db` (stored at `~/.claude/code-review/forge_metrics.db`) set `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout=5000` on open.
6. **`halt_round` is always `max_rounds + 1`:** Never hardcode "round 4". Always compute `halt_round = cfg["max_rounds"] + 1`. If someone sets `max_rounds=5`, halt round is 6.
7. **`--dry-run` semantics:** Run round 1 of Phase 1 (design review) only, report findings to terminal, then exit with code 0. No fixes, no commits, no plan generation, no issue creation, no downstream phases.
8. **GH_TOKEN lifecycle:** Before any `gh` CLI call that must use user PAT (issue creation, PR creation), call `unset GH_TOKEN` to ensure native auth. Before any bot-identity review comment posting, `export GH_TOKEN=$(github_app.py token)`. Document this sequence in forge_orchestrator.py. Never let a bot token leak into `gh issue create`.
9. **`config_loader.py` cache:** Tests must call `load_config.cache_clear()` in setup/teardown fixtures to avoid cross-test stale values from `@lru_cache`.
10. **TaskCreate/TaskUpdate are Claude Code tools:** These are called from the SKILL.md prompt (which the LLM executes), NOT from Python modules. Python modules emit structured progress to stderr; the SKILL.md reads that output and calls TaskCreate/TaskUpdate.
11. **`--workers N` limitation:** `dispatch_plan_review()` uses its own internal `MAX_WORKERS = 21`. The `--workers N` flag controls how many agent groups are dispatched concurrently from `forge_review.py` (sequential if `--workers 1`), but does NOT override the internal thread pool within each dispatch call. Document this limitation. For true sequential operation, pass `--workers 1` AND set `forge.workers: 1` in config.
12. **Cost guardrails:** Reference existing `cost.hard_stop_usd` from config. Before each dispatch, check accumulated cost against hard stop. If exceeded, HALT with "Cost budget exceeded" (exit code 1).

---

## Phase 1: Foundations (Config, Audit, Skill, Install)

**Goal:** Config, audit infrastructure, skill definition, prompt scaffolding, and install wiring. No runtime behavior yet, but everything needed for Phase 2 to build on.
**Dependencies:** None
**Effort:** M

### Task 1.1: Forge config and config_loader integration

**Files:**
- Modify: `global/config.json`
- Modify: `scripts/config_loader.py`

- [ ] **Step 1:** Add `forge` section to `global/config.json` with all keys from the design spec (domain_routing, plan_review_routing, agent_fallback_order, consensus_domains, consensus_threshold, max_rounds, halt_round, workers, fix_threshold, noise_improvement_threshold, heuristic_consolidation_threshold)

- [ ] **Step 2:** Add `DEFAULT_FORGE` dict and `get_forge_config()` function to `config_loader.py` using the same deep-merge pattern as existing section accessors. Add `forge` to `_SECTION_DEFAULTS`.

- [ ] **Step 3:** Write test `scripts/test_forge_config.py` — verify `get_forge_config()` returns merged config from global/org/repo, verify valid values for `fix_threshold` enum, verify `halt_round == max_rounds + 1`.

- [ ] **Step 4:** Run tests:
```bash
python3 -m pytest scripts/test_forge_config.py -v
```

- [ ] **Step 5:** Commit:
```bash
git add global/config.json scripts/config_loader.py scripts/test_forge_config.py
git commit -m "feat(forge): add forge config section and config_loader integration"
```

### Task 1.2: Audit module (forge_audit.py)

**Files:**
- Create: `scripts/forge_audit.py`
- Create: `scripts/test_forge_audit.py`

- [ ] **Step 1:** Write test for `init_metrics_db()` — verify tables `runs` and `domain_stats` are created, WAL mode is set:
```python
def test_init_metrics_db(tmp_path):
    db_path = tmp_path / "test_metrics.db"
    init_metrics_db(db_path)
    conn = sqlite3.connect(str(db_path))
    tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    assert ("runs",) in tables
    assert ("domain_stats",) in tables
    journal = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert journal == "wal"
```

- [ ] **Step 2:** Run test to verify it fails (module doesn't exist yet):
```bash
python3 -m pytest scripts/test_forge_audit.py::test_init_metrics_db -v
```

- [ ] **Step 3:** Implement `forge_audit.py` with:
  - `init_metrics_db(db_path)` — create tables, set WAL mode, busy timeout
  - `record_call(audit_path, call_data)` — append to `.forge-audit.json` in worktree
  - `record_run(db_path, run_data)` — insert into `runs` and `domain_stats` tables
  - `get_domain_snr(db_path, domain, last_n=10)` — compute rolling SNR
  - `prune_metrics(db_path, retention_days=90)` — delete old rows
  - `AuditCall` dataclass for structured call data

- [ ] **Step 4:** Write remaining tests: `test_record_call`, `test_record_run`, `test_get_domain_snr`, `test_prune_metrics`. Run:
```bash
python3 -m pytest scripts/test_forge_audit.py -v
```

- [ ] **Step 5:** Commit:
```bash
git add scripts/forge_audit.py scripts/test_forge_audit.py
git commit -m "feat(forge): add forge_audit.py with SQLite metrics and JSON audit"
```

### Task 1.3: Skill definition (SKILL.md) and install wiring

**Files:**
- Create: `skill/stark-forge/SKILL.md`
- Modify: `install.sh`
- Create: `global/forge_heuristics.json` (seed file)

- [ ] **Step 1:** Create `skill/stark-forge/SKILL.md` with invocation spec (`/stark-forge <path> [--auto-detect] [--dry-run] [--resume] [--workers N]`), exit codes (0/1/2/3), preflight call, worktree creation, orchestrator dispatch, phase sequencing with TaskCreate/TaskUpdate, and terminal output format ([OK]/[FAIL]/[SKIP]/[HALT] text labels).

- [ ] **Step 2:** Create `global/forge_heuristics.json` with the default rules from the design spec (8 conditional domains + always-included domains).

- [ ] **Step 3:** Update `install.sh` to:
  - Symlink `skill/stark-forge/` to `~/.claude/skills/stark-forge`
  - Copy `global/forge_heuristics.json` to `~/.claude/code-review/forge_heuristics.json` (if not exists — don't overwrite learned rules)
  - Create `~/.claude/code-review/history/forge/` directory
  - Do NOT archive `/stark-design` yet — wait until Phase 7 (after forge is proven functional)

- [ ] **Step 4:** Run install and verify:
```bash
./install.sh --status
ls -la ~/.claude/skills/stark-forge
ls -la ~/.claude/code-review/forge_heuristics.json
```

- [ ] **Step 5:** Commit:
```bash
git add skill/stark-forge/SKILL.md global/forge_heuristics.json install.sh
git commit -m "feat(forge): add SKILL.md, seed heuristics, install wiring"
```

### Task 1.4: Forge prompt trees

**Files:**
- Create: `global/prompts/forge-design-review/domains/*.md` (13 files — 12 existing + implementation-feasibility)
- Create: `global/prompts/forge-design-review/{claude,codex,gemini}/agent.md`
- Create: `global/prompts/forge-plan-review/domains/*.md` (10 files)
- Create: `global/prompts/forge-plan-review/{claude,codex,gemini}/agent.md`

- [ ] **Step 1:** Copy (not symlink) the 12 existing design-review domain prompts into `global/prompts/forge-design-review/domains/`. Symlinks break when install.sh copies to `~/.claude/code-review/prompts/` because relative paths resolve differently. Use copies to keep forge prompts independent:
```bash
mkdir -p global/prompts/forge-design-review/domains
for f in global/prompts/design-review/domains/*.md; do
  cp "$f" "global/prompts/forge-design-review/domains/$(basename $f)"
done
```

- [ ] **Step 2:** Create `global/prompts/forge-design-review/domains/12-implementation-feasibility.md` — the new domain prompt instructing the reviewer to grep for all referenced function/class/module names and verify they exist with correct signatures.

- [ ] **Step 3:** Copy agent preambles for design review (same reason — no symlinks):
```bash
for agent in claude codex gemini; do
  mkdir -p "global/prompts/forge-design-review/$agent"
  cp "global/prompts/design-review/$agent/agent.md" "global/prompts/forge-design-review/$agent/agent.md"
done
```

- [ ] **Step 4:** Create forge plan-review domain prompts (10 files) for: general, completeness, correctness, scope, risk, sequencing, testing, integration, rollback, observability. Symlink where they match existing plan-review domains, create new ones where they don't.

- [ ] **Step 5:** Copy plan-review agent preambles similarly (same copy-not-symlink approach).

- [ ] **Step 6:** Verify prompt discovery works:
```python
from dispatcher_base import discover_domains
from pathlib import Path
domains = discover_domains(str(Path.home() / ".claude/code-review/prompts/forge-design-review"))
print(f"Discovered domains: {sorted(domains.keys())}")
assert "implementation-feasibility" in domains, f"Missing implementation-feasibility. Found: {sorted(domains.keys())}"
assert "general" in domains
assert "security" in domains
# Log count but don't assert it — count may change as domains evolve
print(f"Total domains: {len(domains)}")
```

- [ ] **Step 7:** Commit:
```bash
git add global/prompts/forge-design-review/ global/prompts/forge-plan-review/
git commit -m "feat(forge): add isolated prompt trees for design and plan review"
```

**Phase 1 verification:**
```bash
python3 -m pytest scripts/test_forge_config.py scripts/test_forge_audit.py -v
./install.sh --status
python3 -c "from config_loader import get_forge_config; print(get_forge_config()['max_rounds'])"
```

---

## Phase 2: Worktree, State, and Resume Engine

**Goal:** Make forge safe to start, stop, and resume without losing work or mutating the user's checkout.
**Dependencies:** Phase 1
**Effort:** M

### Task 2.1: Orchestrator entrypoint and worktree lifecycle

**Files:**
- Create: `scripts/forge_orchestrator.py`
- Create: `scripts/test_forge_orchestrator.py`

- [ ] **Step 1:** Write tests for `derive_branch_name()`:
```python
def test_derive_branch_name():
    assert derive_branch_name(Path("docs/specs/2026-04-11-stark-forge-design.md")) == "forge/stark-forge-design"
    assert derive_branch_name(Path("My Cool Feature_v2.md")) == "forge/My-Cool-Feature-v2"
    assert len(derive_branch_name(Path("a" * 100 + ".md")).split("/")[1]) <= 50
```

- [ ] **Step 2:** Run test to verify it fails.

- [ ] **Step 3:** Implement `forge_orchestrator.py` with:
  - `derive_branch_name(spec_path) -> str` — strip date prefix, extension, sanitize, truncate to 50 chars
  - `run_forge(spec_path, auto_detect, dry_run, resume, workers) -> int` — main entrypoint returning exit code
  - Main branch guard: reject `main`/`master` immediately (exit code 3)
  - `--dry-run` handling: after Phase 0 classification, run round 1 of Phase 1 (design review) only, report findings to terminal, then return exit code 0. No fixes, no commits, no plan generation, no issue creation, no downstream phases. Still creates the worktree (needed for dispatch) but does not commit into it.
  - Worktree creation via `git worktree add` into `WORKTREE_BASE = Path(git_root) / ".worktrees" / f"forge-{slug}"`
  - Spec copy into worktree

- [ ] **Step 4:** Run tests:
```bash
python3 -m pytest scripts/test_forge_orchestrator.py -v
```

- [ ] **Step 5:** Commit.

### Task 2.2: Atomic state and backup handling

**Files:**
- Modify: `scripts/forge_orchestrator.py`
- Modify: `scripts/test_forge_orchestrator.py`

- [ ] **Step 1:** Write tests for `write_state_atomic()` and `load_state()`:
```python
def test_write_state_atomic(tmp_path):
    state_path = tmp_path / ".forge-state.json"
    write_state_atomic(state_path, {"version": 1, "phases": {}})
    assert state_path.exists()
    assert not (tmp_path / ".forge-state.json.tmp").exists()

def test_load_state_fallback_to_backup(tmp_path):
    backup_path = tmp_path / "backup" / "state-backup.json"
    backup_path.parent.mkdir()
    backup_path.write_text('{"version": 1, "phases": {}}')
    state = load_state(tmp_path / "missing.json", backup_path)
    assert state["version"] == 1
```

- [ ] **Step 2:** Implement:
  - `write_state_atomic(state_path, state)` — write to `.tmp`, `os.replace()`, mirror to backup
  - `load_state(state_path, backup_path)` — try state file, fall back to backup, error if neither
  - State schema initialization with version 1 fields

- [ ] **Step 3:** Run tests, commit.

### Task 2.3: Lock file and concurrent run protection

**Files:**
- Modify: `scripts/forge_orchestrator.py`
- Modify: `scripts/test_forge_orchestrator.py`

- [ ] **Step 1:** Write tests: active PID blocks, dead PID is cleaned, lock released on completion/halt.

- [ ] **Step 2:** Implement `.forge-lock` with PID recording, liveness check via `os.kill(pid, 0)`, cleanup on exit.

- [ ] **Step 3:** Run tests, commit.

### Task 2.4: Resume logic

**Files:**
- Modify: `scripts/forge_orchestrator.py`
- Modify: `scripts/test_forge_orchestrator.py`

- [ ] **Step 1:** Write tests for resume scenarios: completed phases skip, starting phases re-run, pending phases run, missing worktree with backup recovers.

- [ ] **Step 2:** Implement:
  - Locate worktree via `git worktree list --porcelain` filtering by branch name
  - Read state, reconcile against git log for partial commits
  - Clean partial outputs before re-dispatch
  - **Spec hash check:** On resume, compute `sha256(spec_file_content)` and compare to `state["spec_hash"]`. If different, warn: "Spec has been modified since the original run. Proceeding with current content — classification and review results from previous rounds may not apply." Continue (don't block — the user likely edited the spec to fix a HALT).

- [ ] **Step 3:** Run tests, commit.

### Task 2.5: Terminal output and progress rendering

**Files:**
- Modify: `scripts/forge_orchestrator.py`

- [ ] **Step 1:** Implement progress output using text labels (`[OK]`, `[FAIL]`, `[SKIP]`, `[HALT]`, `[DETECT]`, `[RUN]`). Use `tui_core.py` primitives where applicable.

- [ ] **Step 2:** Implement TTY vs non-TTY detection: rich progress to stderr always, structured JSON summary to stdout when not a TTY.

- [ ] **Step 3:** Wire TaskCreate/TaskUpdate calls for each phase start/complete.

- [ ] **Step 4:** Commit.

**Phase 2 verification:**
```bash
python3 -m pytest scripts/test_forge_orchestrator.py -v
python3 scripts/forge_orchestrator.py docs/specs/2026-04-11-stark-forge-design.md --dry-run 2>&1 | head -5
# Should see: main branch guard or worktree creation
git worktree list --porcelain | grep forge
```

---

## Phase 3: Domain Classification (Phase 0)

**Goal:** Ship 3-tier domain classification with heuristic learning.
**Dependencies:** Phase 2
**Can parallel with:** Phase 4 (if orchestrator interface is stable)
**Effort:** M

### Task 3.1: Heuristic classifier (Tier 1)

**Files:**
- Create: `scripts/forge_classifier.py`
- Create: `scripts/test_forge_classifier.py`

- [ ] **Step 1:** Write tests:
```python
def test_backend_spec_skips_accessibility():
    content = "This service exposes REST API endpoints with PostgreSQL database storage and auth token validation"
    result = classify_spec(content, Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    assert "accessibility" not in result.domains
    assert "api-design" in result.domains
    assert "security" in result.domains
    assert "data-modeling" in result.domains

def test_always_included_domains():
    result = classify_spec("minimal spec", Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    for d in ["general", "completeness", "scope", "consistency"]:
        assert d in result.domains
```

- [ ] **Step 2:** Implement `forge_classifier.py`:
  - `ClassificationResult` dataclass: `domains`, `skipped_domains`, `design_type`, `tier_used`, `confidence`
  - `match_heuristics(content, rules)` — pattern matching with pre-compiled regexes
  - `classify_spec(content, spec_path, auto_detect, cfg)` — Tier 1 → Tier 2 → Tier 3 flow

- [ ] **Step 3:** Run tests, commit.

### Task 3.2: LLM classification (Tier 2) and user confirmation (Tier 3)

**Files:**
- Modify: `scripts/forge_classifier.py`
- Modify: `scripts/test_forge_classifier.py`

- [ ] **Step 1:** Implement Tier 2: call `domain_triage.triage_domains()` with `review_type="design"` when heuristic confidence is low. Extract domain concepts from the explanation (not raw spec text — poisoning guard).

- [ ] **Step 2:** Implement Tier 3: interactive terminal prompt showing detected type, running/skipping domains, override options. Skip when `--auto-detect` or stdin is not interactive.

- [ ] **Step 3:** Run tests, commit.

### Task 3.3: Heuristic learning and log rotation

**Files:**
- Modify: `scripts/forge_classifier.py`
- Modify: `scripts/test_forge_classifier.py`

- [ ] **Step 1:** Implement:
  - `append_classification_log(entry)` — append to `forge_classification_log.jsonl`
  - `maybe_patch_heuristics(explanation_terms, domain, heuristics_path)` — add new patterns, increment `patches_since_consolidation`
  - Log rotation at 1000 entries

- [ ] **Step 2:** Write test verifying poisoning guard: raw spec text cannot become a heuristic pattern.

- [ ] **Step 3:** Run tests, commit.

**Phase 3 verification:**
```bash
python3 -m pytest scripts/test_forge_classifier.py -v
python3 -c "
from forge_classifier import classify_spec
result = classify_spec('REST API with PostgreSQL and auth tokens', Path('test.md'), True, {})
print(f'Domains: {result.domains}')
print(f'Skipped: {result.skipped_domains}')
"
```

---

## Phase 4: Design Review Iron Rule Loop (Phase 1)

**Goal:** Review a design, classify findings, apply fixes, commit each round, halt on blocked.
**Dependencies:** Phase 3
**Effort:** L

### Task 4.1: Routed design-review dispatch

**Files:**
- Create: `scripts/forge_review.py`
- Create: `scripts/test_forge_review.py`

- [ ] **Step 1:** Write test for `compute_finding_id()`:
```python
def test_finding_id_stable():
    id1 = compute_finding_id("claude", "general", "## Solution", "Missing error handling")
    id2 = compute_finding_id("claude", "general", "## Solution", "Missing error handling")
    assert id1 == id2
    assert len(id1) == 12
```

- [ ] **Step 2:** Implement `forge_review.py`:
  - `PhaseResult` dataclass: `status` (completed/halted), `rounds`, `findings_fixed`, `noise`, `commit_shas`
  - `run_design_review(spec_path, state, cfg, repo_dir) -> PhaseResult`
  - Group domains by routed agent from config using `discover_domains()` to get domain dicts
  - Call per agent group with correct signature:
    ```python
    dispatch_plan_review(
        plan_content=spec_text,              # required positional
        round_num=round_num,                 # required positional
        repo_dir=str(repo_dir),
        global_prompts_dir=str(FORGE_DESIGN_REVIEW_DIR),
        agents=["claude"],                   # single agent per group
        domains=filtered_domain_dict,        # dict[str, dict], NOT list
        timeout=cfg.get("timeout", 300),
    )
    ```
  - Handle `agent_fallback_order` for disabled agents
  - `compute_finding_id(agent, domain, section_heading, title) -> str`

- [ ] **Step 3:** Run tests, commit.

### Task 4.2: Finding classification, fix batching, and commit trail

**Files:**
- Modify: `scripts/forge_review.py`
- Modify: `scripts/test_forge_review.py`

- [ ] **Step 1:** Implement `classify_findings()`:
  - Read each finding's referenced section in the spec
  - Classify: `fix` (real issue, above threshold), `noise` (false positive), `blocked` (real but unfixable → immediate HALT)
  - Cross-reference: 2+ agents on same section + concern = `high_confidence` → always `fix`
  - Recurring detection: if finding_id appeared as `fix` in a previous round and reappears → `recurring` (retry fix with different approach; third recurrence → `blocked`)

- [ ] **Step 2:** Implement fix batching: group `fix` findings by section, batch same-section findings into single edit. The orchestrating LLM edits the spec directly.

- [ ] **Step 3:** Implement round commit: `git add <spec> && git commit -m "forge: design review round N — fixed K findings"`

- [ ] **Step 4:** Implement round loop (1 to max_rounds): dispatch → classify → fix → commit → check for early termination (0 fix findings → jump to halt round)

- [ ] **Step 5:** Implement halt round (`cfg["max_rounds"] + 1`, NOT hardcoded 4): dispatch ALL active domains. If any `fix` or `blocked` findings remain → HALT (exit code 1). Otherwise → clean, proceed to Phase 2.

- [ ] **Step 6:** Write test for recurrence escalation:
```python
def test_recurring_finding_becomes_blocked():
    """Third recurrence of the same finding_id triggers blocked → HALT."""
    rounds = [
        {"findings": [{"id": "abc123", "status": "fix"}]},  # round 1: fix
        {"findings": [{"id": "abc123", "status": "recurring"}]},  # round 2: same issue
        {"findings": [{"id": "abc123", "status": "recurring"}]},  # round 3: third time
    ]
    result = classify_findings(round_3_findings, spec_text, rounds, "medium")
    blocked = [f for f in result if f.status == "blocked"]
    assert len(blocked) == 1
    assert blocked[0].id == "abc123"
```

- [ ] **Step 7:** Run tests, commit.

### Task 4.3: Targeted re-dispatch and consensus

**Files:**
- Modify: `scripts/forge_review.py`
- Modify: `scripts/test_forge_review.py`

- [ ] **Step 1:** Implement targeted re-dispatch for rounds 2-3: diff last commit to find changed sections, map to domains, always include `general` and `consistency`.

- [ ] **Step 2:** Implement consensus judge for `security` domain:
  - Dispatch to both routed agents independently
  - Call haiku-class LLM judge with finding titles + descriptions only (no spec content)
  - Group semantically similar findings
  - Findings confirmed by threshold agents survive as `fix` candidates
  - Single-agent findings flagged with `consensus: "single_agent"`, not auto-noise

- [ ] **Step 3:** Implement consensus degradation: if one agent fails, fall back to single-agent mode, record `consensus_degraded: true` in audit.

- [ ] **Step 4:** Run tests, commit.

**Phase 4 verification:**
```bash
python3 -m pytest scripts/test_forge_review.py -v
python3 scripts/forge_orchestrator.py docs/specs/2026-04-11-stark-forge-design.md --auto-detect --workers 1 --dry-run
git -C .worktrees/forge-stark-forge-design log --oneline 2>/dev/null
```

---

## Phase 5: Plan Generation, Plan Review, and TDD Stub (Phases 2-3)

**Goal:** Generate implementation plan, review with Iron Rule, stub TDD.
**Dependencies:** Phase 4
**Effort:** L

### Task 5.1: Plan generation and winner selection

**Files:**
- Create: `scripts/forge_plan.py`
- Create: `scripts/test_forge_plan.py`

- [ ] **Step 1:** Implement `run_plan_phase(spec_path, state, cfg, repo_dir) -> PhaseResult`:
  - Call `generate_plans(design_content=spec_text, ...)` from `design_to_plan_dispatch`
  - Store the full generate result: `gen_result = generate_plans(...)`
  - Call `cross_review_plans(...)` to select winner: `cross_result = cross_review_plans(...)`
  - Extract winner content:
    ```python
    winner_agent = cross_result["winner"]
    winner_content = next(
        r["plan_content"] for r in gen_result["results"]
        if r["agent"] == winner_agent and not r.get("error")
    )
    ```
  - Write `winner_content` to worktree as `{spec-name}-plan.md`
  - Commit the generated plan

- [ ] **Step 2:** Write test with mocked agent responses verifying winner extraction, commit.

### Task 5.2: Plan review with forge plan-review domains

**Note:** After plan review completes (all fixes applied, halt round clean), freeze the plan hash BEFORE proceeding to Phase 4 task generation:
```python
import hashlib
plan_text = plan_path.read_text()
plan_hash = hashlib.sha256(plan_text.encode()).hexdigest()
state["phases"]["plan"]["plan_hash"] = plan_hash
write_state_atomic(state_path, state)
```
This frozen hash is passed to `dispatch_validators()` in Task 6.1. If the plan is edited after this point, the hash mismatch will be caught.

**Files:**
- Modify: `scripts/forge_plan.py`

- [ ] **Step 1:** Implement plan review loop using the same Iron Rule logic from `forge_review.py` but with:
  - `global_prompts_dir` pointing to `forge-plan-review/`
  - All 10 plan review domains run (no Phase 0 filtering)
  - Routing from `forge.plan_review_routing` config
  - Same round/halt/commit logic

- [ ] **Step 2:** Run tests, commit.

### Task 5.3: TDD stub

**Files:**
- Create: `scripts/forge_tdd.py`

- [ ] **Step 1:** Implement `skip_tdd_phase() -> dict`:
  - Print `Phase 3: TDD Spec — skipped (available in v2)`
  - Return `{"status": "completed", "skipped": True}`
  - Set state `phases.tdd.status = "completed"` immediately

- [ ] **Step 2:** Commit.

**Phase 5 verification:**
```bash
python3 -m pytest scripts/test_forge_plan.py -v
```

---

## Phase 6: Task Decomposition and GitHub Issue Creation (Phase 4)

**Goal:** Turn the reviewed plan into validated tasks and create idempotent GitHub issues.
**Dependencies:** Phase 5
**Effort:** M

### Task 6.1: Task generation and validation

**Files:**
- Create: `scripts/forge_tasks.py`
- Create: `scripts/test_forge_tasks.py`

- [ ] **Step 1:** Implement `run_tasks_phase(plan_path, state, cfg, repo_dir) -> PhaseResult`:
  - LLM call to decompose plan into phased tasks (JSON output)
  - Validate via `plan_to_tasks_validate.dispatch_validators()`
  - If validation fails, re-run generation with feedback (up to 2 retries)

- [ ] **Step 2:** Write test with mocked LLM and validator responses, commit.

### Task 6.2: Idempotent GitHub issue creation

**Files:**
- Modify: `scripts/forge_tasks.py`
- Modify: `scripts/test_forge_tasks.py`

- [ ] **Step 1:** Implement:
  - Before each `gh issue create`: write intent to state (`creating_issue: "title"`)
  - Search for existing issues with same title prefix via `gh issue list --search`
  - Skip creation if found, record existing issue number
  - Create with native `gh` CLI auth (`unset GH_TOKEN` first per auth split policy)
  - Record `issue_numbers` in state immediately after each create

- [ ] **Step 2:** Write test: mock `gh` output to simulate existing issues, verify skip logic.

- [ ] **Step 3:** Implement `--dry-run` suppression: no issue creation, just print what would be created.

- [ ] **Step 4:** Run tests, commit.

**Phase 6 verification:**
```bash
python3 -m pytest scripts/test_forge_tasks.py -v
gh auth status
```

---

## Phase 7: Self-Improvement, Hardening, and Documentation

**Goal:** Noise-triggered prompt improvement PRs, heuristic consolidation, acceptance tests, docs.
**Dependencies:** Phase 6
**Effort:** M

### Task 7.1: Self-improvement module

**Files:**
- Create: `scripts/forge_improve.py`
- Create: `scripts/test_forge_improve.py`

- [ ] **Step 1:** Write firewall test:
```python
def test_firewall_no_spec_content():
    # The improvement prompt must not contain any spec text
    prompt = build_improvement_prompt(domain="scope", snr=0.33, current_prompt="...", finding_counts={})
    assert "my secret spec content" not in prompt
    assert "finding description text" not in prompt
```

- [ ] **Step 2:** Implement `forge_improve.py`:
  - `maybe_queue_improvements(run_summary, cfg) -> list[str]` — check SNR thresholds
  - `build_improvement_prompt(domain, snr, current_prompt, finding_counts)` — metadata-only
  - `create_improvement_pr(branch_name, files, title, body)` — via `gh pr create` (native auth)
  - Heuristic consolidation: when `patches_since_consolidation > threshold`, rewrite file from scratch

- [ ] **Step 3:** Write test for heuristic consolidation trigger, commit.

### Task 7.2: End-to-end acceptance tests

**Files:**
- Create: `scripts/test_forge_e2e.py`

- [ ] **Step 1:** Write acceptance tests:
  - `test_dry_run_no_commits` — `--dry-run` produces findings, no commits, no issues
  - `test_main_branch_rejection` — forge refuses to run on main (exit code 3)
  - `test_worktree_isolation` — all changes in worktree, user checkout untouched
  - `test_crash_resume` — simulate crash (write "starting" state), verify resume works
  - `test_exit_codes` — verify 0/1/2/3 for success/halt/dispatch-failure/invalid-input

- [ ] **Step 2:** Run:
```bash
python3 -m pytest scripts/test_forge_e2e.py -v
```

- [ ] **Step 3:** Commit.

### Task 7.3: Archive /stark-design and update documentation

**Files:**
- Modify: `install.sh` (stop symlinking stark-design)
- Modify: `CLAUDE.md` (add forge, update pipeline, archive stark-design)

- [ ] **Step 1:** Update `install.sh` to stop symlinking `skill/stark-design/`. Add a comment: `# Archived: /stark-design — use superpowers:brainstorm + /stark-forge instead`.

- [ ] **Step 2:** Add `/stark-forge` to the skills table in `CLAUDE.md` and the pipeline section. Mark `/stark-design` as archived in the pipeline section.

- [ ] **Step 3:** Update the skills list count (29 → 30, since forge replaces design but is a new skill).

- [ ] **Step 4:** Commit:
```bash
git add install.sh CLAUDE.md
git commit -m "feat(forge): archive /stark-design, add /stark-forge to docs"
```

**Note:** `/stark-design` is archived only NOW (Phase 7), after forge has been proven functional through Phases 1-6. This avoids a rollback-hostile gap where neither skill is available.

**Phase 7 verification:**
```bash
python3 -m pytest scripts/test_forge_improve.py scripts/test_forge_e2e.py -v
python3 -m pytest scripts/test_forge_*.py -v  # all forge tests
```

---

## Phase Gates

Each phase transition in the orchestrator includes a go/no-go check before proceeding:

| Gate | Between | Check | Fail action |
|------|---------|-------|-------------|
| G1 | Phase 0 → Phase 1 | At least 4 domains classified (always-included) | Exit code 3 |
| G2 | Phase 1 → Phase 2 | Halt round produced 0 `fix`/`blocked` findings | HALT (exit 1) |
| G3 | Phase 2 gen → Phase 2 review | Plan file exists and is non-empty in worktree | HALT (exit 2) |
| G4 | Phase 2 review → Phase 4 | Halt round clean; plan_hash frozen in state | HALT (exit 1) |
| G5 | Phase 4 gen → Phase 4 validate | Task JSON passes schema validation | Re-generate (up to 2 retries) |
| G6 | Phase 4 validate → issue creation | `gh auth status` succeeds with user PAT | Skip issues, warn |
| Cost | Before every dispatch | Accumulated cost < `cost.hard_stop_usd` | HALT (exit 1) |

Gates are checked by the orchestrator, not by individual phase modules. Each gate writes its result to the state file before proceeding.

## Integration Points

- **`config_loader.py`** — `get_forge_config()` must use the same deep-merge path as existing sections. Adding only to `global/config.json` without `_SECTION_DEFAULTS` causes inconsistent repo/org overrides.
- **`dispatcher_base.py` / `plan_review_dispatch.py`** — require numbered prompt filenames and domain dict metadata. Forge must build filtered domain dicts, not pass lists.
- **`design_to_plan_dispatch.py`** — `generate_plans()` and `cross_review_plans()` return content and scores but don't manage commits. Forge must persist and commit the winning plan.
- **`plan_to_tasks_validate.py`** — `dispatch_validators()` expects a stable `plan_hash`. If the plan is edited after generation, validation approves the wrong artifact.
- **Prompt-path isolation** — forge uses `forge-design-review/` and `forge-plan-review/`, not the shared `design-review/` and `plan-review/`. This prevents forge changes from altering standalone skill behavior.
- **Auth split** — `gh` CLI (native auth) for PRs and issues. GitHub App tokens (`stark-claude[bot]` etc.) only for posting review comments. Never mix them. Always `unset GH_TOKEN` before `gh issue create` or `gh pr create`.
- **Git authority** — git commits are authoritative for content changes. `.forge-state.json` is authoritative for pipeline progress. On conflict, trust git.
- **Agent timeouts** — inherited from `plan_review_dispatch.py`: `DEFAULT_TIMEOUT = 300` seconds per agent call, Codex gets 2x (600s). Configurable via `forge.timeout` or `--timeout` flag passed through to dispatch. The orchestrator does NOT add its own timeout layer — it relies on the dispatch timeout.
- **GitHub API** — `gh issue create` and `gh issue list` can fail on rate limits or transient errors. Retry up to 2 times with 5s backoff. If all retries fail, record intent in state and HALT — do not silently skip issue creation.

## Testing Strategy

1. **Unit tests first** (pure logic): branch slug derivation, finding IDs, severity classification, section-to-domain mapping, heuristic thresholds, audit summaries, state-version compatibility, metadata firewall.
2. **Integration tests second** (temp git repos, mocked agents): worktree creation, atomic state writes, stale lock recovery, crash-resume matrix, consensus degradation, idempotent issue detection, backup recovery.
3. **E2E tests last**: `--dry-run` on the forge design spec, full happy-path with mocked GitHub, one live smoke test if sandbox repo is available.
4. **Test order follows phase order**: Phase 2 state tests before classifier tests, classifier before review-loop, review-loop before plan, plan before tasks.
5. **Convention**: `scripts/test_forge_*.py` (follows existing repo convention).

## Rollback Plan

| Phase | Rollback |
|-------|----------|
| 1 | Revert `config.json`, `config_loader.py`, prompt trees, SKILL.md. Rerun `./install.sh`. |
| 2 | `git worktree remove --force <path>` + `git branch -D forge/<slug>`. Delete state/lock/backup files. |
| 3 | Reset forge branch to pre-review commit, or delete branch/worktree entirely. |
| 4-5 | Revert plan/review commits on forge branch. Clear phase state to `pending`. |
| 6 | Use `phases.tasks.issue_numbers` to close issues with rollback comment. Reset tasks state to `pending`. |
| 7 | Close improvement PRs, delete branches, restore `forge_heuristics.json` from previous commit. Re-enable `/stark-design` symlink in install.sh if it was archived in this phase. |
