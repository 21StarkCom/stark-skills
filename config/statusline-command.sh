#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin

input=$(cat)

# ── Extract all fields (single jq call) ──────────────────────────────────
eval "$(jq -r <<<"$input" '{
  cwd:          (.workspace.current_dir // .cwd // ""),
  model:        (.model.display_name // ""),
  model_id:     (.model.id // ""),
  used_pct:     (.context_window.used_percentage // ""),
  ctx_size:     (.context_window.context_window_size // ""),
  vim_mode:     (.vim.mode // ""),
  session_name: (.session_name // ""),
  effort:       (.effort.level // ""),
  thinking:     (.thinking.enabled // false),
  agent_name:   (.agent.name // ""),
  out_style:    (.output_style.name // ""),
  week_pct:     (.rate_limits.seven_day.used_percentage // ""),
  week_reset:   (.rate_limits.seven_day.resets_at // ""),
  five_pct:     (.rate_limits.five_hour.used_percentage // ""),
  five_reset:   (.rate_limits.five_hour.resets_at // ""),
  tokens_in:    (.context_window.total_input_tokens // ""),
  tokens_out:   (.context_window.total_output_tokens // ""),
  cur_in:       (.context_window.current_usage.input_tokens // ""),
  cur_out:      (.context_window.current_usage.output_tokens // ""),
  cur_cw:       (.context_window.current_usage.cache_creation_input_tokens // ""),
  cur_cr:       (.context_window.current_usage.cache_read_input_tokens // ""),
  cost_usd:     (.cost.total_cost_usd // ""),
  over_200k:    (.exceeds_200k_tokens // false),
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
# Single jq pass replaces a 3-fork grep|cut|tr chain.
_skip=""
_cfg="$HOME/.claude/statusline-segments.json"
[ -f "$_cfg" ] && _skip=" $(jq -r '[to_entries[] | select(.value == false) | .key] | join(" ")' "$_cfg" 2>/dev/null) "
_on() { [[ "$_skip" != *" $1 "* ]]; }

# Cache wall-clock once; bash printf-builtin avoids a `date +%s` fork on
# each call site (rate segs, last-tool freshness, session-start).
printf -v NOW '%(%s)T' -1

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

fmt_n() { # token count → "1.2k" / "145k" / "1.5M" — pure bash, no fork
  local n=${1:-0}
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    printf '%d.%dM' $((n / 1000000)) $(( (n % 1000000) / 100000 ))
  elif [ "$n" -ge 1000 ] 2>/dev/null; then
    printf '%d.%dk' $((n / 1000)) $(( (n % 1000) / 100 ))
  else
    printf '%d' "$n"
  fi
}

fmt_remain() { # reset_epoch [time_emoji] → " ⏳ Xd Yh" or empty
  [ -z "$1" ] || ! [ "$1" -gt 0 ] 2>/dev/null && return
  local diff=$(( $1 - NOW )) e="${2:-\\u23f3}"
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
  [ -n "$gc" ] && [ -n "$gd" ] && [ "$gc" != "$gd" ] && wt_name=${cwd##*/}

  remote=$(git -C "$cwd" --no-optional-locks remote get-url origin 2>/dev/null)
  if [ -n "$remote" ]; then repo_name=${remote##*/}; repo_name=${repo_name%.git}; fi

  if [ -n "$git_branch" ]; then
    # File counts: single porcelain call replaces diff + diff --cached + ls-files
    changed=0 untracked=0
    while IFS= read -r line; do
      x=${line:0:1} y=${line:1:1}
      if [ "$x" = "?" ]; then (( untracked++ ))
      else [ "$x" != " " ] && (( changed++ )); [ "$y" != " " ] && (( changed++ )); fi
    done < <(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null)

    # `git diff HEAD --numstat` covers both unstaged and staged in one call
    # (single fork instead of `diff` + `diff --cached`). Sum in pure bash.
    la=0 lr=0
    while read -r added removed _; do
      [[ "$added" =~ ^[0-9]+$ ]] && la=$((la + added))
      [[ "$removed" =~ ^[0-9]+$ ]] && lr=$((lr + removed))
    done < <(git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null)

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

# ── Cost formatting ─────────────────────────────────────────────────────
# cost.total_cost_usd is computed correctly client-side by Claude Code,
# accounting for cache reads (10%), cache writes (1.25x/2x), and tier
# pricing (Opus 4 1M context >200K = 2x). Use it directly.
# Single awk emits cost + per-hour burn rate, tab-separated, in one fork.
session_cost="" cost_rate=""
if [ -n "$cost_usd" ]; then
  IFS=$'\t' read -r session_cost cost_rate < <(awk -v c="$cost_usd" -v d="${total_dur_ms:-0}" 'BEGIN{
    if (c+0 == 0) { print "\t"; exit }
    if (c < 0.01)    printf "%.2f\xc2\xa2", c*100
    else if (c < 1)  printf "$%.3f", c
    else             printf "$%.2f", c
    printf "\t"
    if (d+0 > 60000) {
      r = c * 3600000 / d
      if (r >= 10) printf "$%.1f/h", r
      else         printf "$%.2f/h", r
    }
  }')
fi

# ── File-based state ─────────────────────────────────────────────────────
last_tool="" lt_ts="" inflight=0 longest_tool="" longest_s=0

f="$HOME/.stark-insights/last-tool"
if [ -f "$f" ]; then
  IFS=$'\t' read -r lt_name lt_ms lt_ts < "$f" 2>/dev/null
  if [ -n "$lt_name" ] && [ -n "$lt_ms" ] && [ -n "$lt_ts" ] && [ $(( NOW - lt_ts )) -lt 30 ]; then
    [ "$lt_ms" -lt 1000 ] 2>/dev/null && last_tool="${lt_name} ${lt_ms}ms" || last_tool="${lt_name} $(( lt_ms / 1000 ))s"
  fi
fi

# Status file is single-line tab-separated key=value pairs. Read once, no
# nested while/for needed (the previous form ran an outer loop one time).
f="$HOME/.stark-insights/status"
if [ -f "$f" ]; then
  IFS=$'\t' read -ra flds < "$f" 2>/dev/null
  for x in "${flds[@]}"; do
    case "$x" in
      inflight=*)     inflight=${x#*=};;
      longest_tool=*) longest_tool=${x#*=};;
      longest_s=*)    longest_s=${x#*=};;
    esac
  done
fi

# Single sqlite3 fork instead of two — both counts in one query.
q_pending=0 q_dead=0
f="$HOME/.stark-insights/queue.db"
if [ -f "$f" ]; then
  IFS='|' read -r q_pending q_dead < <(sqlite3 "$f" \
    "SELECT (SELECT COUNT(*) FROM pending), (SELECT COUNT(*) FROM dead_letter)" 2>/dev/null)
  q_pending=${q_pending:-0} q_dead=${q_dead:-0}
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 1: repo · branch · model · operational
# ═════════════════════════════════════════════════════════════════════════
out=""
if _on repo_name && [ -n "$repo_name" ]; then
  out="${MAUVE}\U0001f5c2\ufe0f ${repo_name}${R}"
else
  out="${YEL}${cwd##*/}${R}"
fi
_on wt_name && [ -n "$wt_name" ] && seg "${TEAL}\U0001f332 ${wt_name}${R}"

if _on git_branch && [ -n "$git_branch" ]; then
  seg "${GRN}\u2618\ufe0f ${git_branch}${R}"
  _on git_dirty && [ -n "$git_dirty" ] && out="${out} ${MAR}${git_dirty}${R}"
fi

_on model && [ -n "$model" ] && seg "${SAP}$(sed -E 's/ [0-9]+\.[0-9]+//; s/ \(([0-9]+[KMG]) context\)/ \1/' <<<"$model")${R}"

# Reasoning effort \u2014 Lo / Me / Hi / Xh / Mx \u2014 grouped with model since
# it materially affects both output token volume and cost.
if _on effort && [ -n "$effort" ]; then
  case "$effort" in
    low)    _ec="$DIM";   _el="Lo";;
    medium) _ec="$DIM";   _el="Me";;
    high)   _ec="$YEL";   _el="Hi";;
    xhigh)  _ec="$PEACH"; _el="Xh";;
    max)    _ec="$RED";   _el="Mx";;
    *)      _ec="$DIM";   _el="${effort:0:2}";;
  esac
  seg "${_ec}${_el}${R}"
fi

# Extended thinking \u2014 only show when enabled (off is the default state).
_on thinking && [ "$thinking" = "true" ] && seg "${YEL}\U0001f4ad${R}"

# Active subagent (--agent foo or via agent settings).
_on agent && [ -n "$agent_name" ] && seg "${TEAL}\U0001f916 ${agent_name}${R}"

# Non-default output style (Explanatory / Learning / custom user style).
_on out_style && [ -n "$out_style" ] && [ "$out_style" != "default" ] && \
  [ "$out_style" != "Default" ] && seg "${DIM}\U0001f3a8 ${out_style}${R}"

_on inflight && [ "$inflight" -gt 0 ] 2>/dev/null && seg "${SKY}\u26a1\ufe0f ${inflight}${R}"
_on longest_tool && [ "$longest_s" -gt 60 ] 2>/dev/null && seg "$(tcolor "$longest_s" 180 60)\u23f3 ${longest_tool} $(( longest_s / 60 ))m${R}"
_on last_tool && [ -n "$last_tool" ] && seg "${TEAL}\u23f1\ufe0f ${last_tool}${R}"
_on q_pending && [ "$q_pending" -gt 5 ] 2>/dev/null && seg "${MAR}\U0001fab2 ${q_pending}${R}"
_on q_dead && [ "$q_dead" -gt 0 ] 2>/dev/null && seg "${RED}\U0001f41e ${q_dead}${R}"
_on session_name && [ -n "$session_name" ] && seg "${DIM}${session_name}${R}"
_on vim_mode && [ -n "$vim_mode" ] && { [ "$vim_mode" = "NORMAL" ] && seg "${YEL}N${R}" || seg "${DIM}I${R}"; }

if _on api_ratio && [ -n "$total_dur_ms" ] && [ -n "$api_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null; then
  ratio=$(( api_dur_ms * 100 / total_dur_ms ))
  seg "$(tcolor "$ratio" 80 50)\u2699\ufe0f ${ratio}%${R}"
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 2: gauges · tokens · cost
# ═════════════════════════════════════════════════════════════════════════
l2=""

# Context capacity gauge — how full is the window. 🧠 (brain) since the
# context is what the model thinks with.
if _on ctx_usage && [ -n "$used_pct" ]; then
  ctx=$(printf "%.0f" "$used_pct")
  seg2 "$(tcolor "$ctx" 80 50)\U0001f9e0 ${ctx}%${R}"
fi

# Turn flow — what flowed in/out on the last API call, read as one
# narrative connected with arrows:
#   ⬆ fresh   = input + cache_creation (full price + cache-write surcharge)
#   📖 cache  = cache_read with hit% (10% price)
#   ⬇ out    = generated output
if _on tokens && [ -n "$cur_in" ]; then
  cin=${cur_in:-0} ccw=${cur_cw:-0} ccr=${cur_cr:-0} cot=${cur_out:-0}
  fresh=$(( cin + ccw ))
  total_in=$(( fresh + ccr ))
  hit=0
  [ "$total_in" -gt 0 ] && hit=$(( ccr * 100 / total_in ))
  tok="${SAP}\u2b06 $(fmt_n $fresh)${R}"
  [ "$ccr" -gt 0 ] && tok="${tok} ${DIM}\u2192 ${GRN}\U0001f4d6 $(fmt_n $ccr) ${hit}%${R}"
  [ "$cot" -gt 0 ] && tok="${tok} ${DIM}\u2192 ${PEACH}\u2b07 $(fmt_n $cot)${R}"
  seg2 "$tok"
fi

# Cumulative session tokens — opt-in (off by default; can mislead because
# every API call's full input is summed, including cache rereads).
# Cost: real session cost + per-hour burn rate, merged into one segment.
if _on cost && [ -n "$session_cost" ]; then
  c="${PEACH}\U0001f4b0 ${session_cost}${R}"
  [ -n "$cost_rate" ] && c="${c} ${DIM}· ${cost_rate}${R}"
  seg2 "$c"
fi

_on session_dur && [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null && \
  seg2 "${DIM}\U0001faab $(fmt_dur $(( total_dur_ms / 1000 )))${R}"

_on five_hour_rl && rate_seg "\U0001f6dd" "$five_pct" "$five_reset" "\\u23f3"
_on weekly_rl && rate_seg "\U0001f4c5" "$week_pct" "$week_reset" "\\U0001f570\\ufe0f"

_on tier_warn && [ "$over_200k" = "true" ] && seg2 "${RED}\u26a0\ufe0f 1M-tier${R}"

# Cumulative session tokens \u2014 opt-in (off by default; misleading because
# every API call's full input is summed, including cache rereads).
if _on tokens_total && { [ -n "$tokens_in" ] || [ -n "$tokens_out" ]; }; then
  tok=""
  [ -n "$tokens_in" ]  && tok="${DIM}\u03a3\u2b06 $(fmt_n ${tokens_in:-0})${R}"
  [ -n "$tokens_out" ] && tok="${tok} ${DIM}\u03a3\u2b07 $(fmt_n ${tokens_out:-0})${R}"
  seg2 "$tok"
fi

if _on code_churn; then
  churn=""
  [ -n "$s_added" ]  && [ "$s_added" -gt 0 ]  2>/dev/null && churn="${GRN}+${s_added}${R}"
  [ -n "$s_removed" ] && [ "$s_removed" -gt 0 ] 2>/dev/null && { [ -n "$churn" ] && churn="${churn} "; churn="${churn}${RED}-${s_removed}${R}"; }
  [ -n "$churn" ] && seg2 "${DIM}\u270f\ufe0f${R} ${churn}"
fi

printf "%b\n" "${out}\n${l2}"
