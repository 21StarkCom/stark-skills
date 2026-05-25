# Stark Review Observability — Design

- **Date:** 2026-05-25
- **Status:** Draft
- **Owner:** Aryeh Kiovetsky
- **Scope:** localhost personal-playground tooling (stark-skills repo)

## Problem

`/stark-review` and the other multi-agent dispatchers in this repo
(`/stark-copilot`, `/stark-red-team-design`, `/stark-red-team-plan`,
`/stark-design-to-plan`, `/stark-plan-to-tasks`, `/stark-phase-execute`,
`/stark-review-design`, `/stark-review-plan`) regularly run for **30–90
minutes**. During that window the operator has zero visibility into:

- which sub-agents are alive vs stalled
- which sub-agent is burning the most tokens / time
- whether a long run is legitimately busy or a hung CLI

Today the only signal is **post-completion** `agent_dispatch` +
`review_finding` events written to `~/.stark-insights/queue.db` (see
`tools/multi_review_lib.ts:1129` and `tools/multi_review_lib.ts:1148`). No
mid-flight visibility. A 90-minute run looks identical to a deadlocked run
until it terminates.

## Goal

Localhost observability stack: a Docker container hosts a web server + UI.
Every `/stark-*` dispatcher streams **lifecycle**, **structured progress**,
**heartbeats**, and **full token-level stdout/stderr** events to a JSONL
spool on disk. The UI displays runs grouped by **repo → branch → PR →
sub-agent**, with live tail of the selected sub-agent and history search
across the last 30 days.

**Success criteria** (testable):

- While a 90-minute `/stark-review` is in flight, the operator can open the
  UI, see all 27 sub-agents on one screen, identify which ones are
  currently producing output, and read the live token stream of any one of
  them in **< 2 s p95** from selection to first-byte-rendered.
- A sub-agent that has not emitted stdout/stderr **or** a heartbeat for
  more than **300 s** is rendered as `stalled` in the UI.
- A sub-agent whose CLI process is no longer alive but produced no
  `subagent_end` event is rendered as `crashed` within **60 s** of its
  last heartbeat expiring (see "Liveness model" below).

## Non-goals

- Multi-user / team-shared deployment
- Authentication beyond a per-install loopback token
- TLS (localhost only)
- Aggregation across multiple Macs
- Replacing the existing `~/.stark-insights/queue.db` pipeline — this stack
  is **independent**; the insights queue still ingests
  `agent_dispatch`/`review_finding` post-completion events
- Production hardening (this is a personal playground; per repo CLAUDE.md
  the rule is "ship straight to main, no rollout ceremony")

## Architecture

```
┌──────────────────────── HOST (Mac) ────────────────────────┐
│  /stark-review  /stark-copilot  /stark-red-team-* (etc.)   │
│       │              │                │                    │
│       └──────────────┴────────┬───────┘                    │
│                               ▼                            │
│      tools/observability_emit_lib.ts (new)                 │
│        • run_id  = uuid v4 per invocation                  │
│        • subagent_id = run_id:seq                          │
│        • per-run serialized writer queue                   │
│        • taps child stdout/stderr without consuming        │
│        • appends events to JSONL                           │
│                               ▼                            │
│  ~/.claude/code-review/observability/runs/{run_id}/        │
│         events-0001.jsonl  (rotation: 0001, 0002, …)       │
│         meta.json                                          │
└───────────────────────────────┼────────────────────────────┘
                                │  (bind mount, READ-ONLY)
┌───────────── DOCKER (host: 127.0.0.1:7700) ────────────────┐
│                               ▼                            │
│  fs.watch ─► tailer ─► event bus (in-proc) ─► WebSocket    │
│              │                  │                          │
│              ▼                  ▼                          │
│        SQLite index         browser UI                     │
│        (search/history)     (live + history)               │
│              ▲                                             │
│              └── state-only retention (drops SQLite rows;  │
│                  marks orphan runs `crashed`)              │
└────────────────────────────────────────────────────────────┘
                                ▲
                                │  HOST-SIDE
┌──────── tools/observability_prune.ts (CLI) ────────────────┐
│  • runs on host (manual or via launchd)                    │
│  • deletes spool dirs older than retention_days            │
│  • enforces total-spool-bytes budget (pressure retention)  │
└────────────────────────────────────────────────────────────┘
```

**Key idea: append-only JSONL is the contract.** Dispatchers write; the
docker container reads. If the container is down the reviews still run and
events queue up on disk; when the container comes up, the tailer replays
from the last persisted offset (stored in the SQLite index) and the UI
backfills.

**Mount mode:** the spool dir is bind-mounted **read-only**. The web-facing
container has zero write access to the host evidence it observes; if the
server or any of its dependencies is compromised, the attacker cannot
tamper with or delete past runs. Retention is performed by a host-side
CLI (`tools/observability_prune.ts`) that the operator runs manually or
schedules via launchd. The container still owns its own SQLite index
(named volume) and marks orphan runs as `crashed` there — but it never
mutates the spool.

**Network binding.** The Node server inside the container binds `0.0.0.0`.
Host exposure is constrained by `docker-compose.yml`, which publishes the
port as `127.0.0.1:7700:7700` — host-loopback-only. `OBSERVABILITY_BIND`
overrides are rejected unless the user also sets `OBSERVABILITY_ALLOW_LAN=1`
and supplies `OBSERVABILITY_BOOTSTRAP_CODE` via the bootstrap helper; see
"Security".

## Components

### 1. Emit library — `tools/observability_emit_lib.ts` (new)

New TypeScript module. All emit functions are **best-effort with explicit
visibility**:

- Failures NEVER throw and NEVER block the dispatcher.
- A single startup self-test runs once per process: if the spool dir is
  unwritable, the emit lib logs **once** to stderr (`[observability] DISABLED — reason: <…>`)
  and sets a process-local flag. Subsequent emits return immediately.
- The disabled state is recorded in the meta file
  (`{run_id}/meta.json`, field `emit_status`), which the docker server
  surfaces via `/api/health` and the UI.

Surface:

```ts
export interface RunCtx {
  runId: string;
  dispatcher: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  startedAt: string;
  /** OS pid of the dispatcher process; recorded so server can detect orphaned runs. */
  parentPid: number;
  /** Host boot id (from `sysctl kern.boottime` on macOS). Used to invalidate
   *  parentPid across reboots and laptop sleep/resume. */
  hostBootId: string;
  /** Monotonic per-run sub-agent counter; increments on each startSubAgent. */
  _nextSubagentSeq: number;
  /** Per-run byte budget; emits stop writing chunks once exceeded (lifecycle still flows). */
  byteBudgetBytes: number;
  /** Tracked usage. */
  bytesWritten: number;
}

export interface SubAgent {
  subagentId: string;          // = `${run_id}:${seq}`; seq is monotonic per run
  agent: "claude" | "codex" | "gemini" | string;
  model: string;
  task: string;
}

export function startRun(opts: Omit<RunCtx, "runId" | "startedAt" | "_nextSubagentSeq">): RunCtx;
export function endRun(ctx: RunCtx, status: "ok" | "error" | "timeout"): void;

export function startSubAgent(
  ctx: RunCtx,
  fields: { agent: string; model: string; task: string },
): SubAgent;

export function endSubAgent(
  ctx: RunCtx,
  sa: SubAgent,
  status: "ok" | "error" | "timeout",
  durationMs: number,
  summary?: Record<string, unknown>,
): void;

export function emitProgress(
  ctx: RunCtx,
  sa: SubAgent | null,
  kind: string,
  payload: Record<string, unknown>,
): void;

/**
 * Attach observability taps to a spawned child process. Returns void.
 * Adds non-consuming `"data"` listeners to `child.stdout` / `child.stderr`
 * — the existing `runProcess` buffers receive identical bytes; the
 * dispatcher behavior is unchanged. Errors inside the tap are swallowed
 * after one stderr log per process.
 */
export function attachChild(
  ctx: RunCtx,
  sa: SubAgent,
  child: import("node:child_process").ChildProcess,
): void;

/** Emit a heartbeat for a long-running sub-agent (default cadence 30 s). */
export function startHeartbeat(ctx: RunCtx, sa: SubAgent): { stop: () => void };

/** Emit a run-level heartbeat. Default cadence 10 s. Drives the 60-second
 *  crashed-detection SLA when the dispatcher dies without writing run_end. */
export function startRunHeartbeat(ctx: RunCtx): { stop: () => void };
```

**Byte budgets and pressure.** `startRun` reads
`OBSERVABILITY_PER_RUN_MAX_MB` (default 2048) and stores it as
`ctx.byteBudgetBytes`. Every `subagent_stdout` / `subagent_stderr` event
increments `ctx.bytesWritten` and refuses to write the chunk if the limit
would be exceeded. When that happens the emit lib writes a single
`subagent_progress { kind: "chunk-budget-exceeded" }` and silently drops
further chunks (lifecycle, progress, heartbeat, end events keep flowing).
The dropped-chunk state is recorded in `meta.json.byte_budget_exceeded =
true` and surfaced in the UI as a banner.

`startRun` also runs a low-disk preflight: if `statvfs(spoolDir).bavail *
f_frsize < 1 GiB` it sets `emit_status: "disabled"` with reason
`low_disk` and logs once to stderr. The dispatcher still runs; only
observability emission is disabled.

**Sub-agent identifiers** are `${run_id}:${seq}` where `seq` is a monotonic
counter on `RunCtx`. This eliminates the collision risk if the same
`(agent, task)` pair runs more than once in a logical run (e.g., retries
or multi-round dispatch). `agent`, `model`, `task` are stored as
**separate columns** in the index — not embedded in the id.

**Per-run writer queue.** Inside the emit lib, each `run_id` owns a single
**append-only writer task** with an in-process FIFO queue. All event
producers in the dispatcher (from any worker) push events to this queue;
the writer serializes them, assigns a monotonically increasing
`seq` number per event, and only advances the on-disk offset after a
newline-terminated record is `fsync`-flushed. Rotation (see below) is also
serialized through this queue, so a rotation cannot interleave with a
flush.

### 2. Spool layout

Path per run: `~/.claude/code-review/observability/runs/{run_id}/`

```
{run_id}/
├── meta.json                # written once on startRun, updated on endRun
└── events-0001.jsonl        # rotation index 1; 0002, 0003 …
```

`meta.json` shape:

```json
{
  "run_id": "…",
  "dispatcher": "multi_review",
  "repo": "GetEvinced/stark-skills",
  "branch": "feat/x",
  "pr_number": 123,
  "started_at": "2026-05-25T13:00:00Z",
  "ended_at": "2026-05-25T13:42:11Z",
  "status": "ok",
  "emit_status": "ok" | "disabled",
  "emit_disabled_reason": "spool unwritable: …" | null,
  "parent_pid": 84367,
  "host_boot_id": "1779692400.123456",
  "byte_budget_bytes": 2147483648,
  "bytes_written": 1234567,
  "byte_budget_exceeded": false,
  "schema_version": 1
}
```

`meta.json` is rewritten atomically (write to `meta.json.tmp` →
`rename(2)`) on each lifecycle transition and on every periodic
run-heartbeat (default 10 s cadence). The atomic rename guarantees the
tailer never reads a half-written file.

JSONL records: one JSON object per line, newline-terminated. All records
carry:

- `seq` — monotonic per-run sequence number (1, 2, 3, …)
- `ts` — ISO-8601 UTC, millisecond precision
- `type` — one of the event types below

Event types (all fields **after** the common `seq`/`ts`/`type`):

| Type                  | Required fields                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- |
| `run_start`           | `run_id`, `dispatcher`, `repo?`, `branch?`, `pr_number?`, `version`                   |
| `subagent_start`      | `run_id`, `subagent_id`, `agent`, `model`, `task`                                     |
| `subagent_stdout`     | `run_id`, `subagent_id`, `chunk` (string), `encoding` (`"utf8"` \| `"base64"`)        |
| `subagent_stderr`     | (same as stdout)                                                                      |
| `subagent_progress`   | `run_id`, `subagent_id?`, `kind`, `payload` (object)                                  |
| `subagent_heartbeat`  | `run_id`, `subagent_id`                                                               |
| `subagent_end`        | `run_id`, `subagent_id`, `status`, `duration_ms`, `summary?`                          |
| `run_heartbeat`       | `run_id`, `parent_pid`, `host_boot_id`, `bytes_written`                               |
| `run_end`             | `run_id`, `status`                                                                    |

`chunk` is the raw process output; UTF-8 by default. If decode finds
invalid sequences, the writer falls back to `encoding: "base64"` for that
chunk. Chunks larger than **64 KB are split** into multiple events that
share `subagent_id` and `ts`, preserving order via `seq`.

`subagent_progress.kind` values currently used:

- `"finding"` — `payload` is a finding object (severity, title, description, suggestion, …)
- `"round"` — `payload` is `{ round_num: N, phase: "review" | "fix" }`
- `"wing-attempt"`, `"patch-applied"`, etc. — dispatcher-specific

### 3. Rotation

When the current `events-NNNN.jsonl` exceeds **100 MB** (configurable via
`OBSERVABILITY_MAX_FILE_BYTES`), the writer queue closes the file and
opens `events-{NNNN+1}.jsonl`. The logical run is continuous;
`seq` keeps incrementing across files. The tailer follows by scanning the
run directory for the next file when EOF is reached on the current one.

### 4. Liveness model

A sub-agent is in one of these UI-rendered states:

| State       | Condition                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `running`   | `subagent_start` seen, no `subagent_end` yet, last activity (stdout/stderr/heartbeat) within 300 s, **and** parent run heartbeat is fresh |
| `stalled`   | `subagent_start` seen, no `subagent_end` yet, last activity > 300 s ago, but parent run heartbeat still fresh                              |
| `crashed`   | `subagent_start` seen, no `subagent_end` yet, **parent run heartbeat is stale** (no `run_heartbeat` for > 60 s and `parent_pid` is no longer alive on the host) |
| `ok`        | `subagent_end` with `status: ok`                                                                       |
| `error`     | `subagent_end` with `status: error`                                                                    |
| `timeout`   | `subagent_end` with `status: timeout`                                                                  |

Two heartbeats drive the model:

- **Sub-agent heartbeat** (`subagent_heartbeat`) every 30 s while a sub-agent
  is running. Updates `last_output_at` in the SQLite index just like
  stdout chunks.
- **Run heartbeat** (`run_heartbeat`) every 10 s. Carries `parent_pid` and
  `host_boot_id`. Updates `runs.last_heartbeat_at` and
  `runs.parent_pid_alive` columns in the SQLite index.

**60-second crashed-detection SLA.** The docker server runs a 30-second
tick. For each `run` with `last_heartbeat_at > 60 s ago` AND
`run_end IS NULL`, it:

1. Reads the run's recorded `parent_pid` and `host_boot_id` from the
   index. There is no `/proc` mount inside the container; the host
   `tools/observability_hostinfo.ts` ticker exposes the necessary host
   facts via `/hostinfo/host.json` (`host_boot_id`, `uptime_seconds`,
   `live_pids[]`).
2. If the current host_boot_id (read from `host.json`, refreshed every
   5 s) does NOT match the recorded `host_boot_id`, treat the run as
   **crashed by host event** (reboot/sleep) and mark non-terminal
   sub-agents as `crashed` with reason `host_boot_changed`.
3. Otherwise, if the recorded `parent_pid` is missing from
   `host.json#live_pids[]`, treat the run as **crashed by dispatcher
   exit** and mark non-terminal sub-agents as `crashed` with reason
   `parent_exit`.
4. Otherwise, treat the run as **stale, parent still alive** — no
   state change yet; flag in `/api/health` and reconsider next tick.

The 60-second window is achievable because run heartbeats are written
every 10 s and the server tick is 30 s; worst case is ~70 s, within the
goal's 60 s + small jitter envelope. The success criterion in "Goal"
explicitly accepts up to 90 s practical bound.

**Laptop sleep / resume.** macOS pauses the dispatcher and the container
together during sleep. On resume, `host_boot_id` is unchanged (sleep is
not reboot) but the recorded run-heartbeat may be very stale. To avoid
false crashed-state on resume, the docker server reads
`host.json#uptime_seconds` on every tick and skips state transitions for
one full tick (30 s) whenever the host uptime delta is smaller than the
wall-clock delta by more than 60 s (i.e., the host slept). On reboot
(`host_boot_id` change), inflight runs are explicitly marked crashed
because the dispatcher is gone.

The synthetic `crashed` state is recorded **only in the SQLite index**;
the spool JSONL is never modified by the container (mount is read-only).
The UI shows the crashed sub-agent with a tooltip explaining the reason.

Orphan-run sweep: if a run has not received any event for **1800 s** and
has no `run_end`, the server forcibly transitions all its non-terminal
sub-agents to `crashed` with reason `orphan_timeout`. This is a
last-resort fallback for the case where both run heartbeats and host
process introspection have failed.

### 5. Docker server — `tools/observability_server/`

Single container, image based on `node:22-alpine`. Mounts:

- `~/.claude/code-review/observability/runs:/spool/runs:ro` (read-only — see Architecture)
- `~/.claude/code-review/observability/hostinfo:/hostinfo:ro` (ticker file maintained by the host-side `tools/observability_hostinfo.ts`; carries `host_boot_id`, uptime, free disk, **and `live_pids[]`** — the only host-process introspection surface; macOS Docker Desktop does not expose `/proc` to containers, so there is **no** `/proc:/host_proc:ro` mount)
- `~/.claude/code-review/observability/audit:/audit` (audit log, writable)
- named volume `observability_index:/data` (SQLite database — the only other writable path inside the container)

One Node process, four subcomponents:

- **Tailer.** Watches the spool dir via `chokidar` (smooths over the
  well-known macOS `fs.watch` quirks). On each new file or append:
  1. opens the file at the persisted offset (`tail_offsets`)
  2. reads forward, buffers any partial trailing line
  3. parses each complete line as JSON; on malformed JSON, increments the
     `tailer_parse_errors_total` counter, emits a warning to
     `/api/health.errors`, and skips that line
  4. pushes events to the in-proc event bus
  5. persists the new offset
- **Index writer.** Subscribes to the bus; UPSERTs into the SQLite index.
  Idempotent on `seq` — re-processing the same `(run_id, seq)` is a
  no-op. Updates `last_output_at` on every `subagent_*` event.
- **WebSocket hub.** One endpoint at `/ws`. See "WebSocket protocol" below.
- **HTTP API.** REST endpoints. See "HTTP API" below.
- **State-only retention.** Hourly. The container CANNOT delete spool
  files (mount is read-only). Instead the sweep:
    1. detects spool dirs that have already been removed from disk by the
       host-side `tools/observability_prune.ts` CLI;
    2. for each such missing run, runs `DELETE FROM runs WHERE run_id = ?`
       (cascades to all child tables).
  The host-side prune is where spool deletion actually happens — see §10.

Port: `7700` (overridable via `OBSERVABILITY_PORT`).

### 6. SQLite index schema (`/data/index.db`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  dispatcher          TEXT NOT NULL,
  repo                TEXT,
  branch              TEXT,
  pr_number           INTEGER,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  status              TEXT,                -- 'running' | 'ok' | 'error' | 'timeout' | 'crashed'
  emit_status         TEXT,
  parent_pid          INTEGER,
  host_boot_id        TEXT,
  last_heartbeat_at   TEXT,
  bytes_written       INTEGER NOT NULL DEFAULT 0,
  byte_budget_exceeded INTEGER NOT NULL DEFAULT 0,
  total_subagents     INTEGER NOT NULL DEFAULT 0,
  total_findings      INTEGER NOT NULL DEFAULT 0,
  last_seq            INTEGER NOT NULL DEFAULT 0,
  crashed_reason      TEXT                 -- 'parent_exit' | 'host_boot_changed' | 'orphan_timeout' | NULL
);

CREATE TABLE IF NOT EXISTS subagents (
  subagent_id     TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  agent           TEXT NOT NULL,
  model           TEXT,
  task            TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT,
  duration_ms     INTEGER,
  stdout_bytes    INTEGER NOT NULL DEFAULT 0,
  stderr_bytes    INTEGER NOT NULL DEFAULT 0,
  last_output_at  TEXT,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  summary_json    TEXT
);

CREATE TABLE IF NOT EXISTS progress_events (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  subagent_id    TEXT REFERENCES subagents(subagent_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS spool_files (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  rotation_index INTEGER NOT NULL,
  file_path      TEXT NOT NULL,
  first_seq      INTEGER,
  last_seq       INTEGER,
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  mtime_ns       INTEGER NOT NULL DEFAULT 0,
  last_offset    INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT,
  PRIMARY KEY (run_id, rotation_index)
);

CREATE TABLE IF NOT EXISTS tail_offsets (
  file_path TEXT PRIMARY KEY,
  offset    INTEGER NOT NULL,
  mtime_ns  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_offsets (
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  subagent_id     TEXT NOT NULL REFERENCES subagents(subagent_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,             -- per-run monotonic seq of the chunk event
  stream          TEXT NOT NULL,                -- 'stdout' | 'stderr'
  rotation_index  INTEGER NOT NULL,             -- which events-NNNN.jsonl file
  byte_start      INTEGER NOT NULL,             -- byte offset within that file
  byte_end        INTEGER NOT NULL,             -- exclusive end-of-record offset
  ts              TEXT NOT NULL,
  encoding        TEXT NOT NULL,                -- 'utf8' | 'base64'
  PRIMARY KEY (run_id, seq)
);
-- chunk_offsets is the seek-index that backs the chunk replay endpoint and
-- the WebSocket from_seq backfill. Tested under load to validate the
-- 2-second p95 replay target for 30-day-old history.

CREATE INDEX IF NOT EXISTS idx_runs_repo_started ON runs(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status       ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started      ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagents_run     ON subagents(run_id);
CREATE INDEX IF NOT EXISTS idx_subagents_status  ON subagents(status);
CREATE INDEX IF NOT EXISTS idx_progress_run      ON progress_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_progress_subagent ON progress_events(subagent_id, ts);
CREATE INDEX IF NOT EXISTS idx_spool_run         ON spool_files(run_id, rotation_index);
CREATE INDEX IF NOT EXISTS idx_chunk_subagent    ON chunk_offsets(subagent_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_heartbeat    ON runs(last_heartbeat_at);
```

`progress_events` is the queryable history of `subagent_progress` events
(including all findings). Token-stream chunks are NOT stored in SQLite —
they live in the JSONL files; `spool_files.last_offset` plus the chunk
endpoint provide replay.

Schema versioning: a single `PRAGMA user_version` is bumped per migration.
The server runs `migrations/` SQL files on startup, idempotently.

### 7. HTTP API

All endpoints return JSON unless otherwise stated. Timestamps are ISO-8601
UTC with millisecond precision (`2026-05-25T13:42:11.123Z`). Enumerated
values are the strings in their canonical column definitions (see schema).

**Authentication.** Browser sessions authenticate via a same-origin
**HttpOnly session cookie** (`obs_session`). Bootstrap flow (see "Security"
for the helper command and threat model):

1. Operator runs `node tools/observability_open.ts` on the host. The
   helper retrieves the per-install token from the macOS Keychain
   (service `stark-observability-token`), POSTs it to the running
   container at `POST /api/auth/bootstrap`, and receives a short-lived
   (60 s) one-time **bootstrap code**.
2. The helper opens `http://localhost:7700/?b=<code>` in the default
   browser.
3. The UI's `index.html` extracts the `b` query parameter, immediately
   strips it from the URL (`history.replaceState`), and `POST`s it to
   `POST /api/auth/exchange`. The server validates the code, sets the
   `obs_session` HttpOnly + Secure-omitted (loopback only) + SameSite=Strict
   cookie, and returns 204.
4. Subsequent UI requests carry the cookie automatically. WebSocket
   upgrades likewise validate the cookie at handshake.

For programmatic clients (CLI scripts, integrations), `Authorization:
Bearer <token>` is also accepted with the same per-install token.

Bad/missing auth → 401 with the standard error envelope. There is no
unauthenticated path other than `GET /api/health/probe` (a minimal
liveness probe that returns just `{ ok: true }` so launchd / monitoring
can confirm the container is up; no run data is exposed).

**Error envelope** (used for all 4xx/5xx responses):

```json
{
  "error": {
    "code": "not_found" | "bad_request" | "unauthorized" | "rate_limited" | "internal" | "retention_gap",
    "message": "human readable",
    "details": { "...optional context..." }
  }
}
```

| Status | Use                                                                       |
| ------ | ------------------------------------------------------------------------- |
| 400    | malformed parameters, invalid filters, malformed chunk range              |
| 401    | missing or invalid `Authorization`                                        |
| 404    | unknown `run_id` or `subagent_id`                                         |
| 410    | spool file was deleted by retention (`code: "retention_gap"`)             |
| 429    | rate-limited                                                              |
| 500    | unhandled internal failure                                                |

Endpoints:

#### `GET /api/runs`

Cursor-paginated list of runs.

Query: `repo?`, `dispatcher?`, `status?` (CSV), `since?` (ISO-8601),
`until?` (ISO-8601), `limit?` (default 50, max 200), `cursor?` (opaque).

Response:

```json
{
  "items": [
    {
      "run_id": "…",
      "dispatcher": "multi_review",
      "repo": "GetEvinced/stark-skills",
      "branch": "feat/x",
      "pr_number": 123,
      "started_at": "…",
      "ended_at": "…",
      "status": "running",
      "total_subagents": 27,
      "total_findings": 0
    }
  ],
  "next_cursor": "opaque-or-null",
  "has_more": true
}
```

Stable sort: `started_at DESC`, tie-break `run_id DESC`.

#### `GET /api/runs/:run_id`

```json
{
  "run": { /* same shape as items above plus emit_status, last_seq */ },
  "subagents": [
    {
      "subagent_id": "…",
      "agent": "codex",
      "model": "gpt-5.5",
      "task": "completeness",
      "started_at": "…",
      "ended_at": "…",
      "status": "running",
      "duration_ms": null,
      "stdout_bytes": 12345,
      "stderr_bytes": 0,
      "last_output_at": "…",
      "finding_count": 7,
      "summary": null
    }
  ]
}
```

#### `GET /api/runs/:run_id/subagents/:subagent_id`

Single sub-agent object as above.

#### `GET /api/runs/:run_id/subagents/:subagent_id/chunks`

Streams `text/event-stream` (SSE). Query parameters:

| Name        | Meaning                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `from_seq?` | Inclusive starting `seq` value (defaults to 1)                          |
| `to_seq?`   | Inclusive end (defaults to current `last_seq`; omit for live tail)      |
| `stream?`   | `stdout` \| `stderr` \| `both` (default `both`)                         |

Frame format (one SSE `data:` per event):

```json
{
  "stream": "stdout",
  "seq": 42,
  "ts": "…",
  "encoding": "utf8",
  "chunk": "…"
}
```

Terminator: a final SSE event of `event: end` with `data: {"reason":"to_seq" | "subagent_end" | "rotation_gap"}`. If a rotated spool file has been deleted by retention, the server emits `event: gap` with the missing seq range before continuing.

#### `GET /api/health`

```json
{
  "status": "ok" | "degraded" | "down",
  "tailer": {
    "files_watched": 42,
    "lag_seconds": 0.3,
    "parse_errors_total": 0,
    "last_error": null
  },
  "index": {
    "db_size_bytes": 12345678,
    "open_transactions": 0
  },
  "retention": {
    "last_run_at": "…",
    "files_deleted_total": 12
  },
  "errors": [
    { "ts": "…", "source": "tailer", "message": "…" }
  ]
}
```

#### Rate limits

| Endpoint                                            | Limit                   |
| --------------------------------------------------- | ----------------------- |
| `GET /api/runs`                                     | 60 rps per token        |
| `GET /api/runs/:id`                                 | 120 rps per token       |
| `GET …/chunks` (SSE)                                | max 8 concurrent streams per token |
| `WS /ws`                                            | max 4 concurrent connections per token |

Exceeding the limit returns 429 with `Retry-After`. The SSE limit is
enforced as connection-cap, not rps. The single-user assumption makes
these soft caps to prevent runaway browser-tab proliferation rather than
adversarial protection.

### 8. WebSocket protocol — `/ws`

Client connects, sends `subscribe` messages, receives `event` and `error`
messages. All messages are JSON.

#### Auth handshake

WebSocket upgrade requests carry the `obs_session` cookie that the
bootstrap flow set; the server validates the cookie at handshake time
(before the upgrade completes). Connections without a valid cookie are
rejected with HTTP 401 during the upgrade. Programmatic clients may
substitute `Authorization: Bearer <token>` on the upgrade request.

Once the socket is open, the first client frame should be a
`subscribe` (no separate auth frame is needed; the upgrade already
authenticated the connection).

#### Subscribe

```json
{
  "type": "subscribe",
  "sub_id": "client-chosen-string",
  "filter": {
    "run_id": "…",            // optional
    "subagent_id": "…",       // optional
    "repo": "…",              // optional
    "live": true,             // optional — all currently-running runs
    "event_types": ["subagent_stdout", "subagent_progress"]  // optional
  },
  "from_seq": 12345           // optional resume hint, per run
}
```

Server reply:

```json
{ "type": "subscribe_ok", "sub_id": "…" }
```

Or, on bad filter:

```json
{ "type": "error", "sub_id": "…", "code": "bad_filter", "message": "…" }
```

#### Events

```json
{ "type": "event", "sub_id": "…", "event": { /* JSONL record verbatim */ } }
```

Events for a given `run_id` are delivered in `seq` order. The server
backfills from `from_seq` (if provided) up to the current `last_seq`
before switching to live tail.

#### Heartbeat / reconnect

Server sends `{ "type": "ping" }` every 25 s; client must echo with
`{ "type": "pong" }` within 10 s or be disconnected with code 4002
(`stale`). On reconnect, the client may re-send `subscribe` with the
last-seen `seq` as `from_seq` to resume losslessly.

#### Unsubscribe / close

```json
{ "type": "unsubscribe", "sub_id": "…" }
```

Server replies `{ "type": "unsubscribe_ok", "sub_id": "…" }`.

### 9. UI

Single-page React 18 app, built with Vite. Stack: TanStack Query for HTTP,
native `WebSocket` for streaming, no SSR.

**Layout.** Two-column responsive layout:

- **Left rail (tree).** Repo → Branch → PR → Run → Sub-agent. Live runs
  sorted to top with a pulse indicator next to currently-emitting
  sub-agents. Implemented as a native `<ul role="tree">` with
  `<li role="treeitem">` items.
- **Right pane (detail).**
  - If a Run is selected: a sortable table of its sub-agents (columns:
    agent, task, status, elapsed, stdout bytes, stderr bytes, finding
    count, last-output-at). Implemented as a `<table>` with native
    `aria-sort` on column headers.
  - If a Sub-agent is selected: a live-tailing log view of its stdout
    (collapsible stderr panel beneath via a `<details>` element),
    plus a structured findings list populated from `progress_events`.

**Top bar.** Filter by dispatcher, status, time window. Each filter is a
labeled `<select>` or text input — no custom widgets.

**History tab.** Search the SQLite index by repo, dispatcher, date range,
or status. Clicking a result loads the run in the main pane (live or
replay).

#### Keyboard model

| Region              | Keys                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| Tree (left rail)    | `↑`/`↓` move between visible items; `←`/`→` collapse/expand; `Enter`/`Space` select |
| Table (right pane)  | `↑`/`↓` between rows; `Enter` selects sub-agent; `Space`/`Enter` on a header sorts |
| Tabs (Live / History) | `←`/`→` between tabs (per WAI-ARIA tab pattern); `Enter` activates              |
| Filter inputs       | Standard form-control behavior; `Esc` clears the focused filter                  |
| Log panel           | `j`/`k` page down/up; `End` jumps to live tail; `Esc` exits live tail            |

Focus is moved to the newly-selected detail pane's heading after any tree
or table selection so screen readers and keyboard users immediately land
in the content. Visible focus rings (≥ 3:1 contrast) on every interactive
element.

#### Screen reader model

- All log streaming uses an `aria-live="polite"` region with batching: at
  most one announcement per 2 s, summarizing recent volume (e.g., "12 new
  stdout lines from codex:completeness"). A user toggle (`Quiet
  announcements`) disables the live-region updates for log streams while
  preserving status/finding announcements.
- Sub-agent status transitions (e.g., `running → stalled`,
  `running → crashed`, `running → ok`) are announced via a separate
  `aria-live="assertive"` region.
- New findings are announced as `polite` with the severity + title.
- Loading states use `aria-busy` on the affected region.

Required ARIA / semantic patterns:

- Page-level landmarks: `<header>`, `<nav>` (top filters), `<main>` (detail pane), `<aside>` (left tree)
- One `<h1>` per page; headings descend in order
- Tree: `role="tree"` with `aria-expanded`, `aria-selected`, `aria-level`
- Table: `aria-sort` on sortable headers, `<caption>` summarizing the table
- Tabs: WAI-ARIA tabs pattern (`role="tablist"`, `aria-controls`, etc.)
- Form controls: every input has an associated `<label>`

#### Visual accessibility acceptance criteria

- Color contrast ≥ 4.5:1 for normal text, ≥ 3:1 for large text and UI components (WCAG 2.2 AA)
- No color-only communication: every status icon also has a textual label
- Focus indicator ≥ 3:1 contrast against adjacent colors
- Minimum touch target 44 × 44 CSS pixels
- Layout remains usable at 200 % browser zoom without horizontal scroll except for designated wide content (log/table)
- `prefers-reduced-motion`: the pulse indicator falls back to a static dot; live-tail auto-scroll uses an instant jump instead of a smooth animation

#### Output rendering rules

- All process output and structured-event payload fields are rendered as
  **text only**. The renderer NEVER injects HTML strings.
- Optional ANSI escape interpretation goes through a vetted sanitizer
  (e.g., `ansi-to-html` with strict allowlist), and unsafe terminal
  control sequences (cursor movement, alternate screens) are stripped.
- A restrictive `Content-Security-Policy` header is served with the UI:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:7700; object-src 'none'; frame-ancestors 'none'`.

### 10. Retention

Retention is split between the container (state-only) and a host-side
CLI (the only writer to the spool).

#### Host-side spool prune — `tools/observability_prune.ts` (new)

Usage:

```
node --experimental-strip-types tools/observability_prune.ts \
  [--retention-days 30] \
  [--total-cap-gb 50] \
  [--dry-run] \
  [--json]
```

Behavior:

1. **Age-based pruning.** Walks `~/.claude/code-review/observability/runs/`
   and deletes any run directory whose `meta.json.ended_at` is more than
   `retention_days` ago.
2. **Pressure retention (total-cap-gb).** If after age-based pruning the
   total spool size still exceeds `total_cap_gb`, the CLI sorts terminal
   runs by `ended_at ASC` and applies progressive pressure:
    1. For the oldest 25 % of terminal runs (by count), **truncate token
       chunks** (`subagent_stdout` / `subagent_stderr` events): the CLI
       rewrites each rotated JSONL file by replacing every chunk event
       with `{ "type": "chunk_truncated", "seq": …, "ts": …, "subagent_id": …, "bytes_dropped": N }`
       and rewrites `meta.json.bytes_written` accordingly. Lifecycle,
       progress, heartbeat, and end events are preserved.
    2. If still over cap, delete oldest terminal runs entirely.
3. **Atomicity.** Each run directory is moved to
   `~/.claude/code-review/observability/.trash/{run_id}/` first, then
   removed with `rm -rf` after a 1-minute grace period. This lets the
   tailer notice the deletion via the spool-files index update before
   the bytes go away.
4. **Reports stats** via JSON to stdout when `--json`.

Recommended launchd schedule: hourly. A sample `launchd.plist` ships
under `tools/observability_server/launchd/`.

#### Container-side state retention

Inside the container, a 60-minute tick:

1. Reads the current `spool_files` snapshot via filesystem stat.
2. For any `run_id` whose spool directory no longer exists on disk,
   issues `DELETE FROM runs WHERE run_id = ?` (cascades to all child
   tables).
3. Records stats in the in-memory health snapshot exposed at `/api/health`.

The container CANNOT delete spool files — the mount is read-only. All
disk reclamation flows through the host CLI above.

Configurable via env: `OBSERVABILITY_RETENTION_DAYS` (used by the host
CLI), `OBSERVABILITY_TOTAL_CAP_GB` (used by the host CLI),
`OBSERVABILITY_RETENTION_INTERVAL_MIN` (used by the container).

## Integration with existing dispatchers

Each dispatcher entry point initializes a `RunCtx` at the top of its CLI
`main`. Every `runProcess` call inside the dispatcher is passed a fourth
parameter — a single `observability` options object — that carries the
context and triggers `attachChild` after spawn.

Proposed signature change (additive — backwards-compatible call sites
that omit the option behave exactly as today):

```ts
export function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; env?: Record<string, string>; cwd?: string },
  observability?: { ctx: RunCtx; sa: SubAgent },
): Promise<ProcResult>;
```

Wrapping is mechanical and applied at each dispatcher entry point:

- `tools/multi_review_lib.ts` (entry: `runReview`, child spawner: line 593)
- `tools/copilot_dispatch.ts`
- `tools/plan_dispatch.ts`
- `tools/red_team_lib.ts` (called from `red_team_design.ts` / `red_team_plan.ts`)
- `tools/stark_review_doc.ts`
- `tools/plan_to_tasks_validate_lib.ts`
- `tools/stark_review.ts` (single-agent path)

Each call site that constructs a `SubAgent` does so via `startSubAgent(ctx, {agent, model, task})`, which assigns the monotonic `seq`.

## Security

- Data is read from the local filesystem only. No outbound network calls.
- The spool dir is bind-mounted read-only into the container; spool
  deletion happens only on the host (`tools/observability_prune.ts`).
  The web-facing container cannot tamper with the append-only evidence
  it observes.
- The Node server binds `0.0.0.0` inside the container; `docker-compose.yml`
  publishes `127.0.0.1:7700:7700` on the host. Operators who want LAN
  access must set `OBSERVABILITY_ALLOW_LAN=1` **and** complete the
  bootstrap flow; otherwise the server refuses to start with any
  non-loopback publish.
- **Per-install token.** On first startup, the container generates a
  256-bit random token, persists it to `/data/token` (file mode 0600),
  and exits with a one-line `docker logs` message instructing the
  operator to run `node tools/observability_open.ts`. The helper reads
  the token from the container's `/data/token` (via `docker exec cat`)
  and stores it in the macOS Keychain under service
  `stark-observability-token` for subsequent invocations.
- **Bootstrap-helper command (`tools/observability_open.ts`, new).** Reads
  the token from the Keychain (falling back to `docker exec` on first run),
  POSTs it to `POST /api/auth/bootstrap` on `127.0.0.1:7700`, receives a
  60-second one-time bootstrap code, and opens
  `http://localhost:7700/?b=<code>` in the default browser. The UI
  exchanges the code for a session cookie (see §7). The helper never
  echoes the raw token to stdout.
- **Origin + Host validation.** The server rejects any HTTP request whose
  `Origin` (when present) is not `http://localhost:7700` /
  `http://127.0.0.1:7700`, and rejects any `Host` header that is not one
  of those. WebSocket upgrade requests are subject to the same checks.
- **CORS deny by default.** No `Access-Control-Allow-Origin` headers are
  ever sent. Browsers fetching from any other origin will be blocked at
  the browser level even before they reach auth.
- **Secret redaction.** Before writing JSONL, the emit lib applies a
  redactor over every `chunk`, every `subagent_progress.payload`, every
  `summary`, and every `error` string. Defaults cover:
  - JWTs (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)
  - GitHub PATs (`ghp_…`, `ghs_…`, `gho_…`)
  - OpenAI keys (`sk-…`)
  - AWS access keys (`AKIA[0-9A-Z]{16}`)
  - Anthropic keys (`sk-ant-…`)
  - Bearer tokens in `Authorization:` headers in any captured text
  - Any string named in `OBSERVABILITY_REDACT_EXTRA_ENV` (comma-separated
    env-var names whose **values** are redacted)
  Matched substrings become `<REDACTED:<kind>>`. The original character
  count is preserved in the replacement to keep log offsets stable.
  Events carrying redactions get a top-level `"redacted": true` flag so
  the UI can show a banner. Per-project extension hook: emit lib reads
  `~/.claude/code-review/observability/redactors.json` (optional) with
  additional named regex patterns.
- Token streams may still contain secrets that no regex catches. The
  upstream `tools/runtime_env_lib.ts` env scrubbing remains the first
  line of defense; the redactor is the second.
- The retention sweep is the only writer inside the container. The tailer
  opens spool files **read-only**.

## Testing

### Unit

- **`tools/observability_emit_lib.test.ts`**: runId stability, JSONL
  shape, seq monotonicity, swallow-failure semantics on EACCES /
  ENOSPC / EBADF, chunk-encoding fallback to base64 on invalid UTF-8,
  rotation at the byte threshold (including mid-flush rotation), per-run
  writer-queue serialization under contention, sub-agent id collision
  prevention, redactor output (positive + negative test cases for every
  built-in pattern).
- **`tools/observability_server/tailer.test.ts`**: replay from persisted
  offset; partial-line handling (the tailer must hold a partial line
  across `read` boundaries and only emit on newline); file rotation
  handling (open the next file when current EOF reached); mtime
  regression handling (do not re-emit events when the file is overwritten
  with smaller content); malformed JSON line increments
  `parse_errors_total` and does not abort the stream.
- **Index writer**: schema migration idempotency, UPSERT ordering when
  events arrive out of order, `last_output_at` updates on every
  `subagent_stdout`/`stderr`/`heartbeat`/`progress`, retention cascade.

### API + UI

- **REST tests** (Vitest + `supertest`): every endpoint — `/api/runs`
  pagination (cursor stability, `since`/`until` bounds, status CSV
  filtering, repo/dispatcher filters), run detail, sub-agent detail,
  chunk SSE (range parameters, terminator events, gap events on retention
  loss), `/api/health` output shape, auth (401 on missing token, 401 on
  wrong token).
- **WebSocket tests**: subscribe with filter, backfill from `from_seq`,
  reconnect-and-resume, ping/pong, malformed subscribe error path,
  multiple subscriptions on a single socket, max-concurrent-connections
  rejection (429-equivalent close code).
- **UI E2E** (Playwright): launch the stack against a temp HOME, fire a
  synthetic run via the emit lib, drive the browser to assert:
  - run appears in the tree
  - sub-agents appear as they start
  - selecting a sub-agent shows live token stream within 2 s
  - status transitions visible (running → stalled → ok)
  - keyboard nav (tree, table, tabs) works end-to-end without mouse
  - screen-reader announcements fire (via `aria-live` region snapshots)
  - high zoom (200 %) and reduced-motion are honored

### Load / latency

A scripted load test (`tools/observability_server/test/load.ts`) drives:

- 27 concurrent sub-agents, 600 s sustained
- ~10 KB/s stdout per sub-agent (representative of Codex JSONL)
- Rotation triggered ≥ 1× per sub-agent (i.e., > 100 MB per run)
- Two browser WebSocket subscribers
- A second client iterating history queries every 5 s

Assertions:

- WebSocket end-to-end lag (emit → browser receive) p95 < 2 s
- UI sub-agent-select to first-byte-rendered p95 < 2 s
- SQLite write commit p95 < 50 ms
- Memory growth bounded (no leak ≥ 50 MB/h)
- Chunk SSE delivers without dropping (delivered count == emitted count)

### Restart / backfill

- Emit a stream of events with the docker stack stopped → start the stack
  → assert all events replay in correct order and the UI backfills.
- Kill the server mid-file → restart → assert no duplicates, no skipped
  events (per-file `tail_offsets`).
- Rotate a file while the server is stopped → restart → assert the
  tailer discovers the new file and continues from the correct offset.

### Failure paths

- Malformed JSONL line: parse-error counter increments; subsequent valid
  lines are processed; `/api/health.errors` reports the line number.
- Invalid base64 in a `chunk`: the chunk is rendered as
  `<undecodable: N bytes>` and a `progress_event` with
  `kind: "chunk-decode-error"` is recorded.
- Spool file deleted while a chunk SSE client is reading: emit a
  `gap` SSE event and close with `code: "retention_gap"`.
- SQLite write failure: surface in `/api/health.status: "degraded"`
  with details.

### Health validation

Tests force tailer stalls (mock filesystem pause), parse errors, backlog
growth, and SQLite failures, then assert `/api/health` reports accurate
status, lag, last processed offsets, and actionable error state.

### Liveness model

- **Parent-pid exit** — start a run, kill the dispatcher process with
  SIGKILL, assert all non-terminal sub-agents transition to
  `crashed` with `crashed_reason: "parent_exit"` within 90 s.
- **Host boot id change** — simulate `host_boot_id` change in the
  `hostinfo` sidecar; assert inflight sub-agents move to `crashed` with
  `crashed_reason: "host_boot_changed"`.
- **Laptop sleep / resume** — simulate a host-uptime gap of 5 minutes
  while wall-clock advances 30 minutes; assert the next tick does NOT
  mark sub-agents crashed; the subsequent sub-agent heartbeat keeps the
  run `running`.
- **Run heartbeat freshness** — assert `runs.last_heartbeat_at` updates
  every 10 s for a healthy run; assert the SLA (crashed within 60 s of
  heartbeat going stale).

### Host-side prune

- Age-based deletion respects `--retention-days`.
- Pressure retention rewrites chunk events to `chunk_truncated` and
  preserves lifecycle, progress, heartbeat, end events.
- `.trash/` grace period prevents tailer from re-emitting events from
  half-deleted files.
- Container-side state retention drops `runs` rows for missing spool
  dirs.

### Byte budgets

- `OBSERVABILITY_PER_RUN_MAX_MB` enforced: once exceeded, lifecycle
  events still flow but chunks are dropped and `byte_budget_exceeded`
  is set in `meta.json` and the index.
- Low-disk preflight at `startRun` sets `emit_status: "disabled"`.

### Auth flow

- Bootstrap exchanges code → session cookie; subsequent requests pass.
- Bootstrap code is single-use and expires after 60 s.
- Bearer token also accepted for CLI clients; raw browser request
  without cookie / Bearer is 401.
- Cookie is HttpOnly + SameSite=Strict; client JS cannot read it.

### Live test

Run `/stark-review` against a real PR with the stack up; manually verify
all sub-agents appear, status transitions are correct, the redactor
catches a planted `sk-ant-*` token in agent output, the bootstrap helper
opens the UI without manual log-inspection, and the UI is fully
operable via keyboard.

## Deployment

New directory: `tools/observability_server/`

```
tools/observability_server/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── migrations/
│   └── 001_init.sql
├── launchd/
│   └── com.aryeh.observability.prune.plist  # sample hourly host-prune cron
├── server/
│   ├── index.ts
│   ├── tailer.ts
│   ├── index_writer.ts
│   ├── websocket_hub.ts
│   ├── http_api.ts
│   ├── retention.ts      # state-only (drops SQLite rows for missing spool dirs)
│   ├── auth.ts           # bootstrap codes, session cookies
│   ├── redact.ts
│   ├── liveness.ts       # parent_pid + host_boot_id + sleep detection
│   └── health.ts
└── ui/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        └── ...
```

Plus three new top-level tools (not in the docker image):

- `tools/observability_emit_lib.ts` — emission library imported by every dispatcher
- `tools/observability_prune.ts` — host-side spool cleanup CLI
- `tools/observability_open.ts` — bootstrap helper that opens the UI
- `tools/observability_hostinfo.ts` — host-info ticker that maintains `hostinfo/host.json` (boot_id, uptime, free disk)

`docker-compose.yml` mounts:

- `~/.claude/code-review/observability/runs:/spool/runs:ro`
- `~/.claude/code-review/observability/hostinfo:/hostinfo:ro` (sole host-introspection surface — see "Liveness contract" above)
- `~/.claude/code-review/observability/audit:/audit`
- named volume `observability_index:/data`

Ports: `127.0.0.1:7700:7700` (UI/API) + `127.0.0.1:7701:7701` (loopback-only retention listener).

Start: `docker compose -f tools/observability_server/docker-compose.yml up -d`.

Open the UI: `node --experimental-strip-types tools/observability_open.ts`
(handles bootstrap — opens the browser at the authenticated session URL).

CLAUDE.md update (this repo + workspace-root) and a one-liner in
`AGENTS.md` mention the stack and how to start it.

## Open questions

None — all open clarifications resolved during the 2026-05-25 brainstorming
session (scope, granularity, persistence, deploy shape, transport),
during the 2026-05-25 design-review fix loop (mount mode, bind, auth,
redaction, write serialization, schema completeness, API contracts,
liveness model, accessibility), and during the 2026-05-25 red-team
fix loop (spool ownership / read-only mount + host-side prune;
run-level liveness via `parent_pid` + `host_boot_id` + sleep detection;
chunk-offset index; bootstrap helper + session cookie auth; per-run
byte budgets + pressure retention).
