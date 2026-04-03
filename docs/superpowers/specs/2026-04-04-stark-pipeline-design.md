# `stark-pipeline` — End-to-End Feature Orchestrator Design Spec

> Automate the full stark workflow from spec to release: design → review → plan → review → tasks → implement → test → code review → fix → PR → merge → docs → release → housekeeping. Python orchestrator with terminal UI, checkpointing, metrics, and human-in-the-loop escalation.

**Repo:** GetEvinced/stark-skills
**Author:** Aryeh
**Status:** Draft
**Spec:** `docs/superpowers/specs/2026-04-04-stark-pipeline-design.md`

---

## Problem

The stark-skills ecosystem has mature, battle-tested components for every stage of feature development — design generation, multi-agent review, plan creation, task decomposition, implementation, PR workflow, release management, and housekeeping. But they're all standalone: each skill or dispatch script operates independently with its own invocation pattern, state management, and output format.

Running a full feature from spec to release requires manually chaining 10+ skills/scripts, tracking state across sessions, re-entering context after interruptions, and mentally maintaining the pipeline's progress. This is error-prone, time-consuming, and doesn't scale — especially when the human operator (Aryeh) is in meetings and wants autonomous execution with intelligent escalation.

## Goals

1. **Single-command feature pipeline** — from a spec (or prompt) to a tagged release with one invocation
2. **Checkpoint and resume** — survive crashes, interrupts, and multi-session workflows without losing progress
3. **Terminal UI** — real-time progress display with stage status, elapsed time, cost, and activity log
4. **Human-in-the-loop escalation** — pause on critical issues or missing information, collect guidance, resume
5. **Metrics and telemetry** — token counts, cost tracking, timing, quality stats, final summary
6. **Flexible entry point** — start from any stage based on what input is provided (spec, plan, slug, prompt)
7. **Reuse existing infrastructure** — import from existing dispatch scripts, don't duplicate

## Non-Goals

- DAG-based workflow engine (the pipeline is linear with one nested loop — a DAG scheduler adds complexity without value)
- Web dashboard or remote monitoring (v1 is terminal-only; web UI could be v2)
- Full Textual TUI application (rich Live display is sufficient; Textual graduation is a future option)
- Replacing existing dispatch scripts (the pipeline wraps and orchestrates them, doesn't rewrite them)
- Multi-project pipelines (one pipeline = one feature in one repo)
- Custom pipeline definitions (stages are fixed and known; plugin architecture is over-engineering)
- Load testing or stress testing the dispatch layer (v1 targets single-user local execution)

## Success Criteria

1. **End-to-end run completes** — from a design spec to a tagged release with zero manual intervention (assuming no escalations)
2. **Resume works** — kill the pipeline mid-phase-execute, resume with `--resume`, and it continues from the correct task and review round
3. **Escalation round-trips** — pipeline pauses on a persistent medium finding, accepts user guidance, feeds it to the fix agent, and continues
4. **Metrics are accurate** — token counts match CLI output for Claude/Codex; Gemini tokens are estimated from character length (noted as approximate in output, prefixed with `~`). Cost calculations use model rates from config. Timing is wall-clock accurate.
5. **TUI is usable** — stage progress, active task, and activity log update in real-time without flicker or corruption
6. **Dry run is informative** — `--dry-run` shows the full execution plan without running anything
7. **Pre-flight catches missing tools** — startup validates all required CLIs are available before dispatching any work

---

## Architecture

### Dual Interface

The pipeline has two entry points that converge on the same Python engine:

1. **CLI** — `python scripts/stark_pipeline.py [args]` — run directly from terminal
2. **Skill** — `/stark-pipeline [args]` — Claude Code parses intent, launches the Python process

The Python process owns the TUI, state machine, agent dispatch, and checkpoint persistence. Claude Code is one of the agents it dispatches, not the orchestrator.

### Package Structure

```
scripts/
  stark_pipeline.py          ← entry point, argparse, launches engine
  pipeline/
    __init__.py
    engine.py                ← state machine, stage sequencing, resume logic
    stages.py                ← stage definitions (dataclasses, run/sanity_check/can_skip)
    dispatch.py              ← dispatch_headless, dispatch_worktree, dispatch_cli
    tui.py                   ← rich Live display, layout, formatting
    metrics.py               ← token counting, cost calculation, aggregation
    checkpoint.py            ← state persistence, atomic writes, resume sanity checks
    escalation.py            ← human-in-the-loop prompting, guardrail logic
    worktree.py              ← create/cleanup worktrees, collect diffs
    config.py                ← pipeline config loading, model rates, defaults
skill/
  stark-pipeline/
    SKILL.md                 ← Claude Code skill entry point
```

### Integration with Existing Code

The pipeline imports from existing modules rather than duplicating:

| Module | Imported From | Usage |
|--------|--------------|-------|
| `claude_utils` | `scripts/claude_utils.py` | `make_clean_env()`, CLI command building |
| `gemini_utils` | `scripts/gemini_utils.py` | `setup_gemini_home()`, Gemini CLI patterns |
| `config_loader` | `scripts/config_loader.py` | Hierarchical config discovery |
| `github_app` | `scripts/github_app.py` | Bot token retrieval for reviews |
| `session_state` | `scripts/session_state.py` | Patterns for persistent state (not directly used, but same approach) |

---

## State Machine

### Stage Model

The pipeline is a linear sequence of stages. Each stage implements a uniform protocol:

```python
class Stage(Protocol):
    id: str
    dispatch_mode: Literal["headless", "worktree", "cli", "mixed"]

    def run(self, context: PipelineContext) -> StageResult: ...
    def sanity_check(self, context: PipelineContext) -> bool: ...
    def can_skip(self, context: PipelineContext) -> bool: ...
```

- `run()` — execute the stage, return results
- `sanity_check()` — verify prerequisites on resume (trust-but-verify)
- `can_skip()` — return True if the stage's output already exists (used during auto-detection of start stage; the CLI `--start-at` flag bypasses this entirely)

The `dispatch_mode` is `"mixed"` for `phase-execute` which uses both worktree and headless dispatch internally. All other stages use a single mode.

### PipelineContext

Passed to every stage — the shared state of the pipeline run:

```python
@dataclass
class PipelineContext:
    slug: str
    repo_root: Path
    config: PipelineConfig        # review_mode, max_fix_rounds, agents, model_rates
    state: PipelineState          # current_stage, phase_progress, completed_stages
    tui: TuiController            # for logging events and updating display
    checkpoint: CheckpointManager # for persisting state after transitions
```

### StageMetrics

```python
@dataclass
class StageMetrics:
    wall_time_s: float
    tokens_in: int
    tokens_out: int
    cost_usd: float
    invocation_count: int
    findings_count: int       # 0 for non-review stages
```

### Stage Definitions

| Stage ID | Dispatch Mode | Parallelism | Input | Output |
|----------|--------------|-------------|-------|--------|
| `design-generate` | headless | 3 agents parallel | prompt string | design doc (.md) |
| `design-review` | headless | N×12 domains parallel | design doc | findings JSON |
| `design-to-plan` | headless | 3 gen + 6 review parallel | design doc | plan doc (.md) |
| `plan-review` | headless | N×10 domains parallel | plan doc | findings JSON |
| `plan-to-tasks` | headless | 3 sequential LLM passes | plan doc | GitHub issues |
| `phase-execute` | mixed | see inner loop | GitHub issues | branches, PRs |
| `docs-update` | headless | 1 agent (Claude) | merged code + changelog diff | updated CHANGELOG.md, ADR if needed |
| `release` | CLI | sequential | main branch, version bump | git tag, GitHub Release with changelog body |
| `housekeeping` | CLI | 1 agent (Claude) | repo state | cleanup report (stale branches, orphan worktrees) |

### Phase Execute Inner Loop

The `phase-execute` stage contains a nested loop over phases and tasks:

```
for phase in phases:
    for task in phase.tasks:
        ① create worktree
        ② dispatch implement agent (worktree mode)
        ③ run tests in worktree
        for round in 1..max_fix_rounds:
            ④ run code review (headless, single or team)
            ⑤ if clean → break
            ⑥ if round == max_fix_rounds and medium+ findings → escalate
            ⑦ dispatch fix agent in worktree (with structured findings as input)
            ⑧ re-run tests
        ⑨ collect diff, push branch, create PR
        ⑩ merge PR
    end phase → run regression test suite
```

Tasks within a phase execute sequentially (each builds on the previous merge). Phases execute sequentially (later phases depend on earlier ones).

### Review Handling by Stage

**Design review and plan review** produce findings but don't have a fix loop — there's no automated "fix the design" agent. Instead:
- If the review produces only low/medium findings → log them, continue to next stage. Findings are saved to the inter-stage artifacts and passed as context to downstream stages (e.g., design-to-plan receives the design review findings so the plan can address them).
- If the review produces critical/blocker findings → escalate to user using the same 4-option escalation UI as phase-execute:
  1. Provide guidance and retry (user can explain why the finding is acceptable)
  2. Skip and continue (finding logged, pipeline advances)
  3. Fix manually, then resume (user edits the spec, pipeline re-runs the review)
  4. Abort pipeline

**Critical findings cannot be skipped** — option 2 ("skip and continue") is unavailable for critical/blocker findings in any stage. The user must either provide guidance (downgrading the finding), fix manually, or abort. This prevents accidentally shipping known critical issues.

**Phase-execute review-fix loop** has full automated fixing:

- **Auto-fix** for up to `max_fix_rounds` (default: 3) rounds
- **Escalate immediately** on critical/blocker findings in any round
- **Escalate after round N** if medium+ findings persist
- **Log and continue** for low/info findings that survive all rounds
- **Structured feedback** — review findings are parsed into per-file, per-line structured data and fed to the fix agent as specific instructions, not raw review text

### Implementation Agent

Worktree-mode stages (implement, fix) use **Claude** (`claude --yes -p`) as the implementation agent. Claude is the only CLI tool with `--yes` mode for non-interactive full-tool-access sessions. This is not configurable in v1 — codex and gemini are used for headless dispatch only. The `--agents` CLI flag controls which agents are used for headless dispatch stages (reviews, generation), not implementation.

### Task and Phase Schema

Tasks are GitHub issues with these conventions (matching existing `/stark-plan-to-tasks` output):

- **Label:** `plan:{slug}` — binds the issue to this pipeline run
- **Label:** `phase:{N}` — which phase the task belongs to (1-indexed)
- **Label:** `sp:{N}` — story point estimate
- **Label:** `risk:{low|medium|high}` — risk level
- **Body:** structured markdown with "Acceptance Criteria" section

Phases are discovered by querying issues with `plan:{slug}` label, grouped by `phase:{N}` label, ordered by phase number. Tasks within a phase are ordered by issue number (creation order from plan-to-tasks).

### Inter-Stage Artifacts

Each stage produces artifacts at known locations:

| Stage | Artifact | Location |
|-------|----------|----------|
| `design-generate` | Design doc | `docs/superpowers/specs/{date}-{slug}-design.md` |
| `design-review` | Review findings | `pipelines/{slug}/design-review.json` |
| `design-to-plan` | Plan doc | `docs/superpowers/specs/{date}-{slug}-plan.md` |
| `plan-review` | Review findings | `pipelines/{slug}/plan-review.json` |
| `plan-to-tasks` | Issue manifest | `pipelines/{slug}/issues.json` (issue numbers, phases, labels) |
| `phase-execute` | Per-task diffs | `pipelines/{slug}/phases/{N}/task-{issue}.diff` |
| `phase-execute` | Per-task PR | `pipelines/{slug}/phases/{N}/task-{issue}-pr.json` |
| `docs-update` | Changelog entry | `CHANGELOG.md` (appended) |
| `release` | Release info | `pipelines/{slug}/release.json` (tag, URL) |

All paths under `pipelines/` are relative to `~/.claude/code-review/pipelines/`.

### Test Execution Policy

Tests are run at two points in the phase-execute loop:

1. **Per-task (step ③, ⑧):** Run the repo's test suite in the worktree. The test command is discovered from (in order): `package.json` scripts.test, `Makefile` test target, `pytest.ini`/`pyproject.toml`, or `--test-cmd` CLI override. Timeout: 10 minutes (configurable via `--test-timeout`). Failure → the task's review-fix loop begins (tests are treated as an implicit "test failure" finding).

2. **Per-phase (end of phase):** Regression suite on main after all tasks in the phase are merged. Same test command, same timeout. Failure → escalate (the phase's merges may have introduced a regression).

### Docs-Update Stage

The `docs-update` stage dispatches Claude (headless) with a prompt that includes:
- The full git diff since the pipeline's first commit (`git diff {base_sha}..HEAD`)
- The current CHANGELOG.md
- The current design spec

The agent produces: an updated CHANGELOG.md entry for the new version, and optionally an ADR if the changes involve architectural decisions. Output is committed directly to main.

If docs-update fails (agent error, timeout), the pipeline escalates — docs are required before release.

### Release Stage

The `release` stage delegates to the existing `/stark-release` skill pattern:

1. Determine version bump (patch/minor/major) from the plan doc's metadata or `--release-type` CLI flag (default: minor for new features, patch for fixes)
2. Update version in package manifest (`package.json`, `pyproject.toml`, etc.)
3. Commit version bump
4. Create annotated git tag
5. Push tag and commits
6. Create GitHub Release with changelog body

Failure at any step → escalate. Release is not retried automatically (risk of duplicate tags).

### Release-Candidate Validation

Before the release stage begins, the pipeline runs a final validation gate:
- Full test suite passes on HEAD
- No uncommitted changes in working tree
- Current branch is main (or the expected release branch)
- All phase PRs are merged

If any check fails → escalate. This prevents releasing broken or incomplete work.

### StageResult

Every stage returns a uniform result:

```python
@dataclass
class StageResult:
    stage_id: str
    status: Literal["success", "failed", "escalated"]
    outputs: StageOutputs  # typed per-stage output (see below)
    metrics: StageMetrics  # tokens, wall_time, cost, invocation_count
    findings: list[Finding] # review findings (if applicable, empty list otherwise)
    error: str | None      # error message if failed
```

### StageOutputs (typed per-stage)

```python
@dataclass
class DesignGenerateOutputs:
    design_path: Path

@dataclass
class ReviewOutputs:
    findings_path: Path
    findings_count: int
    critical_count: int

@dataclass
class PlanOutputs:
    plan_path: Path

@dataclass
class TasksOutputs:
    issues: list[int]        # GitHub issue numbers
    phases: dict[int, list[int]]  # phase_num → [issue_numbers]
    manifest_path: Path

@dataclass
class PhaseExecuteOutputs:
    phases_completed: int
    tasks_completed: int
    pr_urls: list[str]

@dataclass
class DocsUpdateOutputs:
    changelog_updated: bool
    adr_path: Path | None

@dataclass
class ReleaseOutputs:
    tag: str
    release_url: str

@dataclass
class HousekeepingOutputs:
    branches_deleted: int
    worktrees_cleaned: int

StageOutputs = Union[DesignGenerateOutputs, ReviewOutputs, PlanOutputs,
                     TasksOutputs, PhaseExecuteOutputs, DocsUpdateOutputs,
                     ReleaseOutputs, HousekeepingOutputs]
```

### Finding Schema

Review findings — from design review, plan review, or code review — use a structured format:

```python
@dataclass
class Finding:
    id: str                   # unique within the pipeline run (e.g., "r1-f3")
    agent: str
    domain: str
    severity: Literal["critical", "high", "medium", "low", "info"]
    section: str              # file path (code review) or spec section heading (doc review)
    line: int | None          # line number (code review only)
    title: str
    description: str
    suggestion: str | None    # proposed fix text
    status: Literal["open", "fixed", "skipped", "false_positive"]
    fixed_in_round: int | None
```

This schema is used both in the state.json checkpoint and as input to the fix agent. The fix agent receives findings filtered to `status == "open"` with `section`, `line`, `title`, and `suggestion` fields.

---

## Dispatch Layer

### Three Dispatch Modes

```python
def dispatch_headless(
    agent: str,           # "claude" | "codex" | "gemini"
    prompt: str,
    model: str | None,    # override from config
    timeout: int = 300,
    retries: int = 2,     # retry on transient failures (non-zero exit, timeout)
) -> DispatchResult:
    """Single-prompt-in, text-out. For reviews, generation, plan creation."""

def dispatch_worktree(
    prompt: str,           # always Claude — agent parameter omitted
    worktree_path: Path,
    model: str | None,
    timeout: int = 600,
    retries: int = 1,
) -> DispatchResult:
    """Full tool access in isolated worktree. For implementation and fixes. Always uses Claude."""

def dispatch_cli(
    command: list[str],
    env: dict | None,
    cwd: Path | None,
    timeout: int = 120,    # default 2 min for git/gh commands
) -> DispatchResult:
    """Simple subprocess wrapper. For git, gh, release scripts."""
```

### DispatchResult

```python
@dataclass
class DispatchResult:
    agent: str
    model: str
    success: bool
    stdout: str
    stderr: str
    exit_code: int
    wall_time_s: float
    tokens_in: int | None     # None for CLI mode
    tokens_out: int | None
    cost_usd: float | None    # calculated from tokens × model rate
    parsed: dict | None       # stage-specific parsed output
```

### Resilience

**Retry policy:** `dispatch_headless` retries up to N times (default 2) on transient failures (non-zero exit code, timeout, empty output). Exponential backoff: 5s, 15s. `dispatch_worktree` retries once (implementation is expensive). `dispatch_cli` does not retry (git/gh commands are usually deterministic).

**Error contract:** On final failure after retries, `DispatchResult.success = False` with `stderr` and `exit_code` populated. The calling stage decides whether to escalate or continue with degraded results. For headless dispatch in fan-out stages (reviews), individual agent failures are logged but don't fail the stage — the stage reports partial results with a warning if coverage drops below 50%.

**Worktree cleanup:** On any exit from `dispatch_worktree` (success, failure, timeout, KeyboardInterrupt), the worktree is cleaned up via `git worktree remove --force`. A cleanup sweep also runs at pipeline startup (in case a previous run was killed without cleanup) — removes any worktrees matching the `stark-pipeline-*` naming pattern.

### Parallel Dispatch

Stages that dispatch multiple agents use `ThreadPoolExecutor` with per-agent semaphores:
- **Gemini:** max 3 concurrent (API rate limit — same as `multi_review.py`)
- **Claude:** max 5 concurrent (avoids overwhelming local resources)
- **Codex:** max 5 concurrent

Exceptions in worker threads are caught per-future and recorded in `DispatchResult` — they don't crash the executor or lose other workers' results. The TUI updates as each agent completes.

### Agent Invocation Patterns

- **Claude:** `subprocess.run(["claude", "-p", "-", "--output-format", "json", ...], input=prompt)` via `claude_utils.make_clean_env()`
- **Claude (worktree):** `subprocess.run(["claude", "--yes", "-p", prompt, "--cwd", worktree_path, "--output-format", "json"])`
- **Codex:** `subprocess.run(["codex", "exec", "-m", model, "--json", "-"], input=prompt)`
- **Gemini:** `subprocess.run(["gemini", "-m", model, "-p", prompt, "--yolo"])` via `gemini_utils.setup_gemini_home()`

### GitHub Auth

Follows the existing auth split:

- **User's PAT** (native `gh` auth) for: creating PRs, merging PRs, creating issues
- **Bot tokens** (`stark-claude[bot]`, etc.) for: posting review comments
- `unset GH_TOKEN` before PR/issue operations, `export GH_TOKEN=$(github_app.py token)` for reviews

**Thread safety:** GH_TOKEN is NOT set as a process-wide environment variable. Instead, each dispatch call that needs a bot token gets it via `github_app.py token` and passes it in the subprocess-specific `env` dict. This prevents parallel dispatches from clobbering each other's auth context.

**Token refresh:** GitHub App tokens expire after 1 hour. For long-running pipelines, the dispatch layer calls `github_app.py token` before each batch of review dispatches (not once at startup). The token cache in `~/.cache/github-app-token.json` handles TTL automatically.

---

## Checkpointing & Resume

### State File

Each pipeline run persists to `~/.claude/code-review/pipelines/{repo_owner}/{repo_name}/{slug}/state.json`. The repo owner/name prefix prevents slug collisions across repos (e.g., two repos both having a "webhook-support" feature). Updated after every stage transition and every task completion within phase-execute.

**Concurrent run protection:** At startup, the pipeline acquires a file lock (`state.lock`) in the pipeline directory. If the lock is held, the pipeline prints "Another pipeline run for '{slug}' is in progress" and exits. The lock is released on normal exit, abort, or crash (via `atexit` handler and SIGTERM trap).

```json
{
  "schema_version": 1,
  "slug": "webhook-support",
  "repo": "GetEvinced/stark-skills",
  "started_at": "2026-04-04T09:15:00Z",
  "updated_at": "2026-04-04T10:42:33Z",
  "base_sha": "abc123",
  "input": {
    "type": "design-spec",
    "path": "docs/specs/2026-04-04-webhook-support-design.md",
    "start_stage": "design-review"
  },
  "config": {
    "review_mode": "single",
    "max_fix_rounds": 3,
    "agents": ["claude", "codex", "gemini"],
    "max_cost_usd": 50.0,
    "max_wall_time_s": 14400
  },
  "current_stage": "phase-execute",
  "current_phase": 2,
  "current_task": "WEBHOOK-15",
  "current_review_round": 1,
  "completed_stages": [
    {
      "stage_id": "design-review",
      "status": "success",
      "started_at": "...",
      "finished_at": "...",
      "wall_time_s": 184,
      "outputs": { "findings_path": "...", "findings_count": 24, "critical_count": 0 },
      "metrics": { "tokens_in": 42100, "tokens_out": 8300, "cost_usd": 0.18, "invocation_count": 24 }
    }
  ],
  "phase_progress": {
    "1": {
      "status": "done",
      "tasks": [11, 12, 13],
      "completed_tasks": [11, 12, 13],
      "pr_urls": ["https://github.com/GetEvinced/repo/pull/87"],
      "merged": true
    },
    "2": {
      "status": "in_progress",
      "tasks": [14, 15],
      "completed_tasks": [14],
      "current_task": 15,
      "current_review_round": 1
    }
  },
  "escalations": [ ... ],
  "metrics_summary": { ... }
}
```

### Schema Migration

`schema_version` starts at 1. When the schema changes:
- Bump `schema_version`
- Add a migration function `migrate_v{N}_to_v{N+1}(state: dict) -> dict` in `checkpoint.py`
- On load, if `schema_version < CURRENT_VERSION`, apply migrations sequentially
- Migrations are pure functions (input dict → output dict), tested independently
```

### Checkpoint Frequency

| Event | What's Saved |
|-------|-------------|
| Stage completes | Stage result added to `completed_stages`, `metrics_summary` updated |
| Task completes (PR merged) | `phase_progress` updated with task status, PR URL |
| Review round completes | `current_review_round` updated, findings saved |
| Escalation resolved | Resolution added to `escalations` array |
| Pipeline finishes | Final `metrics_summary`, `completed_at` timestamp |

### Atomic Writes

All state file updates use write-to-temp + rename to prevent corruption on crash:

```python
tmp = state_path.with_suffix(".tmp")
tmp.write_text(json.dumps(state, indent=2))
tmp.rename(state_path)
```

### Resume Flow

```
$ python scripts/stark_pipeline.py --resume webhook-support

1. Load state.json (auto-detected from repo context: repo_owner/repo_name/slug)
2. Acquire file lock (fail if another run is active)
3. Sanity checks (trust-but-verify):
   ✓ Git repo matches state.repo?
   ✓ Expected branches exist?
   ✓ Last PR still open/merged as expected? (gh pr view)
   ✓ GitHub issues with plan:{slug} label still match state?
   For mid-stage resume (interrupted during phase-execute):
   ✓ Worktree for current task exists or can be recreated?
   ✓ HEAD of main matches expected state? (not: "tests pass" — tests are re-run as part of the stage)
4. If all pass → continue from current_stage + current_task + current_review_round
5. If any fail → escalate with details of what changed
```

### Idempotency for External Operations

Operations that create external resources (GitHub issues, PRs, releases) must be idempotent on retry:

- **plan-to-tasks:** Before creating an issue, check if an issue with matching title and `plan:{slug}` label already exists. If so, reuse it.
- **PR creation:** Before creating a PR, check if a PR from the expected branch already exists. If so, reuse it.
- **Release:** Before creating a tag, check if the tag already exists. If so, skip tagging and create the GitHub Release pointing to the existing tag (or skip if Release also exists).

### Metrics Across Sessions

Metrics accumulate across resume boundaries. `metrics_summary` running totals are additive. The final summary reflects the entire run regardless of how many sessions it took.

### Budget Ceiling

The pipeline enforces optional cost and time ceilings (from config or CLI flags):

- `--max-cost N` — abort if `metrics_summary.total_cost_usd` exceeds N (default: no limit)
- `--max-time N` — abort if wall time exceeds N seconds (default: 4 hours)

When a ceiling is hit, the pipeline saves state and exits with a clear message. Resume is possible after adjusting the ceiling.

### Retention and Cleanup

Pipeline artifacts in `~/.claude/code-review/pipelines/` are retained indefinitely by default. The `housekeeping` stage (and `/stark-housekeeping`) can clean up:

- Completed pipeline runs older than 30 days: archive `state.json` and `summary.json`, delete diffs and audit logs
- Failed/abandoned pipeline runs (no update in 7 days): prompt for deletion
- `audit.jsonl` files larger than 10MB: rotate (keep last 10MB, archive the rest)

---

## Terminal UI

### Technology

Built with `rich` only — `rich.live.Live`, `rich.table.Table`, `rich.panel.Panel`, `rich.prompt.Prompt`. No Textual dependency.

### Layout

Three zones stacked vertically, updating in-place via `Live`:

1. **Header bar** — pipeline name, slug, elapsed time, running cost
2. **Stage progress table** — all stages with status (✓/●/○), wall time, cost, key output. Active stage highlighted. Within phase-execute, shows per-task breakdown.
3. **Activity log** — rolling buffer of last 20 events with timestamps, color-coded by type (dispatch, review, fix, escalation)

### Escalation Mode

When the pipeline needs human input:
- Live display pauses
- Header turns red with "⚠ ESCALATION — Pipeline paused"
- Shows: task context, specific finding, what the agent tried
- Four options via `rich.prompt`:
  1. Provide guidance and retry — user text fed to agent as additional context
  2. Skip and continue — finding logged as skipped, pipeline advances
  3. Fix manually, then resume — pipeline waits, user edits code, presses Enter
  4. Abort pipeline — state saved, can `--resume` later

### Final Summary

On completion, displays: total duration (with per-stage breakdown), total cost, token counts, quality stats (found/fixed/skipped/escalated), phases completed, PRs merged, release tag, docs updated.

### `--no-tui` Mode

Plain log output for CI, piped execution, or screen reader users. Same information, just sequential log lines instead of live display. Each line prefixed with `[HH:MM:SS]` timestamp and event type tag (`[stage]`, `[dispatch]`, `[review]`, `[fix]`, `[escalation]`) — no color-only differentiation. This is the accessible alternative to the Live TUI.

### Terminal Compatibility

- **Minimum width:** 80 columns. Below that, the TUI degrades gracefully (truncates long paths, hides cost column).
- **Activity log:** Event type is indicated by both color AND text prefix (`[review]`, `[fix]`, etc.) so information isn't lost in monochrome terminals.
- **Escalation mode:** Uses `rich.prompt.Prompt` which works in any terminal that supports stdin.

---

## Metrics & Telemetry

### Three Aggregation Levels

1. **Per-invocation** — every dispatch call logged to `pipelines/{slug}/audit.jsonl` (agent, model, tokens, cost, wall_time, success)
2. **Per-stage** — aggregated in `StageResult.metrics` (total tokens, cost, wall_time, invocation_count, findings_count)
3. **Pipeline total** — running totals in `state.json` `metrics_summary`, final snapshot to `pipelines/{slug}/summary.json`

### Token Tracking

- **Claude:** parsed from `--output-format json` response (`usage.input_tokens`, `usage.output_tokens`)
- **Codex:** parsed from `--json` response
- **Gemini:** estimated from prompt/response character length (Gemini CLI doesn't report tokens)

### Cost Calculation

Built-in rate table in `config.json` (overridable):

| Model | Input $/1M | Output $/1M |
|-------|-----------|------------|
| claude-opus-4-6 | $15.00 | $75.00 |
| claude-sonnet-4-6 | $3.00 | $15.00 |
| gpt-5.4 (codex) | $2.50 | $10.00 |
| gemini-2.5-pro | $1.25 | $10.00 |
| gemini-2.5-flash | $0.15 | $0.60 |

### Summary Output

Final summary written to terminal (rich Panel) and `pipelines/{slug}/summary.json`:

```json
{
  "slug": "webhook-support",
  "duration_s": 6120,
  "total_tokens_in": 612000,
  "total_tokens_out": 98000,
  "total_cost_usd": 7.34,
  "stages_completed": 9,
  "phases_completed": 3,
  "tasks_implemented": 7,
  "prs_merged": ["#87", "#88", "#89"],
  "review_rounds_total": 11,
  "avg_review_rounds_per_task": 1.57,
  "issues_found": 47,
  "issues_fixed": 45,
  "issues_skipped": 2,
  "escalations": 1,
  "release_tag": "v1.4.0"
}
```

---

## Escalation Engine

### Triggers

| Trigger | When | Severity |
|---------|------|----------|
| Critical/blocker finding | Any review round | Immediate pause |
| Medium+ persists after round N | Round N = `max_fix_rounds` | Pause after round |
| Resume sanity check fails | On `--resume` | Before continuing |
| Stage failure | Agent crash, timeout, test failure | After failure |

### Response Options

Consistent across all trigger types:

1. **Provide guidance and retry** — user's text is appended to the agent's prompt as additional context for the next attempt
2. **Skip and continue** — logged as skipped with reason, pipeline advances to next task/stage. **Not available for critical/blocker findings** — user must provide guidance, fix manually, or abort.
3. **Fix manually, then resume** — pipeline waits at a prompt, user edits code externally, presses Enter to trigger re-validation and continue
4. **Abort pipeline** — state saved at current position, can `--resume` later

### Escalation Notification

When the pipeline pauses for escalation and the user is not actively watching the terminal, it needs a way to get attention:

- **macOS notification:** `osascript -e 'display notification "Pipeline paused — needs input" with title "stark-pipeline"'`
- **Terminal bell:** `\a` character sent to stdout (works in most terminals, triggers system notification if configured)
- **Log line:** `[HH:MM:SS] ⚠ ESCALATION — pipeline paused, waiting for input` (visible in scrollback)

All three fire simultaneously when an escalation begins. No external notification service required for v1.

### Escalation Persistence

Every escalation is recorded in `state.json`:

```json
{
  "at": "2026-04-04T10:30:00Z",
  "stage": "phase-execute",
  "task": "WEBHOOK-14",
  "round": 3,
  "trigger": "medium_persisted",
  "finding": "Missing rate limit on webhook dispatch endpoint",
  "agent_attempts": ["Added per-URL throttle (round 2)", "Added global counter (round 3)"],
  "resolution": "User guidance: add token bucket rate limiter, 100 req/min per tenant",
  "resolved_at": "2026-04-04T10:35:00Z",
  "action": "retry_with_guidance"
}
```

---

## CLI Interface

### Entry Point

```
usage: stark_pipeline.py [-h] [--slug SLUG] [--prompt PROMPT]
                        [--start-at STAGE] [--resume SLUG]
                        [--review-mode {single,team}]
                        [--max-fix-rounds N] [--dry-run]
                        [--agents AGENTS] [--no-tui]
                        [--max-cost USD] [--max-time SECONDS]
                        [--test-cmd CMD] [--test-timeout SECONDS]
                        [--release-type {patch,minor,major}]
                        [input]

positional arguments:
  input                 path to design spec or plan (.md file)

options:
  --slug SLUG           pipeline identifier (default: derived from input filename)
  --prompt PROMPT       raw requirement string (starts from design generation)
  --start-at STAGE      override entry point stage
  --resume SLUG         resume a previous pipeline run
  --review-mode MODE    "single" (1×9) or "team" (3×9) code reviews (default: single)
  --max-fix-rounds N    max review-fix iterations per task (default: 3)
  --dry-run             show execution plan without running
  --agents AGENTS       comma-separated agent list for headless dispatch (default: claude,codex,gemini)
  --no-tui              disable live TUI, plain log output (also serves as accessibility mode)
  --max-cost USD        abort if total cost exceeds this (default: no limit)
  --max-time SECONDS    abort if wall time exceeds this (default: 14400 = 4 hours)
  --test-cmd CMD        override test command (default: auto-detected from project)
  --test-timeout SECS   test suite timeout in seconds (default: 600)
  --release-type TYPE   version bump type: patch, minor, major (default: minor)
```

Note: `--agents` controls which agents are used for **headless dispatch** stages (reviews, generation, plan creation). Implementation and fix stages always use Claude regardless of this flag.

### Entry Point Detection

When no `--start-at` is provided, the pipeline infers the starting stage:

| Input | Heuristic | Start Stage |
|-------|-----------|-------------|
| `.md` file with "Architecture", "Components" | Design spec | `design-review` |
| `.md` file with "Phase", "Tasks", "Implementation" | Plan doc | `plan-review` |
| `--slug` with existing `plan:{slug}` GitHub issues | Issues exist | `phase-execute` |
| `--prompt` string | Raw requirement | `design-generate` |
| `--resume` | Existing state.json | Saved `current_stage` |

### Pre-Flight Check

Before any dispatch, the pipeline verifies all required tools are available:

```
$ python scripts/stark_pipeline.py docs/specs/webhook-design.md

Pre-flight check:
  ✓ claude (v1.x.x)
  ✓ codex (v1.x.x)
  ✓ gemini (v1.x.x)
  ✓ gh (v2.x.x) — authenticated as aryeh-evinced
  ✓ git (v2.x.x)
  ✓ python3 scripts venv — OK
```

If any tool is missing or auth fails, the pipeline prints what's wrong and exits before starting any work. Agents not in the `--agents` list are skipped (e.g., `--agents claude,codex` skips the gemini check).

### Dry Run

`--dry-run` outputs the full execution plan:

```
Pipeline: webhook-support
Entry point: design-review (detected from input file)
Agents (headless): claude, codex, gemini
Implementation: claude

Stages to execute:
  1. design-review     — 3 agents × 12 domains = 36 dispatches
  2. design-to-plan    — 3 generate + 6 cross-review = 9 dispatches
  3. plan-review        — 3 agents × 10 domains = 30 dispatches
  4. plan-to-tasks      — 3 sequential LLM passes
  5. phase-execute      — phases TBD (depends on task decomposition)
  6. docs-update        — 1 dispatch (claude)
  7. release            — CLI commands (minor)
  8. housekeeping       — 1 dispatch (claude)

Estimated dispatches: 80+ (excluding phase-execute)
Review mode: single (1×9 per task)
Max fix rounds: 3
Budget: no cost limit, 4h time limit
```

---

## `/stark-pipeline` Skill

### SKILL.md Contract

```yaml
name: stark-pipeline
description: End-to-end feature pipeline — design through release
args: [input_path] [--slug NAME] [--prompt "..."] [--resume NAME]
      [--start-at STAGE] [--review-mode single|team]
      [--max-fix-rounds N] [--dry-run] [--no-tui]
      [--agents AGENTS] [--max-cost USD] [--max-time SECONDS]
      [--test-cmd CMD] [--release-type patch|minor|major]
```

The skill's job is to:

1. Parse the user's natural language intent into CLI arguments
2. Validate the input exists (if a file path)
3. Launch `python scripts/stark_pipeline.py [args]` as a subprocess
4. The Python process takes over the terminal (TUI)

### Entry Point Detection in Skill

The skill includes heuristics for mapping user intent:

- `/stark-pipeline docs/specs/my-feature.md` → file input, auto-detect start stage
- `/stark-pipeline --slug my-feature` → existing issues, start at phase-execute
- `/stark-pipeline --prompt "Add webhook support"` → raw prompt, start at design-generate
- `/stark-pipeline --resume my-feature` → resume from checkpoint

---

## Installation

`install.sh` is updated to:

1. Symlink `scripts/pipeline/` to `~/.claude/code-review/scripts/pipeline/`
2. Symlink `scripts/stark_pipeline.py` to `~/.claude/code-review/scripts/stark_pipeline.py`
3. Symlink `skill/stark-pipeline/` to `~/.claude/skills/stark-pipeline`
4. Create `~/.claude/code-review/pipelines/` directory if it doesn't exist

No new Python packages required — `rich` is already in the venv.

---

## Testing Strategy

### Unit Tests (`scripts/pipeline/test_*.py`)

| Module | What's Tested | Approach |
|--------|---------------|----------|
| `checkpoint.py` | Atomic writes, schema migration, resume sanity checks, concurrent lock | File system operations with temp dirs |
| `config.py` | Config loading, cost rate lookup, CLI arg merging | Pure functions, no I/O |
| `metrics.py` | Token extraction from CLI JSON, cost calculation, aggregation | Known input → expected output |
| `escalation.py` | Trigger classification, critical-skip prevention | Unit test guardrail logic |
| `stages.py` | `can_skip()` heuristics, entry point detection | Mock file system, mock GitHub API responses |
| `engine.py` | Stage sequencing, resume-from-midpoint, budget ceiling enforcement | Mock stages that return canned StageResults |
| `tui.py` | Layout rendering, no-tui mode output formatting | Snapshot tests against known state |
| `worktree.py` | Worktree creation, cleanup, orphan detection | Real git repos in temp dirs |

### Integration Tests

| Scenario | What's Verified |
|----------|----------------|
| **Dry run** | `--dry-run` with a real spec file produces correct execution plan |
| **Single stage** | `--start-at release --dry-run` from a real state file |
| **Resume round-trip** | Create state file, kill engine, resume, verify continuation point |
| **Dispatch smoke test** | `dispatch_headless("claude", "echo test", ...)` returns valid DispatchResult |
| **Idempotent PR creation** | Create PR, re-run PR creation step, verify no duplicate |

### What's NOT Tested in Automation

- Full end-to-end pipeline runs (too expensive, too slow — verified manually)
- Agent output quality (that's what the review-fix loop is for)
- GitHub App auth (requires real credentials — tested via smoke test in CI with `--dry-run`)

---

## Dependencies

### Python (existing in repo)

- `rich` — TUI display (Live, Table, Panel, Prompt)
- `subprocess` — agent dispatch
- `concurrent.futures` — ThreadPoolExecutor for parallel dispatch
- `json` — state persistence
- `argparse` — CLI argument parsing
- `dataclasses` — stage and result models
- `pathlib` — file path handling
- `time` — wall clock timing

### External Tools (already installed)

- `claude` CLI — Claude Code agent dispatch
- `codex` CLI — Codex agent dispatch
- `gemini` CLI — Gemini agent dispatch
- `gh` CLI — GitHub PR/issue operations
- `git` — branch and worktree management

### No New Dependencies

The pipeline uses only Python stdlib + `rich` (already a dependency of the repo). No new packages to install.
