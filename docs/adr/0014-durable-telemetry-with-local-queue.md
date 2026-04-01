# ADR-0014: Durable Telemetry With Local Queue

**Date:** 2026-04-01
**Status:** Accepted
**Context:** Codex architectural review of stark-skills observability, stark-insights design spec

## Decision

Replace the fire-and-forget HTTP POST in `stark-emit` with a SQLite write-ahead queue. Standardize on a single event envelope for all producers. Demote `history.jsonl` scraping from primary analytics source to backfill/audit fallback.

## Problem

Three competing sources of truth that don't converge:

1. **`standards/observability.md`** — user-facing progress protocol (TaskCreate + timestamped logs + metrics summaries). Well-designed for terminal UX. Not telemetry.
2. **`stark-emit`** — posts `{type, cli, project, source, session_id, payload}` to localhost:7420. Silently drops events when the container is down. No local persistence, no retry, no dead-letter.
3. **`scripts/metrics.py` + `stark-skill-analytics`** — reconstruct analytics by normalizing four incompatible JSON formats from `~/.claude/code-review/history/` and scraping slash commands from `history.jsonl`.

The stark-insights design spec (2026-03-27) already describes the right target architecture but the active producers haven't converged on it.

## Rationale

The single highest-leverage fix is making event emission durable. Today, if the stark-insights container is down (restart, deploy, network hiccup), events are permanently lost. The safety net is history.jsonl scraping, but that requires complex format normalization (four PR review formats, A through D in `metrics.py:96-212`) and can only reconstruct a subset of events.

A local SQLite queue decouples emission from delivery. Events are durable the moment they're written, regardless of whether the API is reachable. This matches the stark-insights spec's "write-ahead buffer" goal with zero data loss.

## What We Build

1. **`scripts/emit_queue.py`** — shared Python module with:
   - `enqueue(event)` — validates against schema, writes to SQLite, returns immediately
   - `drain()` — flushes pending events to the API, marks as synced
   - `dead_letter(event_id, error)` — moves to dead-letter table after N failures
   - SQLite DB at `~/.stark-insights/queue.db` with WAL mode for concurrent access

2. **Updated `stark-emit`** — uses `emit_queue.enqueue()` instead of direct HTTP POST. Drain runs opportunistically (best-effort after enqueue) and via a periodic trigger.

3. **`scripts/event_schema.json`** — canonical event envelope matching the stark-insights spec, validated at enqueue time.

## What We Don't Build

| Rejected | Why |
|----------|-----|
| Skill manifest schema (`skill-manifest.schema.json`) | SKILL.md is the manifest. Git versions prompts. A parallel JSON manifest creates a sync problem between two representations at current scale (26 skills, 1 primary user). |
| OpenTelemetry-grade event envelope (25+ fields) | The stark-insights spec's schema is right-sized. `trace_id`, `span_id`, `parent_span_id` are production service concerns, not CLI tool concerns. |
| Data mart / star schema (fact tables for skill_runs, phase_runs, tool_calls, etc.) | Two materialized views (`skill_usage`, `agent_scorecards`) cover current query patterns. Build marts when query needs outgrow views. |
| MLflow-style Prompt Registry | `git log global/prompts/claude/01-architecture.md` gives full version history with diffs. Separate registry is unnecessary. |
| Eval suites blocking skill promotion | Right direction, wrong time. Fix data quality before building quality gates. |

## Event Envelope

Right-sized to the stark-insights spec, not OpenTelemetry:

```json
{
  "type": "skill_invocation",
  "timestamp": "2026-04-01T14:30:00Z",
  "cli": "claude",
  "user_id": "aryeh-stark",
  "project": "/Users/aryeh/git/Evinced/widget-system",
  "session_id": "abc123",
  "source": "skill",
  "schema_version": 1,
  "dedupe_key": "stark-review:abc123:1743518200",
  "payload": { ... }
}
```

Dedupe key formulas per the existing spec:
- Skill: `{skill}:{session_id}:{start_timestamp}`
- Hook: `{cli}:{session_id}:{sequence_number}`
- Scraper: `{cli}:{file_path}:{byte_offset}`

## Migration Path

1. `stark-emit` gains durable queue (this ADR). Old callers work unchanged.
2. History format standardizes on `RunRecord` shape for new writes. Existing four formats remain supported read-only in `metrics.py`.
3. Once structured events flow reliably, `stark-skill-analytics` history.jsonl parsing becomes backfill/audit, not primary source.

## Consequences

- Events survive container restarts and network interruptions (zero data loss).
- New dependency: SQLite (stdlib in Python, no external package).
- `~/.stark-insights/queue.db` becomes a local state file that needs housekeeping (drain + prune).
- `stark-emit` script gains ~80 lines but remains a single-file executable.
- No breaking changes to existing callers — same CLI interface, same env vars.
