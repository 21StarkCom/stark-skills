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
                                │  (bind mount, READ-WRITE)
┌───────────── DOCKER (host: 127.0.0.1:7700) ────────────────┐
│                               ▼                            │
│  fs.watch ─► tailer ─► event bus (in-proc) ─► WebSocket    │
│              │                  │                          │
│              ▼                  ▼                          │
│        SQLite index         browser UI                     │
│        (search/history)     (live + history)               │
│              ▲                                             │
│              └── retention sweep (deletes spool + rows)    │
└────────────────────────────────────────────────────────────┘
```

**Key idea: append-only JSONL is the contract.** Dispatchers write; the
docker container reads. If the container is down the reviews still run and
events queue up on disk; when the container comes up, the tailer replays
from the last persisted offset (stored in the SQLite index) and the UI
backfills.

**Mount mode:** the spool dir is bind-mounted **read-write** because the
retention sweep (which deletes 30-day-old files) runs **inside** the
container. The container is the sole owner of the spool lifecycle once the
emit lib has finished writing a logical run.

**Network binding:** the Node server inside the container binds `0.0.0.0`.
Host exposure is constrained by `docker-compose.yml`, which publishes the
port as `127.0.0.1:7700:7700` — host-loopback-only. `OBSERVABILITY_BIND`
overrides are rejected unless the user also sets `OBSERVABILITY_ALLOW_LAN=1`
and supplies `OBSERVABILITY_TOKEN`; see "Security".

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
  /** Monotonic per-run sub-agent counter; increments on each startSubAgent. */
  _nextSubagentSeq: number;
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
```

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
  "schema_version": 1
}
```

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
| `running`   | `subagent_start` seen, no `subagent_end` yet, last activity (stdout/stderr/heartbeat) within 300 s     |
| `stalled`   | `subagent_start` seen, no `subagent_end` yet, last activity > 300 s ago                                |
| `crashed`   | `subagent_start` seen, no `subagent_end` yet, last activity > 600 s ago AND parent `run_end` was seen  |
| `ok`        | `subagent_end` with `status: ok`                                                                       |
| `error`     | `subagent_end` with `status: error`                                                                    |
| `timeout`   | `subagent_end` with `status: timeout`                                                                  |

The emit lib starts a heartbeat for every sub-agent
(`startHeartbeat(ctx, sa)`) by default; cadence is **30 s**. Heartbeats
update `last_output_at` in the SQLite index just like stdout chunks.

The docker server runs a 30-second tick that re-evaluates state for every
row in `subagents` whose `status IS NULL` (i.e., `running`). Stale-run
inference also detects orphans: if a run has not received any event for
1800 s **and** has no `run_end`, the server marks all its non-terminal
sub-agents as `crashed` and writes a synthetic `run_end` with
`status: "crashed"`.

### 5. Docker server — `tools/observability_server/`

Single container, image based on `node:22-alpine`. Mounts:

- `~/.claude/code-review/observability/runs:/spool` **(read-write)**
- named volume `observability_index:/data` (SQLite database)

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
- **Retention sweep.** Hourly. Deletes spool directories whose
  `runs.ended_at` is more than `OBSERVABILITY_RETENTION_DAYS` (default 30)
  in the past, then `DELETE FROM runs WHERE run_id = ?` (cascades).

Port: `7700` (overridable via `OBSERVABILITY_PORT`).

### 6. SQLite index schema (`/data/index.db`)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  run_id           TEXT PRIMARY KEY,
  dispatcher       TEXT NOT NULL,
  repo             TEXT,
  branch           TEXT,
  pr_number        INTEGER,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  status           TEXT,                   -- 'running' | 'ok' | 'error' | 'timeout' | 'crashed'
  emit_status      TEXT,
  total_subagents  INTEGER NOT NULL DEFAULT 0,
  total_findings   INTEGER NOT NULL DEFAULT 0,
  last_seq         INTEGER NOT NULL DEFAULT 0
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

CREATE INDEX IF NOT EXISTS idx_runs_repo_started ON runs(repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status       ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started      ON runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagents_run     ON subagents(run_id);
CREATE INDEX IF NOT EXISTS idx_subagents_status  ON subagents(status);
CREATE INDEX IF NOT EXISTS idx_progress_run      ON progress_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_progress_subagent ON progress_events(subagent_id, ts);
CREATE INDEX IF NOT EXISTS idx_spool_run         ON spool_files(run_id, rotation_index);
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

**Authentication.** Every request must include `Authorization: Bearer
<token>` where `<token>` is the per-install token (see "Security"). The UI
embeds the token at build time from the environment. Bad/missing token →
401 with the standard error envelope.

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

The very first frame from the client MUST be:

```json
{ "type": "auth", "token": "…" }
```

Server replies:

```json
{ "type": "auth_ok" }
```

…or closes the connection with code 4001 (`unauthorized`).

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

Background job inside the container, runs hourly:

1. Find runs with `ended_at < now - OBSERVABILITY_RETENTION_DAYS` (default 30).
2. Delete `~/.claude/code-review/observability/runs/{run_id}/` from disk (the mount is RW).
3. `DELETE FROM runs WHERE run_id = ?` — cascades to `subagents`, `progress_events`, `spool_files`.
4. Record stats in the in-memory health snapshot.

Configurable via env: `OBSERVABILITY_RETENTION_DAYS`,
`OBSERVABILITY_RETENTION_INTERVAL_MIN` (default 60).

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
- The Node server binds `0.0.0.0` inside the container; `docker-compose.yml`
  publishes `127.0.0.1:7700:7700` on the host. Operators who want LAN
  access must set `OBSERVABILITY_ALLOW_LAN=1` **and** supply
  `OBSERVABILITY_TOKEN`; otherwise the server refuses to start with any
  non-loopback publish.
- **Per-install token.** On first startup, the container generates a
  256-bit random token, persists it to `/data/token`, and exposes it via
  `docker logs`. All HTTP requests require `Authorization: Bearer
  <token>`; all WebSocket connections require an `auth` handshake.
  The UI build pulls the token from a runtime config endpoint
  (`/api/runtime-config`, served only over loopback without auth so the
  empty browser tab can bootstrap; this endpoint returns just the
  token-version, not the token itself).
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

### Live test

Run `/stark-review` against a real PR with the stack up; manually verify
all sub-agents appear, status transitions are correct, the redactor
catches a planted `sk-ant-*` token in agent output, and the UI is fully
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
├── server/
│   ├── index.ts
│   ├── tailer.ts
│   ├── index_writer.ts
│   ├── websocket_hub.ts
│   ├── http_api.ts
│   ├── retention.ts
│   ├── auth.ts
│   ├── redact.ts
│   └── health.ts
└── ui/
    ├── index.html
    ├── package.json
    ├── vite.config.ts
    └── src/
        └── ...
```

`docker-compose.yml` mounts:

- `~/.claude/code-review/observability/runs:/spool` (read-write)
- named volume `observability_index:/data`

Ports: `127.0.0.1:7700:7700`.

Start: `docker compose -f tools/observability_server/docker-compose.yml up -d`.

UI: `http://localhost:7700`.

CLAUDE.md update (this repo + workspace-root) and a one-liner in
`AGENTS.md` mention the stack and how to start it.

## Open questions

None — all open clarifications resolved during the 2026-05-25 brainstorming
session (scope, granularity, persistence, deploy shape, transport) and
during the 2026-05-25 design-review fix loop (mount mode, bind, auth,
redaction, write serialization, schema completeness, API contracts,
liveness model, accessibility).
