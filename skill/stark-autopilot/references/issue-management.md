# Issue Management

## Transition Issues to In Progress (step start)

For each issue number in the step's `issue_numbers`, add a comment and update status:

```bash
unset GH_TOKEN  # Use user's PAT for issue operations
for issue in ${step.issue_numbers}; do
  gh issue comment $issue --repo $REPO --body "Implementation started — autopilot step \`$step_id\` dispatching 3 agents."
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
    --comment "Implemented in commit $COMMIT_SHA (autopilot step \`$step_id\`, $winner won $score)."
done
```

If `.github/project-config.json` exists, also update the project board:
1. `export GH_TOKEN=$(node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude token)`
2. Find project item and update Status to "Done"
3. `unset GH_TOKEN`

Failure is non-fatal — log and continue. Issues can be closed manually if the API call fails.

## Summary Template

```
stark-autopilot — Complete
──────────────────────────
Steps:    5/5 completed
Duration: 45m 12s

Step Results:
  1. [title] — claude won (92/100)
  2. [title] — codex won (88/100)
  3. [title] — claude won (95/100)
  4. [title] — gemini won (91/100)
  5. [title] — claude won (89/100)

Agent Stats:
  claude:  3 wins, avg 92.0/100
  codex:   1 win,  avg 85.3/100
  gemini:  1 win,  avg 82.7/100

Files changed: 23 (+1,450 / -200)
Commits: 5
```
