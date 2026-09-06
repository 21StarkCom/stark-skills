#!/usr/bin/env bash
# Regression test for statusline-command.sh's usage_windows_stale() gate (STARK-2652).
#
# The 5H/7D rate-limit windows arrive only in the startup payload and are pinned to
# the seat the `claude` process authenticated to at launch — they never follow a
# mid-session /login or `idun cc` rotation. usage_windows_stale() decides whether
# THIS process's payload windows belong to a rotated-away seat, so the render can
# show "—" instead of a confident wrong number. This asserts the truth table,
# especially the two directions that must stay PERMISSIVE (unresolvable → show the
# numbers, unchanged) and the boundary (procstart == since is fresh, matching the
# snapshot-write guard's `>=`).
#
# It extracts usage_windows_stale() straight from the shipped script (no copy to
# drift). Run in CI by tools/statusline_stale.test.ts; runnable directly.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline-command.sh"

eval "$(sed -n '/^usage_windows_stale() {/,/^}/p' "$SCRIPT")"
type usage_windows_stale >/dev/null 2>&1 || {
  echo "FAIL: could not extract usage_windows_stale from $SCRIPT"; exit 1; }

FAIL=0
# name  seat  procstart  since  want(stale|fresh)
check() {
  local name="$1" seat="$2" ps="$3" since="$4" want="$5" got
  if usage_windows_stale "$seat" "$ps" "$since"; then got=stale; else got=fresh; fi
  if [ "$got" = "$want" ]; then
    echo "  ok   $name"
  else
    printf '  FAIL %-28s want=%s got=%s (seat=%q ps=%q since=%q)\n' \
      "$name" "$want" "$got" "$seat" "$ps" "$since"
    FAIL=1
  fi
}

# STALE only when proven: seat known + both epochs resolvable + procstart < since.
check "process predates seat"        seat 100 200 stale
check "one second before"            seat 199 200 stale

# FRESH: process started at/after the seat became current (write-guard boundary).
check "process == seat since"        seat 200 200 fresh
check "process after seat"           seat 300 200 fresh

# PERMISSIVE (never claim stale when we cannot prove it) — these keep the numbers.
check "empty seat"                   ""   100 200 fresh
check "procstart unresolved (0)"     seat 0   200 fresh
check "procstart empty"              seat ""  200 fresh
check "since unresolved (0)"         seat 100 0   fresh
check "since empty (no marker yet)"  seat 100 ""  fresh
check "both unresolved"              ""   0   0   fresh
check "non-numeric procstart"        seat abc 200 fresh
check "non-numeric since"            seat 100 xyz fresh

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
