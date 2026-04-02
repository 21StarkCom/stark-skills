# Failure Modes — stark-plan-to-tasks

| Failure | Recovery |
|---------|----------|
| Plan file doesn't exist or is empty | Fail with clear error message |
| Plan is not markdown (.md) | Fail with "expected .md file" error |
| Target repo doesn't exist on GitHub | Fail at Step 1 with repo name and org |
| Target repo doesn't match current checkout | Warn and ask user at Step 1 |
| GitHub App auth fails | Fail at Step 1 before any LLM work |
| `gh` CLI not found | Fail at Step 1 before any LLM work |
| App lacks issue/label permissions on target repo | Fail at Step 1 after repo access probe |
| GitHub API rate limit during issue creation | Stop, report partial state via run manifest, allow resume |
| Partial issue creation (some succeeded, some failed) | Run manifest records `task_id → issue_number` mapping; re-run skips created issues |
| Token expires mid-run (>1 hour with many issues) | Each `gh` command block inlines token acquisition; stale shell var is the risk, not cache |
| Issue body exceeds 65,536 char GitHub limit | Truncate with note (section caps should prevent this); never split — splitting is a decomposition change |
| LLM returns malformed JSON (Pass 2 or 3) | Validate against schema, retry once with error appended to prompt, halt if still invalid |
| Plan quality gate can't pass after 3 user rounds | Stop at Step 2, report remaining gaps |
| Validation can't converge after 2 iterations | Halt, do not create issues, surface remaining problems |
| Validation agent CLI not found | Fail at Step 1 with message naming the missing agent |
| Re-run on same plan (issues already exist) | Detected at Step 1; user chooses skip/update/fresh |
| Step 6 commit fails (pre-commit hook, dirty tree) | Plan not deleted; warn and leave changes unstaged for user review |
