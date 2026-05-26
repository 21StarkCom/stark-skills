# Phase 8 — live verification scripts

Operator-driven scripts that exercise the running observability stack end-to-end
against a real PR. Each numbered file maps to a Phase 8 task in the spec
(`docs/specs/2026-05-25-stark-review-observability-plan.md` §Phase 8).

| Script | Phase 8 task | What it does |
| ------ | ------------ | ------------ |
| `live_run_metadata.ts`              | Task 3 + 4 | Standalone helper that writes `~/.claude/code-review/observability/test/live-run.json` from outside the dispatcher — use when wrapping a dispatcher you can't recompile. The real dispatchers write the same file natively when launched with `STARK_OBS_WRITE_LIVE_RUN_METADATA=1` (see "Running" below), which is the path the destructive tests assume. |
| `dispatcher_sigkill.sh`             | Task 3 | SIGKILL's the dispatcher; asserts the daemon-written crashed path completes in ≤ 60 s with a regex-bound `ended_at`. |
| `dispatcher_and_daemon_sigkill.sh`  | Task 4 | SIGKILL's the dispatcher AND the daemon; asserts the sweeper-written crashed path completes in ≤ 90 s and is idempotent across 20 sweep ticks. |
| `ui_verification_checklist.md`      | Task 5 | Per-scenario UI checklist filed under `.observability-runs/live-test-YYYY-MM-DD.md`. |
| `host_boot_id_change.ts`            | Task 6 | Rewrites `hostinfo/host.json` with a fresh `host_boot_id`; asserts inflight runs transition to `crashed_reason: "host_boot_changed"` within 60 s. |
| `pressure_retention.sh`             | Task 7 | Forces pressure retention via the prune CLI; captures `mitmproxy` traffic; verifies the two-call notify schema + Keychain Bearer match. |
| `lan_bootstrap.sh`                  | Task 8 | Executes the loopback → LAN bootstrap five-step sequence. |
| `checklist_template.md`             | All     | Markdown skeleton for the per-run report. |

## Running

The scripts assume:

- The container stack is up (`docker compose -f tools/observability_server/docker-compose.yml up -d`).
- `tools/observability_open.ts` has been run at least once so `/data/last_bootstrap_at` exists and the operator's macOS Keychain holds both `stark-observability-bootstrap-token` and `stark-observability-prune-token`.
- `mitmproxy` is on `$PATH` for Task 7's notify-traffic capture.
- The PR run under test was launched with `STARK_OBS_WRITE_LIVE_RUN_METADATA=1` exported in the dispatcher's environment, e.g.:

  ```bash
  STARK_OBS_WRITE_LIVE_RUN_METADATA=1 \
    node --experimental-strip-types tools/multi_review.ts --pr 1234
  ```

  Every TS dispatcher built on `tools/observability_dispatcher_helpers.ts::initRunCtx` honors the flag: immediately after `startRun()` returns, the dispatcher atomically writes `~/.claude/code-review/observability/test/live-run.json` with the real `dispatcher_pid` (= dispatcher Node pid, == `runs.parent_pid`), `writer_pid` (read from `runs/<run>/writer.pid`), and `run_id`. The destructive scripts in this directory then resolve those values from harness bookkeeping rather than from `pgrep`/`tail` — both of which can land on stale processes or older run dirs and silently target the wrong run. Connected child dispatchers (`STARK_OBS_PARENT_RUN_ID` set) deliberately skip the write so a child can't clobber the parent's metadata.

Each script writes its run artefact to `.observability-runs/<task>-YYYY-MM-DD.md` (gitignored) so the operator can attach screenshots + percentile assertions to the per-day report.

## Auth contract

Every `curl` example uses the cookie file produced by `observability_open.ts`:

```bash
COOKIE_FILE=~/.claude/code-review/observability/session.cookie
curl -sS -b "$COOKIE_FILE" http://127.0.0.1:7700/api/...
```

The prune CLI's Bearer flow writes the header to a 0600 temp file and passes it
via `curl -K <file>` so the token never appears in `argv` or shell history. No
script in this directory uses `curl -H "Authorization: Bearer $TOKEN"` directly
— grep'd by `tools/observability_server/server/grep_assertions.test.ts`.
