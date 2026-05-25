# Stark Review Observability — Implementation Plan

## 1. Overview

Implementation approach is **infra-first, then emit, then server, then UI, then dispatcher integration, then ops**. Each phase delivers a working increment that can be exercised end-to-end with the previous phases.

Key architectural decisions:

- **JSONL append-only spool is the contract.** Emit (host) and server (container) are decoupled by the filesystem — phases can be built and tested independently.
- **Read-only spool mount + host-side prune.** Container can never tamper with evidence; retention split is enforced from day one, not bolted on later.
- **Per-install token + bootstrap-code → session cookie.** Auth is wired in Phase 4 (server) before any UI exists; UI in Phase 5 only consumes it. **The bootstrap helper (`tools/observability_open.ts`) never echoes the raw token to stdout in any code path** (no `--print-token` flag exists). It writes the session cookie to a 0600 file for scripted use and stores the long-lived token in the macOS Keychain (service `stark-observability-token`). Scripts that need Bearer auth read the token directly from the Keychain via the OS `security` CLI — distinct from any helper stdout.
- **Liveness via run-heartbeat + `parent_pid` + `host_boot_id` + hostinfo `live_pids[]`.** Container performs NO `/proc` introspection. macOS Docker Desktop cannot mount host `/proc`, so liveness consumes a host-maintained sidecar (`hostinfo/host.json`) exclusively.
- **Single ownership rule for emit lifecycle:** the **dispatcher entry point** owns `startRun` / `endRun` / `startRunHeartbeat` AND `startSubAgent` / `endSubAgent` / `startHeartbeat`. `runProcess` does ONE observability thing only — `attachChild` to tap stdout/stderr. This eliminates double-end / missing-summary risk and is enforced as a code rule in Phase 6.
- **Heartbeat-stop is strictly a timer cancel; lifecycle calls own termination.** `startRunHeartbeat(ctx)` and `startHeartbeat(ctx, sa)` return `{stop}` objects whose `stop()` ONLY cancels the timer and releases the local interval handle. It does NOT call `endRun` / `endSubAgent` / `run_end` / `subagent_end`. The dispatcher always calls `endRun` (or `endSubAgent`) **first**, then `runHb.stop()` (or `saHb.stop()`) **second**. This rule applies to in-process callers (the dispatcher's own timer handle) and to the daemon-internal run-heartbeat timer (which is cancelled inside `endRun` before the daemon flushes and exits).
- **Crashed semantics belong to the liveness sweeper alone, not the daemon.** When the daemon's `kill(tracked_pid, 0)` poll observes ESRCH (the dispatcher / SKILL.md shell is gone), the daemon writes `run_end` with **`status: "crashed"`** and **`crashed_reason: "parent_exit"`** (not `error`). It then flushes, fsyncs, rewrites `meta.json`, and exits. The Phase 4 liveness sweeper covers the case where the **daemon itself** also died before reaching that path. There is exactly one crashed-state writer per failure mode — never two ticking the same row.
- **Cross-process emit goes through a per-run UDS writer daemon.** Each `RunCtx` is owned by exactly one process: the **writer daemon** (`tools/observability_writer_daemon.ts`, new). All emits — from the dispatcher process, from child slash-command processes, from CLI subcommands like `phase_execute_observability.ts progress` — connect to `~/.claude/code-review/observability/runs/{run_id}/writer.sock` and send framed JSON requests. The daemon owns the in-process writer queue, the seq counter, the byte budget, the open file descriptors, and rotation. This eliminates the "multiple processes share an in-process RunCtx" inconsistency and gives a single serialization point for every event on a run.
- **`runs.parent_pid` is always the tracked-parent pid, never the daemon pid.** At daemon spawn the caller passes the pid the daemon must watch via the `--tracked-parent-pid` arg. For normal dispatchers that is `process.pid` of the dispatcher Node process. For `/stark-phase-execute` it is the SKILL.md shell pid passed as `--skill-pid` to `phase_execute_observability.ts start`. The daemon writes that exact pid into every `run_heartbeat`'s `parent_pid` field AND into `meta.json.parent_pid`, the index writer copies it into `runs.parent_pid`, and the liveness sweeper checks `runs.parent_pid NOT IN host.live_pids[]`. The daemon's own pid is recorded separately in `meta.json.writer_daemon_pid` and `runs.writer_daemon_pid` for diagnostics but is never used by the liveness check.
- **All JSONL records are seek-indexed.** A single `event_offsets` table indexes every JSONL record by `(run_id, seq)` with file rotation index + byte range. WebSocket backfill and chunk SSE both read raw bytes through this index, so lifecycle events (`subagent_start`, `subagent_end`, `run_heartbeat`, `run_end`, `subagent_progress`, heartbeats, chunks) all replay verbatim.
- **`chunk_truncated` is a first-class JSONL event type with seq-preserving in-place rewrite semantics.** The pressure-retention rewrite replaces each `subagent_stdout` / `subagent_stderr` record with a `chunk_truncated` record carrying **the same `seq`** as the original chunk. There is no separate `replaced_seq` — `seq` IS the seq of the data that got dropped. Schema and JSONL event share that contract.
- **One canonical retention-notify schema, one strictly-ordered two-step call.** Phase 7's prune CLI talks to the server's `POST /api/internal/retention/notify` endpoint via two distinct requests per rewritten file: (1) **`action: "pre-rename"`** carrying `new_size_bytes` and a `truncated[]` array of `{seq, subagent_id, stream, bytes_dropped}` rows — called BEFORE the `rename(2)`; (2) **`action: "update-mtime"`** carrying `new_mtime_ns` — called AFTER the rename, once the new mtime is `fstat`-able. The pre-rename body NEVER carries `new_mtime_ns`. Phase 3, Phase 4, and Phase 7 reference this identical schema.
- **All timestamps written by the server come from TypeScript `new Date().toISOString()`, never SQLite `strftime`.** This applies to every `runs.ended_at`, `subagents.ended_at`, and any other ISO-8601 column the server writes. SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ','now')` produces non-portable formatting and has burned this codebase before; TS computes once and binds as a parameter, guaranteeing the canonical `YYYY-MM-DDTHH:MM:SS.sssZ` shape and matching every emit-side timestamp.
- **TypeScript everywhere, no Python.** Per repo CLAUDE.md.

Phases (8 total):

1. **Infra & scaffolding** — spool dirs, Docker skeleton with explicit `container_name`, schema migrations, hostinfo ticker (sole host-introspection surface), executable LAN bootstrap sequence.
2. **Emit library + writer daemon** — `observability_emit_lib.ts` plus `observability_writer_daemon.ts` (the per-run UDS server) with the full event surface, redaction, byte budgets, heartbeats, child taps. Defines the daemon protocol so Phase 6 can use it.
3. **Tailer + universal event index + chunk_truncated handling** — `fs.watch` → JSONL parse → SQLite upserts; `event_offsets` indexes every record; `chunk_truncated` parsed and recorded; the tailer correctly handles in-place rewrites by re-reading from offset 0 when the internal retention-notify endpoint resets per-file state.
4. **HTTP API + WebSocket hub + liveness + auth** — full server surface behind bootstrap-code session auth; backfill reads `event_offsets` for ALL event types; liveness sweeper sets `status='crashed'` AND `ended_at=<TS-bound ISO timestamp>` so transitions are idempotent.
5. **UI** — React/Vite single-page app with tree, table, live log, history, full a11y, inline gap markers for `chunk_truncated`.
6. **Dispatcher integration** — wire `RunCtx` and `attachChild` into all eight dispatcher entry points (including `/stark-phase-execute`, via a TS lifecycle wrapper that runs the writer daemon and that the SKILL.md invokes with an explicit `--session-id` resolved up front from `tools/session_id.ts`).
7. **Retention** — host-side prune CLI + container state-only sweep + launchd plist; emits `chunk_truncated` events via streaming in-place rewrite; calls server's `pre-rename` + `update-mtime` notify endpoints in that order. Prune CLI reads its Bearer token directly from the macOS Keychain, never via helper stdout.
8. **Hardening, load test, live verification** — load harness, redaction live test, end-to-end real-PR run with **dispatcher-process** SIGKILL test (matches design's run-level crashed model).

## 2. Prerequisites

Must exist before Phase 1:

- macOS host with Docker Desktop installed and `docker compose` available.
- Node 22+ on host (`--experimental-strip-types` is the project standard for TS execution).
- macOS Keychain access; `security` CLI on `$PATH`.
- **macOS does NOT expose host `/proc` to Docker Desktop.** This is decisive: the container never gets a `/proc` mount under any circumstance. All host-process introspection (parent-pid liveness, host_boot_id, free disk, host uptime) flows through `hostinfo/host.json` produced by the host-side ticker.

Can be done in parallel with Phase 1:

- Drafting the SQLite migration SQL (`migrations/001_init.sql`).
- Drafting the redaction regex set + test fixtures.
- Drafting the JSONL event schema doc that will live in `tools/observability_server/README.md` for human reference.

## 3. Phases

## Phase 1: Infrastructure scaffolding

**Goal:** Spool dirs exist, Docker stack starts on `127.0.0.1:7700` with `container_name: stark-observability` and serves `GET /api/health/probe`, SQLite schema is created on first run, hostinfo ticker is writing `host.json` (with `live_pids[]`) on the host, all docs reflect the hostinfo-only liveness contract. **The LAN bootstrap path is documented as an executable sequence (loopback first boot → run helper → restart with LAN bind + `OBSERVABILITY_ALLOW_LAN=1`).**
**Dependencies:** None.
**Estimated effort:** M.

### Tasks

1. **Create spool directory layout**
   - What: Add an idempotent init step (called by `tools/observability_open.ts` and by `startRun` in Phase 2) that `mkdir -p`s:
     - `~/.claude/code-review/observability/runs/`
     - `~/.claude/code-review/observability/hostinfo/`
     - `~/.claude/code-review/observability/.trash/`
   - Files: `tools/observability_paths_lib.ts` (new) — exports `OBSERVABILITY_ROOT`, `runsDir()`, `hostinfoDir()`, `trashDir()`, `runDir(runId)`, `metaPath(runId)`, `currentSpoolFile(runId, rotationIndex)`, `writerSocketPath(runId)`, `sessionCookiePath()`, `ensureRoot()`.
   - Acceptance: importing the lib and calling `ensureRoot()` twice is a no-op the second time; passes unit test.

2. **Pin hostinfo as the SOLE host-introspection surface; remove all `/proc` references; correct the uptime formula**
   - What: The container has no `/proc` mount. Liveness reads `hostinfo/host.json` exclusively. The host-side ticker `tools/observability_hostinfo.ts` writes:
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
   - **Field derivations (exact, executable on macOS):**
     - `boot_time_seconds`: parse `sysctl -n kern.boottime` (output `{ sec = 1779692400, usec = 123456 } …`) into the numeric `sec + usec/1e6` value.
     - `host_boot_id`: same value as `boot_time_seconds` formatted as `"<sec>.<usec>"`. Stable across the boot session, changes on reboot.
     - `uptime_seconds`: `Date.now() / 1000 - boot_time_seconds` (always positive).
     - `wall_clock`: `new Date().toISOString()`.
     - `free_disk_bytes`: `fs.statfs(spoolDir).bavail * fs.statfs(spoolDir).bsize`.
     - `live_pids`: `ps -axo pid= -u $(id -u)` parsed into integers — single fork, ~3–5 ms on a healthy Mac, returns only the current user's PIDs. No shell-string interpolation (args passed as argv array via `spawnSync`); no PID-bag leakage of other users; bounded output (≤ a few thousand PIDs).
   - Write cadence: 5 s. Atomic write: `host.json.tmp` → `rename(2)`. The tailer/server reads with `O_RDONLY`; rename guarantees no torn reads.
   - Files: `tools/observability_hostinfo.ts` (new — `--loop --interval 5s` and `--once` modes), `tools/observability_paths_lib.ts` already exposes `hostinfoDir()`.
   - **Doc updates (in this same task / commit):**
     - `tools/observability_server/README.md` (new): "Liveness contract: container reads only `/hostinfo/host.json`. No `/proc` mount."
     - `tools/observability_server/CLAUDE.md` (new): mirror of the above, plus the live_pids generation note and the corrected uptime formula.
     - `tools/observability_server/AGENTS.md` (new): one-line pointer.
     - Top-level `CLAUDE.md` (the stark-skills one) gets a one-line note under "Observability stack".
     - Top-level `AGENTS.md`: one-line pointer.
     - `docs/specs/stark-review-observability.md`: replace any `/proc:/host_proc:ro` references with `/hostinfo/host.json`.
   - Acceptance: start ticker; `cat ~/.claude/code-review/observability/hostinfo/host.json | jq '.uptime_seconds > 0'` returns `true`; `boot_time_seconds` matches the `sysctl` parse; `live_pids[]` includes the ticker's own PID and the current shell's PID; field updates within 5 s; the rename is atomic verified by a torn-write stress test (1000 rapid reads while the ticker writes 1000 times → zero parse errors).

3. **Docker compose + Dockerfile skeleton with explicit container name + executable LAN bootstrap sequence**
   - What: Multi-stage `node:22-alpine` image, deps `better-sqlite3`, `chokidar`, `ws`, `fastify`, `cookie`, `@fastify/static`, `@fastify/rate-limit`. **Alpine `better-sqlite3` build requirements:** stage `builder` (FROM `node:22-alpine`) installs `python3 make g++ gcc libc-dev` via `apk add --no-cache --virtual .build-deps`, copies `package.json` + `package-lock.json`, runs `npm ci --build-from-source` to compile native modules, then drops the build deps. The runtime stage starts from a fresh `node:22-alpine` and `COPY --from=builder /app/node_modules /app/node_modules`, leaving the toolchain out of the final image. This is the only known-reproducible install path for `better-sqlite3` on `node:22-alpine` as of 2026-05-25. The image installs **no `sqlite3` CLI** — all index mutations go through Node's `better-sqlite3` in the server process; the prune CLI uses the server's internal HTTP endpoint, not direct DB access (see Phase 7 Task 3). The container generates `/data/token` (256-bit) on first run if missing; logs a one-line bootstrap hint (`"bootstrap required — run: node --experimental-strip-types tools/observability_open.ts"`) — never the token value.
   - Files:
     - `tools/observability_server/Dockerfile`
     - `tools/observability_server/docker-compose.yml` — explicit `container_name: stark-observability`; default `services.observability.ports: ["127.0.0.1:7700:7700"]`; volumes:
       ```yaml
       volumes:
         - ~/.claude/code-review/observability/runs:/spool/runs:ro
         - ~/.claude/code-review/observability/hostinfo:/hostinfo:ro
         - observability_index:/data

       # The block below is REQUIRED active YAML — NOT a comment. It declares
       # a top-level `volumes:` key (sibling of `services:` at column 0 of the
       # real docker-compose.yml, even though both appear at the same
       # markdown-list indent here). Pinning `name: observability_index`
       # stops Docker Compose from prefixing the volume with the project
       # directory name. Without it, the Phase 8 Task 8 marker-wipe commands
       # (`docker volume inspect observability_index`,
       # `docker run -v observability_index:/data …`) silently target a
       # different volume than the one mounted at `/data` inside the container.

       volumes:
         observability_index:
           name: observability_index
       ```
       NOTE: no `/proc:/host_proc:ro` line. The runs mount is `/spool/runs` (not `/spool`) so every container-side path reference in this plan (`/spool/runs/<runId>/events-NNNN.jsonl` in Phase 3 scans, Phase 3 retention-notify schemas, and Phase 7 prune CLI bodies) matches the file system the tailer actually observes.
     - `tools/observability_server/docker-compose.lan.yml.example` — a checked-in **example override** showing the LAN publish + `OBSERVABILITY_ALLOW_LAN=1` env. Operators copy it to `docker-compose.override.yml` only after completing the bootstrap sequence below.
     - `tools/observability_server/package.json`, `tsconfig.json`
     - `tools/observability_server/server/index.ts` — minimal `GET /api/health/probe` returning `{ ok: true }`.

   - **Server boot binding rules (the container CANNOT introspect Compose `ports:` mappings from inside, so an explicit env-var contract is the only reliable signal of what host-side address is published):**
     - **Default bind inside the container:** `0.0.0.0` (per design §"Network binding"). Host exposure is constrained by `docker-compose.yml`'s default `ports: ["127.0.0.1:7700:7700"]` — only host loopback is published. The container-internal `0.0.0.0` is required so Docker's port forwarder can reliably reach the server through the published port (binding to `127.0.0.1` inside a container is not reliably reachable through Docker port publishing depending on userland-proxy configuration).
     - **Required env contract:** every Compose file MUST set `OBSERVABILITY_PUBLISHED_HOST` to the exact host-side `<address>:<port>` it publishes to (`127.0.0.1:7700` in the default file; `<lan-ip>:7700` in the LAN override). The container reads this env at boot and uses its value — never `req.socket.remoteAddress`, which Docker's userland proxy replaces with a gateway address such as `192.168.65.1`/`172.x` — as the authoritative answer to "what host-side address am I exposed on". The server refuses to boot (non-zero exit + recovery instructions) if `OBSERVABILITY_PUBLISHED_HOST` is unset.
     - **Non-loopback publish refused unless authorized:** if `OBSERVABILITY_PUBLISHED_HOST` is not in `{127.0.0.1:7700, ::1:7700, localhost:7700}`, the server refuses to boot unless ALL THREE conditions hold simultaneously:
       1. `OBSERVABILITY_ALLOW_LAN=1` is set in the container env, AND
       2. `/data/last_bootstrap_at` exists on the SQLite-index volume (written by `POST /api/auth/exchange` in Phase 4 Task 1 the first time a bootstrap code is redeemed), AND
       3. `OBSERVABILITY_TLS_TERMINATED=1` is set (signals that an HTTPS reverse proxy fronts the listener; see the Phase 4 Task 1 cookie-`Secure`/WSS contract). The server's own listener never speaks HTTPS; operator-facing docs (Phase 8) point at `mkcert`-issued certs on a local reverse proxy as the recommended setup.
     - `OBSERVABILITY_BIND` overrides the container-internal bind only; it never substitutes for the three rules above.
     - On refusal the server prints an exact recovery instruction to `docker logs` and exits non-zero:
       ```
       [server] non-loopback bind requested but bootstrap state missing.
       [server] Required steps:
       [server]   1. Stop this stack.
       [server]   2. Restart with the default loopback bind (no OBSERVABILITY_BIND override, no docker-compose.override.yml).
       [server]   3. On the host, run: node --experimental-strip-types tools/observability_open.ts
       [server]   4. After the helper prints "session established", stop the stack.
       [server]   5. Apply the LAN override and restart.
       ```

   - **Executable LAN bootstrap sequence (this is the only path that produces a LAN-listening server):**
     1. **First boot, host loopback publish.** `docker compose -f tools/observability_server/docker-compose.yml up -d`. No override file. The Node server binds `0.0.0.0:7700` inside the container; docker-compose publishes `127.0.0.1:7700:7700` on the host so only the host loopback can reach it. The container generates `/data/token` if missing, serves `/api/health/probe`. `/data/last_bootstrap_at` does not yet exist.
     2. **Run the helper against loopback** (always possible because the bind is loopback at this step):
        ```bash
        node --experimental-strip-types tools/observability_open.ts --no-browser
        ```
        The helper reads `/data/token` (via `docker exec stark-observability cat /data/token`), stores it in the macOS Keychain under service `stark-observability-token`, calls `POST /api/auth/bootstrap` and then `POST /api/auth/exchange` on loopback, receives the session cookie, and writes it to `~/.claude/code-review/observability/session.cookie` (mode 0600, Netscape format for curl). The server's `exchange` handler writes the marker file `/data/last_bootstrap_at` containing the ISO timestamp (Phase 4 Task 1 spells out that write).
     3. **Stop the stack:** `docker compose -f tools/observability_server/docker-compose.yml down`. The named volume `observability_index` retains `/data/token` AND `/data/last_bootstrap_at`.
     4. **Enable LAN.** Copy the example override into place and edit the bind address:
        ```bash
        cp tools/observability_server/docker-compose.lan.yml.example \
           tools/observability_server/docker-compose.override.yml
        # Edit the override to set the LAN bind, e.g. "192.168.1.42:7700:7700",
        # and confirm OBSERVABILITY_ALLOW_LAN=1 is set in the env block.
        ```
     5. **Restart with both overlays:**
        ```bash
        docker compose \
          -f tools/observability_server/docker-compose.yml \
          -f tools/observability_server/docker-compose.override.yml up -d
        ```
        The server boots, observes `OBSERVABILITY_ALLOW_LAN=1` AND `/data/last_bootstrap_at` exists, and starts listening on the LAN address. The bootstrap helper had to run against loopback (step 2) to produce the marker that authorizes the LAN bind (step 5) — the loopback first boot is what breaks the chicken-and-egg.

   - **Acceptance** of the LAN sequence (verified in Phase 8 Task 8 — Phase 1 implements only the server-side guards, the example override, and the `OBSERVABILITY_PUBLISHED_HOST` env contract; the helper-driven steps require Phase 4 auth endpoints): a single end-to-end transcript of the five steps succeeds; attempting step 5 BEFORE step 2 fails with the printed recovery instructions; attempting step 5 with `OBSERVABILITY_ALLOW_LAN` unset also fails identically.

4. **SQLite schema + migration runner**
   - What: Add `migrations/001_init.sql` containing the full schema (see §6 of the design, plus the universal `event_offsets` table and `chunk_truncations` table added below). Server's `index.ts` opens `/data/index.db`, runs `PRAGMA user_version`, applies pending migrations in order, single `BEGIN/COMMIT` per file.
   - **New tables added (not in the design as written; required by findings 6 + 7):**
     ```sql
     CREATE TABLE IF NOT EXISTS event_offsets (
       run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
       seq            INTEGER NOT NULL,
       ts             TEXT NOT NULL,
       type           TEXT NOT NULL,
       subagent_id    TEXT,
       rotation_index INTEGER NOT NULL,
       byte_start     INTEGER NOT NULL,
       byte_end       INTEGER NOT NULL,
       PRIMARY KEY (run_id, seq)
     );
     CREATE INDEX IF NOT EXISTS idx_event_offsets_subagent ON event_offsets(subagent_id, seq);
     CREATE INDEX IF NOT EXISTS idx_event_offsets_type     ON event_offsets(run_id, type, seq);

     CREATE TABLE IF NOT EXISTS chunk_truncations (
       run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
       subagent_id    TEXT NOT NULL REFERENCES subagents(subagent_id) ON DELETE CASCADE,
       seq            INTEGER NOT NULL,
       ts             TEXT NOT NULL,
       bytes_dropped  INTEGER NOT NULL,
       stream         TEXT NOT NULL,
       PRIMARY KEY (run_id, seq)
     );
     CREATE INDEX IF NOT EXISTS idx_chunk_trunc_subagent ON chunk_truncations(subagent_id, seq);
     ```
   - The `runs` table from §6 of the design gets one additional column added in this same migration: `writer_daemon_pid INTEGER` (nullable). Diagnostics-only; the liveness sweeper does NOT read it. Populated from `run_heartbeat.writer_daemon_pid` (see Phase 2 Task 8 / Phase 3 Task 2).
   - `chunk_offsets` is RETAINED (it carries `stream` + `encoding`, which the chunk SSE endpoint still needs for surviving chunks). `event_offsets` is the superset used for WS backfill of every event type.
   - Files: `tools/observability_server/migrations/001_init.sql`, `tools/observability_server/server/db.ts`.
   - Acceptance: starting the container with an empty `/data` produces `index.db` with `runs` (incl. `writer_daemon_pid` column), `subagents`, `progress_events`, `spool_files`, `tail_offsets`, `chunk_offsets`, `event_offsets`, `chunk_truncations` tables plus all indexes; restart is a no-op.

5. **launchd plist for hostinfo ticker**
   - What: `tools/observability_server/launchd/com.aryeh.observability.hostinfo.plist`. Runs `/usr/local/bin/node --experimental-strip-types <repo>/tools/observability_hostinfo.ts --loop --interval 5s`. RunAtLoad + KeepAlive true.
   - Acceptance: `launchctl load` starts the ticker; `kill -9` on the ticker process triggers respawn within 5 s.

### Risks

- **`live_pids[]` growth on a busy host** — capped by `ps -u $(id -u)` to the operator's own processes (typically 50–300). Documented limit.
- **Hostinfo write while server reads** → atomic rename eliminates torn reads; verified by stress test.
- **Token leak in `docker logs`** → mitigated by never logging the token value; bootstrap hint only. The helper enforces the same rule on its side — there is no flag that prints the raw token to stdout.
- **Docker Compose volume-name prefixing** — the compose file pins the SQLite-index volume name with an explicit top-level `volumes: { observability_index: { name: observability_index } }` block (shown in the compose snippet above) so that `docker volume inspect observability_index` and the marker-wipe `docker run -v observability_index:/data alpine ...` commands target the same volume that is actually mounted into `stark-observability` — without the explicit `name:`, Compose prefixes the volume with the project directory name and the verification commands would silently target a different volume.
- **Operator skips step 2 of the LAN sequence** → server refuses to boot LAN with the printed recovery instructions; no way to brick the install.
- **Compose port mapping vs container-internal view** — covered by the required `OBSERVABILITY_PUBLISHED_HOST` env contract in the binding rules above: the container does not introspect `ports:` (it cannot), so the explicit env value IS the host-publish address from the container's perspective, and any mismatch between the operator's `ports:` line and the env value is the operator's bug to fix — startup-time validation surfaces it immediately.

### Verification (exact, runnable)

Every command below assumes CWD is the stark-skills repo root. **No command in this verification block ever asks the helper to echo a token.**

```bash
# Loopback first boot — always permitted.
docker compose -f tools/observability_server/docker-compose.yml up -d

# Token exists in the container at /data/token (we check presence, not value).
docker exec stark-observability test -s /data/token \
  && echo "container token file present"

curl -sS http://127.0.0.1:7700/api/health/probe
# Expect: {"ok":true}

# NOTE: Helper invocation, Keychain population, session.cookie creation,
# /data/last_bootstrap_at marker write, and the LAN-refusal negative test all
# require Phase 4 auth endpoints (POST /api/auth/bootstrap and
# POST /api/auth/exchange). Those acceptance checks live in Phase 4
# verification and Phase 8 Task 8 ("Live test — LAN bootstrap end-to-end"),
# not here, because Phase 1's server skeleton only exposes
# GET /api/health/probe.

# Restart and confirm migrations don't re-run.
docker compose -f tools/observability_server/docker-compose.yml restart
docker logs stark-observability 2>&1 | grep -c "applying migration"  # expect 0 after first boot

# Hostinfo ticker.
launchctl load tools/observability_server/launchd/com.aryeh.observability.hostinfo.plist
sleep 6
jq '.uptime_seconds > 0 and (.live_pids | length) > 0' \
  ~/.claude/code-review/observability/hostinfo/host.json
# expect: true

# LAN-refusal negative test moved to Phase 8 Task 8 — requires Phase 4 auth
# endpoints that Phase 1 does not yet implement.
```

## Phase 2: Emit library + per-run writer daemon

**Goal:** `tools/observability_emit_lib.ts` is feature-complete with passing unit tests, including writer-queue serialization, rotation, byte budgets, redaction, heartbeats, child taps. **`tools/observability_writer_daemon.ts` (new) hosts a per-run RunCtx behind a Unix domain socket so other processes can emit to the same run.** No dispatcher uses either yet — verified by a synthetic harness that pretends to be a dispatcher.
**Dependencies:** Phase 1.
**Estimated effort:** L.

### Tasks

1. **Core in-process surface**
   - What: Implement the full surface from the design: `startRun`, `endRun`, `startSubAgent`, `endSubAgent`, `emitProgress`, `attachChild`, `startHeartbeat`, `startRunHeartbeat`.
   - Files: `tools/observability_emit_lib.ts` (new).
   - Run-id: `crypto.randomUUID()`. Subagent id: `${runId}:${seq}` where `seq = ctx._nextSubagentSeq++`.
   - `startRun(opts)`: reads `OBSERVABILITY_PER_RUN_MAX_MB` (default 2048) → `ctx.byteBudgetBytes`; reads `OBSERVABILITY_DISABLED=1` env → returns a stub disabled `RunCtx`; runs `fs.statfs(spoolDir)` low-disk preflight (< 1 GiB free → disable with `emit_status: "disabled", emit_disabled_reason: "low_disk"`); calls `paths_lib.ensureRoot()`; spawns the writer daemon with `--tracked-parent-pid <pid>` (default = `process.pid`; phase-execute passes the SKILL.md shell pid); writes initial `meta.json` atomically (`.tmp` + rename); captures `parent_pid = trackedParentPid` and `host_boot_id` (read once from `~/.claude/code-review/observability/hostinfo/host.json` if present, else from `sysctl -n kern.boottime`).
   - **`endRun(ctx, status)` semantics:** stops the daemon-internal run-heartbeat timer (the daemon ignores further heartbeat ticks once `end_run` is received); drains the writer queue; writes a final `run_end` JSONL record with the given status and TS-computed `ts = new Date().toISOString()`; fsyncs the current rotation file; rewrites `meta.json` with `ended_at = new Date().toISOString()` + `status`; closes the UDS server; deletes `writer.sock` + `writer.pid`; exits the daemon process with code 0. The dispatcher's local `RunCtx` handle becomes a stub after this call returns; subsequent `emitProgress` / `endSubAgent` calls on it are no-ops with a single stderr warning.

2. **Per-run writer queue (lives inside the daemon)**
   - What: The daemon process owns one async writer task per `runId`. A queue (Promise-chain FIFO) accepts events; the writer drains serially, assigns `seq` monotonically, JSON-stringifies, appends with newline, `fsync`s, then resolves. Rotation goes through the same queue, so a rotation never interleaves with a flush.
   - Producers from any in-process or cross-process worker push to the queue via the UDS protocol (Task 3) — correctness verified by stress test (10 producers × 10 k events → assert strictly monotonic `seq`, no duplicate, no skip).
   - Files: implementation inside `tools/observability_writer_daemon.ts`; `tools/observability_emit_lib.ts` is the thin client that round-trips ops over UDS.

3. **Writer daemon + cross-process UDS protocol**
   - What: New file `tools/observability_writer_daemon.ts`. **One daemon per active run.** Owns the canonical `RunCtx` and the writer queue described in Task 2 — there is exactly one in-process writer queue per `runId`, located in the daemon process.
   - Spawned by `startRun(...)` via:
     ```ts
     child_process.spawn(process.execPath, [
       '--experimental-strip-types',
       writerDaemonScript,
       '--run-id', runId,
       '--spool-dir', dir,
       '--tracked-parent-pid', String(trackedParentPid),
       '--meta', JSON.stringify(metaFields),
     ], { detached: true, stdio: 'ignore' });
     child.unref();
     ```
     Daemon writes its own PID to `runDir(runId)/writer.pid` for diagnostics and into `meta.json.writer_daemon_pid`.
   - **Startup readiness handshake (binding contract before `startRun`/`connectRun` returns):** the daemon must, in this exact order, (1) create + bind `writer.sock` with mode `0600`, (2) write `writer.pid`, (3) append + `fsync` an initial `run_start` JSONL record into the rotation file, (4) append + `fsync` an initial `run_heartbeat` JSONL record carrying `parent_pid` + `host_boot_id` + `bytes_written: 0` + `writer_daemon_pid`, (5) begin answering `{op:"ping"}` over UDS with `{ok:true, ready:true, run_start_committed:true, run_heartbeat_committed:true}`. `startRun(opts)` polls the socket every 25 ms with a `ping` and does NOT return until the response carries all three `*_committed` flags `true`. Bounded by `OBSERVABILITY_DAEMON_READY_TIMEOUT_MS` (default 5000 ms); on timeout `startRun` enters the disabled-state path (Task 9), `SIGKILL`s the half-started daemon, removes any partial `writer.sock`/`writer.pid`, and returns a stub `RunCtx`. `connectRun(runId, paths)` runs the same handshake against an existing daemon and times out identically (the existing daemon, if healthy, replies to `ping` immediately because steps 1–4 ran at its own startup).
   - **Why the initial `run_heartbeat` is part of the readiness contract (resolves the Phase 4 sweeper race):** the Phase 4 liveness sweeper drives terminal transitions off `runs.parent_pid` + `runs.last_heartbeat_at`. Both columns are populated only by indexed `run_heartbeat` events. The natural 10 s heartbeat cadence would leave them NULL for the first 10 s of every run; a SIGKILL of the dispatcher AND the daemon within that window would otherwise force the orphan-timeout path (30 min) before a row could be marked crashed. Writing one heartbeat as part of the readiness barrier guarantees both columns are non-NULL by the time `startRun` returns, so the sweeper's 60 s `last_heartbeat_at` check (with its IS NULL defense branch from Phase 4 step 4) catches abrupt early kills in normal time.
   - Listens on a Unix domain socket at `paths_lib.writerSocketPath(runId)`. Socket file mode `0600`.
   - **Wire protocol** (newline-delimited JSON, request/response over a single connection):
     ```
     // client → daemon
     {"op":"start_subagent","agent":"codex","model":"gpt-5.5","task":"completeness"}
     {"op":"end_subagent","subagent_id":"<rid>:1","status":"ok","duration_ms":12345,"summary":{...}}
     {"op":"emit_progress","subagent_id":"<rid>:1"|null,"kind":"finding","payload":{...}}
     {"op":"emit_chunk","subagent_id":"<rid>:1","stream":"stdout","encoding":"utf8","chunk":"..."}
     {"op":"emit_subagent_heartbeat","subagent_id":"<rid>:1"}
     {"op":"end_run","status":"ok"|"error"|"timeout"}
     {"op":"ping"}
     // daemon → client
     {"ok":true,"subagent_id":"<rid>:1"}
     {"ok":true,"seq":N}
     {"ok":false,"error":"…","code":"…"}
     ```
   - The daemon NEVER trusts the client for `seq` — assigns it from the in-process counter. The daemon owns `bytes_written`, `byteBudgetExceeded`, heartbeat timers, `ts = new Date().toISOString()` on every write, and `meta.json` rewrites.
   - **Connection lifecycle:** clients reconnect per batch (cheap on UDS). Daemon enforces a 64-KB request size cap and rejects unknown ops. Socket file mode `0600` + inherited uid ensures only the owning user can connect.
   - **Daemon lifecycle on normal `end_run`:** flushes the queue, fsyncs the current rotation file, rewrites `meta.json` one last time (including `ended_at = new Date().toISOString()`), exits 0 and deletes `.sock` and `.pid`.
   - **Daemon lifecycle on tracked-parent loss (the canonical crashed path):** the daemon polls `kill(tracked_parent_pid, 0)` every 30 s. On ESRCH, it:
     1. Writes one final `run_heartbeat` to flush `bytes_written` / `parent_pid`.
     2. Writes a `run_end` JSONL record with **`status: "crashed"`** and `crashed_reason: "parent_exit"` and `ts = new Date().toISOString()` (NOT `status: "error"` — `crashed` is the canonical state for "parent process is gone"; this is the single agreed semantic across the daemon path and the sweeper path).
     3. `fsync`s, rewrites `meta.json` with `ended_at = new Date().toISOString()`, `status: "crashed"`, `crashed_reason: "parent_exit"`.
     4. Deletes `.sock` and `.pid`, exits 0.
     The Phase 4 liveness sweeper sees the `runs.status = 'crashed'` row (written by the index writer from the daemon's `run_end`), matches its terminal-status filter, and does NOT re-touch it. There is no double-crashed-write race.
   - **Daemon lifecycle on SIGTERM/SIGHUP:** same as `end_run` but with `status: "error"`. (Different from parent-loss: SIGTERM is an explicit cooperative shutdown signal sent by an operator or by a wrapper script — distinct intent from "parent died mysteriously".)
   - **Daemon lifecycle on SIGKILL (daemon itself killed):** stale socket remains on disk. The next `connectRun(runId)` from any caller detects no listener (ECONNREFUSED on connect) and treats the run as crashed-by-daemon-loss: emits a single stderr warning, returns a stub disabled client. The Phase 4 liveness sweeper covers the row: with the daemon dead, `run_heartbeat` writes stop, `runs.last_heartbeat_at` ages past 60 s, the daemon's pid is gone from `live_pids[]`, and the sweeper marks `status: 'crashed', crashed_reason: 'parent_exit'` (since the tracked parent — whatever it was — is also dead per the live_pids[] check). Idempotency: once written, the terminal-status filter prevents further updates.
   - **In-process and cross-process clients use the same API.** The emit lib exposes:
     ```ts
     export function startRun(opts): RunCtx              // spawns the daemon, returns a RunCtx wired to it
     export function connectRun(runId, paths): RunCtx    // connects to an existing daemon, returns a RunCtx wired to it
     ```
     `RunCtx` is a thin handle around a `WriterClient` that round-trips ops to the daemon. Heartbeat timers run in the **caller's** process when started via `startHeartbeat(ctx, sa)`; they translate to `emit_subagent_heartbeat` ops over UDS. The `run_heartbeat` timer runs **inside the daemon** and is started automatically on daemon boot and stopped automatically by the daemon when `end_run` arrives.
   - **Acceptance**:
     - Two concurrent Node processes connect to the same daemon, each starts a sub-agent, emits 1000 progress events, ends the sub-agent. Daemon writes 2 × 1000 events with strictly monotonic global `seq` and no interleave corruption.
     - Killing the tracked parent process (`kill -9 $TRACKED_PID`) leads to daemon writing `run_end` with `status: "crashed", crashed_reason: "parent_exit"` within 60 s, then daemon exits.
     - Killing the daemon (`kill -9 $(cat writer.pid)`) without `endRun` leaves a stale socket; a fresh `connectRun(runId)` detects it within 1 s and logs a single stderr line.

4. **Chunk encoding + 64 KB split + non-consuming tap**
   - What: `attachChild` adds non-consuming `'data'` listeners on `child.stdout` and `child.stderr`. Each Buffer is tested for valid UTF-8 (`Buffer.isUtf8(buf)`); on `false`, emit as `encoding: "base64"`. Chunks are split based on **serialized request size**, NOT raw Buffer length. Before sending each `emit_chunk` op the emit lib computes `Buffer.byteLength(JSON.stringify(request))` and re-slices the underlying data if that would exceed 56 KiB (leaves headroom under the daemon's 64 KiB request cap from Task 3 for JSON envelope overhead and any future field additions). Practical raw-slice ceilings: ~40 KiB for non-UTF-8 buffers (base64 expands 4/3 → ~54 KiB encoded plus envelope) and ~48 KiB for UTF-8 (JSON `\u00xx` escape worst case ~2x plus envelope). Every produced chunk shares the same `subagent_id` and `ts`; the writer queue assigns `seq` monotonically (daemon-assigned). The unit test in Task 4 explicitly plants a 64 KiB binary buffer and asserts every `emit_chunk` request fits under the cap before send.
   - **Non-consuming property guarded by unit test:** the test spawns a child, calls `attachChild` AFTER the dispatcher already attached its own `.on('data', ...)` consumer, and asserts the dispatcher's consumer still receives identical bytes byte-for-byte. If the test fails, the implementation falls back to `pipe()`-through-`PassThrough` and observes the PassThrough.

5. **Redaction**
   - What: `tools/observability_redact_lib.ts` (new) exports `redact(text: string): { text: string; redacted: boolean }`. Applies regex list from design §Security plus extras from `~/.claude/code-review/observability/redactors.json` (optional) and `OBSERVABILITY_REDACT_EXTRA_ENV` (CSV env-var names → their literal values become redaction targets). Replacement preserves character count: `<REDACTED:jwt>` padded with `*` to the matched length so log offsets stay stable.
   - Applied **inside the daemon** before any write: every chunk, every `subagent_progress.payload` (deep-walked via `JSON.stringify` round-trip with string-leaf replacement), every `summary`, every `error` string.
   - Each event carrying any redaction sets a top-level `redacted: true` field.
   - Acceptance: positive + negative cases for every built-in pattern (jwt, ghp_, ghs_, gho_, sk-, sk-ant-, AKIA, bearer-in-header).

6. **Byte budgets + chunk-budget-exceeded path**
   - What: Each chunk write inside the daemon increments `ctx.bytesWritten`. If the write would exceed `ctx.byteBudgetBytes`, the writer emits a single `subagent_progress { kind: "chunk-budget-exceeded" }` (only once per run), sets `ctx.byteBudgetExceeded = true`, rewrites `meta.json.byte_budget_exceeded = true` atomically, and silently drops further chunks. Lifecycle, progress (other kinds), heartbeat, and end events keep flowing.

7. **Rotation**
   - What: Before each event write, the daemon's writer checks tracked-in-memory file size. If `> OBSERVABILITY_MAX_FILE_BYTES` (default 100 MB), it closes the current fd, opens `events-{NNNN+1}.jsonl`, and continues. Rotation is serialized through the writer queue so it cannot interleave a flush.
   - `meta.json` is NOT updated on rotation; the tailer discovers rotated files via filesystem scan.

8. **Heartbeats — timer-stop is strictly a timer cancel; lifecycle calls own termination**
   - What: Two distinct timer surfaces, both with the same `{stop}` contract.
     - **`startHeartbeat(ctx, sa)`** runs in the **caller's** process. It schedules an `emit_subagent_heartbeat` op (over UDS) every 30 s (configurable via `OBSERVABILITY_SUBAGENT_HEARTBEAT_S`). The returned `{stop}`'s `stop()` ONLY clears the interval. It does NOT call `endSubAgent`, does NOT emit `subagent_end`. The dispatcher is required to call `endSubAgent(ctx, sa, …)` first, then `saHb.stop()`.
     - **`startRunHeartbeat(ctx)`** is a thin client-side handle whose body is intentionally minimal. For owned runs (where `startRun` spawned the daemon in this process), the **daemon** schedules its own run-heartbeat timer every 10 s (configurable via `OBSERVABILITY_RUN_HEARTBEAT_S`) and that timer writes `run_heartbeat` JSONL records carrying `parent_pid` (the tracked-parent pid, NOT the daemon pid), `host_boot_id`, `bytes_written`, and `writer_daemon_pid`. The `{stop}` returned by the dispatcher's `startRunHeartbeat(ctx)` call ONLY clears any client-side bookkeeping (a no-op in the current implementation — the daemon owns the actual timer). It does NOT call `endRun`, does NOT signal the daemon to terminate. The dispatcher is required to call `endRun(ctx, …)` first (which internally tells the daemon to stop the run-heartbeat timer, flush, and exit), then `runHb?.stop()` as a defensive no-op.
   - **Heartbeat ownership rule (binding for Phase 6):** the dispatcher calls `startHeartbeat` immediately after `startSubAgent` and `saHb.stop()` immediately AFTER `endSubAgent`. The dispatcher calls `startRunHeartbeat` immediately after `startRun` and `runHb?.stop()` immediately AFTER `endRun`. `runProcess` is FORBIDDEN from calling any of these. This is the single ownership rule that disambiguates lifecycle responsibility.
   - **Connected (child) dispatchers** (where `connectRun` returns the `RunCtx` because `STARK_OBS_PARENT_RUN_ID` is set) DO NOT call `startRunHeartbeat` — the parent daemon already runs the timer. The child's `RunCtx` has a `_isOwned: false` flag, and `startRunHeartbeat` on a non-owned ctx returns a no-op `{stop: () => {}}`. Unit-tested.

9. **Disabled-state semantics**
   - What: One-shot startup self-test in `startRun`: if `mkdir` or daemon-spawn or write check fails, set process-local `__obs_disabled = { reason }`, log ONCE to stderr (`[observability] DISABLED — reason: <…>`). Subsequent `startRun`/`connectRun`/`emitProgress`/`attachChild`/`startHeartbeat`/`startRunHeartbeat`/`endSubAgent`/`endRun` are no-ops returning stub `RunCtx`/`SubAgent` objects so the dispatcher's call sites can run unchanged. `meta.json.emit_status` records `"disabled"` and `emit_disabled_reason` when partial init occurred.
   - Also honors `OBSERVABILITY_DISABLED=1` env (the operator kill-switch from Section 6 Rollback).

### Risks

- **`Buffer.isUtf8` requires Node ≥ 20.6** — Node 22 base image is fine.
- **Race between `startRun` returning and the daemon binding `writer.sock`** — addressed by the Task 3 readiness handshake: `startRun` polls `ping` every 25 ms until the daemon replies `{ready:true, run_start_committed:true, run_heartbeat_committed:true}`, bounded at 5 s; first client ops cannot race the socket because `startRun` has not yet returned the `RunCtx`.
- **Listener back-pressure** — adding a `'data'` listener doesn't switch flowing mode if a consumer already attached. The unit test in Task 4 codifies the no-consume requirement.
- **`startRun` returning before the daemon is ready** — addressed by the startup readiness handshake in Task 3: `startRun` polls `ping` and does not return until the daemon has bound `writer.sock`, written `writer.pid`, and fsynced both the initial `run_start` AND initial `run_heartbeat`. The 5 s bound prevents indefinite hangs on broken setups.
- **Redaction over-matching** breaks valid log content → unit-test corpus covers benign matches; `OBSERVABILITY_REDACT_DISABLE_PATTERNS` env var (CSV of pattern names) is the per-install override.
- **Daemon-process leakage** — handled by the daemon's `kill(tracked_parent_pid, 0)` poll (Task 3), which on ESRCH writes the canonical crashed `run_end` and exits. Belt-and-suspenders with the Phase 4 liveness sweeper.
- **64 KiB UDS request cap vs chunk size** — addressed by serialized-request-size splitting in Task 4 (raw Buffer slices capped well below the base64-expanded + JSON-envelope size); a chunk that fits inside 64 KiB raw but blows the cap once encoded would otherwise be rejected and lost.

### Verification

- `npm test -- observability_emit_lib` passes.
- Synthetic harness: `tools/observability_emit_harness.ts` spawns 5 sub-agents emitting random output for 60 s; inspect `events-0001.jsonl` for strictly monotonic `seq`, no torn lines, rotation if forced (`OBSERVABILITY_MAX_FILE_BYTES=1048576`); redaction of planted `ghp_*` token confirmed.
- **Cross-process emit test:** `node --experimental-strip-types tools/observability_emit_harness.ts --multi-process` starts a run in process A, spawns process B that calls `connectRun(runId)` and emits a sub-agent end-to-end while process A is still emitting. Inspect the spool to confirm both processes' events appear with strictly monotonic global `seq`. Kill process A (the tracked parent); confirm the daemon writes `run_end` with `status: "crashed", crashed_reason: "parent_exit"` within 60 s and exits. Confirm the `run_end` event's `ts` and the resulting `meta.json.ended_at` are both ISO-8601 millisecond-precision strings (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`).
- **Stop-is-a-timer-cancel test:** call `startRunHeartbeat(ctx)`, grab `runHb`, sleep 30 s, call `runHb.stop()` WITHOUT calling `endRun`. Assert: (a) no `run_end` JSONL record is written, (b) the daemon is still running and still writing `run_heartbeat` records (the daemon's internal timer is independent of the client `{stop}`), (c) `meta.json.ended_at` is still null. Then call `endRun(ctx, "ok")`; assert the `run_end` record is written exactly once.
- Run with `chmod 000 ~/.claude/code-review/observability/runs` → exactly one stderr line, no crash, dispatcher harness exits 0.
- Disable kill-switch: `OBSERVABILITY_DISABLED=1 node --experimental-strip-types tools/observability_emit_harness.ts` → no `events-*.jsonl` created, no daemon spawned, harness exits 0.

## Phase 3: Tailer + universal event index + chunk_truncated handling

**Goal:** Container reads JSONL spool files, parses every event type (including `chunk_truncated`), upserts SQLite tables idempotently, indexes every record via `event_offsets`, persists offsets, handles rotation + restart + **in-place file rewrites by Phase 7 prune**. No HTTP/WebSocket yet — verified via direct SQLite queries.
**Dependencies:** Phase 1, Phase 2 (Phase 2 generates test fixtures).
**Estimated effort:** L.

### Tasks

1. **Tailer**
   - What: `tools/observability_server/server/tailer.ts`. `chokidar.watch('/spool/runs', { depth: 2, awaitWriteFinish: false })` (matches the Phase 1 mount `~/.claude/code-review/observability/runs:/spool/runs:ro`; depth 2 covers `<runId>/events-NNNN.jsonl`).
     - `add` → open RO, register in in-memory file table.
     - `change` → check `mtime_ns` against `spool_files.mtime_ns`. If the new mtime is **earlier** or the file is **smaller than the previously-seen size**, treat as in-place rewrite (Phase 7 prune): the per-file index state will have already been cleared via the server's `POST /api/internal/retention/notify` `action: "pre-rename"` call (Task 4 below); read from offset 0 and re-insert. If neither condition is true, seek to persisted `tail_offsets.offset`, read forward into a 256-KB buffer, hold any partial trailing line, emit each complete line as a parsed JSON event to the event bus along with its `(file_path, byte_start, byte_end)` range.
     - `unlink` → mark file deleted in `spool_files` (set `deleted_at = new Date().toISOString()` bound from TS, no `strftime`).
   - Malformed JSON: increment `tailer_parse_errors_total`, push `{ts, source: "tailer", message, file, line_no}` to `/api/health.errors[]`, skip the line.
   - Backup 10-second sweeper: `readdir + stat` pass to catch anything chokidar missed on macOS; reconciles `spool_files` snapshot.
   - Files: `server/tailer.ts`, `server/event_bus.ts` (typed `EventEmitter`).

2. **Index writer — every event type, including `chunk_truncated`**
   - What: `server/index_writer.ts` subscribes to the event bus. `better-sqlite3` prepared statements. UPSERT per event type:
     - `run_start` → `INSERT OR IGNORE INTO runs`; insert `event_offsets`.
     - `subagent_start` → `INSERT OR IGNORE INTO subagents`; increment `runs.total_subagents`; insert `event_offsets`.
     - `subagent_stdout` / `subagent_stderr` → UPDATE `subagents.{stdout_bytes|stderr_bytes}`, `last_output_at`, `runs.last_seq`; INSERT INTO `chunk_offsets` AND `event_offsets`.
     - `subagent_progress` → INSERT INTO `progress_events` AND `event_offsets`; if `kind == "finding"` increment `subagents.finding_count` and `runs.total_findings`.
     - `subagent_heartbeat` → UPDATE `subagents.last_output_at`; insert `event_offsets`.
     - `subagent_end` → UPDATE subagents row with `status`, `duration_ms`, `summary_json`, and `ended_at = <event.ts>` (the daemon-written ISO timestamp from Phase 2 Task 3 — already canonical millisecond precision); insert `event_offsets`.
     - `run_heartbeat` → UPDATE `runs.last_heartbeat_at = <event.ts>`, `runs.bytes_written`, `runs.parent_pid` (the tracked-parent pid carried in the event), `runs.host_boot_id`, `runs.writer_daemon_pid` (diagnostic only); insert `event_offsets`.
     - `run_end` → UPDATE `runs.ended_at = <event.ts>`, `runs.status`. If the event carries `crashed_reason` (i.e., the daemon wrote it on parent-loss), also UPDATE `runs.crashed_reason`. Insert `event_offsets`.
     - **`chunk_truncated`** → `INSERT OR REPLACE INTO chunk_truncations(run_id, subagent_id, seq, ts, bytes_dropped, stream)` (seq IS the original chunk's seq, preserved by Phase 7's in-place rewrite); `DELETE FROM chunk_offsets WHERE run_id = ? AND seq = ?`; insert/replace into `event_offsets`; UPDATE `subagents.{stdout_bytes|stderr_bytes} = MAX(0, current - bytes_dropped)`. All five statements wrap in a single transaction.
   - **Idempotency rule for replays** (server restart OR Phase 7 pre-rename `tail_offsets.offset = 0` reset followed by `rename(2)` re-read from offset 0): every event-application step inserts `event_offsets` FIRST via `INSERT OR IGNORE INTO event_offsets (run_id, seq, ...) VALUES (...)`; downstream UPSERTs into `runs`/`subagents`/`progress_events`/`chunk_offsets`/`chunk_truncations` AND every aggregate-counter mutation (`runs.total_subagents += 1`, `subagents.{stdout_bytes|stderr_bytes} += chunk_size`, `subagents.finding_count += 1`, `runs.total_findings += 1`, AND the `chunk_truncated` handler's `subagents.{stdout_bytes|stderr_bytes} -= bytes_dropped` decrement) execute ONLY when `db.prepare(INSERT OR IGNORE event_offsets).run(...).changes === 1` for that `(run_id, seq)`. On a replay where the seq is already indexed, the changes-count is 0, all side effects are skipped, and the row UPSERTs are idempotent on `(run_id, seq)`. This guarantees that re-reading any file from offset 0 never double-counts subagents, findings, or bytes — and in particular fixes the Phase 7-induced replay path where the rewritten file's pre-existing `subagent_start` / `subagent_progress` / `subagent_end` lines would otherwise re-trigger aggregate-counter mutations on every prune cycle.
   - After each event, UPDATE `tail_offsets` with the new byte offset.
   - Batching: wrap up to 50 events or 100 ms (whichever first) in a single `BEGIN/COMMIT`.

3. **Universal event-offset indexing**
   - What: For EVERY event the tailer emits, the index writer inserts (`INSERT OR REPLACE` so that rewrites land cleanly) one row into `event_offsets` with `(run_id, seq, ts, type, subagent_id?, rotation_index, byte_start, byte_end)`. This is what powers the WebSocket lifecycle backfill.

4. **Internal retention-notify endpoint — canonical two-step schema**
   - What: Add an authenticated **loopback-only + Bearer-token-required** route `POST /api/internal/retention/notify` on the server. The body has a discriminator `action` field and two valid shapes. **This is the one canonical schema for the entire stack** — Phase 7's prune CLI sends exactly these bodies, no others.

     **Pre-rename body** (called BEFORE the prune CLI's `rename(2)`; no `new_mtime_ns` field):
     ```json
     {
       "action": "pre-rename",
       "run_id": "<runId>",
       "rotation_index": <N>,
       "file_path": "/spool/runs/<runId>/events-<NNNN>.jsonl",
       "new_size_bytes": <int — size of the .tmp file after rewrite>,
       "truncated": [
         { "seq": <int>, "subagent_id": "<rid>:<k>", "stream": "stdout", "bytes_dropped": <int> },
         { "seq": <int>, "subagent_id": "<rid>:<k>", "stream": "stderr", "bytes_dropped": <int> }
       ]
     }
     ```

     **Update-mtime body** (called AFTER the rename, once the new mtime is `fstat`-able; carries only the mtime + identifying keys):
     ```json
     {
       "action": "update-mtime",
       "run_id": "<runId>",
       "rotation_index": <N>,
       "file_path": "/spool/runs/<runId>/events-<NNNN>.jsonl",
       "new_mtime_ns": <int>
     }
     ```

   - **Server behavior on `action: "pre-rename"`:**
     1. Validate Bearer token against `/data/token`.
     2. Validate source IP is loopback.
     3. Validate the body matches the pre-rename schema (zod): `action == "pre-rename"`, `truncated` is a non-empty array, every element has the four required fields, no `new_mtime_ns` at top level.
     4. Inside a single `BEGIN/COMMIT`:
        - For each row in `truncated`: `DELETE FROM chunk_offsets WHERE run_id = ? AND seq = ?` AND `DELETE FROM event_offsets WHERE run_id = ? AND seq = ?` (the tailer will re-insert both kinds of rows once it re-reads the file).
        - **Do NOT mutate `subagents.{stdout_bytes|stderr_bytes}` in this call.** Byte-counter ownership belongs EXCLUSIVELY to the `chunk_truncated` event handler in Task 2, which decrements counters when the tailer replays the rewritten file. Decrementing here AND in the replay would double-subtract and produce undercounted output bytes for every pressure rewrite.
        - `UPDATE spool_files SET size_bytes = new_size_bytes, deleted_at = NULL WHERE run_id = ? AND rotation_index = ?` (do NOT touch `mtime_ns` here — that's the next call's job).
        - `UPDATE tail_offsets SET offset = 0 WHERE file_path = ?` (do NOT touch `mtime_ns` here either).
     5. Returns `{ "ok": true, "cleared": <count of truncated rows>, "action": "pre-rename" }`.

   - **Server behavior on `action: "update-mtime"`:**
     1. Validate Bearer token + loopback as above.
     2. Validate body matches update-mtime schema.
     3. Inside a single `BEGIN/COMMIT`:
        - `UPDATE spool_files SET mtime_ns = new_mtime_ns WHERE run_id = ? AND rotation_index = ?`
        - `UPDATE tail_offsets SET mtime_ns = new_mtime_ns WHERE file_path = ?`
     4. Returns `{ "ok": true, "action": "update-mtime" }`.

   - The chokidar `change` event fired by the prune's `rename(2)` triggers the tailer to re-read the rewritten file from offset 0 and re-insert `chunk_truncated` rows + their `event_offsets` rows. The `update-mtime` call patches up `spool_files.mtime_ns` and `tail_offsets.mtime_ns` after the fact so the tailer's "in-place rewrite" detection (mtime regression or size shrink) doesn't spuriously fire on the next legitimate append (there will never be one for a terminal run, but defensive).
   - Files: `server/http_api.ts` (route stub in this phase with a "trusted-loopback-only" check; full auth middleware applied in Phase 4). Zod schemas for both bodies live in `server/retention_notify_schemas.ts`.

5. **Restart correctness**
   - What: On startup, server scans `/spool/runs/*/events-*.jsonl`, joins against `tail_offsets`, resumes from each persisted offset. Files seen for the first time start at offset 0.
   - Test: stop container mid-run, restart, assert no duplicates, no skips, `runs.last_seq` matches the final emitted event's seq.

6. **Rotation handling**
   - What: When tailer reaches EOF on `events-0001.jsonl` and `events-0002.jsonl` exists in the same dir, it opens 0002 and continues. `spool_files` row inserted for 0002 on first read.

7. **`chunk_truncated` live-stream semantics**
   - What: When the tailer emits a `chunk_truncated` event:
     - Index writer records it per Task 2 (single transaction).
     - Event bus broadcasts a `truncation` event so any live WS subscriber for that subagent receives `{type: "event", event: {type: "chunk_truncated", ...}}` in real time.
     - The chunk SSE endpoint (Phase 4) sees the truncation row in `chunk_truncations` (the corresponding `chunk_offsets` row is gone) and emits `event: gap`.

### Risks

- **chokidar on macOS** can miss events under heavy churn — backup sweeper (Task 1) covers it.
- **SQLite write contention** — WAL + single in-process writer + 50-event batches keeps commit p95 < 50 ms (verified Phase 8).
- **Race between `pre-rename` notify and tailer read** — if the tailer is mid-read on a file when the notify endpoint resets `tail_offsets.offset = 0`, the read continues at the old offset for that pass and only honors the reset on the next `change` event. Mitigated because the prune CLI performs the `rename(2)` AFTER the notify returns 200 — the rename guarantees a fresh `change` event from chokidar that the tailer will see, and it will then read from offset 0.

### Verification

- Generate 10 runs × 27 sub-agents × 1000 events with Phase 2 harness, container off. Start container. Assert all events appear; every row has a matching `event_offsets` row; row counts in `runs`/`subagents`/`progress_events`/`chunk_offsets`/`event_offsets` match expected.
- Force kill `-9` the container mid-replay; restart; assert no duplicate rows, `runs.last_seq` advances correctly.
- Force a 100 MB rotation; assert the tailer follows into `events-0002.jsonl` without resync.
- **In-place rewrite test:** with the Phase 2 harness, produce a run with 100 chunk events. Hand-rewrite the file by replacing the middle 50 lines with `chunk_truncated` records (same `seq` values, new `bytes_dropped`). POST `pre-rename` with the canonical schema (50 entries in `truncated[]`, each with `{seq, subagent_id, stream, bytes_dropped}`); assert 200 with `cleared: 50`. `rename(2)` the rewritten file over the original. `fstat` the renamed file for its new mtime. POST `update-mtime` with `{run_id, rotation_index, file_path, new_mtime_ns}`; assert 200. Within 10 s, assert `chunk_offsets` has 50 rows (was 100), `chunk_truncations` has 50 rows with matching seqs, `event_offsets` has 100 rows with the middle 50 pointing into the rewritten file's new byte ranges, `subagents.stdout_bytes` has been reduced by the dropped total, and `spool_files.mtime_ns == new_mtime_ns`.
- **Schema rejection test:** POST a pre-rename body containing `new_mtime_ns` → 400 with zod error. POST an update-mtime body containing a `truncated` array → 400. POST a pre-rename body where one `truncated[]` entry is missing `bytes_dropped` → 400.
- **Timestamp shape test:** after a daemon-written `run_end` lands, run `SELECT ended_at FROM runs WHERE run_id = ?` and assert the result matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`. Repeat for `subagents.ended_at`.

## Phase 4: HTTP API + WebSocket + liveness + auth

**Goal:** Full server surface from the design implemented behind bootstrap-code session auth. WebSocket backfill replays EVERY event type via `event_offsets`. **Liveness sweeper sets both `status='crashed'` AND `ended_at=<TS-bound ISO timestamp>` on synthetic crashes so the next tick filters those rows out idempotently. The terminal-status filter is shared with the daemon-written crashed path so there is exactly one writer per failure mode. All server-written timestamps come from TypeScript `new Date().toISOString()`, never SQLite `strftime`.** Verifiable via `curl` + `wscat` + a CLI harness, all using the cookie file produced by the helper or a Bearer token read from the macOS Keychain — never via helper stdout.
**Dependencies:** Phase 3.
**Estimated effort:** L.

### Tasks

1. **Auth subsystem**
   - What: `server/auth.ts`. Surfaces:
     - `POST /api/auth/bootstrap` — body `{ token }`. Validates against `/data/token` (constant-time compare via `crypto.timingSafeEqual`). On success, generates a 60-second one-time bootstrap code (32 random bytes, base64url) stored in in-memory `Map<code, expires_at>`, returns `{ code }`. **Does NOT write `/data/last_bootstrap_at`** — only a successful `exchange` call below writes that marker, so a bootstrap attempt that never completes the cookie-exchange flow cannot retroactively authorize a LAN bind.
     - `POST /api/auth/exchange` — body `{ code }`. Validates and **consumes** the code (single-use). Generates a 32-byte session id with 24 h TTL. Sets `obs_session` cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400` (plus `Secure` whenever `OBSERVABILITY_PUBLISHED_HOST` is non-loopback per Phase 1 Task 3 contract; on a non-TLS LAN request — i.e. `X-Forwarded-Proto` absent/not `https` AND `OBSERVABILITY_TLS_TERMINATED` unset — the server refuses to set the cookie and returns 400 with a recovery instruction pointing at the mkcert reverse-proxy setup in the Phase 8 docs task). **Atomically writes `/data/last_bootstrap_at` containing `new Date().toISOString()` — this is the SOLE writer of the marker that authorizes future LAN binds per Phase 1 Task 3.** Returns 204.
     - Middleware: every endpoint except `GET /api/health/probe` and `POST /api/auth/bootstrap` requires either a valid `obs_session` cookie OR `Authorization: Bearer <token>`. The `POST /api/internal/retention/notify` route (Phase 3 Task 4) is upgraded to use this Bearer check via the middleware. **Loopback enforcement does NOT rely on `req.socket.remoteAddress`** — Docker's userland proxy substitutes the gateway address (`192.168.65.1`, `172.x`, etc.), which would falsely fail a literal `127.0.0.1` check on every legitimate host call and brick the loopback bootstrap path. Loopback is enforced instead by (a) the docker-compose host-side bind (`OBSERVABILITY_PUBLISHED_HOST=127.0.0.1:7700` by default, validated at boot per Phase 1 Task 3) AND (b) per-request `Host` and `Origin` header checks: the server accepts only `Host` values matching `OBSERVABILITY_PUBLISHED_HOST` and `Origin` values matching `http://<host>` (or `https://<host>` in TLS-terminated LAN mode). In LAN mode (`OBSERVABILITY_PUBLISHED_HOST` non-loopback AND `OBSERVABILITY_ALLOW_LAN=1` AND `/data/last_bootstrap_at` exists AND `OBSERVABILITY_TLS_TERMINATED=1`), requests carrying the LAN host header are accepted; the `obs_session` cookie carries `Secure`, WebSocket connections MUST use `wss://`, and plain `http://`/`ws://` requests off-loopback are rejected with 400.
   - Origin/Host check on every request: rejects `Origin` headers that aren't `http://localhost:7700` / `http://127.0.0.1:7700` (or the LAN address explicitly enabled via override); rejects `Host` headers outside the same set.
   - Files: `server/auth.ts`, `server/middleware.ts`.

2. **HTTP API endpoints + scripted-auth contract (no helper-stdout token leak)**
   - What: Implement every endpoint in §7 with Fastify + zod schemas:
     - `GET /api/runs` — cursor pagination via base64-encoded `(started_at, run_id)` tuple.
     - `GET /api/runs/:run_id`
     - `GET /api/runs/:run_id/subagents/:subagent_id`
     - `GET /api/runs/:run_id/subagents/:subagent_id/chunks` — SSE. Reads `chunk_offsets` rows in `seq` order; for each, `pread`s the byte range from the spool file (RO fd cached per `run_id` in an LRU of 64). Emits `event: chunk` per record. For any `seq` present in `chunk_truncations` but absent from `chunk_offsets`, emits `event: gap` with `data: {"reason":"retention_gap","seq":N,"bytes_dropped":M,"stream":"stdout"}`. On `to_seq` omitted → switches to live tail. Terminator `event: end`.
     - `GET /api/health` — full shape from §7.
     - `GET /api/health/probe` — unauthenticated `{ ok: true }`.
     - `POST /api/internal/retention/notify` — canonical two-action schema from Phase 3 Task 4; auth middleware applied here.
   - Rate limits via `@fastify/rate-limit`. SSE concurrent-stream cap enforced via in-memory counter per session/token.
   - Files: `server/http_api.ts`, `server/sse_chunks.ts`.

   - **Scripted auth — token never echoed by the helper.** The helper writes (a) the session cookie to a 0600 file and (b) the token to the macOS Keychain. Scripts pick whichever surface fits their needs. Verbatim, working example:
     ```bash
     # One-time setup: helper runs, writes cookie file + populates Keychain.
     # NEVER prints the token. --no-browser is the headless variant; the default
     # behavior also opens the browser but writes the same cookie file.
     node --experimental-strip-types tools/observability_open.ts --no-browser

     COOKIE_FILE="$HOME/.claude/code-review/observability/session.cookie"

     # Cookie-based auth — preferred for any browser-shaped client (curl with -b is fine):
     curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/runs?limit=10

     # Bearer auth for clients that cannot use cookies (e.g., the Phase 7 prune CLI).
     # The token is read DIRECTLY from the macOS Keychain via the OS `security` CLI.
     # This is an operator-owned OS surface for revealing a secret; it is distinct
     # from the helper's stdout, which never carries the token in any flag or path.
     TOKEN=$(security find-generic-password -s stark-observability-token -w)
     curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7700/api/runs?limit=10
     unset TOKEN
     ```
     The acceptance assertion for this task is that `grep -RIn "print-token" tools/ scripts/ skill/` returns zero matches — no helper flag, no script, no SKILL.md ever requests the helper to echo a token.

3. **WebSocket hub — backfill via `event_offsets` (lifecycle-complete)**
   - What: `server/websocket_hub.ts`. `ws` server attached to the Fastify HTTP server at `/ws`. Upgrade handler validates the `obs_session` cookie (or Bearer header) BEFORE accepting; failure returns HTTP 401 during the handshake.
   - On `subscribe` with `from_seq`: backfill is sourced **exclusively from `event_offsets`** so every event type replays verbatim. Standard `pread` + JSON parse + push as `{type:"event", sub_id, event:<parsed>}`. On missing spool file, emit `{type:"error", code:"retention_gap"}`.
   - Filters: `run_id`, `subagent_id`, `repo`, `live`, `event_types[]`.
   - Heartbeat: server `{type:"ping"}` every 25 s; client `{type:"pong"}` within 10 s; otherwise close `4002 stale`.
   - Max 4 concurrent connections per session/token.

4. **Liveness sweeper — hostinfo only, idempotent terminal transitions, one writer per failure mode, TS-bound timestamps**
   - What: `server/liveness.ts`. 30-second tick. Every UPDATE that writes `ended_at` binds a single TS-computed ISO timestamp via parameter — no `strftime`, no `datetime('now')` in any SET clause. **WHERE-clause cutoffs are ALSO bound from TypeScript** via `new Date(Date.now() - <ms>).toISOString()` and compared as plain text against the stored ISO-8601-ms strings. `datetime('now', …)` is forbidden in WHERE clauses for the same reason it's forbidden in SET clauses: `last_heartbeat_at` is stored as `YYYY-MM-DDTHH:MM:SS.sssZ` while SQLite's `datetime('now', '-60 seconds')` renders as `YYYY-MM-DD HH:MM:SS`, and on the same date the literal `T` lex-sorts greater than the literal space — an actually-stale ISO row would silently fail to match the SQLite-rendered cutoff. No SQLite-native time function appears in any WHERE clause in this file; the Phase 8 grep assertion `grep -RIn "datetime('now'\|strftime" tools/observability_server/server/liveness.ts` must return zero matches.
     1. Read `/hostinfo/host.json`. If file missing or older than 60 s → flag `health.status: "degraded"` with `liveness_blind: true`, skip transitions this tick.
     2. Compare `host_boot_id` against the previous tick's snapshot. If changed → for every run matching `status NOT IN ('crashed','ok','error','timeout')`, run a single transaction. TypeScript:
        ```ts
        const endedAt = new Date().toISOString(); // canonical "2026-05-25T13:42:11.123Z"
        const tx = db.transaction((endedAt: string, runIds: string[]) => {
          const runsStmt = db.prepare(`
            UPDATE runs
               SET status = 'crashed',
                   crashed_reason = 'host_boot_changed',
                   ended_at = ?
             WHERE run_id IN (${runIds.map(() => '?').join(',')})
               AND status NOT IN ('crashed','ok','error','timeout')
          `);
          runsStmt.run(endedAt, ...runIds);
          const subagentsStmt = db.prepare(`
            UPDATE subagents
               SET status = 'crashed',
                   ended_at = ?
             WHERE run_id IN (${runIds.map(() => '?').join(',')})
               AND status NOT IN ('crashed','ok','error','timeout')
          `);
          subagentsStmt.run(endedAt, ...runIds);
        });
        tx(endedAt, affectedRunIds);
        ```
        Setting `ended_at` AND filtering by `status NOT IN (terminal)` is the belt-and-suspenders fix that prevents the same row from being re-marked crashed on every subsequent tick. The TS-computed `endedAt` matches the exact ISO-8601 millisecond format used by `run_end` JSONL events and by `subagent_end` JSONL events, so the API never returns mixed timestamp shapes.
     3. Compute host-uptime delta vs wall-clock delta since previous tick; if host uptime advanced by ≥ 60 s less than wall-clock → skip transitions this tick (laptop slept / resumed).
     4. `SELECT run_id, parent_pid FROM runs WHERE status NOT IN ('crashed','ok','error','timeout') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)` where the cutoff is bound from TS via `new Date(Date.now() - 60_000).toISOString()`. `last_heartbeat_at` is stored as the canonical millisecond ISO-8601 string (`YYYY-MM-DDTHH:MM:SS.sssZ`); SQLite's `datetime('now','-60 seconds')` would render as `'YYYY-MM-DD HH:MM:SS'` and lex-compare incorrectly (the literal `T` in the stored value sorts greater than the literal space in the SQLite-rendered cutoff on the same date, masking actually stale rows). The `IS NULL` branch covers the rare race where the daemon was SIGKILLed before the Phase 2 Task 3 initial-heartbeat handshake landed an indexed row (the daemon's readiness barrier writes one immediately, so this branch is a defense-in-depth case rather than the normal path). For each row: if `parent_pid NOT IN host.live_pids[]` → run the same transaction-with-TS-bound-`endedAt` pattern as step 2, with `crashed_reason: 'parent_exit'`, scoped to the single run. Else flag in `/api/health.errors[]`, no state change.
        - **`runs.parent_pid` here is the tracked-parent pid written by the daemon into every `run_heartbeat`** (= the dispatcher Node process pid for normal dispatchers; the SKILL.md shell pid for phase-execute). This is the same pid `live_pids[]` would contain if the tracked parent were still alive.
        - **Single-writer property:** the daemon's own parent-loss path (Phase 2 Task 3) also writes `status: "crashed", crashed_reason: "parent_exit"` with its own TS-bound `ended_at`. When that happens first (daemon still alive, only the tracked parent died), the row already matches the terminal-status filter when the sweeper runs; the sweeper's `WHERE status NOT IN (...)` clause is what guarantees no double-write. There is exactly one writer per failure mode: the daemon when it lives long enough to see ESRCH, the sweeper when it doesn't.
     5. Orphan sweep (separate 5-minute tick): `SELECT run_id FROM runs WHERE status NOT IN ('crashed','ok','error','timeout') AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?)` where the cutoff is bound from TS via `new Date(Date.now() - 1_800_000).toISOString()` for the same ISO-8601 vs `datetime('now',...)` format-mismatch reason as step 4 → same TS-bound transaction with `crashed_reason: 'orphan_timeout'`.
   - All three crashed paths (daemon-written `parent_exit`, sweeper-written `parent_exit`, sweeper-written `host_boot_changed`, sweeper-written `orphan_timeout`) write to SQLite only; the spool is read-only for the container.
   - **Idempotency assertion in tests:** after any crashed transition, running the sweeper 10 more times in a row must produce zero additional UPDATE statements (verified by counting `runs.changes()` between ticks).
   - **Timestamp-shape assertion in tests:** after a sweeper-written crashed transition, `SELECT ended_at FROM runs WHERE run_id = ?` must match `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`. The fail case the wing flagged (`...:12.12.345Z` from `strftime`) is impossible because no UPDATE in this file uses `strftime` for an `ended_at` SET — all are TS-bound parameters.

5. **State-only retention sweep**
   - What: `server/retention.ts`. Hourly tick. `readdir` of `/spool/runs/`. For any `run_id` in `runs` table whose spool directory is gone → `DELETE FROM runs WHERE run_id = ?` (cascades to all child tables). Update `/api/health.retention.files_deleted_total`.

6. **CSP + security headers**
   - What: Middleware adds CSP from §9 to UI responses; HSTS omitted (loopback); no `Access-Control-Allow-Origin`; `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`.

### Risks

- **Bootstrap-code phishing** via `?b=...` in an iframe → CSP `frame-ancestors 'none'` + UI checks `window.top === window` and refuses to call `/api/auth/exchange` otherwise.
- **`event_offsets` storage cost** — ~648 MB at design load. Acceptable on a Mac SSD; verified in Phase 8.
- **Sweeper depends on heartbeat-populated `runs.parent_pid` + `last_heartbeat_at` that may not exist yet** — eliminated by the Phase 2 Task 3 startup readiness handshake, which fsyncs an initial `run_heartbeat` before `startRun` returns. The Phase 4 sweeper's step-4 SELECT now also covers `last_heartbeat_at IS NULL` for runs with a non-null tracked parent (defense-in-depth for the rare race where the daemon was SIGKILLed before the readiness heartbeat reached the index).
- **Daemon-vs-sweeper race for the same crashed transition** — eliminated by the terminal-status filter: whichever writer gets there first wins; the other is a no-op.
- **Mixed timestamp shapes between daemon-written and sweeper-written rows** — eliminated by both writers using `new Date().toISOString()` and binding as a parameter; no `strftime` in any `SET ended_at = ...` clause anywhere in the codebase. Enforced by a grep-based unit assertion (`grep -RIn "ended_at.*strftime" tools/ scripts/ tools/observability_server/` returns zero matches).

### Verification

- `curl` script exercises every endpoint with valid + invalid auth using the cookie-file flow above; assert 200 / 401 / 403 / 404 / 410 / 429 / 400 per spec.
- `wscat` subscribe with `from_seq: 1`: every event type received in `seq` order verbatim. (`wscat` is invoked with `-H "Cookie: $(awk '/obs_session/{print "obs_session="$NF}' $COOKIE_FILE)"` so the session cookie travels on the upgrade.)
- **Dispatcher-kill while daemon stays alive (daemon-written crashed):** spawn a synthetic dispatcher (Phase 2 harness) → `kill -9 <dispatcher_pid>` → within 60 s the daemon writes `run_end` with `status: "crashed", crashed_reason: "parent_exit"` and exits → `runs.status = 'crashed'`, `runs.crashed_reason = 'parent_exit'`, `runs.ended_at` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` → run the sweeper 20 more times, assert zero additional UPDATEs against the same run.
- **Daemon + dispatcher both killed (sweeper-written crashed):** synthetic dispatcher → `kill -9 <dispatcher_pid>` AND `kill -9 <daemon_pid>` → within 90 s the sweeper writes `runs.status = 'crashed'`, `crashed_reason = 'parent_exit'`, `ended_at` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` → run the sweeper 20 more times, assert zero additional UPDATEs.
- Simulate `host_boot_id` change in `host.json` → inflight runs transition to `crashed_reason: host_boot_changed`, `ended_at` matches the ISO-8601 ms format, no re-transition.
- Inject a `chunk_truncations` row with a deleted `chunk_offsets` row → chunk SSE emits `event: gap`; WebSocket backfill emits `{type:"error",code:"retention_gap"}`.
- **No-print-token assertion:** `grep -RIn "print-token" tools/ scripts/ skill/ tools/observability_server/` exits 1 (zero matches). Run on every CI pass for this phase forward.

## Phase 5: UI

**Goal:** React/Vite app served from the container, satisfies all §9 a11y + visual + keyboard requirements, hits the < 2 s sub-agent-select-to-first-byte target, renders `chunk_truncated` as inline gap markers.
**Dependencies:** Phase 4.
**Estimated effort:** L.

### Tasks

1. **Build + serve**
   - What: `ui/` Vite project. Production build → `ui/dist/`; Node server serves it via `@fastify/static` at `/`. CSP header per §9.
   - Files: `tools/observability_server/ui/package.json`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`.

2. **Bootstrap-code exchange on load**
   - What: `index.html` includes a tiny bundled module that reads `?b=<code>` from `location`, calls `history.replaceState(null, "", location.pathname)` to strip, POSTs to `/api/auth/exchange`. On 204 → mount the app. On failure → render "run `node --experimental-strip-types tools/observability_open.ts`" instructional page. Refuses to exchange if `window.top !== window`.

3. **Tree (left rail)**
   - What: Native `<ul role="tree">` with `<li role="treeitem">`. Keyboard model per §9. Data: TanStack Query against `GET /api/runs?status=running` (refetch 5 s) plus `GET /api/runs?limit=50` for history. Aggregated client-side into repo → branch → PR → run → sub-agent.
   - Pulse indicator on currently-emitting sub-agents (driven by WebSocket subscription with `live: true`).
   - `prefers-reduced-motion` falls back to a static dot.

4. **Detail pane**
   - What: Conditional rendering:
     - Run selected → sortable `<table>` with `aria-sort`; columns per §9.
     - Sub-agent selected → log viewer (live tail via WebSocket subscribe with `subagent_id` + `from_seq = lastSeenSeq`, ANSI-sanitized via `ansi-to-html` with strict allowlist, virtualized via `@tanstack/react-virtual`). Collapsible stderr `<details>`. Findings list from `progress_events` with `kind == "finding"`.
   - **`chunk_truncated` rendering:** when the WS or chunk SSE delivers a `chunk_truncated` record (or `event: gap`), the log viewer inserts an inline `<div role="separator" aria-label="N bytes dropped by retention">` with visible bytes-dropped count and an icon. The separator is keyboard-focusable so screen-reader users can land on it.

5. **A11y compliance**
   - What: implement every bullet from §9 (landmarks, `aria-live` polite region with 2 s batching + quiet toggle, focus-on-detail-heading after selection, focus rings ≥ 3:1, 44×44 touch targets, 200% zoom, `prefers-reduced-motion`).
   - Verified via Playwright + `@axe-core/playwright` and a manual keyboard-only walkthrough script committed to `tools/observability_server/ui/test/keyboard-walkthrough.md`.

6. **History tab**
   - What: WAI-ARIA tabs (`role="tablist"`). Search form with `<select>` filters; results paginated via cursor; clicking a row opens the run in the live pane.

7. **CSP + render safety**
   - What: All chunk content and progress payload fields rendered as text only. Never `dangerouslySetInnerHTML`. ANSI sanitizer applied to log chunks only.

### Risks

- **Live-tail render thrash** at 10 KB/s × 27 sub-agents → virtualization + WebSocket frame coalescing (group events within 50 ms into one React commit).
- **Backfill of 30-day-old run** → backend-paced; UI shows progressive loader and falls back to range pagination on `event: gap`.

### Verification

- Playwright E2E per §Testing UI: synthetic run via Phase 2 harness; assert tree, table, live stream first-byte ≤ 2 s, keyboard nav end-to-end, axe-rule pass, 200% zoom, reduced-motion, inline gap marker rendered when a `chunk_truncated` record is in the stream.
- Lighthouse a11y ≥ 95 on the main detail view.

## Phase 6: Dispatcher integration

**Goal:** Every `/stark-*` dispatcher initializes a `RunCtx`, owns lifecycle calls, and passes the `observability` option into every `runProcess`. The single ownership rule (dispatcher owns lifecycle; `runProcess` only attaches taps) is enforced by code review and asserted by tests. **`/stark-phase-execute` is integrated via a TS lifecycle wrapper invoked from the SKILL.md; the daemon's tracked-parent pid is the SKILL.md shell pid (the same pid that ends up in `runs.parent_pid` and is checked by the sweeper against `live_pids[]`); session-id resolution and the env-file source step are spelled out as exact shell commands.**
**Dependencies:** Phase 2.
**Estimated effort:** M.

### Tasks

1. **Extend `runProcess` signature additively — taps ONLY**
   - What: Add optional `observability?: { ctx: RunCtx; sa: SubAgent }` to `runProcess`. After `spawn()`, IF `observability` is set, call `attachChild(ctx, sa, child)`. That is the ONLY observability action `runProcess` performs.
   - `runProcess` MUST NOT call `startSubAgent`, `endSubAgent`, `startHeartbeat`, `startRunHeartbeat`, `endRun`, or `startRun`. A unit test verifies that `runProcess` does not import any of those symbols and that calling `runProcess` with an `observability` arg results in zero `subagent_start`/`subagent_end` events (only chunk + progress events from the tap).
   - Files: `tools/copilot_dispatch.ts` (canonical).

2. **Wire each dispatcher entry point — eight dispatchers, one ownership pattern**
   - Common pattern at every entry point's `main`:
     ```ts
     const parentRunId = process.env.STARK_OBS_PARENT_RUN_ID;
     const ctx = parentRunId
       ? connectRun(parentRunId, paths_lib)
       : startRun({
           dispatcher: "<name>",
           repo, branch, prNumber,
           trackedParentPid: process.pid,   // captured in daemon as runs.parent_pid for normal dispatchers
           byteBudgetBytes,
         });

     if (parentRunId) {
       emitProgress(ctx, null, "child-run-link", { child_dispatcher: "<name>", child_pid: process.pid });
     }

     // startRunHeartbeat returns a no-op {stop} for non-owned ctxs (Phase 2 Task 8).
     const runHb = startRunHeartbeat(ctx);
     try {
       for (const { agent, model, task } of plannedSubAgents) {
         const sa = startSubAgent(ctx, { agent, model, task });
         const saHb = startHeartbeat(ctx, sa);
         try {
           const result = await runProcess(cmd, args, opts, { ctx, sa });
           endSubAgent(ctx, sa, result.exitCode === 0 ? "ok" : "error", result.durationMs, result.summary);
         } catch (e) {
           endSubAgent(ctx, sa, "error", Date.now() - sa.startedAtMs, { error: String(e) });
           throw e;
         } finally {
           saHb.stop();                          // timer cancel only — endSubAgent already ran
         }
       }
       if (!parentRunId) endRun(ctx, "ok");      // owned run: end first
     } catch (e) {
       if (!parentRunId) endRun(ctx, "error");
       throw e;
     } finally {
       runHb.stop();                             // timer cancel only — endRun already ran (or never had its own daemon)
     }
     ```
   - **Cross-process semantics resolved:** when `parentRunId` is set, `connectRun` opens a UDS client to the parent writer daemon (Phase 2 Task 3). The daemon is the single owner of the parent `RunCtx` — assigns seq, owns byte budget, owns rotation, owns `meta.json`. `emitProgress` / `startSubAgent` / `endSubAgent` over the UDS appear in the parent's JSONL alongside the parent's own events. The child dispatcher does NOT spawn a writer daemon, does NOT call `startRun`, does NOT call `endRun`, and its `startRunHeartbeat` returns a no-op `{stop}` because `_isOwned` is false on the returned ctx.
   - One commit per dispatcher, each independently shippable:
     - **`tools/multi_review_lib.ts::runReview`** — entry around line 593; `endRun` after the existing `agent_dispatch`/`review_finding` insights writes at lines 1129/1148; emits `subagent_progress { kind: "finding" }` at every existing finding-append site; emits `subagent_progress { kind: "round" }` at every round transition.
     - **`tools/copilot_dispatch.ts`** lead+wing dispatcher. `emitProgress { kind: "wing-attempt" | "patch-applied" }` at the existing log sites.
     - **`tools/plan_dispatch.ts`** lead+wing dispatcher.
     - **`tools/red_team_lib.ts`** (called from `red_team_design.ts` / `red_team_plan.ts`).
     - **`tools/stark_review_doc.ts`** (design + plan review).
     - **`tools/plan_to_tasks_validate_lib.ts`**.
     - **`tools/stark_review.ts`** (single-agent path).

3. **`/stark-phase-execute` integration — daemon tracks the SKILL.md shell pid; `runs.parent_pid` is the SKILL pid**
   - **Why this is a separate task:** `/stark-phase-execute` is a Claude SKILL.md, not a TS dispatcher. The parent phase-execute run needs its own RunCtx so the UI shows a single parent run encompassing all child sub-runs. The writer daemon (Phase 2 Task 3) is the mechanism that lets multiple CLI invocations from the SKILL.md emit to the same RunCtx safely.
   - **Pid contract for phase-execute (uses a long-lived session sentinel, NOT the SKILL.md shell pid):**
     - SKILL.md bash command blocks are NOT guaranteed to share a parent shell — Claude Code may exec each block in a fresh `/bin/bash -c '…'` whose `$$` differs across blocks. Tracking `$$` as `--skill-pid` would race the daemon's 30 s `kill(pid,0)` poll into a spurious `crashed` transition the moment the first block's transient shell exits, even while the SKILL continues executing later blocks normally.
     - **Session sentinel:** `phase_execute_observability.ts start` spawns its own long-lived sentinel process inside the host: `child_process.spawn('/bin/sh', ['-c', 'while sleep 86400; do :; done'], { detached: true, stdio: 'ignore' })`, then `child.unref()`s. The sentinel persists across every transient SKILL.md bash block because it has no controlling terminal and no parent-shell association — it survives until `end` (or a real abnormal kill from outside the SKILL) terminates it. `start` writes `{sentinel_pid, sentinel_pgid}` into `~/.claude/code-review/sessions/<session_id>/phase_run.json` and uses `sentinel_pid` (NOT `$$`) as `--tracked-parent-pid` when spawning the writer daemon.
     - **`end` cleanup ordering:** `end` reads `sentinel_pid` from `phase_run.json` and calls the writer daemon's `end_run` op over UDS FIRST. The daemon completes its normal end sequence (flush, fsync, rewrite `meta.json` with `ended_at`, exit). `end` THEN sends `SIGTERM` to the sentinel and waits up to 5 s for it to exit (`SIGKILL` on timeout). This ordering reserves the canonical crashed path strictly for genuinely unexpected exits — a graceful `end` never fires `crashed_reason: "parent_exit"`.
     - The daemon polls `kill(sentinel_pid, 0)` every 30 s. ESRCH (without a prior `end_run` op having arrived over UDS) → write `run_end` with `status: "crashed", crashed_reason: "parent_exit"` (the canonical daemon-written crashed path from Phase 2 Task 3).
     - The daemon writes `parent_pid: <sentinel_pid>` into every `run_heartbeat` JSONL record.
     - The Phase 3 index writer copies that value into `runs.parent_pid` on every heartbeat.
     - The Phase 4 sweeper's `parent_pid NOT IN host.live_pids[]` check reads `runs.parent_pid` and gets the sentinel pid — which appears in `host.live_pids[]` iff the sentinel is still alive. The check is correct and consistent across the daemon-written and sweeper-written paths.
     - The daemon's own pid is written separately into `runs.writer_daemon_pid` (Phase 1 Task 4 schema addition) and `meta.json.writer_daemon_pid` for diagnostics. The sweeper does NOT use this column. There is exactly ONE pid the liveness check cares about per run: the tracked-parent pid (= sentinel pid for phase-execute, = dispatcher Node pid for everything else).
   - **New file:** `tools/phase_execute_observability.ts`. Subcommands (all idempotent on per-session state file):

     - **`start --plan-slug <slug> --session-id <id> [--repo <ORG/REPO>] [--branch <name>]`** — there is intentionally NO `--skill-pid` flag; the SKILL.md shell's `$$` is unreliable across bash command blocks (see the session-sentinel rationale above).
       - Spawns the long-lived session sentinel (`/bin/sh -c 'while sleep 86400; do :; done'`, detached + `unref`-ed) and captures its `{sentinel_pid, sentinel_pgid}`.
       - Calls `startRun({dispatcher:"stark-phase-execute", trackedParentPid: <sentinel_pid>, ...})`. This spawns the writer daemon (Phase 2 Task 3) with `--tracked-parent-pid <sentinel_pid>` and returns a `RunCtx` wired to it.
       - Writes the resulting `{runId, writerSocketPath, writerPid, sessionId, sentinel_pid, sentinel_pgid}` to `~/.claude/code-review/sessions/<session_id>/phase_run.json`.
       - Writes `~/.claude/code-review/sessions/<session_id>/phase_run.env` containing exactly:
         ```
         export STARK_OBS_PARENT_RUN_ID='<runId>'
         export STARK_OBS_SESSION_ID='<session_id>'
         ```
       - Prints `runId` to stdout.
       - Exits 0 immediately; the writer daemon (already detached and `unref()`-ed) lives on independently and owns the run-heartbeat timer.

     - **`progress --kind <k> --payload <json>`** — connects via `connectRun`, calls `emitProgress(ctx, null, kind, JSON.parse(payload))`, disconnects.

     - **`subagent-start --agent <a> --model <m> --task <t>` / `subagent-end --subagent-id <id> --status <s> [--duration-ms <n>] [--summary <json>]`** — used by the SKILL.md to bracket in-Claude sub-skills (memory update, prompt improvement detection). Connects via `connectRun`, calls `startSubAgent` / `endSubAgent` against the daemon, prints the resulting `subagent_id` to stdout.

     - **`end --status <ok|error|timeout>`** — connects, calls `endRun(ctx, status)`. The daemon flushes, fsyncs, rewrites `meta.json` with `ended_at = new Date().toISOString()`, removes `writer.sock` and `writer.pid`, exits. The CLI then removes `phase_run.json` and `phase_run.env`.

   - **Child-dispatcher linking:** the `phase_run.env` file sets `STARK_OBS_PARENT_RUN_ID`. The SKILL.md `source`s it before invoking any child slash command. Each child dispatcher's main checks `process.env.STARK_OBS_PARENT_RUN_ID` and, if set, calls `connectRun` instead of `startRun`. The child's events flow into the parent run via the same daemon. Note that `runs.parent_pid` continues to reflect the **SKILL.md shell pid** (the daemon's `tracked-parent-pid`), not any child dispatcher pid — child Node processes come and go; the SKILL.md is what defines whether the run is alive.

   - **SKILL.md edits (binding, in this same task):** `skill/stark-phase-execute/SKILL.md` gets four explicit invocation blocks.

     1. **Preflight + start (very first block in the SKILL):**
        ```bash
        export SESSION_ID="$(node --experimental-strip-types ~/.claude/code-review/tools/session_id.ts)"

        node --experimental-strip-types ~/.claude/code-review/tools/phase_execute_observability.ts start \
          --plan-slug "$PLAN_SLUG" \
          --session-id "$SESSION_ID"
        # No --skill-pid: `start` spawns its own session sentinel process and
        # uses that sentinel's pid as --tracked-parent-pid for the writer
        # daemon. $$ varies across SKILL.md bash command blocks and would race
        # the daemon's ESRCH poll into a false-positive crashed transition.

        source "$HOME/.claude/code-review/sessions/$SESSION_ID/phase_run.env"
        ```
     2. **Around each major lifecycle event:**
        ```bash
        node --experimental-strip-types ~/.claude/code-review/tools/phase_execute_observability.ts progress \
          --kind "$KIND" --payload "$PAYLOAD_JSON"
        ```
     3. **Around each in-Claude sub-skill:**
        ```bash
        SAID="$(node --experimental-strip-types ~/.claude/code-review/tools/phase_execute_observability.ts subagent-start \
          --agent claude --model opus-4-7 --task memory-update)"
        # ... do the sub-skill work ...
        node --experimental-strip-types ~/.claude/code-review/tools/phase_execute_observability.ts subagent-end \
          --subagent-id "$SAID" --status ok
        ```
     4. **At the very end (and on every error path):**
        ```bash
        node --experimental-strip-types ~/.claude/code-review/tools/phase_execute_observability.ts end \
          --status "$STATUS"
        ```

4. **`emitProgress` for findings + rounds (all dispatchers)**
   - What: At every existing finding-append site in `multi_review_lib.ts` and `stark_review_doc.ts`, call `emitProgress(ctx, sa, "finding", findingObject)`. At every round transition, call `emitProgress(ctx, sa, "round", { round_num, phase })`. Same pattern in `copilot_dispatch.ts` (`wing-attempt`, `patch-applied`).

### Risks

- **Behavioral drift in `runProcess`**: a misplaced `attachChild` could double-consume stdout. Mitigation: Phase 2 unit test asserts no consume; Phase 6 integration test asserts byte-for-byte equality.
- **Disabled-state regression**: every code path treats stub `RunCtx`/`SubAgent` as opaque; unit-tested via `OBSERVABILITY_DISABLED=1` runs of each dispatcher.
- **Pid confusion between SKILL pid and daemon pid in phase-execute** — eliminated by the explicit Pid contract above: `runs.parent_pid` always = tracked-parent-pid = SKILL.md shell pid; `runs.writer_daemon_pid` is diagnostic only and not read by liveness.
- **`source phase_run.env` runs before `start` writes the file** — addressed by sequencing in block 1: the `start` invocation completes (and writes the env file) before the next shell line runs; `source` only runs after `start` returns 0.

### Verification

- Run each of the eight dispatchers end-to-end against a real PR with the stack up; assert all 27 sub-agents (multi_review) or the appropriate count for each appear in the UI.
- Assert event counts match expected lifecycle: exactly one `run_start`, one `run_end`, N `subagent_start` and N `subagent_end`, periodic `subagent_heartbeat` and `run_heartbeat`.
- Run `/stark-phase-execute` end-to-end on a plan with 3 issues; verify in the UI:
  - One parent run with `dispatcher: "stark-phase-execute"` appears.
  - Three child dispatcher invocations emit their events INTO the parent run (no separate child run dirs), each prefixed with a `child-run-link` progress event.
  - The single daemon's run-heartbeat fires every 10 s for the full duration; every `run_heartbeat` event has `parent_pid` equal to the session sentinel pid (verified by parsing the JSONL and comparing against `jq -r .sentinel_pid ~/.claude/code-review/sessions/$SESSION_ID/phase_run.json`).
  - `runs.parent_pid` equals the session sentinel pid (verified by `curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/runs/<runId> | jq '.run.parent_pid'`).
  - Killing the session sentinel directly (`kill -9 $(jq -r .sentinel_pid ~/.claude/code-review/sessions/$SESSION_ID/phase_run.json)`) or sending the SKILL an OS-level kill that propagates to the sentinel → within 60 s the daemon writes `run_end` with `status: "crashed", crashed_reason: "parent_exit"` and exits cleanly. `runs.status` = `'crashed'`, `runs.crashed_reason` = `'parent_exit'`, `runs.ended_at` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/`.
  - The Phase 4 liveness sweeper does NOT re-mark the run crashed on subsequent ticks (idempotency).
- Run each dispatcher with `chmod 000` on spool dir; assert dispatchers complete normally with one stderr line per process and zero spool writes.

## Phase 7: Retention

**Goal:** `tools/observability_prune.ts` prunes by age and pressure correctly; `chunk_truncated` rewrites are produced cleanly via streaming in-place rewrite + atomic rename; container `event_offsets` / `chunk_offsets` / `chunk_truncations` / byte counters are updated coherently through the server's canonical two-action retention-notify endpoint (`action: "pre-rename"` before the rename, `action: "update-mtime"` after); container state sweep keeps SQLite consistent for whole-run deletions. The pre-rename body NEVER carries `new_mtime_ns`; the update-mtime body NEVER carries the `truncated[]` array. **The prune CLI reads its Bearer token directly from the macOS Keychain via the OS `security` CLI — never via the helper's stdout.**
**Dependencies:** Phase 6, Phase 4.
**Estimated effort:** M.

### Tasks

1. **Host-side prune CLI**
   - What: `tools/observability_prune.ts`. Flags: `--retention-days` (default 30, also `OBSERVABILITY_RETENTION_DAYS`), `--total-cap-gb` (default 50, also `OBSERVABILITY_TOTAL_CAP_GB`), `--dry-run`, `--json`.
   - **Token acquisition:** at the top of `main()` the CLI calls `getObservabilityToken()` which shells out to `security find-generic-password -s stark-observability-token -w` (the `-w` flag emits the password to stdout of THAT command). The CLI stores the result in a local variable, uses it only as the `Authorization: Bearer` header on the two notify requests, and zeroizes the variable at the end of each file's pair of requests. No CLI flag, no env-var path, no helper invocation participates in token transport. If `security` exits non-zero (no Keychain entry), the CLI prints a one-line recovery instruction (`"run: node --experimental-strip-types tools/observability_open.ts --no-browser to populate the Keychain"`) and exits non-zero.
   - Walks `runs/`, reads each `meta.json`, partitions into age-prunable + survivors.
   - **Reconciliation pass for sweeper-only crashes (runs before the skip filter):** the prune CLI calls `GET /api/runs?status=crashed` (Phase 4 endpoint, authenticated with the Keychain Bearer per Task 1) and for each returned run reads its on-disk `meta.json`. If `meta.json.ended_at` is `null` but the API row has a non-null `ended_at` (i.e. the container's liveness sweeper marked the run crashed via SQLite-only because the spool mount is read-only and the writer daemon had been SIGKILLed before it could rewrite `meta.json` — the Phase 8 dispatcher+daemon double-kill scenario), the CLI atomically rewrites `meta.json` (`.tmp` + `rename(2)`) with `ended_at` = the API value, `status: "crashed"`, `crashed_reason` = the API value. This host-side reconciliation step is what makes sweeper-only crashes prune-eligible. Skip protection (after reconciliation): any run whose `meta.json.ended_at` is `null` is excluded from BOTH age pruning AND pressure pruning.
   - Age pruning: move dir to `.trash/{run_id}/` (atomic `rename(2)`); write `.trash/{run_id}/.moved_at` containing `new Date().toISOString()`; schedule `rm -rf` on the next prune invocation (≥ 60 s later).
   - Pressure (after age pruning): compute total bytes; if > cap, sort terminal runs by `ended_at` ASC; for the oldest 25 % by count, call Task 3's per-file truncation routine. If still over cap after the truncation pass, delete oldest entire runs.
   - JSON output: `{ "deleted": [run_ids], "truncated": [{run_id, rotation_index, bytes_dropped, seqs: [...]}, ...], "bytes_reclaimed": N, "errors": [] }`.

2. **`.trash` grace period semantics**
   - What: `.trash/{run_id}/` is the staging area. The grace period exists so the container's tailer notices the move (via chokidar `unlink` for files in the original dir) and updates `spool_files.deleted_at` BEFORE the bytes go away. The state-only retention sweep DROPs the run from SQLite on the next hourly tick.

3. **Chunk-truncated streaming rewrite — canonical two-call schema, strict ordering, Keychain-resolved Bearer**
   - What: For each `events-NNNN.jsonl` in a pressure-truncated run, the CLI:

     1. Opens a sibling `events-NNNN.jsonl.tmp` for write.
     2. Stream-reads the original line-by-line. For each line: JSON-parse; if `type` is `subagent_stdout` or `subagent_stderr`, write a replacement record to the tmp:
        ```json
        {"seq": <orig.seq>, "ts": <orig.ts>, "type": "chunk_truncated", "run_id": <orig.run_id>, "subagent_id": <orig.subagent_id>, "stream": <"stdout"|"stderr">, "bytes_dropped": <byteLength(orig.chunk, after-base64-decode-if-needed)>}
        ```
        Else copy the line verbatim. Track every replacement as `{seq, subagent_id, stream, bytes_dropped}` for the notify body.
     3. After EOF, `fsync` the tmp. `fstat` the tmp to get `new_size_bytes`.
     4. **Call A — `action: "pre-rename"` (BEFORE rename). The body carries `new_size_bytes` and the full `truncated[]` array; it NEVER carries `new_mtime_ns`** because the mtime is intrinsically unknowable until the rename has happened and the file has been re-stat'd. Exact request:
        ```http
        POST /api/internal/retention/notify HTTP/1.1
        Host: 127.0.0.1:7700
        Authorization: Bearer <token-from-Keychain>
        Content-Type: application/json
        ```
        ```json
        {
          "action": "pre-rename",
          "run_id": "<runId>",
          "rotation_index": <N>,
          "file_path": "/spool/runs/<runId>/events-<NNNN>.jsonl",
          "new_size_bytes": <int>,
          "truncated": [
            {"seq": <int>, "subagent_id": "<rid>:<k>", "stream": "stdout", "bytes_dropped": <int>},
            ...
          ]
        }
        ```
        Expected 200 response: `{"ok": true, "cleared": <count>, "action": "pre-rename"}`. The server (Phase 3 Task 4) clears the affected `chunk_offsets` + `event_offsets` rows, decrements byte counters, updates `spool_files.size_bytes` and `spool_files.deleted_at`, resets `tail_offsets.offset = 0`.
     5. On 200 from Call A, the CLI performs `rename(2)` of `events-NNNN.jsonl.tmp` over `events-NNNN.jsonl`. The chokidar `change` event from the rename triggers the tailer (Phase 3 Task 1) to detect the mtime regression / size shrink, treat the file as in-place rewritten, and read from offset 0 — re-inserting `chunk_truncations` rows + `event_offsets` rows with the new byte ranges.
     6. `fstat` the post-rename file to read its actual `new_mtime_ns`. **Call B — `action: "update-mtime"` (AFTER rename). The body carries ONLY `new_mtime_ns` plus identifying keys; it NEVER carries `truncated[]` or `new_size_bytes`** (which the server already recorded in Call A):
        ```http
        POST /api/internal/retention/notify HTTP/1.1
        Host: 127.0.0.1:7700
        Authorization: Bearer <token-from-Keychain>
        Content-Type: application/json
        ```
        ```json
        {
          "action": "update-mtime",
          "run_id": "<runId>",
          "rotation_index": <N>,
          "file_path": "/spool/runs/<runId>/events-<NNNN>.jsonl",
          "new_mtime_ns": <int>
        }
        ```
        Expected 200: `{"ok": true, "action": "update-mtime"}`. The server updates `spool_files.mtime_ns` and `tail_offsets.mtime_ns`.
     7. Update `meta.json.bytes_written -= total_bytes_dropped`; atomic rewrite.

   - **Strict call ordering:** Call A → `rename(2)` → `fstat` → Call B. Never Call A with `new_mtime_ns`. Never Call B with `truncated[]`. Never `rename(2)` before Call A returns 200. Never Call B before `rename(2)` + `fstat`. The CLI's request-building functions are typed (zod schemas mirroring the server's Phase 3 Task 4 schemas) so a mistyped body fails at the CLI before it can leave.

   - **Failure handling:**
     - Call A non-200 → delete `.tmp`; original file untouched; index untouched; log entry in `errors[]`. Next prune cycle retries.
     - `rename(2)` failure after Call A 200 → server has cleared rows but the file is unchanged. The tailer's next read (offset = 0) will re-insert the original chunk records, restoring index parity. The CLI logs the rename failure but the system stays consistent. Next prune cycle retries.
     - Call B failure after rename succeeded → the truncated content is on disk and the index has been re-populated by the tailer with correct chunk_truncations/event_offsets rows. The only thing missing is `spool_files.mtime_ns` matching the actual file mtime; that mismatch is harmless because terminal runs don't see further appends, and the next prune cycle will retry Call B (idempotent UPDATE). Logged as an `errors[]` entry but not fatal.

4. **launchd plist for prune**
   - What: `tools/observability_server/launchd/com.aryeh.observability.prune.plist`. Runs hourly: `node --experimental-strip-types <repo>/tools/observability_prune.ts --json >> ~/.claude/code-review/observability/prune.log`. The CLI self-trims `prune.log` entries older than 90 days on each run. The plist's environment block does NOT include the Bearer token; the CLI resolves it from the Keychain at runtime per Task 1.

5. **Container state-only retention (verify wiring with prune CLI)**
   - What: Already implemented in Phase 4 Task 5. Confirm the hourly tick detects `.trash`-moved runs as missing on disk and `DELETE`s the SQLite row tree.

### Risks

- **Truncation rewrite corrupts a run mid-write** → stream to `.tmp`, validate every line parses as JSON before rename, only rename on success.
- **Prune races with an active dispatcher** → `ended_at IS NULL` filter excludes active runs. (Sweeper-only crashed runs are NOT affected by this exclusion because the reconciliation pass in Task 1 mutates `meta.json.ended_at` to the SQLite value before the skip filter runs.)
- **Server unreachable during prune** → CLI errors out for that file with a logged entry in `errors[]`; original file untouched; retry next hour.
- **Server restart between Call A and Call B** → the tailer's next read (offset = 0, persisted by Call A) re-inserts everything correctly from the rewritten file (if rename succeeded) or from the original (if not). Call B is retried on the next prune cycle; until then, only `spool_files.mtime_ns` is potentially stale, which is harmless for terminal runs.
- **Keychain entry missing on a fresh install** → CLI exits with the printed recovery instruction; the operator runs `tools/observability_open.ts --no-browser` once and retries. No fallback path that involves shipping the token through helper stdout.

### Verification

- Synthetic: emit 100 fake runs spanning 60 days, populate spool to 60 GB total. Run `node --experimental-strip-types tools/observability_prune.ts --retention-days 30 --total-cap-gb 50 --json | jq`. Assert all runs > 30 days gone; total < 50 GB; `chunk_truncated` records present in the oldest 25 % of survivors with seq values matching the original chunks; lifecycle/progress/heartbeat events preserved verbatim.
- **Schema-correctness test:** force a pressure-truncate. Capture both HTTP requests via `mitmproxy`. Assert Call A's JSON body validates against the `pre-rename` zod schema, contains `new_size_bytes`, contains a non-empty `truncated[]` with `{seq, subagent_id, stream, bytes_dropped}` per element, and does NOT contain `new_mtime_ns`. Assert Call B's body validates against the `update-mtime` schema, contains `new_mtime_ns`, and does NOT contain `truncated` or `new_size_bytes`. Assert Call A is sent strictly before the `rename(2)` syscall (verified via `dtruss` ordering) and Call B is sent strictly after.
- **No-print-token assertion (prune surface):** `grep -RIn "print-token\|observability_open.ts.*--print" tools/observability_prune.ts` returns zero matches; `grep -RIn "security find-generic-password -s stark-observability-token -w" tools/observability_prune.ts` returns exactly one match (the canonical token acquisition site).
- Open the UI and select a truncated sub-agent; assert inline gap markers render at the truncated chunk seqs.
- Verify via authenticated curl that `chunk_truncations` rows are present and `chunk_offsets` rows for the truncated seqs are gone:
  ```bash
  COOKIE_FILE="$HOME/.claude/code-review/observability/session.cookie"
  curl -sS -b "$COOKIE_FILE" "http://127.0.0.1:7700/api/runs/$RUN_ID/subagents/$SUBAGENT_ID/chunks?from_seq=1" \
    | grep -c "^event: gap" # expect > 0
  ```
- Inspect via the server's debug-introspection HTTP route: `runs` rows for deleted spool dirs are gone within an hour; `chunk_truncations` rows are present for truncated sub-agents.
- launchctl unload + manual trigger: `prune.log` shows the prune action.

## Phase 8: Hardening, load test, live verification

**Goal:** Latency + throughput targets met under representative load. Live end-to-end verification against a real PR. **Crashed-state tests cover both the daemon-written and sweeper-written paths and prove the single-writer-per-failure-mode property. All scripted auth in this phase uses the cookie file or Keychain-resolved Bearer — never the helper's stdout.**
**Dependencies:** Phase 7.
**Estimated effort:** M.

### Tasks

1. **Load harness**
   - What: `tools/observability_server/test/load.ts`. Spawns a synthetic dispatcher that itself spawns 27 fake child sub-agents emitting 10 KB/s of synthetic Codex-JSONL-shaped stdout for 600 s, forces ≥ 1 rotation per sub-agent, spawns 2 browser WS subscribers (Playwright headless), spawns a history-query loop every 5 s.
   - Asserts: WS end-to-end p95 < 2 s; UI sub-agent select → first-byte p95 < 2 s; SQLite commit p95 < 50 ms; memory growth < 50 MB/h; chunk delivery count == emitted count; daemon UDS round-trip p95 < 5 ms even under load.
   - Files: `tools/observability_server/test/load.ts`, `tools/observability_server/test/load_report.ts`.

2. **Failure-path tests**
   - What: Vitest suite forcing every failure path from §Testing: malformed JSONL, invalid base64, deleted spool file mid-SSE, SQLite write failure, tailer parse storm, daemon SIGKILL'd mid-run, server crash between retention-notify Call A and Call B.
   - Each asserts `/api/health` reports accurate state and the server stays up.

3. **Live test — dispatcher SIGKILL with daemon-written crashed path**
   - What: Run `/stark-review` against a real PR with planted secrets in agent output (`ghp_*` token, `sk-ant-*` key, JWT). Mid-run, with several sub-agents in-flight:
     ```bash
     DISP_PID=$(pgrep -fn "multi_review.ts")
     kill -9 "$DISP_PID"
     ```
   - Expected behavior:
     1. The daemon's `kill(parent_pid, 0)` poll (Phase 2 Task 3) detects the dispatcher is gone within 30 s.
     2. The daemon writes a final `run_heartbeat`, then a `run_end` JSONL record with `status: "crashed", crashed_reason: "parent_exit"` and `ts = new Date().toISOString()`, fsyncs, rewrites `meta.json` (`ended_at` set to the same ISO timestamp, `status: "crashed"`, `crashed_reason: "parent_exit"`), removes `writer.sock` and `writer.pid`, exits 0.
     3. The Phase 3 tailer reads the new `run_end` event; the index writer updates `runs.status = 'crashed'`, `runs.crashed_reason = 'parent_exit'`, `runs.ended_at = <event.ts>`.
     4. The Phase 4 liveness sweeper, on its next tick, sees the row matches the terminal-status filter and does nothing. Idempotency confirmed.
     5. Total elapsed from SIGKILL to UI showing crashed: ≤ 60 s.
   - Assert `runs.ended_at` matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` (catches any regression where someone reintroduced `strftime`).

4. **Live test — dispatcher + daemon SIGKILL with sweeper-written crashed path**
   - What: Same setup, then:
     ```bash
     DISP_PID=$(pgrep -fn "multi_review.ts")
     # Resolve the writer daemon for the active run.
     RUN_ID=$(jq -r '.run_id' ~/.claude/code-review/observability/runs/*/meta.json | tail -1)
     DAEMON_PID=$(cat ~/.claude/code-review/observability/runs/$RUN_ID/writer.pid)
     kill -9 "$DISP_PID" "$DAEMON_PID"
     ```
   - Expected behavior:
     1. With the daemon dead, no `run_heartbeat` writes occur; `runs.last_heartbeat_at` ages past 60 s.
     2. The dispatcher pid (which the daemon was tracking and writing into `runs.parent_pid`) is gone from `host.live_pids[]`.
     3. The Phase 4 liveness sweeper, on its next 30 s tick, runs its transaction and writes `runs.status = 'crashed'`, `runs.crashed_reason = 'parent_exit'`, `runs.ended_at = <TS-bound ISO timestamp>`. Assert the result matches the millisecond regex.
     4. Total elapsed from SIGKILL to UI showing crashed: ≤ 90 s.
     5. Run the sweeper 20 more times — assert zero further UPDATEs against the same run.

5. **Live test — UI verification**
   - What: For each of Tasks 3 and 4, verify in UI:
     - All 27 sub-agents appear before the kill.
     - Status transitions are correct: `running` → `crashed` for all non-terminal sub-agents within the expected SLA.
     - The run's `crashed_reason` is `parent_exit` and `ended_at` is set (and renders as a parseable Date in the UI).
     - Planted secrets show as `<REDACTED:…>` everywhere.
     - `tools/observability_open.ts` opens the UI without manual log inspection.
     - Full keyboard-only operation works.

6. **Live test — host_boot_id change**
   - What: Simulate by editing `~/.claude/code-review/observability/hostinfo/host.json` to a new boot id; verify inflight runs transition to `crashed` with `crashed_reason: "host_boot_changed"` and `ended_at` matching the ISO-8601 ms regex within 60 s; idempotent on subsequent ticks.

7. **Live test — pressure retention with canonical notify schema**
   - What: Force pressure retention to truncate the just-completed PR run; capture HTTP traffic via `mitmproxy`; verify Call A is `action: "pre-rename"` without `new_mtime_ns`, Call B is `action: "update-mtime"` without `truncated[]`, and the two calls bracket the `rename(2)` syscall in that order. Verify the tailer re-reads the rewritten file, `chunk_truncations` rows appear, `chunk_offsets` rows for the truncated seqs are gone, inline gap markers render in the UI's log view, and `mitmproxy` shows the Bearer header value matches the Keychain entry (not any helper stdout transcript).

8. **Live test — LAN bootstrap end-to-end**
   - What: Execute the full executable LAN bootstrap sequence from Phase 1 Task 3 on the actual install:
     ```bash
     docker compose -f tools/observability_server/docker-compose.yml down
     docker run --rm -v observability_index:/data alpine sh -c 'rm -f /data/last_bootstrap_at'
     docker compose -f tools/observability_server/docker-compose.yml up -d
     node --experimental-strip-types tools/observability_open.ts --no-browser
     # Assert /data/last_bootstrap_at now exists:
     docker exec stark-observability test -s /data/last_bootstrap_at && echo "marker present"
     docker compose -f tools/observability_server/docker-compose.yml down
     cp tools/observability_server/docker-compose.lan.yml.example \
        tools/observability_server/docker-compose.override.yml
     # Bind set to the host's actual LAN IP in the override.
     docker compose \
       -f tools/observability_server/docker-compose.yml \
       -f tools/observability_server/docker-compose.override.yml up -d
     # Server boots, accepts the LAN bind, /api/health/probe responds from the LAN IP.
     curl -sS http://192.168.X.Y:7700/api/health/probe   # expect {"ok":true}
     ```
     Then revert: bring stack down, delete the override, restart loopback-only.

9. **Docs**
   - What:
     - Update repo `CLAUDE.md` ("Stark Review Observability" section): how to start, how to open, spool location, prune CLI location, explicit note that liveness is via `hostinfo/host.json` only, explicit note that the writer daemon is one-per-run, explicit note that `runs.parent_pid` is always the tracked-parent pid (dispatcher Node pid for normal dispatchers, SKILL.md shell pid for phase-execute) and never the daemon pid, explicit note that retention-notify is two strictly-ordered calls (`pre-rename` then `update-mtime`), explicit note that the helper never echoes the raw token and scripts use the cookie file or Keychain Bearer, explicit note that the LAN bootstrap sequence requires a loopback first boot.
     - Update workspace-root `CLAUDE.md`: one-liner pointer with the same hostinfo + parent_pid + no-token-echo + LAN-bootstrap notes.
     - Update repo `AGENTS.md`: one-line mention.
     - `tools/observability_server/README.md`: full human-readable JSONL event schema, `chunk_truncated` semantics, hostinfo-only liveness contract, writer-daemon UDS protocol, two-call retention-notify protocol with the canonical schema for each action, deployment runbook including the LAN bootstrap five-step sequence, scripted-auth contract (cookie file + Keychain Bearer; no helper-stdout token).
     - `tools/observability_server/CLAUDE.md` / `AGENTS.md`: reflect the daemon protocol, uptime formula, `chunk_truncated.seq == orig.seq` rule, two-call notify schema, parent_pid contract, no-print-token rule, TS-bound timestamp rule.

### Risks

- **Load test passes locally but real Codex output is bursty** → Task 5's live test is the final arbiter.
- **Redaction over-aggressive on real agent output** → live test surfaces this; mitigation already in Phase 2.
- **Crashed-state test timing variance** — the design accepts up to ~90 s practical bound for the sweeper path; the daemon-written path completes in ≤ 60 s. Both bounds are tested.
- **Strftime regression** — guarded by the regex assertion on `ended_at` in every crashed-path test plus a static grep assertion (`grep -RIn "ended_at.*strftime" tools/ tools/observability_server/` must return zero in CI).

### Verification

- Load harness exit code 0; report JSON shows all percentile assertions green.
- Live test screenshots + per-scenario checklist filed in `.observability-runs/live-test-2026-MM-DD.md`.
- `curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/runs?status=crashed | jq '.items[0].crashed_reason'` returns `"parent_exit"` after both crashed-path scenarios, and `.items[0].ended_at` is non-null and matches the ISO-8601 ms regex.
- `grep -RIn "print-token" tools/ scripts/ skill/ tools/observability_server/` returns zero matches.
- `grep -RIn "ended_at.*strftime\|strftime.*ended_at" tools/ tools/observability_server/` returns zero matches.

## 4. Integration Points

- **JSONL spool ↔ tailer**: append-only file is the only contract. Schema versioned by top-level field (`run_start.version`) plus per-event `type`. Changes are additive.
- **Writer daemon UDS ↔ emit lib**: the `op`/`{ok,seq,error}` wire protocol from Phase 2 Task 3 is the cross-process contract. Adding ops is OK; renaming requires a versioned client.
- **`runProcess` signature**: additive `observability` param; `runProcess` performs ONLY `attachChild`. Lifecycle calls are the dispatcher's responsibility — enforced by code rule and unit test.
- **Heartbeat `{stop}` ↔ lifecycle calls**: `stop()` is strictly a timer cancel. `endRun` and `endSubAgent` are the only termination triggers. The dispatcher always calls the lifecycle function first and `{stop}` second. Enforced by unit test (Phase 2 Task 8) and by the dispatcher pattern in Phase 6 Task 2.
- **Daemon crashed-write ↔ sweeper crashed-write**: both write `status: "crashed", crashed_reason: "parent_exit"` with `ended_at` bound from `new Date().toISOString()` on the writer side. The sweeper's `status NOT IN (terminal)` filter guarantees at most one writer wins per row. The daemon path runs in ≤ 60 s; the sweeper path is the fallback for when the daemon is also dead and runs in ≤ 90 s.
- **`runs.parent_pid` ↔ tracked-parent-pid**: always equals the pid passed as `--tracked-parent-pid` at daemon spawn (= dispatcher Node pid for normal dispatchers, = SKILL.md shell pid for `/stark-phase-execute`). Used by the liveness sweeper's `live_pids[]` check. The daemon's own pid is `runs.writer_daemon_pid`, diagnostic only.
- **SQLite schema ↔ HTTP API**: HTTP shapes stable. Column renames go through migration + translation layer. All `ended_at` and `last_heartbeat_at` values are server-bound ISO-8601 millisecond strings; never SQLite `strftime` output.
- **Hostinfo ↔ liveness**: `host.json` shape is the contract between the host ticker and the container sweeper. No `/proc` mount.
- **`event_offsets` ↔ WebSocket backfill**: every JSONL record indexed once; WS hub reads bytes by `(rotation_index, byte_start, byte_end)` for ANY event type.
- **`chunk_truncated` ↔ retention**: seq-preserved by Phase 7's in-place rewrite; parsed by Phase 3 tailer; recorded by Phase 3 index writer; surfaced by Phase 4 chunk SSE as `event: gap`; surfaced by Phase 4 WS backfill as `code: retention_gap`; rendered by Phase 5 UI as inline gap markers.
- **`POST /api/internal/retention/notify` ↔ prune CLI**: two strictly-ordered calls per rewritten file. `action: "pre-rename"` carries `new_size_bytes` + `truncated[]` (each entry `{seq, subagent_id, stream, bytes_dropped}`); sent BEFORE the `rename(2)`; never carries `new_mtime_ns`. `action: "update-mtime"` carries only `new_mtime_ns` (plus identifying keys); sent AFTER the rename + `fstat`; never carries `truncated[]` or `new_size_bytes`. Bearer-token + loopback authed. Zod schemas on both ends. Single canonical schema referenced by Phase 3 Task 4, Phase 4 Task 2, Phase 7 Task 3.
- **`STARK_OBS_PARENT_RUN_ID` ↔ child dispatchers**: env-var-mediated cross-process linking. Read by each dispatcher's `main` (Phase 6 Task 2); on hit, the dispatcher calls `connectRun` instead of `startRun` and emits a `child-run-link` progress event.
- **Auth token ↔ Keychain**: `/data/token` is generated by the server (Phase 1) and mirrored to the macOS Keychain by the bootstrap helper (Phase 1 + Phase 4 auth flow). The prune CLI (Phase 7) reads the same Keychain entry. The helper never echoes the token to stdout; scripts that need Bearer auth use `security find-generic-password -s stark-observability-token -w` directly.
- **`/data/last_bootstrap_at` ↔ LAN bind authorization**: the file is written by `POST /api/auth/exchange` on first successful redemption (Phase 4 Task 1). The server boot check (Phase 1 Task 3) reads its existence to decide whether to accept a non-loopback bind. The executable LAN bootstrap sequence is the only path that produces this file. There is no escape hatch that bypasses the marker.

## 5. Testing Strategy

| Phase | Unit | Integration | E2E |
| ----- | ---- | ----------- | --- |
| 1 | path helpers, hostinfo render (incl. corrected `uptime_seconds` formula), atomic rename stress | docker compose up + probe endpoint + `docker exec stark-observability test -s /data/token` + `observability_open.ts --no-browser` (Keychain populated, cookie file written, no token on stdout) + LAN-refusal negative test | n/a |
| 2 | emit lib (all surfaces, redactor, budgets, rotation, non-consume tap), writer daemon UDS protocol (single + multi-client), `{stop}`-is-a-timer-cancel test, daemon parent-loss writes `status: "crashed"` with TS-bound `ended_at` | synthetic harness writes valid JSONL with rotation; multi-process harness exercises `connectRun` from two PIDs | n/a |
| 3 | tailer parse (incl. `chunk_truncated`, incl. in-place rewrite detection), index writer upserts (incl. `event_offsets`, `chunk_truncations` with seq-preserving semantics, daemon-written `run_end` with `crashed_reason`), two-action notify endpoint schema validation, ISO-8601-ms `ended_at` shape | container reads Phase 2 fixture; SQLite row counts match per type; injected hand-rewrite round-trips correctly via pre-rename + rename + update-mtime | n/a |
| 4 | auth (incl. `/data/last_bootstrap_at` write on exchange), rate-limit, liveness logic (hostinfo-only, idempotent terminal transitions, single-writer-per-failure-mode, TS-bound `ended_at`), WS backfill via `event_offsets`, two-action notify endpoint auth + zod, grep assertion `print-token == 0 matches`, grep assertion `ended_at.*strftime == 0 matches` | full curl + wscat suite against running container using cookie file + Keychain Bearer | n/a |
| 5 | React components, gap-marker rendering | TanStack Query against live server | Playwright + axe |
| 6 | runProcess no-lifecycle assertion, per-dispatcher `RunCtx` plumb, phase-execute parent/child linking via `connectRun`, SKILL pid → `runs.parent_pid` propagation | dispatcher harness end-to-end against stack; phase-execute parent visible with linked child events; SKILL.md `source phase_run.env` round-trips | live PR run |
| 7 | prune logic, `chunk_truncated` rewrite atomicity, two-call notify ordering, Keychain Bearer resolution + missing-Keychain recovery path | synthetic 60 GB spool prune + UI inline-gap render + mitmproxy schema capture + mitmproxy Bearer-matches-Keychain | n/a |
| 8 | failure paths | load harness | live PR with planted secrets + dispatcher-SIGKILL (daemon-written crashed) + dispatcher+daemon-SIGKILL (sweeper-written crashed) + boot-id-change + pressure-truncation + LAN bootstrap five-step sequence |

**Test first** (Phase 3): tailer + universal event index — the riskiest correctness surface, especially the in-place rewrite path that Phase 7 depends on.
**Test last** (Phase 8): load + live + dual crashed-path tests + LAN bootstrap — depends on every preceding phase.

## 6. Rollback Plan

Each phase is independently revertable because the JSONL spool contract decouples producers from consumers.

- **Phase 1**: `docker compose -f tools/observability_server/docker-compose.yml down`; `rm -rf ~/.claude/code-review/observability/`; `launchctl unload tools/observability_server/launchd/com.aryeh.observability.hostinfo.plist`; `security delete-generic-password -s stark-observability-token` (if installed). No dispatcher impact.
- **Phase 2**: revert the emit-lib commits. Nothing imports it yet, so nothing breaks. Any leftover writer-daemon processes are user-owned and idle; `pkill -f observability_writer_daemon.ts` cleans them up.
- **Phase 3**: stop the container. Spool keeps growing on disk; host-side prune still works.
- **Phase 4**: revert the server commits except the probe endpoint. UI breaks (Phase 5), but dispatchers are unaffected.
- **Phase 5**: revert the UI commit; serve a static "UI under maintenance" page. HTTP API stays functional for CLI clients.
- **Phase 6 (per dispatcher)**: revert that dispatcher's commit. The `observability` param is optional. For `/stark-phase-execute`, revert the SKILL.md changes and remove `tools/phase_execute_observability.ts`; the SKILL still works without observability. Any in-flight writer daemon is owned by the SKILL.md shell and is cleaned up by `end` on normal exit, or by the daemon's own `kill(skill_pid, 0)` poll on abnormal exit.
- **Phase 7**: revert the prune CLI commit; `launchctl unload tools/observability_server/launchd/com.aryeh.observability.prune.plist`. Disk grows unbounded until manually cleaned; no functional impact.
- **Phase 8**: load test artifacts and docs. Pure additive — no rollback needed.

**Whole-stack kill-switch:** `OBSERVABILITY_DISABLED=1` env var read by the emit lib in `startRun` (Phase 2 Task 9) short-circuits all emission and sets `emit_status: "disabled"`. Set it in the operator's shell `.zshrc` to mute observability without uninstalling anything.

Start Phase 1 by running `mkdir -p ~/.claude/code-review/observability/{runs,hostinfo,.trash}` and committing the `tools/observability_paths_lib.ts` skeleton.