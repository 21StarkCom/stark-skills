# `stark-hosts` - Host-Aware Monorepo Architecture Design Spec

> Extract the reusable Stark engine from the current Claude-bound skill system, preserve Claude as a first-class host product, and build Codex as a native host product instead of a compatibility clone.

**Repo:** `GetEvinced/stark-skills`  
**Author:** Aryeh  
**Status:** Draft  
**Spec:** `docs/superpowers/specs/2026-04-05-stark-host-aware-monorepo-design.md`  
**Companion visualization:** `docs/skills/monorepo-architecture.html`

---

## Problem

The current `stark-skills` repo is not just "Claude-authored skills." It is a Claude-shaped product stack:

- skill installation targets `~/.claude/skills/`
- runtime state is written under `~/.claude/code-review/`
- observability assumes Claude task semantics
- session and analytics features read Claude-specific history/state locations
- skill validation enforces Claude-specific frontmatter

That means a naive Codex duplication would copy the wrong architecture.

Today, the repo mixes four concerns that should be separated:

1. **Shared workflow behavior** - prompts, orchestration logic, telemetry schema, run artifacts, evaluation fixtures
2. **Host UX** - how a workflow is exposed to the operator in Claude or Codex
3. **Runtime state** - history, sessions, telemetry, artifacts, caches
4. **Provider/worker logic** - Claude, Codex, and Gemini as participating review/generation agents

Because those concerns are entangled, the system has three structural problems:

1. **Portability debt** - shared logic is polluted by `~/.claude` assumptions
2. **Maintenance debt** - adding a second host by copying `SKILL.md` files guarantees drift
3. **Product debt** - Codex would inherit Claude's UX shape instead of getting a native experience

The right solution is not "duplicate the skills for Codex." The right solution is to make the host boundary explicit and move the reusable system behind that boundary.

## Goals

1. **Make Stark host-aware** - distinguish shared workflow behavior from host-specific UX and installation
2. **Build Codex as a first-class host** - Codex should feel native, not like an awkward Claude translation
3. **Preserve Claude value during migration** - existing Claude workflows keep working while the core is extracted
4. **Normalize runtime state** - history, sessions, telemetry, and artifacts live in Stark-owned storage, not host-owned hidden directories
5. **Keep workflow behavior single-source** - prompts, orchestration, contracts, and evals live once
6. **Make host drift measurable** - use shared contracts and cross-host evals to prevent silent divergence
7. **Reduce future host cost** - adding a third host should be an adapter exercise, not a repository fork

## Non-Goals

- Literal 1:1 duplication of the current `skill/` tree for Codex
- A generator-first architecture that compiles one giant canonical `SKILL.md` into multiple hosts
- A full rewrite of all Python orchestration before the boundary is established
- Simultaneous redesign of every low-value or deeply host-bound workflow
- Replacing the per-worker prompt model (`claude`, `codex`, `gemini`) with a host-agnostic prompt model
- Renaming the GitHub repo as part of this migration
- Building a web control plane or remote SaaS runtime

## Success Criteria

1. **No shared package reads `~/.claude` directly** - all host-specific paths are accessed only through host adapters
2. **Claude remains operational** - the current Claude-based entrypoints still work during and after migration
3. **Codex first wave ships natively** - `stark-review`, `stark-team-review`, `stark-design`, `stark-design-to-plan`, and `stark-review-plan` are usable from Codex without Claude compatibility shims in the shared engine
4. **Runtime state is normalized** - new runs write history, telemetry, and artifacts under `~/.stark/runtime/` (sessions are deferred to Phase C)
5. **Shared behavior is tested once** - shared workflow contracts and output semantics are verified by host-independent tests
6. **Host wrappers are intentionally thin** - each host product mainly handles invocation UX, capability mapping, and result rendering
7. **Provider/worker concepts remain separate from host concepts** - "Codex the worker" and "Codex the host" are represented distinctly in config and code

---

## Terminology

This distinction is mandatory. The current repo overloads "claude" and "codex" in ways that become confusing once Codex is both a worker and a host.

### Host

The operator-facing product that invokes Stark workflows.

Examples:

- `claude-code`
- `codex-cli`

A host owns:

- user-facing skill wrappers
- install flow
- progress UX
- session integration
- host-specific compatibility/migration logic

### Worker

An AI engine/CLI used as a generation or review participant inside a workflow.

Examples:

- `claude`
- `codex`
- `gemini`

A worker owns:

- prompt family selection
- CLI invocation details
- model/version selection
- output parsing and failure handling

### Workflow

The durable Stark behavior: review, design generation, design-to-plan, plan review, plan-to-tasks, execution, release, etc.

Workflows belong to the shared Stark engine, not to any host.

### Adapter

A host-specific implementation of the capability interface required by shared workflows.

Examples:

- progress reporter
- runtime path resolver
- session/history reader
- install/status checker

### Runtime

The Stark-owned on-disk state used by workflows across hosts.

This spec standardizes runtime state under `~/.stark/runtime/`.

---

## Core Architectural Decision

Adopt a **host-aware monorepo** with:

- a shared Stark core for workflows, orchestration, prompts, contracts, and evals
- a Claude host product
- a Codex host product
- a Stark-owned runtime

Do **not** center the new architecture on shared giant `SKILL.md` files.

The current skill markdown is a product wrapper, not the real source of truth. The true source of truth should become:

1. workflow contracts
2. shared orchestration/runtime code
3. shared prompt assets
4. shared eval suites

Host skill files should become thin wrappers around that system.

---

## Why Monorepo

The best solution is a monorepo, but not a fake monorepo.

### Correct monorepo shape

One repository containing:

- shared engine
- shared contracts
- shared evals
- host-specific products

### Incorrect monorepo shape

One repository containing:

- `skill/` for Claude
- `skill-codex/` for Codex
- duplicated markdown with small path edits

That second version preserves duplication while hiding it in one repo. It is worse than an honest fork.

### Why monorepo beats a full fork

1. **Shared versioning** - prompts, schemas, orchestration, and evals move together
2. **Boundary enforcement** - cross-package imports reveal host leakage immediately
3. **Operational simplicity** - one CI surface, one release discipline, one backlog
4. **Cheaper long-term evolution** - new workflows are added once in core, then wrapped per host

### Why monorepo beats a generator-first system

The user experience should diverge when the hosts differ. A generator-first system encourages fake parity and turns host design into template arguments.

Generation is acceptable for:

- manifests
- indexes
- compatibility shims
- install metadata
- derived docs

Generation should not own the primary authoring model for host UX.

---

## Proposed Repository Topology

The repo keeps the current root for now (`stark-skills`) and evolves into this layout:

```text
stark_core/                # Python package (pip-editable install)
  workflows/               # shared workflow implementations
  orchestration/           # dispatch, aggregation, run lifecycle
  runtime/                 # runtime read/write, atomic ops, locking
  telemetry/               # event emission, schema validation
  workers/                 # worker invocation, parsing, retry
  adapters/                # HostAdapter base protocol + capability protocols
prompts/                   # shared prompt families (from global/prompts/)
  pr-review/
    claude/
    codex/
    gemini/
  design-review/
  plan-review/
  design-to-plan/
  autopilot/
contracts/                 # schemas and capability definitions
  workflows/               # per-workflow input/output/artifact schemas
  capabilities/            # host + worker capability definitions
  telemetry/               # telemetry event schema
standards/
evals/
  golden/
  fixtures/
  adapter-conformance/
  smoke/
hosts/
  claude/
    skills/                # SKILL.md wrappers (Claude slash commands)
    adapters/
    install/
    docs/
    compatibility/
  codex/
    agents/                # AGENTS.md entries or Codex-native wrappers
    adapters/
    install/
    docs/
runtime/
  migrations/
scripts/
  stark_install.py
  stark_doctor.py
  migrate_runtime_state.py
docs/
  skills/
  superpowers/
  architecture/
```

### Layer responsibilities

| Layer | Owns | Does not own |
|---|---|---|
| `stark_core/` | workflow behavior, orchestration, prompt routing, worker invocation, runtime APIs, adapter base protocols | host UI, host frontmatter, host install locations |
| `contracts/` | schemas and capability definitions (workflow I/O, artifacts, telemetry, capabilities) | implementation details |
| `evals/` | shared verification of behavior | host-specific UX assertions |
| `hosts/claude/` | Claude SKILL.md wrappers, Claude adapter, install flow, migration shims | shared workflow semantics |
| `hosts/codex/` | Codex AGENTS.md wrappers, Codex adapter, install flow | shared workflow semantics |
| `runtime/` | runtime migrations and storage conventions | host-specific install entrypoints |

---

## Host Boundary Rules

These rules are the most important part of the design.

### Python packaging model

`stark_core/` is a pip-installable Python package with a `pyproject.toml`. During development, it is installed as an editable package (`pip install -e .`) in the shared venv at `scripts/.venv/`. The installer (`stark_install.py`) ensures the editable install is current. Host wrappers and scripts import `from stark_core.workflows import ...` — no path manipulation required.

This replaces the current `scripts/` directory's direct path imports. Existing scripts that are not yet migrated into `stark_core/` remain in `scripts/` and are migrated incrementally.

### Shared core may do

- read workflow contracts
- read prompts
- dispatch workers
- emit normalized telemetry
- read and write Stark runtime state
- call adapter interfaces supplied by a host

### Shared core may not do

- read `~/.claude/...` directly
- read host skill directories directly
- assume Claude task/progress primitives
- require host-specific frontmatter
- embed host-specific installer behavior

### Host products may do

- implement their own skill wrappers
- map host UX into shared capabilities
- maintain migration shims for legacy layouts
- expose host-native progress and error messages

### Host products may not do

- redefine shared workflow contracts
- fork shared prompt logic without a deliberate, tracked decision
- write incompatible runtime artifacts
- bypass shared evals for a workflow that claims parity

---

## Shared Workflow Model

The center of gravity moves from giant host markdown into explicit workflow definitions.

### Workflow definition

Each workflow gets a canonical definition in `contracts/workflows/<workflow>.json` and a matching implementation in `stark_core/workflows/`.

Example schema shape:

```json
{
  "id": "stark-review",
  "version": 1,
  "category": "review",
  "summary": "PR review with classified findings and optional fix loop",
  "inputs": {
    "pr_number": { "type": "integer", "required": false },
    "repo": { "type": "string", "required": false },
    "agent_override": { "type": "string", "required": false },
    "dry_run": { "type": "boolean", "required": false }
  },
  "host_capabilities": [
    "progress",
    "runtime_paths"
  ],
  "core_services": [
    "runtime_history",
    "worker_dispatch"
  ],
  "external_prerequisites": [
    "git_shell",
    "gh_auth_status"
  ],
  "artifacts": [
    "review_summary",
    "classified_findings",
    "timing_metrics"
  ],
  "outcomes": [
    "success",
    "degraded",
    "blocked"
  ],
  "degradation_policy": {
    "min_workers": 1,
    "outcome_if_below": "blocked",
    "outcome_if_partial": "degraded"
  }
}
```

The three capability fields match the taxonomy in **Host capability taxonomy**: `host_capabilities` are resolved via the adapter, `core_services` are always available from `stark_core`, `external_prerequisites` are validated at workflow start against the environment. First-wave workflows must not require `session_state` (deferred to Phase C).

### Contract versioning policy

Contracts use integer versioning. Rules:

- **Additive changes** (new optional fields, new optional capabilities) increment the version but do not break existing consumers
- **Breaking changes** (field removal, type change, new required field) require a new major version and a migration script in `runtime/migrations/`
- History records and artifacts include a `contract_version` field so readers can apply the correct deserialization path
- Hosts declare the minimum contract version they support; shared core rejects invocations where the installed contract version is below the host's declared minimum

Phase 1 defines contracts only for the 5 first-wave workflows. Remaining workflows are contractized when they are extracted, not before.

### Workflow result schema

Every shared workflow returns a `WorkflowResult` to the host wrapper:

```json
{
  "run_id": "stark-review-20260405-143022-a1b2c3",
  "workflow_id": "stark-review",
  "contract_version": 1,
  "outcome": "success | degraded | blocked",
  "artifacts": [
    {"type": "review_summary", "path": "~/.stark/runtime/artifacts/..."}
  ],
  "worker_results": [
    {"worker_id": "claude", "status": "success | partial | failed", "error": null}
  ],
  "degradation_detail": null,
  "blocked_reason": null,
  "telemetry_ref": "~/.stark/runtime/telemetry/..."
}
```

All host wrappers must accept this structure. Hosts may render it differently but may not require additional fields from the shared workflow.

### Worker degradation policy

Each workflow contract includes a `degradation_policy` field:

```json
{
  "degradation_policy": {
    "min_workers": 1,
    "outcome_if_below": "blocked",
    "outcome_if_partial": "degraded"
  }
}
```

For `stark-team-review` with 3 workers: 2-of-3 = degraded, 1-of-3 = degraded, 0-of-3 = blocked. This is defined per-workflow, not globally.

### Workflow implementation

Each workflow implementation lives in shared Python and depends only on:

- the workflow contract
- shared runtime/state helpers
- worker adapters
- host capability interfaces

### Workflow wrappers

Each host then adds a thin wrapper that:

- exposes arguments in host-native form
- obtains a host adapter
- invokes the shared workflow
- renders the result

This is intentionally the opposite of the current system, where the markdown wrapper contains most of the operational detail.

---

## Host Adapter Model

Each host must implement a stable capability interface.

### Host capability taxonomy

Host capabilities and core services are distinct. Workflow contracts reference both but must label them clearly:

| Type | Examples | Provided by |
|---|---|---|
| **Host capabilities** | `progress`, `interaction`, `session_state`, `runtime_paths`, `environment`, `telemetry_sink`, `artifact_presentation` | Host adapter implementation |
| **Core services** | `runtime_history`, `worker_dispatch` | Shared `stark_core` — always available |
| **External prerequisites** | `git_shell`, `gh_auth_status` | Environment — validated at workflow start, not by adapter |

Workflow contracts declare all three types but in separate fields, so the runtime knows where to resolve each.

### Required vs optional host capabilities

| Capability | Required for first wave | Purpose |
|---|---|---|
| `progress` | yes | show phases, status, and live updates in host-native form |
| `runtime_paths` | yes | resolve Stark runtime locations and host compatibility paths |
| `interaction` | yes | ask questions, present options, display structured summaries |
| `environment` | yes | detect host version, install layout, CLI availability |
| `telemetry_sink` | optional | emit host metadata alongside normalized workflow events |
| `session_state` | optional | expose current session metadata and checkpoint access |
| `artifact_presentation` | optional | open, link, or surface generated artifacts in a host-native way |

Optional capabilities degrade gracefully — shared core skips them if the adapter does not implement them.

### Python interface

The adapter is split into a required base and optional capability protocols:

```python
@dataclass
class ProgressHandle:
    """Thread-safe handle for updating progress from worker threads."""
    def update(self, phase: str, status: str, detail: str | None = None) -> None: ...
    def end(self, outcome: str) -> None: ...

@dataclass
class EnvironmentInfo:
    host_id: str
    host_version: str | None
    install_root: Path
    cli_available: dict[str, bool]  # worker CLI availability

class HostAdapterBase(Protocol):
    """Required — every host must implement this.
    Thread-safety: progress() and its ProgressHandle must be thread-safe.
    ask_choice() is serialized by shared core (never called from worker threads).
    """
    host_id: str                    # canonical host ID (e.g., "claude-code", "codex-cli")
    host_version: str | None

    # Progress (context manager — thread-safe)
    @contextmanager
    def progress(self, workflow_id: str, phases: list[str]) -> Iterator[ProgressHandle]: ...

    # Runtime paths — failure here is BLOCKING (workflow cannot proceed)
    def runtime_root(self) -> Path: ...
    def compatibility_paths(self) -> dict[str, Path]: ...

    # Interaction (serialized by shared core)
    def ask_choice(self, prompt: str, options: list[str], default: str | None = None) -> str: ...

    # Environment
    def environment_info(self) -> EnvironmentInfo: ...

    # Capability discovery
    def supported_capabilities(self) -> set[str]: ...


class TelemetrySink(Protocol):
    """Optional — adapters that emit host-enriched telemetry."""
    def emit_host_event(self, event_type: str, payload: dict) -> None: ...


class SessionStateProvider(Protocol):
    """Optional — adapters that expose session metadata."""
    def get_session_context(self) -> SessionContext: ...


class ArtifactPresenter(Protocol):
    """Optional — adapters that surface artifacts in host-native UX."""
    def present_artifact(self, artifact_type: str, path: Path) -> None: ...
```

### Adapter error contract

- All adapter method calls in shared core are wrapped with try/except at the call site
- Adapter exceptions for non-critical capabilities (`progress`, `telemetry_sink`) are logged as `host_adapter_failure` telemetry events and silently tolerated
- Adapter exceptions for critical capabilities (`runtime_paths`) surface as workflow-level `blocked` outcomes — the workflow cannot proceed without a valid runtime root
- `environment_info()` failure defaults to `blocked` because the safe starting assumption is that host environment validation is required; a workflow may explicitly relax this and accept degraded environment info when it has no external prerequisites to validate
- `ask_choice()` failure is `blocked` when the workflow requires an interactive decision and has no valid default; if the workflow contract explicitly allows a default and one is supplied, shared core may continue with that default
- Adapters that cannot fulfill a declared capability raise `AdapterCapabilityError`; shared core probes `supported_capabilities()` at workflow start

### Adapter concurrency contract

Shared workflows dispatch workers in parallel via `ThreadPoolExecutor`. Adapter implementations **must be thread-safe** for `progress` methods (which will be called from worker threads). Shared core serializes calls to `ask_choice` (which is interactive and cannot overlap). This requirement is enforced by adapter conformance tests.

### Adapter-specific behavior

Claude adapter responsibilities:

- map progress into Claude-style task/progress UX
- read any legacy `~/.claude` state during migration
- preserve existing `/stark-*` affordances where practical

Codex adapter responsibilities:

- expose Codex-native wrappers and progress UX
- avoid inheriting Claude terminology or path assumptions
- integrate with Stark runtime directly instead of via Claude compatibility shims

---

## Worker Model

Workers remain a shared-core concept and are distinct from hosts.

### Worker IDs

- `claude`
- `codex`
- `gemini`

### Why the distinction matters

`hosts/codex` is not the same thing as `workers/codex`.

Examples:

- A Codex host may invoke a workflow that dispatches Claude, Codex, and Gemini workers
- A Claude host may invoke a workflow that dispatches Codex workers

This separation prevents architecture confusion and config mistakes.

### Worker dispatch contract

The interface between shared workflow orchestration and individual workers is defined by `WorkerDispatchRequest` and `WorkerDispatchResult`:

```python
@dataclass
class WorkerDispatchRequest:
    worker_id: str          # "claude" | "codex" | "gemini"
    prompt_family: str      # e.g., "pr-review/architecture"
    inputs: dict            # workflow-specific inputs
    timeout_s: int = 300    # per-worker timeout budget
    max_retries: int = 1    # retry once on transient failure (auth refresh, network)

@dataclass
class WorkerDispatchResult:
    worker_id: str
    status: str             # "success" | "partial" | "failed"
    raw_output: str | None
    parsed_findings: list[dict] | None
    error: str | None
    duration_s: float
```

### Worker CLI safety

All worker CLI invocation **must** use Python's `subprocess` with argument lists. `shell=True` and string interpolation of workflow inputs into CLI commands are prohibited. The `agent_override` input is validated against the allowlist of known worker IDs before use. This is enforced by security conformance tests.

### Worker ownership

Workers stay in `stark_core/workers/` and own:

- CLI invocation details
- model selection
- worker-specific prompt family routing
- output parsing
- retry/failure handling

They do not own:

- host UX
- host session state
- host installation

---

## Prompt Ownership

Prompt families remain shared assets because they describe worker behavior inside workflows, not host behavior.

### Prompt layout

Current prompt families under `global/prompts/` move into `prompts/` at the repo root.

Example:

```text
prompts/
  pr-review/
    claude/
    codex/
    gemini/
  design-review/
  plan-review/
  design-to-plan/
  autopilot/
```

### What stays shared

- per-worker prompt families
- domain prompts
- agent preambles
- judge prompts

### What becomes host-local

- host-facing instruction wrappers
- install guidance
- progress conventions
- host UX explanations

This lets the system keep per-worker prompt sophistication without forcing host wrappers to mirror each other.

---

## Runtime Layout

The runtime moves to Stark-owned storage.

### Canonical runtime root

`~/.stark/runtime/`

### Layout

```text
~/.stark/runtime/
  manifest.json              # runtime schema version, migration epoch
  history/
    reviews/
    design-reviews/
    plan-reviews/
  telemetry/
    events.jsonl             # single append-only log (V1 — no DB infrastructure)
  artifacts/
    <workflow>/<run-id>/     # run-scoped: e.g., stark-review/20260405-143022-a1b2c3/
  cache/
  locks/
  migrations/
```

Sessions, autopilot, and tournament directories are added when those workflows are extracted (Phase C). V1 uses only what the first-wave workflows need.

### Run-scoped namespacing

Every workflow invocation is assigned a run ID (`<workflow>-<timestamp>-<short-uuid>`) at execution start. All artifact and history writes for that invocation are scoped under `artifacts/<workflow>/<run-id>/`. The `WorkflowResult` includes the `run_id` so host wrappers and telemetry reference the same scope. This prevents concurrent runs from colliding.

### Telemetry model (V1)

V1 telemetry uses `events.jsonl` as the single canonical store. No SQLite databases in V1. DB infrastructure is added later only if a measured throughput or reliability requirement demands it.

Concurrent writes to `events.jsonl` use `flock(LOCK_EX)` with a short timeout (100ms). If the lock cannot be acquired, the event is dropped with a warning — telemetry is best-effort. Each event is a single JSON line terminated by newline.

Telemetry writes are **best-effort, not blocking**. A full, corrupt, or contended telemetry store logs a warning and skips the event — it does not block the workflow. Only artifact and history writes are on the critical path.

Telemetry events must not contain secrets, credentials, or raw source code. Events that include code excerpts (e.g., review findings) use a truncated hash reference to the artifact, not inline content.

### Concurrency model

- Artifact writes are isolated by run-scoped directories — parallel runs cannot collide
- History writes use atomic temp-then-rename within run-scoped paths
- `locks/` uses file locks with a heartbeat-based liveness protocol:
  - Lock files contain `{"pid": N, "host_id": "...", "workflow_id": "...", "heartbeat": "<ISO timestamp>"}`
  - The lock holder updates `heartbeat` every 30 seconds while running
  - A lock is considered stale only when **both** the PID is no longer running (checked via `os.kill(pid, 0)`) **and** the heartbeat is older than 2 minutes. TTL alone is not sufficient — a long-running migration or review may legitimately hold a lock for longer than any fixed TTL.
  - If a prospective acquirer finds a stale lock, it removes it and re-acquires. If the lock holder is still alive (PID check passes), the acquirer waits up to 30 seconds then fails as `blocked`.
  - `stark_doctor.py` can force-remove locks with `--force-unlock` after confirming the PID is dead
- Telemetry appends use `flock` with short timeout; contention drops the event rather than blocking
- Multiple workflows from different hosts writing to the same runtime root is supported without coordination beyond the file-lock convention

### Retention policy

Runtime storage has configurable retention:

```json
{
  "runtime": {
    "retention": {
      "history_days": 365,
      "telemetry_days": 90,
      "artifacts_days": 30,
      "cache_days": 7
    }
  }
}
```

Retention is enforced by `stark-housekeeping`, which is deferred to Phase C. Until then, retention is manual (`find ~/.stark/runtime/artifacts -mtime +30 -delete` or equivalent). Growth estimate: ~50KB per review run, ~500 runs/year = ~25MB/year — retention is for hygiene, not capacity pressure. No automated enforcement is needed in Phase A/B at this scale.

### File permissions

Directories under `~/.stark/runtime/` are created mode 0700. Files are created mode 0600. This scopes access to the owning user. Encryption at rest is not required for V1 (single-user local tool) but may be evaluated for environments where review artifacts contain security findings.

### Secrets management

Secrets (GitHub App private keys, worker API tokens) are **never** stored in config JSON or in `~/.stark/runtime/`. The approved secret storage backends are:

- macOS Keychain (current approach — retained)
- Environment variables (for CI)

Workers and host adapters retrieve secrets via `stark_core.secrets.get_secret(key, scope)` which abstracts the backend. Rotation policy is per-secret-type and documented in the ops runbook.

### Runtime rules

1. New writes go to `~/.stark/runtime/`
2. During migration, the Claude host adapter may read legacy state from `~/.claude/code-review/`
3. Legacy reads are adapter-only behavior, not shared-core behavior
4. Compatibility shims may mirror or migrate selected legacy files, but the canonical source of truth is Stark runtime
5. The `manifest.json` records the runtime schema version; startup code checks it and runs pending migrations automatically

### Relationship to `~/.stark-insights`

`~/.stark-insights` is a separate system: a local Docker container + SQLite queue (`queue.db`, `buffer.db`) that receives telemetry events via HTTP POST and syncs to Cloud SQL. It is provisioned by `install.sh` today and referenced by hooks in `config/settings.json`, multiple skills, and `scripts/emit_queue.py`.

**Decision: `~/.stark-insights` is not migrated into `~/.stark/runtime/`. It remains a separate system.**

Rationale:

- `stark-insights` is a service with its own API, schema, Docker container, and deployment lifecycle. It is not "runtime state" — it is a downstream consumer of events.
- `~/.stark/runtime/telemetry/events.jsonl` is the local durable log. `stark-insights` is the analytics pipeline that consumes from it (or from the existing local queue).
- Merging them would couple the local runtime to a service deployment, which is the opposite of the runtime independence this spec establishes.

What changes:

- `install.sh` currently creates `~/.stark-insights/`. The new `stark_install.py` does **not** create or manage it — that remains `stark-insights`'s own installer responsibility.
- Skills that emit to `stark-insights` via HTTP POST continue to do so. The V1 telemetry (`events.jsonl`) is a parallel local store, not a replacement for the insights pipeline.
- If `stark-insights` is down, events go to `events.jsonl` only. If `stark-insights` is up, events go to both. The two stores are independent and may be reconciled later if needed.
- `config/settings.json` hooks that reference `~/git/Evinced/stark-insights/` are host-specific install config (Claude adapter) and move to `hosts/claude/install/` during Phase B.

### Why this is necessary

Runtime state belongs to Stark, not to Claude. As long as the runtime lives under `~/.claude`, Claude remains the accidental platform owner.

---

## Configuration Model

Config must distinguish host config from worker config.

### Host ID convention

Canonical host IDs use the full name: `claude-code`, `codex-cli`. The install CLI accepts short aliases (`claude`, `codex`) that map to canonical IDs. Config files always use canonical IDs.

### Config ownership model

There are three config scopes with strict ownership. No field appears in more than one scope.

| Scope | File | Owns | Does not own |
|---|---|---|---|
| **Shared** | `stark.config.json` (repo root) | workers, runtime, workflow defaults | host install paths, host compatibility, host feature flags |
| **Org overlay** | `org/<org>/config.json` | per-org worker overrides, per-org workflow defaults | host install, shared runtime root |
| **Host** | `hosts/<host>/install/config.json` | install root, compatibility mode, host feature flags, hooks | workers, runtime, workflow semantics |

The canonical config loading function lives in `stark_core.config` and replaces both `scripts/config_loader.py` (reads `~/.claude/code-review/config.json`) and `scripts/plan_to_tasks_validate.py`'s inline loader (merges global → repo). One loader, one merge order.

### Merge order

`stark.config.json` → `org/<org>/config.json` → `hosts/<host>/install/config.json`

Later scopes override earlier scopes for keys they own. A host config that attempts to set a `workers` key is rejected at load time (schema validation). A shared config that contains host-specific `install_root` is rejected. This is enforced by the config schema, not by convention.

### Shared config shape

```json
{
  "workers": {
    "claude": {
      "enabled": true,
      "default_model": "claude-sonnet-4-6"
    },
    "codex": {
      "enabled": true,
      "default_model": "gpt-5.4"
    },
    "gemini": {
      "enabled": true,
      "default_model": "gemini-3.1-pro"
    }
  },
  "runtime": {
    "root": "~/.stark/runtime",
    "retention": {
      "history_days": 365,
      "telemetry_days": 90,
      "artifacts_days": 30
    }
  },
  "workflow_defaults": {
    "stark-team-review": {
      "worker_set": ["claude", "codex", "gemini"],
      "timeout_s": 300,
      "degradation_policy": { "min_workers": 1 }
    }
  }
}
```

Note: `stark-team-review` is the multi-worker workflow. `stark-review` is single-agent and does not set `worker_set` here.

### Host config shape (example: Claude)

```json
{
  "host_id": "claude-code",
  "install_root": "~/.claude/skills",
  "compatibility_mode": "read-legacy-runtime",
  "hooks": {
    "pre_session": "~/.stark-insights/hooks/skill-setup.py"
  }
}
```

Host-specific install paths, compatibility behavior, and hooks live here — never in shared config.

### Required config decisions

1. **Workers and workflow defaults are shared-owned — never in host config**
2. **Host install paths and compatibility modes are host-owned — never in shared config**
3. **Runtime root is shared-owned and host-neutral**
4. **Config merge order is shared → org → host, enforced by schema validation**
5. **One canonical loader in `stark_core.config` replaces both existing loaders**
6. **Host IDs are canonical (claude-code, codex-cli); short aliases for CLI only**
7. **Cross-scope key pollution is a load-time error, not a silent merge**

### Migration rule

The existing `global/config.json` is migrated into `stark.config.json` (shared fields only). The existing `config/settings.json` is split: host-specific fields go to `hosts/<host>/install/config.json`, hooks go to host config. Any field that mixes host and worker concerns is rejected at migration time and requires manual resolution.

---

## Packaging and Install Model

Installation must become host-aware while keeping the repo operable during migration.

### New installer model

Introduce a shared installer entrypoint:

```bash
python3 scripts/stark_install.py --host claude     # alias for claude-code
python3 scripts/stark_install.py --host codex      # alias for codex-cli
python3 scripts/stark_install.py --host all
```

### Installer responsibilities

Shared installer:

- bootstrap `~/.stark/runtime/` (create directories, write `manifest.json`)
- ensure `stark_core` is installed as editable package in `scripts/.venv/`
- validate shared config/contracts
- run host-specific install steps

Host installer:

- install host wrappers into host-expected locations
- install host-specific docs/compatibility files
- validate host-specific prerequisites (e.g., Codex CLI version supports AGENTS.md)

### Installer idempotency

All install and migration commands are idempotent and safe to re-run:

- Repeated execution produces the same result without duplication
- Each step records a checkpoint; interrupted installs resume from the last checkpoint on re-run
- `stark_install.py --status` reports current state without modifying anything
- `migrate_runtime_state.py` uses migration epoch markers to prevent re-processing migrated records

### Compatibility decision

Keep the current root `install.sh` during migration, but make it a thin compatibility wrapper around the new installer.

Behavior:

- default behavior remains Claude install
- explicit `--host codex` becomes the new Codex path
- over time, the old Claude-only assumptions are removed from `install.sh`

This avoids a disruptive cutover while moving the architecture in the right direction.

---

## Documentation Model

The new system needs three kinds of documentation.

### Shared architecture docs

Stored under `docs/superpowers/` and `docs/architecture/`.

Examples:

- this spec
- migration specs
- ADRs
- shared contract docs

### Host docs

Stored under:

- `hosts/claude/docs/`
- `hosts/codex/docs/`

Examples:

- host install guides
- host UX expectations
- host compatibility notes

### Generated/visual docs

Continue to live under `docs/skills/` for now. If the docs tree is reorganized later, that move is documentation-only and does not change architecture ownership.

The HTML visualization created for this proposal stays useful as a companion artifact, but it is not the normative source of truth. This spec is.

---

## Execution Model

The execution path for all workflows follows the same shape.

1. User invokes a host wrapper
2. Host wrapper parses and validates host-facing inputs
3. Host wrapper constructs a host adapter
4. Shared workflow executes against the adapter and shared worker/runtime services
5. Shared workflow emits normalized artifacts and telemetry
6. Host wrapper renders the result natively

### What varies by host

- invocation syntax
- live progress UX
- session integration
- installation path
- compatibility behavior

### What must not vary by host

- workflow semantics
- artifact schema
- telemetry schema
- outcome classification
- worker participation logic

This guarantees that a workflow can be host-native in UX while still being one coherent Stark workflow.

---

## Control and Data Flow

This section makes the runtime flow explicit.

### Invocation flow

1. A host wrapper receives user input
2. The host wrapper validates host-facing syntax and options
3. The host wrapper creates a host adapter
4. Shared workflow code loads its contract and required prompts
5. Shared workflow code dispatches workers as needed
6. Shared workflow code writes normalized artifacts and telemetry to Stark runtime
7. The host wrapper renders the result for the operator

### Artifact flow

For a workflow like `stark-review`, the data path is:

1. host input -> normalized workflow input
2. normalized workflow input -> worker dispatch requests
3. worker outputs -> parsed findings/results
4. parsed results -> normalized artifacts in `~/.stark/runtime/artifacts/`
5. normalized artifacts -> host-rendered summary/output

### Telemetry flow

1. shared workflow emits workflow events
2. host adapter adds host metadata
3. events are written to Stark runtime telemetry storage
4. metrics/reporting tools read the shared telemetry schema, not host-specific folders

The consequence is deliberate: the host can change presentation without changing the artifact or telemetry contract.

---

## Failure and Compatibility Handling

The architecture must fail in predictable ways. A clean boundary is not enough if failures leak across it.

### Workflow outcomes

All shared workflows resolve to one of three outcomes:

- `success` - workflow completed as intended
- `degraded` - workflow completed with a tolerated reduction in behavior or coverage
- `blocked` - workflow could not proceed safely

Hosts may render these differently, but they may not invent new shared outcome semantics.

### Failure ownership

| Failure class | Owner | Required behavior |
|---|---|---|
| worker CLI/auth/model failure | shared core worker layer | normalize to structured `WorkerDispatchResult` with `status: "failed"`, emit telemetry, return degraded or blocked per workflow `degradation_policy` |
| host progress/render failure | host adapter | must not corrupt shared artifacts; logged as `host_adapter_failure` event and silently tolerated |
| artifact/history write failure | shared runtime layer | fail the workflow as blocked; never silently continue after artifact/history write failure |
| telemetry write failure | shared runtime layer | **best-effort**: log warning, skip the event, continue workflow. Telemetry is not on the critical path |
| legacy compatibility read failure | Claude host adapter | fall back to Stark runtime only; never make shared core aware of Claude paths |
| install validation failure | host installer | abort before partial installation is reported as successful; resume from checkpoint on re-run |

### Compatibility policy

Claude compatibility is **read-through only** during migration:

- shared code writes only to `~/.stark/runtime/`
- Claude adapter may read old `~/.claude/code-review/` state when needed
- migration tooling may copy or transform legacy state into Stark runtime
- no new shared behavior may depend on the legacy path existing

### Migration source precedence

When both legacy and new runtime contain data for the same logical entity:

1. `~/.stark/runtime/` is always the source of truth for any record that exists there
2. Legacy `~/.claude/code-review/` is read only for records that do not yet exist in Stark runtime
3. Once a record is migrated (copied to Stark runtime), the legacy copy is never read again
4. `manifest.json` records a migration epoch; records created before the epoch are candidates for legacy read-through, records after are Stark-only

### Migration rollback

`migrate_runtime_state.py` operates in three phases:

1. **Validate** — verify source and destination, estimate volume, report plan
2. **Copy-then-verify** — copy records in batches, verify each batch, write checkpoint
3. **Mark complete** — write migration epoch to `manifest.json`

The script supports `--dry-run` (report only), `--batch-size N` (bound memory), and `--rollback` (restore read-through for pre-migration records). Legacy data is never deleted by the migration script — only marked as migrated.

**Rollback limitation:** Runs that completed after migration started wrote artifacts only to `~/.stark/runtime/` — they have no legacy copy. Rollback restores read-through for pre-migration records but cannot undo post-migration runs. The rollback command warns about this and lists affected run IDs so the operator can decide whether to proceed.

### Write safety

Mutable runtime state (history records, session state, migration checkpoints) must use atomic writes:

- write to temp file in the same directory
- fsync
- rename into canonical location

Write-once artifacts (review markdown, JSON reports) scoped under run-ID directories do not require atomic rename — they are written once and never updated. Telemetry appends to `events.jsonl` are protected by `flock` and remain best-effort rather than part of the critical write path.

### Run commitment model

A workflow run is committed when its history record is written as the final step, after all artifacts are in place. Analytics and re-run detection only consider runs with a committed history record. If artifact writes succeed but the history record fails, the run is treated as incomplete and artifacts are orphaned (cleaned by retention policy).

---

## Migration of Existing Repo Content

This section defines how the current repo maps into the target architecture.

| Current location | Target location | Decision | Phase |
|---|---|---|---|
| `skill/stark-*/SKILL.md` | `hosts/claude/skills/stark-*/SKILL.md` | Move into Claude host product | B |
| `global/prompts/` | `prompts/` | Shared core, repo root | A |
| `scripts/multi_review.py` and related orchestrators | `stark_core/orchestration/` | Shared core, keep entrypoint shims as needed | A |
| `scripts/metrics.py` | split between `stark_core/telemetry/` and host adapters | Shared aggregation plus host-specific access | B |
| `scripts/skill_router.py` | shared logic in `stark_core/`, host wrapper integration in each host | Split | B |
| `standards/observability.md` | shared observability contract in `contracts/telemetry/` plus host docs | Split | A |
| `global/config.json` | `stark.config.json` (shared config at repo root) | Shared config — host-neutral settings | A |
| `config/settings.json` | `hosts/claude/install/config.json` and `hosts/codex/install/config.json` | Host-owned install config | B |
| `install.sh` | temporary wrapper over `scripts/stark_install.py` | Compatibility shim, retired after Phase B | B |
| `org/evinced/` | `org/evinced/config.json` (org overlay in config merge chain) | Migrate into host-aware config overlay format | B |

### Migration principle

Do not reorganize the whole repo in one shot. Extract boundaries first, then move files once ownership is obvious.

---

## Codex Product Strategy

Codex should not be a parity clone.

### Codex invocation model

Codex CLI uses `AGENTS.md` as its extensibility surface. Each Codex workflow wrapper is an entry in `hosts/codex/agents/AGENTS.md` that describes the workflow, its arguments, and how to invoke the shared engine. This is the Codex equivalent of Claude's `SKILL.md` files.

**Prerequisite:** This design assumes Codex CLI reads `AGENTS.md` from a configurable location (analogous to `~/.claude/skills/`). If `codex-cli` does not support this or uses a different extension mechanism, the Codex adapter and wrapper format must be revised before Phase B begins. This is a **blocking open item** to validate before starting Codex work.

### First-wave Codex workflows

Ship these first:

1. `stark-review`
2. `stark-team-review`
3. `stark-design`
4. `stark-design-to-plan`
5. `stark-review-plan`

### Why these first

- they are the highest-value core workflows
- they already lean most heavily on shared orchestration/prompt assets
- they have the least dependence on Claude-specific session/history assumptions
- they are enough to prove the architecture without rebuilding every host-bound utility

### Explicitly not first wave

Do not port these in the first Codex wave:

- `stark-session`
- `stark-session-insights`
- `stark-skill-analytics`
- `stark-housekeeping`
- `stark-persona`

These workflows are more entangled with Claude-specific session and analytics assumptions. They should be redesigned after the runtime and adapter model exist.

---

## Claude Product Strategy

Claude remains a first-class host product, but it stops being the implicit architecture.

### Claude obligations

- remain functional during migration
- provide legacy runtime compatibility while migration is active
- move host-specific logic out of shared scripts over time

### Claude limitations after migration

Claude may keep host-specific wrappers and compatibility shims, but it does not get to define:

- canonical runtime paths
- shared artifact schemas
- shared telemetry schemas
- the shape of host-neutral workflow contracts

This is the critical governance change.

---

## Testing and Verification Strategy

The new architecture must be defended by tests at multiple levels.

### 1. Unit tests

Fast, hermetic, no live workers required. Cover:

- worker invocation and failure normalization (using stubs)
- runtime atomic write semantics
- contract schema validation
- prompt routing decisions
- config merge order

### 2. Contract tests

For every workflow contract:

- schema is valid
- required capabilities are declared and classified (host / core / external)
- outputs/artifacts reference defined artifact schemas
- workflow ID/version are stable

### 3. Adapter conformance tests

For each host adapter:

- required capabilities exist and match `supported_capabilities()` output
- progress lifecycle is supported (including concurrent calls from worker threads)
- runtime root resolution is correct and scoped under `~/.stark/runtime/`
- optional capabilities degrade gracefully when absent
- compatibility reads behave as specified (Claude adapter only)

### 4. Security conformance tests

Mandatory in CI:

- static analysis: shared core contains no `~/.claude` path literals
- worker invocation: `subprocess` called with list, never `shell=True`
- runtime file permissions: created files are mode 0600, directories mode 0700
- secrets: no credentials in config JSON or runtime artifacts

### 5. Failure scenario tests

Map each failure class from the Failure Handling section to test cases:

- runtime artifact write failure → workflow outcome is `blocked`
- worker auth failure → normalized to `WorkerDispatchResult(status="failed")`, outcome per `degradation_policy`
- telemetry write failure → warning logged, workflow continues
- legacy compatibility read failure → falls back to Stark runtime without surfacing to shared core
- install validation failure → abort without partial install reported as success

### 6. Cross-host golden tests

For each first-wave workflow, a golden test runs the same inputs through both hosts and asserts:

1. **Outcome equivalence:** `WorkflowResult.outcome` is identical (same `success`/`degraded`/`blocked`)
2. **Artifact structural equivalence:** artifacts in `~/.stark/runtime/artifacts/<workflow>/<run-id>/` have the same set of files, same top-level JSON keys, same field types. Values may differ (timestamps, run IDs, host metadata) but the schema shape must match.
3. **Worker participation equivalence:** `WorkflowResult.worker_results` lists the same set of `worker_id` entries with compatible `status` values (both hosts dispatched the same workers)
4. **Finding-count tolerance:** for review workflows, the classified findings count from each host must be within ±10% or ±2 absolute (whichever is greater), since non-deterministic model output can vary across runs. The test asserts structural equivalence, not content identity.

What is explicitly **not** required to match:

- host UX output (progress messages, terminal rendering)
- run IDs and timestamps
- telemetry event payloads (host metadata differs by design)
- exact finding text (model output is non-deterministic)

This definition makes the golden tests executable: they compare JSON structure and counts, not string equality. A failing golden test must report which specific assertion failed (outcome, artifact shape, worker set, or finding count) so the root cause is immediately visible.

### 7. Smoke tests

For installed hosts:

- host install succeeds and is idempotent
- host wrapper can invoke a simple shared workflow
- artifacts are written to `~/.stark/runtime/artifacts/<workflow>/<run-id>/`
- host-specific entrypoints are discoverable

### 8. Migration tests

For Claude compatibility:

- successful full migration (copy-then-verify)
- interrupted migration recovery (resume from checkpoint)
- legacy runtime data readable through Claude adapter when not yet migrated
- new runs write to Stark runtime
- no shared code depends on direct `~/.claude` access

### Test environment strategy

| Test type | Worker dependency | Where it runs |
|---|---|---|
| Unit, contract, security conformance | Stubs/fixtures only | CI (always) |
| Adapter conformance | Lightweight adapter stub | CI (always) |
| Failure scenario | Stubs with injected failures | CI (always) |
| Cross-host golden | Live workers with auth | Gated CI (requires credentials) |
| Smoke | Live install + minimal workflow | Gated CI or manual |
| Migration | Fixture legacy data | CI (always) |

### Verification gate

No workflow may claim host parity until it passes:

- contract tests
- adapter conformance
- security conformance
- one failure scenario test per failure class
- one cross-host golden test
- one installed smoke test

---

## Operational Model

The architecture should simplify operations, not complicate them.

### Shared operational commands

Introduce shared tooling:

- `python3 scripts/stark_doctor.py --host claude`
- `python3 scripts/stark_doctor.py --host codex`
- `python3 scripts/stark_install.py --host <name>`
- `python3 scripts/migrate_runtime_state.py --from claude [--dry-run] [--rollback]`

### Doctor responsibilities

`stark_doctor.py` is a **diagnostic tool** (advisory, not blocking). It checks:

- shared runtime directories exist and have correct permissions
- `manifest.json` is present and schema version is current
- `stark_core` package is importable
- contracts and prompts are present for configured workflows
- host install state (wrappers present, symlinks valid)
- worker CLI availability and auth status
- stale lock recovery (PID liveness check + heartbeat expiry, per the lock protocol in Concurrency model)
- prints remediation steps per host

Deferred to Phase B — not required for Phase A (the conformance test suite validates architecture during Phase A).

### Release policy

Versioning should track:

- shared core changes
- host product changes
- runtime schema changes

At minimum, release notes must state whether a change affects:

- shared workflows
- Claude host
- Codex host
- runtime schema

---

## Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Shared core still leaks Claude assumptions | The whole migration fails if `~/.claude` remains the hidden source of truth | adapter-only legacy access plus tests that reject shared direct access |
| Codex becomes a thin Claude translation | Product quality drops and maintenance cost stays high | require Codex-owned wrappers and reject generator-first parity as the default |
| Excessive reorg churn stalls delivery | Big-bang structure changes will create noise without value | extract contracts and adapters before moving everything |
| Worker vs host confusion causes config bugs | `codex` can mean two different things | separate `hosts` and `workers` in config and code |
| Runtime migration breaks analytics/history | legacy history is valuable and cannot be dropped casually | support read-legacy compatibility through Claude adapter and explicit migration scripts |
| Low-value workflows consume the roadmap early | the effort gets diluted into edge workflows | enforce first-wave scope and defer deeply host-bound workflows |
| Codex CLI does not support configurable skill/agents directory | entire Codex host product design is blocked | validate Codex extensibility model as a prerequisite before Phase B Codex work begins |
| Phase A contracts are over-specified before real implementation validates them | rework cost amplified across unused contracts | limit Phase A to 5 first-wave workflow contracts only |

---

## Rollout Plan

The original 5 phases are collapsed to 3, reflecting actual dependencies. Runtime normalization moves before host extraction (not after), because writing to `~/.stark/runtime/` from day one avoids dual-write complexity.

### Phase A — Shared foundation (contracts + runtime + adapter interface)

Deliver:

- `stark_core/` Python package with `pyproject.toml` and editable install
- `~/.stark/runtime/` bootstrapping (directories, `manifest.json`, telemetry `events.jsonl`)
- workflow contracts for the 5 first-wave workflows only (not all 26)
- `WorkflowResult` schema, `WorkerDispatchRequest/Result` schema
- `HostAdapterBase` protocol + optional capability protocols
- host/worker config split (`stark.config.json`)
- adapter conformance test harness
- security conformance tests (no `~/.claude` in shared core, subprocess list-only, file permissions)
- `migrate_runtime_state.py` with dry-run and rollback support

Exit criteria: adapter conformance tests pass with a test adapter, `stark_core` is importable, runtime directories exist and are writable.

Do not deliver yet:

- host products
- low-value workflow migrations
- full Codex or Claude wrappers

### Phase B — Host products (Claude extraction + Codex first wave, in parallel)

Deliver:

- `hosts/claude/` — Claude SKILL.md wrappers, Claude adapter, legacy compatibility reads, compatibility `install.sh` wrapper
- `hosts/codex/` — Codex AGENTS.md wrappers (or equivalent), Codex adapter, install flow
- Codex wrappers for the five priority workflows
- `org/evinced/` migrated into host-aware config overlay format
- cross-host golden tests for first-wave workflows
- installed smoke tests for both hosts
- migration of `config/settings.json` into host-specific install config
- retirement of `install.sh` compatibility shim (replaced by `stark_install.py`)

Exit criteria: both hosts pass adapter conformance + golden tests + smoke tests. Specifically, for each first-wave workflow: outcome equivalence, artifact structural equivalence, worker participation equivalence, and finding-count tolerance as defined in the cross-host golden test specification (see Testing and Verification Strategy).

**Blocking prerequisite for Codex:** validate that `codex-cli` supports a configurable extension/agents directory before starting Codex wrappers. **Owner: Aryeh. Deadline: before Phase B Codex work begins.** If Codex CLI does not support this, the fallback is a Python CLI entrypoint (`python3 -m stark_core.cli stark-review ...`) that Codex invokes via its tool-use or shell capabilities.

### Phase C — Redesign host-bound workflows

Deliver:

- session/analytics strategy on top of normalized runtime
- redesigned experiences for `stark-session`, `stark-session-insights`, `stark-skill-analytics`, `stark-housekeeping`, `stark-persona`
- runtime directories for sessions, autopilot, tournaments (added when workflows need them)

This phase is a **separate spec**. The current spec does not define its deliverables at implementation-plan detail. The deferred workflows remain Claude-only until Phase C is planned and executed.

---

## Recommended Decisions Summary

This spec makes these concrete decisions:

1. **Use a monorepo**
2. **Make the monorepo host-aware**
3. **Keep shared workflow behavior in `stark_core/`** (flat Python package, not nested `packages/core/python/`)
4. **Treat Claude and Codex as separate host products**
5. **Keep worker prompts and worker invocation in shared core**
6. **Move runtime state to `~/.stark/runtime/`** — established in Phase A, before host extraction
7. **Separate `hosts` from `workers` in config; use canonical host IDs (`claude-code`, `codex-cli`)**
8. **Do not use a generator-first giant-skill architecture**
9. **Ship Codex in a limited first wave** (5 workflows only)
10. **Keep Claude operational through compatibility shims while removing its accidental ownership of the architecture**
11. **Scope Phase A contracts to first-wave workflows only** — do not contractize all 26 workflows upfront
12. **Telemetry is best-effort** — never blocks workflow execution
13. **V1 local telemetry uses `events.jsonl` as canonical store** — no premature DB infrastructure. `stark-insights` remains an optional downstream sink, not part of the runtime source of truth

---

## Why this is the best approach

This design solves the actual problem instead of the visible symptom.

The visible symptom is "we need Codex skills."

The real problem is:

- shared behavior is mixed with host UX
- runtime ownership is wrong
- Claude assumptions leak into system architecture

If we only duplicate the skills, we keep the wrong architecture and double the maintenance cost.

If we use a generator-first single-source skill system, we preserve fake parity and make Codex second-class.

If we create a host-aware monorepo with a shared core and explicit host products, we get:

- one engine
- two native products
- one runtime
- one testable contract surface
- a clean path to future hosts

That is the strongest long-term architecture and the only one that makes "Codex, but better" true instead of cosmetic.
