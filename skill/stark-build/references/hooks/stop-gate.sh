#!/bin/bash
# Stop-hook gate for /stark-build task sessions.
# The task's done-when check owns turn-end: red blocks the stop (exit 2,
# reason fed back); green allows it. A logged deviation for this task also
# allows it — abort-with-deviation is a first-class successful exit. At MAX
# consecutive red blocks the HARNESS writes the deviation and lets the turn
# end, so Claude Code's own 8-block override never becomes a silent green.
#
# usage (in a generated settings.json hook command):
#   stop-gate.sh <check-script> <counter-file> <progress-file> <task-id> [max-blocks]
set -uo pipefail # no -e: a red check is the normal path, not a script error

CHECK="${1:?check script}"
COUNTER="${2:?counter file}"
PROGRESS="${3:?progress file}"
TASK="${4:?task id}"
MAX="${5:-7}"

# stdin is CLOSED for the check: a Stop hook's own stdin is the Claude Code
# payload pipe, which never delivers EOF. Any gate that transitively reads
# stdin would block there forever — the same failure class that cost 5h14m on
# a `codex exec` advisory, but worse, because it hangs turn-end inside the
# gate and is indistinguishable from a slow task. Measured: without
# `</dev/null` the check never returns; with it, rc=0 in <1s.
out="$(bash "$CHECK" </dev/null 2>&1)"
rc=$?
if [ "$rc" -eq 0 ]; then
  printf '0' > "$COUNTER"
  exit 0
fi

# Abort path: a deviation logged for this task is a valid exit.
if grep -q "\[deviation\] task=${TASK}" "$PROGRESS" 2>/dev/null; then
  exit 0
fi

n="$(cat "$COUNTER" 2>/dev/null || echo 0)"
case "$n" in '' | *[!0-9]*) n=0 ;; esac
n=$((n + 1))
printf '%s' "$n" > "$COUNTER"

if [ "$n" -ge "$MAX" ]; then
  {
    echo ""
    echo "- [deviation] task=${TASK} class=blocked: gate still red after ${n} consecutive Stop blocks; harness aborted the session. Last check output:"
    echo '```'
    printf '%s\n' "$out" | tail -5
    echo '```'
  } >> "$PROGRESS"
  echo "GATE ABORT: check still red after ${n} blocks. The harness logged a deviation to PROGRESS.md. Stop working on this task." >&2
  exit 0
fi

echo "GATE RED (${n}/${MAX}): the task's check failed — you may not stop yet. Fix the code; never edit the gated check. If the task is genuinely blocked, append '- [deviation] task=${TASK} class=blocked: <why>' to ${PROGRESS} and stop. Check output tail:
$(printf '%s\n' "$out" | tail -20)" >&2
exit 2
