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
