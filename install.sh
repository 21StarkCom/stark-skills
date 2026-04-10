#!/usr/bin/env bash
set -euo pipefail

# stark-skills installer
# Symlinks repo contents to the locations where the review system expects them.
#
# Usage:
#   ./install.sh                     # install everything
#   ./install.sh --select            # interactive skill picker
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

SCRIPT="$0"
[ -L "$SCRIPT" ] && SCRIPT="$(readlink "$SCRIPT")"
REPO_DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CODE_REVIEW_DIR="$CLAUDE_DIR/code-review"
EVINCED_DIR="$HOME/git/Evinced"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

validate_json_config() {
    local config_path="$REPO_DIR/global/config.json"

    if ! python3 -c 'import json, sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$config_path" 2>/tmp/stark-install-config.err; then
        error "Config validation failed for $config_path"
        sed 's/^/  /' /tmp/stark-install-config.err >&2 || true
        rm -f /tmp/stark-install-config.err
        return 1
    fi

    rm -f /tmp/stark-install-config.err
    info "Config JSON: valid"
}

provision_infrastructure() {
    echo ""
    echo "Provisioning local infrastructure..."

    mkdir -p \
        "$HOME/.stark-insights" \
        "$CODE_REVIEW_DIR/history/autopilot" \
        "$CODE_REVIEW_DIR/history/design-reviews" \
        "$CODE_REVIEW_DIR/sessions" \
        "$CODE_REVIEW_DIR/staged" \
        "$CODE_REVIEW_DIR/dashboard" \
        "$REPO_DIR/tests/fixtures"

    info "Created local directories"

    python3 - <<'PY'
from pathlib import Path
import os
import sqlite3

queue_db = Path.home() / ".stark-insights" / "queue.db"
buffer_db = Path.home() / ".stark-insights" / "buffer.db"

schemas = {
    queue_db: """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS pending(
            id INTEGER PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL,
            retries INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS dead_letter(
            id INTEGER PRIMARY KEY,
            payload TEXT NOT NULL,
            failed_at TEXT NOT NULL,
            error TEXT
        );
        CREATE TABLE IF NOT EXISTS inflight(
            id INTEGER PRIMARY KEY,
            payload TEXT NOT NULL,
            locked_at TEXT NOT NULL,
            lock_id TEXT
        );
    """,
    buffer_db: """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS events(
            id INTEGER PRIMARY KEY,
            type TEXT NOT NULL,
            payload TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            session_id TEXT
        );
    """,
}

for db_path, schema in schemas.items():
    db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(db_path))
    try:
        connection.executescript(schema)
        connection.commit()
    finally:
        connection.close()
    os.chmod(db_path, 0o600)
PY

    info "Provisioned SQLite databases"
}

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

# ── TUI: Interactive Skill Selection ─────────────────────────

declare -a TUI_NAMES=()
declare -a TUI_DESCS=()
declare -a TUI_SELECTED=()
declare -a TUI_INSTALLED=()
TUI_CURSOR=0
TUI_SCROLL=0
TUI_COUNT=0

tui_get_desc() {
    awk '
        /^---$/ { c++; if (c == 2) exit; next }
        c == 1 && /^description:/ {
            sub(/^description:[[:space:]]*/, "")
            sub(/^>-?[[:space:]]*/, "")
            if ($0 != "") desc = $0
            reading = 1; next
        }
        c == 1 && reading && /^[[:space:]]/ {
            sub(/^[[:space:]]+/, "")
            if (desc) desc = desc " " $0; else desc = $0
            next
        }
        c == 1 && reading { reading = 0 }
        END { print desc }
    ' "$1"
}

tui_discover() {
    TUI_NAMES=(); TUI_DESCS=(); TUI_SELECTED=(); TUI_INSTALLED=()
    TUI_CURSOR=0; TUI_SCROLL=0

    for skill_dir in "$REPO_DIR"/skill/stark-*/; do
        [ -d "$skill_dir" ] || continue
        skill_dir="${skill_dir%/}"
        local name skill_file desc
        name=$(basename "$skill_dir")
        skill_file="$skill_dir/SKILL.md"
        [ -f "$skill_file" ] || continue

        TUI_NAMES+=("$name")
        desc=$(tui_get_desc "$skill_file")
        TUI_DESCS+=("$desc")

        if [ -L "$HOME/.claude/skills/$name/SKILL.md" ]; then
            TUI_INSTALLED+=(1)
            TUI_SELECTED+=(1)
        else
            TUI_INSTALLED+=(0)
            TUI_SELECTED+=(0)
        fi
    done
    TUI_COUNT=${#TUI_NAMES[@]}
}

tui_draw() {
    local rows cols visible
    rows=$(tput lines)
    cols=$(tput cols)
    visible=$((rows - 8))
    [ "$visible" -lt 5 ] && visible=5
    [ "$visible" -gt "$TUI_COUNT" ] && visible=$TUI_COUNT

    if [ "$TUI_CURSOR" -lt "$TUI_SCROLL" ]; then
        TUI_SCROLL=$TUI_CURSOR
    elif [ "$TUI_CURSOR" -ge $((TUI_SCROLL + visible)) ]; then
        TUI_SCROLL=$((TUI_CURSOR - visible + 1))
    fi

    local name_w=34
    local desc_w=$((cols - name_w - 10))
    [ "$desc_w" -lt 10 ] && desc_w=10

    tput cup 0 0
    tput ed

    echo -e "  ${BOLD}stark-skills${NC} — select skills to install"
    echo ""
    echo -e "  ${DIM}↑/k${NC} up  ${DIM}↓/j${NC} down  ${DIM}Space${NC} toggle  ${DIM}a${NC} all  ${DIM}n${NC} none  ${DIM}Enter${NC} apply  ${DIM}q${NC} quit"
    echo ""

    local end=$((TUI_SCROLL + visible))
    [ "$end" -gt "$TUI_COUNT" ] && end=$TUI_COUNT

    local i
    for ((i = TUI_SCROLL; i < end; i++)); do
        local arrow="  "
        [ "$i" -eq "$TUI_CURSOR" ] && arrow="▸ "

        local check color
        if [ "${TUI_SELECTED[$i]}" -eq 1 ]; then
            check="[✓]"
            if [ "${TUI_INSTALLED[$i]}" -eq 1 ]; then color="$GREEN"; else color="$CYAN"; fi
        else
            check="[ ]"
            if [ "${TUI_INSTALLED[$i]}" -eq 1 ]; then color="$YELLOW"; else color="$DIM"; fi
        fi

        local name="${TUI_NAMES[$i]}"
        local desc="${TUI_DESCS[$i]}"
        [ "${#desc}" -gt "$desc_w" ] && desc="${desc:0:$((desc_w - 3))}..."

        local padded
        printf -v padded "%-${name_w}s" "$name"

        echo -e "${arrow}${color}${check} ${padded}${NC} ${DIM}${desc}${NC}"
    done

    # Scroll indicators
    if [ "$TUI_SCROLL" -gt 0 ]; then
        tput cup 3 $((cols - 3)); echo -ne "${DIM}▲${NC}"
    fi
    if [ "$end" -lt "$TUI_COUNT" ]; then
        tput cup $((4 + visible)) $((cols - 3)); echo -ne "${DIM}▼${NC}"
    fi

    # Footer
    local sel=0 to_inst=0 to_rm=0
    for ((i = 0; i < TUI_COUNT; i++)); do
        [ "${TUI_SELECTED[$i]}" -eq 1 ] && sel=$((sel + 1))
        [ "${TUI_SELECTED[$i]}" -eq 1 ] && [ "${TUI_INSTALLED[$i]}" -eq 0 ] && to_inst=$((to_inst + 1))
        [ "${TUI_SELECTED[$i]}" -eq 0 ] && [ "${TUI_INSTALLED[$i]}" -eq 1 ] && to_rm=$((to_rm + 1))
    done

    echo ""
    local summary="${sel}/${TUI_COUNT} selected"
    [ "$to_inst" -gt 0 ] && summary="${summary} · ${to_inst} to install"
    [ "$to_rm" -gt 0 ] && summary="${summary} · ${to_rm} to uninstall"
    echo -e "  ${summary}"
    echo -e "  ${GREEN}■${NC}${DIM} installed ${NC} ${CYAN}■${NC}${DIM} will install ${NC} ${YELLOW}■${NC}${DIM} will uninstall${NC}"
}

tui_run() {
    tui_discover
    if [ "$TUI_COUNT" -eq 0 ]; then
        error "No skills found in $REPO_DIR/skill/"
        return 1
    fi

    if [ ! -t 0 ] || [ ! -t 1 ]; then
        error "Interactive mode requires a terminal"
        return 1
    fi

    tput smcup
    tput civis
    trap 'tput cnorm; tput rmcup; exit 0' INT TERM

    while true; do
        tui_draw

        IFS= read -rsn1 key
        case "$key" in
            $'\x1b')
                IFS= read -rsn2 -t 1 rest || true
                case "$rest" in
                    '[A') [ "$TUI_CURSOR" -gt 0 ] && TUI_CURSOR=$((TUI_CURSOR - 1)) ;;
                    '[B') [ "$TUI_CURSOR" -lt $((TUI_COUNT - 1)) ] && TUI_CURSOR=$((TUI_CURSOR + 1)) ;;
                esac
                ;;
            ' ')
                TUI_SELECTED[$TUI_CURSOR]=$(( 1 - ${TUI_SELECTED[$TUI_CURSOR]} ))
                [ "$TUI_CURSOR" -lt $((TUI_COUNT - 1)) ] && TUI_CURSOR=$((TUI_CURSOR + 1))
                ;;
            'k') [ "$TUI_CURSOR" -gt 0 ] && TUI_CURSOR=$((TUI_CURSOR - 1)) ;;
            'j') [ "$TUI_CURSOR" -lt $((TUI_COUNT - 1)) ] && TUI_CURSOR=$((TUI_CURSOR + 1)) ;;
            'a') for ((i = 0; i < TUI_COUNT; i++)); do TUI_SELECTED[$i]=1; done ;;
            'n') for ((i = 0; i < TUI_COUNT; i++)); do TUI_SELECTED[$i]=0; done ;;
            ''|$'\n')
                tput cnorm
                tput rmcup
                return 0
                ;;
            'q')
                tput cnorm
                tput rmcup
                echo "Cancelled."
                exit 0
                ;;
        esac
    done
}

tui_apply() {
    local installed=0 removed=0 unchanged=0 skipped=0

    echo ""
    echo "Applying skill selection..."
    echo ""

    for ((i = 0; i < TUI_COUNT; i++)); do
        local name="${TUI_NAMES[$i]}"
        local skill_file="$REPO_DIR/skill/$name/SKILL.md"

        if [ "${TUI_SELECTED[$i]}" -eq 1 ]; then
            if [ "${TUI_INSTALLED[$i]}" -eq 1 ]; then
                unchanged=$((unchanged + 1))
                continue
            fi
            # Validate before installing
            if ! grep -q "^disable-model-invocation: true" "$skill_file"; then
                error "Skill $name: missing 'disable-model-invocation: true' — skipped"
                skipped=$((skipped + 1))
                continue
            fi
            mkdir -p "$HOME/.claude/skills/$name"
            link_dir "$skill_file" "$HOME/.claude/skills/$name/SKILL.md" "Skill: $name"
            installed=$((installed + 1))
        else
            if [ "${TUI_INSTALLED[$i]}" -eq 1 ]; then
                unlink_dir "$HOME/.claude/skills/$name/SKILL.md" "Skill: $name"
                rmdir "$HOME/.claude/skills/$name" 2>/dev/null || true
                removed=$((removed + 1))
            fi
        fi
    done

    echo ""
    info "Skills: ${installed} installed, ${removed} removed, ${unchanged} unchanged"
    [ "$skipped" -gt 0 ] && warn "${skipped} skill(s) skipped (validation failed)"
}

interactive() {
    echo ""
    echo "Installing stark-skills from $REPO_DIR (interactive)"
    echo ""

    validate_json_config

    # Core infrastructure (always installed)
    link_dir "$REPO_DIR/global/config.json" "$CODE_REVIEW_DIR/config.json" "Global config"
    link_dir "$REPO_DIR/global/orchestrator.md" "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    link_dir "$REPO_DIR/global/prompts" "$CODE_REVIEW_DIR/prompts" "Prompts"
    link_dir "$REPO_DIR/scripts" "$CODE_REVIEW_DIR/scripts" "Scripts"

    for script in multi_review.py github_app.py github_projects.py setup_project.py stark_graph.py; do
        if [ -f "$REPO_DIR/scripts/$script" ]; then
            info "  Script: $script"
        else
            warn "  Script: $script not found"
        fi
    done

    mkdir -p "$CODE_REVIEW_DIR/history"
    info "History dir: $CODE_REVIEW_DIR/history/"

    if [ -d "$EVINCED_DIR" ]; then
        link_dir "$REPO_DIR/org/evinced" "$EVINCED_DIR/.code-review" "Evinced org config"
    else
        warn "Evinced dir not found at $EVINCED_DIR — skipping org config"
    fi

    # Interactive skill selection
    tui_run
    tui_apply

    # Orphan cleanup
    for link in "$HOME"/.claude/skills/stark-*/SKILL.md; do
        [ -L "$link" ] && [ ! -e "$link" ] && rm "$link" && rmdir "$(dirname "$link")" 2>/dev/null || true
    done

    # Standards & config (always installed)
    link_dir "$REPO_DIR/standards" "$CODE_REVIEW_DIR/standards" "Standards templates"
    link_dir "$REPO_DIR/config/settings.json" "$CLAUDE_DIR/settings.json" "Settings"
    link_dir "$REPO_DIR/config/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh" "Status line"

    provision_infrastructure

    echo ""
    info "Installation complete. Verify with: ./install.sh --status"
    echo ""
}

install() {
    echo ""
    echo "Installing stark-skills from $REPO_DIR"
    echo ""

    validate_json_config

    # 1. Global: ~/.claude/code-review/ → repo/global/
    #    But we need scripts/ at the same level, so we link them separately
    link_dir "$REPO_DIR/global/config.json" "$CODE_REVIEW_DIR/config.json" "Global config"
    link_dir "$REPO_DIR/global/orchestrator.md" "$CODE_REVIEW_DIR/orchestrator.md" "Orchestrator"
    link_dir "$REPO_DIR/global/prompts" "$CODE_REVIEW_DIR/prompts" "Prompts"
    link_dir "$REPO_DIR/scripts" "$CODE_REVIEW_DIR/scripts" "Scripts"

    # Verify key scripts are present in the scripts dir
    for script in multi_review.py github_app.py github_projects.py setup_project.py stark_graph.py; do
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

    # 4. Validate skills (blocking — must pass before symlinking)
    echo ""
    echo "Validating skills..."
    local skill_errors=0

    for skill_dir in "$REPO_DIR"/skill/stark-*/; do
        [ -d "$skill_dir" ] || continue
        local skill_file="$skill_dir/SKILL.md"
        [ -f "$skill_file" ] || continue
        local sname
        sname=$(basename "$skill_dir")

        # Check A: disable-model-invocation: true is required
        if ! grep -q "^disable-model-invocation: true" "$skill_file"; then
            error "Skill $sname: missing 'disable-model-invocation: true' in frontmatter"
            skill_errors=$((skill_errors + 1))
        fi

        # Check B: description ≤200 chars
        local desc_len
        desc_len=$(awk '/^---$/{c++; next} c==1 && /description:/{found=1} found && /^[a-z]/ && !/description:/{found=0} found{s=s $0}' "$skill_file" | sed 's/description:[[:space:]]*//' | sed 's/^>-\?//' | tr -d '\n' | sed 's/^[[:space:]]*//' | wc -c | tr -d ' ')
        if [ "$desc_len" -gt 200 ]; then
            error "Skill $sname: description is ${desc_len} chars (max 200)"
            skill_errors=$((skill_errors + 1))
        fi
    done

    if [ "$skill_errors" -gt 0 ]; then
        echo ""
        error "$skill_errors skill validation error(s). Fix before installing."
        echo "  - disable-model-invocation: Add to frontmatter (all stark-skills are invoked via /slash-command)"
        echo "  - description >200 chars: Front-load trigger keywords, move details to SKILL.md body"
        return 1
    fi
    info "All skills passed validation"

    # 5. Skills: ~/.claude/skills/{name}/SKILL.md → repo/skill/{name}/SKILL.md
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

    # Post-install: body size warnings (non-blocking)
    local body_warnings=0
    for skill_dir in "$REPO_DIR"/skill/stark-*/; do
        [ -d "$skill_dir" ] || continue
        local skill_file="$skill_dir/SKILL.md"
        [ -f "$skill_file" ] || continue
        local sname
        sname=$(basename "$skill_dir")
        local body_lines
        body_lines=$(awk 'BEGIN{c=0} /^---$/{c++; if(c==2){f=1; next}} f{print}' "$skill_file" | wc -l | tr -d ' ')
        if [ "$body_lines" -gt 500 ]; then
            warn "Skill $sname: body is ${body_lines} lines (consider extracting to references/)"
            body_warnings=$((body_warnings + 1))
        fi
    done
    if [ "$body_warnings" -gt 0 ]; then
        warn "$body_warnings skill(s) with body >500 lines"
    fi

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

    # 6. Standards: ~/.claude/code-review/standards/ → repo/standards/
    link_dir "$REPO_DIR/standards" "$CODE_REVIEW_DIR/standards" "Standards templates"

    # 7. User config: ~/.claude/settings.json + statusline → repo/config/
    link_dir "$REPO_DIR/config/settings.json" "$CLAUDE_DIR/settings.json" "Settings"
    link_dir "$REPO_DIR/config/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh" "Status line"

    provision_infrastructure

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
    for script in multi_review.py github_app.py github_projects.py setup_project.py stark_graph.py; do
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
    --select)    interactive ;;
    *)           install ;;
esac
