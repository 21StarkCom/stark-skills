# Failure Modes — stark-phase-execute

| Failure | Recovery |
|---------|----------|
| Not on main at start | `git checkout main && git pull` |
| Dirty working tree | Stash automatically, log warning |
| Task implementation produces no changes | Log as skipped, continue |
| PR creation fails | Retry once after push; if still fails, log and continue |
| multi_review.py dispatch fails | Log agent failures, proceed with available findings |
| Worktree already exists (crashed session) | Reuse existing: `cd /tmp/review-*` |
| Merge conflict | Rebase on main, resolve, re-push, retry merge |
| Merge fails (checks, permissions) | Force with `--admin`; if still fails, log and continue |
| Test suite fails | Log failures, continue to next phase |
| Release fails (no CHANGELOG, tag exists) | Log and skip deploy |
| GitHub API rate limit | Wait 60s, retry once; if still limited, log and continue |
| Subagent timeout | Log timeout, skip task, continue |
| Stale remote branch from failed task | Clean up in error handler (1.8) |
