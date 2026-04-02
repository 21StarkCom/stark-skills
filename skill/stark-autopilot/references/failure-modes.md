# Failure Modes

| Failure | Recovery |
|---------|----------|
| No input | Ask: "What should I build?" |
| 0/3 agents succeed on a step | Abort step, report error, ask user how to proceed |
| 1/3 agents succeed | Use that agent's output, warn about no tournament |
| 2/3 agents succeed | Tournament between 2, warn about reduced competition |
| Diff fails to apply | Copy files from winner's worktree directly |
| Tests fail for all agents | Use semantic-only scoring, warn "no agent passed tests" |
| Worktree creation fails | Try without worktrees (sequential, same branch) |
| Agent timeout | Disqualify, continue with remaining agents |
| Mid-run abort (user Ctrl+C) | Clean up all worktrees before exiting |
| Winner fails import check | Disqualify, fall back to next-highest scorer |
| All winners fail import check | Fix the import error before continuing (likely a missing dep or circular import) |
| SDK method doesn't exist | Install SDK, run `inspect.signature()` to find correct API, fix before committing |
| End-of-run verification fails | Fix all failures before generating summary — do not ship broken code |
