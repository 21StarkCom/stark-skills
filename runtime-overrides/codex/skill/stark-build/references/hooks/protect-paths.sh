#!/bin/bash
# PreToolUse path-deny for $stark-build task sessions.
# Blocks writes to gated files (spec, gated existing tests, harness scripts,
# CI config). Deterministic deny — exit 2 blocks the tool call; prompts are
# never the gate. Belt only: the runner's post-task diff-vs-protected-list
# check is the deterministic backstop for anything that slips through Bash.
#
# usage (in a generated settings.json hook command):
#   protect-paths.sh <protected-list-file> <task-id>
# The list file holds one absolute path (file or dir prefix) per line.
set -euo pipefail

LIST="${1:?usage: protect-paths.sh <protected-list-file> <task-id>}"
TASK="${2:?usage: protect-paths.sh <protected-list-file> <task-id>}"
case "$TASK" in '' | *[!A-Za-z0-9._-]*) echo "invalid task id" >&2; exit 2 ;; esac
[ -f "$LIST" ] || { echo "BLOCKED: protected list is missing" >&2; exit 2; }

payload="$(cat)"
tool="$(printf '%s' "$payload" | jq -r '.tool_name // empty')"

deny() {
  printf 'STARK_DEVIATION task=%s class=blocked message=attempted-write-to-runner-protected-path\n' "$TASK"
  echo "BLOCKED: '$1' is runner-owned and write-protected. Stop; do not edit runner state. The runner will validate the stdout marker and record the deviation." >&2
  exit 2
}

# Strip trailing slashes from a list entry. A directory written as
# `/state/tasks/` would otherwise build the glob `/state/tasks//*`, whose double
# slash matches NOTHING — silently disabling write protection for every file
# under it while the entry looks correct. Verified: with the trailing slash,
# `/state/tasks/T1/check.sh` is ALLOWED; without it, DENIED. The runner is an
# LLM filling a template, so normalize here rather than relying on the prose.
norm() {
  p="$1"
  while [ "${p%/}" != "$p" ] && [ "$p" != "/" ]; do p="${p%/}"; done
  printf '%s' "$p"
}

case "$tool" in
  Edit|Write|NotebookEdit)
    path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')"
    [ -n "$path" ] || exit 0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      p="$(norm "$p")"
      [ -n "$p" ] || continue
      case "$path" in "$p" | "$p"/*) deny "$path" ;; esac
    done < "$LIST"
    ;;
  Bash)
    cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')"
    [ -n "$cmd" ] || exit 0
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      p="$(norm "$p")"
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
