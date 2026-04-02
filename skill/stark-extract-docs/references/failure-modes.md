# Failure Modes — stark-extract-docs

| Failure | Recovery |
|---------|----------|
| Spec doesn't exist or is empty | Error message, abort |
| Spec is not `.md` | Error: "expected .md file" |
| Target repo not found locally | Error with clone suggestion |
| Pass 1 extracts nothing | Log cleanly, exit (not an error) |
| Pass 1 returns invalid JSON | Retry once with error in prompt, then fail |
| ADR number can't be determined | Fall back to `0001` with warning |
| File write fails | Report what succeeded, what failed |
| Batch: one spec fails | Continue to next, report failures at end |
| Git commit fails | Files already written; suggest manual commit |
| Target repo has dirty tree | Warn, skip commit, files still written |
