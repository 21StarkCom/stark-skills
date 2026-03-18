#!/usr/bin/env bash
set -euo pipefail

# stark-review installer
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
    echo "Installing stark-review from $REPO_DIR"
    echo ""

    # 1. Global: ~/.claude/code-review/ → repo/global/
    #    But we need scripts/ at the same level, so we link them separately
    link_dir "$REPO_DIR/global/config.json" "$CODE_REVIEW_DIR/config.json" "Global config"
    link_dir "$REPO_DIR/global/orchestrator.md" "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    link_dir "$REPO_DIR/global/prompts" "$CODE_REVIEW_DIR/prompts" "Prompts"
    link_dir "$REPO_DIR/scripts" "$CODE_REVIEW_DIR/scripts" "Scripts"

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
    mkdir -p "$HOME/.claude/skills/stark-review"
    if [ -f "$REPO_DIR/skill/SKILL.md" ]; then
        link_dir "$REPO_DIR/skill/SKILL.md" "$HOME/.claude/skills/stark-review/SKILL.md" "Skill: stark-review"
    else
        warn "Skill file not found at $REPO_DIR/skill/SKILL.md"
    fi

    mkdir -p "$HOME/.claude/skills/stark-review-improvement"
    if [ -f "$REPO_DIR/skill/stark-review-improvement/SKILL.md" ]; then
        link_dir "$REPO_DIR/skill/stark-review-improvement/SKILL.md" "$HOME/.claude/skills/stark-review-improvement/SKILL.md" "Skill: stark-review-improvement"
    else
        warn "Skill file not found at $REPO_DIR/skill/stark-review-improvement/SKILL.md"
    fi

    mkdir -p "$HOME/.claude/skills/stark-review-plan"
    if [ -f "$REPO_DIR/skill/stark-review-plan/SKILL.md" ]; then
        link_dir "$REPO_DIR/skill/stark-review-plan/SKILL.md" "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
    else
        warn "Skill file not found at $REPO_DIR/skill/stark-review-plan/SKILL.md"
    fi

    mkdir -p "$HOME/.claude/skills/init-docs"
    if [ -f "$REPO_DIR/skill/init-docs/SKILL.md" ]; then
        link_dir "$REPO_DIR/skill/init-docs/SKILL.md" "$HOME/.claude/skills/init-docs/SKILL.md" "Skill: init-docs"
    else
        warn "Skill file not found at $REPO_DIR/skill/init-docs/SKILL.md"
    fi

    # 5. Standards: ~/.claude/code-review/standards/ → repo/standards/
    link_dir "$REPO_DIR/standards" "$CODE_REVIEW_DIR/standards" "Standards templates"

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
    echo "Uninstalling stark-review symlinks"
    echo ""

    unlink_dir "$CODE_REVIEW_DIR/config.json" "Global config"
    unlink_dir "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    unlink_dir "$CODE_REVIEW_DIR/prompts" "Prompts"
    unlink_dir "$CODE_REVIEW_DIR/scripts" "Scripts"
    unlink_dir "$EVINCED_DIR/.code-review" "Evinced org config"
    unlink_dir "$HOME/.claude/skills/stark-review/SKILL.md" "Skill: stark-review"
    unlink_dir "$HOME/.claude/skills/stark-review-improvement/SKILL.md" "Skill: stark-review-improvement"
    unlink_dir "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
    unlink_dir "$HOME/.claude/skills/init-docs/SKILL.md" "Skill: init-docs"
    unlink_dir "$CODE_REVIEW_DIR/standards" "Standards templates"

    echo ""
    echo "Note: $CODE_REVIEW_DIR/history/ was not removed (contains local data)"
    echo ""
}

status() {
    echo ""
    echo "stark-review installation status"
    echo ""

    check_dir "$CODE_REVIEW_DIR/config.json" "Global config"
    check_dir "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    check_dir "$CODE_REVIEW_DIR/prompts" "Prompts"
    check_dir "$CODE_REVIEW_DIR/scripts" "Scripts"
    check_dir "$EVINCED_DIR/.code-review" "Evinced org config"
    check_dir "$HOME/.claude/skills/stark-review/SKILL.md" "Skill: stark-review"
    check_dir "$HOME/.claude/skills/stark-review-improvement/SKILL.md" "Skill: stark-review-improvement"
    check_dir "$HOME/.claude/skills/stark-review-plan/SKILL.md" "Skill: stark-review-plan"
    check_dir "$HOME/.claude/skills/init-docs/SKILL.md" "Skill: init-docs"
    check_dir "$CODE_REVIEW_DIR/standards" "Standards templates"

    echo ""
    if [ -d "$CODE_REVIEW_DIR/history" ]; then
        local count
        count=$(find "$CODE_REVIEW_DIR/history" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
        info "History: $count files in $CODE_REVIEW_DIR/history/"
    else
        warn "History dir not created yet"
    fi
    echo ""
}

case "${1:-}" in
    --uninstall) uninstall ;;
    --status)    status ;;
    *)           install ;;
esac
