# GitHub API Repo Rename Contract

Repository rename uses `PATCH /repos/{org}/{old-name}` with the `name` field via the gh CLI. Authentication is provided by a GitHub App token from `github_app.py --app stark-claude`.

## Invocation

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api -X PATCH "/repos/$ORG/$OLD_NAME" -f name="$NEW_NAME"
```

The `GH_TOKEN` assignment must be on the same line as the `gh` command for proper child process environment inheritance.

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Success | Verify returned `name` matches `$NEW_NAME` |
| 403 | No admin permission | Error with permission instructions |
| 404 | Repo not found | Error — check org/name |
| 422 | Name already taken | Error — choose a different name |
| 5xx | GitHub error | Error — retry manually |

## Idempotency

Before calling PATCH, check if the repo is already named correctly by comparing both repo ID and exact name field (including case). If ID matches and name matches exactly, skip the rename. If ID matches but name differs in case only, still issue the PATCH (case-only rename).

## Side Effects

GitHub creates a URL redirect from the old name to the new name. This redirect breaks if a new repository with the old name is later created.
