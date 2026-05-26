# CLAUDE.md — stark-observability server

## Liveness contract (binding)

The container reads only `/hostinfo/host.json`. There is **no** `/proc`
mount; macOS Docker Desktop doesn't expose host `/proc` to containers.
Every host fact the server needs comes from the launchd-managed ticker
`tools/observability_hostinfo.ts`, atomically written to `host.json`
every 5 s.

When generating server-side code that needs:

- boot id → read `host.json#host_boot_id`
- uptime → read `host.json#uptime_seconds` (formula:
  `Date.now()/1000 - boot_time_seconds`, clamped at 0)
- free disk → read `host.json#free_disk_bytes`
- liveness of a host PID → check `host.json#live_pids[]`

Do not introduce any code path that depends on `/proc`.

## live_pids generation

The ticker runs `ps -axo pid= -u $(id -u)` (argv-passed via
`spawnSync`, never shell-interpolated). The set is bounded to the
current user's processes — typically 50–300 on a laptop, capped at the
few-thousand range even on a busy host.

## File modes

Every file the server creates: 0600. Every directory: 0700. Use
`tools/observability_paths_lib.ts`'s `ensurePrivateDir()` and
`openPrivate()` helpers; never call `fs.mkdir` / `fs.open` directly.

## Bind contract

The server refuses to boot unless `OBSERVABILITY_PUBLISHED_HOST` is
set. Non-loopback values require all of:

- `OBSERVABILITY_ALLOW_LAN=1`
- `OBSERVABILITY_TLS_TERMINATED=1`
- `/data/last_bootstrap_at` (written by the bootstrap helper)

See `server/bind.ts` for the full decision tree.

## UI (Phase 5)

`ui/` is a Vite + React + TypeScript SPA. Production bundle goes to
`ui/dist`; the Dockerfile's `ui-builder` stage copies it into the
runtime image at `/app/ui/dist`. `OBSERVABILITY_UI_DIR` overrides the
path (defaults to `/app/ui/dist`).

Rules for new UI code:

- All log chunk + finding text renders through React text nodes — no
  unsafe HTML-string props anywhere under `ui/src/`. The ANSI sanitizer
  in `ui/src/ansi.ts` emits a typed token stream; tokens map to
  `<span className=...>`.
- The static auth-exempt list (`server/middleware.ts`) covers `/`,
  `/index.html`, `/favicon.ico`, and the `/assets/` prefix. Anything
  Vite emits outside `assets/` MUST be added to that list.
- The bootstrap fragment is captured by `ui/src/bootstrap.ts` BEFORE
  any other module's top-level code (it's the first import of
  `main.tsx`). Do not move the import; do not introduce side effects
  earlier.
- `chunk_truncated` MUST render as a focusable `<div role="separator">`
  with the bytes-dropped count in `aria-label`. The component lives at
  `ui/src/components/GapMarker.tsx`.

## Migrations

`migrations/NNN_*.sql` run on every boot, idempotent via `PRAGMA
user_version`. To add a column: bump to a new file (do NOT mutate
`001_init.sql` after release).

## Daemon protocol (binding)

The per-run writer daemon is the **single owner** of: writer queue,
seq allocation, file rotation, byte budgets, redaction, run-heartbeat
timer, tracked-parent-pid poll. Dispatchers connect via the per-run
UDS at `tmpdir/stark-obs/<hash>.sock` (mode 0600, FNV-1a 32-bit of
the run id; short prefix dodges macOS's 104-byte `sun_path` cap).
First frame is `{op: "hello", cap}` where `cap` is a single-use
ephemeral cap minted from `writer.cap` (0600, per-run dir) via the
unauthenticated `caps_issue` op. Same-UID without a valid cap is
rejected.

The daemon's `{stop}` returned by heartbeat helpers is **strictly a
timer cancel** — it does NOT call `endSubAgent` / `endRun`.
Dispatchers always call the lifecycle function first, then `.stop()`.

## Uptime formula

`host.json#uptime_seconds = Date.now() / 1000 - boot_time_seconds`,
clamped at 0. Never read from a `/proc/uptime` equivalent — there
is none.

## `chunk_truncated.seq == orig.seq`

The prune CLI's in-place rewrite preserves the JSONL `seq` field
across the `subagent_stdout`/`subagent_stderr` → `chunk_truncated`
transition. The index writer's state machine deletes the
`chunk_offsets` row at that seq, inserts a `chunk_truncations` row,
and emits a one-shot truncation broadcast on the event bus.

## Retention-notify schema (two strictly-ordered calls)

`POST /api/internal/retention/notify` on the retention listener
(port 7701, Bearer-token authed against `/data/prune_token`):

- `action: "pre-rename"` — `new_size_bytes`, `truncated[]`. NEVER
  `new_mtime_ns`. Sets `spool_files.rewrite_state = 'pending'`,
  `target_size_bytes`, `target_mtime_ns`.
- `action: "update-mtime"` — `new_mtime_ns`. NEVER `truncated[]` or
  `new_size_bytes`. Advances `rewrite_state → 'committed'`.
- `action: "abort-rewrite"` — clears `rewrite_state` back to `'idle'`.
- `action: "scan-now"` — forces a tailer scan of the named run.
- `action: "recover-pending"` — runs `recoverPendingRewrites(db)` on
  demand so the prune CLI can recover after a server restart without
  waiting for the next boot.

`rewrite_state` is SQLite-authoritative (RT2) — there is no
host-side `.pending-rewrites/` journal.

## `runs.parent_pid` contract

`runs.parent_pid` is always the **tracked-parent pid**: the
dispatcher Node pid for normal dispatchers, or the SKILL.md shell pid
for `/stark-phase-execute`. The writer daemon's own pid is in
`runs.writer_daemon_pid` and is diagnostic only. The liveness sweeper
joins `parent_pid` against `host.live_pids[]`.

## No-print-token rule

The bootstrap helper (`tools/observability_open.ts`) never echoes the
raw token. Scripts read from the cookie file (`-b $COOKIE_FILE`) or
the appropriate scoped Keychain service (`stark-observability-bootstrap-token`
or `stark-observability-prune-token`) via
`security find-generic-password -s <service> -w`, and pass Bearer
headers via `curl -K <0600-file>` so the secret never lands in
`argv`. `server/grep_assertions.test.ts` enforces `--print-token` is
absent from the codebase.

## TS-bound `ended_at` rule

Every `ended_at` and `last_heartbeat_at` value the server writes
comes from `new Date().toISOString()` on the writer side. SQLite
`strftime(...)` / `datetime('now', ...)` are forbidden — `grep_assertions.test.ts`
enforces the rule in CI.

## Phase 8 test harness

- `test/load.ts --spec` runs the plan-profile load test in-process
  (Node 22+ required for `better-sqlite3`). `--main-port 0` /
  `--retention-port 0` lets it grab free ports; the harness writes
  `test/load-report.json` with per-percentile assertions. The
  index-writer's `getCommitLatencies()` accessor + the new
  `/api/health.index_writer.commit_ms_p50/p95/commit_samples` fields
  back the SQLite commit assertion.
- `test/failure_paths.test.ts` exercises every failure path the plan
  calls out (`node:test` runner).
- `test/live/` is operator-driven (real PR, real container).
- The `live-run.json` metadata file the destructive tests read is
  written by the real dispatcher when launched with
  `STARK_OBS_WRITE_LIVE_RUN_METADATA=1` — the env var is consumed in
  `tools/observability_dispatcher_helpers.ts::initRunCtx`, which
  writes `~/.claude/code-review/observability/test/live-run.json`
  atomically right after `startRun()` returns. `test/live/live_run_metadata.ts`
  is the standalone helper used only when wrapping a dispatcher that
  cannot be relaunched with the env var.
- `tools/observability_hostinfo.ts` writes the canonical freshness
  field as `wall_clock` (ISO ms). `LivenessSweeper.loadHostInfo()`
  accepts `wall_clock`, `ts`, and `ts_ms` for the freshness check
  (legacy test fixtures use `ts`/`ts_ms`; production ticker emits
  `wall_clock` only).
