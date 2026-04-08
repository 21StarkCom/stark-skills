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
session_id=$(echo "$input" | jq -r '.session_id // empty')
week_pct=$(echo "$input"  | jq -r '.rate_limits.seven_day.used_percentage // empty')
week_reset=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
five_pct=$(echo "$input"  | jq -r '.rate_limits.five_hour.used_percentage // empty')
five_reset=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')

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

# ── Worktree detection ────────────────────────────────────────────────────
worktree_name=""
git_common=$(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir 2>/dev/null)
git_dir=$(git -C "$cwd" --no-optional-locks rev-parse --git-dir 2>/dev/null)
if [ -n "$git_common" ] && [ -n "$git_dir" ] && [ "$git_common" != "$git_dir" ]; then
  worktree_name=$(basename "$cwd")
fi

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
  # Lines added/removed (staged + unstaged)
  diff_stat=$(git -C "$cwd" --no-optional-locks diff --numstat 2>/dev/null; git -C "$cwd" --no-optional-locks diff --cached --numstat 2>/dev/null)
  lines_added=0; lines_removed=0
  if [ -n "$diff_stat" ]; then
    lines_added=$(echo "$diff_stat" | awk '{s+=$1} END{print s+0}')
    lines_removed=$(echo "$diff_stat" | awk '{s+=$2} END{print s+0}')
  fi
  parts=""
  [ "$changed" -gt 0 ] && parts="\U0001f4c4 ${changed}"
  [ "$untracked" -gt 0 ] && { [ -n "$parts" ] && parts="${parts} "; parts="${parts}\U0001f50e ${untracked}"; }
  diff_parts=""
  [ "$lines_added" -gt 0 ] && diff_parts="${C_GREEN}+${lines_added}${RESET}"
  [ "$lines_removed" -gt 0 ] && { [ -n "$diff_parts" ] && diff_parts="${diff_parts} "; diff_parts="${diff_parts}${C_RED}-${lines_removed}${RESET}"; }
  [ -n "$diff_parts" ] && { [ -n "$parts" ] && parts="${parts} "; parts="${parts}${diff_parts}"; }
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

# ── Status snapshot (inflight, longest) ───────────────────────────────────
inflight_count=0
longest_tool=""
longest_s=0
status_file="$HOME/.stark-insights/status"
if [ -f "$status_file" ]; then
  while IFS=$'\t' read -ra fields; do
    for f in "${fields[@]}"; do
      case "$f" in
        inflight=*)  inflight_count="${f#inflight=}" ;;
        longest_tool=*) longest_tool="${f#longest_tool=}" ;;
        longest_s=*) longest_s="${f#longest_s=}" ;;
      esac
    done
  done < "$status_file"
fi

# ── Token counts (cumulative session totals) ─────────────────────────────
tokens_in=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
tokens_out=$(echo "$input" | jq -r '.context_window.total_output_tokens // empty')
model_id=$(echo "$input" | jq -r '.model.id // ""')

# ── Cost estimation ───────────────────────────────────────────────────────
# Prices per million tokens (USD). Cumulative session totals.
session_cost=""
if [ -n "$tokens_in" ] && [ -n "$tokens_out" ] && [ -n "$model_id" ]; then
  session_cost=$(STARK_MODEL_ID="$model_id" STARK_TOKENS_IN="$tokens_in" \
    STARK_TOKENS_OUT="$tokens_out" python3 - <<'PYEOF'
import os

model = os.environ.get("STARK_MODEL_ID", "")
try:
    tokens_in = int(float(os.environ.get("STARK_TOKENS_IN") or 0))
    tokens_out = int(float(os.environ.get("STARK_TOKENS_OUT") or 0))
except (ValueError, TypeError):
    tokens_in = tokens_out = 0

PRICES = {
    "claude-opus-4":     {"in": 15.0, "out": 75.0},
    "claude-sonnet-4":   {"in": 3.0,  "out": 15.0},
    "claude-sonnet-3-7": {"in": 3.0,  "out": 15.0},
    "claude-opus-3-5":   {"in": 15.0, "out": 75.0},
    "claude-sonnet-3-5": {"in": 3.0,  "out": 15.0},
    "claude-haiku-4-5":  {"in": 0.8,  "out": 4.0},
    "claude-haiku-3-5":  {"in": 0.8,  "out": 4.0},
    "claude-opus-3":     {"in": 15.0, "out": 75.0},
    "claude-haiku-3":    {"in": 0.25, "out": 1.25},
}

price = None
for key in sorted(PRICES.keys(), key=len, reverse=True):
    normalized_model = model.replace(".", "-")
    if key in normalized_model or normalized_model.startswith(key):
        price = PRICES[key]
        break

if price is not None:
    M = 1_000_000
    cost = (tokens_in / M) * price["in"] + (tokens_out / M) * price["out"]
    if cost < 0.01:
        print(f"{cost*100:.3f}\u00a2")
    else:
        print(f"${cost:.3f}")
PYEOF
  2>/dev/null)
fi

# ── Session start time (persisted per session_id) ─────────────────────────
session_start_time=""
if [ -n "$session_id" ]; then
  start_file="$HOME/.stark-insights/session-start-${session_id}"
  if [ ! -f "$start_file" ]; then
    date +%s > "$start_file" 2>/dev/null
  fi
  start_ts=$(cat "$start_file" 2>/dev/null)
  if [ -n "$start_ts" ]; then
    session_start_time=$(date -r "$start_ts" +%H:%M 2>/dev/null || date +%H:%M)
  fi
fi

# ── Telemetry queue health ────────────────────────────────────────────────
queue_pending=0
queue_dead=0
queue_db="$HOME/.stark-insights/queue.db"
if [ -f "$queue_db" ]; then
  queue_pending=$(sqlite3 "$queue_db" "SELECT COUNT(*) FROM pending" 2>/dev/null || echo 0)
  queue_dead=$(sqlite3 "$queue_db" "SELECT COUNT(*) FROM dead_letter" 2>/dev/null || echo 0)
fi

# ── Assemble ──────────────────────────────────────────────────────────────
out=""

SEP=" ${C_DIM}|${RESET} "

# ── Line 1: repo, model, operational ─────────────────────────────────────

# worktree indicator — 🌲 worktree-name (only when in a worktree)
out=""
[ -n "$worktree_name" ] && out="${C_TEAL}[\U0001f332 ${worktree_name}]${RESET} "

# repo + git
out="${out}${C_YELLOW}${dir_display}${RESET}"
if [ -n "$git_branch_str" ]; then
  out="${out} ${C_GREEN}${git_branch_str}${RESET}"
  [ -n "$git_dirty_str" ] && out="${out} ${C_MAROON}${git_dirty_str}${RESET}"
fi

# model — compress "Opus 4.6 (1M context)" → "Opus[1M]", "Sonnet 4.6" → "Sonnet" etc.
if [ -n "$model" ]; then
  short_model=$(echo "$model" | sed -E \
    -e 's/ [0-9]+\.[0-9]+//' \
    -e 's/ \(([0-9]+[KMG]) context\)/[\1]/' \
  )
  out="${out}${SEP}${C_SAPPHIRE}${short_model}${RESET}"
fi

# inflight count — ⚡️
if [ "$inflight_count" -gt 0 ] 2>/dev/null; then
  out="${out}${SEP}${C_SKY}\u26a1\ufe0f ${inflight_count}${RESET}"
fi

# longest inflight tool — amber if >3min
if [ "$longest_s" -gt 180 ] 2>/dev/null; then
  lt_min=$(( longest_s / 60 ))
  out="${out}${SEP}${C_YELLOW}\u23f3 ${longest_tool} ${lt_min}m${RESET}"
elif [ "$longest_s" -gt 60 ] 2>/dev/null; then
  lt_min=$(( longest_s / 60 ))
  out="${out}${SEP}${C_DIM}\u23f3 ${longest_tool} ${lt_min}m${RESET}"
fi

# last tool duration — ⏱️
if [ -n "$last_tool_str" ]; then
  out="${out}${SEP}${C_TEAL}\u23f1\ufe0f ${last_tool_str}${RESET}"
fi

# queue pending — 🪲
if [ "$queue_pending" -gt 5 ] 2>/dev/null; then
  out="${out}${SEP}${C_MAROON}\U0001fab2 ${queue_pending}${RESET}"
fi

# dead letter — 🐞
if [ "$queue_dead" -gt 0 ] 2>/dev/null; then
  out="${out}${SEP}${C_RED}\U0001f41e ${queue_dead}${RESET}"
fi

# session name
[ -n "$session_name" ] && out="${out}${SEP}${C_DIM}${session_name}${RESET}"

# vim mode
if [ -n "$vim_mode" ]; then
  [ "$vim_mode" = "NORMAL" ] && out="${out}${SEP}${C_YELLOW}[N]${RESET}" || out="${out}${SEP}${C_DIM}[I]${RESET}"
fi

# start/end times — 🆂 start (red) / 🅴 end (green, only when work done)
time_str=""
[ -n "$session_start_time" ] && time_str="\U0001f182 ${C_RED}${session_start_time}${RESET}"
if [ -n "$lt_ts" ] && [ "$lt_ts" -gt 0 ] 2>/dev/null; then
  end_time=$(date -r "$lt_ts" +%H:%M 2>/dev/null || date +%H:%M)
  [ -n "$time_str" ] && time_str="${time_str} "
  time_str="${time_str}\U0001f174 ${C_GREEN}${end_time}${RESET}"
fi
[ -n "$time_str" ] && out="${out}${SEP}${time_str}"

# ── Line 2: gauges + tokens + cost ──────────────────────────────────────
out="${out}\n"

# context usage — 🎬 (dim <50%, yellow 50-79%, red 80%+)
if [ -n "$ctx_pct" ]; then
  if [ "$ctx_pct" -ge 80 ]; then
    out="${out}${C_RED}\U0001f3ac ${ctx_pct}%${ctx_trend}${RESET}"
  elif [ "$ctx_pct" -ge 50 ]; then
    ctx_str="${C_YELLOW}\U0001f3ac ${ctx_pct}%${RESET}"
    [ -n "$ctx_trend" ] && ctx_str="${ctx_str}${C_YELLOW}${ctx_trend}${RESET}"
    out="${out}${ctx_str}"
  else
    ctx_str="${C_DIM}\U0001f3ac ${ctx_pct}%${RESET}"
    [ -n "$ctx_trend" ] && ctx_str="${ctx_str}${C_YELLOW}${ctx_trend}${RESET}"
    out="${out}${ctx_str}"
  fi
fi

# 5-hour session limit — 🛝 pct ⏳ time-remaining
if [ -n "$five_pct" ]; then
  five_int=$(printf "%.0f" "$five_pct")
  five_remain=""
  if [ -n "$five_reset" ] && [ "$five_reset" -gt 0 ] 2>/dev/null; then
    now=$(date +%s)
    diff=$(( five_reset - now ))
    if [ "$diff" -gt 0 ]; then
      diff_h=$(( diff / 3600 ))
      diff_m=$(( (diff % 3600) / 60 ))
      if [ "$diff_h" -gt 0 ]; then
        five_remain=" \u23f3 ${diff_h}h${diff_m}m"
      else
        five_remain=" \u23f3 ${diff_m}m"
      fi
    fi
  fi
  if [ "$five_int" -ge 80 ]; then
    out="${out}${SEP}${C_RED}\U0001f6dd ${five_int}%${five_remain}${RESET}"
  elif [ "$five_int" -ge 50 ]; then
    out="${out}${SEP}${C_YELLOW}\U0001f6dd ${five_int}%${five_remain}${RESET}"
  else
    out="${out}${SEP}${C_DIM}\U0001f6dd ${five_int}%${five_remain}${RESET}"
  fi
fi

# weekly (7-day) limit — 📅 pct 🕰️ time-remaining
if [ -n "$week_pct" ]; then
  week_int=$(printf "%.0f" "$week_pct")
  week_remain=""
  if [ -n "$week_reset" ] && [ "$week_reset" -gt 0 ] 2>/dev/null; then
    now=$(date +%s)
    diff=$(( week_reset - now ))
    if [ "$diff" -gt 0 ]; then
      diff_d=$(( diff / 86400 ))
      diff_h=$(( (diff % 86400) / 3600 ))
      diff_m=$(( (diff % 3600) / 60 ))
      if [ "$diff_d" -gt 0 ]; then
        week_remain=" \U0001f570\ufe0f ${diff_d}d${diff_h}h"
      elif [ "$diff_h" -gt 0 ]; then
        week_remain=" \U0001f570\ufe0f ${diff_h}h${diff_m}m"
      else
        week_remain=" \U0001f570\ufe0f ${diff_m}m"
      fi
    fi
  fi
  if [ "$week_int" -ge 80 ]; then
    out="${out}${SEP}${C_RED}\U0001f4c5 ${week_int}%${week_remain}${RESET}"
  elif [ "$week_int" -ge 50 ]; then
    out="${out}${SEP}${C_YELLOW}\U0001f4c5 ${week_int}%${week_remain}${RESET}"
  else
    out="${out}${SEP}${C_DIM}\U0001f4c5 ${week_int}%${week_remain}${RESET}"
  fi
fi

# token counts — ⬆ sent (green) / ⬇ received (red)
if [ -n "$tokens_in" ] || [ -n "$tokens_out" ]; then
  tok_str=""
  [ -n "$tokens_in" ]  && tok_str="\u2b06 ${C_GREEN}${tokens_in}${RESET}"
  [ -n "$tokens_out" ] && tok_str="${tok_str} \u2b07 ${C_RED}${tokens_out}${RESET}"
  out="${out}${SEP}${tok_str}"
fi

# cost estimate — 💰
if [ -n "$session_cost" ]; then
  out="${out}${SEP}${C_PEACH}\U0001f4b0 ${session_cost}${RESET}"
fi

printf "%b\n" "$out"
