# PR Posting Details

## Post lead/wing output to PR

**The lead's raw findings and the wing's summary MUST be posted to the PR under their bot identities.** GitHub serves as the permanent data store for learning and analysis.

Post the codex lead's raw findings under `stark-codex[bot]`:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-codex pr review $pr_number --comment --body "$codex_findings"
```

The comment should list the raw findings in a table. If the lead returned 0 findings or failed, still post a short status comment under its identity.

Then post the claude wing's classified summary as `stark-claude[bot]`:

```bash
node --experimental-strip-types "$TOOLS/github_app.ts" --app stark-claude pr review $pr_number --comment --body "$summary"
```

If posting fails for either identity, warn and continue.
