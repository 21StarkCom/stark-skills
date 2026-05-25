# AGENTS.md — stark-observability server

See `CLAUDE.md` for the binding rules. Short version:

- Liveness reads only `/hostinfo/host.json`. No `/proc` mount.
- Files: 0600. Dirs: 0700. Go through `observability_paths_lib.ts`.
- Migrations under `migrations/`, idempotent via `user_version`.
- Server bind is gated by `OBSERVABILITY_PUBLISHED_HOST` +
  `OBSERVABILITY_ALLOW_LAN` + `OBSERVABILITY_TLS_TERMINATED` +
  `/data/last_bootstrap_at` (see `server/bind.ts`).
- UI is the Vite app under `ui/`; runtime artefacts at
  `/app/ui/dist`. Auth middleware exempts `/`, `/index.html`, and
  `/assets/*` so the cold shell loads without a cookie (E1). Never
  reach for the unsafe React HTML prop in `ui/src/`; chunks render as
  React text nodes via the ANSI token stream in `ui/src/ansi.ts`.
