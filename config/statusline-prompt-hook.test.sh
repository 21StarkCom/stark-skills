#!/usr/bin/env bash
# Regression test for statusline-prompt-hook.sh's idle-gap guard (STARK-662):
# a prompt re-stamps prompt_ts only when the last Stop was >= IDLE_GAP seconds
# ago, so machine re-prompts (/loop, cron) firing right after turn-end don't
# reset the 👤 "since enter" clock. Run in CI by tools/statusline_prompt_hook.test.ts.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/statusline-prompt-hook.sh"
command -v jq >/dev/null || { echo "SKIP: jq not installed"; exit 0; }

FAIL=0
# run <stop_age|none> <preset_prompt_ts> -> echoes the prompt_ts the hook left behind
run() {
  local stop_age="$1" preset="$2"
  local home; home="$(mktemp -d)"
  mkdir -p "$home/.claude"
  local now; now="$(date +%s)"
  [ -n "$preset" ] && printf '%s\n' "$((now - preset))" > "$home/.claude/.statusline-prompt-tsid"
  [ "$stop_age" != none ] && printf '%s\n' "$((now - stop_age))" > "$home/.claude/.statusline-stop-tsid"
  HOME="$home" bash "$HOOK" <<<'{"session_id":"tsid"}'
  local v=""; [ -r "$home/.claude/.statusline-prompt-tsid" ] && IFS= read -r v < "$home/.claude/.statusline-prompt-tsid"
  rm -rf "$home"
  # classify: "fresh" if within 3s of now, else the raw age it kept
  if [ -n "$v" ] && [ "$((now - v))" -le 3 ] 2>/dev/null; then echo fresh; else echo "kept:$((now - v))"; fi
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1 — expected=$2 actual=$3"; FAIL=1; fi
}

# Stop 2s ago (machine re-prompt) + preset prompt_ts from 100s ago → guard skips → clock held at 100s
check "recent-stop-holds"   "kept:100" "$(run 2 100)"
# Stop 10s ago (genuine idle) + preset 100s → re-stamps → fresh
check "old-stop-restamps"   "fresh"    "$(run 10 100)"
# No stop file (first prompt) → stamps → fresh
check "no-stop-restamps"    "fresh"    "$(run none 100)"
# Stop exactly at the boundary is not "< gap" (5s ago, gap 5) → re-stamps
check "boundary-restamps"   "fresh"    "$(run 5 100)"

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
