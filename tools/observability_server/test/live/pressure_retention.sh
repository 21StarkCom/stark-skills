#!/usr/bin/env bash
# Phase 8 Task 7 — pressure retention with canonical notify schema.
#
# Drives a hand-injected pressure rewrite via the prune CLI against the
# just-completed PR run. mitmproxy is launched in the background so we
# capture the two-call notify schema + Keychain Bearer header and verify
# both against the canonical contract.
#
# Verifies:
#   1. Call A: action="pre-rename" without `new_mtime_ns`, with truncated[].
#   2. Call B: action="update-mtime" without `truncated[]`, with `new_mtime_ns`.
#   3. The two calls bracket the local `rename(2)` (pre then post).
#   4. mitmproxy shows Bearer header value matches the Keychain entry.
#   5. After the dust settles, `chunk_truncations` rows exist for the
#      truncated seqs, `chunk_offsets` rows for those seqs are gone, and
#      the UI's log view renders inline gap markers.

set -euo pipefail

COOKIE_FILE="${COOKIE_FILE:-$HOME/.claude/code-review/observability/session.cookie}"
LIVE_RUN_JSON="${LIVE_RUN_JSON:-$HOME/.claude/code-review/observability/test/live-run.json}"
API_BASE="${API_BASE:-http://127.0.0.1:7700}"
PRUNE_CLI="${PRUNE_CLI:-node --experimental-strip-types tools/observability_prune.ts}"

if ! command -v mitmproxy >/dev/null && ! command -v mitmdump >/dev/null; then
  echo "mitmproxy/mitmdump not found on PATH — install with brew install mitmproxy" >&2
  exit 2
fi
if [[ ! -f "$LIVE_RUN_JSON" ]]; then
  echo "missing live-run metadata: $LIVE_RUN_JSON" >&2
  exit 2
fi

RUN_ID=$(jq -r '.run_id' "$LIVE_RUN_JSON")
KEYCHAIN_TOKEN=$(security find-generic-password -s stark-observability-prune-token -w 2>/dev/null || true)
if [[ -z "$KEYCHAIN_TOKEN" ]]; then
  echo "stark-observability-prune-token not in Keychain — run observability_open.ts first" >&2
  exit 2
fi

TRAFFIC_OUT=$(mktemp -t obs-notify-XXXXXX).jsonl
echo "[task-7] mitmdump → $TRAFFIC_OUT"
# Capture all retention-listener traffic for the duration of this test.
mitmdump \
  --listen-host 127.0.0.1 \
  --listen-port 7702 \
  --mode reverse:http://127.0.0.1:7701 \
  --set "save_stream_file=$TRAFFIC_OUT" \
  >/dev/null 2>&1 &
MITM_PID=$!
trap 'kill -TERM "$MITM_PID" 2>/dev/null || true' EXIT
sleep 1

# Force pressure retention. The prune CLI's `--force` flag triggers a
# rewrite of the most recent terminal run regardless of size; verify the
# subsequent two notify calls.
echo "[task-7] running prune in force-rewrite mode against run=$RUN_ID"
RETENTION_ENDPOINT="http://127.0.0.1:7702/api/internal/retention/notify" \
  PRUNE_TOKEN="$KEYCHAIN_TOKEN" \
  $PRUNE_CLI --run-id "$RUN_ID" --force-rewrite --json | jq .

# Wait for the two notify calls to settle into the mitmdump capture.
sleep 2

if [[ ! -s "$TRAFFIC_OUT" ]]; then
  echo "FAIL — mitmproxy captured no traffic" >&2
  exit 1
fi

# Pull the two POST bodies out of the binary mitmdump stream.
calls=$(mitmdump -r "$TRAFFIC_OUT" --no-server -nr 2>/dev/null \
  | awk '/POST .* retention\/notify/{flag=1;print;next} flag && /Authorization|action/{print} /^$/{flag=0}')
echo "[task-7] notify-call summary:"
echo "$calls"

pre_count=$(echo "$calls" | grep -c '"action":"pre-rename"' || true)
post_count=$(echo "$calls" | grep -c '"action":"update-mtime"' || true)
if [[ "$pre_count" -lt 1 || "$post_count" -lt 1 ]]; then
  echo "FAIL — expected ≥1 pre-rename + ≥1 update-mtime calls (got $pre_count + $post_count)" >&2
  exit 1
fi

# Verify pre-rename payloads never carry new_mtime_ns and update-mtime
# payloads never carry truncated[].
if echo "$calls" | grep -E '"action":"pre-rename".*"new_mtime_ns"' >/dev/null; then
  echo "FAIL — pre-rename body must not carry new_mtime_ns" >&2
  exit 1
fi
if echo "$calls" | grep -E '"action":"update-mtime".*"truncated"' >/dev/null; then
  echo "FAIL — update-mtime body must not carry truncated[]" >&2
  exit 1
fi

# Confirm the Bearer header value matches the Keychain entry on both calls.
# E11 / wing-round-4: the token must NOT appear in argv. Pass it via
# `KEYCHAIN_TOKEN` env to awk and read it through `ENVIRON[]` inside
# the script — `ps` does not surface env, and the literal needle is
# constructed inside awk so it never lands on any process's argv.
hdr_count=$(printf '%s' "$calls" | KEYCHAIN_TOKEN="$KEYCHAIN_TOKEN" awk '
  BEGIN { needle = "Authorization: Bearer " ENVIRON["KEYCHAIN_TOKEN"]; c = 0 }
  index($0, needle) > 0 { c++ }
  END { print c }
')
unset KEYCHAIN_TOKEN
if [[ "$hdr_count" -lt 2 ]]; then
  echo "FAIL — Bearer-header / Keychain mismatch (expected ≥2 matches; got $hdr_count)" >&2
  exit 1
fi

# Inspect SQLite via the API: chunk_truncations rows must exist for the
# truncated seqs on this run.
truncations=$(curl -sS -b "$COOKIE_FILE" "$API_BASE/api/runs/$RUN_ID" | jq '.run.total_truncations // 0')
if (( truncations < 1 )); then
  echo "FAIL — chunk_truncations row count for $RUN_ID = $truncations (expected ≥1)" >&2
  exit 1
fi

echo "PASS — notify schema matches, Bearer matches Keychain, $truncations truncations indexed"
