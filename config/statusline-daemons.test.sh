#!/usr/bin/env bash
# Integration test for the statusline daemon-health segment (line 3 tail).
#
# Covers the FORK-FREE resolvers under a controlled $HOME:
#   • idun   — state-file lastPoll {at, ok} → 🟢 fresh+ok / 🟡 fresh+failed or behind
#              / 🔴 frozen or missing.
#   • alfred — alfredd.lock pid + the kill -0 builtin → 🟢 alive / 🔴 dead or no lock.
# frigg-cache-sync reads system launchd state via `launchctl list`, which a
# controlled $HOME cannot isolate (and which is absent on CI), so it is NOT asserted.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline-command.sh"
FAIL=0
NOW="$(printf '%(%s)T' -1)"
PAYLOAD='{"model":{"display_name":"Opus","id":"o"},"context_window":{"used_percentage":10}}'
G=🟢; Y=🟡; RD=🔴

# idun state file carrying a lastPoll {at, ok}. $1 = ok (true|false)  $2 = at-epoch.
idun_state() { printf '{ "startedAt": 1, "perSeat": {}, "lastPoll": { "at": %s, "ok": %s, "detail": "" } }\n' "$2" "$1"; }

# Render line 3 under a controlled HOME. $1 = alfred pid ("" = no lock file)
# $2 = idun-state file content ("" = no file). Sets L3 (ANSI-stripped line 3).
render_l3() {
  local RH out; RH="$(mktemp -d)"; mkdir -p "$RH/.claude" "$RH/.local/state/alfred"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  [ -n "$1" ] && printf '%s\n' "$1" > "$RH/.local/state/alfred/alfredd.lock"
  [ -n "$2" ] && printf '%s\n' "$2" > "$RH/.claude/.idun-daemon-state.json"
  out="$RH/out"; HOME="$RH" bash "$SCRIPT" <<<"$PAYLOAD" > "$out" 2>/dev/null
  L3="$(sed -n '3p' "$out" | sed $'s/\033\[[0-9;]*m//g')"
  rm -rf "$RH"
}

want() { # name  expected-substring
  if grep -qF "$2" <<<"$L3"; then echo "  ok   $1"; else
    printf '  FAIL %-34s want %q in: %s\n' "$1" "$2" "$L3"; FAIL=1; fi
}

# ── alfred: pid liveness ─────────────────────────────────────────────────────
render_l3 "$$"          "" ; want "alfred: own pid alive → green" "alfred$G"
render_l3 "2147483647"  "" ; want "alfred: dead pid → red"        "alfred$RD"
render_l3 ""            "" ; want "alfred: no lock file → red"     "alfred$RD"

# ── idun: lastPoll health ────────────────────────────────────────────────────
render_l3 "$$" "$(idun_state true  "$NOW")"           ; want "idun: fresh + ok → green"       "idun$G"
render_l3 "$$" "$(idun_state false "$NOW")"           ; want "idun: fresh + failed poll → yellow" "idun$Y"
render_l3 "$$" "$(idun_state true  "$((NOW - 99999))")"; want "idun: frozen lastPoll → red"     "idun$RD"
render_l3 "$$" ""                                      ; want "idun: no state file → red"       "idun$RD"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
