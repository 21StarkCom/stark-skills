# Verification Checks

## Phase 7: Verify

Post-rename checks:

```bash
# Remote URL works
git ls-remote origin >/dev/null 2>&1 || echo "FAIL: git ls-remote origin failed"

# Symlinks resolve to new path
find ~/.claude -type l | while IFS= read -r link; do
    target=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$link")
    case "$target" in "$PARENT/$OLD_NAME"*) echo "STALE: $link → $target" ;; esac
done
```

Grep for remaining references using all 5 patterns across the renamed
project. Apply the same exclusion rules from Phase 4 so intentionally
preserved references (skill invocations, frontmatter names) don't show
as false positives. Report only unexpected residual matches.

Scan `.github/workflows/*.yml` in renamed project and sibling repos for
old-name references — report as "CI/CD files that may need manual update".

## Phase 8: Summary

Print:
- Every file changed, grouped by repo
- Verification results (pass/fail for each check)
- Residual old-name references that need manual review
- CI/CD workflow files with old-name references
- Sibling repos skipped due to dirty worktrees
- The `cd` command: `cd $PARENT/$NEW_NAME`
- Known integration points that may need manual update (webhooks, Slack, Jira)
- Note: GitHub redirects are in place but break if a repo with the old
  name is created later
