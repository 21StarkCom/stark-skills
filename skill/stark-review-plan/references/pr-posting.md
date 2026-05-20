# PR Posting Details

## Post per-agent raw findings to PR

**Every agent's raw findings MUST be posted to the PR under that agent's bot identity.** GitHub serves as the permanent data store for learning and analysis.

For each agent that returned findings, post a separate comment under that agent's bot:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number --comment --body "$claude_findings"
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-codex pr review $pr_number --comment --body "$codex_findings"
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-gemini pr review $pr_number --comment --body "$gemini_findings"
```

Each agent's comment should list its raw findings in a table. If an agent returned 0 findings or failed, still post a short status comment under its identity.

Then post the orchestrator's classified summary as `stark-claude[bot]`:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails for a specific agent, warn and continue.
