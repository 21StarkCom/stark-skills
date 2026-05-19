# Issue Management

## Transition Issues to In Progress (step start)

For each issue number in the step's `issue_numbers`, add a comment and update status:

```bash
unset GH_TOKEN  # Use user's PAT for issue operations
for issue in ${step.issue_numbers}; do
  gh issue comment $issue --repo $REPO --body "Implementation started — copilot step \`$step_id\` ($LEAD lead, $WING wing)."
done
```

If `.github/project-config.json` exists, also update the project board:
1. `export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)`
2. Find project item: `node --experimental-strip-types "$TOOLS/github_projects.ts" find-item --org "$ORG" --repo "$REPO" --issue "$ISSUE_NUM" --project "$PROJECT_ID"`
3. Update Status field to "Agent Working"
4. `unset GH_TOKEN`

Failure is non-fatal — log and continue.

## Transition Issues to Done (step end)

For each issue number in the step's `issue_numbers`, close with a reference to the commit:

```bash
unset GH_TOKEN  # Use user's PAT
COMMIT_SHA=$(git rev-parse --short HEAD)
for issue in ${step.issue_numbers}; do
  gh issue close $issue --repo $REPO \
    --comment "Implemented in commit $COMMIT_SHA (copilot step \`$step_id\`, $LEAD lead → $WING wing approved in $rounds_count round(s))."
done
```

If `.github/project-config.json` exists, also update the project board:
1. `export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)`
2. Find project item and update Status to "Done"
3. `unset GH_TOKEN`

Failure is non-fatal — log and continue. Issues can be closed manually if the API call fails.

## Summary Template

```
stark-copilot — Complete
────────────────────────
Steps:    5/5 completed
Duration: 45m 12s
Lead:     claude (implementer)
Wing:     codex  (reviewer)

Step Results:
  1. [title] — approved in 2 rounds
  2. [title] — approved in 1 round
  3. [title] — approved in 3 rounds
  4. [title] — approved in 1 round
  5. [title] — approved in 2 rounds

Aggregate:
  Avg rounds/step: 1.8
  Total rounds:    9
  Wing parse retries: 0

Files changed: 23 (+1,450 / -200)
Commits: 5
```
