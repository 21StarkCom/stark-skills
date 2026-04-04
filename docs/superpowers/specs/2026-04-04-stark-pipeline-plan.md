# `stark-pipeline` — Implementation Plan

> Phased implementation plan for the end-to-end feature orchestrator. Built on the Codex-generated plan, aligned with the reviewed design spec, and incorporating 15 unresolved review findings.

**Design spec:** `docs/superpowers/specs/2026-04-04-stark-pipeline-design.md`
**Design review:** `docs/superpowers/specs/2026-04-04-stark-pipeline-design.design-review.md`
**Author:** Aryeh
**Status:** Draft
**Generated:** 2026-04-04 (1 agent, no cross-review — Claude timed out, Gemini disabled)

---

## Overview

Build `stark-pipeline` as a thin Python orchestration layer over existing dispatch primitives. Six phases, each leaving a working (progressively more capable) pipeline:

1. **Foundation** — package scaffold, config, preflight, install
2. **Durable State** — checkpoint, dispatch wrappers, metrics, locking
3. **Read-Only Stages** — design-generate through plan-to-tasks
4. **Phase-Execute Engine** — worktree loop, review-fix, escalation, resume
5. **Post-Merge Stages** — docs-update, release, housekeeping
6. **TUI & Skill** — Rich display, `/stark-pipeline` skill, smoke tests

Key constraints from the design:
- Reuse existing scripts (`multi_review.py`, `design_to_plan_dispatch.py`, `plan_review_dispatch.py`, `autopilot_dispatch.py`) via import, not rewrite
- Worktree must persist across fix rounds (not cleaned until PR created) — **design review finding #4/#15**
- Task identity is GitHub issue number (int), not string — **design review finding #1**
- Artifact paths repo-namespaced: `~/.claude/code-review/pipelines/{owner}/{repo}/{slug}/` — **design review finding #2**
- Slug sanitized to prevent path traversal — **design review finding #8**
- `git pull origin main` after each PR merge — **design review finding #7**
- Finding IDs globally unique: `{stage}-{task}-{round}-{ordinal}` — **design review finding #3**
- Retry distinguishes transient vs permanent failures — **design review finding #13**
- File lock includes PID for stale detection — **design review finding #14**

## Prerequisites

```bash
cd /Users/aryeh/git/Evinced/stark-skills
./install.sh --status || ./install.sh
PYTHON=scripts/.venv/bin/python3
$PYTHON -c "import rich, pytest; print('python deps ok')"
unset GH_TOKEN && gh auth status
git checkout main && git pull --rebase origin main
```

Required existing modules:
- `scripts/preflight.py` — pre-flight checks (extend with `stark-pipeline` workflow)
- `scripts/lock_helpers.py` — file locking primitives (reuse for `state.lock`)
- `scripts/validation_gate.py` — test execution (reuse for per-task/per-phase tests)
- `scripts/design_to_plan_dispatch.py` — plan generation dispatch
- `scripts/plan_review_dispatch.py` — review dispatch
- `scripts/multi_review.py` — code review dispatch
- `scripts/github_app.py` — GitHub App auth
- `scripts/claude_utils.py`, `scripts/gemini_utils.py`, `scripts/codex_utils.py` — CLI helpers
- `scripts/config_loader.py` — hierarchical config

**Pre-implementation verification:** Before starting Phase 1, verify each module above exists and its public API matches what the plan depends on. Run: `$PYTHON -c "from preflight import run_preflight; from lock_helpers import acquire_lock; from validation_gate import run_tests"` etc. Document any missing or changed APIs as Phase 1 blockers.

Known design gaps to resolve during Phase 1:
- `skill/stark-release/SKILL.md` is repo-specific (`src/infra_pulse/__init__.py`); needs generic version detection
- `plan-to-tasks` is a skill contract, not a Python API; needs callable adapter (this is a **significant refactor** — split into subtasks: extract core logic, add idempotent issue creation, add label contract validation, test independently)
- No `pipeline` section in `global/config.json` yet; model rates and pipeline defaults must be added
- `design_to_plan_dispatch.py` `--mode generate` parameter needs verification — confirm the script accepts this flag before depending on it in Phase 3

---

## Phase 1: Foundation and Shared Utility Hardening

**Goal:** Create the package skeleton, CLI entry point, config schema, and harden shared utilities before orchestration depends on them.
**Dependencies:** None
**Effort:** M (3-5 tasks)

### Tasks

**1.1 Bootstrap package and CLI entry point**

Create `scripts/stark_pipeline.py` with argparse matching the design spec's CLI interface (all flags: `--slug`, `--prompt`, `--start-at`, `--resume`, `--review-mode`, `--max-fix-rounds`, `--dry-run`, `--agents`, `--no-tui`, `--max-cost`, `--max-time`, `--test-cmd`, `--test-timeout`, `--release-type`).

Create `scripts/pipeline/__init__.py` and `scripts/pipeline/config.py` with `PipelineConfig` dataclass. Extend `global/config.json` with a `pipeline` section containing:
- `model_rates` — the cost rate table from the design spec
- `default_review_mode` — "single"
- `default_max_fix_rounds` — 3
- `default_agents` — ["claude", "codex", "gemini"]
- `default_max_wall_time_s` — 14400

Add slug sanitization: strip path separators, limit to `[a-z0-9-]`, max 64 chars. **Resolves design review finding #8.**

Files: `scripts/stark_pipeline.py`, `scripts/pipeline/__init__.py`, `scripts/pipeline/config.py`, `global/config.json`

Done when: `python scripts/stark_pipeline.py --dry-run --prompt "test"` parses cleanly and prints a stub execution plan.

**1.2 Harden preflight for pipeline workflow**

Extend `scripts/preflight.py` with a `stark-pipeline` workflow that:
- Always checks Claude availability (even if `--agents` excludes it) — **resolves design review finding #6**
- Checks all tools from design Dependencies section: `claude`, `codex`, `gemini` (per `--agents`), `gh`, `git`
- Checks `gh auth status` for user PAT
- Checks GitHub App token acquisition
- Validates `scripts/.venv` has required deps (`rich`, etc.)

Files: `scripts/preflight.py`, `scripts/pipeline/config.py`

Done when: `python3 scripts/preflight.py --workflow stark-pipeline --json` returns all checks passing.

**1.3 Update install.sh**

Add to `install.sh`:
- Symlink `scripts/pipeline/` → `~/.claude/code-review/scripts/pipeline/`
- Symlink `scripts/stark_pipeline.py` → `~/.claude/code-review/scripts/stark_pipeline.py`
- Symlink `skill/stark-pipeline/` → `~/.claude/skills/stark-pipeline`
- Create `~/.claude/code-review/pipelines/` directory

Files: `install.sh`, `skill/stark-pipeline/SKILL.md` (stub)

Done when: `./install.sh --status` reports pipeline assets as installed.

### Risks
- Shared helper changes break existing skills: keep function signatures backward-compatible, add regression tests.
- Config schema drift between repo and installed symlinks: `install.sh --status` must report new assets.

### Verification
```bash
python scripts/stark_pipeline.py --dry-run --prompt "smoke test" --no-tui
python3 scripts/preflight.py --workflow stark-pipeline --json
./install.sh --status | grep pipeline
$PYTHON -m pytest scripts/pipeline/test_config.py -q
```

---

## Phase 2: Durable State, Artifacts, and Metrics

**Goal:** Make resume, artifact persistence, cost ceilings, and audit logging reliable before any stage runs.
**Dependencies:** Phase 1
**Effort:** M (3-4 tasks)

### Tasks

**2.1 Implement checkpoint manager**

Create `scripts/pipeline/checkpoint.py` with `CheckpointManager`:
- Repo-scoped paths: `~/.claude/code-review/pipelines/{owner}/{repo}/{slug}/` — **resolves design review finding #2**
- Atomic writes (write-to-tmp + rename)
- `schema_version` field with migration framework (`migrate_v1_to_v2()` etc.)
- Slug sanitization integrated from config.py
- File lock using `lock_helpers.acquire_lock()` with PID in lock file for stale detection. **Stale lock reclaim:** read PID from lock, check `os.kill(pid, 0)` — if process is dead, reclaim. If process is alive but not a pipeline process (check `/proc/{pid}/cmdline` or `ps`), warn and require `--force` to reclaim. — **resolves design review finding #14**
- `base_sha` capture: record `git rev-parse HEAD` at pipeline start, store in state.json. This is the anchor for `docs-update`'s diff range.
- State schema matching design spec: `schema_version`, `slug`, `repo`, `base_sha`, `input`, `config`, `current_stage`, `current_phase`, `current_task` (int, not string — **resolves finding #1**), `current_review_round`, `completed_stages`, `phase_progress`, `escalations`, `metrics_summary`

Files: `scripts/pipeline/checkpoint.py`, `scripts/pipeline/test_checkpoint.py`

Done when: state survives crash/reload, migrations can upgrade schema versions, concurrent starts fail fast, stale locks are reclaimed via PID check.

**2.2 Implement dispatch wrappers**

Create `scripts/pipeline/dispatch.py` with the three dispatch functions from the design spec:
- `dispatch_headless(agent, prompt, model, timeout, retries)` — wraps `claude_utils`, `gemini_utils`, `codex_utils`
- `dispatch_worktree(prompt, worktree_path, model, timeout, retries)` — always Claude
- `dispatch_cli(command, env, cwd, timeout)` — subprocess wrapper

Retry policy with explicit classification per CLI tool:
- **Transient (retry):** timeout, exit code 1 with "rate limit" or "429" in stderr, exit code 137 (OOM kill), empty stdout with exit 0, network errors
- **Permanent (no retry):** exit code 1 with "auth" or "invalid" in stderr, exit code 2 (usage error), `dispatch_cli` failures (git/gh are deterministic)
- Exponential backoff with jitter: `base * (2^attempt) + random(0, base)` where base=5s
— **resolves design review finding #13**

Per-agent semaphores (configurable in `pipeline` config section): Claude 5, Codex 5, Gemini 3. Thread-safe GH_TOKEN via per-subprocess env dict — never set process-wide.

`dispatch_cli` takes `command: list[str]` (not a string) — this prevents shell injection. No shell=True.

Files: `scripts/pipeline/dispatch.py`, `scripts/pipeline/test_dispatch.py`

Done when: every invocation yields a typed `DispatchResult`, retries work correctly, parallel dispatch respects semaphores.

**2.3 Implement metrics collection**

Create `scripts/pipeline/metrics.py`:
- Token extraction from Claude JSON (`usage.input_tokens`, `usage.output_tokens`), Codex JSON, Gemini estimation (with `~` prefix flag)
- Cost calculation from `PipelineConfig.model_rates`
- Per-invocation append to `audit.jsonl` (thread-safe via queue or mutex — **resolves design review finding #12**)
- Stage-level aggregation into `StageMetrics`
- Pipeline-level running totals in `metrics_summary`
- Budget ceiling check after each stage **and** after each dispatch invocation within fan-out stages (not just at stage boundaries — a 36-agent design-review dispatch can blow past the budget before the stage completes)
- Token extraction must be resilient: if Claude JSON doesn't contain `usage.input_tokens` (e.g., CLI version changes), log warning and set tokens to None rather than crashing

Files: `scripts/pipeline/metrics.py`, `scripts/pipeline/test_metrics.py`

Done when: totals remain correct across resume boundaries, budget ceiling triggers abort mid-stage if needed.

### Risks
- Resume corruption if state and artifacts diverge: write stage result and artifact metadata in same checkpoint transition.
- Overcounted cost on retries: log per-attempt but only roll successful stage totals into `StageResult.metrics`.

### Verification
```bash
$PYTHON -m pytest scripts/pipeline/test_checkpoint.py scripts/pipeline/test_dispatch.py scripts/pipeline/test_metrics.py -q
python scripts/stark_pipeline.py --prompt "checkpoint test" --dry-run --slug pipeline-smoke --no-tui
```

---

## Phase 3: Read-Only Stage Adapters (design-generate → plan-to-tasks)

**Goal:** Make the front half of the pipeline executable using existing dispatch infrastructure.
**Dependencies:** Phase 2
**Effort:** L (4-5 tasks)

### Tasks

**3.1 Define stage protocol and typed models**

Create `scripts/pipeline/stages.py` with:
- `Stage` protocol (id, dispatch_mode, run, sanity_check, can_skip)
- `PipelineContext` dataclass
- `StageResult`, `StageMetrics`, all `StageOutputs` variants
- `Finding` dataclass with globally unique IDs: `{stage_id}-{task_num}-r{round}-f{ordinal}` — **resolves design review finding #3**
- `Finding.section_kind: Literal["file_path", "doc_heading"]` discriminator — **resolves design review finding #10**
- Severity enum including `"blocker"` — **resolves design review finding #5**

Files: `scripts/pipeline/stages.py`, `scripts/pipeline/test_stages.py`

Done when: all stage result types serialize/deserialize correctly, Finding IDs are provably unique.

**3.2 Implement design-generate and design-review stage adapters**

Wrap `design_to_plan_dispatch.py` (mode=generate) for `design-generate` stage. Wrap `plan_review_dispatch.py` (prompts-dir=design-review) for `design-review` stage. Normalize JSON output into `StageResult` with typed `ReviewOutputs` and `Finding` objects.

Feed design review findings downstream as context to `design-to-plan`.

Files: `scripts/pipeline/stages.py`

Done when: `--start-at design-review` produces a `ReviewOutputs` with normalized findings.

**3.3 Implement design-to-plan and plan-review stage adapters**

Wrap `design_to_plan_dispatch.py` (mode=generate + cross-review) for `design-to-plan`. Wrap `plan_review_dispatch.py` (prompts-dir=plan-review) for `plan-review`.

Files: `scripts/pipeline/stages.py`

Done when: `--start-at design-to-plan` produces a plan doc, `--start-at plan-review` reviews it.

**3.4 Implement plan-to-tasks stage adapter**

This is a significant refactor — split into subtasks:

3.4a. **Extract core logic** from `stark-plan-to-tasks` SKILL.md into `scripts/pipeline/plan_to_tasks.py`. Extract the plan parsing, phase/task decomposition, and issue body generation into callable Python functions (not just subprocess wrappers).

3.4b. **Add idempotent issue creation** — before creating an issue, query existing issues with `plan:{slug}` label using `gh issue list --label "plan:{slug}" --limit 200 --json number,title,labels`. Match by title. Reuse existing issues; only create missing ones. **Critical: use `--limit 200`** to avoid gh's default 30-item truncation.

3.4c. **Add label contract validation** — after issue creation, verify that every issue has both `plan:{slug}` and `phase:{N}` labels. If any are missing, add them. Write `issues.json` manifest only after validation passes.

3.4d. **Handle plan changes on resume** — if `issues.json` exists from a prior run but the plan has changed, detect drift (issue count mismatch, title changes) and escalate rather than silently creating duplicate issues.

Reuse `plan_to_tasks_validate.py` for the 3-LLM validation pass.

Output: `issues.json` manifest with issue numbers, phases, labels.

Files: `scripts/pipeline/plan_to_tasks.py`, `scripts/pipeline/stages.py`, `scripts/pipeline/test_plan_to_tasks.py`

Done when: stage creates or reuses GitHub issues, writes `issues.json`, reruns don't duplicate, label contract is enforced.

**3.5 Implement engine for linear stage sequencing**

Create `scripts/pipeline/engine.py`:
- Load stage list, determine start stage (from `--start-at`, auto-detection, or resume)
- **`--start-at` validation:** if starting mid-pipeline, verify required upstream artifacts exist (e.g., `--start-at plan-review` requires a plan doc; `--start-at phase-execute` requires `issues.json`). If missing, error with "Required artifact from stage X not found. Run from an earlier stage or provide the artifact."
- Execute stages sequentially, checkpoint after each
- Handle design/plan review escalation (critical findings → 4-option escalation, critical can't be skipped)
- **Stub escalation.py import:** the engine needs escalation for review stages, but the full escalation module is Phase 4. Create a minimal `escalation.py` stub in Phase 3 with `escalate(finding, context) -> EscalationResult` that supports the 4-option prompt. Phase 4 extends it with macOS notification, persistence, and non-interactive behavior.
- **Non-interactive escalation:** when `stdin` is not a TTY (headless/CI), auto-select "abort" for critical findings and "skip" for medium findings. Log the decision. This prevents the pipeline from hanging in non-interactive environments.
- `--dry-run` mode prints execution plan

Files: `scripts/pipeline/engine.py`, `scripts/pipeline/escalation.py` (stub), `scripts/pipeline/test_engine.py`

Done when: `python scripts/stark_pipeline.py docs/specs/design.md --start-at design-review` runs through review → plan → review → tasks with checkpointing. `--start-at` rejects missing upstream artifacts.

### Risks
- Skill/Python drift for plan-to-tasks: keep new adapter as single implementation, have skill shell out to it.
- Partial fan-out failures look "clean": enforce <50% coverage = warning, 0 successes = failure.

### Verification
```bash
$PYTHON -m pytest scripts/pipeline/test_stages.py scripts/pipeline/test_engine.py -q
python scripts/stark_pipeline.py docs/superpowers/specs/2026-04-04-stark-pipeline-design.md \
  --start-at design-review --dry-run --no-tui
```

---

## Phase 4: Phase-Execute Engine and Resume-Safe Worktree Loop

**Goal:** Implement the core value: task discovery, implement, test, review-fix loop, PR, merge, resume from any point.
**Dependencies:** Phase 3
**Effort:** L (4-5 tasks)

### Tasks

**4.1 Implement worktree management**

Create `scripts/pipeline/worktree.py`:
- `create_worktree(repo_root, slug, task_num) -> Path` — creates `stark-pipeline-{slug}-task-{num}` worktree
- Worktree **persists across fix rounds** — not cleaned until after diff collection and PR creation — **resolves design review findings #4 and #15**
- Lifecycle: create → implement → test → review → fix → ... → collect_diff → push → create_pr → merge_pr → THEN cleanup
- `collect_diff(worktree_path) -> DiffResult` — captures diff before cleanup
- `cleanup_worktree(worktree_path)` — `git worktree remove --force`
- **Startup sweep safety:** remove orphaned `stark-pipeline-*` worktrees **only for slugs that have no active `state.lock`**. If resuming (`--resume`), **never** sweep the worktree for the current task — check `state.json` for `current_task` and preserve that worktree.
- After each PR merge: refresh local main from the **repo root** (not the worktree CWD): `git -C {repo_root} checkout main && git -C {repo_root} pull --rebase origin main`. **If rebase conflicts:** escalate with details (this means someone else pushed to main during the pipeline run). — **resolves design review finding #7**
- **Disk space guard:** before creating a worktree, check available disk space. If <1GB free, escalate.

Files: `scripts/pipeline/worktree.py`, `scripts/pipeline/test_worktree.py`

Done when: worktrees survive across review-fix rounds, cleanup is reliable, orphan sweep doesn't destroy resumed worktrees, main refresh uses correct CWD.

**4.2 Implement task discovery, implementation dispatch, and phase loop**

Extend `scripts/pipeline/engine.py` with phase-execute logic:
- Discover phases via `gh issue list --label "plan:{slug}" --limit 200 --json number,title,labels,body`. **Critical: `--limit 200`** to avoid default 30-item truncation. If result count equals limit, paginate.
- **Reconciliation gate:** compare discovered issues with `issues.json` manifest. If mismatch (issues deleted, labels changed), escalate before executing.
- Group by `phase:{N}` label, order phases by N, tasks within phase by issue number
- **Per-task loop** (the full inner loop from the design spec):
  1. Create worktree (4.1)
  2. **Dispatch implementation agent** — `dispatch_worktree(prompt, worktree_path)` with the issue body as context. This is step ② from the design spec — the core implementation step.
  3. Run tests in worktree (via `validation_gate.py`)
  4. Review-fix loop (4.3)
  5. Collect diff, push branch, create PR, merge (4.4)
- Sequential task execution within phase, sequential phases
- Checkpoint after each task (PR merged), each review round, each phase

Files: `scripts/pipeline/engine.py`

Done when: `--start-at phase-execute --slug my-feature` discovers issues, dispatches implementation, and iterates phases.

**4.3 Implement review-fix-escalation loop**

Create `scripts/pipeline/escalation.py`:
- 4-option prompt (guidance/skip/manual/abort)
- Critical/blocker findings cannot be skipped
- macOS notification + terminal bell on escalation
- Escalation persistence in state.json

Integrate into engine's per-task loop:
- Step ③/⑧: run tests via `validation_gate.py`
- Step ④: dispatch review via `multi_review.py` or headless wrapper
- Step ⑤: classify findings, check clean
- Step ⑥: escalate on round N with medium+, or immediately on critical
- Step ⑦: dispatch fix agent with structured findings

Files: `scripts/pipeline/escalation.py`, `scripts/pipeline/engine.py`, `scripts/pipeline/test_escalation.py`

Done when: escalation round-trips work, kill-and-resume returns to correct task/round.

**4.4 Implement PR creation, merge, and idempotency**

Extend engine with steps ⑨-⑩:
- Before PR create: check if PR from expected branch exists (`gh pr list --head {branch} --json number`). Reuse if found.
- Before merge: **poll for mergeable status** — `gh pr view {number} --json mergeable,mergeStateStatus`. Wait up to 60s for checks to complete. If not mergeable after timeout, escalate.
- `unset GH_TOKEN` for PR operations (user PAT)
- Phase-end regression test via `validation_gate.py` on main after all phase tasks merged
- **After docs-update PR merge (Phase 5):** refresh local main before release stage

Files: `scripts/pipeline/engine.py`

Done when: retry doesn't create duplicate PRs, merge waits for checks, phase regression test runs.

### Risks
- Branch protection blocks direct pushes: only task branches + PR merges mutate code.
- Cleanup races destroy diffs: collect and persist diff before `git worktree remove`.
- **Rebase conflict after main refresh:** if `git pull --rebase` fails (concurrent pushes to main), escalate with conflict details rather than crashing.

### Verification
```bash
$PYTHON -m pytest scripts/pipeline/test_worktree.py scripts/pipeline/test_engine.py scripts/pipeline/test_escalation.py -q
python scripts/stark_pipeline.py --slug pipeline-test --start-at phase-execute --dry-run --no-tui
```

---

## Phase 5: Post-Merge Stages, Retention, and Release

**Goal:** Complete the pipeline with docs-update, release, housekeeping.
**Dependencies:** Phase 4
**Effort:** M (3-4 tasks)

### Tasks

**5.1 Implement docs-update stage**

Dispatch Claude (headless) with `git diff {base_sha}..HEAD`, current `CHANGELOG.md`, and design spec. Land changes via a short-lived `docs/{slug}` branch + PR rather than direct commit to main — **resolves design review finding #11**.

If the diff is very large, summarize rather than sending full diff (avoid context window limits).

Files: `scripts/pipeline/stages.py`

Done when: docs-update creates/merges a docs PR, escalates on failure.

**5.2 Implement generic release adapter**

Create `scripts/pipeline/release.py`:
- Detect version source: `package.json`, `pyproject.toml`, `setup.cfg`, `__init__.py` (generic, not repo-specific)
- Release-candidate validation gate: tests pass, no uncommitted changes, all phase PRs merged
- Idempotent: check tag existence before creating. If tag exists but GitHub Release doesn't, create Release pointing to existing tag. If both exist, skip. **This prevents the "tag created but Release creation failed" deadlock.**
- `--release-type` flag for bump level
- **Point of no return:** before pushing the tag, prompt for confirmation in interactive mode (or auto-proceed in non-interactive if all validation gates passed)

Files: `scripts/pipeline/release.py`, `scripts/pipeline/stages.py`

Done when: release works for stark-skills without project-specific paths.

**5.3 Implement housekeeping stage and retention**

Housekeeping adapter that:
- Cleans stale branches matching `stark-pipeline-*`
- Removes orphan worktrees
- Archives completed pipeline runs > 30 days
- Rotates `audit.jsonl` > 10MB

Files: `scripts/pipeline/stages.py`, `scripts/pipeline/maintenance.py`

Done when: housekeeping cleans up without deleting active runs.

### Risks
- Release duplication: check tag first, then release, then push once.
- Cleanup deletes active artifacts: only act on runs with no `state.lock` and no recent `updated_at`.

### Verification
```bash
$PYTHON -m pytest scripts/pipeline/test_release.py -q
python scripts/stark_pipeline.py --slug pipeline-test --start-at docs-update --dry-run --no-tui
```

---

## Phase 6: TUI, Skill Wrapper, and End-to-End Verification

**Goal:** Add operator UX after the engine is stable, then verify full pipeline behavior.
**Dependencies:** Phase 5
**Effort:** M (3-4 tasks)

### Tasks

**6.1 Implement TUI**

Create `scripts/pipeline/tui.py`:
- `TuiController` class with `Live` display
- Header bar (slug, elapsed, cost), stage progress table, activity log (20-line rolling buffer)
- Escalation mode (pause Live, show finding, rich.prompt)
- Final summary panel
- `--no-tui` mode: same events as sequential log lines with `[HH:MM:SS]` timestamps and `[type]` prefixes
- Minimum 80-column width, graceful degradation below that

Files: `scripts/pipeline/tui.py`, `scripts/pipeline/test_tui.py`

Done when: TUI updates in real-time without flicker, `--no-tui` produces equivalent information.

**6.2 Write SKILL.md**

Create `skill/stark-pipeline/SKILL.md` matching the design spec contract:
- Parse natural language intent into CLI args
- Entry point detection heuristics
- All CLI flags documented with examples
- Launch `python scripts/stark_pipeline.py [args]` as subprocess

Files: `skill/stark-pipeline/SKILL.md`

Done when: `/stark-pipeline docs/specs/my-feature.md --dry-run` works from Claude Code.

**6.3 Integration and smoke tests**

Add integration tests:
- Dry run with real spec file → correct execution plan
- Resume round-trip: create synthetic state.json, verify continuation point
- Dispatch smoke test: `dispatch_headless("claude", "echo test")` returns valid result
- Idempotent PR detection with mocked `gh`
- CLI arg parsing edge cases

Document manual smoke sequence:
1. `--dry-run` on real design doc
2. Limited live run: `--start-at design-review` only
3. `--start-at phase-execute` on a safe test slug
4. Full end-to-end only after all previous steps pass

Files: `scripts/pipeline/test_integration.py`

Done when: all tests pass, manual smoke path documented.

### Risks
- TUI bugs obscure state: keep `--no-tui` first-class and test equally.
- Skill arg drift from CLI: generate skill usage from argparse source.

### Verification
```bash
$PYTHON -m pytest scripts/pipeline/ -q
python scripts/stark_pipeline.py docs/superpowers/specs/2026-04-04-stark-pipeline-design.md --dry-run
python scripts/stark_pipeline.py docs/superpowers/specs/2026-04-04-stark-pipeline-design.md --dry-run --no-tui
```

---

## Success Criteria (measurable)

The pipeline is complete when all of the following pass:

1. `python scripts/stark_pipeline.py docs/specs/test-design.md --dry-run` produces correct execution plan
2. `python scripts/stark_pipeline.py --resume test-slug` resumes from the correct stage/task/round after a SIGTERM
3. Full unit test suite passes: `$PYTHON -m pytest scripts/pipeline/ -q` with 0 failures
4. A live run from design-review through plan-to-tasks completes with real agent dispatches
5. A live phase-execute run on a test slug implements at least 1 task, reviews it, and merges a PR
6. `--no-tui` output contains all the same information as TUI mode (verified by diff of structured events)
7. `/stark-pipeline --dry-run` from Claude Code matches direct CLI invocation

---

## Integration Points

These are the critical contracts between components. If any is wrong, downstream stages break:

| Contract | Producer | Consumer | Failure Mode |
|----------|----------|----------|-------------|
| `PipelineConfig` | CLI + config.json | engine, stages | Wrong cost rates, missing defaults |
| `Finding` schema | review stages | escalation, fix agent, checkpoint | Mis-handled findings, broken resume |
| `issues.json` + GitHub labels | plan-to-tasks | phase-execute | Skipped tasks, wrong ordering |
| Worktree lifecycle | worktree.py | implement, test, review, diff, PR | Lost diffs, impossible resume |
| Post-merge state | engine (after merge) | docs-update, release | Wrong changelog, broken release |
| `state.json` | checkpoint.py | resume flow, metrics | Corrupt state, lost progress |

## Testing Strategy

- **Unit tests first:** colocated with package (`scripts/pipeline/test_*.py`). Cover: checkpoint migration, dispatch retry classification, metrics aggregation, stage result normalization, finding ID uniqueness, TUI rendering, worktree cleanup.
- **Integration tests second:** CLI dry-run, resume from synthetic state.json, idempotent issue/PR detection with mocked `gh`, worktree round-trips in temp git repos.
- **Manual E2E last:** `--dry-run` on real doc → limited live run (`--start-at design-review`) → phase-execute on test slug → full release only after generic adapter passes.
- **Test order mirrors build order:** Phase 1 tests with Phase 1 code, etc.

## Rollback Plan

| Phase | Rollback |
|-------|----------|
| 1 | Remove `scripts/stark_pipeline.py`, `scripts/pipeline/`, new config block |
| 2 | Disable CLI entrypoint, delete pipeline artifact dirs |
| 3 | Turn off stage adapters, fall back to standalone skills |
| 4 | Disable phase-execute behind CLI guard, clean all `stark-pipeline-*` worktrees |
| 5 | Disable docs-update/release/housekeeping independently; never delete pushed tags |
| 6 | Default to `--no-tui`, remove skill symlink, keep Python engine callable |
