#!/usr/bin/env bash
# Phase 8 Task 4 — dispatcher + daemon SIGKILL with sweeper-written crashed path.
#
# Reads `live-run.json` to resolve dispatcher_pid, writer_pid, run_id from
# the harness's own bookkeeping. Sanity-checks both are still alive and the
# run is still `running` before pulling the trigger. SIGKILL's both, then
# waits up to 90 s for the liveness sweeper to write
# `status: "crashed", crashed_reason: "parent_exit"`. Runs the sweeper 20
# more ticks and asserts no further UPDATEs.

set -euo pipefail

COOKIE_FILE="${COOKIE_FILE:-$HOME/.claude/code-review/observability/session.cookie}"
LIVE_RUN_JSON="${LIVE_RUN_JSON:-$HOME/.claude/code-review/observability/test/live-run.json}"
API_BASE="${API_BASE:-http://127.0.0.1:7700}"
RETENTION_BASE="${RETENTION_BASE:-http://127.0.0.1:7701}"
ISO_MS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'

if [[ ! -f "$COOKIE_FILE" ]]; then
  echo "missing cookie file: $COOKIE_FILE" >&2
  exit 2
fi
if [[ ! -f "$LIVE_RUN_JSON" ]]; then
  echo "missing live-run metadata: $LIVE_RUN_JSON" >&2
  exit 2
fi

# Prune-token Bearer needed for the sweep-now trigger on the retention
# listener (E11: pass via curl -K <0600 file>, never argv).
PRUNE_TOKEN=$(security find-generic-password -s stark-observability-prune-token -w 2>/dev/null || true)
if [[ -z "$PRUNE_TOKEN" ]]; then
  echo "missing prune token in Keychain (service: stark-observability-prune-token)" >&2
  exit 2
fi
CURL_AUTH_CFG=$(mktemp)
trap 'rm -f "$CURL_AUTH_CFG"' EXIT
chmod 600 "$CURL_AUTH_CFG"
printf 'header = "Authorization: Bearer %s"\n' "$PRUNE_TOKEN" >"$CURL_AUTH_CFG"
unset PRUNE_TOKEN

DISP_PID=$(jq -r '.dispatcher_pid' "$LIVE_RUN_JSON")
RUN_ID=$(jq -r '.run_id' "$LIVE_RUN_JSON")
DAEMON_PID=$(jq -r '.writer_pid' "$LIVE_RUN_JSON")

if [[ -z "$DAEMON_PID" || "$DAEMON_PID" == "null" ]]; then
  echo "writer_pid missing from $LIVE_RUN_JSON — aborting" >&2
  exit 1
fi

if ! kill -0 "$DISP_PID" 2>/dev/null; then
  echo "dispatcher pid $DISP_PID already gone — aborting destructive test" >&2
  exit 1
fi
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "writer daemon pid $DAEMON_PID already gone — aborting destructive test" >&2
  exit 1
fi
status=$(curl -sS -b "$COOKIE_FILE" "$API_BASE/api/runs/$RUN_ID" | jq -r '.run.status')
if [[ "$status" != "running" ]]; then
  echo "run $RUN_ID not in 'running' state (was '$status') — aborting" >&2
  exit 1
fi

echo "[task-4] SIGKILL dispatcher=$DISP_PID daemon=$DAEMON_PID run=$RUN_ID at $(date -u +%FT%T.000Z)"
kill -9 "$DISP_PID" "$DAEMON_PID"

DEADLINE=$(($(date +%s) + 90))
crashed=""
while (( $(date +%s) < DEADLINE )); do
  resp=$(curl -sS -b "$COOKIE_FILE" "$API_BASE/api/runs/$RUN_ID")
  status=$(echo "$resp" | jq -r '.run.status')
  if [[ "$status" == "crashed" ]]; then
    crashed="$resp"
    break
  fi
  sleep 2
done

if [[ -z "$crashed" ]]; then
  echo "FAIL — sweeper did not mark run $RUN_ID crashed within 90 s" >&2
  exit 1
fi

ended_at=$(echo "$crashed" | jq -r '.run.ended_at')
reason=$(echo "$crashed" | jq -r '.run.crashed_reason')
if [[ "$reason" != "parent_exit" ]]; then
  echo "FAIL — crashed_reason='$reason' expected 'parent_exit'" >&2
  exit 1
fi
if ! [[ "$ended_at" =~ $ISO_MS_RE ]]; then
  echo "FAIL — ended_at='$ended_at' does not match ISO-8601 ms regex" >&2
  exit 1
fi

# Idempotency: force 20 real sweeper ticks via the retention listener's
# `sweep-now` endpoint (prune-token authed, loopback-only). Each POST
# runs the full liveness sweep transaction synchronously, so we observe
# 20 actual ticks here — not 20 sleeps that drift past the natural
# 30 s interval. After each, `ended_at` must not move.
echo "[task-4] verifying sweeper idempotency over 20 forced ticks..."
for i in $(seq 1 20); do
  sweep=$(curl -sS -K "$CURL_AUTH_CFG" -X POST \
    "$RETENTION_BASE/internal/retention/sweep-now")
  if ! echo "$sweep" | jq -e '.ok == true' >/dev/null; then
    echo "FAIL — sweep-now call $i failed: $sweep" >&2
    exit 1
  fi
  resp=$(curl -sS -b "$COOKIE_FILE" "$API_BASE/api/runs/$RUN_ID")
  ea=$(echo "$resp" | jq -r '.run.ended_at')
  if [[ "$ea" != "$ended_at" ]]; then
    echo "FAIL — sweeper re-wrote ended_at on tick $i (was=$ended_at now=$ea)" >&2
    exit 1
  fi
done

echo "PASS — run=$RUN_ID sweeper-written crashed, idempotent across 20 forced ticks. ended_at=$ended_at"
