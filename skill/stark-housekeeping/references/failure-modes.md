# Failure Modes — stark-housekeeping

| Failure | Recovery |
|---------|----------|
| `gh` auth fails | Stop — housekeeping requires GitHub access |
| API rate limit | Wait 60s, retry once; if still limited, report partial results |
| Issue close fails (permissions) | Log warning, skip issue, continue |
| Branch delete fails (not merged) | Flag branch as unmerged, don't force-delete |
| Remote branch delete fails | Log warning, continue — branch may have protection rules |
| Worktree remove fails | Log warning, continue — may need manual cleanup |
| No open issues found | Skip Phase 1, report "No open issues" |
| Paginated API response truncated | Use `--paginate` flag; warn if > 1000 issues |
| Issue body is null/empty | Skip checklist parsing for that issue |
| `date -v` not available (Linux) | Fall back to `date -d "-30 days"` for aggressive mode |
| Not a git repo | Stop — housekeeping requires git context |
| Dirty working tree | Proceed — housekeeping doesn't modify code |
| `find` for symlinks fails (permissions) | Log warning, skip dangling symlink check |
| No git tags exist | Skip unreleased commits check |
| `.worktrees/` dir doesn't exist | Skip agent worktree check — normal for repos without autopilot |
| Label API pagination | Use `--paginate`; repos rarely exceed 100 labels |
