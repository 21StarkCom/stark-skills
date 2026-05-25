# AGENTS.md — stark-observability server

See `CLAUDE.md` for the binding rules. Short version:

- Liveness reads only `/hostinfo/host.json`. No `/proc` mount.
- Files: 0600. Dirs: 0700. Go through `observability_paths_lib.ts`.
- Migrations under `migrations/`, idempotent via `user_version`.
- Server bind is gated by `OBSERVABILITY_PUBLISHED_HOST` +
  `OBSERVABILITY_ALLOW_LAN` + `OBSERVABILITY_TLS_TERMINATED` +
  `/data/last_bootstrap_at` (see `server/bind.ts`).
