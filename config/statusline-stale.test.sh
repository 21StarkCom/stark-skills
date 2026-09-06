#!/usr/bin/env bash
# Regression test for statusline-command.sh's 5H/7D staleness gate (STARK-2652).
#
# The rate-limit windows arrive only in the startup payload and are pinned to the
# seat the `claude` process authenticated to at launch — they never follow a
# mid-session /login or `idun cc` rotation. The gate compares the seat this process
# STARTED under (resolve_startseat, captured on first render + cached per claude pid)
# against the live seat; differ → the render shows "—" instead of a rotated-away
# seat's numbers under the current label.
#
# Part 1 asserts the pure predicate usage_windows_stale() truth table (extracted
# from the shipped script, no copy to drift). Part 2 drives the WHOLE script under a
# controlled $HOME to prove resolve_startseat + the render wiring behave: a rotated
# process shows "—", a current process shows its bars, and the per-pid seat cache is
# written + honored + self-invalidated on pid reuse (different procstart).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline-command.sh"

eval "$(sed -n '/^usage_windows_stale() {/,/^}/p' "$SCRIPT")"
type usage_windows_stale >/dev/null 2>&1 || {
  echo "FAIL: could not extract usage_windows_stale from $SCRIPT"; exit 1; }

FAIL=0

# ── Part 1: pure predicate ──────────────────────────────────────────────────
# usage_windows_stale <current_seat> <startup_seat>  → exit 0 == stale.
pcheck() {
  local name="$1" cur="$2" start="$3" want="$4" got
  if usage_windows_stale "$cur" "$start"; then got=stale; else got=fresh; fi
  if [ "$got" = "$want" ]; then echo "  ok   $name"; else
    printf '  FAIL %-28s want=%s got=%s (cur=%q start=%q)\n' "$name" "$want" "$got" "$cur" "$start"
    FAIL=1; fi
}
pcheck "seat rotated away"        "b:new" "a:old" stale
pcheck "same seat"                "a:one" "a:one" fresh
pcheck "current unknown"          ""      "a:old" fresh   # permissive
pcheck "startup unknown"          "b:new" ""      fresh   # permissive (first render race)
pcheck "both unknown"             ""      ""      fresh

# ── Part 2: full-script integration (resolve_startseat + render) ─────────────
# resolve_startseat keys its cache on the payload's session_id ($sid) — unique per
# session, never recycled — so a pre-seeded .statusline-procseat-<sid> forces the
# captured startup seat regardless of pid. The script is run directly with file
# redirection (never inside $(...)), and output is ANSI-stripped for matching.
SID="test-sid-abc123"
PAYLOAD='{"session_id":"'"$SID"'","model":{"display_name":"Opus","id":"o"},"rate_limits":{"five_hour":{"used_percentage":83,"resets_at":4102444800},"seven_day":{"used_percentage":15,"resets_at":4102444800}},"context_window":{"used_percentage":39}}'
CURSEAT="aaaa:bbbb"   # what ~/.claude.json (the live seat) will say
RH=""; RENDER=""      # set by render_to: temp HOME + ANSI-stripped statusline output

render_to() { # $1 = seat to seed into .statusline-procseat-$SID ("" = no cache file)
  RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  [ -n "$1" ] && printf '%s\n' "$1" > "$RH/.claude/.statusline-procseat-$SID"
  local out="$RH/out"
  HOME="$RH" bash "$SCRIPT" <<<"$PAYLOAD" > "$out" 2>/dev/null
  RENDER="$(sed $'s/\033\[[0-9;]*m//g' "$out")"
}

icheck() { # name  seeded-startup-seat  expect(stale|live)
  local name="$1" cache="$2" want="$3" want_pat got
  render_to "$cache"
  if [ "$want" = "stale" ]; then want_pat='5H —'; else want_pat='5H .*83%'; fi
  if grep -qE "$want_pat" <<<"$RENDER"; then got="$want"; else got="other"; fi
  if [ "$got" = "$want" ]; then echo "  ok   $name"; else
    printf '  FAIL %-32s want=%s\n    got: %s\n' "$name" "$want" "$(grep -oE '5H [^|]*' <<<"$RENDER" | head -1)"
    FAIL=1; fi
  rm -rf "$RH"
}

# Cached startup seat differs from the live seat → rotated away → stale.
icheck "rotated: cached seat differs"  "cccc:dddd" stale
# Cached startup seat == live seat → this session is on the current seat → live.
icheck "current: cached seat matches"  "aaaa:bbbb" live
# No cache yet (first render): captures current seat → live (and writes the cache).
icheck "first render captures + live"  ""          live

# Payload without a session_id → no cache key → permissive (show the numbers).
_saved_payload="$PAYLOAD"
PAYLOAD='{"model":{"display_name":"Opus","id":"o"},"rate_limits":{"five_hour":{"used_percentage":83,"resets_at":4102444800},"seven_day":{"used_percentage":15,"resets_at":4102444800}},"context_window":{"used_percentage":39}}'
icheck "no session_id → permissive"    ""          live
PAYLOAD="$_saved_payload"

# First render must persist the per-session seat cache so later renders are stable.
render_to ""
if IFS= read -r cseat < "$RH/.claude/.statusline-procseat-$SID" 2>/dev/null \
   && [ "$cseat" = "$CURSEAT" ]; then
  echo "  ok   first render writes the <seat> cache keyed by session_id"
else
  echo "  FAIL first render did not write the expected seat cache (got: '${cseat:-}')"; FAIL=1
fi
rm -rf "$RH"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
