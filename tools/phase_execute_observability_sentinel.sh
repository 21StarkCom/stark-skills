#!/bin/sh
# Phase 6 Task 3: lease-checking session sentinel for /stark-phase-execute.
#
# Purpose: act as the daemon's tracked-parent pid for the entire phase-execute
# SKILL run. The SKILL.md bash blocks are NOT guaranteed to share a parent
# shell — Claude Code may exec each block in a fresh `/bin/bash -c '…'` whose
# `$$` differs across blocks. Tracking `$$` as `--skill-pid` would race the
# daemon's 30s `kill(pid, 0)` poll into a spurious `crashed` transition the
# moment the first block's transient shell exits, even while the SKILL is
# legitimately executing later blocks.
#
# Contract: the SKILL is RESPONSIBLE for touching the lease file at the start
# of every bash block. This sentinel:
#   - polls every 15s, statting the lease file
#   - exits 0 when the lease is missing OR its mtime is older than $LEASE_TTL_S
#
# On exit, the writer daemon's 30s `kill(sentinel_pid, 0)` poll observes ESRCH
# and writes the canonical crashed `run_end` with `crashed_reason: "parent_exit"`.
# Total worst-case from SKILL abort → crashed transition: ~225s.
#
# Usage: phase_execute_observability_sentinel.sh <lease_path> <ttl_seconds>

set -u

LEASE_PATH="${1:-}"
TTL_S="${2:-180}"
POLL_S="15"

if [ -z "$LEASE_PATH" ]; then
  echo "sentinel: lease path required" >&2
  exit 2
fi

# Detach from controlling terminal (best-effort) so SIGHUP from the launching
# shell does not kill us. setsid is not POSIX but is on macOS via util-linux
# port; fall back silently if unavailable.
if command -v setsid >/dev/null 2>&1 && [ -z "${SENTINEL_DETACHED:-}" ]; then
  SENTINEL_DETACHED=1 exec setsid "$0" "$LEASE_PATH" "$TTL_S"
fi

# Cross-platform mtime: GNU stat uses `-c %Y`; BSD/macOS stat uses `-f %m`.
mtime_of() {
  if stat -f %m "$1" 2>/dev/null; then return; fi
  stat -c %Y "$1" 2>/dev/null
}

while :; do
  if [ ! -e "$LEASE_PATH" ]; then
    exit 0
  fi
  mt=$(mtime_of "$LEASE_PATH")
  if [ -z "$mt" ]; then
    # Lease vanished between -e and stat; treat as gone.
    exit 0
  fi
  now=$(date +%s)
  age=$(( now - mt ))
  if [ "$age" -gt "$TTL_S" ]; then
    exit 0
  fi
  sleep "$POLL_S"
done
