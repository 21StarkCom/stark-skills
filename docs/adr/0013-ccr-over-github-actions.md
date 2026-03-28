# ADR-0013: CCR Over GitHub Actions for Automation Fleet

**Date:** 2026-03-28
**Status:** Accepted
**Context:** stark-automation-fleet design

## Decision

Use Claude Code Remote Triggers (CCR) as the execution substrate for the 12-trigger automation fleet instead of GitHub Actions.

## Rationale

GitHub Actions can run shell scripts on a cron schedule but cannot run multi-turn Claude conversations with tool access. The automation triggers need to reason over code, analyze review quality, benchmark models, and make judgment calls about findings — tasks that require an LLM agent with tool use, not just scripted commands.

CCR provides:
- Fresh git clone per run (clean state)
- Full Claude tool suite (Bash, Read, Write, Edit, Glob, Grep)
- MCP connector support (Slack, Context7)
- claude-sonnet-4-6 as the execution model
- Managed scheduling with minimum 1-hour granularity

## Trade-offs

| Factor | CCR | GitHub Actions |
|--------|-----|----------------|
| Multi-turn LLM reasoning | Native | Requires wrapping CLI calls in bash |
| Tool access | Full Claude tool suite | Shell only |
| MCP connectors | Built-in | Manual webhook/API integration |
| Scheduling UI | claude.ai/code/scheduled | GitHub Actions tab |
| Debugging | CCR execution logs | GHA run logs (better) |
| Cost | Token-based ($6-15/week est.) | Free for public repos, minutes-based for private |
| Reliability | Dependent on Anthropic cloud | Dependent on GitHub infrastructure |
| Self-monitoring | Cannot monitor itself (needs external watchdog) | Can monitor itself |

## Consequences

- An external GitHub Actions heartbeat workflow is required to detect total CCR outages
- Trigger prompts must be fully self-contained (zero ambient context between runs)
- All state persistence must go through git (no filesystem persists between runs)
- Debugging requires claude.ai/code/scheduled UI, not standard CI/CD logs
