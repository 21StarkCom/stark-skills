# stark-observability server

Docker-hosted Node server that ingests JSONL spool files from the
stark-review observability stack, indexes them in SQLite, and serves a
browser UI + WebSocket stream. Designed for a single-user developer
laptop.

## Liveness contract

**The container reads only `/hostinfo/host.json`. There is no `/proc`
mount.**

Docker Desktop on macOS does not expose host `/proc` to containers, so
every host fact the server needs (boot id, uptime, free disk, the live
pid set for parent-pid liveness) is written to `host.json` on the host
by the launchd-managed ticker `tools/observability_hostinfo.ts` and
bind-mounted read-only at `/hostinfo` inside the container.

`host.json` shape:

```json
{
  "host_boot_id": "1779692400.123456",
  "boot_time_seconds": 1779692400.123456,
  "uptime_seconds": 12345.6,
  "free_disk_bytes": 12345678901,
  "wall_clock": "2026-05-25T13:00:00.000Z",
  "live_pids": [84367, 84412, 84415]
}
```

Field derivations are exact on macOS:

| Field | Source |
| --- | --- |
| `boot_time_seconds` | `sysctl -n kern.boottime` → `sec + usec/1e6` |
| `host_boot_id` | `"<sec>.<usec>"` — stable per boot session |
| `uptime_seconds` | `Date.now()/1000 - boot_time_seconds` |
| `wall_clock` | `new Date().toISOString()` |
| `free_disk_bytes` | `fs.statfs(spoolDir).bavail * bsize` |
| `live_pids` | `ps -axo pid= -u $(id -u)` — current user only |

The ticker writes atomically (`host.json.tmp` → `rename(2)`) every 5 s.
The reader uses `O_RDONLY`; `rename(2)` guarantees no torn reads.

## Mounts

| Source | Container path | Mode | Purpose |
| --- | --- | --- | --- |
| host bind: `~/.claude/code-review/observability/runs` | `/spool/runs` | ro | JSONL spool tree |
| host bind: `~/.claude/code-review/observability/hostinfo` | `/hostinfo` | ro | host ticker output (`host.json`) |
| host bind: `~/.claude/code-review/observability/audit` | `/audit` | rw | audit log (rotated by the server) |
| named volume: `observability_index` | `/data` | rw | SQLite index + bootstrap markers + tokens |

The three host bind mounts surface what the host produces. The two
read-only ones (`/spool/runs`, `/hostinfo`) carry the host writer
daemon's spool and the launchd ticker's `host.json`. The writable one
(`/audit`) is the host-visible audit log — `ensureRoot()` in
`tools/observability_paths_lib.ts` creates it at `0700` so a fresh
install is operator-readable without `docker volume inspect` gymnastics
(plan §1.5.1 E9).

The `/data` mount stays a Docker named volume because the SQLite index,
the bootstrap marker, and the scoped tokens are server-owned state. The
image-side `mkdir + chown` lines seed the volume with
`starkobs:starkobs` (UID/GID 10001) ownership at mode `0700` on first
attach. The explicit `name: observability_index` pin in
`docker-compose.yml` defeats Compose's project-directory prefixing so
the Phase 8 marker-wipe commands target this exact volume.

### UID handling

The runtime UID/GID is REQUIRED at compose-up time via the `.env`
file in this directory:

```bash
cd tools/observability_server
printf 'OBSERVABILITY_UID=%s\nOBSERVABILITY_GID=%s\n' \
  "$(id -u)" "$(id -g)" > .env
```

The compose `user:` directive resolves to `${OBSERVABILITY_UID}:${OBSERVABILITY_GID}`
with `:?` validation — `docker compose up` fails loudly if either is
unset. There is no silent fallback that produces unreadable bind
mounts.

Why this is required: macOS Docker Desktop's VirtioFS / gRPC-FUSE
layer does NOT translate UIDs on bind mounts (and Linux never does).
The host bind dirs (`/spool/runs`, `/hostinfo`, `/audit`) are created
at mode `0700` owned by the operator who ran `ensureRoot()`. For
those mounts to be readable/writable inside the container, the
container UID must match the host owner's UID.

The compose stack uses a small `init` sidecar (alpine, root-only,
runs once before `observability` starts) that chowns the named
SQLite-index volume `/data` and the `/audit` host-bind to the
runtime UID/GID. That makes the named volume writable whether the
operator chose their own UID or the UID 10001 path.

Two deployment paths, both fully supported:

1. **Default — runtime UID = host operator UID** (recommended for
   single-user dev laptops). The `.env` one-liner above sets it.
2. **RT1 acceptance path — runtime UID = `starkobs` (10001)**. Phase 2
   ships a launchd writer plist that creates a dedicated host
   `starkobs` system user with UID 10001 and chowns the host bind
   dirs to it. Once that is in place, set
   `OBSERVABILITY_UID=10001` + `OBSERVABILITY_GID=10001` in `.env`
   and the same `init` sidecar handles the named-volume chown.

## Ports

| Port | Bind | Purpose |
| --- | --- | --- |
| 7700 | host loopback (default) | UI, HTTP API, WebSocket |
| 7701 | host loopback only | retention listener (prune CLI ↔ server) |

LAN exposure is conditional on the executable bootstrap sequence — see
the plan §"Executable LAN bootstrap sequence" and the
`docker-compose.lan.yml.example` override file.

## Hardening

- Runs as a non-root UID resolved at compose-up time from
  `${OBSERVABILITY_UID}:${OBSERVABILITY_GID}` in `.env` (no silent
  default — see `.env.example`). The image bakes a `starkobs` user
  (UID/GID 10001) as the image-default for `docker run` and as the
  Phase 2 RT1 acceptance target; compose `user:` overrides it.
- `cap_drop: ALL`, `security_opt: ["no-new-privileges:true"]`.
- `read_only: true` rootfs; `/tmp` is a 64 MB tmpfs at `0700`, owned by
  UID/GID 10001 to match the container `user:`.
- Writable mounts: `/data` (Docker named volume seeded at
  `starkobs:starkobs` mode `0700` by the image's `mkdir + chown`
  lines) and `/audit` (host bind to
  `~/.claude/code-review/observability/audit`, created at mode `0700`
  by `ensureRoot()`).
- First-boot secrets at `/data/bootstrap_token` and `/data/prune_token`
  (mode 0600) are generated by the server during startup if missing;
  `/data/token` is a backward-compat symlink → `bootstrap_token` kept
  for one release. Values are never logged in any flag, error path, or
  audit row — a presence-only hint is printed when at least one was
  newly created.
- File modes: every file the server creates lands at `0600`; every
  directory at `0700`. Enforced by `tools/observability_paths_lib.ts`.

## UI

The `ui/` directory is a self-contained Vite + React + TypeScript app.
Production build (`npm run build` inside `ui/`) emits `ui/dist/` which
the Dockerfile's `ui-builder` stage bakes into the runtime image at
`/app/ui/dist`. `@fastify/static` serves it at `/`; the auth
middleware exempts `/`, `/index.html`, and `/assets/*` so a cold
browser load with no cookie still gets the bootstrap shell + asset
bundle (plan §1.5.1 E1).

Local UI development against a running container:

```bash
cd tools/observability_server/ui
npm install
npm run dev    # serves at http://127.0.0.1:5173 and proxies /api + /ws
```

The dev server hits the container's main listener at
`http://127.0.0.1:7700`; export `OBSERVABILITY_E2E_BASE_URL` if your
publish address differs.

### Bootstrap flow

The browser bootstrap is a two-step exchange (plan Phase 5 Task 2):

1. The host helper opens
   `http://127.0.0.1:7700/#b=<one-time-code>`. The `b=` value lives in
   the URL fragment so it is never transmitted to the server in the
   HTTP request target and is never persisted in proxy access logs.
2. The page's first JS module (`src/bootstrap.ts`) reads the
   fragment, stashes the code, and calls
   `history.replaceState(null, "", location.pathname)` to strip it
   from the address bar. It refuses to read the fragment if
   `window.top !== window` (frame-busting / clickjacking guard). React
   then POSTs the code to `/api/auth/exchange`; on 204 the cookie is
   set and the app mounts.

A11y (plan §9): native `<ul role="tree">` left rail, sortable
`<table aria-sort>` detail view, focusable inline gap markers for
`chunk_truncated`, polite ARIA live region with 2 s batching and a
"Quiet" toggle, focus rings ≥ 3:1, 44×44 touch targets,
`prefers-reduced-motion` honored. The Playwright + axe suite
(`ui/test/e2e/`) enforces zero violations and the < 2 s sub-agent
select → first-byte target.

## SQLite schema

`migrations/001_init.sql` creates the full schema, including the post-
review amendments:

- `runs.parent_pid` + `runs.writer_daemon_pid` (E10)
- `spool_files.rewrite_pending*` + `rewrite_state` + `rewrite_txn_id` +
  `target_size_bytes` + `target_mtime_ns` (E5 + RT2)
- `event_offsets` (universal WS-backfill seek index)
- `chunk_truncations` (chunk-drop audit trail)
- `synthetic_events` (sweeper-injected lifecycle close events — RT3)

Migrations run on every server boot. `PRAGMA user_version` is bumped per
file; second-boot logs show `0` `applying migration` lines.

## Local commands

```bash
# Pre-create every host-side bind dir (runs, hostinfo, audit) at 0700.
# /data stays a named volume — the compose `init` sidecar chowns it
# to the runtime UID/GID on every `up`.
node --experimental-strip-types -e "import('./../observability_paths_lib.ts').then(m => m.ensureRoot())"

cd tools/observability_server

# Generate .env (REQUIRED — see .env.example for the alternate RT1
# acceptance path that pins UID/GID to 10001).
printf 'OBSERVABILITY_UID=%s\nOBSERVABILITY_GID=%s\n' \
  "$(id -u)" "$(id -g)" > .env

docker compose up -d
docker compose down

# health probe
curl -sS http://127.0.0.1:7700/api/health/probe
```

For everything else see the plan
(`docs/specs/2026-05-25-stark-review-observability-plan.md`) and design
(`docs/specs/2026-05-25-stark-review-observability-design.md`).

## JSONL event schema (Phase 8 reference)

Every JSONL spool record carries `seq` (monotonic per run), `ts`
(ISO-8601 ms), and `type`. The current set:

| `type` | Required fields | Notes |
| --- | --- | --- |
| `run_start` | `version`, `dispatcher`, `tracked_parent_pid`, `writer_daemon_pid` | First record. `version` = 1. |
| `run_heartbeat` | – | 10 s interval; daemon-owned timer. |
| `run_end` | `status`, `ended_at`, `crashed_reason?` | `status ∈ ok/error/timeout/crashed`. |
| `subagent_start` | `subagent_id`, `agent`, `model`, `task` | – |
| `subagent_heartbeat` | `subagent_id` | 30 s interval; tier-batched. |
| `subagent_end` | `subagent_id`, `status`, `duration_ms` | – |
| `subagent_stdout` / `subagent_stderr` | `subagent_id`, `stream`, `encoding`, `chunk` | `encoding ∈ utf8/base64`; tier-batched. |
| `subagent_progress` | `subagent_id`, `kind`, `payload` | `kind == "finding"` is tier-immediate. |
| `chunk_truncated` | `subagent_id`, `stream`, `bytes_dropped`, `reason` | Phase 7 + E6 sentinel. `seq` is preserved across the in-place rewrite. |

### `chunk_truncated` semantics

A `subagent_stdout` / `subagent_stderr` record at `(run_id, seq)` may be
rewritten in-place by the prune CLI into a `chunk_truncated` record at
the same `seq`. The tailer detects the in-place rewrite via mtime
change + `spool_files.rewrite_state` transitions; the index writer's
state machine (`subagent_*` → `chunk_truncated`) deletes the
`chunk_offsets` row for that seq and inserts a `chunk_truncations` row.
WS subscribers see the gap live via `event: gap`; backfill via
`code: retention_gap`. The UI renders inline gap markers
(`ui/src/components/GapMarker.tsx`).

### Liveness — hostinfo only

`host.json` is the ONLY host-introspection surface. Liveness sweep
joins `runs.parent_pid` against `host.live_pids[]`. There is no
`/proc` mount; macOS Docker Desktop does not expose host `/proc`.

### Writer daemon UDS protocol (per-run)

Each dispatcher run spawns a per-run daemon. Dispatchers connect to
`tmpdir/stark-obs/<hash>.sock` (mode 0600). First frame:

```json
{"op": "hello", "cap": "<ephemeral-cap>"}
```

The cap is minted by `op: "caps_issue"` against the per-run
`writer.cap` issuer secret (0600, in the per-run dir). Subsequent ops:
`start_subagent`, `end_subagent`, `emit_progress`, `emit_chunk`,
`emit_chunk_truncated`, `emit_subagent_heartbeat`, `end_run`, `ping`.

### Retention-notify two-call protocol

`POST /api/internal/retention/notify` (Bearer-token, loopback-only)
accepts a strictly-ordered pair per rewritten spool file:

```json
// Call A — sent BEFORE rename(2). Never carries new_mtime_ns.
{"action": "pre-rename", "run_id": "...", "rotation_index": 0,
 "file_path": "...", "new_size_bytes": 500,
 "truncated": [{"seq": 5, "subagent_id": "...", "stream": "stdout", "bytes_dropped": 1234}]}

// Call B — sent AFTER rename(2). Never carries truncated[] or new_size_bytes.
{"action": "update-mtime", "run_id": "...", "rotation_index": 0,
 "file_path": "...", "new_mtime_ns": 1779692401000000000}

// On rename(2) failure — must complete before retrying.
{"action": "abort-rewrite", "run_id": "...", "rotation_index": 0,
 "file_path": "..."}
```

The Bearer-token check resolves the `stark-observability-prune-token`
Keychain entry (NEVER `stark-observability-token`); the prune CLI
writes the header to a 0600 temp file and passes it via `curl -K
<file>` so the token never lands in `argv`.

### Crashed-state semantics

Two redundant writers, single-writer-per-failure-mode guaranteed by
the sweeper's `status NOT IN (terminal)` filter:

- **Daemon-written** (≤ 60 s): per-run writer daemon polls
  `kill(tracked_parent_pid, 0)` every 30 s; on ESRCH writes a final
  `run_heartbeat`, then `run_end {status: "crashed", crashed_reason:
  "parent_exit"}` with `ended_at = new Date().toISOString()`, rewrites
  `meta.json` with the same TS, removes `writer.sock` + `writer.pid`,
  exits 0.
- **Sweeper-written** (≤ 90 s, fallback): the container's liveness
  sweep runs every 30 s, marks rows whose `parent_pid` ∉
  `host.live_pids[]` as crashed via a `status NOT IN (terminal)`
  UPDATE with `ended_at` bound server-side. The synthetic close event
  is recorded in `synthetic_events` so WS backfill replays it.

`runs.parent_pid` is always the **tracked-parent pid** — the
dispatcher Node pid for normal dispatchers, or the SKILL.md shell
pid for `/stark-phase-execute`. The daemon's own pid lives in
`runs.writer_daemon_pid` and is diagnostic only.

All `ended_at` + `last_heartbeat_at` values are server-bound ISO-8601
millisecond strings. SQLite `strftime` / `datetime('now', ...)` are
forbidden; `tools/observability_server/server/grep_assertions.test.ts`
enforces this in CI.

## Deployment runbook — LAN bootstrap

```bash
# 1. Loopback boot + first-bootstrap dance.
docker compose -f tools/observability_server/docker-compose.yml up -d
node --experimental-strip-types tools/observability_open.ts --no-browser
# → writes /data/last_bootstrap_at, /data/bootstrap_token,
#   /data/prune_token, populates Keychain (stark-observability-bootstrap-token
#   + stark-observability-prune-token), drops session.cookie at
#   ~/.claude/code-review/observability/session.cookie.

# 2. Stop loopback stack.
docker compose -f tools/observability_server/docker-compose.yml down

# 3. Install LAN override.
cp tools/observability_server/docker-compose.lan.yml.example \
   tools/observability_server/docker-compose.override.yml
# Replace LAN_IP_PLACEHOLDER with your host's actual LAN IP.

# 4. Boot LAN stack via TLS.
docker compose \
  -f tools/observability_server/docker-compose.yml \
  -f tools/observability_server/docker-compose.override.yml up -d

# 5. TLS probe via mkcert root.
curl -sS --cacert "$(mkcert -CAROOT)/rootCA.pem" \
     https://<LAN_IP>:7700/api/health/probe   # → {"ok":true}
# Plain HTTP off-loopback must refuse.
```

There is no escape hatch around `/data/last_bootstrap_at` — first
boot must always be loopback. `bash tools/observability_server/test/live/lan_bootstrap.sh`
automates the full sequence + the negative HTTP-LAN refusal test.

## Scripted auth contract

Scripts and operators NEVER use `curl -H "Authorization: Bearer $TOKEN"`
or any helper-stdout-piped Bearer flow. The two authoritative forms:

```bash
# Cookie file — populated by tools/observability_open.ts:
COOKIE_FILE=~/.claude/code-review/observability/session.cookie
curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/runs

# Bearer-needing scripts (prune CLI) — write the header to a 0600 file:
HDR=$(mktemp -t obs-curl-XXXXXX)
trap 'rm -f "$HDR"' EXIT
chmod 0600 "$HDR"
TOKEN=$(security find-generic-password -s stark-observability-prune-token -w)
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" >"$HDR"
curl -sS -K "$HDR" http://127.0.0.1:7701/api/internal/retention/...
```

The presence of `--print-token` in any source file is a build break —
`server/grep_assertions.test.ts` enforces it.

## Phase 8 load harness + live tests

- `tools/observability_server/test/load.ts --spec` — plan-profile load
  test (N=27 sub-agents × 10 KB/s × 600 s + 2 WS subscribers + 5 s
  history loop). Asserts WS p95 < 2 s, SSFB p95 < 2 s, UDS RTT p95 <
  5 ms, commit p95 < 50 ms, memory growth < 50 MB/h. Writes
  `test/load-report.json`; render with `load_report.ts`.
- `tools/observability_server/test/failure_paths.test.ts` — failure
  matrix from §Testing: malformed JSONL, deleted spool, parse storm,
  SQLite commit failure, dispatcher SIGKILL, server crash between
  retention-notify Call A and Call B, base64 chunk truncation.
- `tools/observability_server/test/live/` — operator-driven scripts
  (dispatcher SIGKILL, dispatcher+daemon SIGKILL with sweeper
  idempotency, host_boot_id change, pressure retention notify, LAN
  bootstrap). Each prints `PASS`/`FAIL` so they can be wired into CI.

