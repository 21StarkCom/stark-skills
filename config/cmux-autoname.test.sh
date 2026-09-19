#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Not a hardcoded /private/tmp: CI runs this harness on ubuntu, where that
# directory does not exist. Nothing below compares an absolute path, so the
# macOS /var -> /private/var realpath difference cannot bite.
fixture="$(mktemp -d "${TMPDIR:-/tmp}/cmux-autoname.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

repo="$fixture/sample-repo"
state="$fixture/state"
mkdir -p "$repo" "$fixture/bin" "$fixture/home/.config/cmux"
git -C "$repo" init -q
git -C "$repo" config user.name Fixture
git -C "$repo" config user.email fixture@example.invalid
touch "$repo/README"
git -C "$repo" add README
git -C "$repo" commit -qm initial

printf '{"sample-repo":"Rose"}\n' > "$fixture/home/.config/cmux/repo-colors.json"
fake_cmux="$fixture/bin/cmux"
printf '%s\n' '#!/usr/bin/env bash' 'printf "%s\n" "$*" >> "$CMUX_CAPTURE"' > "$fake_cmux"
chmod +x "$fake_cmux"

CMUX_WORKSPACE_ID=ws-root CMUX_SURFACE_ID=surface-root \
  AGENT_PROJECT_DIR="$repo" CMUX_AUTONAME_CMUX_BIN="$fake_cmux" \
  CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
  bash "$script_dir/cmux-autoname.sh"

grep -Fqx 'rename-tab --surface surface-root ROOT' "$fixture/calls"
grep -Fqx 'workspace rename --workspace ws-root --title SAMPLE-REPO' "$fixture/calls"
grep -Fqx 'workspace-action --workspace ws-root --action set-color --color Rose' "$fixture/calls"

# A second lifecycle event in the same cmux workspace may refresh the tab but
# must not rename or recolor the workspace again.
CMUX_WORKSPACE_ID=ws-root CMUX_SURFACE_ID=surface-root \
  CODEX_PROJECT_DIR="$repo" CMUX_AUTONAME_CMUX_BIN="$fake_cmux" \
  CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
  bash "$script_dir/cmux-autoname.sh"
[[ "$(grep -Fxc 'workspace rename --workspace ws-root --title SAMPLE-REPO' "$fixture/calls")" == 1 ]]

git -C "$repo" branch fixture-worktree
git -C "$repo" worktree add -q "$fixture/feature-lane" fixture-worktree
CMUX_WORKSPACE_ID=ws-worktree CMUX_SURFACE_ID=surface-worktree \
  CLAUDE_PROJECT_DIR="$fixture/feature-lane" CMUX_CLAUDE_HOOK_CMUX_BIN="$fake_cmux" \
  CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
  bash "$script_dir/cmux-autoname.sh"
grep -Fqx 'rename-tab --surface surface-worktree FEATURE-LANE' "$fixture/calls"
grep -Fqx 'workspace rename --workspace ws-worktree --title SAMPLE-REPO' "$fixture/calls"

# A compact or clear re-fire happens inside a live session whose tab a skill may
# have retitled (MINION (n) etc.); it must leave the tab alone. startup and
# resume (a fresh process, possibly a fresh tab) still name it.
: > "$fixture/calls"
for src in compact clear; do
  printf '{"session_id":"s","source":"%s"}' "$src" | \
  CMUX_WORKSPACE_ID=ws-worktree CMUX_SURFACE_ID=surface-worktree \
    CLAUDE_PROJECT_DIR="$fixture/feature-lane" CMUX_AUTONAME_CMUX_BIN="$fake_cmux" \
    CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
    bash "$script_dir/cmux-autoname.sh"
done
# Not `! grep -q …`: a negated command never trips `set -e`, so that spelling
# could not fail on its own (measured) — only the exact count below caught a
# regression, and only incidentally.
if grep -q 'rename-tab' "$fixture/calls"; then
  printf 'FAIL: a compact/clear re-fire renamed the tab\n' >&2
  exit 1
fi
for src in startup resume; do
  printf '{"session_id":"s","source":"%s"}' "$src" | \
  CMUX_WORKSPACE_ID=ws-worktree CMUX_SURFACE_ID=surface-worktree \
    CLAUDE_PROJECT_DIR="$fixture/feature-lane" CMUX_AUTONAME_CMUX_BIN="$fake_cmux" \
    CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
    bash "$script_dir/cmux-autoname.sh"
done
[[ "$(grep -Fxc 'rename-tab --surface surface-worktree FEATURE-LANE' "$fixture/calls")" == 2 ]]
# No payload at all (Codex, a hand run) keeps the old behaviour.
CMUX_WORKSPACE_ID=ws-worktree CMUX_SURFACE_ID=surface-worktree \
  CLAUDE_PROJECT_DIR="$fixture/feature-lane" CMUX_AUTONAME_CMUX_BIN="$fake_cmux" \
  CMUX_CAPTURE="$fixture/calls" HOME="$fixture/home" XDG_STATE_HOME="$state" \
  bash "$script_dir/cmux-autoname.sh" </dev/null
[[ "$(grep -Fxc 'rename-tab --surface surface-worktree FEATURE-LANE' "$fixture/calls")" == 3 ]]

printf 'PASS cmux autoname: Codex precedence, Claude compatibility, title, color, idempotency, compact/clear keep the title\n'
