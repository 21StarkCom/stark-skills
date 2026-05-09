#!/bin/sh
# REST-only contract guard for the stark-review TS pipeline.
#
# Phase 4 verification was a developer-time grep; this script is the real
# enforcement that prevents silent GraphQL slip-in. CI runs it before tests.
#
# Scope is intentionally minimal — dispatcher and agent ports only, excluding
# their own *.test.ts companions.
set -e

cd "$(dirname "$0")"

# Collect candidate sources (skip .test.ts so test fixtures with example
# strings don't false-positive).
files=""
for f in stark_review*.ts agent_*.ts; do
  case "$f" in
    *.test.ts) continue ;;
  esac
  [ -f "$f" ] || continue
  files="$files $f"
done

if [ -z "$files" ]; then
  echo "check-rest-only: no source files found" >&2
  exit 1
fi

if grep -nE 'gh api graphql|/graphql' $files; then
  echo "REST-only violation: see hits above" >&2
  exit 1
fi
exit 0
