#!/usr/bin/env bash
# Regression test for statusline-command.sh's pure-bash payload parser.
#
# parse_payload (in statusline-command.sh) replaced a jq call; this asserts it
# stays byte-identical to that jq across a payload matrix — extra/missing/
# reordered fields, nested duplicate keys (used_percentage ×3), string values
# with spaces, the cwd fallback, and the thinking special-case. Run in CI by
# tools/statusline_parse.test.ts; runnable directly for local iteration.
#
# It extracts parse_payload straight from the shipped script (no copy to drift)
# and diffs its vars against the exact jq filter the script used to run.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/statusline-command.sh"
command -v jq >/dev/null || { echo "SKIP: jq not installed"; exit 0; }

# Pull parse_payload() { ... } out of the shipped script and load it.
eval "$(sed -n '/^parse_payload() {/,/^}/p' "$SCRIPT")"
type parse_payload >/dev/null 2>&1 || { echo "FAIL: could not extract parse_payload from $SCRIPT"; exit 1; }

VARS=(cwd model model_id used_pct ctx_size vim_mode session_name effort thinking
      agent_name out_style week_pct week_reset five_pct five_reset over_200k sid
      api_dur_ms s_added s_removed pr_number pr_state cache_warm cache_hit)

jq_parse() { # the EXACT filter statusline-command.sh used before the bash rewrite
  jq -r '{
    cwd:(.workspace.current_dir // .cwd // ""), model:(.model.display_name // ""),
    model_id:(.model.id // ""), used_pct:(.context_window.used_percentage // ""),
    ctx_size:(.context_window.context_window_size // ""), vim_mode:(.vim.mode // ""),
    session_name:(.session_name // ""), effort:(.effort.level // ""),
    thinking:(if ((.thinking // {})|has("enabled")) then (.thinking.enabled|tostring) else "" end),
    agent_name:(.agent.name // ""), out_style:(.output_style.name // ""),
    week_pct:(.rate_limits.seven_day.used_percentage // ""),
    week_reset:(.rate_limits.seven_day.resets_at // ""),
    five_pct:(.rate_limits.five_hour.used_percentage // ""),
    five_reset:(.rate_limits.five_hour.resets_at // ""),
    over_200k:(.exceeds_200k_tokens // false), sid:(.session_id // ""),
    api_dur_ms:(.cost.total_api_duration_ms // ""),
    s_added:(.cost.total_lines_added // ""), s_removed:(.cost.total_lines_removed // ""),
    pr_number:(.pr.number // ""), pr_state:(.pr.review_state // ""),
    cache_warm:(if ((.prompt_cache // {})|has("warm")) then (.prompt_cache.warm|tostring) else "" end),
    cache_hit:(.prompt_cache.hit_ratio // "")
  } | to_entries[] | "\(.key)=\(.value|tostring)"' <<<"$1"
}

FAIL=0
check() {
  local name="$1" p="$2" fails=0 v
  declare -A JQ
  while IFS='=' read -r k val; do JQ[$k]="$val"; done < <(jq_parse "$p")
  parse_payload "$p"
  for v in "${VARS[@]}"; do
    if [ "${!v}" != "${JQ[$v]}" ]; then
      printf '  MISMATCH [%s] %-14s bash=%q jq=%q\n' "$name" "$v" "${!v}" "${JQ[$v]}"
      fails=$((fails+1))
    fi
  done
  [ "$fails" -eq 0 ] && echo "  ok   $name" || { echo "  FAIL $name ($fails)"; FAIL=1; }
}

check full         '{"session_id":"benchsid","cwd":"/x","workspace":{"current_dir":"/Users/aryeh/Code/21Stark/stark-skills"},"model":{"display_name":"Opus 4.8 (1M context)","id":"claude-opus-4-8[1m]"},"context_window":{"used_percentage":42.5,"context_window_size":1000000,"total_input_tokens":123456,"total_output_tokens":23456,"current_usage":{"input_tokens":1200,"output_tokens":800,"cache_creation_input_tokens":300,"cache_read_input_tokens":95000}},"effort":{"level":"high"},"rate_limits":{"seven_day":{"used_percentage":33,"resets_at":1786900000},"five_hour":{"used_percentage":51,"resets_at":1786895000}},"cost":{"total_api_duration_ms":45678,"total_lines_added":120,"total_lines_removed":40},"exceeds_200k_tokens":false}'
check minimal      '{"session_id":"s","workspace":{"current_dir":"/repo"},"model":{"display_name":"Sonnet","id":"claude-sonnet-5"}}'
check no-ratelimit '{"cwd":"/only-cwd","model":{"display_name":"Haiku","id":"h"},"context_window":{"used_percentage":12,"current_usage":{"input_tokens":5,"output_tokens":6,"cache_creation_input_tokens":7,"cache_read_input_tokens":8}}}'
check reordered    '{"rate_limits":{"seven_day":{"used_percentage":33,"resets_at":111},"five_hour":{"used_percentage":51,"resets_at":222}},"context_window":{"current_usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":3,"cache_read_input_tokens":4},"used_percentage":88,"context_window_size":200000},"model":{"id":"m","display_name":"M"}}'
check extras       '{"model":{"display_name":"Opus","id":"o"},"thinking":{"enabled":true},"agent":{"name":"Explore"},"output_style":{"name":"Blunt"},"vim":{"mode":"NORMAL"},"session_name":"my sess","exceeds_200k_tokens":true,"context_window":{"used_percentage":5}}'
check thinking-off  '{"model":{"display_name":"O","id":"o"},"thinking":{"enabled":false}}'
check thinking-none '{"model":{"display_name":"O","id":"o"},"thinking":{}}'
check spaces        '{"workspace":{"current_dir":"/Users/aryeh/My Code/stark skills"},"model":{"display_name":"Opus 4.8 (1M context)","id":"o"},"session_name":"feat: thing"}'
check cwd-fallback  '{"cwd":"/fallback/dir","model":{"display_name":"X","id":"x"}}'
check empty         '{}'
check pr-cache-warm '{"model":{"display_name":"X","id":"x"},"pr":{"number":944,"url":"https://x/pull/944","review_state":"pending"},"prompt_cache":{"warm":true,"hit_ratio":0.97,"requests":43,"miss_causes":{}}}'
check pr-cache-cold '{"model":{"display_name":"X","id":"x"},"pr":{"number":12,"review_state":"approved"},"prompt_cache":{"warm":false,"hit_ratio":0.5,"miss_causes":{}}}'

[ "$FAIL" -eq 0 ] && echo "ALL PASS" || echo "FAILURES"
exit "$FAIL"
