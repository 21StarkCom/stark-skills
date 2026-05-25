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
