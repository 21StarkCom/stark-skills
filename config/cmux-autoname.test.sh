#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixture="$(mktemp -d /private/tmp/cmux-autoname.XXXXXX)"
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

printf 'PASS cmux autoname: Codex precedence, Claude compatibility, title, color, idempotency\n'
