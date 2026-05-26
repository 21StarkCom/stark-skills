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
- Writer daemon protocol: one-per-run UDS at `tmpdir/stark-obs/<hash>.sock`
  (0600), `{op:"hello",cap}` first frame, cap minted from per-run
  `writer.cap` via `caps_issue`. `{stop}` from heartbeat helpers is a
  timer cancel only — `endSubAgent`/`endRun` are the lifecycle calls.
- `runs.parent_pid` = tracked-parent pid (dispatcher Node pid, or
  SKILL.md shell pid for `/stark-phase-execute`); `runs.writer_daemon_pid`
  is diagnostic only. The liveness sweep joins `parent_pid` against
  `host.live_pids[]`. Every `ended_at` / `last_heartbeat_at` is
  server-bound `new Date().toISOString()` — no SQLite `strftime`.
- Retention notify is two strictly-ordered calls: `pre-rename`
  (carries `new_size_bytes` + `truncated[]`) BEFORE `rename(2)`;
  `update-mtime` (carries `new_mtime_ns`) AFTER. `abort-rewrite` on
  failure. SQLite is the sole rewrite transaction log (RT2).
- Scripted auth: cookie file (`-b $COOKIE_FILE`) or Keychain Bearer
  (`stark-observability-bootstrap-token` or `stark-observability-prune-token`)
  via `curl -K <0600-file>`. Never `--print-token`, never raw
  `Authorization: Bearer $TOKEN` in argv. `grep_assertions.test.ts`
  enforces this.
- LAN bootstrap requires a successful loopback bootstrap first —
  `/data/last_bootstrap_at` is the gate, no escape hatch. See
  `test/live/lan_bootstrap.sh` for the five-step sequence.
- Phase 8 harnesses live in `test/`: `load.ts` (perf + percentile
  assertions), `failure_paths.test.ts` (failure-matrix coverage),
  `test/live/` (operator-driven crashed-path + LAN bootstrap scripts).
