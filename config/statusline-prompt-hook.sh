#!/usr/bin/env bash
# UserPromptSubmit hook — stamp the prompt-submission epoch for the statusline
# session clocks (line 3). The statusline payload has no "prompt submitted"
# field, so this hook is the single source for both the last-prompt time and
# the elapsed counter: both originate from this one stamp.
# Input: hook JSON on stdin ({session_id, ...}). Keyed per session so
# concurrent Claude Code windows don't clobber each other.
sid=$(jq -r '.session_id // "default"' 2>/dev/null)
sid=${sid//[^a-zA-Z0-9_-]/}
printf '%s\n' "${EPOCHSECONDS:-$(date +%s)}" \
  > "$HOME/.claude/.statusline-prompt-${sid:-default}" 2>/dev/null
exit 0
