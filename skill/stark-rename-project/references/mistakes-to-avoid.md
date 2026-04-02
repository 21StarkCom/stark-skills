# Mistakes to Avoid

## Common Mistakes

| Mistake | Why it's wrong | Do this instead |
|---------|---------------|-----------------|
| Using `\b` word boundaries | Hyphens/dots are word boundaries in regex — matches inside `stark-review-improvement` | Use `(?<![A-Za-z0-9._-])..(?![A-Za-z0-9._-])` |
| Using sed for replacements | `sed` treats `.` as regex wildcard — `foo.bar` matches `fooXbar` | Use Perl `\Q...\E` for literal matching |
| Replacing skill paths in install.sh | `~/.claude/skills/stark-review/` is a skill identity, not a repo reference | Add explicit exclusion for installed skill paths |
| Unquoted file lists in git add | Paths with spaces/dashes can break shell or git | Use arrays: `git add -- "${files[@]}"` |
| Running `git commit -am` in sibling repos | Sweeps unrelated changes into the commit | `git add <specific-files> && git commit` |
| Modifying files before uninstalling symlinks | install.sh references change, uninstall can't find old targets | Uninstall first (Phase 3b), then modify (Phase 4) |
| Using `readlink -f` on macOS | Not available on macOS | Use `python3 -c "import os; print(os.path.realpath(...))"` |
| Replacing inside `.github/workflows/` | CI/CD files should be reported, not auto-modified | Skip workflows, report in summary |
| Hardcoding `GetEvinced` or `github.com` | Won't work for other orgs/hosts | Parse from `git remote get-url origin` |
| Forgetting to `cd` after `mv` | All subsequent commands operate from invalid cwd | `cd $PARENT/$NEW_NAME` immediately after mv |

## What This Skill Does NOT Do

- Rename skills or their invocation commands (e.g., `/stark-review` stays `/stark-review`)
- Update CI/CD pipelines or GitHub Actions (scans and reports them only)
- Handle repos outside the parent directory
- Rename GitHub Apps or their credentials
- Modify binary files or untracked files
- Update external webhooks, Slack integrations, or Jira links
