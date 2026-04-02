# GitHub Projects Integration — stark-plan-to-tasks

After all issues are created (all 4 creation passes complete), optionally add them to a GitHub Project and set project fields.

## Config loading

At the start of this step, check for `.github/project-config.json` in the target repo root. If the file does not exist, skip this entire step — project integration is opt-in.

## Auth

Switch back to bot token. Project field mutations require the GitHub App token:

```bash
export GH_TOKEN=$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)
```

## Per-issue steps

For each created issue (from the run manifest), perform these steps. If any GraphQL call fails, log a warning and continue to the next issue — issue creation already succeeded, project integration is best-effort.

1. **Get issue node ID:**
   ```bash
   $PYTHON -c "import sys; sys.path.insert(0, '$SCRIPTS'); import github_projects, github_app; github_app.select_app('stark-claude'); print(github_projects.get_issue_node_id('$ORG', '$REPO', $ISSUE_NUM))"
   ```

2. **Add to project:**
   ```bash
   $PYTHON -c "import sys; sys.path.insert(0, '$SCRIPTS'); import github_projects, github_app; github_app.select_app('stark-claude'); github_projects.add_issue_to_project('$ITEM_NODE_ID')"
   ```

3. **Set project fields** via `github_projects.set_fields()`:

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
   $PYTHON -c "
   import sys; sys.path.insert(0, '$SCRIPTS')
   import github_projects, github_app
   github_app.select_app('stark-claude')
   github_projects.set_fields('$ITEM_ID', {
       'Status': '$STATUS',
       'Phase': '$PHASE_NAME',
       'Story Points': $SP,
       'Risk': '$RISK',
       'AI Suitability': '$AI_SUITABILITY',
       'Documentation State': 'Not Started',
       'Spec Approval': 'Not Required',
       'Release Approval': 'Not Required',
       'Priority': '$PRIORITY'
   })
   "
   ```

## Error handling

If a GraphQL call fails for a specific issue, log:
> Warning: Failed to add #{issue_number} to project: {error}. Skipping project integration for this issue.

Continue with the next issue. Do not halt the skill.

## Legacy labels

The `sp:*`, `risk:*`, `confidence:*` labels continue to be created alongside project fields. This is additive migration — labels remain until the project workflow is validated.
