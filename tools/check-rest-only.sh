#!/bin/sh
# REST-only contract guard for the PR-posting path.
#
# Originally written for the stark-review dispatcher; that skill was buried
# (STARK-6098) but the contract outlived it — `review_post_lib.ts` and
# `findings_review_post.ts` are how findings reach a PR today, and the agent
# ports spawn subprocesses alongside them. This script is the real enforcement
# that prevents silent GraphQL slip-in; CI runs it before tests.
#
# Scope is intentionally minimal — the posting path and the agent ports only,
# excluding their own *.test.ts companions. `github_projects.ts` is GraphQL by
# design (Projects V2 has no REST surface) and is deliberately out of scope.
set -e

cd "$(dirname "$0")"

# Collect candidate sources (skip .test.ts so test fixtures with example
# strings don't false-positive).
files=""
for f in review_post_lib.ts findings_review_post.ts finding_lib.ts agent_*.ts; do
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
