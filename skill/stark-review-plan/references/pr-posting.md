# PR Posting Details

## Post per-agent raw findings to PR

**Every agent's raw findings MUST be posted to the PR under that agent's bot identity.** GitHub serves as the permanent data store for learning and analysis.

For each agent that returned findings, post a separate comment under that agent's bot:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$claude_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-codex pr review $pr_number --comment --body "$codex_findings"
$PYTHON $SCRIPTS/github_app.py --app stark-gemini pr review $pr_number --comment --body "$gemini_findings"
```

Each agent's comment should list its raw findings in a table. If an agent returned 0 findings or failed, still post a short status comment under its identity.

In tournament mode, also post the tournament scorecard under stark-claude:
```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$tournament_scorecard"
```

Then post the orchestrator's classified summary as `stark-claude[bot]`:

```bash
$PYTHON $SCRIPTS/github_app.py --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails for a specific agent, warn and continue.
