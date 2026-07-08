#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin
#
# Runs on every refresh tick (1s), so forks are the enemy:
#   • one jq parses stdin AND statusline-segments.json together
#   • account identity (~/.claude.json is big) is mtime-cached to a tab file
#   • repo root / worktree / branch are read straight off .git files in bash
#     (pointer file, commondir, HEAD) — no `git rev-parse` fork
#   • remote URL is read from .git/config in bash (no `git remote` fork)
#   • the dirty scan (status + numstat, the priciest part) runs only when the
#     git_dirty segment is enabled, in ONE process substitution, and its
#     result is TTL-cached (4s) keyed on repo root — bursty event-driven
#     re-renders are fork-free
#   • gauge bars substring a pre-built fill string — no per-cell loop
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
  over_200k:    (.exceeds_200k_tokens // false),
  s_added:      (.cost.total_lines_added // ""),
  s_removed:    (.cost.total_lines_removed // ""),
  skip:         ([($_seg[0] // {}) | objects | to_entries[] | select(.value == false) | .key] | join(" "))
} | to_entries[] | "\(.key)=\(.value | tostring | @sh)"' 2>/dev/null)"

_skip=" ${skip:-} "
_on() { [[ "$_skip" != *" $1 "* ]]; }

# ── Colors (Catppuccin Mocha 256-color) ──────────────────────────────────
R="\033[0m" DIM="\033[38;5;245m"
PEACH="\033[38;5;216m" YEL="\033[38;5;229m" GRN="\033[38;5;150m"
SAP="\033[38;5;117m"   RED="\033[38;5;211m" TEAL="\033[38;5;158m"
MAR="\033[38;5;217m"   MAUVE="\033[38;5;141m" SKY="\033[38;5;117m"
CTX_COL="\033[38;2;77;165;220m"    # #4da5dc — CTX label (context gauge)
FIVEHR_COL="\033[38;2;237;117;78m" # #ed754e — 5H label (5-hour window gauge)
DAY_COL="\033[38;2;229;114;74m"    # #e5724a — 7D label (7-day window gauge)
SEP=" ${DIM}|${R} "

# Per-gauge bar fill — each gauge fades a light tint (cell 0) → its saturated
# hue (cell 9) across the 10 cells, so the three bars read as distinct channels
# and depth grows with fill. Prefixes are precomputed once (see build_grad).
build_grad() { # arrname r0 g0 b0 r1 g1 b1 → global array of 11 filled-cell prefixes
  local -n _a="$1"; local r0=$2 g0=$3 b0=$4 r1=$5 g1=$6 b1=$7 i r g b acc=""
  _a=("")
  for (( i = 0; i < 10; i++ )); do
    r=$(( r0 + (r1 - r0) * i / 9 ))
    g=$(( g0 + (g1 - g0) * i / 9 ))
    b=$(( b0 + (b1 - b0) * i / 9 ))
    acc+="\033[38;2;${r};${g};${b}m█"
    _a+=("$acc")
  done
}
build_grad _CTX_FB 223 177  96 160  53  47   # #dfb160 → #a0352f — CTX (gold→crimson)
build_grad _5H_FB   80 155 197 196  60  60   # #509bc5 → #c43c3c — 5H (blue→red)
build_grad _7D_FB  162 166 211  72  47 134   # #a2a6d3 → #482f86 — 7D (indigo)

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

fmt_remain() { # reset_epoch [time_emoji] → sets FR: " ⏳ XdYh" or " XdYh" (emoji arg "") or ""
  FR=""
  [ -z "$1" ] || ! [ "$1" -gt 0 ] 2>/dev/null && return
  local diff=$(( $1 - NOW )) e="${2-\\u23f3}"
  [ "$diff" -le 0 ] && return
  local d=$(( diff / 86400 )) h=$(( (diff % 86400) / 3600 )) m=$(( (diff % 3600) / 60 ))
  local lead=""; [ -n "$e" ] && lead="${e} "
  if [ "$d" -gt 0 ]; then FR=" ${lead}${d}d${h}h"
  elif [ "$h" -gt 0 ]; then FR=" ${lead}${h}h${m}m"
  else FR=" ${lead}${m}m"; fi
}

# All gauges render at width 10. Each gauge's filled prefixes are precomputed
# by build_grad (light→dark), so mkbar is a pure array lookup + substring — no
# per-cell loop.
_E10="░░░░░░░░░░"
_BORD="\033[38;5;252m"   # bright neutral rail — contrasts both filled + empty cells

mkbar() { # pct gradarray → sets BAR: railed █ bar, filled cells fading light→dark
  local -n _fb="$2"
  local filled=$(( ($1 * 10 + 50) / 100 ))
  (( filled > 10 )) && filled=10
  (( filled < 0 )) && filled=0
  BAR="${_BORD}▐${R}${_fb[filled]}${DIM}${_E10:0:10-filled}${_BORD}▌${R}"
}

gradient() { # text [palette] → sets GRAD: per-account color sweep
  # Static spatial gradient across the label. The periodic statusLine refresh
  # is intentionally disabled (no refreshInterval key), so there's no animation
  # timer — each event-driven re-render reads a fresh EPOCHREALTIME and drifts
  # the field a frame, but it no longer animates on a clock. Palette ($2)
  # selects the account's color family: gold (Max/Com), violet (Max/Net), blue
  # (Enterprise), magenta→orange spectrum (Team#0 magenta / #1 pink / #2 coral /
  # #3 orange). Pure bash fixed-point math, no forks. GRAD holds
  # interpreted ESC bytes (printf -v %b) — embed directly, don't re-%b it.
  local text="$1" pal="${2:-gold}" RST=$'\033[0m'
  local -a PR PG PB
  case "$pal" in
    violet) PR=(203 180 224 150) PG=(140 110 120 90 ) PB=(247 250 255 240) ;;  # purple→magenta — Max/Net
    blue)   PR=(0   64  138 33 ) PG=(160 196 224 182) PB=(255 255 255 255) ;;  # strong light blue — Enterprise
    team0)  PR=(225 255 240 210) PG=(60  95  72  48 ) PB=(200 230 215 190) ;;  # magenta/fuchsia — Team#0
    team1)  PR=(255 255 255 245) PG=(77  128 105 90 ) PB=(148 180 160 140) ;;  # hot pink — Team#1
    team2)  PR=(255 255 255 250) PG=(110 145 125 100) PB=(110 120 100 90 ) ;;  # coral/salmon — Team#2
    team3)  PR=(255 255 255 250) PG=(150 178 138 160) PB=(40  75  30  55 ) ;;  # orange — Team#3
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

# ── Git (pure-bash discovery, TTL-cached dirty scan) ─────────────────────
# Repo root / worktree / branch come straight off the filesystem (.git
# pointer file, commondir, HEAD) — replaces the `git rev-parse` fork.
wt_name="" repo_name="" git_branch="" git_dirty="" _root=""
if [ -n "$cwd" ]; then
  _root="$cwd"
  while [ -n "$_root" ] && [ ! -e "$_root/.git" ]; do _root="${_root%/*}"; done
fi
if [ -n "$_root" ]; then
  gd="$_root/.git" gc=""
  if [ -f "$gd" ]; then                       # pointer file: worktree/submodule
    IFS= read -r _l < "$gd"
    gd="${_l#gitdir: }"
    [[ "$gd" != /* ]] && gd="$_root/$gd"
    if [ -f "$gd/commondir" ]; then           # linked worktree → resolve common dir
      IFS= read -r _cd < "$gd/commondir"
      [[ "$_cd" != /* ]] && _cd="$gd/$_cd"
      gc="$_cd" wt_name=${cwd##*/}
    else gc="$gd"; fi                         # submodule: common == git dir
  else gc="$gd"; fi

  # Branch: parse HEAD directly — "ref: refs/heads/x" → x; detached → "HEAD"
  # (matches `rev-parse --abbrev-ref HEAD`).
  if [ -r "$gd/HEAD" ]; then
    IFS= read -r _h < "$gd/HEAD"
    case "$_h" in
      "ref: refs/heads/"*) git_branch="${_h#ref: refs/heads/}" ;;
      "ref: "*)            git_branch="${_h#ref: }" ;;
      *)                   git_branch="HEAD" ;;
    esac
  fi

  # Repo name: read `[remote "origin"] url` straight out of the common-dir
  # config file — pure bash, replaces a `git remote get-url` fork. (Skips
  # url.*.insteadOf rewrites, which don't change the basename.)
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

  # Dirty-state scan is the priciest part of the tick — only pay for it when
  # the segment is displayed (branch + dirty both on), and TTL-cache the
  # result (4s, keyed on repo root): event-driven renders burst, and a burst
  # should fork git exactly once. Both git calls share one process
  # substitution, split by a \x01 sentinel line.
  if [ -n "$git_branch" ] && _on git_branch && _on git_dirty; then
    _gcf="$HOME/.claude/.statusline-git-dirty-cache" _hit=""
    if [ -r "$_gcf" ]; then
      { IFS= read -r _ce; IFS= read -r _cr; IFS= read -r git_dirty; } < "$_gcf"
      if [[ "$_ce" =~ ^[0-9]+$ ]] && [ "$_cr" = "$_root" ] && (( NOW - _ce < 4 )); then
        _hit=1
      else git_dirty=""; fi
    fi
    if [ -z "$_hit" ]; then
      # File counts: porcelain replaces diff + diff --cached + ls-files;
      # `diff HEAD --numstat` covers staged+unstaged lines in one call.
      changed=0 untracked=0 la=0 lr=0 _num=""
      while IFS= read -r line; do
        [ "$line" = $'\x01' ] && { _num=1; continue; }
        if [ -z "$_num" ]; then
          x=${line:0:1} y=${line:1:1}
          if [ "$x" = "?" ]; then (( untracked++ ))
          else [ "$x" != " " ] && (( changed++ )); [ "$y" != " " ] && (( changed++ )); fi
        else
          added="${line%%$'\t'*}" _rest="${line#*$'\t'}" removed="${_rest%%$'\t'*}"
          [[ "$added" =~ ^[0-9]+$ ]] && la=$((la + added))
          [[ "$removed" =~ ^[0-9]+$ ]] && lr=$((lr + removed))
        fi
      done < <(git -C "$cwd" --no-optional-locks status --porcelain 2>/dev/null
               printf '\x01\n'
               git -C "$cwd" --no-optional-locks diff HEAD --numstat 2>/dev/null)

      p=""
      [ "$changed" -gt 0 ]   && p="\U0001f4c4 ${changed}"
      [ "$untracked" -gt 0 ] && { [ -n "$p" ] && p="${p} "; p="${p}\U0001f50e ${untracked}"; }
      dp=""
      [ "$la" -gt 0 ] && dp="${GRN}+${la}${R}"
      [ "$lr" -gt 0 ] && { [ -n "$dp" ] && dp="${dp} "; dp="${dp}${RED}-${lr}${R}"; }
      [ -n "$dp" ] && { [ -n "$p" ] && p="${p} "; p="${p}${dp}"; }
      git_dirty="$p"
      printf '%s\n%s\n%s\n' "$NOW" "$_root" "$git_dirty" > "$_gcf" 2>/dev/null
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

# Model: keep the version, shorten " (1M context)" → " 1M" —
# pure-bash regex replaces a sed fork.
if _on model && [ -n "$model" ]; then
  m="$model"
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

# Active subagent (--agent foo or via agent settings).
_on agent && [ -n "$agent_name" ] && seg "${TEAL}\U0001f916 ${agent_name}${R}"

# Non-default output style (Explanatory / Learning / custom user style).
_on out_style && [ -n "$out_style" ] && [ "$out_style" != "default" ] && \
  [ "$out_style" != "Default" ] && seg "${DIM}\U0001f3a8 ${out_style}${R}"

_on session_name && [ -n "$session_name" ] && seg "${DIM}${session_name}${R}"
_on vim_mode && [ -n "$vim_mode" ] && { [ "$vim_mode" = "NORMAL" ] && seg "${YEL}N${R}" || seg "${DIM}I${R}"; }

# ═════════════════════════════════════════════════════════════════════════
# Line 2: account · duration · gauges · tokens
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
        # Four Team accounts share the .net domain — disambiguate by the email
        # local part: aryeh.kiovetsky{1,2,3} → Team#{1,2,3}, the base
        # aryeh.kiovetsky → Team#0.
        if [ "$acct_otype" = "claude_max" ]; then acct_label="Max/Net"
        else case "${acct_email%%@*}" in
          aryeh.kiovetsky1) acct_label="Team#1" ;;
          aryeh.kiovetsky2) acct_label="Team#2" ;;
          aryeh.kiovetsky3) acct_label="Team#3" ;;
          *)                acct_label="Team#0" ;;
        esac; fi ;;
      *) acct_label="$acct_dom" ;;
    esac
    if [ -n "$acct_label" ]; then
      # Color family per account: Max/Net → violet, Max/Com → gold, Enterprise →
      # blue. The Team accounts share a magenta→orange spectrum, one shade each:
      # Team#0 magenta, Team#1 pink, Team#2 coral, Team#3 orange.
      case "$acct_label" in
        Max/Net)    _pal=violet ;;
        Max/*)      _pal=gold ;;
        Enterprise) _pal=blue ;;
        Team#0)     _pal=team0 ;;
        Team#1)     _pal=team1 ;;
        Team#2)     _pal=team2 ;;
        Team#3)     _pal=team3 ;;
        Team*)      _pal=team0 ;;
        *)          _pal=gold ;;
      esac
      gradient "$acct_label" "$_pal"
      # Emoji stays static (glyphs ignore fg color); the label carries the gradient.
      seg2 "${MAUVE}\U0001f464${R} ${GRAD}"
    fi
  fi
fi

# Session duration — right after the account so the "how long have I been at
# this" read comes first. Full battery 🔋 for the first 4h, low battery 🪫 after.
if _on session_dur && [ -n "$total_dur_ms" ] && [ "$total_dur_ms" -gt 0 ] 2>/dev/null; then
  fmt_dur $(( total_dur_ms / 1000 ))
  if [ "$total_dur_ms" -lt 14400000 ]; then _batt="\U0001f50b"; else _batt="\U0001faab"; fi
  seg2 "${DIM}${_batt} ${FD}${R}"
fi

# Context capacity gauge — how full is the window.
if _on ctx_usage && [ -n "$used_pct" ]; then
  printf -v ctx '%.0f' "$used_pct"
  tcolor "$ctx" 80 50; mkbar "$ctx" _CTX_FB
  seg2 "${CTX_COL}CTX${R} ${BAR} ${TC}${ctx}%${R}"
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

# 5-hour rate-limit window: fixed-color "5H" label instead of a dynamic-
# colored emoji; countdown is a bare duration, no emoji/label of its own.
if _on five_hour_rl && [ -n "$five_pct" ]; then
  printf -v _fpct '%.0f' "$five_pct"
  tcolor "$_fpct" 80 50; mkbar "$_fpct" _5H_FB; fmt_remain "$five_reset" ""
  seg2 "${FIVEHR_COL}5H${R} ${BAR} ${TC}${_fpct}%${FR}${R}"
fi
# 7-day rate-limit window: fixed-color "7D" label instead of the dynamic-
# colored 📅 emoji; countdown is a bare duration, matching 5H.
if _on weekly_rl && [ -n "$week_pct" ]; then
  printf -v _wpct '%.0f' "$week_pct"
  tcolor "$_wpct" 80 50; mkbar "$_wpct" _7D_FB; fmt_remain "$week_reset" ""
  seg2 "${DAY_COL}7D${R} ${BAR} ${TC}${_wpct}%${FR}${R}"
fi

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
