#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin
#
# Runs on every refresh tick (1s), so forks are the enemy:
#   • one jq parses stdin AND statusline-segments.json together
#   • account identity (~/.claude.json is big) is mtime-cached to a tab file
#   • remote URL is read from .git/config in bash (no `git remote` fork)
#   • git status/diff only run when the git_dirty segment is enabled
#   • helpers return via printf -v globals (TC/FN/FD/FR/GRAD) — no $(...) subshells

# ── Extract all fields + segment visibility (single jq call) ─────────────
# statusline-segments.json (from statusline-setup) is slurped into the same
# invocation; keys toggled false land in $skip. jq reads stdin directly.
_cfg="$HOME/.claude/statusline-segments.json"
_segsrc=(--argjson _seg '[{}]')
[ -f "$_cfg" ] && _segsrc=(--slurpfile _seg "$_cfg")

eval "$(jq -r "${_segsrc[@]}" '{
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
  api_dur_ms:   (.cost.total_api_duration_ms // ""),
  skip:         ([($_seg[0] // {}) | objects | to_entries[] | select(.value == false) | .key] | join(" "))
} | to_entries[] | "\(.key)=\(.value | tostring | @sh)"' 2>/dev/null)"

_skip=" ${skip:-} "
_on() { [[ "$_skip" != *" $1 "* ]]; }

# ── Colors (Catppuccin Mocha 256-color) ──────────────────────────────────
R="\033[0m" DIM="\033[38;5;245m"
PEACH="\033[38;5;216m" YEL="\033[38;5;229m" GRN="\033[38;5;150m"
SAP="\033[38;5;117m"   RED="\033[38;5;211m" TEAL="\033[38;5;158m"
MAR="\033[38;5;217m"   MAUVE="\033[38;5;141m" SKY="\033[38;5;117m"
SEP=" ${DIM}|${R} "

# Cache wall-clock once; bash printf-builtin avoids a `date +%s` fork on
# each call site (rate segs, session-start).
printf -v NOW '%(%s)T' -1

# ── Helpers ──────────────────────────────────────────────────────────────
# All formatters write to globals via printf -v instead of echoing into
# $(...): a command substitution forks a subshell, and these run up to a
# dozen times per tick.
seg()  { [ -z "$out" ] && out="$1" || out="${out}${SEP}$1"; }      # line 1 append
seg2() { [ -z "$l2" ] && l2="$1" || l2="${l2}${SEP}$1"; }         # line 2 append

tcolor() { # val hi_thresh mid_thresh → sets TC
  if [ "$1" -ge "$2" ] 2>/dev/null; then TC="$RED"
  elif [ "$1" -ge "$3" ] 2>/dev/null; then TC="$YEL"
  else TC="$DIM"; fi
}

fmt_dur() { # seconds → sets FD: "XhYm" | "Xm" | "Xs"
  local h=$(( $1 / 3600 )) m=$(( ($1 % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then FD="${h}h${m}m"
  elif [ "$m" -gt 0 ]; then FD="${m}m"
  else FD="${1}s"; fi
}

fmt_n() { # token count → sets FN: "1.2k" / "145k" / "1.5M"
  local n=${1:-0}
  if [ "$n" -ge 1000000 ] 2>/dev/null; then
    printf -v FN '%d.%dM' $((n / 1000000)) $(( (n % 1000000) / 100000 ))
  elif [ "$n" -ge 1000 ] 2>/dev/null; then
    printf -v FN '%d.%dk' $((n / 1000)) $(( (n % 1000) / 100 ))
  else
    printf -v FN '%d' "$n"
  fi
}

fmt_remain() { # reset_epoch [time_emoji] → sets FR: " ⏳ XdYh" or ""
  FR=""
  [ -z "$1" ] || ! [ "$1" -gt 0 ] 2>/dev/null && return
  local diff=$(( $1 - NOW )) e="${2:-\\u23f3}"
  [ "$diff" -le 0 ] && return
  local d=$(( diff / 86400 )) h=$(( (diff % 86400) / 3600 )) m=$(( (diff % 3600) / 60 ))
  if [ "$d" -gt 0 ]; then FR=" ${e} ${d}d${h}h"
  elif [ "$h" -gt 0 ]; then FR=" ${e} ${h}h${m}m"
  else FR=" ${e} ${m}m"; fi
}

rate_seg() { # section_emoji pct reset_epoch [time_emoji]
  [ -z "$2" ] && return
  local pct; printf -v pct '%.0f' "$2"
  tcolor "$pct" 80 50; fmt_remain "$3" "$4"
  seg2 "${TC}${1} ${pct}%${FR}${R}"
}

gradient() { # text [palette] → sets GRAD: per-account color sweep
  # Static spatial gradient across the label. The periodic statusLine refresh
  # is intentionally disabled (no refreshInterval key), so there's no animation
  # timer — each event-driven re-render reads a fresh EPOCHREALTIME and drifts
  # the field a frame, but it no longer animates on a clock. Palette ($2)
  # selects the account's color family: gold (Max/Com), violet (Max/Net), blue
  # (Enterprise), pink (Team #1/#2). Pure bash fixed-point math, no forks. GRAD holds
  # interpreted ESC bytes (printf -v %b) — embed directly, don't re-%b it.
  local text="$1" pal="${2:-gold}" RST=$'\033[0m'
  local -a PR PG PB
  case "$pal" in
    violet) PR=(203 180 224 150) PG=(140 110 120 90 ) PB=(247 250 255 240) ;;  # purple→magenta — Max/Net
    blue)   PR=(0   64  138 33 ) PG=(160 196 224 182) PB=(255 255 255 255) ;;  # strong light blue — Enterprise
    pink)   PR=(255 255 255 250) PG=(77  120 160 100) PB=(148 180 205 170) ;;  # vivid pink — Team
    *)      PR=(230 255 255 250) PG=(150 190 224 204) PB=(0   0   60  15 ) ;;  # amber→gold — Max/Com
  esac
  local n=${#PR[@]} len=${#text}

  local et="${EPOCHREALTIME:-}"
  if [[ -z $et ]]; then # bash <5 / unset → static first stop, reset-terminated
    printf -v GRAD '%b' "\033[38;2;${PR[0]};${PG[0]};${PB[0]}m${text}${RST}"
    return
  fi

  local frac="${et#*.}"; frac="${frac}000"; frac="${frac:0:3}"
  local secs="${et%.*}"
  local phase=$(( 10#$secs * 1000 + 10#$frac ))

  local out='' i ch pos span m idx t j r g b
  span=$(( n * 1000 ))                  # palette ring width (1000 units/stop)
  for (( i = 0; i < len; i++ )); do
    ch="${text:i:1}"
    pos=$(( i * 1000 + phase / 2 ))     # 1 stop/char; phase/2 drifts the field
    m=$(( pos % span )); (( m < 0 )) && m=$(( m + span ))
    idx=$(( m / 1000 )); t=$(( m % 1000 )); j=$(( (idx + 1) % n ))
    r=$(( (PR[idx]*(1000 - t) + PR[j]*t) / 1000 ))
    g=$(( (PG[idx]*(1000 - t) + PG[j]*t) / 1000 ))
    b=$(( (PB[idx]*(1000 - t) + PB[j]*t) / 1000 ))
    out+="\033[38;2;${r};${g};${b}m${ch}"
  done
  printf -v GRAD '%b' "${out}${RST}"
}

# ── Git (consolidated calls) ─────────────────────────────────────────────
wt_name="" repo_name="" git_branch="" git_dirty=""
if [ -n "$cwd" ]; then
  # Worktree + branch: single rev-parse
  { read -r gc; read -r gd; read -r git_branch; } \
    < <(git -C "$cwd" --no-optional-locks rev-parse --git-common-dir --git-dir --abbrev-ref HEAD 2>/dev/null)
  [ -n "$gc" ] && [ -n "$gd" ] && [ "$gc" != "$gd" ] && wt_name=${cwd##*/}

  # Repo name: read `[remote "origin"] url` straight out of the common-dir
  # config file — pure bash, replaces a `git remote get-url` fork. (Skips
  # url.*.insteadOf rewrites, which don't change the basename.)
  if [ -n "$gc" ]; then
    [[ "$gc" != /* ]] && gc="$cwd/$gc"
    if [ -r "$gc/config" ]; then
      _sect=0
      while IFS= read -r cline; do
        if [[ "$cline" =~ ^[[:space:]]*\[ ]]; then
          [[ "$cline" == *'[remote "origin"]'* ]] && _sect=1 || _sect=0
        elif (( _sect )) && [[ "$cline" =~ ^[[:space:]]*url[[:space:]]*=[[:space:]]*([^[:space:]]+) ]]; then
          repo_name="${BASH_REMATCH[1]##*/}"; repo_name=${repo_name%.git}
          break
        fi
      done < "$gc/config"
    fi
  fi

  # Dirty-state scan is the priciest part of the tick — only pay for it
  # when the segment is actually displayed (needs both branch + dirty on).
  if [ -n "$git_branch" ] && _on git_branch && _on git_dirty; then
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
# Pure-bash fixed point in micro-dollars (replaces an awk fork); each
# branch rounds to its display resolution with carry, matching %.Nf.
session_cost="" cost_rate=""
if [[ "$cost_usd" =~ ^([0-9]+)(\.([0-9]+))?$ ]]; then
  _cf="${BASH_REMATCH[3]}000000"
  _micro=$(( 10#${BASH_REMATCH[1]} * 1000000 + 10#${_cf:0:6} ))
  if [ "$_micro" -gt 0 ]; then
    if [ "$_micro" -lt 10000 ]; then        # < 1¢ → "0.42¢"
      _r=$(( (_micro + 50) / 100 ))
      printf -v session_cost '%d.%02d¢' $(( _r / 100 )) $(( _r % 100 ))
    elif [ "$_micro" -lt 1000000 ]; then    # < $1 → "$0.123"
      _r=$(( (_micro + 500) / 1000 ))
      printf -v session_cost '$%d.%03d' $(( _r / 1000 )) $(( _r % 1000 ))
    else                                    # ≥ $1 → "$3.46"
      _r=$(( (_micro + 5000) / 10000 ))
      printf -v session_cost '$%d.%02d' $(( _r / 100 )) $(( _r % 100 ))
    fi
    if [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 60000 ] 2>/dev/null; then
      _rm=$(( _micro * 3600000 / total_dur_ms ))   # burn rate, micro-$/h
      if [ "$_rm" -ge 10000000 ]; then             # ≥ $10/h → 1 decimal
        _r=$(( (_rm + 50000) / 100000 ))
        printf -v cost_rate '$%d.%d/h' $(( _r / 10 )) $(( _r % 10 ))
      else
        _r=$(( (_rm + 5000) / 10000 ))
        printf -v cost_rate '$%d.%02d/h' $(( _r / 100 )) $(( _r % 100 ))
      fi
    fi
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 1: repo · branch · model · operational
# ═════════════════════════════════════════════════════════════════════════
out=""
if _on repo_name && [ -n "$repo_name" ]; then
  out="${MAUVE}\U0001f5c2️ ${repo_name}${R}"
else
  out="${YEL}${cwd##*/}${R}"
fi
_on wt_name && [ -n "$wt_name" ] && seg "${TEAL}\U0001f332 ${wt_name}${R}"

if _on git_branch && [ -n "$git_branch" ]; then
  seg "${GRN}☘️ ${git_branch}${R}"
  _on git_dirty && [ -n "$git_dirty" ] && out="${out} ${MAR}${git_dirty}${R}"
fi

# Model: strip " 4.5"-style versions, shorten " (1M context)" → " 1M" —
# pure-bash regex replaces a sed fork.
if _on model && [ -n "$model" ]; then
  m="$model"
  [[ $m =~ ^(.*)\ [0-9]+\.[0-9]+(.*)$ ]] && m="${BASH_REMATCH[1]}${BASH_REMATCH[2]}"
  [[ $m =~ ^(.*)\ \(([0-9]+[KMG])\ context\)(.*)$ ]] && m="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}${BASH_REMATCH[3]}"
  seg "${SAP}${m}${R}"
fi

# Reasoning effort — Lo / Me / Hi / Xh / Mx — grouped with model since
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

# Extended thinking — only show when enabled (off is the default state).
_on thinking && [ "$thinking" = "true" ] && seg "${YEL}\U0001f4ad${R}"

# Active subagent (--agent foo or via agent settings).
_on agent && [ -n "$agent_name" ] && seg "${TEAL}\U0001f916 ${agent_name}${R}"

# Non-default output style (Explanatory / Learning / custom user style).
_on out_style && [ -n "$out_style" ] && [ "$out_style" != "default" ] && \
  [ "$out_style" != "Default" ] && seg "${DIM}\U0001f3a8 ${out_style}${R}"

_on session_name && [ -n "$session_name" ] && seg "${DIM}${session_name}${R}"
_on vim_mode && [ -n "$vim_mode" ] && { [ "$vim_mode" = "NORMAL" ] && seg "${YEL}N${R}" || seg "${DIM}I${R}"; }

if _on api_ratio && [ -n "$total_dur_ms" ] && [ -n "$api_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null; then
  ratio=$(( api_dur_ms * 100 / total_dur_ms ))
  tcolor "$ratio" 80 50
  seg "${TC}⚙️ ${ratio}%${R}"
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 2: account · gauges · tokens · cost
# ═════════════════════════════════════════════════════════════════════════
l2=""

# Logged-in account — 4 accounts across 2 emails (.com / .net), each with an
# org account (Enterprise / Team) and a personal Max plan. Resolve from
# ~/.claude.json oauthAccount {emailAddress, organizationType}; the statusline
# stdin payload doesn't carry it. ~/.claude.json is big and changes rarely
# relative to the 1s tick, so the jq parse is mtime-cached ([ -nt ] is a
# builtin — zero forks on the hot path).
if _on account; then
  acct_email="" acct_otype=""
  _ac="$HOME/.claude/.statusline-account-cache"
  if [ -f "$_ac" ] && ! [ "$HOME/.claude.json" -nt "$_ac" ]; then
    IFS=$'\t' read -r acct_email acct_otype < "$_ac"
  else
    IFS=$'\t' read -r acct_email acct_otype < <(
      jq -r '.oauthAccount | "\(.emailAddress // "")\t\(.organizationType // "")"' \
        "$HOME/.claude.json" 2>/dev/null)
    printf '%s\t%s\n' "$acct_email" "$acct_otype" > "$_ac" 2>/dev/null
  fi
  if [ -n "$acct_email" ]; then
    acct_dom=${acct_email##*@}            # evinced.com / evinced.net
    acct_label=""
    case "$acct_dom" in
      *.com)
        if [ "$acct_otype" = "claude_max" ]; then acct_label="Max/Com"
        else acct_label="Enterprise"; fi ;;
      *.net)
        # Two Team accounts share the .net domain — disambiguate by the email
        # local part: aryeh.kiovetsky2 → Team#2, the original → Team#1.
        if [ "$acct_otype" = "claude_max" ]; then acct_label="Max/Net"
        elif [ "${acct_email%%@*}" = "aryeh.kiovetsky2" ]; then acct_label="Team#2"
        else acct_label="Team#1"; fi ;;
      *) acct_label="$acct_dom" ;;
    esac
    if [ -n "$acct_label" ]; then
      # Color family per account: Max/Net → violet, Max/Com → gold,
      # Enterprise → blue, Team (both #1/#2) → pink.
      case "$acct_label" in
        Max/Net)    _pal=violet ;;
        Max/*)      _pal=gold ;;
        Enterprise) _pal=blue ;;
        Team*)      _pal=pink ;;
        *)          _pal=gold ;;
      esac
      gradient "$acct_label" "$_pal"
      # Emoji stays static (glyphs ignore fg color); the label carries the gradient.
      seg2 "${MAUVE}\U0001f464${R} ${GRAD}"
    fi
  fi
fi

# Context capacity gauge — how full is the window. 🧠 (brain) since the
# context is what the model thinks with.
if _on ctx_usage && [ -n "$used_pct" ]; then
  printf -v ctx '%.0f' "$used_pct"
  tcolor "$ctx" 80 50
  seg2 "${TC}\U0001f9e0 ${ctx}%${R}"
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
  fmt_n "$fresh"; tok="${SAP}⬆ ${FN}${R}"
  [ "$ccr" -gt 0 ] && { fmt_n "$ccr"; tok="${tok} ${DIM}→ ${GRN}\U0001f4d6 ${FN} ${hit}%${R}"; }
  [ "$cot" -gt 0 ] && { fmt_n "$cot"; tok="${tok} ${DIM}→ ${PEACH}⬇ ${FN}${R}"; }
  seg2 "$tok"
fi

# Cost: real session cost + per-hour burn rate, merged into one segment.
if _on cost && [ -n "$session_cost" ]; then
  c="${PEACH}\U0001f4b0 ${session_cost}${R}"
  _on cost_rate && [ -n "$cost_rate" ] && c="${c} ${DIM}· ${cost_rate}${R}"
  seg2 "$c"
fi

_on session_dur && [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null && \
  { fmt_dur $(( total_dur_ms / 1000 )); seg2 "${DIM}\U0001faab ${FD}${R}"; }

_on five_hour_rl && rate_seg "\U0001f6dd" "$five_pct" "$five_reset" "\\u23f3"
_on weekly_rl && rate_seg "\U0001f4c5" "$week_pct" "$week_reset" "\\U0001f570\\ufe0f"

_on tier_warn && [ "$over_200k" = "true" ] && seg2 "${RED}⚠️ 1M-tier${R}"

# Cumulative session tokens — opt-in (off by default; misleading because
# every API call's full input is summed, including cache rereads).
if _on tokens_total && { [ -n "$tokens_in" ] || [ -n "$tokens_out" ]; }; then
  tok=""
  [ -n "$tokens_in" ]  && { fmt_n "${tokens_in:-0}";  tok="${DIM}Σ⬆ ${FN}${R}"; }
  [ -n "$tokens_out" ] && { fmt_n "${tokens_out:-0}"; tok="${tok} ${DIM}Σ⬇ ${FN}${R}"; }
  seg2 "$tok"
fi

if _on code_churn; then
  churn=""
  [ -n "$s_added" ]  && [ "$s_added" -gt 0 ]  2>/dev/null && churn="${GRN}+${s_added}${R}"
  [ -n "$s_removed" ] && [ "$s_removed" -gt 0 ] 2>/dev/null && { [ -n "$churn" ] && churn="${churn} "; churn="${churn}${RED}-${s_removed}${R}"; }
  [ -n "$churn" ] && seg2 "${DIM}✏️${R} ${churn}"
fi

printf "%b\n" "${out}\n${l2}"
