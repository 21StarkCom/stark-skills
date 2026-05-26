# Live verification — Phase 8 — YYYY-MM-DD

Operator: ____________________
Stack version (`docker compose images stark-observability` → tag): ____________________
PR under test: ____________________

## Setup

- [ ] `docker compose -f tools/observability_server/docker-compose.yml ps` shows `stark-observability` healthy.
- [ ] `node --experimental-strip-types tools/observability_open.ts --no-browser` populated:
  - [ ] `~/.claude/code-review/observability/session.cookie`
  - [ ] Keychain entries `stark-observability-bootstrap-token` + `stark-observability-prune-token`
- [ ] Live-run metadata file present:
  `~/.claude/code-review/observability/test/live-run.json`

## Task 3 — dispatcher SIGKILL (daemon-written crashed)

- [ ] `bash tools/observability_server/test/live/dispatcher_sigkill.sh` exits PASS.
- [ ] UI verification checklist: ____________________
- [ ] Screenshot attached: ____________________

## Task 4 — dispatcher + daemon SIGKILL (sweeper-written crashed)

- [ ] `bash tools/observability_server/test/live/dispatcher_and_daemon_sigkill.sh` exits PASS.
- [ ] Sweeper idempotency confirmed (20 ticks; ended_at frozen).
- [ ] UI verification checklist: ____________________

## Task 6 — host_boot_id change

- [ ] `node --experimental-strip-types tools/observability_server/test/live/host_boot_id_change.ts` exits PASS.

## Task 7 — pressure retention notify

- [ ] `bash tools/observability_server/test/live/pressure_retention.sh` exits PASS.
- [ ] mitmdump capture archived at: ____________________

## Task 8 — LAN bootstrap

- [ ] `LAN_IP=<host IP> bash tools/observability_server/test/live/lan_bootstrap.sh` exits PASS.

## Tear-down

- [ ] Override file removed: `tools/observability_server/docker-compose.override.yml` absent.
- [ ] Loopback stack restored.
- [ ] `curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/runs?status=crashed | jq '.items[0].crashed_reason'` returns `"parent_exit"`.

## Notes
