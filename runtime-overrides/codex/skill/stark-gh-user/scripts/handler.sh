#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: handler.sh [show|primary|secondary|swap|limits] [--kind fine|classic|auto]
EOF
}

HANDLER_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

resolve_token_script() {
  local candidate
  local -a candidates=()
  [ -n "${STARK_ASSET_ROOT:-}" ] && candidates+=("$STARK_ASSET_ROOT/tools/user_token.ts")
  [ -n "${STARK_PLUGIN_ROOT:-}" ] && candidates+=("$STARK_PLUGIN_ROOT/tools/user_token.ts")
  candidates+=(
    "$HANDLER_DIR/../../../tools/user_token.ts"
    "$HOME/.agents/stark/stark-ops/tools/user_token.ts"
  )
  for candidate in "${candidates[@]}"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "Error: user_token.ts not found; set STARK_ASSET_ROOT to the installed bundle root" >&2
  return 1
}

SUBCOMMAND=show
SEEN_SUBCOMMAND=false
KIND=auto
KIND_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    show|primary|secondary|swap|limits)
      if [ "$SEEN_SUBCOMMAND" = true ]; then
        echo "Error: provide exactly one subcommand" >&2
        exit 2
      fi
      SUBCOMMAND=$1
      SEEN_SUBCOMMAND=true
      shift
      ;;
    --kind)
      [ "$#" -ge 2 ] || { echo "Error: --kind requires fine, classic, or auto" >&2; exit 2; }
      case "$2" in
        fine|classic|auto) KIND=$2; KIND_ARGS=(--kind "$2") ;;
        *) echo "Error: --kind must be fine, classic, or auto" >&2; exit 2 ;;
      esac
      shift 2
      ;;
    --kind=*)
      KIND=${1#--kind=}
      case "$KIND" in
        fine|classic|auto) KIND_ARGS=(--kind "$KIND") ;;
        *) echo "Error: --kind must be fine, classic, or auto" >&2; exit 2 ;;
      esac
      shift
      ;;
    --help|-h|help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

SCRIPT=$(resolve_token_script)
run_token() { node --no-warnings "$SCRIPT" "$@"; }
ACTIVE_USER=${STARK_GH_USER:-primary}
case "$ACTIVE_USER" in
  primary|secondary) ;;
  *) echo "Error: STARK_GH_USER must be primary or secondary" >&2; exit 2 ;;
esac

emit_exports() {
  local user=$1 kind=$2
  printf 'if GH_TOKEN="$(node --no-warnings %q --user %q --kind %q)"; then\n' \
    "$SCRIPT" "$user" "$kind"
  printf '  export GH_TOKEN\n'
  printf '  export GITHUB_TOKEN="$GH_TOKEN"\n'
  printf '  export STARK_GH_USER=%q\n' "$user"
  printf '  export STARK_GH_TOKEN_KIND=%q\n' "$kind"
  printf 'else\n'
  printf '  unset GH_TOKEN GITHUB_TOKEN\n'
  printf '  false\n'
  printf 'fi\n'
}

case "$SUBCOMMAND" in
  primary|secondary)
    run_token --user "$SUBCOMMAND" "${KIND_ARGS[@]}" >/dev/null
    emit_exports "$SUBCOMMAND" "$KIND"
    ;;
  swap)
    if [ "$ACTIVE_USER" = primary ]; then
      TARGET_USER=secondary
    else
      TARGET_USER=primary
    fi
    run_token --user "$TARGET_USER" "${KIND_ARGS[@]}" >/dev/null
    emit_exports "$TARGET_USER" "$KIND"
    printf '# swapped %s -> %s\n' "$ACTIVE_USER" "$TARGET_USER"
    ;;
  show)
    TOKEN=$(run_token --user "$ACTIVE_USER" "${KIND_ARGS[@]}" 2>/dev/null) || {
      echo "Error: no token for '$ACTIVE_USER'. Add stark-gh-token / $ACTIVE_USER-fine to Keychain." >&2
      exit 1
    }
    LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
    LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit) core, \(.graphql.remaining)/\(.graphql.limit) graphql"' 2>/dev/null) || LIMITS="(unable to fetch)"
    printf 'Active: %s (%s) — %s\n' "$ACTIVE_USER" "$LOGIN" "$LIMITS"
    ;;
  limits)
    echo "identity   core         graphql      login"
    for user in primary secondary; do
      TOKEN=$(run_token --user "$user" "${KIND_ARGS[@]}" 2>/dev/null) || {
        printf '%-10s %-12s %-12s %s\n' "$user" MISSING MISSING MISSING
        continue
      }
      LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit),\(.graphql.remaining)/\(.graphql.limit)"' 2>/dev/null) || {
        printf '%-10s %-12s %-12s %s\n' "$user" MISSING MISSING MISSING
        continue
      }
      CORE=${LIMITS%%,*}
      GRAPHQL=${LIMITS#*,}
      LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
      printf '%-10s %-12s %-12s %s\n' "$user" "$CORE" "$GRAPHQL" "$LOGIN"
    done
    ;;
esac
