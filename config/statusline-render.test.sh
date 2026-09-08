#!/usr/bin/env bash
# Integration test for statusline-command.sh's 5H/7D dual-source render.
#
# The rate-limit windows in the stdin payload are frozen to the seat this `claude`
# process authenticated to at launch, so after a mid-session /login or `idun cc`
# rotation they belong to a rotated-away seat. STARK-2807 dropped the launch-seat
# staleness gate in favor of reading the idun daemon's LIVE poll of the current seat
# (~/.claude/.idun-daemon-state.json) and rendering both side by side: `5H (P%/D%)`
# where P = payload (launch, frozen) and D = daemon (current, live).
#
# This drives the WHOLE script under a controlled $HOME with a seeded daemon-state
# file and asserts the render. Two load-bearing invariants: (1) the SEAT-KEY GUARD —
# the daemon figure must come from THIS seat's object, and a seat absent from the
# state renders "—", never a neighbour's number (the `== *"<seat>": {*` guard); and
# (2) the FRESHNESS GATE — a present-but-stale entry (stampedAt older than DAEMON_TTL:
# a dead daemon, or a seat idun stopped polling) must render "—", not its frozen
# numbers, or the redesign reintroduces the confident-wrong-number failure it killed.
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

render() { # $1 = payload  $2 = daemon-state file content ("" = no file) → sets RENDER
  local RH out; RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  [ -n "$2" ] && printf '%s\n' "$2" > "$RH/.claude/.idun-daemon-state.json"
  out="$RH/out"; HOME="$RH" bash "$SCRIPT" <<<"$1" > "$out" 2>/dev/null
  RENDER="$(sed $'s/\033\[[0-9;]*m//g' "$out")"
  rm -rf "$RH"
}

check() { # name  render-input-payload  daemon-content  want5  want7  (literal substrings)
  local name="$1"; render "$2" "$3"
  if grep -qF "$4" <<<"$RENDER" && grep -qF "$5" <<<"$RENDER"; then
    echo "  ok   $name"
  else
    printf '  FAIL %-40s want: %q + %q\n    got: %s\n' "$name" "$4" "$5" \
      "$(grep -oE '5H [^|]*\| 7D [^|]*' <<<"$RENDER" | head -1)"
    FAIL=1
  fi
}

# Both sources present → payload / daemon, each its own number.
check "both present"          "$PAYLOAD_LIMITS"   "$(daemon_state aaaa:bbbb)" "5H (83%/36%)" "7D (15%/53%)"
# Payload has no rate_limits → payload side "—", daemon side live.
check "payload absent"        "$PAYLOAD_NOLIMITS" "$(daemon_state aaaa:bbbb)" "5H (—/36%)"   "7D (—/53%)"
# No daemon file at all → daemon side "—", payload side shown.
check "daemon file missing"   "$PAYLOAD_LIMITS"   ""                          "5H (83%/—)"   "7D (15%/—)"
# THE GUARD: daemon file present but keyed ONLY under a DIFFERENT seat. The current
# seat (aaaa:bbbb) is absent, so the daemon side MUST be "—" — never zzzz's 36/53.
check "cross-seat guard: absent seat → —" "$PAYLOAD_LIMITS" "$(daemon_state zzzz:wwww)" "5H (83%/—)" "7D (15%/—)"
# THE GUARD, part 2: the current seat sits BETWEEN two decoys with distinct numbers.
# The slice must pick aaaa:bbbb's 36/53 — never first:seat's 11/22 or zzzz:wwww's 99/88.
check "multi-seat: picks current, not neighbours" "$PAYLOAD_LIMITS" "$(daemon_state_multi)" "5H (83%/36%)" "7D (15%/53%)"
# FRESHNESS GATE: the current seat is present but its stampedAt is older than
# DAEMON_TTL (a dead/asleep daemon, or a seat idun stopped polling). Its frozen
# numbers MUST NOT be painted as live — daemon side shows "—".
check "stale daemon entry → —" "$PAYLOAD_LIMITS" "$(daemon_state aaaa:bbbb "$STALE")" "5H (83%/—)" "7D (15%/—)"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
