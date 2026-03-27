# stark-insights — Design Spec

**Date:** 2026-03-27
**Status:** Draft
**Author:** Aryeh + Claude

## Overview

A local-first, cloud-synced observability and analytics system for AI CLI interactions. Collects metrics, insights, and conversation data from Claude Code, Codex CLI, and Gemini CLI. Stores locally for offline resilience, syncs to Cloud SQL for team-wide visibility, and integrates with infra-sentinel for monitoring.

## Goals

1. **Capture everything measurable** from AI CLI sessions — prompts, skill invocations, review findings, corrections, code changes, bug fixes, agent performance.
2. **Local + centralized** — local Docker proxy buffers offline, Cloud SQL is the source of truth.
3. **Team-ready** — any engineer running the stack contributes data; dashboards show cross-team patterns.
4. **Self-monitored** — infra-sentinel watches the pipeline via Prometheus metrics and Loki logs.
5. **LLM-queryable** — MCP server lets Claude Code explore the data via SQL.
6. **Backfill** — one-time import of all existing historical data.

## Success Metrics

| Metric | Target |
|--------|--------|
| Event capture rate | ≥99% of CLI events captured within 15 minutes |
| Sync lag | ≤5 minutes when online; ≤15 min after reconnect |
| Max data-loss window | 0 (write-ahead buffer is durable) |
| MCP query p95 latency | <2s for aggregate queries, <5s for ad-hoc |
| Storage cost | <$25/month (Cloud SQL + backups) |
| Local footprint | <350MB RAM, <0.5 CPU |

## Non-Goals

- Real-time streaming analytics (batch/near-real-time is fine).
- Replacing infra-sentinel (this is a data source *for* sentinel, not a replacement).
- Token-level cost attribution (capture if available, but don't build billing).

## MVP Boundary

**Phase 1 (MVP):** Claude Code hooks + Claude history scraper + SQLite write-ahead buffer + Cloud SQL sync + basic MCP query tools + infra-sentinel integration.

**Phase 2:** Codex and Gemini history scrapers, GitHub scraper, code metrics scraper, materialized aggregates.

**Phase 3:** Backfill, Grafana dashboards, session reconciliation, memory scraper, advanced MCP summary tool.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Claude Code / Codex CLI / Gemini CLI / Hooks       │
└──────────────┬──────────────────────────────────────┘
               │ MCP (HTTP/SSE) or HTTP POST
               ▼
┌──────────────────────────────────────────────────────┐
│  Local Docker Container: stark-insights              │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  FastAPI + MCP Server                        │    │
│  │  - POST /events — ingest events              │    │
│  │  - POST /query — run SQL against Cloud SQL   │    │
│  │  - GET /health — liveness                    │    │
│  │  - GET /metrics — Prometheus metrics          │    │
│  │  - MCP tools: log_event, query, status       │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────┐    │
│  │  Scheduler (APScheduler)                     │    │
│  │  - History scraper (5 min)                   │    │
│  │  - Run history scraper (5 min)               │    │
│  │  - Skill logs scraper (5 min)                │    │
│  │  - Session metadata scraper (5 min)          │    │
│  │  - Memory scraper (10 min)                   │    │
│  │  - GitHub scraper (15 min)                   │    │
│  │  - Code metrics scraper (15 min)             │    │
│  │  - Buffer flush to Cloud SQL (1 min)         │    │
│  └──────────────────────────────────────────────┘    │
│  ┌──────────┐                                        │
│  │ SQLite   │  ← offline buffer only                 │
│  │ WAL mode │                                        │
│  └──────────┘                                        │
│  ┌──────────────────────────────────────────────┐    │
│  │  obs_metrics + obs_logger                    │    │
│  │  (from infra-sentinel /lib/python/)          │    │
│  └──────────────────────────────────────────────┘    │
└──────────────┬───────────────────────────────────────┘
               │ always: write-ahead to SQLite first
               │ async: flush buffer to Cloud SQL
               ▼
       ┌──────────────┐
       │  Cloud SQL   │
       │  (Postgres)  │     ← source of truth
       │  GCP         │
       └──────┬───────┘
              │
              ▼
       ┌──────────────┐
       │  infra-       │
       │  sentinel     │     ← monitors the pipeline
       │  (Prometheus  │
       │   + Loki +    │
       │   Grafana)    │
       └──────────────┘
```

### Component Responsibilities

| Component | Role |
|-----------|------|
| **FastAPI** | HTTP API for event ingestion and SQL queries |
| **MCP Server** | Claude Code native integration (HTTP/SSE transport via the running FastAPI server) |
| **Scheduler** | Cron-based scraping of local history files, GitHub API |
| **SQLite buffer** | WAL-mode write-ahead log — ALL events land here first, synced async to Cloud SQL |
| **Cloud SQL** | Central Postgres — source of truth, team-wide queries |
| **obs_metrics** | Prometheus metrics for self-monitoring |
| **obs_logger** | Structured JSON logging for Loki ingestion |

---

## Data Model

### `sessions`

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| cli | text | claude / codex / gemini |
| user_id | text | Engineer identifier |
| project | text | Repo path or name |
| branch | text | Nullable |
| started_at | timestamptz | |
| ended_at | timestamptz | Nullable — updated on session end |
| prompt_count | int | Updated incrementally |
| outcome_summary | text | Nullable — populated at session end |

### `events`

Single event log with JSONB payload. All event types flow through this table. **Partitioned by month** on `timestamp` using Postgres native range partitioning — makes retention cleanup a `DROP PARTITION` instead of slow DELETE, and keeps index sizes manageable.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| dedupe_key | text | Source-stable idempotency key (see Deduplication below). UNIQUE constraint. |
| session_id | uuid | FK → sessions, nullable for scraped events |
| type | text | Event type discriminator |
| timestamp | timestamptz | When the event occurred (partition key) |
| cli | text | claude / codex / gemini |
| user_id | text | Canonical format: GitHub username (see Identity Normalization) |
| project | text | |
| payload | jsonb | Type-specific data, validated by Pydantic models at ingest |
| schema_version | int | Payload schema version (starts at 1, bumped on breaking changes) |
| source | text | hook / skill / scraper / backfill |
| synced_at | timestamptz | Null until flushed to Cloud SQL (local buffer only) |

**Indexes:**
- `idx_events_type` on `(type)`
- `idx_events_timestamp` on `(timestamp)`
- `idx_events_session` on `(session_id)`
- `idx_events_project` on `(project)`
- `idx_events_dedupe` on `(dedupe_key)` UNIQUE
- `idx_events_synced` on `(synced_at)` where `synced_at IS NULL` (partial, for buffer flush)
- GIN index on `payload` for JSONB queries

#### Deduplication

The same logical event may arrive via multiple paths (hook + scraper, scraper + backfill). The `dedupe_key` is source-stable and excludes volatile fields:

| Source | dedupe_key formula |
|--------|-------------------|
| Scraper (history files) | `{cli}:{file_path}:{byte_offset}` |
| Hook (real-time) | `{cli}:{session_id}:{sequence_number}` |
| Skill instrumentation | `{skill}:{session_id}:{start_timestamp}` |
| GitHub scraper | `github:{repo}:{event_type}:{github_id}` |
| Backfill | Same as whichever source the data originally came from |

`ON CONFLICT (dedupe_key) DO NOTHING` ensures no double-counting regardless of ingestion path.

#### Identity Normalization

The `user_id` field is normalized to GitHub username at ingest time. A `user_aliases` table maps known aliases:

| Column | Type |
|--------|------|
| alias | text | PK — git email, OS username, etc. |
| canonical_user_id | text | GitHub username |

Populated manually or via `gh api /user` during onboarding. Unknown aliases are stored as-is and flagged for resolution.

#### Session Reconciliation

Scraped events with `session_id = NULL` are back-linked by a periodic reconciliation job (runs after each scrape cycle):

1. Match events to sessions by `user_id + project + timestamp ∈ [started_at, ended_at]`
2. Per-CLI session keys: Claude uses `sessionId` from history.jsonl, Codex uses its session file UUID, Gemini uses per-session directory name
3. Unmatched events remain with `session_id = NULL` — they are still queryable, just not session-attributed

### Event Types

| Type | Payload Keys |
|------|-------------|
| `prompt` | `text`, `length`, `is_skill_invocation` |
| `skill_invocation` | `skill`, `args`, `duration_s`, `success`, `error` |
| `review_finding` | `pr_number`, `repo`, `agent`, `domain`, `severity`, `title`, `description`, `fixed`, `dismissed` |
| `correction` | `signal`, `context`, `what_was_wrong`, `what_was_fix` |
| `memory_write` | `memory_type`, `file`, `project`, `summary` |
| `code_change` | `files_changed`, `lines_added`, `lines_removed`, `commits` |
| `bug_fix` | `source`, `rounds_to_fix`, `error_type`, `duration_s`, `caused_by_agent` |
| `pr_event` | `pr_number`, `repo`, `action`, `review_rounds`, `time_to_merge_s` |
| `agent_dispatch` | `agent`, `task`, `duration_s`, `success`, `timeout`, `finding_count` |
| `tool_usage` | `tool`, `count`, `context` |
| `ci_signal` | `pr_number`, `repo`, `passed`, `failures` |

### Materialized Aggregates

Implemented as Postgres materialized views, refreshed by the scheduler (every 15 min or on-demand). Use `REFRESH MATERIALIZED VIEW CONCURRENTLY` (requires a unique index on each view) to avoid blocking readers during refresh.

#### `skill_usage`

| Column | Type |
|--------|------|
| skill | text | PK composite |
| period | date | PK composite |
| user_id | text | PK composite |
| invocations | int |
| avg_duration_s | float |
| success_rate | float |
| repos | text[] |

#### `agent_scorecards`

| Column | Type |
|--------|------|
| agent | text | PK composite |
| period | date | PK composite |
| reviews | int |
| findings | int |
| high_severity | int |
| fix_rate | float |
| timeout_rate | float |
| avg_duration_s | float |

---

## Data Collection

### Real-Time Path

#### Claude Code Hooks

Hooks use a helper script to safely JSON-encode values (raw shell interpolation into JSON breaks on quotes, newlines, and special characters):

```python
#!/usr/bin/env python3
# ~/.stark-insights/hook-emit.py
import json, sys, urllib.request, os

event = {"type": sys.argv[1], "payload": {}}
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1)
    event["payload"][k] = v
event["cli"] = "claude"
event["project"] = os.environ.get("CLAUDE_PROJECT", "")

req = urllib.request.Request(
    "http://localhost:7420/events",
    data=json.dumps(event).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    urllib.request.urlopen(req, timeout=2)
except Exception:
    pass  # fail silently — scraper is the safety net
```

```json
// settings.json
{
  "hooks": {
    "post_tool_call": [
      {"command": "python3 ~/.stark-insights/hook-emit.py tool_usage tool=$TOOL_NAME"}
    ],
    "notification": [
      {"command": "python3 ~/.stark-insights/hook-emit.py notification message=$MESSAGE"}
    ]
  }
}
```

#### Skill Instrumentation

Skills POST to the local server after execution:

```bash
curl -s -X POST http://localhost:7420/events \
  -H 'Content-Type: application/json' \
  -d '{"type": "skill_invocation", "payload": {"skill": "stark-review", "duration_s": 120, "success": true}}'
```

### Batch Path (Scheduler)

| Job | Frequency | Offset | Source | Collects |
|-----|-----------|--------|--------|----------|
| `scrape_claude_history` | 15 min | :00 | `~/.claude/history.jsonl` | Prompts, sessions, skill invocations |
| `scrape_codex_history` | 15 min | :03 | `~/.codex/history.jsonl` | Prompts, sessions |
| `scrape_gemini_history` | 15 min | :06 | `~/.gemini/history/` | Full conversations (prompt + response) |
| `scrape_run_history` | 15 min | :09 | `~/.claude/code-review/history/` | Review findings, agent performance |
| `scrape_skill_logs` | 15 min | :12 | `~/.claude/code-review/logs/` | Skill execution metadata |
| `scrape_session_metadata` | 15 min | :01 | `~/.claude/sessions/` | Session start/end, cwd |
| `scrape_github` | 30 min | :05 | GitHub API (with ETags + rate limit backoff) | PR events, reviews, CI, issues |
| `scrape_code_metrics` | 30 min | :20 | `git log` in active repos | Files changed, lines, commits |
| `flush_buffer` | 1 min | — | SQLite buffer | Flush unsynced events to Cloud SQL |
| `refresh_aggregates` | 15 min | :14 | Cloud SQL events table | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |

**Note:** Memory scraper deferred to Phase 3 (low incremental signal — memory writes are infrequent and capturable via skill instrumentation).

**Scheduler configuration:**
- All jobs use `max_instances=1` to prevent overlapping runs of the same scraper.
- Start times are staggered within the interval to avoid resource spikes.
- `stark_scrape_overruns_total{scraper}` metric tracks when a job can't start because the previous run is still active.

Each scraper tracks a **high-water mark** (last processed timestamp or file byte offset) persisted in SQLite. The high-water mark is only advanced **after** the scraped batch is successfully committed to the SQLite buffer — a mid-run crash resumes from the last committed position, not from the beginning. Scrapers are idempotent via `dedupe_key` (see Deduplication above).

**GitHub scraper specifics:** Uses conditional requests (`If-None-Match` with ETags) to avoid re-fetching unchanged data. Checks `X-RateLimit-Remaining` header and backs off when below 100 remaining requests. Paginates per-page with high-water mark updates per page (not per-job) so restarts don't re-fetch already-processed pages.

**Codex/Gemini CLI history:** Formats must be verified during implementation. Scrapers include resilience for missing or unparseable files (log warning, skip entry, continue). Pin to tested CLI versions in docs.

### Backfill

One-time import job that reads all historical data:

1. `~/.claude/history.jsonl` — all 6,921+ entries
2. `~/.claude/code-review/history/` — all 73+ run files
3. `~/.claude/code-review/logs/` — all skill logs
4. `~/.claude/sessions/` — all session metadata files
5. `~/.gemini/history/` — all Gemini session files
6. GitHub API — historical PRs, reviews, issues for configured repos

Backfill events are tagged `source: backfill` to distinguish from live data. The backfill job is idempotent and can be re-run safely.

---

## MCP Server

### Tools

| Tool | Description |
|------|------------|
| `stark_insights_log_event` | Log an event (type + payload). Used by skills and hooks. |
| `stark_insights_query` | Run a read-only SQL query against Cloud SQL (or local buffer if offline). Returns JSON rows. |
| `stark_insights_status` | Return sync status: buffer size, last sync time, Cloud SQL connectivity, scraper health. |
| `stark_insights_summary` | Run predefined aggregate queries and return a structured summary of recent activity (last 24h/7d) for the current project. Not LLM-generated — returns formatted SQL results. |

### MCP Transport

**HTTP/SSE only** — the MCP server runs inside the already-running FastAPI container and shares its process, DB connections, and scheduler state. No stdio-via-docker-exec (which would spawn a cold process per call with no shared state).

- **SSE** on `http://localhost:7420/mcp/sse` for all MCP clients (Claude Code, Codex, Gemini)

### MCP Configuration

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "stark-insights": {
      "url": "http://localhost:7420/mcp/sse"
    }
  }
}
```

---

## HTTP API

**Base URL:** `http://localhost:7420`

### Endpoints

| Method | Path | Body | Description |
|--------|------|------|------------|
| POST | `/events` | `{type, timestamp?, cli?, user_id?, project?, payload}` | Ingest a single event |
| POST | `/events/batch` | `[{...}, {...}]` | Ingest multiple events |
| POST | `/query` | `{sql, params?, limit?}` | Run read-only SQL with `statement_timeout` (10s) and row limit (default 10,000). Localhost-only security boundary. |
| GET | `/status` | — | Sync status, buffer size, connectivity |
| GET | `/health` | — | Liveness probe |
| GET | `/metrics` | — | Prometheus metrics |
| POST | `/backfill` | `{sources?: [...]}` | Trigger backfill job |

### Event Ingestion Logic

Write-ahead design — the local SQLite buffer is the durable record of every event, regardless of Cloud SQL availability:

1. Validate payload against the Pydantic model for the given `type`. Return `400 Bad Request` with error details if invalid.
2. Compute `dedupe_key` from source-stable fields (see Deduplication).
3. Write to SQLite buffer with `synced_at = NULL`. This is the durable acknowledgement.
4. Return `201 Created` with event ID.
5. The async flush job (every 1 min) handles Cloud SQL sync — the ingest path never blocks on Cloud SQL.

### Error Responses

All endpoints return a standard error envelope on failure:

```json
{"error": {"code": "invalid_payload", "message": "Field 'type' is required", "details": {...}}}
```

| Status | Meaning |
|--------|---------|
| 400 | Invalid payload (validation failed) |
| 409 | Duplicate event (dedupe_key conflict) |
| 500 | Internal error (logged, event NOT persisted) |

---

## Write-Ahead Buffer

**SQLite database:** `~/.stark-insights/buffer.db` (mounted into Docker container)

**ALL events are written here first** — this is the write-ahead log, not just an offline fallback. WAL mode for concurrent reads/writes.

**Flush logic (every 1 min):**
1. `SELECT * FROM events WHERE synced_at IS NULL ORDER BY timestamp LIMIT 1000`
2. Batch INSERT into Cloud SQL via `psycopg` with `ON CONFLICT (dedupe_key) DO NOTHING`
3. `UPDATE events SET synced_at = now() WHERE id IN (...)`
4. If Cloud SQL unreachable: skip, retry next cycle.
5. Periodic cleanup: `DELETE FROM events WHERE synced_at IS NOT NULL AND synced_at < now() - interval '7 days'`

**Buffer size cap:** Maximum 100,000 unsynced events or 500MB file size. When exceeded:
1. Drop lowest-priority events first (`tool_usage` before `review_finding` before `correction`)
2. Increment `stark_events_discarded_total{reason="buffer_full", priority}` counter
3. Log warning via obs_logger
4. Continue accepting high-priority events until hard cap (500MB) is hit

---

## infra-sentinel Integration

### Prometheus Metrics

Exposed on `GET /metrics` (port 7420), scraped by sentinel's Prometheus (pull model only — no Pushgateway needed since this is a long-running service).

**Counters:**
- `stark_events_ingested_total{type, cli, source}` — events received
- `stark_events_synced_total` — events flushed to Cloud SQL
- `stark_events_discarded_total{reason, priority}` — events dropped (buffer full, validation failure)
- `stark_events_deduplicated_total{source}` — events rejected as duplicates
- `stark_sync_errors_total{error_type}` — sync failures
- `stark_scrape_runs_total{scraper, status}` — scraper executions
- `stark_scrape_overruns_total{scraper}` — scraper couldn't start because previous run still active

**Gauges:**
- `stark_buffer_events_pending` — events waiting to sync
- `stark_buffer_size_bytes` — SQLite file size
- `stark_cloud_sql_connected` — 1 if reachable, 0 if offline
- `stark_cloud_sql_last_sync_epoch` — timestamp of last successful sync

**Histograms:**
- `stark_event_ingest_duration_seconds` — time to process an ingest request
- `stark_query_duration_seconds` — time to execute a SQL query
- `stark_scrape_duration_seconds{scraper}` — time per scraper run
- `stark_sync_batch_duration_seconds` — time per buffer flush

### Structured Logging

JSON to stdout, collected by GCP Cloud Logging → Loki:

```json
{
  "timestamp": "2026-03-27T14:30:00Z",
  "level": "info",
  "service": "stark-insights",
  "type": "background",
  "message": "Buffer flushed",
  "events_synced": 42,
  "duration_s": 0.8
}
```

### Alert Rules

Add to `configs/prometheus/alert-rules.yml` in infra-sentinel:

```yaml
- alert: StarkInsightsSyncStalled
  expr: time() - stark_cloud_sql_last_sync_epoch > 1800
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "stark-insights hasn't synced to Cloud SQL in 30 minutes"

- alert: StarkInsightsBufferGrowing
  expr: stark_buffer_events_pending > 5000
  for: 10m
  labels:
    severity: warning
  annotations:
    summary: "stark-insights buffer has {{ $value }} pending events"

- alert: StarkInsightsSyncErrors
  expr: rate(stark_sync_errors_total[5m]) > 0.1
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "stark-insights sync error rate elevated"
```

### Grafana Dashboard

**Panel: Events Ingested** — `rate(stark_events_ingested_total[5m])` by type
**Panel: Sync Lag** — `time() - stark_cloud_sql_last_sync_epoch`
**Panel: Buffer Size** — `stark_buffer_events_pending` over time
**Panel: Cloud SQL Data Growth** — `stark_events_synced_total` cumulative
**Panel: Scraper Health** — `stark_scrape_runs_total` by scraper and status
**Panel: Query Latency** — `histogram_quantile(0.95, stark_query_duration_seconds)`

---

## GCP Resources

Provisioned via Terraform in a new `terraform/` directory within the stark-insights repo.

| Resource | Type | Config |
|----------|------|--------|
| Cloud SQL instance | `google_sql_database_instance` | `db-g1-small` (1.7GB RAM, shared vCPU), Postgres 16, **public IP** with Auth Proxy, `infra-ai-platform` project. Instance size is a configurable Terraform variable. |
| Database | `google_sql_database` | `stark_insights` |
| DB user | `google_sql_user` | `stark_insights_app` (IAM-authenticated via Cloud SQL Auth Proxy) |
| Service account | `google_service_account` | `stark-insights@infra-ai-platform.iam.gserviceaccount.com` |
| IAM binding | `google_project_iam_member` | `roles/cloudsql.client` |
| Secret | `google_secret_manager_secret` | DB password in Secret Manager |

**Network model:** Cloud SQL uses **public IP** (the local Docker container runs on developer laptops, not in the GCP VPC). The Cloud SQL Auth Proxy sidecar handles authentication and encryption. No VPC peering needed.

### Cloud SQL Auth

Local Docker container connects via **Cloud SQL Auth Proxy** sidecar using **Application Default Credentials** (ADC). No service account key files on disk — developers authenticate via `gcloud auth application-default login` and mount the ADC token:

```yaml
# docker-compose.yml
services:
  cloud-sql-proxy:
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
    command: >
      --address 0.0.0.0
      --port 5432
      infra-ai-platform:us-central1:stark-insights
    volumes:
      - ${HOME}/.config/gcloud:/gcloud:ro
    environment:
      - GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json
    expose:
      - "5432"
```

The API container connects to `cloud-sql-proxy:5432` as if it were a local Postgres. The proxy handles SSL and IAM auth. Prerequisites: `gcloud auth application-default login` run once per developer machine.

---

## Docker Compose

```yaml
services:
  api:
    build: .
    command: ["python", "-m", "stark_insights.server"]
    ports:
      - "127.0.0.1:7420:7420"  # localhost-only — not exposed to network
    volumes:
      - ${HOME}/.claude:/data/claude:ro
      - ${HOME}/.codex:/data/codex:ro
      - ${HOME}/.gemini:/data/gemini:ro
      - ${HOME}/.stark-insights:/data/buffer
    environment:
      - DATABASE_URL=postgresql://stark_insights_app:${DB_PASSWORD}@cloud-sql-proxy:5432/stark_insights
      - BUFFER_PATH=/data/buffer/buffer.db
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - STATEMENT_TIMEOUT=10000  # 10s max query time
      - QUERY_ROW_LIMIT=10000   # max rows returned by /query
    depends_on:
      - cloud-sql-proxy
    mem_limit: 256m
    cpus: 0.25
    restart: unless-stopped

  cloud-sql-proxy:
    image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2
    command: >
      --address 0.0.0.0
      --port 5432
      infra-ai-platform:us-central1:stark-insights
    volumes:
      - ${HOME}/.config/gcloud:/gcloud:ro
    environment:
      - GOOGLE_APPLICATION_CREDENTIALS=/gcloud/application_default_credentials.json
    expose:
      - "5432"
    mem_limit: 64m
    cpus: 0.1
    restart: unless-stopped
```

**Total local footprint: ~320MB RAM, 0.35 CPU.**

---

## Project Structure

```
stark-insights/
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── CLAUDE.md
├── terraform/
│   ├── main.tf
│   ├── cloudsql.tf
│   ├── iam.tf
│   ├── variables.tf
│   └── outputs.tf
├── src/stark_insights/
│   ├── __init__.py
│   ├── server.py              # FastAPI app + startup + MCP SSE mount
│   ├── mcp_tools.py           # MCP tool definitions
│   ├── api/
│   │   ├── events.py          # POST /events, /events/batch
│   │   ├── query.py           # POST /query
│   │   └── status.py          # GET /status, /health, /metrics
│   ├── db/
│   │   ├── cloud_sql.py       # Cloud SQL connection + writes
│   │   ├── buffer.py          # SQLite buffer logic
│   │   ├── schema.py          # SQLAlchemy models
│   │   └── migrations/        # Alembic migrations
│   ├── scrapers/
│   │   ├── base.py            # Base scraper with high-water mark
│   │   ├── claude_history.py
│   │   ├── codex_history.py
│   │   ├── gemini_history.py
│   │   ├── run_history.py
│   │   ├── skill_logs.py
│   │   ├── session_metadata.py
│   │   ├── memory.py
│   │   ├── github.py
│   │   └── code_metrics.py
│   ├── scheduler.py           # APScheduler job definitions
│   ├── sync.py                # Buffer flush + Cloud SQL sync
│   ├── backfill.py            # One-time historical import
│   └── observability.py       # obs_metrics + obs_logger setup
├── tests/
│   ├── test_api.py
│   ├── test_scrapers.py
│   ├── test_buffer.py
│   ├── test_sync.py
│   └── test_backfill.py
└── hooks/
    └── hook-emit.py           # Claude Code hook helper (installed to ~/.stark-insights/)
```

---

## Ensuring Data Is Always Collected

Three layers of redundancy:

1. **Claude Code hooks** (real-time) — fire on every tool call and notification. Zero agent cooperation needed. POST to `localhost:7420/events`.
2. **Skill instrumentation** (real-time) — skills POST after execution. Belt and suspenders with hooks.
3. **Scrapers** (batch, every 5 min) — read history files from all three CLIs, run history, GitHub API. Catches everything hooks miss. Idempotent via content-hash IDs.

If the Docker container is down, hooks fail silently (curl returns non-zero, hook continues). The scraper catches up when the container restarts — history files are the durable source, the container is just a processor.

---

## Backfill Strategy

Triggered via `POST /backfill` or `docker exec stark-insights python -m stark_insights.backfill`.

**Sources (same as scraper sources, processed from the beginning instead of high-water mark):**
1. `~/.claude/history.jsonl` — all entries (6,921+)
2. `~/.claude/code-review/history/` — all run files (73+)
3. `~/.claude/code-review/logs/` — all skill logs
4. `~/.claude/sessions/` — all session metadata files
5. `~/.gemini/history/` — all Gemini session directories
6. GitHub API — historical PRs, reviews, issues for repos in `~/.claude/projects/`

**All backfill events tagged `source: backfill`.** Idempotent — safe to re-run.

---

## Retention

| Store | Retention | Mechanism |
|-------|-----------|-----------|
| Cloud SQL events | 1 year | `DROP PARTITION` for months older than 12 months (table is range-partitioned by month) |
| Cloud SQL aggregates | Indefinite | Rolled up by day, small footprint |
| SQLite buffer | 7 days after sync | `DELETE WHERE synced_at IS NOT NULL AND synced_at < now() - interval '7 days'` |
| Cloud SQL backups | 7 days | Cloud SQL automated backups |

---

## Security

### Network & Auth

- Local API binds to `127.0.0.1:7420` only (enforced in docker-compose `ports` mapping) — not exposed to network.
- Local API requires a shared secret Bearer token (generated at container startup, written to `~/.stark-insights/api-token`). Defense-in-depth against any local process abuse.
- Cloud SQL Auth Proxy handles mTLS via ADC — no service account key files on disk.
- DB password stored in GCP Secret Manager, injected as env var.
- History file mounts are read-only (`:ro`).
- SQL queries via MCP/API use `SET default_transaction_read_only = on` and `statement_timeout = 10s`.
- GitHub token scoped to read-only (PRs, issues, reviews).
- Service account has `cloudsql.client` only — no admin access.

### Data Classification & PII

Event payloads are classified by sensitivity:

| Classification | Event Types | Policy |
|---------------|-------------|--------|
| **Public** | `skill_invocation`, `pr_event`, `ci_signal`, `agent_dispatch` | Stored as-is in Cloud SQL, visible team-wide |
| **Internal** | `code_change`, `bug_fix`, `tool_usage`, `review_finding` | Stored in Cloud SQL, visible team-wide |
| **Sensitive** | `prompt`, `correction`, `memory_write` | `prompt.text` is truncated to first 200 chars in Cloud SQL. Full text retained in local buffer only. Accessible only to originating `user_id` in team queries. |

Ingest-time scrubbing: the API strips or truncates sensitive fields before the Cloud SQL sync flush. The local SQLite buffer retains full data for the originating user's MCP queries.

---

## Dependencies

```toml
[project]
name = "stark-insights"
requires-python = ">=3.12"

dependencies = [
    "fastapi>=0.115",
    "uvicorn>=0.34",
    "sqlalchemy>=2.0",
    "alembic>=1.14",
    "psycopg[binary]>=3.2",
    "aiosqlite>=0.20",
    "apscheduler>=3.11,<4",  # 4.x is an incompatible async rewrite
    "mcp>=1.0",
    "prometheus-client>=0.21",
    "httpx>=0.28",
    "pydantic>=2.10",
]
```
