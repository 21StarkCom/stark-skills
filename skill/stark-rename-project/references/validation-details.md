# Validation Details

## Phase 1d: Standard Validation

```bash
# Parse remote into components (not substring grep)
# SSH: git@github.com:GetEvinced/stark-skills.git → HOST=github.com ORG=GetEvinced REPO=stark-skills
# HTTPS: https://github.com/GetEvinced/stark-skills.git → same
# Confirm parsed REPO matches OLD_NAME
test "$REPO" = "$OLD_NAME" || error "Remote repo name '$REPO' doesn't match old-name '$OLD_NAME'"

# Confirm no uncommitted changes
test -z "$(git status --porcelain)" || error "Uncommitted changes — commit or stash first"

# Confirm new-name doesn't exist locally (skip for case-only renames)
if [ "$OLD_NAME" != "$NEW_NAME" ] || [ "$(echo "$OLD_NAME" | tr '[:upper:]' '[:lower:]')" != "$(echo "$NEW_NAME" | tr '[:upper:]' '[:lower:]')" ]; then
    test ! -d "$PARENT/$NEW_NAME" || error "Directory $PARENT/$NEW_NAME already exists"
fi

# Fetch and store current repo ID for collision/idempotency checks
CURRENT_REPO_ID=$(GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$OLD_NAME" --jq '.id')
```

For case-only renames (old and new differ only in case), skip the local
existence check — case-insensitive filesystems report the existing dir
as a match.

## Phase 1e: Parse Remote

Extract `HOST`, `ORG`, and repo name from the git remote URL:

```bash
REMOTE_URL=$(git remote get-url origin)
# SSH: git@github.com:GetEvinced/stark-skills.git
# HTTPS: https://github.com/GetEvinced/stark-skills.git
```

Parse HOST, ORG, OLD_NAME from the URL. All replacement patterns are
built from these parsed values — no hardcoded org/host literals.

## Phase 1f: Permission Pre-flight

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$OLD_NAME" --jq '.permissions.admin'
```

If the result is not `true`, error:
"GitHub App lacks admin permission on $ORG/$OLD_NAME. Grant Administration:write."

## Phase 1g: Check New-name Availability on GitHub

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api "/repos/$ORG/$NEW_NAME" 2>/dev/null
```

If the API returns a repo AND its `id` differs from `$CURRENT_REPO_ID`,
error: "A different repo named $ORG/$NEW_NAME already exists on GitHub."

## Phase 2a: Rename the Repository

```bash
GH_TOKEN="$($PYTHON $SCRIPTS/github_app.py --app stark-claude token)" \
  gh api -X PATCH "/repos/$ORG/$OLD_NAME" -f name="$NEW_NAME"
```

Verify the response: check that the returned `name` field matches `$NEW_NAME`.

Handle errors:
| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 200 | Success | Continue |
| 403 | No admin permission | Error with permission instructions |
| 404 | Repo not found | Error — check org/name |
| 422 | Name already taken | Error — choose a different name |
| 5xx | GitHub error | Error — retry manually |

GitHub creates a redirect from the old URL to the new URL. Note: this
redirect breaks if a repo with the old name is later created.

## Phase 2b: Update Git Remote URLs

```bash
# Read current URLs
FETCH_URL=$(git remote get-url origin)
PUSH_URL=$(git remote get-url --push origin 2>/dev/null || echo "$FETCH_URL")

# Replace only the repo-name component (not arbitrary substrings)
# Use Perl for literal replacement (sed treats . as regex wildcard)
NEW_FETCH=$(echo "$FETCH_URL" | perl -pe "s|\Q$OLD_NAME\E([.]git)?$|$NEW_NAME\$1|")
NEW_PUSH=$(echo "$PUSH_URL" | perl -pe "s|\Q$OLD_NAME\E([.]git)?$|$NEW_NAME\$1|")

git remote set-url origin "$NEW_FETCH"
if [ "$FETCH_URL" != "$PUSH_URL" ]; then
    git remote set-url --push origin "$NEW_PUSH"
fi

# Verify
git remote -v
```

Note: `\Q...\E` in Perl treats the old name as a literal string, not a
regex. This prevents `.` in repo names from matching arbitrary characters.

## Phase 3b: Uninstall Old Symlinks

Run this BEFORE modifying any files — Phase 4 would change install.sh,
making uninstall look for wrong targets.

```bash
if [ "$HAS_UNINSTALL" = "true" ]; then
    ./install.sh --uninstall
else
    # Fallback: find stale symlinks across ALL known install destinations
    OLD_ABS="$PARENT/$OLD_NAME"
    for search_dir in ~/.claude ~/git/Evinced/.code-review; do
        [ -d "$search_dir" ] || continue
        find "$search_dir" -type l | while IFS= read -r link; do
            target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$link")
            # Match exact old path or children, not substring
            if [ "$target" = "$OLD_ABS" ] || case "$target" in "$OLD_ABS/"*) true;; *) false;; esac; then
                rm "$link" && echo "Removed stale symlink: $link"
            fi
        done
    done
fi
```

Only remove symlinks whose resolved absolute targets are exactly the old
project path or rooted under it. Never delete non-symlink data.
