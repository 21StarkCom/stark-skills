#!/usr/bin/env bash
# Integration test for statusline-command.sh's 5H/7D usage-bar render.
#
# The rate-limit windows in the stdin payload are frozen to the seat this `claude`
# process authenticated to at launch, so after a mid-session /login or `idun cc`
# rotation they belong to a rotated-away seat. STARK-2807 dropped the launch-seat
# staleness gate in favor of reading the idun daemon's LIVE poll of the current seat
# (~/.claude/.idun-daemon-state.json). Each window renders as a usage bar filled from
# that daemon reading when present+fresh, falling back to the frozen payload only
# when the daemon has no usable value for this seat.
#
# This drives the WHOLE script under a controlled $HOME with a seeded daemon-state
# file and asserts the rendered percent per window. Three load-bearing invariants:
# (1) the SEAT-KEY GUARD — the daemon figure must come from THIS seat's object, and a
# seat absent from the state falls back to the payload, never a neighbour's number
# (the `== *"<seat>": {*` guard); (2) the FRESHNESS GATE — a present-but-stale entry
# (stampedAt older than DAEMON_TTL: a dead daemon, or a seat idun stopped polling)
# falls back too, never painting its frozen number as live; and (3) the < 0 SENTINEL
# — idun's "no data" value is treated as absent. Any of the three, if broken, paints
# the WRONG number, which asserting the correct per-seat value here catches.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline-command.sh"
FAIL=0

# A "now" stampedAt so fixtures pass the daemon freshness gate (NOW - stampedAt <=
# DAEMON_TTL). STALE is far in the past to exercise the gate's reject path.
FRESH="$(printf '%(%s)T' -1)"
STALE=1700000000

# ~/.claude.json resolves acct_seat = accountUuid:organizationUuid → "aaaa:bbbb".
PAYLOAD_LIMITS='{"model":{"display_name":"Opus","id":"o"},"five_hour":{"used_percentage":83,"resets_at":4102444800},"seven_day":{"used_percentage":15,"resets_at":4102444800},"context_window":{"used_percentage":39}}'
PAYLOAD_NOLIMITS='{"model":{"display_name":"Opus","id":"o"},"context_window":{"used_percentage":39}}'

# A daemon-state file whose perSeat carries the given seat key with fivePct=36,
# weekPct=53. Format mirrors idun's JSON.stringify(state, null, 2): the `"<seat>": {`
# opener (space after the colon) is what the reader slices on. stampedAt defaults to
# a fresh "now" so the entry passes the reader's freshness gate; pass $STALE to test
# the reject path.
daemon_state() { # $1 = seat key  [$2 = stampedAt, default fresh]
  local stamp="${2:-$FRESH}"
  cat <<JSON
{
  "startedAt": 1,
  "perSeat": {
    "$1": {
      "seatKey": "$1",
      "email": "x@evinced.com",
      "fivePct": 36,
      "fiveReset": 4102444800,
      "weekPct": 53,
      "weekReset": 4102444800,
      "stampedAt": $stamp
    }
  },
  "lastPoll": { "at": $stamp, "ok": true, "detail": "" }
}
JSON
}

# Multi-seat state: a decoy BEFORE and AFTER the current seat (aaaa:bbbb), each with
# distinct numbers, so a slice that anchored on the wrong `}` or leaked a neighbour
# would surface 11/22 or 99/88 instead of the current seat's 36/53.
daemon_state_multi() {
  cat <<JSON
{
  "startedAt": 1,
  "perSeat": {
    "first:seat": {
      "seatKey": "first:seat", "email": "a@evinced.com",
      "fivePct": 11, "fiveReset": 4102444800, "weekPct": 22, "weekReset": 4102444800, "stampedAt": $FRESH
    },
    "aaaa:bbbb": {
      "seatKey": "aaaa:bbbb", "email": "x@evinced.com",
      "fivePct": 36, "fiveReset": 4102444800, "weekPct": 53, "weekReset": 4102444800, "stampedAt": $FRESH
    },
    "zzzz:wwww": {
      "seatKey": "zzzz:wwww", "email": "z@evinced.com",
      "fivePct": 99, "fiveReset": 4102444800, "weekPct": 88, "weekReset": 4102444800, "stampedAt": $FRESH
    }
  },
  "lastPoll": { "at": $FRESH, "ok": true, "detail": "" }
}
JSON
}

# Sentinel state: the current seat is fresh but reports fivePct=-1 / weekPct=-1
# (idun's "no data"), which the reader must treat as absent → fall back to payload.
daemon_state_neg() { # $1 = seat key
  cat <<JSON
{
  "startedAt": 1,
  "perSeat": {
    "$1": {
      "seatKey": "$1", "email": "x@evinced.com",
      "fivePct": -1, "fiveReset": 4102444800, "weekPct": -1, "weekReset": 4102444800, "stampedAt": $FRESH
    }
  },
  "lastPoll": { "at": $FRESH, "ok": true, "detail": "" }
}
JSON
}

render() { # $1 = payload  $2 = daemon-state file content ("" = no file) → sets RENDER
  local RH out; RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  [ -n "$2" ] && printf '%s\n' "$2" > "$RH/.claude/.idun-daemon-state.json"
  out="$RH/out"; HOME="$RH" bash "$SCRIPT" <<<"$1" > "$out" 2>/dev/null
  RENDER="$(sed $'s/\033\[[0-9;]*m//g' "$out")"
  rm -rf "$RH"
}

# Extract the 5H and 7D segments (each `|`-delimited) and assert the expected percent
# lands in the RIGHT one. Because the bar is filled from the daemon reading when
# usable and the payload otherwise, asserting the correct number in the correct
# window doubles as the seat-guard / freshness / sentinel proof: a leaked neighbour,
# an ungated stale entry, or an un-rejected sentinel would put the WRONG number there
# and fail the match. 36/53 = daemon, 83/15 = payload, decoys = 11/22 & 99/88.
check() { # name  payload  daemon-content  want5  want7  (percent substrings, e.g. " 36%")
  local name="$1"; render "$2" "$3"
  local seg5 seg7
  seg5="$(grep -oE '5H [^|]*' <<<"$RENDER" | head -1)"
  seg7="$(grep -oE '7D [^|]*' <<<"$RENDER" | head -1)"
  if [[ $seg5 == *"$4"* ]] && [[ $seg7 == *"$5"* ]]; then
    echo "  ok   $name"
  else
    printf '  FAIL %-40s want: 5H~%q 7D~%q\n    got: 5H=%q 7D=%q\n' "$name" "$4" "$5" "$seg5" "$seg7"
    FAIL=1
  fi
}

# Daemon present + fresh → its live number fills the bar (payload is the fallback,
# not shown).
check "daemon present → daemon value"   "$PAYLOAD_LIMITS"   "$(daemon_state aaaa:bbbb)" " 36%" " 53%"
# Payload has no rate_limits, daemon present → daemon still fills the bar.
check "payload absent, daemon present"  "$PAYLOAD_NOLIMITS" "$(daemon_state aaaa:bbbb)" " 36%" " 53%"
# No daemon file at all → fall back to the payload's frozen number.
check "daemon missing → payload"        "$PAYLOAD_LIMITS"   ""                          " 83%" " 15%"
# SEAT GUARD: daemon file present but keyed ONLY under a DIFFERENT seat. The current
# seat (aaaa:bbbb) is absent, so the bar falls back to the payload (83/15) — a leak
# would show zzzz's 36/53.
check "cross-seat absent → payload"     "$PAYLOAD_LIMITS" "$(daemon_state zzzz:wwww)"  " 83%" " 15%"
# SEAT GUARD 2: the current seat sits BETWEEN two decoys. The slice must pick
# aaaa:bbbb's 36/53 — never first:seat's 11/22 or zzzz:wwww's 99/88.
check "multi-seat picks current"        "$PAYLOAD_LIMITS" "$(daemon_state_multi)"      " 36%" " 53%"
# FRESHNESS GATE: the current seat is present but its stampedAt is older than
# DAEMON_TTL. Its frozen number MUST NOT paint the bar — fall back to the payload.
check "stale daemon → payload"          "$PAYLOAD_LIMITS" "$(daemon_state aaaa:bbbb "$STALE")" " 83%" " 15%"
# SENTINEL: a daemon value < 0 (idun "no data") is treated as absent → payload fallback.
check "daemon <0 sentinel → payload"    "$PAYLOAD_LIMITS" "$(daemon_state_neg aaaa:bbbb)" " 83%" " 15%"
# NEITHER source has a value → dim-empty bar with an em-dash, no percent.
check "both absent → dash"              "$PAYLOAD_NOLIMITS" ""                          "—"   "—"

# ── Bound-ticket segment (STARK-4405) ────────────────────────────────────────
# alfred mirrors the session's bound ticket to ~/.claude/.statusline-task-<sid>
# as "<id>\t<title>". The statusline shows "<id> · <title>" in place of the
# session_name segment, and falls back to the session name when unbound (no file).
TAB=$'\t'
PAYLOAD_TASK='{"model":{"display_name":"Opus","id":"o"},"context_window":{"used_percentage":39},"session_id":"sessabc","session_name":"my-worktree"}'

# Seed $HOME/.claude/.statusline-task-<sid> (sid from the payload) then render.
render_with_task() { # $1=payload  $2=task-file-content ("" = no file) → sets RENDER
  local RH out sid; RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  sid="$(sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p' <<<"$1")"
  [ -n "$2" ] && printf '%s' "$2" > "$RH/.claude/.statusline-task-${sid}"
  out="$RH/out"; HOME="$RH" bash "$SCRIPT" <<<"$1" > "$out" 2>/dev/null
  RENDER="$(sed $'s/\033\[[0-9;]*m//g' "$out")"
  rm -rf "$RH"
}

checkT() { # name  want-substring  notwant-substring ("" to skip the absence check)
  if grep -qF "$2" <<<"$RENDER" && { [ -z "$3" ] || ! grep -qF "$3" <<<"$RENDER"; }; then
    echo "  ok   $1"
  else
    printf '  FAIL %-42s want:%q not:%q\n    got line1: %s\n' "$1" "$2" "$3" "$(sed -n 1p <<<"$RENDER")"
    FAIL=1
  fi
}

render_with_task "$PAYLOAD_TASK" "STARK-4405${TAB}render bound task title"
checkT "bound ticket shows id · title"        "STARK-4405 · render bound task title" ""
checkT "bound ticket replaces session name"   "STARK-4405"  "my-worktree"
render_with_task "$PAYLOAD_TASK" ""
checkT "unbound falls back to session name"    "my-worktree" "STARK-4405"
render_with_task "$PAYLOAD_TASK" "STARK-4405${TAB}"
checkT "title-less mirror shows id only"        "STARK-4405"  " · "
# A literal backslash in the (untrusted) title must NOT be re-interpreted by the
# final printf %b: without the escape, "a\nb" would inject a newline (and "\c" would
# blank the rest of the statusline). It must render byte-for-byte.
render_with_task "$PAYLOAD_TASK" "STARK-4405${TAB}a\\nb"
checkT "backslash in title is not %b-interpreted" 'STARK-4405 · a\nb' ''

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
