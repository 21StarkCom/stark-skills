# Automation Fleet — Operator Runbook

The stark automation fleet is a self-maintaining system of 12 Claude Code Remote (CCR) triggers running on cron schedules in Anthropic's cloud. Each trigger performs a specific maintenance function across the 6-repo GetEvinced ecosystem. Triggers are organized into 4 tiers by function: self-improvement, health/drift detection, intelligence gathering, and reporting/meta-monitoring.

All state is persisted as git-committed files in this `automation/` directory. CCR sessions are ephemeral — nothing survives between runs except what gets pushed to this repo.

---

## Quick Reference

| Trigger | Schedule (UTC) | Tier | Purpose |
|---------|---------------|------|---------|
| `stark-evolution` | `0 3 * * 0` (Sun 03:00) | 1 — Self-Improvement | Detect new model releases, benchmark, recommend upgrades |
| `stark-self-review` | `0 6 * * 1` (Mon 06:00) | 1 — Self-Improvement | Analyze recent PR review quality, propose prompt improvements |
| `stark-sentinel` | `0 5 * * 0-3,5-6` (6d/wk 05:00) | 2 — Health & Drift | Validate CLI tool health, snapshot versions and flags |
| `stark-dependency-audit` | `0 4 * * 2` (Tue 04:00) | 2 — Health & Drift | Scan all 6 repos for outdated or vulnerable dependencies |
| `stark-infra-drift` | `0 6 * * *` (daily 06:00) | 2 — Health & Drift | Detect config drift across Terraform, Docker, CI files |
| `stark-api-compat` | `0 7 * * *` (daily 07:00) | 2 — Health & Drift | Validate API contracts between repos haven't broken |
| `stark-intelligence` | `0 6 * * 3` (Wed 06:00) | 3 — Intelligence | Cross-repo pattern analysis, extract reusable insights |
| `stark-claude-md-sync` | `0 4 * * 4` (Thu 04:00) | 3 — Intelligence | Audit CLAUDE.md files across repos for accuracy and completeness |
| `stark-digest` | `0 14 * * 5` (Fri 14:00) | 4 — Reporting | Weekly Slack digest summarizing all fleet activity |
| `stark-automation-monitor` | `0 9 * * *` (daily 09:00) | 4 — Meta | Aggregate all trigger logs, generate reports and cost ledger |
| `stark-hooks-auditor` | `0 5 * * 4` (Thu 05:00) | 4 — Meta | Audit Claude Code hooks across all repos, recommend additions |

---

## Operational Procedures

### Pause/Resume a Trigger

To pause a single trigger, use the CCR RemoteTrigger API:

```bash
# Pause — disable the trigger's cron schedule
claude triggers pause <trigger-id>

# Resume
claude triggers resume <trigger-id>
```

To re-register a trigger after changes to its prompt or config:

```bash
scripts/register_triggers.sh --trigger stark-sentinel
```

This reads the trigger's cron and MCP connectors from `global/config.json` and re-registers it with CCR.

### PAT Rotation

The `STARK_TRIGGERS_PAT` token is shared by all 12 triggers. Rotate every 90 days:

1. **Generate new PAT** — GitHub Settings > Developer settings > Fine-grained tokens. Scope to `GetEvinced` org with `contents:write`, `issues:write`, `pull_requests:write` on all 6 repos.
2. **Update Keychain** — `security add-generic-password -U -s STARK_TRIGGERS_PAT -a stark -w "<new-token>"` (or update via Keychain Access).
3. **Re-register all triggers** — `scripts/register_triggers.sh --update-secret`. This pushes the new PAT to all 12 CCR triggers without changing their schedules.
4. **Verify** — manually run the sentinel trigger and confirm it can clone, push, and call `gh api`:
   ```bash
   claude triggers run stark-sentinel --manual
   ```
5. **Revoke old PAT** — once all triggers have run successfully with the new token, delete the old PAT from GitHub.

### Lost Log Recovery

If a trigger's git push fails (race condition, network issue), the run record is lost from git but still exists in CCR's execution history:

1. Go to [claude.ai/code/scheduled](https://claude.ai/code/scheduled)
2. Find the trigger by name and timestamp
3. The full session transcript is available — extract the run record and manually prepend it to the trigger's log file

### Archive Recovery

Triggers may archive old log entries to `automation/archive/`. To find archived data:

```bash
# Find all commits that touched the archive
git log -- automation/archive/

# Restore a specific archived file
git show <commit>:automation/archive/<filename>
```

### Issue Dedupe Troubleshooting

Triggers that open GitHub issues use the `automation:<trigger-name>` label to prevent duplicates. If a trigger is creating duplicate issues:

1. **Verify the label exists** on the target repo:
   ```bash
   gh label list -R GetEvinced/<repo> | grep "automation:"
   ```
   If missing, create it:
   ```bash
   gh label create "automation:stark-sentinel" --color "d4c5f9" -R GetEvinced/<repo>
   ```

2. **Verify the search query** — triggers search for open issues with their label before creating new ones. Check the trigger prompt for the correct search pattern:
   ```bash
   gh issue list -R GetEvinced/<repo> -l "automation:stark-sentinel" --state open
   ```

3. **Check for label typos** — the label in the trigger prompt must exactly match the label on the repo (case-sensitive).

---

## Adding a New Trigger

Checklist for adding trigger #13+:

- [ ] Create prompt file: `automation/prompts/<trigger-name>.md`
- [ ] Add config entry in `global/config.json` under `automation.triggers` with `cron`, `tier`, and `budget_usd`
- [ ] Create the `automation:<trigger-name>` label on all repos the trigger will open issues against
- [ ] Create empty log file: `automation/triggers/<trigger-name>.md` with header and `schema_version: 1`
- [ ] Register with CCR: `scripts/register_triggers.sh --trigger <trigger-name>`
- [ ] Run manually first: `claude triggers run <trigger-name> --manual`
- [ ] Verify log file was updated and pushed
- [ ] Enable cron schedule

---

## Adding a New Repo

Checklist for extending fleet coverage to a 7th+ repo:

- [ ] Ensure `STARK_TRIGGERS_PAT` has access — update the PAT's repo scope to include the new repo
- [ ] Add the repo to `global/config.json` in the `automation.repos` array
- [ ] Update trigger prompts that should scan the new repo (typically: `stark-dependency-audit`, `stark-infra-drift`, `stark-api-compat`, `stark-intelligence`, `stark-claude-md-sync`)
- [ ] Re-register affected triggers: `scripts/register_triggers.sh --trigger <name>` for each
- [ ] Create `automation:*` labels on the new repo for any triggers that open issues

---

## Monitoring

### Dashboard

The `automation/triggers/_index.md` file is an auto-generated dashboard maintained by `stark-automation-monitor`. It shows the latest status of every trigger: last run time, pass/fail, token usage.

### Cost Tracking

`automation/costs/token-usage.md` is a running ledger of estimated token costs per trigger per week. Budget alerts fire via Slack when weekly spend exceeds $50.

### Slack Alerts

Critical alerts (trigger failures, CLI breakage, security findings) go to the configured Slack channel immediately. The weekly digest (`stark-digest`, Fridays at 14:00 UTC) summarizes all fleet activity for the week.

---

## External Watchdog

The fleet includes a GitHub Actions workflow (`.github/workflows/automation-heartbeat.yml`) that runs daily at noon UTC. It checks whether any commit has touched `automation/triggers/` in the last 48 hours. If not, the workflow fails — this surfaces in GitHub's Actions tab and can trigger email/Slack notifications via GitHub's built-in alerting.

This is intentionally outside CCR so that a CCR-wide outage doesn't prevent the alert from firing.
