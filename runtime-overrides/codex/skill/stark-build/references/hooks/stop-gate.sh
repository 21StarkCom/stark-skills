#!/bin/bash
# Stop-hook gate for $stark-build task sessions.
# The task's done-when check owns turn-end: red blocks the stop (exit 2,
# reason fed back); green allows it. An exact deviation marker already emitted
# by this task also allows it — abort-with-deviation is a first-class successful
# exit. At MAX consecutive red blocks the hook emits that marker on stdout and
# lets the turn end. It never writes PROGRESS or any other runner record.
#
# usage (in a generated settings.json hook command):
#   stop-gate.sh <check-script> <counter-file> <session-log> <task-id> [max-blocks]
set -uo pipefail # no -e: a red check is the normal path, not a script error

CHECK="${1:?check script}"
COUNTER="${2:?counter file}"
SESSION_LOG="${3:?session log}"
TASK="${4:?task id}"
MAX="${5:-7}"
case "$TASK" in '' | *[!A-Za-z0-9._-]*) echo "invalid task id" >&2; exit 2 ;; esac
case "$MAX" in '' | *[!0-9]*) echo "invalid max-blocks" >&2; exit 2 ;; esac

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

# Abort path: an exact stdout marker already emitted for this task is valid.
# The runner still validates cardinality, class, reason length/printability,
# hashes, and scope before it appends anything to PROGRESS.
if grep -Eq "^STARK_DEVIATION task=${TASK} class=(blocked|spec-defect|scope-move) message=[[:print:]]+$" "$SESSION_LOG" 2>/dev/null; then
  exit 0
fi

n="$(cat "$COUNTER" 2>/dev/null || echo 0)"
case "$n" in '' | *[!0-9]*) n=0 ;; esac
n=$((n + 1))
printf '%s' "$n" > "$COUNTER"

if [ "$n" -ge "$MAX" ]; then
  printf 'STARK_DEVIATION task=%s class=blocked message=gate-still-red-after-%s-stop-blocks\n' "$TASK" "$n"
  echo "GATE ABORT: check still red after ${n} blocks. The hook emitted a marker; the runner owns validation, evidence, and PROGRESS. Stop working on this task. Last check output tail:
$(printf '%s\n' "$out" | tail -5)" >&2
  exit 0
fi

echo "GATE RED (${n}/${MAX}): the task's check failed — you may not stop yet. Fix the code; never edit the gated check. If genuinely blocked, print exactly 'STARK_DEVIATION task=${TASK} class=blocked message=<single-line reason>' on stdout and stop; never write runner state. Check output tail:
$(printf '%s\n' "$out" | tail -20)" >&2
exit 2
