#!/usr/bin/env bash
# UserPromptSubmit hook — stamp the prompt-submission epoch for the statusline
# session clocks (line 3, the 👤 "since enter" segment). The statusline payload
# has no "prompt submitted" field, so this hook is the single source for it.
# Input: hook JSON on stdin ({session_id, ...}). Keyed per session so concurrent
# Claude Code windows don't clobber each other.
#
# IDLE-GAP GUARD (STARK-662). UserPromptSubmit fires for machine-generated
# re-prompts too — `/loop` iterations and scheduled/cron re-invocations — not
# just a human keystroke. Those re-fire within a second or two of the turn
# ending, so without a guard the 👤 clock resets to ~0 between agent actions in
# any looped/scheduled session (the reported bug). The discriminator: a genuine
# human "enter" lands after the agent has actually been idle a while, whereas a
# machine re-prompt lands almost immediately after Stop. So only re-stamp when
# the last Stop (statusline-stop-<sid>, written by statusline-stop-hook.sh) was
# at least IDLE_GAP seconds ago; a prompt arriving sooner is treated as a
# continuation and the clock holds.
#
# Tradeoff (accepted): a human follow-up sent within IDLE_GAP seconds of the
# agent finishing won't move the clock either — 👤 then reads from the prior
# message. Harmless, and the alternative (resetting on machine re-prompts) is
# the bug being fixed. A long-interval `/loop` (gap > IDLE_GAP) is not
# suppressed — by then the idle really was a genuine gap. Tune via the
# STATUSLINE_PROMPT_IDLE_GAP env var (default 5).
IDLE_GAP="${STATUSLINE_PROMPT_IDLE_GAP:-5}"

sid=$(jq -r '.session_id // "default"' 2>/dev/null)
sid=${sid//[^a-zA-Z0-9_-]/}
sid=${sid:-default}
now="${EPOCHSECONDS:-$(date +%s)}"

# Continuation check: if the last Stop was < IDLE_GAP seconds ago, this prompt
# is a machine re-fire, not a fresh human enter — leave prompt_ts untouched.
_stopf="$HOME/.claude/.statusline-stop-${sid}"
if [ -r "$_stopf" ]; then
  IFS= read -r _st < "$_stopf" 2>/dev/null
  if [ "$_st" -gt 0 ] 2>/dev/null && [ "$((now - _st))" -lt "$IDLE_GAP" ] 2>/dev/null; then
    exit 0
  fi
fi

printf '%s\n' "$now" > "$HOME/.claude/.statusline-prompt-${sid}" 2>/dev/null
exit 0
