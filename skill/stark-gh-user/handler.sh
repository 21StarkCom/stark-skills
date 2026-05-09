#!/bin/bash
set -euo pipefail

# Resolve script path: worktree-relative or global fallback
SCRIPT=""
if [[ -f "scripts/user_token.py" ]]; then
  SCRIPT="scripts/user_token.py"
elif [[ -f "$HOME/.claude/code-review/scripts/user_token.py" ]]; then
  SCRIPT="$HOME/.claude/code-review/scripts/user_token.py"
else
  echo "Error: user_token.py not found" >&2
  exit 1
fi

# Parse arguments: extract subcommand and --kind flag
SUBCOMMAND="show"
KIND=""
for arg in $ARGUMENTS; do
  if [[ "$arg" == "--kind" ]]; then
    continue
  elif [[ "$arg" == fine || "$arg" == classic || "$arg" == auto ]]; then
    KIND="--kind $arg"
  elif [[ "$arg" == show || "$arg" == primary || "$arg" == secondary || "$arg" == swap || "$arg" == limits ]]; then
    SUBCOMMAND="$arg"
  fi
done

# Execute subcommand
case "$SUBCOMMAND" in
  primary|secondary)
    python3 "$SCRIPT" --user "$SUBCOMMAND" $KIND
    ;;
  swap)
    python3 "$SCRIPT" --swap $KIND
    ;;
  show)
    ACTIVE_USER="${STARK_GH_USER:-primary}"
    TOKEN=$(python3 "$SCRIPT" --user "$ACTIVE_USER" 2>/dev/null) || {
      echo "Error: No token for '$ACTIVE_USER'. Add it to keychain: security add-generic-password -U -s stark-gh-token -a $ACTIVE_USER-fine -w '<token>'" >&2
      exit 1
    }
    LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
    LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit) core, \(.graphql.remaining)/\(.graphql.limit) graphql"' 2>/dev/null) || LIMITS="(unable to fetch)"
    echo "Active: $ACTIVE_USER ($LOGIN) — $LIMITS"
    ;;
  limits)
    echo "identity   core         graphql      login"
    for user in primary secondary; do
      TOKEN=$(python3 "$SCRIPT" --user "$user" 2>/dev/null) || {
        echo "$user      MISSING      MISSING      MISSING"
        continue
      }
      LIMITS=$(GH_TOKEN="$TOKEN" gh api rate_limit --jq '.resources | "\(.core.remaining)/\(.core.limit),\(.graphql.remaining)/\(.graphql.limit)"' 2>/dev/null) || {
        echo "$user      MISSING      MISSING      MISSING"
        continue
      }
      CORE=$(echo "$LIMITS" | cut -d, -f1)
      GRAPHQL=$(echo "$LIMITS" | cut -d, -f2)
      LOGIN=$(GH_TOKEN="$TOKEN" gh api user --jq .login 2>/dev/null) || LOGIN="(unknown)"
      printf "%-10s %-12s %-12s %s\n" "$user" "$CORE" "$GRAPHQL" "$LOGIN"
    done
    ;;
  *)
    echo "Error: unknown subcommand '$SUBCOMMAND'" >&2
    exit 1
    ;;
esac
