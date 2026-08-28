#!/usr/bin/env bash
# Claude Code status line — Catppuccin Mocha palette
# Input: JSON via stdin
#
# Runs on every refresh tick (60s), so forks are the enemy:
#   • the stdin payload + statusline-segments.json are parsed in PURE BASH
#     ([[ =~ ]] + BASH_REMATCH, zero forks) — replaced the one-jq parse, which
#     profiled as ~5ms of a ~17ms render (see parse_payload below)
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

# ── Extract all fields (pure bash, no jq fork) ───────────────────────────
# The statusline runs on every 1s refresh across every open window, so the
# single jq that used to parse the payload was the dominant per-render cost:
# ~5ms of a ~17ms render (measured — the bash body + everything else profiled
# under 1ms combined). parse_payload reads the same fields with `[[ =~ ]]` +
# BASH_REMATCH and ZERO forks — no $(...) and no echoing helpers, since a
# command substitution forks a subshell PER FIELD, which is the very cost this
# removes (see the header). Verified byte-identical to the old jq across a
# payload matrix by config/statusline-parse.test.sh (run in CI via
# tools/statusline_parse.test.ts).
parse_payload() {
  local j="$1" _m _eff _vim _ag _os _sd _fh _rest
  local Sr='":"([^"]*)"' Nr='":(-?[0-9][0-9.eE+-]*)'   # string / number key-tails

  # cwd: workspace.current_dir, else top-level cwd (jq's // only falls through
  # on absent/null, so a present current_dir — even "" — wins, matching jq).
  if   [[ $j =~ \"current_dir\":\"([^\"]*)\" ]]; then cwd="${BASH_REMATCH[1]}"
  elif [[ $j =~ \"cwd\":\"([^\"]*)\" ]];         then cwd="${BASH_REMATCH[1]}"
  else cwd=""; fi

  session_name=""; [[ $j =~ \"session_name$Sr ]] && session_name="${BASH_REMATCH[1]}"
  sid="";          [[ $j =~ \"session_id$Sr ]]   && sid="${BASH_REMATCH[1]}"

  ctx_size="";   [[ $j =~ \"context_window_size$Nr ]]   && ctx_size="${BASH_REMATCH[1]}"
  api_dur_ms=""; [[ $j =~ \"total_api_duration_ms$Nr ]] && api_dur_ms="${BASH_REMATCH[1]}"
  s_added="";    [[ $j =~ \"total_lines_added$Nr ]]     && s_added="${BASH_REMATCH[1]}"
  s_removed="";  [[ $j =~ \"total_lines_removed$Nr ]]   && s_removed="${BASH_REMATCH[1]}"

  # scoped scalars — capture the FLAT parent body ([^{}]* = no nested object),
  # then read the field from it (order-independent within the parent).
  _m=""; [[ $j =~ \"model\":\{([^{}]*)\} ]] && _m="${BASH_REMATCH[1]}"
  model="";    [[ $_m =~ \"display_name$Sr ]] && model="${BASH_REMATCH[1]}"
  model_id=""; [[ $_m =~ \"id$Sr ]]           && model_id="${BASH_REMATCH[1]}"

  _eff=""; [[ $j =~ \"effort\":\{([^{}]*)\} ]] && _eff="${BASH_REMATCH[1]}"
  effort=""; [[ $_eff =~ \"level$Sr ]] && effort="${BASH_REMATCH[1]}"
  _vim=""; [[ $j =~ \"vim\":\{([^{}]*)\} ]] && _vim="${BASH_REMATCH[1]}"
  vim_mode=""; [[ $_vim =~ \"mode$Sr ]] && vim_mode="${BASH_REMATCH[1]}"
  _ag=""; [[ $j =~ \"agent\":\{([^{}]*)\} ]] && _ag="${BASH_REMATCH[1]}"
  agent_name=""; [[ $_ag =~ \"name$Sr ]] && agent_name="${BASH_REMATCH[1]}"
  _os=""; [[ $j =~ \"output_style\":\{([^{}]*)\} ]] && _os="${BASH_REMATCH[1]}"
  out_style=""; [[ $_os =~ \"name$Sr ]] && out_style="${BASH_REMATCH[1]}"

  # thinking: "" unless a thinking object carries an "enabled" bool
  thinking=""; [[ $j =~ \"thinking\":\{[^{}]*\"enabled\":(true|false) ]] && thinking="${BASH_REMATCH[1]}"
  over_200k=false; [[ $j =~ \"exceeds_200k_tokens\":(true|false) ]] && over_200k="${BASH_REMATCH[1]}"

  _sd=""; [[ $j =~ \"seven_day\":\{([^{}]*)\} ]] && _sd="${BASH_REMATCH[1]}"
  week_pct="";   [[ $_sd =~ \"used_percentage$Nr ]] && week_pct="${BASH_REMATCH[1]}"
  week_reset=""; [[ $_sd =~ \"resets_at$Nr ]]       && week_reset="${BASH_REMATCH[1]}"
  _fh=""; [[ $j =~ \"five_hour\":\{([^{}]*)\} ]] && _fh="${BASH_REMATCH[1]}"
  five_pct="";   [[ $_fh =~ \"used_percentage$Nr ]] && five_pct="${BASH_REMATCH[1]}"
  five_reset=""; [[ $_fh =~ \"resets_at$Nr ]]       && five_reset="${BASH_REMATCH[1]}"

  # context_window.used_percentage: 3 keys share the name (context_window +
  # seven_day + five_hour). Drop the two flat rate-limit blocks (captured above)
  # so context_window's is the only used_percentage left — order-independent,
  # no brace walking.
  _rest="$j"
  [ -n "$_sd" ] && _rest="${_rest/\"seven_day\":\{$_sd\}/}"
  [ -n "$_fh" ] && _rest="${_rest/\"five_hour\":\{$_fh\}/}"
  used_pct=""; [[ $_rest =~ \"used_percentage$Nr ]] && used_pct="${BASH_REMATCH[1]}"
}

# Slurp the whole stdin payload into a var, fork-free (`read -d ''` reads to
# EOF; the nonzero rc at EOF is expected and ignored).
IFS= read -r -d '' _payload 2>/dev/null || true
parse_payload "$_payload"

# Segment visibility: statusline-segments.json (from statusline-setup) lists
# segments toggled off. Read it in bash — each key with a literal false value
# lands in $skip. Absent file (the common case) → nothing skipped, no fork.
_cfg="$HOME/.claude/statusline-segments.json" skip=""
if [ -f "$_cfg" ]; then
  _segj=""; IFS= read -r -d '' _segj < "$_cfg" 2>/dev/null || true
  while [[ $_segj =~ \"([a-zA-Z_]+)\"[[:space:]]*:[[:space:]]*false ]]; do
    skip="$skip ${BASH_REMATCH[1]}"
    _segj="${_segj/${BASH_REMATCH[0]}/}"        # drop the match so the loop advances
  done
fi
_skip=" ${skip} "
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
seg3() { [ -z "$l3" ] && l3="$1" || l3="${l3}${SEP}$1"; }         # line 3 append

tcolor() { # val hi_thresh mid_thresh → sets TC
  if [ "$1" -ge "$2" ] 2>/dev/null; then TC="$RED"
  elif [ "$1" -ge "$3" ] 2>/dev/null; then TC="$YEL"
  else TC="$DIM"; fi
}

fmt_dur() { # seconds → sets FD: "XhYm" | "Xm" | "<1m"  (minute granularity, no seconds)
  local h=$(( $1 / 3600 )) m=$(( ($1 % 3600) / 60 ))
  if [ "$h" -gt 0 ]; then FD="${h}h${m}m"
  elif [ "$m" -gt 0 ]; then FD="${m}m"
  else FD="<1m"; fi
}

fmt_age() { # seconds → sets FA: "<1m" | "Xm" | "H:MM" — session-age scale
  # Minute granularity (no seconds): sub-minute reads "<1m", sub-hour in whole
  # minutes, hours as a clock face (2:06) rather than fmt_dur's "2h6m" — a
  # long-lived process reads as an elapsed clock, which is what "session age" wants.
  if [ "$1" -lt 60 ]; then FA="<1m"
  elif [ "$1" -lt 3600 ]; then FA="$(( $1 / 60 ))m"
  else printf -v FA '%d:%02d' $(( $1 / 3600 )) $(( ($1 % 3600) / 60 )); fi
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

# Claude Code start epoch → sets PROCSTART (0 when unresolvable).
#
# Hoisted out of the session-times block because the usage snapshot needs it
# too: a snapshot is only attributable when the RENDERING process was launched
# under the currently-recorded identity (see the snapshot guard below).
#
# Claude Code execs the statusline directly, so $PPID is the `claude` process —
# stable across renders, distinct per window. Cached per-PPID: the warm path is
# a single file read, zero forks (matching the git/account caches). Only a cold
# miss touches ps+date. If a shell wrapper ever sits between (PPID != claude),
# walk ancestors to find claude and skip the cache — the wrapper pid is
# ephemeral, so caching it would leak a file per render and never hit anyway.
#
# Memoized for the render: process start can't change within a single tick, and
# two call sites need it (the usage-snapshot guard and the session-times block).
# The first call resolves; the second returns instantly, sparing a file read on
# the warm path and an entire ps-ancestor-walk + date fork on a cold miss.
resolve_procstart() {
  [ -n "${_PS_DONE:-}" ] && return
  _PS_DONE=1
  PROCSTART=0
  local _ccpid="$PPID" _psf="$HOME/.claude/.statusline-procstart-${PPID}"
  local _v="" _ppcomm _p _c _ls
  [ -r "$_psf" ] && IFS= read -r _v < "$_psf"
  if [ "$_v" -gt 0 ] 2>/dev/null; then PROCSTART="$_v"; return; fi
  _ppcomm=$(ps -o comm= -p "$PPID" 2>/dev/null); _ppcomm="${_ppcomm##*/}"
  if [ "$_ppcomm" != "claude" ]; then             # resolve claude via ancestors
    _p=$PPID
    for _ in 1 2 3 4 5 6; do
      _p=$(ps -o ppid= -p "$_p" 2>/dev/null); _p="${_p//[[:space:]]/}"
      { [ -n "$_p" ] && [ "$_p" -gt 1 ] 2>/dev/null; } || break
      _c=$(ps -o comm= -p "$_p" 2>/dev/null)
      [ "${_c##*/}" = "claude" ] && { _ccpid="$_p"; break; }
    done
  fi
  _ls=$(ps -o lstart= -p "$_ccpid" 2>/dev/null)
  _ls="${_ls%"${_ls##*[![:space:]]}"}"            # rstrip trailing spaces
  [ -n "$_ls" ] || return
  _v=$(date -j -f "%a %b %d %T %Y" "$_ls" +%s 2>/dev/null) \
    || _v=$(date -d "$_ls" +%s 2>/dev/null)       # GNU/Linux fallback
  [ "$_v" -gt 0 ] 2>/dev/null || return
  PROCSTART="$_v"
  [ "$_ppcomm" = "claude" ] && printf '%s\n' "$_v" > "$_psf" 2>/dev/null
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

# Enterprise variant: rate-limit bars fill with 🔸 instead of the gradient
# (org plan — the windows aren't the personal quota story, so the fill is a
# marker, not a heat gradient).
_D10=$'\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538\U0001f538'
mkbar_ent() { # pct → sets BAR: railed 🔸 bar, width-matched to the █ bars
  # 🔸 renders 2 cells wide, so d diamonds + (10 − 2d) ░ keeps the 10-cell rail.
  local filled=$(( ($1 * 10 + 50) / 100 ))
  (( filled > 10 )) && filled=10
  (( filled < 0 )) && filled=0
  local d=$(( (filled + 1) / 2 ))
  BAR="${_BORD}▐${R}${_D10:0:d}${DIM}${_E10:0:10-2*d}${_BORD}▌${R}"
}

gradient() { # text [palette] → sets GRAD: per-account color sweep
  # Static spatial gradient across the label. A 60s `refreshInterval` (settings.json)
  # re-runs the command on a timer so time-based segments (CTX / 5H / 7D, git
  # state) stay current while the session is idle — each re-render reads a fresh
  # EPOCHREALTIME and drifts the gradient a frame (60s cadence, not a smooth
  # animation clock). Palette ($2)
  # selects the account's color family: gold (Max/Com), violet (Max/Net), blue
  # (Enterprise), magenta (Team#0 fallback), plus a shade per agent account —
  # ice/cyan (A1), lime (A2), crimson→rose (A3), emerald→teal (A4),
  # amber/orange (A5), indigo (A6), rose-gold (K), and the four stark slots —
  # yellow (S1), green (S2), pink (S3), slate (S4). The label→slot map is in the
  # private roster (see the resolvers below). Pure bash fixed-point math, no
  # forks. GRAD holds
  # interpreted ESC bytes (printf -v %b) — embed directly, don't re-%b it.
  local text="$1" pal="${2:-gold}" RST=$'\033[0m'
  local -a PR PG PB
  case "$pal" in
    violet) PR=(203 180 224 150) PG=(140 110 120 90 ) PB=(247 250 255 240) ;;  # purple→magenta — Max/Net
    blue)   PR=(0   64  138 33 ) PG=(160 196 224 182) PB=(255 255 255 255) ;;  # strong light blue — Enterprise
    team0)  PR=(225 255 240 210) PG=(60  95  72  48 ) PB=(200 230 215 190) ;;  # magenta/fuchsia — Team#0 (.net fallback)
    agent1) PR=(56  103 125 80 ) PG=(189 232 240 210) PB=(248 249 255 250) ;; # ice/cyan→sky — A1
    agent2) PR=(190 214 163 235) PG=(242 255 230 250) PB=(100 133 80  120) ;; # lime→chartreuse — A2
    agent3) PR=(255 255 240 250) PG=(90  130 70  105) PB=(110 150 95  130) ;; # crimson→rose — A3
    agent4) PR=(52  45  34  110) PG=(211 212 211 231) PB=(153 191 238 183) ;; # emerald→teal→cyan — A4
    agent5) PR=(255 240 255 235) PG=(165 125 180 145) PB=(70  48  92  62 ) ;; # amber→orange→coral — A5
    agent6) PR=(150 120 100 175) PG=(130 100 80  140) PB=(252 240 220 248) ;; # indigo→blue-violet — A6
    agent7) PR=(232 255 246 214) PG=(20  70  36  96 ) PB=(180 214 150 205) ;; # magenta→hot-pink — A7
    agent8) PR=(64  112 150 92 ) PG=(224 242 255 232) PB=(208 216 205 212) ;; # turquoise→aqua — A8
    acctk) PR=(240 250 235 245) PG=(200 165 150 180) PB=(150 130 165 140) ;; # rose-gold — account slot K
    stark1) PR=(225 240 210 235) PG=(220 235 230 225) PB=(60  85  95  70 ) ;; # yellow — S1 (cyan is now A1)
    stark2) PR=(90  120 70  140) PG=(210 230 195 235) PB=(110 140 90  150) ;; # green — S2 (lime is now A2)
    stark3) PR=(255 250 255 250) PG=(130 160 120 150) PB=(180 200 175 195) ;; # pink/rose — S3 (crimson is now A3)
    stark4) PR=(140 165 120 155) PG=(160 180 145 175) PB=(190 205 175 200) ;; # slate/steel-blue — S4 (teal is now A4)
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

# ── Account label + palette resolvers ────────────────────────────────────
# GENERIC defaults: domain + org type only, no personal roster. The full
# per-account map (email local-parts → S1/A3/K labels + per-account hues) is
# PII and lives in the PRIVATE stark-workspace repo, sourced below to override
# these. Absent (CI, a fresh machine, a public clone), the statusline degrades
# to these generic labels. Both set caller-scope vars in place — no command
# substitution, to stay fork-free on the tick.
_stark_resolve_account_label() {   # $1=email $2=orgType → sets acct_label
  local dom=${1##*@} otype="$2"
  case "$dom" in
    *.com) [ "$otype" = "claude_max" ] && acct_label="Max/Com" || acct_label="Enterprise" ;;
    *.net) [ "$otype" = "claude_max" ] && acct_label="Max/Net" || acct_label="Team#0" ;;
    *)     acct_label="$dom" ;;
  esac
}
_stark_resolve_account_palette() { # $1=label → sets _pal (a gradient palette slot)
  case "$1" in
    Max/Net)    _pal=violet ;;
    Enterprise) _pal=blue ;;
    Max/*)      _pal=gold ;;
    Team*)      _pal=team0 ;;
    *)          _pal=gold ;;
  esac
}
# Private roster override (see stark-workspace config/statusline-accounts.sh).
source "$HOME/.claude/.statusline-accounts.sh" 2>/dev/null || true

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

# Extended-thinking toggle (chat:thinkingToggle / alt+t) — 🧠 lit when on,
# dimmed when explicitly off. Absent field (model has no thinking) → hidden.
if _on thinking && [ -n "$thinking" ]; then
  [ "$thinking" = "true" ] && seg "${MAUVE}\U0001f9e0${R}" || seg "${DIM}\U0001f9e0 off${R}"
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

# Logged-in account — distinguished by email + org type, mapped to a short
# label by the resolvers above (generic domain-only here, the personal roster
# when the private map is sourced).
# Resolve from ~/.claude.json oauthAccount {emailAddress, organizationType};
# the statusline
# stdin payload doesn't carry it. ~/.claude.json is big and changes rarely
# relative to the 60s tick, so the jq parse is mtime-cached ([ -nt ] is a
# builtin — zero forks on the hot path).
# Resolved unconditionally (not just when the account segment is shown):
# the 5H/7D gauges below key their fill style off acct_label (Enterprise → 🔸).
acct_label=""
{
  acct_email="" acct_otype="" acct_seat=""
  _ac="$HOME/.claude/.statusline-account-cache"
  if [ -f "$_ac" ] && ! [ "$HOME/.claude.json" -nt "$_ac" ]; then
    IFS=$'\t' read -r acct_email acct_otype acct_seat < "$_ac"
  fi
  # Re-parse on a miss OR on a cache left by an earlier keying scheme (2 fields,
  # or 3 with a bare org uuid): those files stay valid by mtime, so without this
  # the seat key would read empty or wrong until ~/.claude.json next changed —
  # silently suspending usage snapshots, or worse, writing them under a key that
  # merges two seats. The `:` is what distinguishes a seat key from a bare uuid.
  case "$acct_seat" in
    *:*) ;;                                  # already a seat key
    *)   acct_seat="" ;;
  esac
  if [ -z "$acct_seat" ]; then
    IFS=$'\t' read -r acct_email acct_otype acct_seat < <(
      jq -r '.oauthAccount | "\(.emailAddress // "")\t\(.organizationType // "")\t" + (if (.accountUuid // "") != "" and (.organizationUuid // "") != "" then "\(.accountUuid):\(.organizationUuid)" else "" end)' \
        "$HOME/.claude.json" 2>/dev/null)
    printf '%s\t%s\t%s\n' "$acct_email" "$acct_otype" "$acct_seat" > "$_ac" 2>/dev/null
  fi
  if [ -n "$acct_email" ]; then
    # Resolve email + org type → label. The generic resolver defined above knows
    # only domain + plan (Max/Com, Enterprise, Max/Net, Team#0); the private
    # roster sourced above overrides it with the per-account labels (S1/A3/K).
    _stark_resolve_account_label "$acct_email" "$acct_otype"
    if _on account && [ -n "$acct_label" ]; then
      # Palette family per label. Generic: Max/Net → violet, Enterprise → blue,
      # Max/* → gold, Team* → team0. The private roster override maps each
      # per-account label to its own hue slot (agent1..stark4 / acctk) below.
      _pal=gold
      _stark_resolve_account_palette "$acct_label"
      gradient "$acct_label" "$_pal"
      # Emoji stays static (glyphs ignore fg color); the label carries the gradient.
      seg2 "${MAUVE}\U0001f464${R} ${GRAD}"
    fi
  fi
}

# Context capacity gauge — how full is the window. Always visible: a payload
# without the field renders as 0% rather than hiding the gauge.
printf -v ctx '%.0f' "${used_pct:-0}"
tcolor "$ctx" 80 50; mkbar "$ctx" _CTX_FB
seg2 "${CTX_COL}CTX${R} ${BAR} ${TC}${ctx}%${R}"

# 5-hour rate-limit window: fixed-color "5H" label instead of a dynamic-
# colored emoji; countdown is a bare duration, no emoji/label of its own.
# Always visible (missing pct → 0%); Enterprise fills with 🔸 instead of
# the gradient.
printf -v _fpct '%.0f' "${five_pct:-0}"
tcolor "$_fpct" 80 50; fmt_remain "$five_reset" ""
if [ "$acct_label" = "Enterprise" ]; then mkbar_ent "$_fpct"; else mkbar "$_fpct" _5H_FB; fi
seg2 "${FIVEHR_COL}5H${R} ${BAR} ${TC}${_fpct}%${FR}${R}"
# 7-day rate-limit window: fixed-color "7D" label instead of the dynamic-
# colored 📅 emoji; countdown is a bare duration, matching 5H.
printf -v _wpct '%.0f' "${week_pct:-0}"
tcolor "$_wpct" 80 50; fmt_remain "$week_reset" ""
if [ "$acct_label" = "Enterprise" ]; then mkbar_ent "$_wpct"; else mkbar "$_wpct" _7D_FB; fi
seg2 "${DAY_COL}7D${R} ${BAR} ${TC}${_wpct}%${FR}${R}"

_on tier_warn && [ "$over_200k" = "true" ] && seg2 "${RED}⚠️ 1M-tier${R}"

# Persist this account's rate-limit windows for `idun cc limits`.
#
# These four fields arrive ONLY in the statusline stdin payload — they are not
# written to ~/.claude.json or anywhere else on disk, so a tool asking "how much
# headroom does my other account have?" has no source but this. Snapshotting
# here is free: the values are already parsed above, and the write is a bash
# redirect (no fork), matching the account/git caches alongside it.
#
# Keyed by SEAT — accountUuid:organizationUuid — because neither component is
# unique. One address can hold seats in several orgs (e.g. both a Team seat and
# a personal Max plan) and one org can hold many members (several distinct
# accounts in the same org). Team limits are
# per-member, so every (account, org) pair has its own budget. Keying by either
# component alone pointed two seats at one file, so each reported the other's
# usage. The `:` is replaced by `_` on disk (see idun's cc_lib.ts::sanitizeKey —
# the reader that must resolve the same filename).
#
# Guarded on the RAW $five_pct, not the rounded $_fpct: when the payload omits
# rate_limits entirely, $_fpct is 0, and persisting that would claim the account
# is completely free. Skipping the write leaves the previous (older but true)
# snapshot in place, which the reader ages honestly.
#
# `seat_key=` is written LAST so a torn read degrades to "unknown" rather than
# to a falsely-low percentage — see idun's cc_lib.ts::formatSnapshot (the
# cross-language snapshot wire-format contract this bash writer must match).
#
# GUARD — a snapshot is only attributable when the RENDERING process was
# launched under the currently-recorded identity.
#
# `~/.claude.json` is global but each `claude` process authenticates ONCE at
# startup and then reports ITS OWN account's rate_limits forever. So a process
# started before a /login keeps reporting the previous account's window while
# reading the new account's identity from the shared file — and files the wrong
# percentages under the wrong seat.
#
# This is not hypothetical or brief. Observed live on 2026-07-29 with ELEVEN
# concurrent claude processes spanning three days: one seat's snapshot thrashed
# 60% -> 46% -> 73% as different processes rendered, and ten per-pid records
# carried four distinct reset epochs under a single seat key. Both directions
# occur, and the understating one is the harmful one — it breaks the `floor`
# lower-bound promise and ranks an exhausted account first.
#
# The rule that holds: a process launched AFTER an identity became current is
# authenticated to it. So track when the current seat first appeared, and write
# only from processes that started later. A stale process simply stops
# contributing — its seat reads `unknown` (sorted last) until a process started
# under it renders, which is exactly the honest answer.
#
# This subsumes the /login settling window too: on a switch the marker's epoch
# becomes now, so every already-running process is excluded until restart.
_scf="$HOME/.claude/.statusline-seat-current"
_cur_seat="" _cur_since=""
[ -r "$_scf" ] && IFS=$'\t' read -r _cur_seat _cur_since < "$_scf"
if [ -n "$acct_seat" ] && [ "$_cur_seat" != "$acct_seat" ]; then
  _cur_seat="$acct_seat" _cur_since="$NOW"
  printf '%s\t%s\n' "$acct_seat" "$NOW" > "$_scf" 2>/dev/null
fi
if [ -n "$acct_seat" ] && [ -n "$five_pct" ]; then
  resolve_procstart
  if [ "$PROCSTART" -gt 0 ] 2>/dev/null &&
     [ "${_cur_since:-0}" -gt 0 ] 2>/dev/null &&
     [ "$PROCSTART" -ge "$_cur_since" ]; then
    printf 'five_pct=%s\nfive_reset=%s\nweek_pct=%s\nweek_reset=%s\nstamped_at=%s\nemail=%s\nseat_key=%s\n' \
      "$_fpct" "${five_reset:-0}" "$_wpct" "${week_reset:-0}" "$NOW" "$acct_email" "$acct_seat" \
      > "$HOME/.claude/.cc-usage-${acct_seat//:/_}" 2>/dev/null
  fi
fi

if _on code_churn; then
  churn=""
  [ -n "$s_added" ]  && [ "$s_added" -gt 0 ]  2>/dev/null && churn="${GRN}+${s_added}${R}"
  [ -n "$s_removed" ] && [ "$s_removed" -gt 0 ] 2>/dev/null && { [ -n "$churn" ] && churn="${churn} "; churn="${churn}${RED}-${s_removed}${R}"; }
  [ -n "$churn" ] && seg2 "${DIM}✏️${R} ${churn}"
fi

# ═════════════════════════════════════════════════════════════════════════
# Line 3: session clocks — now+age · started · 👤 since-enter · 🤖 since-reply
# (now leads; 👤 marks the human's Enter, 🤖 the agent's last reply.)
# ═════════════════════════════════════════════════════════════════════════
# "Started" = when the Claude Code PROCESS opened (survives /clear, unlike
# cost.total_duration_ms which resets per session), read from the parent
# process' start time (ps lstart → epoch). Cached per PPID so the ps+date
# forks run once per Claude Code run, not every render.
# "Now (age)" = current wall clock plus session age (NOW − process start),
# scaled by fmt_age (Xs / Xm / H:MM).
# "Enter" = the last prompt-submission epoch, stamped to
# ~/.claude/.statusline-prompt-<sid> by the UserPromptSubmit hook
# (config/statusline-prompt-hook.sh). That hook carries an idle-gap guard
# (STARK-662): machine re-prompts (/loop, cron) that fire within ~5s of a Stop
# do NOT re-stamp, so 👤 tracks the human's real enter, not each loop tick.
# No stamp yet (hook not fired this session) → the segment is hidden rather
# than faked from process start.
# The status segment resolves running-vs-idle from TWO hook stamps — the
# prompt stamp above and the Stop-hook stamp in
# ~/.claude/.statusline-stop-<sid> (config/statusline-stop-hook.sh): the agent
# is RUNNING while the prompt stamp is the newer of the two (prompt_ts ≥
# stop_ts), and IDLE once Stop fires and advances its stamp past the prompt.
# Both segments are RELATIVE durations ("N ago"), never a clock time:
#   • 👤 human = elapsed since Enter, ALWAYS shown — while running it is the live
#     turn duration, while idle it is "how long since I asked".
#   • 🤖 bot   = elapsed since the last reply, shown ONLY when idle. A running
#     turn has no completed reply of its own, and the human counter above is
#     already the live one, so the bot segment would just be stale noise.
# Both stamps come from hooks, not the payload, so a segment is hidden rather
# than faked when its hook has not fired this session.
l3=""
if _on session_times; then
  resolve_procstart; _procstart="$PROCSTART"

  # Now + session age — the leading segment.
  printf -v _nowc '%(%H:%M)T' "$NOW"
  if [ "$_procstart" -gt 0 ] 2>/dev/null; then
    fmt_age $(( NOW - _procstart ))
    seg3 "${SAP}\U0001f552 ${_nowc}${DIM} (${FA})${R}"  # now · session age
  else
    seg3 "${SAP}\U0001f552 ${_nowc}${R}"          # now (age unresolved)
  fi

  if [ "$_procstart" -gt 0 ] 2>/dev/null; then
    printf -v _startc '%(%H:%M)T' "$_procstart"
    seg3 "${DIM}\U0001f7e2 ${_startc}${R}"        # started (CC opened)
  fi

  # Enter + running/idle status — both from hook stamps (see block comment).
  # Coerce each stamp to a clean integer (0 when absent/garbage) so the -ge
  # comparison below is always numeric.
  _ppf="$HOME/.claude/.statusline-prompt-${sid:-default}"
  _spf="$HOME/.claude/.statusline-stop-${sid:-default}"
  _pt="" _st=""
  [ -r "$_ppf" ] && IFS= read -r _pt < "$_ppf"
  [ -r "$_spf" ] && IFS= read -r _st < "$_spf"
  [ "$_pt" -gt 0 ] 2>/dev/null || _pt=0
  [ "$_st" -gt 0 ] 2>/dev/null || _st=0
  _running=0
  [ "$_pt" -gt 0 ] && [ "$_pt" -ge "$_st" ] && _running=1

  # 👤 human — elapsed since Enter, always (running = live turn counter, idle =
  # since I asked). Relative only, no clock time.
  if [ "$_pt" -gt 0 ]; then
    fmt_dur $(( NOW - _pt ))
    seg3 "${PEACH}\U0001f464 ${FD}${DIM} ago${R}"  # 👤 since enter
  fi

  # 🤖 bot — elapsed since the last reply, only while idle.
  if [ "$_running" != 1 ] && [ "$_st" -gt 0 ]; then
    fmt_dur $(( NOW - _st ))
    seg3 "${GRN}\U0001f916 ${FD}${DIM} ago${R}"    # 🤖 since last reply (waiting)
  fi
fi

if [ -n "$l3" ]; then
  printf "%b\n" "${out}\n${l2}\n${l3}"
else
  printf "%b\n" "${out}\n${l2}"
fi
