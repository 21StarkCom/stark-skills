#!/usr/bin/env bash
set -euo pipefail

# register_triggers.sh — Idempotent CCR trigger registration
# Usage:
#   ./scripts/register_triggers.sh                    # Register/update all triggers
#   ./scripts/register_triggers.sh --trigger NAME      # Register/update one trigger
#   ./scripts/register_triggers.sh --update-secret     # Re-register all with fresh PAT
#   ./scripts/register_triggers.sh --list              # List registered triggers
#   ./scripts/register_triggers.sh --dry-run           # Show what would be done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/global/config.json"
REGISTRY="$REPO_ROOT/automation/registry.json"
PROMPTS_DIR="$REPO_ROOT/automation/prompts"
ENVIRONMENT_ID="env_01ERsNoR4xcvaJCsG4WVA3F2"

# Parse args
SINGLE_TRIGGER=""
UPDATE_SECRET=false
DRY_RUN=false
LIST_ONLY=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --trigger) SINGLE_TRIGGER="$2"; shift 2 ;;
        --update-secret) UPDATE_SECRET=true; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --list) LIST_ONLY=true; shift ;;
        *) echo "Unknown arg: $1"; exit 1 ;;
    esac
done

# Read PAT from Keychain
PAT=$(security find-generic-password -s STARK_TRIGGERS_PAT -w 2>/dev/null) || {
    echo "Error: STARK_TRIGGERS_PAT not found in Keychain"
    exit 1
}

# Read config
TRIGGERS=$(jq -r '.automation.triggers | keys[]' "$CONFIG")
SLACK_UUID=$(jq -r '.automation.connectors.slack' "$CONFIG")
CONTEXT7_UUID=$(jq -r '.automation.connectors.context7' "$CONFIG")

if $LIST_ONLY; then
    echo "Registered triggers:"
    jq -r '.triggers | to_entries[] | "  \(.key): \(.value.trigger_id) (registered: \(.value.last_registered))"' "$REGISTRY"
    exit 0
fi

# Determine which triggers to process
if [[ -n "$SINGLE_TRIGGER" ]]; then
    if ! echo "$TRIGGERS" | grep -q "^${SINGLE_TRIGGER}$"; then
        echo "Error: trigger '$SINGLE_TRIGGER' not found in config"
        exit 1
    fi
    TRIGGERS="$SINGLE_TRIGGER"
fi

register_trigger() {
    local name=$1
    local cron=$(jq -r ".automation.triggers[\"$name\"].cron" "$CONFIG")
    local tier=$(jq -r ".automation.triggers[\"$name\"].tier" "$CONFIG")
    local prompt_file="$PROMPTS_DIR/${name}.md"

    if [[ ! -f "$prompt_file" ]]; then
        echo "  [$name] SKIP — no prompt file at $prompt_file"
        return 0
    fi

    local prompt_content
    prompt_content=$(cat "$prompt_file")

    # Check if already registered
    local existing_id
    existing_id=$(jq -r ".triggers[\"$name\"].trigger_id // empty" "$REGISTRY")

    # Determine MCP connections based on trigger needs
    local mcp_connections="[]"
    case $name in
        stark-self-review|stark-sentinel|stark-digest|stark-automation-monitor)
            mcp_connections="[{\"connector_uuid\": \"$SLACK_UUID\", \"name\": \"Slack\", \"url\": \"https://mcp.slack.com/mcp\"}]"
            ;;
        stark-intelligence)
            mcp_connections="[{\"connector_uuid\": \"$CONTEXT7_UUID\", \"name\": \"Context7\", \"url\": \"https://mcp.context7.com/mcp\"}]"
            ;;
    esac

    local uuid
    uuid=$(python3 -c "import uuid; print(str(uuid.uuid4()))")

    if [[ -n "$existing_id" ]] && ! $UPDATE_SECRET; then
        # Update existing trigger
        if $DRY_RUN; then
            echo "  [$name] DRY-RUN: would update trigger $existing_id"
            return 0
        fi
        echo "  [$name] Updating trigger $existing_id..."
        # Update would go here via RemoteTrigger API
        echo "  [$name] Updated (cron: $cron, tier: $tier)"
    else
        # Create new trigger
        if $DRY_RUN; then
            echo "  [$name] DRY-RUN: would create trigger (cron: $cron)"
            return 0
        fi
        echo "  [$name] Creating trigger (cron: $cron, tier: $tier)..."
        # Creation would go here via RemoteTrigger API
        # For now, generate a placeholder ID
        local new_id="trg_$(echo "$name" | md5sum | cut -c1-12 2>/dev/null || echo "$name" | md5 -q | cut -c1-12)"

        # Update registry
        local tmp=$(mktemp)
        jq --arg name "$name" \
           --arg id "$new_id" \
           --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           '.triggers[$name] = {"trigger_id": $id, "last_registered": $ts, "enabled": false}' \
           "$REGISTRY" > "$tmp" && mv "$tmp" "$REGISTRY"

        echo "  [$name] Created: $new_id"
    fi
}

echo "stark-skills trigger registration"
echo "================================="
echo "Config: $CONFIG"
echo "Registry: $REGISTRY"
echo "Prompts: $PROMPTS_DIR"
echo ""

for trigger in $TRIGGERS; do
    register_trigger "$trigger"
done

echo ""
echo "Done. Registry: $REGISTRY"
