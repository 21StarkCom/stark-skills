#!/usr/bin/env bash
#
# cmux-autoname.sh — auto-name the cmux workspace + tab for an agent session.
#
# Generic: no personal data lives here. Wired from Claude and Codex SessionStart
# hooks. No-op outside cmux and outside a git repo, so it is safe to run from
# every agent session.
#
#   Workspace (first session only): named after the REPO, colored from the map.
#   Tab (every session):            worktree folder name, UPPERCASE, ROOT for main.
#
# Color map: $CMUX_REPO_COLORS (default ~/.config/cmux/repo-colors.json), a
# private per-user file of { "<repo-lowercase>": "<ColorName-or-#hex>" }.
# Unmapped repos get a deterministic hashed named color. cmux accepts a named
# color (Red Crimson Orange Amber Olive Green Teal Aqua Blue Navy Indigo Purple
# Magenta Rose Brown Charcoal) or #RRGGBB.
set -euo pipefail

# --- act only inside a cmux surface ---
[ -n "${CMUX_WORKSPACE_ID:-}" ] || exit 0
cmux_bin="${CMUX_AUTONAME_CMUX_BIN:-${CMUX_CLAUDE_HOOK_CMUX_BIN:-cmux}}"
command -v "$cmux_bin" >/dev/null 2>&1 || exit 0

proj="${AGENT_PROJECT_DIR:-${CODEX_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}}}"

# --- must be a git repo ---
root="$(git -C "$proj" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -n "$root" ] || exit 0

upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# --- tab (every session): worktree folder name, ROOT for the main worktree ---
gitdir="$(git -C "$proj" rev-parse --git-dir 2>/dev/null || true)"
case "$gitdir" in
  */worktrees/*) tab="$(basename "$root")" ;;
  *)             tab="ROOT" ;;
esac
"$cmux_bin" rename-tab --surface "${CMUX_SURFACE_ID:-}" "$(upper "$tab")" >/dev/null 2>&1 || true

# --- workspace (first session only): name after the repo + color ---
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/cmux-autoname"
marker="$state_dir/${CMUX_WORKSPACE_ID}"
[ -e "$marker" ] && exit 0

# Repo name = the main worktree's folder, regardless of which worktree we're in.
common="$(git -C "$proj" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$common" ]; then
  repo="$(basename "$(dirname "$common")")"
else
  repo="$(basename "$root")"
fi

color=""
if command -v python3 >/dev/null 2>&1; then
  color="$(python3 - "$repo" <<'PY' || true
import sys, json, hashlib, os
repo = sys.argv[1].lower()
palette = ["Red","Crimson","Orange","Amber","Olive","Green","Teal","Aqua",
           "Blue","Navy","Indigo","Purple","Magenta","Rose","Brown","Charcoal"]
cfg = os.environ.get("CMUX_REPO_COLORS") or os.path.expanduser("~/.config/cmux/repo-colors.json")
m = {}
try:
    with open(os.path.expanduser(cfg)) as f:
        m = {str(k).lower(): v for k, v in json.load(f).items()}
except Exception:
    pass
if repo in m:
    print(m[repo])
else:
    h = int(hashlib.sha256(repo.encode()).hexdigest(), 16)
    print(palette[h % len(palette)])
PY
)"
fi

"$cmux_bin" workspace rename --workspace "$CMUX_WORKSPACE_ID" --title "$(upper "$repo")" >/dev/null 2>&1 || true
[ -n "$color" ] && "$cmux_bin" workspace-action --workspace "$CMUX_WORKSPACE_ID" --action set-color --color "$color" >/dev/null 2>&1 || true

mkdir -p "$state_dir"
printf '%s\n' "$repo" > "$marker"
