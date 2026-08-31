#!/usr/bin/env bash
# Stop hook — stamp the turn-end epoch for the statusline session clocks
# (line 3). The statusline payload carries no "agent finished / waiting" field,
# so this hook is the single source for the last-response time AND for the
# running-vs-idle decision the status segment keys off: the agent is running
# whenever the prompt stamp is newer than this stop stamp (prompt_ts >= stop_ts),
# idle once Stop fires and moves this stamp past the prompt stamp.
# Sibling of statusline-prompt-hook.sh (UserPromptSubmit); the two stamps share
# no state but are read together in statusline-command.sh line 3.
# Input: hook JSON on stdin ({session_id, ...}). Keyed per session so
# concurrent Claude Code windows don't clobber each other.
sid=$(jq -r '.session_id // "default"' 2>/dev/null)
sid=${sid//[^a-zA-Z0-9_-]/}
now="${EPOCHSECONDS:-$(date +%s)}"
printf '%s\n' "$now" \
  > "$HOME/.claude/.statusline-stop-${sid:-default}" 2>/dev/null

# Surface-addressable activity stamp — the fleet cockpit (hermod) reads this
# file's mtime per surface for its LAST ACTIVE column. Keyed by the STABLE cmux
# surface UUID ($CMUX_SURFACE_ID, present in-process), because the session-id
# stamp above is not reachable from outside the process (the cmux session store
# drifts on resume/fork). Best-effort; absent when not running under cmux.
if [ -n "$CMUX_SURFACE_ID" ]; then
  _sfid=${CMUX_SURFACE_ID//[^a-zA-Z0-9_-]/}
  printf '%s\n' "$now" > "$HOME/.claude/.surface-activity-${_sfid}" 2>/dev/null
fi
exit 0
