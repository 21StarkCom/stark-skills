#!/usr/bin/env bash
set -euo pipefail

# stark-skills installer
# Symlinks repo contents to the locations where the review system expects them.
#
# Usage:
#   ./install.sh                     # install everything
#   ./install.sh --uninstall         # remove all symlinks
#   ./install.sh --status            # show what's installed
#
# What it does:
#   1. ~/.claude/code-review/         ← symlink to repo's global/
#   2. ~/.claude/code-review/scripts/ ← symlink to repo's scripts/
#   3. ~/git/Evinced/.code-review/    ← symlink to repo's org/evinced/
#
# Files stay in the repo — symlinks point to them. Updating the repo
# updates the installed system. No copying, no drift.

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CODE_REVIEW_DIR="$CLAUDE_DIR/code-review"
EVINCED_DIR="$HOME/git/Evinced"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

link_dir() {
    local src="$1"
    local dst="$2"
    local label="$3"

    if [ -L "$dst" ]; then
        local existing
        existing=$(readlink "$dst")
        if [ "$existing" = "$src" ]; then
            info "$label: already linked"
            return 0
        else
            warn "$label: symlink exists but points to $existing (expected $src)"
            echo "  Remove it manually if you want to re-link: rm $dst"
            return 1
        fi
    elif [ -d "$dst" ]; then
        warn "$label: directory exists (not a symlink). Back it up or remove it first."
        return 1
    else
        mkdir -p "$(dirname "$dst")"
        ln -s "$src" "$dst"
        info "$label: linked $dst → $src"
    fi
}

unlink_dir() {
    local dst="$1"
    local label="$2"

    if [ -L "$dst" ]; then
        rm "$dst"
        info "$label: unlinked"
    elif [ -d "$dst" ]; then
        warn "$label: is a directory, not a symlink — skipping"
    else
        info "$label: not installed"
    fi
}

check_dir() {
    local dst="$1"
    local label="$2"

    if [ -L "$dst" ]; then
        local target
        target=$(readlink "$dst")
        info "$label: → $target"
    elif [ -d "$dst" ]; then
        warn "$label: directory (not symlinked)"
    else
        error "$label: not installed"
    fi
}

install() {
    echo ""
    echo "Installing stark-skills from $REPO_DIR"
    echo ""

    # 1. Global: ~/.claude/code-review/ → repo/global/
    #    But we need scripts/ at the same level, so we link them separately
    link_dir "$REPO_DIR/global/config.json" "$CODE_REVIEW_DIR/config.json" "Global config"
    link_dir "$REPO_DIR/global/orchestrator.md" "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    link_dir "$REPO_DIR/global/prompts" "$CODE_REVIEW_DIR/prompts" "Prompts"
    link_dir "$REPO_DIR/scripts" "$CODE_REVIEW_DIR/scripts" "Scripts"

    # Verify key scripts are present in the scripts dir
    for script in multi_review.py github_app.py github_projects.py setup_project.py; do
        if [ -f "$REPO_DIR/scripts/$script" ]; then
            info "  Script: $script"
        else
            warn "  Script: $script not found in $REPO_DIR/scripts/"
        fi
    done

    # 2. Create history dir (not symlinked — local working data)
    mkdir -p "$CODE_REVIEW_DIR/history"
    info "History dir: $CODE_REVIEW_DIR/history/"

    # 3. Org: ~/git/Evinced/.code-review/ → repo/org/evinced/
    if [ -d "$EVINCED_DIR" ]; then
        link_dir "$REPO_DIR/org/evinced" "$EVINCED_DIR/.code-review" "Evinced org config"
    else
        warn "Evinced dir not found at $EVINCED_DIR — skipping org config"
    fi

    # 4. Skills: ~/.claude/skills/{name}/SKILL.md → repo/skill/{name}/SKILL.md
    #    Auto-discover all stark-* skill dirs under skill/
    for skill_dir in "$REPO_DIR"/skill/stark-*/; do
        [ -d "$skill_dir" ] || continue
        skill_dir="${skill_dir%/}"  # strip trailing slash
        local skill_name
        skill_name=$(basename "$skill_dir")
        local skill_file="$skill_dir/SKILL.md"

        if [ -f "$skill_file" ]; then
            mkdir -p "$HOME/.claude/skills/$skill_name"
            link_dir "$skill_file" "$HOME/.claude/skills/$skill_name/SKILL.md" "Skill: $skill_name"
        else
            warn "Skill dir $skill_name has no SKILL.md"
        fi
    done

    # Clean up orphaned skill symlinks (deleted skills)
    local SKILLS_DIR="$HOME/.claude/skills"
    for link in "$SKILLS_DIR"/stark-*/SKILL.md; do
        if [ -L "$link" ] && [ ! -e "$link" ]; then
            echo "  Removing orphaned symlink: $link"
            rm "$link"
            rmdir "$(dirname "$link")" 2>/dev/null || true
        fi
    done

    # Clean up old skill names (renamed to stark-* prefix)
    for old_name in init-docs update-deps rename-project onboard-project review-deployment-plan release claude-md-improver session-start; do
        local old_dir="$HOME/.claude/skills/$old_name"
        if [ -d "$old_dir" ]; then
            local old_file="$old_dir/SKILL.md"
            if [ -L "$old_file" ]; then
                rm "$old_file"
                rmdir "$old_dir" 2>/dev/null
                info "Cleaned up old skill: $old_name (was symlink)"
            elif [ -f "$old_file" ]; then
                rm "$old_file"
                rmdir "$old_dir" 2>/dev/null
                info "Cleaned up old skill: $old_name (was standalone)"
            fi
        fi
    done

    # 5. Standards: ~/.claude/code-review/standards/ → repo/standards/
    link_dir "$REPO_DIR/standards" "$CODE_REVIEW_DIR/standards" "Standards templates"

    # 6. User config: ~/.claude/settings.json + statusline → repo/config/
    link_dir "$REPO_DIR/config/settings.json" "$CLAUDE_DIR/settings.json" "Settings"
    link_dir "$REPO_DIR/config/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh" "Status line"

    echo ""
    info "Note: To enable staleness detection in a repo, copy or reference:"
    info "  $CODE_REVIEW_DIR/standards/workflows/doc-staleness.yml"
    info "  → .github/workflows/doc-staleness.yml in the target repo"

    echo ""
    echo "Installation complete. Verify with: ./install.sh --status"
    echo ""

    # Check dependencies
    echo "Checking dependencies..."
    for cmd in claude codex gemini gh python3; do
        if command -v "$cmd" &>/dev/null; then
            info "$cmd: $(command -v "$cmd")"
        else
            warn "$cmd: not found in PATH"
        fi
    done

    # Check keychain
    echo ""
    echo "Checking keychain entries..."
    for key in STARK_CLAUDE_PRIVATE_KEY STARK_CODEX_PRIVATE_KEY STARK_GEMINI_PRIVATE_KEY; do
        if security find-generic-password -s "$key" -w &>/dev/null; then
            info "$key: found"
        else
            error "$key: not found in keychain"
        fi
    done

    # Check Python deps
    echo ""
    echo "Checking Python dependencies..."
    local py="$REPO_DIR/scripts/.venv/bin/python3"
    if [ -x "$py" ]; then
        info "venv: $py"
        for pkg in jwt requests; do
            if "$py" -c "import $pkg" 2>/dev/null; then
                info "  $pkg: installed"
            else
                error "  $pkg: missing — run: $py -m pip install PyJWT requests"
            fi
        done
    else
        warn "No venv at scripts/.venv/ — run: python3 -m venv $REPO_DIR/scripts/.venv && $REPO_DIR/scripts/.venv/bin/pip install PyJWT requests"
    fi
}

uninstall() {
    echo ""
    echo "Uninstalling stark-skills symlinks"
    echo ""

    unlink_dir "$CODE_REVIEW_DIR/config.json" "Global config"
    unlink_dir "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    unlink_dir "$CODE_REVIEW_DIR/prompts" "Prompts"
    unlink_dir "$CODE_REVIEW_DIR/scripts" "Scripts"
    unlink_dir "$EVINCED_DIR/.code-review" "Evinced org config"

    # Unlink all stark-* skills
    for skill_dir in "$HOME"/.claude/skills/stark-*/; do
        [ -d "$skill_dir" ] || continue
        local skill_name
        skill_name=$(basename "$skill_dir")
        unlink_dir "$skill_dir/SKILL.md" "Skill: $skill_name"
        rmdir "$skill_dir" 2>/dev/null || true
    done

    unlink_dir "$CODE_REVIEW_DIR/standards" "Standards templates"
    unlink_dir "$CLAUDE_DIR/settings.json" "Settings"
    unlink_dir "$CLAUDE_DIR/statusline-command.sh" "Status line"

    echo ""
    echo "Note: $CODE_REVIEW_DIR/history/ was not removed (contains local data)"
    echo ""
}

status() {
    echo ""
    echo "stark-skills installation status"
    echo ""

    check_dir "$CODE_REVIEW_DIR/config.json" "Global config"
    check_dir "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    check_dir "$CODE_REVIEW_DIR/prompts" "Prompts"
    check_dir "$CODE_REVIEW_DIR/scripts" "Scripts"

    # Verify key scripts are accessible
    for script in multi_review.py github_app.py github_projects.py setup_project.py; do
        if [ -f "$CODE_REVIEW_DIR/scripts/$script" ]; then
            info "  Script: $script"
        else
            error "  Script: $script not found"
        fi
    done

    check_dir "$EVINCED_DIR/.code-review" "Evinced org config"

    # Check all stark-* skills
    for skill_dir in "$REPO_DIR"/skill/stark-*/; do
        [ -d "$skill_dir" ] || continue
        local skill_name
        skill_name=$(basename "$skill_dir")
        check_dir "$HOME/.claude/skills/$skill_name/SKILL.md" "Skill: $skill_name"
    done

    check_dir "$CODE_REVIEW_DIR/standards" "Standards templates"
    check_dir "$CLAUDE_DIR/settings.json" "Settings"
    check_dir "$CLAUDE_DIR/statusline-command.sh" "Status line"

    echo ""
    if [ -d "$CODE_REVIEW_DIR/history" ]; then
        local count
        count=$(find "$CODE_REVIEW_DIR/history" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
        info "History: $count files in $CODE_REVIEW_DIR/history/"
    else
        warn "History dir not created yet"
    fi

    # Automation fleet health
    echo ""
    echo "Automation fleet:"
    local auto_dir="$REPO_DIR/automation"
    if [ -d "$auto_dir" ]; then
        # Registry check
        if [ -f "$auto_dir/registry.json" ]; then
            local trigger_count
            trigger_count=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('triggers',{})))" "$auto_dir/registry.json" 2>/dev/null || echo "0")
            if [ "$trigger_count" -gt 0 ]; then
                info "Registry: $trigger_count triggers registered"
            else
                warn "Registry: exists but no triggers registered"
            fi
        else
            error "Registry: automation/registry.json not found"
        fi

        # Trigger log files (expect 12)
        local expected_triggers=(
            stark-evolution stark-self-review stark-sentinel
            stark-dependency-audit stark-infra-drift stark-api-compat
            stark-intelligence stark-claude-md-sync stark-digest
            stark-observability-check stark-automation-monitor stark-hooks-auditor
        )
        local found=0
        local missing=0
        for t in "${expected_triggers[@]}"; do
            if [ -f "$auto_dir/triggers/$t.md" ]; then
                found=$((found + 1))
            else
                missing=$((missing + 1))
            fi
        done
        if [ "$missing" -eq 0 ]; then
            info "Trigger logs: $found/12 present"
        else
            warn "Trigger logs: $found/12 present ($missing missing)"
        fi

        # CLI snapshots
        local snapshot_files=(claude-help.txt claude-version.txt codex-help.txt codex-version.txt gemini-help.txt gemini-version.txt)
        local snap_found=0
        for sf in "${snapshot_files[@]}"; do
            if [ -f "$auto_dir/cli-snapshots/$sf" ]; then
                snap_found=$((snap_found + 1))
            fi
        done
        if [ "$snap_found" -eq "${#snapshot_files[@]}" ]; then
            info "CLI snapshots: $snap_found/${#snapshot_files[@]} committed"
        else
            warn "CLI snapshots: $snap_found/${#snapshot_files[@]} committed"
        fi
    else
        info "Automation fleet: not installed"
    fi
    echo ""
}

case "${1:-}" in
    --uninstall) uninstall ;;
    --status)    status ;;
    *)           install ;;
esac
