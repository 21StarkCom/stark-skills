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
printf '%s\n' "${EPOCHSECONDS:-$(date +%s)}" \
  > "$HOME/.claude/.statusline-stop-${sid:-default}" 2>/dev/null
exit 0
