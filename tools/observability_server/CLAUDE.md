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

## Migrations

`migrations/NNN_*.sql` run on every boot, idempotent via `PRAGMA
user_version`. To add a column: bump to a new file (do NOT mutate
`001_init.sql` after release).
