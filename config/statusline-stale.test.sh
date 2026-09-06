#!/usr/bin/env bash
# Regression test for statusline-command.sh's 5H/7D staleness gate (STARK-2652).
#
# The rate-limit windows arrive only in the startup payload and are pinned to the
# seat the `claude` process authenticated to at launch — they never follow a
# mid-session /login or `idun cc` rotation. The gate compares the seat this process
# STARTED under (resolve_startseat, captured on first render + cached per session_id)
# against the live seat; differ → the render shows "—" instead of a rotated-away
# seat's numbers under the current label.
#
# Part 1 asserts the pure predicate usage_windows_stale() truth table (extracted
# from the shipped script, no copy to drift). Part 2 drives the WHOLE script under a
# controlled $HOME to prove resolve_startseat + the render wiring behave: a rotated
# incarnation shows "—", a current one shows its bars, a RESUMED incarnation (same
# session_id, new procstart) re-captures and shows its bars, the cache is written +
# honored + mtime-refreshed on a hit, and an absent session_id falls back permissive.
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
# resolve_startseat keys its cache file on the payload's session_id ($sid) and tags
# the line with this incarnation's procstart. The test forces PROCSTART by seeding
# .statusline-procstart-<PPID> (PPID == this shell's $$ when the script is run
# directly, never inside $(...)), and seeds .statusline-procseat-$SID with a chosen
# `<procstart>\t<seat>` line. Output is written to a file and ANSI-stripped.
PP=$$
PROC=1700000000       # forced PROCSTART for this "incarnation"
SID="test-sid-abc123"
PAYLOAD='{"session_id":"'"$SID"'","model":{"display_name":"Opus","id":"o"},"rate_limits":{"five_hour":{"used_percentage":83,"resets_at":4102444800},"seven_day":{"used_percentage":15,"resets_at":4102444800}},"context_window":{"used_percentage":39}}'
CURSEAT="aaaa:bbbb"   # what ~/.claude.json (the live seat) will say
RH=""; RENDER=""      # set by render_to: temp HOME + ANSI-stripped statusline output

render_to() { # $1 = full line to seed into .statusline-procseat-$SID ("" = no file)
  RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
  printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
  printf '%s\n' "$PROC" > "$RH/.claude/.statusline-procstart-$PP"   # force PROCSTART=$PROC
  [ -n "$1" ] && printf '%b' "$1" > "$RH/.claude/.statusline-procseat-$SID"
  local out="$RH/out"
  HOME="$RH" bash "$SCRIPT" <<<"$PAYLOAD" > "$out" 2>/dev/null
  RENDER="$(sed $'s/\033\[[0-9;]*m//g' "$out")"
}

icheck() { # name  seeded-cache-line  expect(stale|live)
  # The 5H and 7D windows are gated by the SAME usage_stale flag but rendered by
  # two separate copy-pasted blocks, so assert BOTH — a stale/live regression in
  # only the 7D block would otherwise ship unseen.
  local name="$1" cache="$2" want="$3" pat5 pat7 got
  render_to "$cache"
  if [ "$want" = "stale" ]; then pat5='5H —'; pat7='7D —'; else pat5='5H .*83%'; pat7='7D .*15%'; fi
  if grep -qE "$pat5" <<<"$RENDER" && grep -qE "$pat7" <<<"$RENDER"; then got="$want"; else got="other"; fi
  if [ "$got" = "$want" ]; then echo "  ok   $name"; else
    printf '  FAIL %-34s want=%s\n    got: %s\n' "$name" "$want" "$(grep -oE '5H [^|]*| 7D [^|]*' <<<"$RENDER" | head -2 | tr '\n' ' ')"
    FAIL=1; fi
  rm -rf "$RH"
}

# Same incarnation (procstart matches), cached startup seat differs → rotated → stale.
icheck "rotated: cached seat differs"      '1700000000\tcccc:dddd\n' stale
# Same incarnation, cached seat == live seat → on the current seat → live.
icheck "current: cached seat matches"      '1700000000\taaaa:bbbb\n' live
# Resume: same session_id, DIFFERENT (older) procstart → re-capture live seat → live.
icheck "resume: procstart mismatch"        '1699999999\tcccc:dddd\n' live
# No cache yet (first render): captures current seat → live (and writes the cache).
icheck "first render captures + live"      ''                        live

# Payload without a session_id → no cache key → permissive (show the numbers).
_saved_payload="$PAYLOAD"
PAYLOAD='{"model":{"display_name":"Opus","id":"o"},"rate_limits":{"five_hour":{"used_percentage":83,"resets_at":4102444800},"seven_day":{"used_percentage":15,"resets_at":4102444800}},"context_window":{"used_percentage":39}}'
icheck "no session_id → permissive"        ''                        live
PAYLOAD="$_saved_payload"

# First render must persist `<procstart>\t<seat>` so later renders are stable.
render_to ""
if IFS=$'\t' read -r cps cseat < "$RH/.claude/.statusline-procseat-$SID" 2>/dev/null \
   && [ "$cps" = "$PROC" ] && [ "$cseat" = "$CURSEAT" ]; then
  echo "  ok   first render writes <procstart>\\t<seat> keyed by session_id"
else
  echo "  FAIL first render did not write the expected cache (got: '${cps:-}' / '${cseat:-}')"; FAIL=1
fi
rm -rf "$RH"

# A cache HIT must refresh the file's mtime so a live long session is not age-swept.
RH="$(mktemp -d)"; mkdir -p "$RH/.claude"
printf '{"oauthAccount":{"emailAddress":"x@evinced.com","organizationType":"claude_max","accountUuid":"aaaa","organizationUuid":"bbbb"}}' > "$RH/.claude.json"
printf '%s\n' "$PROC" > "$RH/.claude/.statusline-procstart-$PP"
_seat_file="$RH/.claude/.statusline-procseat-$SID"
printf '%b' '1700000000\taaaa:bbbb\n' > "$_seat_file"
touch -t 200001010000 "$_seat_file"                       # backdate to the year 2000
_before="$(stat -f %m "$_seat_file" 2>/dev/null || stat -c %Y "$_seat_file")"
HOME="$RH" bash "$SCRIPT" <<<"$PAYLOAD" >/dev/null 2>&1
_after="$(stat -f %m "$_seat_file" 2>/dev/null || stat -c %Y "$_seat_file")"
if [ "$_after" -gt "$_before" ] 2>/dev/null \
   && IFS=$'\t' read -r cps cseat < "$_seat_file" 2>/dev/null \
   && [ "$cps" = "$PROC" ] && [ "$cseat" = "aaaa:bbbb" ]; then
  echo "  ok   cache hit refreshes mtime, content unchanged"
else
  echo "  FAIL cache hit did not refresh mtime / changed content (before=$_before after=$_after line='${cps:-}/${cseat:-}')"; FAIL=1
fi
rm -rf "$RH"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
