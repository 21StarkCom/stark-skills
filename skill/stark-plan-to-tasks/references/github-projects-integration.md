# GitHub Projects Integration — stark-plan-to-tasks

After all issues are created (all 4 creation passes complete), optionally add them to a GitHub Project and set project fields.

## Config loading

At the start of this step, check for `.github/project-config.json` in the target repo root. If the file does not exist, skip this entire step — project integration is opt-in.

```bash
CONFIG_JSON=$(node --experimental-strip-types "$TOOLS/github_projects.ts" load-config --repo-root "$REPO_ROOT")
[ "$CONFIG_JSON" = "null" ] && exit 0
PROJECT_ID=$(printf '%s' "$CONFIG_JSON" | jq -r '.project_id')
```

## Auth

Switch back to bot token. Project field mutations require the GitHub App token:

```bash
export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)
```

## Per-issue steps

For each created issue (from the run manifest), perform these steps. If any GraphQL call fails, log a warning and continue to the next issue — issue creation already succeeded, project integration is best-effort.

1. **Get issue node ID:**
   ```bash
   ISSUE_NODE_ID=$(node --experimental-strip-types "$TOOLS/github_projects.ts" \
       get-issue-node-id --org "$ORG" --repo "$REPO" --issue "$ISSUE_NUM" | jq -r '.node_id')
   ```

2. **Add to project (returns the item ID — capture for step 3):**
   ```bash
   ITEM_ID=$(node --experimental-strip-types "$TOOLS/github_projects.ts" \
       add-issue --project "$PROJECT_ID" --issue "$ISSUE_NODE_ID" | jq -r '.item_id')
   ```

3. **Set project fields** via the `set-fields` subcommand (single GraphQL mutation per field, 100ms throttle between mutations):

   | Field | Value | Source |
   |-------|-------|--------|
   | Status | `Backlog` or `Ready for Agent` | `Backlog` if the task has unresolved dependencies; `Ready for Agent` if all dependencies are satisfied (phase 1 tasks with no deps) |
   | Phase | Phase name (e.g., `Phase 1 — Data Model`) | From decomposition |
   | Story Points | Fibonacci value | From task `story_points` |
   | Risk | `Low`, `Medium`, `High` | From task `risk`, capitalized (`low` → `Low`, `med` → `Medium`, `high` → `High`) |
   | AI Suitability | `Autonomous`, `Assisted`, `Human-led` | From task `ai_suitability`, capitalized |
   | Documentation State | `Not Started` | Default for new tasks |
   | Spec Approval | `Not Required` | Spec already approved at this point |
   | Release Approval | `Not Required` | Default for new tasks |
   | Priority | Derived from risk | `High` risk → `High` priority, `Medium` risk → `Medium`, `Low` risk → `Low` |

   ```bash
   FIELDS_JSON=$(jq -nc \
     --arg status "$STATUS" \
     --arg phase "$PHASE_NAME" \
     --argjson sp "$SP" \
     --arg risk "$RISK" \
     --arg ai "$AI_SUITABILITY" \
     --arg priority "$PRIORITY" \
     '{
        Status: $status,
        Phase: $phase,
        "Story Points": $sp,
        Risk: $risk,
        "AI Suitability": $ai,
        "Documentation State": "Not Started",
        "Spec Approval": "Not Required",
        "Release Approval": "Not Required",
        Priority: $priority
      }')

   node --experimental-strip-types "$TOOLS/github_projects.ts" \
       set-fields --project "$PROJECT_ID" --item "$ITEM_ID" --fields "$FIELDS_JSON"
   ```

## Error handling

If a GraphQL call fails for a specific issue, log:
> Warning: Failed to add #{issue_number} to project: {error}. Skipping project integration for this issue.

Continue with the next issue. Do not halt the skill.

## Legacy labels

The `sp:*`, `risk:*`, `confidence:*` labels continue to be created alongside project fields. This is additive migration — labels remain until the project workflow is validated.
