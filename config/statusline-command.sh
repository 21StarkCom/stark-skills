#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette, mirrors Starship config
# Input: JSON via stdin

input=$(cat)

# ── Data extraction ────────────────────────────────────────────────────────
cwd=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // ""')
model=$(echo "$input" | jq -r '.model.display_name // ""')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
vim_mode=$(echo "$input" | jq -r '.vim.mode // empty')
session_name=$(echo "$input" | jq -r '.session_name // empty')

# ── Directory (just the repo/folder name) ─────────────────────────────────
dir_display=$(basename "$cwd")

# ── Git branch + dirty ────────────────────────────────────────────────────
git_branch_str=""
git_dirty_str=""
if git_branch=$(git -C "$cwd" --no-optional-locks rev-parse --abbrev-ref HEAD 2>/dev/null); then
  git_branch_str="$git_branch"
  modified=$(git -C "$cwd" --no-optional-locks diff --name-only 2>/dev/null | wc -l | tr -d ' ')
  staged=$(git -C "$cwd" --no-optional-locks diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
  untracked=$(git -C "$cwd" --no-optional-locks ls-files --others --exclude-standard 2>/dev/null | wc -l | tr -d ' ')
  changed=$(( modified + staged ))
  parts=""
  [ "$changed" -gt 0 ] && parts="\u270e${changed}"
  [ "$untracked" -gt 0 ] && { [ -n "$parts" ] && parts="${parts} "; parts="${parts}\u2728${untracked}"; }
  [ -n "$parts" ] && git_dirty_str="[${parts}]"
fi

# ── Context usage + velocity ─────────────────────────────────────────────
ctx_pct=""
ctx_alert=0
ctx_trend=""
if [ -n "$used_pct" ]; then
  ctx_pct=$(printf "%.0f" "$used_pct")
  [ "$ctx_pct" -ge 75 ] && ctx_alert=1
  # Record context % and get trend indicator
  ctx_trend=$(python3 -c "
import sys; sys.path.insert(0, '$HOME/git/Evinced/stark-skills/scripts')
from emit_queue import record_context_pct
print(record_context_pct($ctx_pct))
" 2>/dev/null)
fi

# ── Catppuccin Mocha ANSI (256-color) ─────────────────────────────────────
# peach=#fab387 ≈ 216, yellow=#f9e2af ≈ 229, green=#a6e3a1 ≈ 150
# sapphire=#74c7ec ≈ 117, lavender=#b4befe ≈ 183, red=#f38ba8 ≈ 211
# teal=#94e2d5 ≈ 158, maroon=#eba0ac ≈ 217, flamingo=#f2cdcd ≈ 224
# mauve=#cba6f7 ≈ 183, sky=#89dceb ≈ 117, rosewater=#f5e0dc ≈ 224
RESET="\033[0m"
BOLD="\033[1m"
C_PEACH="\033[38;5;216m"
C_YELLOW="\033[38;5;229m"
C_GREEN="\033[38;5;150m"
C_SAPPHIRE="\033[38;5;117m"
C_LAVENDER="\033[38;5;183m"
C_RED="\033[38;5;211m"
C_DIM="\033[38;5;245m"
C_TEAL="\033[38;5;158m"
C_MAROON="\033[38;5;217m"
C_MAUVE="\033[38;5;141m"
C_SKY="\033[38;5;117m"

# ── Last tool duration ────────────────────────────────────────────────────
last_tool_str=""
last_tool_file="$HOME/.stark-insights/last-tool"
if [ -f "$last_tool_file" ]; then
  IFS=$'\t' read -r lt_name lt_ms lt_ts < "$last_tool_file" 2>/dev/null
  if [ -n "$lt_name" ] && [ -n "$lt_ms" ] && [ -n "$lt_ts" ]; then
    age=$(( $(date +%s) - lt_ts ))
    if [ "$age" -lt 30 ]; then
      if [ "$lt_ms" -lt 1000 ] 2>/dev/null; then
        last_tool_str="${lt_name} ${lt_ms}ms"
      else
        lt_s=$(( lt_ms / 1000 ))
        last_tool_str="${lt_name} ${lt_s}s"
      fi
    fi
  fi
fi

# ── Status snapshot (inflight, cost, longest) ────────────────────────────
inflight_count=0
longest_tool=""
longest_s=0
session_cost=""
status_file="$HOME/.stark-insights/status"
if [ -f "$status_file" ]; then
  while IFS=$'\t' read -ra fields; do
    for f in "${fields[@]}"; do
      case "$f" in
        inflight=*)  inflight_count="${f#inflight=}" ;;
        longest_tool=*) longest_tool="${f#longest_tool=}" ;;
        longest_s=*) longest_s="${f#longest_s=}" ;;
        cost=*)      session_cost="${f#cost=}" ;;
      esac
    done
  done < "$status_file"
fi

# ── Telemetry queue health ────────────────────────────────────────────────
queue_str=""
queue_db="$HOME/.stark-insights/queue.db"
if [ -f "$queue_db" ]; then
  pending=$(sqlite3 "$queue_db" "SELECT COUNT(*) FROM pending" 2>/dev/null || echo 0)
  dead=$(sqlite3 "$queue_db" "SELECT COUNT(*) FROM dead_letter" 2>/dev/null || echo 0)
  if [ "$dead" -gt 0 ]; then
    queue_str="${pending}q/${dead}dl"
  elif [ "$pending" -gt 5 ]; then
    queue_str="${pending}q"
  fi
fi

# ── Assemble ──────────────────────────────────────────────────────────────
out=""

SEP=" ${C_DIM}|${RESET} "

# repo + git
out="${C_YELLOW}${dir_display}${RESET}"
if [ -n "$git_branch_str" ]; then
  out="${out} ${C_GREEN}${git_branch_str}${RESET}"
  [ -n "$git_dirty_str" ] && out="${out} ${C_RED}${git_dirty_str}${RESET}"
fi

# model — compress "Opus 4.6 (1M context)" → "Opus[1M]", "Sonnet 4.6" → "Sonnet" etc.
if [ -n "$model" ]; then
  short_model=$(echo "$model" | sed -E \
    -e 's/ [0-9]+\.[0-9]+//' \
    -e 's/ \(([0-9]+[KMG]) context\)/[\1]/' \
  )
  out="${out}${SEP}${C_SAPPHIRE}${short_model}${RESET}"
fi

# context % + velocity trend
if [ -n "$ctx_pct" ]; then
  if [ "$ctx_alert" -eq 1 ]; then
    out="${out}${SEP}${C_RED}${ctx_pct}%${ctx_trend}${RESET}"
  else
    ctx_str="${C_LAVENDER}${ctx_pct}%${RESET}"
    [ -n "$ctx_trend" ] && ctx_str="${ctx_str}${C_YELLOW}${ctx_trend}${RESET}"
    out="${out}${SEP}${ctx_str}"
  fi
fi

# session cost — mauve
if [ -n "$session_cost" ] && [ "$session_cost" != "0.00" ]; then
  out="${out}${SEP}${C_MAUVE}\$${session_cost}${RESET}"
fi

# inflight count — sky with lightning bolt
if [ "$inflight_count" -gt 0 ] 2>/dev/null; then
  out="${out}${SEP}${C_SKY}\u26a1${inflight_count}${RESET}"
fi

# longest inflight tool — amber if >3min
if [ "$longest_s" -gt 180 ] 2>/dev/null; then
  lt_min=$(( longest_s / 60 ))
  out="${out}${SEP}${C_YELLOW}\u23f3 ${longest_tool} ${lt_min}m${RESET}"
elif [ "$longest_s" -gt 60 ] 2>/dev/null; then
  lt_min=$(( longest_s / 60 ))
  out="${out}${SEP}${C_DIM}\u23f3 ${longest_tool} ${lt_min}m${RESET}"
fi

# last tool duration — teal
if [ -n "$last_tool_str" ]; then
  out="${out}${SEP}${C_TEAL}\u23f1 ${last_tool_str}${RESET}"
fi

# telemetry queue — maroon with skull
if [ -n "$queue_str" ]; then
  out="${out}${SEP}${C_MAROON}\u2620 ${queue_str}${RESET}"
fi

# session name
[ -n "$session_name" ] && out="${out}${SEP}${C_DIM}${session_name}${RESET}"

# vim mode
if [ -n "$vim_mode" ]; then
  [ "$vim_mode" = "NORMAL" ] && out="${out}${SEP}${C_YELLOW}[N]${RESET}" || out="${out}${SEP}${C_DIM}[I]${RESET}"
fi

# last activity time — show when last tool finished (flag emoji)
if [ -n "$lt_ts" ] && [ "$lt_ts" -gt 0 ] 2>/dev/null; then
  last_time=$(date -r "$lt_ts" +%H:%M 2>/dev/null || date +%H:%M)
  out="${out}${SEP}${C_DIM}\U0001f3c1 ${last_time}${RESET}"
else
  out="${out}${SEP}${C_DIM}\U0001f3c1 $(date +%H:%M)${RESET}"
fi

printf "%b\n" "$out"
