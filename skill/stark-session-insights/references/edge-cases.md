# Edge Cases & Limitations

Referenced from [../SKILL.md](../SKILL.md).

## Edge Cases

- **Empty history file** -- error and abort, not a silent skip
- **Project with only 1 prompt** -- show stats but session length = 0
- **Malformed JSONL lines** -- skip with warning, don't abort
- **Missing fields** -- `display` defaults to empty string, skip entries without `timestamp`
- **Very long display text** -- truncate to 300 chars in output, never show full text of extremely long prompts
- **Unicode in prompts** -- preserve as-is in output
- **No corrections found** -- show section with "No corrections detected."
- **No skills used** -- show section with "No skill invocations found."

## What This Skill Does NOT Do

- Modify or delete history.jsonl
- Send data anywhere -- all output is local files
- Analyze prompt content for security/sensitive data
- Compare across users (single-user tool)
- Create GitHub issues or PRs
