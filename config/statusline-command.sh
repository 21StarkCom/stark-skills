#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin

input=$(cat)

# ── Extract all fields (single jq call) ──────────────────────────────────
eval "$(echo "$input" | jq -r '{
  cwd:          (.workspace.current_dir // .cwd // ""),
  model:        (.model.display_name // ""),
  model_id:     (.model.id // ""),
  used_pct:     (.context_window.used_percentage // ""),
  vim_mode:     (.vim.mode // ""),
  session_name: (.session_name // ""),
  session_id:   (.session_id // ""),
  week_pct:     (.rate_limits.seven_day.used_percentage // ""),
  week_reset:   (.rate_limits.seven_day.resets_at // ""),
  five_pct:     (.rate_limits.five_hour.used_percentage // ""),
  five_reset:   (.rate_limits.five_hour.resets_at // ""),
  tokens_in:    (.context_window.total_input_tokens // ""),
  tokens_out:   (.context_window.total_output_tokens // ""),
  s_added:      (.cost.total_lines_added // ""),
  s_removed:    (.cost.total_lines_removed // ""),
  total_dur_ms: (.cost.total_duration_ms // ""),
  api_dur_ms:   (.cost.total_api_duration_ms // "")
} | to_entries[] | "\(.key)=\(.value | tostring | @sh)"')"

# ── Colors (Catppuccin Mocha 256-color) ──────────────────────────────────
R="\033[0m" DIM="\033[38;5;245m"
PEACH="\033[38;5;216m" YEL="\033[38;5;229m" GRN="\033[38;5;150m"
SAP="\033[38;5;117m"   RED="\033[38;5;211m" TEAL="\033[38;5;158m"
MAR="\033[38;5;217m"   MAUVE="\033[38;5;141m" SKY="\033[38;5;117m"
SEP=" ${DIM}|${R} "

# ── Segment visibility (from statusline-setup.py config) ────────────────
_skip=""
_cfg="$HOME/.claude/statusline-segments.json"
[ -f "$_cfg" ] && _skip=" $(grep -o '"[a-z_]*": *false' "$_cfg" 2>/dev/null | cut -d'"' -f2 | tr '\n' ' ')"
_on() { [[ "$_skip" != *" $1 "* ]]; }

# ── Helpers ──────────────────────────────────────────────────────────────
seg()  { [ -z "$out" ] && out="$1" || out="${out}${SEP}$1"; }      # line 1 append
seg2() { [ -z "$l2" ] && l2="$1" || l2="${l2}${SEP}$1"; }         # line 2 append

tcolor() { # val hi_thresh mid_thresh → stdout color escape
  if [ "$1" -ge "$2" ] 2>/dev/null; then echo "$RED"
  elif [ "$1" -ge "$3" ] 2>/dev/null; then echo "$YEL"
  else echo "$DIM"; fi
}

fmt_dur() { # seconds → "Xh Ym" | "Xm" | "Xs"
  local h=$(( $1 / 3600 )) m=$(( ($1 % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then echo "${h}h${m}m"
  elif [ "$m" -gt 0 ]; then echo "${m}m"
  else echo "${1}s"; fi
}

fmt_remain() { # reset_epoch [time_emoji] → " ⏳ Xd Yh" or empty
  [ -z "$1" ] || ! [ "$1" -gt 0 ] 2>/dev/null && return
  local diff=$(( $1 - $(date +%s) )) e="${2:-\\u23f3}"
  [ "$diff" -le 0 ] && return
  local d=$(( diff / 86400 )) h=$(( (diff % 86400) / 3600 )) m=$(( (diff % 3600) / 60 ))
  if [ "$d" -gt 0 ]; then echo " ${e} ${d}d${h}h"
  elif [ "$h" -gt 0 ]; then echo " ${e} ${h}h${m}m"
  else echo " ${e} ${m}m"; fi
}

rate_seg() { # section_emoji pct reset_epoch [time_emoji]
  [ -z "$2" ] && return
  local pct=$(printf "%.0f" "$2")
  seg2 "$(tcolor "$pct" 80 50)${1} ${pct}%$(fmt_remain "$3" "$4")${R}"
}

# ── Git (consolidated calls) ─────────────────────────────────────────────
wt_name="" repo_name="" git_branch="" git_dirty=""
if [ -n "$cwd" ]; then
  # Worktree + branch: single rev-parse
  { read -r gc; read -r gd; read -r git_branch; } \
    < <(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir --git-dir --abbrev-ref HEAD 2>/dev/null)
  [ -n "$gc" ] && [ -n "$gd" ] && [ "$gc" != "$gd" ] && wt_name=$(basename "$cwd")

  remote=$(git -C "$cwd" --no-optional-locks remote get-url origin 2>/dev/null)
  [ -n "$remote" ] && repo_name=$(basename "$remote" .git)

  if [ -n "$git_branch" ]; then
    # File counts: single porcelain call replaces diff + diff --cached + ls-files
    changed=0 untracked=0
    while IFS= read -r line; do
      x=${line:0:1} y=${line:1:1}
      if [ "$x" = "?" ]; then (( untracked++ ))
      else [ "$x" != " " ] && (( changed++ )); [ "$y" != " " ] && (( changed++ )); fi
    done < <(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)

    # Line-level diff (still needs numstat)
    diff_stat=$(git -C "$cwd" --no-optional-locks diff --numstat 2>/dev/null
                git -C "$cwd" --no-optional-locks diff --cached --numstat 2>/dev/null)
    la=0 lr=0
    [ -n "$diff_stat" ] && read -r la lr < <(echo "$diff_stat" | awk '{a+=$1;r+=$2}END{print a+0,r+0}')

    p=""
    [ "$changed" -gt 0 ]   && p="\U0001f4c4 ${changed}"
    [ "$untracked" -gt 0 ] && { [ -n "$p" ] && p="${p} "; p="${p}\U0001f50e ${untracked}"; }
    dp=""
    [ "$la" -gt 0 ] && dp="${GRN}+${la}${R}"
    [ "$lr" -gt 0 ] && { [ -n "$dp" ] && dp="${dp} "; dp="${dp}${RED}-${lr}${R}"; }
    [ -n "$dp" ] && { [ -n "$p" ] && p="${p} "; p="${p}${dp}"; }
    git_dirty="$p"
  fi
fi

# ── Python: context trend + cost (single call) ──────────────────────────
ctx_trend="" session_cost=""
IFS=$'\t' read -r ctx_trend session_cost < <(python3 - "$used_pct" "$model_id" "$tokens_in" "$tokens_out" <<'PYEOF'
import sys, os
_, pct_s, mid, tin, tout = sys.argv

trend = ""
if pct_s:
    try:
        sys.path.insert(0, os.path.expanduser("~/git/Evinced/stark-skills/scripts"))
        from emit_queue import record_context_pct
        trend = record_context_pct(float(pct_s))
    except Exception:
        pass

cost = ""
if tin and tout and mid:
    try:
        ti, to = int(float(tin)), int(float(tout))
        P = {"claude-opus-4":(15,75),"claude-sonnet-4":(3,15),"claude-sonnet-3-7":(3,15),
             "claude-opus-3-5":(15,75),"claude-sonnet-3-5":(3,15),"claude-haiku-4-5":(.8,4),
             "claude-haiku-3-5":(.8,4),"claude-opus-3":(15,75),"claude-haiku-3":(.25,1.25)}
        nm = mid.replace(".", "-")
        for k in sorted(P, key=len, reverse=True):
            if k in nm or nm.startswith(k):
                pi, po = P[k]; M = 1e6; c = ti/M*pi + to/M*po
                cost = f"{c*100:.3f}\u00a2" if c < 0.01 else f"${c:.3f}"
                break
    except Exception:
        pass

print(f"{trend}\t{cost}")
PYEOF
2>/dev/null)

# ── File-based state ─────────────────────────────────────────────────────
last_tool="" lt_ts="" inflight=0 longest_tool="" longest_s=0

f="$HOME/.stark-insights/last-tool"
if [ -f "$f" ]; then
  IFS=$'\t' read -r lt_name lt_ms lt_ts < "$f" 2>/dev/null
  if [ -n "$lt_name" ] && [ -n "$lt_ms" ] && [ -n "$lt_ts" ] && [ $(( $(date +%s) - lt_ts )) -lt 30 ]; then
    [ "$lt_ms" -lt 1000 ] 2>/dev/null && last_tool="${lt_name} ${lt_ms}ms" || last_tool="${lt_name} $(( lt_ms / 1000 ))s"
  fi
fi

f="$HOME/.stark-insights/status"
[ -f "$f" ] && while IFS=$'\t' read -ra flds; do for x in "${flds[@]}"; do
  case "$x" in inflight=*) inflight=${x#*=};; longest_tool=*) longest_tool=${x#*=};; longest_s=*) longest_s=${x#*=};; esac
done; done < "$f"

q_pending=0 q_dead=0
f="$HOME/.stark-insights/queue.db"
[ -f "$f" ] && {
  q_pending=$(sqlite3 "$f" "SELECT COUNT(*) FROM pending" 2>/dev/null || echo 0)
  q_dead=$(sqlite3 "$f" "SELECT COUNT(*) FROM dead_letter" 2>/dev/null || echo 0)
}

session_start=""
if [ -n "$session_id" ]; then
  f="$HOME/.stark-insights/session-start-${session_id}"
  [ ! -f "$f" ] && date +%s > "$f" 2>/dev/null
  ts=$(cat "$f" 2>/dev/null)
  [ -n "$ts" ] && session_start=$(date -r "$ts" +%H:%M 2>/dev/null || date +%H:%M)
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 1: repo · branch · model · operational
# ═════════════════════════════════════════════════════════════════════════
out=""
if _on repo_name && [ -n "$repo_name" ]; then
  out="${MAUVE}\U0001f5c2\ufe0f ${repo_name}${R}"
else
  out="${YEL}$(basename "$cwd")${R}"
fi
_on wt_name && [ -n "$wt_name" ] && seg "${TEAL}\U0001f332 ${wt_name}${R}"

if _on git_branch && [ -n "$git_branch" ]; then
  seg "${GRN}\u2618\ufe0f ${git_branch}${R}"
  _on git_dirty && [ -n "$git_dirty" ] && out="${out} ${MAR}${git_dirty}${R}"
fi

_on model && [ -n "$model" ] && seg "${SAP}$(echo "$model" | sed -E 's/ [0-9]+\.[0-9]+//; s/ \(([0-9]+[KMG]) context\)/ \1/')${R}"
_on inflight && [ "$inflight" -gt 0 ] 2>/dev/null && seg "${SKY}\u26a1\ufe0f ${inflight}${R}"
_on longest_tool && [ "$longest_s" -gt 60 ] 2>/dev/null && seg "$(tcolor "$longest_s" 180 60)\u23f3 ${longest_tool} $(( longest_s / 60 ))m${R}"
_on last_tool && [ -n "$last_tool" ] && seg "${TEAL}\u23f1\ufe0f ${last_tool}${R}"
_on q_pending && [ "$q_pending" -gt 5 ] 2>/dev/null && seg "${MAR}\U0001fab2 ${q_pending}${R}"
_on q_dead && [ "$q_dead" -gt 0 ] 2>/dev/null && seg "${RED}\U0001f41e ${q_dead}${R}"
_on session_name && [ -n "$session_name" ] && seg "${DIM}${session_name}${R}"
_on vim_mode && [ -n "$vim_mode" ] && { [ "$vim_mode" = "NORMAL" ] && seg "${YEL}N${R}" || seg "${DIM}I${R}"; }
_on session_start && [ -n "$session_start" ] && seg "\U0001f182 ${RED}${session_start}${R}"

if _on api_ratio && [ -n "$total_dur_ms" ] && [ -n "$api_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null; then
  ratio=$(( api_dur_ms * 100 / total_dur_ms ))
  seg "$(tcolor "$ratio" 80 50)\u2699\ufe0f ${ratio}%${R}"
fi

_on end_time && [ -n "$lt_ts" ] && [ "$lt_ts" -gt 0 ] 2>/dev/null && \
  seg "\U0001f174 ${GRN}$(date -r "$lt_ts" +%H:%M 2>/dev/null || date +%H:%M)${R}"

# ═════════════════════════════════════════════════════════════════════════
# Line 2: gauges · tokens · cost
# ═════════════════════════════════════════════════════════════════════════
l2=""

if _on ctx_usage && [ -n "$used_pct" ]; then
  ctx=$(printf "%.0f" "$used_pct"); c=$(tcolor "$ctx" 80 50)
  s="${c}\U0001f3ac ${ctx}%${R}"
  if [ -n "$ctx_trend" ]; then
    tc=$YEL; [ "$ctx" -ge 80 ] 2>/dev/null && tc=$RED
    s="${s}${tc}${ctx_trend}${R}"
  fi
  seg2 "$s"
fi

_on session_dur && [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null && \
  seg2 "${DIM}\U0001faab $(fmt_dur $(( total_dur_ms / 1000 )))${R}"

_on five_hour_rl && rate_seg "\U0001f6dd" "$five_pct" "$five_reset" "\\u23f3"
_on weekly_rl && rate_seg "\U0001f4c5" "$week_pct" "$week_reset" "\\U0001f570\\ufe0f"

if _on tokens && { [ -n "$tokens_in" ] || [ -n "$tokens_out" ]; }; then
  tok=""
  [ -n "$tokens_in" ]  && tok="\u2b06 ${GRN}${tokens_in}${R}"
  [ -n "$tokens_out" ] && tok="${tok} \u2b07 ${RED}${tokens_out}${R}"
  seg2 "$tok"
fi

_on cost && [ -n "$session_cost" ] && seg2 "${PEACH}\U0001f4b0 ${session_cost}${R}"

if _on code_churn; then
  churn=""
  [ -n "$s_added" ]  && [ "$s_added" -gt 0 ]  2>/dev/null && churn="${GRN}+${s_added}${R}"
  [ -n "$s_removed" ] && [ "$s_removed" -gt 0 ] 2>/dev/null && { [ -n "$churn" ] && churn="${churn} "; churn="${churn}${RED}-${s_removed}${R}"; }
  [ -n "$churn" ] && seg2 "\u270f\ufe0f ${churn}"
fi

printf "%b\n" "${out}\n${l2}"
