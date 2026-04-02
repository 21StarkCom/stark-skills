#!/usr/bin/env bash
# Emit a skill_invocation event to the durable queue.
#
# Usage: skill-telemetry.sh <skill-name> <duration_s> <success> [key=value ...]
#
# Wraps stark-emit with the standard skill_invocation envelope.
# Skills call this instead of building bespoke stark-emit invocations.
#
# Examples:
#   skill-telemetry.sh stark-team-review 120 true pr_number=42 findings_total=7
#   skill-telemetry.sh stark-release 45 true version=1.2.0 bump_type=patch
#   skill-telemetry.sh stark-session 30 true args=start branch=main

set -euo pipefail

if [[ $# -lt 3 ]]; then
    echo "Usage: skill-telemetry.sh <skill-name> <duration_s> <success> [key=value ...]" >&2
    exit 1
fi

SKILL_NAME="$1"
DURATION_S="$2"
SUCCESS="$3"
shift 3

SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)"
STARK_EMIT="$(dirname "$SCRIPTS_DIR")/stark-emit"

exec python3 "$STARK_EMIT" skill_invocation \
    "skill=$SKILL_NAME" \
    "duration_s=$DURATION_S" \
    "success=$SUCCESS" \
    "$@"
