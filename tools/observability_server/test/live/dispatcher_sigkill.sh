#!/usr/bin/env bash
# Phase 8 Task 3 — dispatcher SIGKILL with daemon-written crashed path.
#
# Runs a `/stark-review` against a real PR with planted secrets (configured
# in the harness's emit fixture). Mid-run, SIGKILL's the dispatcher and
# asserts the daemon's `kill(parent_pid, 0)` poll detects the loss within
# 30 s and writes `status: "crashed", crashed_reason: "parent_exit"` with
# a TS-bound ISO-8601 millisecond `ended_at`. Total elapsed to UI showing
# crashed: ≤ 60 s.

set -euo pipefail

COOKIE_FILE="${COOKIE_FILE:-$HOME/.claude/code-review/observability/session.cookie}"
LIVE_RUN_JSON="${LIVE_RUN_JSON:-$HOME/.claude/code-review/observability/test/live-run.json}"
API_BASE="${API_BASE:-http://127.0.0.1:7700}"
ISO_MS_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'

if [[ ! -f "$COOKIE_FILE" ]]; then
  echo "missing cookie file: $COOKIE_FILE" >&2
  echo "  run: node --experimental-strip-types tools/observability_open.ts" >&2
  exit 2
fi
if [[ ! -f "$LIVE_RUN_JSON" ]]; then
  echo "missing live-run metadata: $LIVE_RUN_JSON" >&2
  echo "  expected the dispatcher to have called live_run_metadata.ts at start" >&2
  exit 2
fi

DISP_PID=$(jq -r '.dispatcher_pid' "$LIVE_RUN_JSON")
RUN_ID=$(jq -r '.run_id' "$LIVE_RUN_JSON")

if ! kill -0 "$DISP_PID" 2>/dev/null; then
  echo "dispatcher pid $DISP_PID already gone — aborting destructive test" >&2
  exit 1
fi
status=$(curl -sS -b "$COOKIE_FILE" "$API_BASE/api/runs/$RUN_ID" | jq -r '.run.status')
if [[ "$status" != "running" ]]; then
  echo "run $RUN_ID not in 'running' state (was '$status') — aborting" >&2
  exit 1
fi

echo "[task-3] SIGKILL dispatcher pid=$DISP_PID run_id=$RUN_ID at $(date -u +%FT%T.000Z)"
kill -9 "$DISP_PID"

DEADLINE=$(($(date +%s) + 60))
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
  echo "FAIL — run $RUN_ID did not transition to 'crashed' within 60 s" >&2
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

echo "PASS — run=$RUN_ID status=crashed reason=parent_exit ended_at=$ended_at"
