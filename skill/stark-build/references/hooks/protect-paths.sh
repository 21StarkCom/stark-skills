#!/bin/bash
# PreToolUse path-deny for /stark-build task sessions.
# Blocks writes to gated files (spec, gated existing tests, harness scripts,
# CI config). Deterministic deny — exit 2 blocks the tool call; prompts are
# never the gate. Belt only: the runner's post-task diff-vs-protected-list
# check is the deterministic backstop for anything that slips through Bash.
#
# usage (in a generated settings.json hook command):
#   protect-paths.sh <protected-list-file>
# The list file holds one absolute path (file or dir prefix) per line.
set -euo pipefail

LIST="${1:?usage: protect-paths.sh <protected-list-file>}"
[ -f "$LIST" ] || exit 0

payload="$(cat)"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"

deny() {
  echo "BLOCKED: '$1' is write-protected for this run (spec / gated check / harness). Add NEW files instead of editing gated ones. If the gate itself is wrong, append a deviation line to PROGRESS.md and stop — abort is a valid outcome." >&2
  exit 2
}

case "$tool" in
  Edit|Write|NotebookEdit)
    path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
    [ -n "$path" ] || exit 0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      case "$path" in "$p" | "$p"/*) deny "$path" ;; esac
    done < "$LIST"
    ;;
  Bash)
    cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
    [ -n "$cmd" ] || exit 0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      esc="$(printf '%s' "$p" | sed 's/[.[\*^$/]/\\&/g')"
      # In-place mutation of the protected path, redirect INTO it, or sed -i
      # on it. Running/reading it (incl. redirecting its OUTPUT elsewhere) is fine.
      if printf '%s' "$cmd" | grep -qE "(^|[;&| ])(rm|mv|cp|tee|truncate|chmod|ln)([^;|&]*[ =])${esc}" \
        || printf '%s' "$cmd" | grep -qE ">[> ]*[\"']?${esc}" \
        || printf '%s' "$cmd" | grep -qE "sed[^;|&]*-i[^;|&]*${esc}"; then
        deny "$p"
      fi
    done < "$LIST"
    ;;
esac
exit 0
