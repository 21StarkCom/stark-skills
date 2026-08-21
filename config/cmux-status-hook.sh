#!/usr/bin/env bash
#
# cmux-status-hook.sh — reflect Claude Code agent state on the cmux sidebar card.
#
# Generic: no personal data. Wire from a Claude Code hook (see
# config/settings.json), passing the state as the first argument:
#
#   UserPromptSubmit  ->  cmux-status-hook.sh working
#   Stop              ->  cmux-status-hook.sh idle
#
# Sets an explicit, colored `claude` status chip you control, complementing
# cmux's own running indicator. No-op outside a cmux surface, so it is safe to
# wire globally. Reads nothing from stdin.
set -euo pipefail

state="${1:-}"
[ -n "${CMUX_WORKSPACE_ID:-}" ] || exit 0
cmux_bin="${CMUX_CLAUDE_HOOK_CMUX_BIN:-cmux}"
command -v "$cmux_bin" >/dev/null 2>&1 || exit 0

set_status() {
  "$cmux_bin" set-status claude "$1" --icon "$2" --color "$3" \
    --workspace "$CMUX_WORKSPACE_ID" >/dev/null 2>&1 || true
}

case "$state" in
  working) set_status "working" "bolt.fill" "#4C8DFF" ;;   # blue
  idle)    set_status "idle"    "moon.fill" "#8B8D98" ;;   # slate
  *)
    printf 'cmux-status-hook.sh: usage: %s <working|idle>\n' "$(basename "$0")" >&2
    exit 2
    ;;
esac
