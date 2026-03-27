# stark-insights — Implementation Plan

## 1. Overview

Build `stark-insights` in buffer-first order: lock unresolved design decisions, stand up the SQLite WAL buffer and Cloud SQL schema, ship the authenticated FastAPI ingest path that only acknowledges after local durability, add the MVP Claude scrapers, expose read-only query and MCP surfaces, instrument observability, then extend to additional CLIs and backfill.

Eight phases total. Phases 0–5 constitute the MVP. Phases 6–7 extend to additional data sources and historical import.

Non-negotiable constraints from the design: every event lands in SQLite first, Cloud SQL is the shared source of truth, `events` is monthly partitioned, sensitive payload fields are scrubbed before remote sync, the API is localhost-only plus bearer-token protected, and scheduled jobs must be staggered with `max_instances=1`.

## 2. Prerequisites

**Must exist before Phase 0:**
- GCP project `infra-ai-platform` with billing enabled
- Developer has `gcloud auth application-default login` completed
- Docker Desktop running locally
- Python 3.12+, `uv`, Terraform, `gcloud`, `gh`
- `infra-sentinel` repo accessible (for obs_metrics/obs_logger SDK)

**Local state:**
- `~/.claude`, `~/.codex`, `~/.gemini` must exist (CLI history directories)
- `~/.stark-insights/` created during setup: `mkdir -p ~/.stark-insights`

## 3. Phases

---

## Phase 0: Design Lock and Project Skeleton

**Goal:** Remove implementation ambiguity and create a runnable project shell.
**Dependencies:** None
**Estimated effort:** S

### Tasks

1. **Freeze conflicting design choices**
   - Scheduler cadence: 15 min for all scrapers (the `5 min` references in the architecture diagram are legacy — the job table is authoritative)
   - Cloud SQL auth: ADC through Cloud SQL Auth Proxy (no IAM DB auth, no Secret Manager password). Auth flow: developer runs `gcloud auth application-default login`, proxy mounts `~/.config/gcloud/`
   - Bearer token: generated at container startup, written to `~/.stark-insights/api-token` (host-accessible via volume mount), hooks read from that path
   - MCP transport: HTTP/SSE only (no stdio-via-docker-exec)
   - Record decisions in `CLAUDE.md` and `.env.example`
   - Files: `CLAUDE.md`, `.env.example`

2. **Scaffold the package**
   - `pyproject.toml` with all dependencies from the spec (APScheduler pinned `>=3.11,<4`)
   - `src/stark_insights/__init__.py`, `src/stark_insights/server.py` with `create_app() -> FastAPI`
   - `src/stark_insights/config.py` — Pydantic Settings with env var loading, fail-fast on missing required vars
   - `Dockerfile` (Python 3.12 slim)
   - `docker-compose.yml` with just the `api` service (no proxy yet), localhost-only port binding `127.0.0.1:7420:7420`
   - `tests/conftest.py` with fixtures
   - Files: `pyproject.toml`, `Dockerfile`, `docker-compose.yml`, `src/stark_insights/`

3. **Observability scaffolding** (moved up from later phases)
   - `src/stark_insights/observability.py` — define all Prometheus counters, gauges, histograms from the spec using `prometheus_client`; configure JSON structured logging
   - `GET /metrics` endpoint on the FastAPI app
   - All subsequent phases instrument against this module from the start
   - Files: `src/stark_insights/observability.py`, `src/stark_insights/api/status.py`

### Risks
- Design drift from unresolved auth choices → block all coding until decisions are recorded
- Skeleton starts without config validation → fail fast on missing env vars at process startup

### Verification
```bash
uv sync
uv run python -m stark_insights.server
curl -s http://127.0.0.1:7420/health  # 200
curl -s http://127.0.0.1:7420/metrics  # Prometheus text format
```

### Rollback
Revert the scaffold branch. No persistent state exists yet.

---

## Phase 1: Storage Foundation

**Goal:** Create the durable local buffer (SQLite WAL) and the Cloud SQL schema. The two storage layers that everything else builds on.
**Dependencies:** Phase 0
**Estimated effort:** M

### Tasks

1. **Pydantic event models**
   - `src/stark_insights/models.py` — Pydantic v2 models for all 11 event types
   - Base `EventEnvelope` with `type`, `timestamp`, `cli`, `user_id`, `project`, `payload`, `source`
   - Discriminated union on `type` field for payload validation
   - `compute_dedupe_key()` per the spec's source-stable formulas
   - `normalize_user_id()` — resolve alias to canonical user_id (lookup `user_aliases`, passthrough if unknown)
   - Files: `src/stark_insights/models.py`

2. **SQLite buffer**
   - `src/stark_insights/db/buffer.py` — WAL-mode SQLite via `aiosqlite`
   - Schema: `events` table, `high_water_marks(scraper TEXT PK, value TEXT, updated_at TEXT)`, `user_aliases(alias TEXT PK, canonical_user_id TEXT)`
   - Operations: `insert_event()`, `insert_batch()`, `get_unsynced(limit)`, `mark_synced(ids)`, `cleanup_synced(days=7)`, `get_buffer_stats()`
   - All inserts use `ON CONFLICT (dedupe_key) DO NOTHING`
   - High-water mark only advances after successful commit
   - Files: `src/stark_insights/db/buffer.py`

3. **Terraform configuration**
   - `terraform/main.tf` — Google provider, `infra-ai-platform` project, GCS backend for state
   - `terraform/cloudsql.tf` — `google_sql_database_instance` (db-g1-small, Postgres 16, public IP, tier as variable), `google_sql_database` (stark_insights), DB user
   - `terraform/iam.tf` — service account + `roles/cloudsql.client` binding
   - `terraform/variables.tf` — tier, region, project ID
   - `terraform/outputs.tf` — connection name, instance IP
   - Files: `terraform/*.tf`

4. **Cloud SQL schema via Alembic**
   - `src/stark_insights/db/schema.py` — SQLAlchemy models (sessions, events, user_aliases)
   - Initial migration: `events` with monthly range partitioning on `timestamp`, all indexes from spec (type, timestamp, session_id, project, dedupe_key UNIQUE, synced partial, GIN on payload)
   - `ensure_event_partitions(months_ahead=3)` — called at migration time to create current + 3 months; also called at server startup and as a monthly scheduled job
   - Files: `src/stark_insights/db/schema.py`, `src/stark_insights/db/migrations/`

5. **Provision GCP resources**
   - `terraform plan` → `terraform apply`
   - Verify connectivity: `pg_isready -h <instance-ip>`
   - Run `alembic upgrade head` against Cloud SQL (via Auth Proxy)
   - Files: none (operational step)

6. **Tests**
   - `tests/test_models.py` — each event type validation, dedupe key computation, user normalization
   - `tests/test_buffer.py` — SQLite buffer CRUD, dedup, WAL concurrency, high-water mark atomicity
   - Files: `tests/test_models.py`, `tests/test_buffer.py`

### Risks
- SQLite/Postgres schema divergence → generate both from one canonical model layer
- Partition creation gap at month rollover → create next-month partitions at startup + monthly scheduled job
- Terraform state management → use GCS backend with bucket versioning

### Verification
```bash
terraform plan                         # shows expected resources
terraform apply                        # provisions Cloud SQL
alembic upgrade head                   # creates schema
uv run pytest tests/test_buffer.py tests/test_models.py -q
```

### Rollback
`terraform destroy` removes Cloud SQL. Delete local buffer DB. Alembic downgrade if needed.

---

## Phase 2: Ingest API and Buffer Sync

**Goal:** `POST /events` is durable, idempotent, and safe under Cloud SQL outages. Buffer flushes to Cloud SQL every minute.
**Dependencies:** Phase 1
**Estimated effort:** M

### Tasks

1. **Bearer token middleware**
   - Generate token at startup, write to `/data/buffer/api-token` (mounted as `~/.stark-insights/` on host)
   - Validate `Authorization: Bearer <token>` on all requests except `/health` and `/metrics`
   - Files: `src/stark_insights/server.py`

2. **Ingest endpoints**
   - `POST /events` — validate → compute dedupe_key → normalize user_id → write to SQLite → return 201
   - `POST /events/batch` — same, within a single transaction
   - Standard error envelope: 400 (validation), 409 (duplicate), 500 (internal)
   - Files: `src/stark_insights/api/events.py`

3. **Cloud SQL connection pool**
   - `src/stark_insights/db/cloud_sql.py` — async SQLAlchemy engine connected to `cloud-sql-proxy:5432`
   - `SET default_transaction_read_only = on` for query connections
   - Connection health check
   - Files: `src/stark_insights/db/cloud_sql.py`

4. **Buffer flush worker**
   - `src/stark_insights/sync.py` — every 1 minute:
     - SELECT unsynced from SQLite (limit 1000)
     - Scrub sensitive fields: truncate `prompt.text` to 200 chars, redact `correction.what_was_wrong` to summary
     - Batch INSERT into Cloud SQL with `ON CONFLICT (dedupe_key) DO NOTHING`
     - Mark synced in SQLite after remote commit succeeds
     - Cleanup synced events older than 7 days
   - Files: `src/stark_insights/sync.py`

5. **Buffer size cap**
   - Max 100,000 unsynced events or 500MB file size
   - Priority-based eviction (lowest to highest): `tool_usage` < `code_change` < `ci_signal` < `pr_event` < `agent_dispatch` < `skill_invocation` < `prompt` < `bug_fix` < `memory_write` < `review_finding` < `correction`
   - Increment `stark_events_discarded_total{reason="buffer_full", priority}` on eviction
   - Files: `src/stark_insights/db/buffer.py`

6. **Docker Compose update**
   - Add `cloud-sql-proxy` sidecar (ADC auth, no key file)
   - API: 256MB/0.25CPU, Proxy: 64MB/0.1CPU
   - Environment: `DATABASE_URL`, `BUFFER_PATH`, `STATEMENT_TIMEOUT=10000`, `QUERY_ROW_LIMIT=10000`
   - Files: `docker-compose.yml`

7. **Update /status**
   - Include: Cloud SQL connectivity, last sync time, buffer pending count, buffer size bytes
   - Files: `src/stark_insights/api/status.py`

8. **Tests**
   - `tests/test_api.py` — ingest happy path, validation (400), dedup (409), batch, auth (401)
   - `tests/test_sync.py` — flush logic, ON CONFLICT, sensitive scrubbing, buffer cap eviction (use `testcontainers-python` for real Postgres)
   - Files: `tests/test_api.py`, `tests/test_sync.py`

### Risks
- Sync marks rows before remote commit → single transaction boundary, update `synced_at` afterward only
- ADC varies across dev machines → document `gcloud auth application-default login`, fail fast with clear error

### Verification
```bash
docker compose up -d
TOKEN=$(cat ~/.stark-insights/api-token)
curl -s -X POST http://127.0.0.1:7420/events -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"tool_usage","payload":{"tool":"rg","count":1,"context":"test"}}'  # 201
# Same curl again → 409
# Wait 1 min → SELECT count(*) FROM events via Cloud SQL shows the event
# Stop proxy → events still ingested to SQLite; restart proxy → sync resumes
uv run pytest tests/test_api.py tests/test_sync.py -q
```

### Rollback
Stop API container. SQLite buffer retains all events. Restart after fix, flush resumes.

---

## Phase 3: Scheduler and Claude History Scrapers

**Goal:** Automated collection from Claude Code's local files. Push + pull data collection.
**Dependencies:** Phase 2
**Estimated effort:** M

### Tasks

1. **Base scraper**
   - `src/stark_insights/scrapers/base.py` — abstract base class:
     - High-water mark load/save from SQLite
     - `async scrape() -> list[EventEnvelope]` abstract method
     - Error handling: log warning on parse failure, skip entry, continue
     - Advance high-water mark only after events committed to buffer
   - Files: `src/stark_insights/scrapers/base.py`

2. **Claude history scraper**
   - `src/stark_insights/scrapers/claude_history.py` — reads `/data/claude/history.jsonl`
   - Stream-read by byte offset (never load entire file)
   - Extracts: `prompt`, `skill_invocation` events
   - Session detection from `sessionId` field
   - Dedupe key: `claude:history.jsonl:{byte_offset}`
   - Files: `src/stark_insights/scrapers/claude_history.py`

3. **Run history scraper**
   - `src/stark_insights/scrapers/run_history.py` — reads `/data/claude/code-review/history/**/*.json`
   - Extracts: `review_finding`, `agent_dispatch` events
   - Files: `src/stark_insights/scrapers/run_history.py`

4. **Skill logs scraper**
   - `src/stark_insights/scrapers/skill_logs.py` — reads `/data/claude/code-review/logs/*.jsonl`
   - Extracts: `skill_invocation` events with duration, success, error
   - Files: `src/stark_insights/scrapers/skill_logs.py`

5. **Session metadata scraper**
   - `src/stark_insights/scrapers/session_metadata.py` — reads `/data/claude/sessions/*.json`
   - Creates/updates `sessions` table entries
   - Files: `src/stark_insights/scrapers/session_metadata.py`

6. **Scheduler**
   - `src/stark_insights/scheduler.py` — APScheduler 3.x:
     - Claude history: 15-min at :00
     - Run history: 15-min at :09
     - Skill logs: 15-min at :12
     - Session metadata: 15-min at :01
     - Buffer flush: 1-min
     - Partition maintenance: monthly (create next month's partition)
     - All jobs: `max_instances=1`
     - Overrun tracking via `stark_scrape_overruns_total` counter
   - Integrate into FastAPI `lifespan` (start on startup, shutdown on teardown)
   - Single uvicorn worker (explicit in Dockerfile CMD) — no multi-worker scheduler conflicts
   - Files: `src/stark_insights/scheduler.py`, `src/stark_insights/server.py`

7. **Tests**
   - `tests/test_scrapers.py` — each scraper with fixture files from real data (sanitized)
   - Verify: correct event extraction, high-water mark advancement, parse error resilience, idempotency (run twice, zero new events)
   - `tests/fixtures/` — sample history.jsonl entries, run history JSON, skill logs, session files
   - Files: `tests/test_scrapers.py`, `tests/fixtures/`

### Risks
- Claude history format changes between versions → pin to tested format, non-fatal parse errors
- Large files causing memory pressure → stream-read with byte offset, per-chunk high-water mark updates
- Docker file mount permissions → mount as `:ro`, test early

### Verification
```bash
docker compose up -d  # with ~/.claude mounted
# Wait 15 min → GET /status shows scraper last-run times
curl -s -X POST http://127.0.0.1:7420/query -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"sql":"SELECT type, count(*) FROM events GROUP BY type"}'
# Stop container → restart → scraper resumes from high-water mark, no duplicates
uv run pytest tests/test_scrapers.py -q
```

### Rollback
Disable scraper jobs in scheduler. Events already buffered are unaffected.

---

## Phase 4: Query API and MCP Server

**Goal:** Claude Code can natively query stark-insights via MCP tools. Safe, shared-state query access.
**Dependencies:** Phase 2 (query endpoint), Phase 3 (data to query)
**Estimated effort:** M

### Tasks

1. **Read-only query endpoint**
   - `POST /query` with `statement_timeout` (10s), row limit (10,000), `SET default_transaction_read_only = on`
   - Reject multi-statement requests
   - Falls back to SQLite when Cloud SQL unreachable (documented subset: no JSONB operators, no materialized views, basic aggregates only)
   - Files: `src/stark_insights/api/query.py`

2. **MCP SSE server**
   - Mount at `/mcp/sse` on existing FastAPI app
   - Shares DB connections, scheduler state, buffer with the HTTP API
   - Four tools: `stark_insights_log_event`, `stark_insights_query`, `stark_insights_status`, `stark_insights_summary`
   - `stark_insights_summary` uses predefined SQL templates only (no LLM generation): events last 24h/7d by type, top skills, top projects, active sessions
   - Files: `src/stark_insights/mcp_tools.py`, `src/stark_insights/server.py`

3. **Hook helper script**
   - `hooks/hook-emit.py` — stdlib Python only, no dependencies
   - Reads API token from `~/.stark-insights/api-token`, sends `Authorization: Bearer`
   - Fail-silent on any error (2s timeout)
   - Install to `~/.stark-insights/hook-emit.py`
   - Files: `hooks/hook-emit.py`

4. **Claude Code configuration**
   - Document `settings.json` additions: hooks (`post_tool_call`, `notification`) and MCP server (`url: http://localhost:7420/mcp/sse`)
   - Add to project's install script or document in CLAUDE.md
   - Files: `CLAUDE.md`

5. **Tests**
   - `tests/test_query.py` — read-only enforcement, timeout, row limits, SQLite fallback
   - `tests/test_mcp.py` — MCP tool invocations via test client
   - `tests/test_hooks.py` — hook-emit.py subprocess tests (success, timeout, server down)
   - Files: `tests/test_query.py`, `tests/test_mcp.py`, `tests/test_hooks.py`

### Risks
- MCP library SSE + FastAPI integration → verify mcp SDK version, test early
- SQLite fallback SQL subset → document what works and what doesn't, return clear error on unsupported queries
- `gh api /user` at startup is brittle → move GitHub alias resolution to onboarding, not runtime

### Verification
```bash
# Add to ~/.claude/settings.json, start Claude Code
# stark_insights_status → returns buffer stats
# stark_insights_query "SELECT count(*) FROM events" → returns count
# Run a tool → hook fires → tool_usage event in buffer within seconds
# Hook with container down → no user-visible error, scraper catches up later
uv run pytest tests/test_query.py tests/test_mcp.py tests/test_hooks.py -q
```

### Rollback
Remove MCP config from settings.json, remove hook entries. Container continues running for HTTP use.

---

## Phase 5: infra-sentinel Integration and Docker Hardening

**Goal:** The pipeline monitors itself. Alert rules in sentinel, structured logging to Loki, resource limits verified.
**Dependencies:** Phase 4
**Estimated effort:** S

### Tasks

1. **Structured logging**
   - Import `obs_logger` from infra-sentinel `/lib/python/` (fall back to local JSON formatter)
   - Replace all logging with structured JSON output
   - Files: `src/stark_insights/observability.py`

2. **Instrument all paths**
   - Add metric recording to: ingest (counter + histogram), sync (counter + histogram + error counter), scraper runs (counter + histogram + overrun), buffer stats (gauges), Cloud SQL connectivity (gauge), dedup counter, discard counter
   - Files: across all modules

3. **infra-sentinel alert rules**
   - PR to infra-sentinel: add `StarkInsightsSyncStalled`, `StarkInsightsBufferGrowing`, `StarkInsightsSyncErrors`
   - Add Prometheus scrape config targeting `127.0.0.1:7420/metrics` (or Docker network equivalent)
   - Files: infra-sentinel `configs/prometheus/alert-rules.yml`, `configs/prometheus/prometheus.yml`

4. **Grafana dashboard**
   - Dashboard JSON with six panels: Events Ingested, Sync Lag, Buffer Size, Cloud SQL Data Growth, Scraper Health, Query Latency
   - Files: `dashboards/stark-insights.json` (in this repo, imported to sentinel)

5. **Docker hardening**
   - Verify resource limits under synthetic load (10 concurrent ingests + scraper burst)
   - Confirm container restarts cleanly (scheduler resumes, buffer intact, high-water marks survive)
   - Files: `docker-compose.yml`

6. **User alias seeding**
   - Manual CSV import or `gh api /user`-based onboarding script for populating `user_aliases`
   - Document the fallback: unknown aliases stored as-is, flagged for manual resolution
   - Files: `scripts/seed_aliases.py`, CLAUDE.md

### Risks
- infra-sentinel PR is a separate repo → deliver as additive PR, doesn't block this repo
- Resource caps too tight for scrape bursts → verify with synthetic load before freezing

### Verification
```bash
curl -s http://127.0.0.1:7420/metrics | head -20  # Prometheus text format
# Ingest event → stark_events_ingested_total increments
# Docker logs → JSON structured lines
# Import dashboard → panels render
docker compose restart  # scheduler resumes, no data loss
uv run pytest -q  # all tests pass
```

### Rollback
Remove sentinel PR. Metrics endpoint is harmless if unused.

---

## Phase 6: Additional Scrapers and Materialized Aggregates

**Goal:** Codex, Gemini, GitHub, code metrics collection. Materialized views for fast aggregates.
**Dependencies:** Phase 3 (base scraper infra)
**Estimated effort:** L

### Tasks

1. **Codex history scraper**
   - `src/stark_insights/scrapers/codex_history.py` — reads `/data/codex/history.jsonl`
   - Verify actual format during implementation; resilient to missing/unparseable files
   - Gate behind fixture coverage before enabling in scheduler
   - Pin tested Codex CLI version in CLAUDE.md
   - Files: `src/stark_insights/scrapers/codex_history.py`

2. **Gemini history scraper**
   - `src/stark_insights/scrapers/gemini_history.py` — reads `/data/gemini/history/`
   - Per-session directory structure, full conversation parsing
   - Pin tested Gemini CLI version in CLAUDE.md
   - Files: `src/stark_insights/scrapers/gemini_history.py`

3. **GitHub scraper**
   - `src/stark_insights/scrapers/github.py` — GitHub API with:
     - Conditional requests (If-None-Match / ETags)
     - Rate limit backoff (pause when <100 remaining)
     - Per-page high-water mark updates (restart resumes from last page)
     - Collects: `pr_event`, `review_finding`, `ci_signal`
     - Repos from active projects in sessions table
   - Files: `src/stark_insights/scrapers/github.py`

4. **Code metrics scraper**
   - `src/stark_insights/scrapers/code_metrics.py` — `git log` in active repos
   - Extracts: `code_change` events (files changed, lines added/removed)
   - Files: `src/stark_insights/scrapers/code_metrics.py`

5. **Register new scrapers**
   - Codex: 15-min at :03, Gemini: 15-min at :06, GitHub: 30-min at :05, Code metrics: 30-min at :20
   - Files: `src/stark_insights/scheduler.py`

6. **Materialized aggregates**
   - Alembic migration: `skill_usage` and `agent_scorecards` materialized views with unique indexes
   - Scheduler job: `REFRESH MATERIALIZED VIEW CONCURRENTLY` every 15 min at :14
   - Expose via `stark_insights_summary` MCP tool
   - Files: `src/stark_insights/db/migrations/`, `src/stark_insights/scheduler.py`

7. **Session reconciliation**
   - `src/stark_insights/reconcile.py` — runs after each scrape cycle:
     - Match events where `session_id IS NULL` by `user_id + project + timestamp ∈ [started_at, ended_at]`
     - Per-CLI session keys: Claude sessionId, Codex UUID, Gemini directory name
     - Unmatched events remain with NULL session_id
   - Files: `src/stark_insights/reconcile.py`

8. **Tests**
   - Fixture files for Codex/Gemini formats (captured from real data before implementing parsers)
   - GitHub scraper with recorded HTTP responses
   - Materialized view refresh with concurrent read verification
   - Session reconciliation edge cases
   - Files: `tests/test_scrapers.py`, `tests/fixtures/`

### Risks
- Codex/Gemini formats undocumented → resilient parsers (log + skip), gated behind fixture coverage
- GitHub API rate limits → ETags + backoff + 30-min interval
- Materialized view refresh blocking → CONCURRENTLY requires unique index (verified)

### Verification
```bash
# Enable Codex/Gemini scrapers after fixtures pass
# GitHub scraper → pr_event and review_finding events appear
# SELECT * FROM skill_usage LIMIT 10 → aggregated data
# Scraper overrun counter stays at 0
uv run pytest tests/test_scrapers.py -q
```

### Rollback
Disable individual scrapers. Drop materialized views with no events table impact.

---

## Phase 7: Backfill, Retention, and Memory Scraper

**Goal:** Import all historical data, automate retention, complete the data collection story.
**Dependencies:** Phase 6
**Estimated effort:** M

### Tasks

1. **Backfill engine**
   - `src/stark_insights/backfill.py` — reuses scraper parsers but starts from byte 0
   - All events tagged `source: backfill`
   - Sources: Claude history (6,921+), run history (73+), skill logs, session metadata, Gemini history, GitHub API
   - `POST /backfill` endpoint + `docker exec` CLI
   - Per-source progress checkpoints (restart resumes, doesn't re-process)
   - Throttled batch size (1000) to avoid competing with live traffic
   - Files: `src/stark_insights/backfill.py`

2. **Retention automation**
   - Monthly scheduled job: `DROP` partitions older than 12 months
   - Dry-run log first, explicit month list before executing DDL
   - Synced-row cleanup: DELETE from SQLite buffer where synced > 7 days
   - Files: `src/stark_insights/scheduler.py`

3. **Memory scraper** (Phase 3 of design's MVP)
   - `src/stark_insights/scrapers/memory.py` — reads `/data/claude/projects/*/memory/`
   - Extracts: `memory_write` events from memory file metadata
   - 15-min interval at :07
   - Files: `src/stark_insights/scrapers/memory.py`

4. **Enhanced MCP summary**
   - `stark_insights_summary` includes: session-attributed metrics, cross-CLI activity, memory write frequency, backfill status
   - Files: `src/stark_insights/mcp_tools.py`

5. **Tests**
   - `tests/test_backfill.py` — full backfill with fixtures, idempotency (run twice, same count), checkpoint resume
   - `tests/test_retention.py` — partition drop logic, dry-run output
   - Files: `tests/test_backfill.py`, `tests/test_retention.py`

### Risks
- Backfill duration for large history → batched inserts, progress logging, interruptible
- Retention drops wrong partition → dry-run + explicit month list + Cloud SQL automated backups

### Verification
```bash
curl -X POST http://127.0.0.1:7420/backfill -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"sources":["claude_history"]}'
# SELECT count(*) FROM events WHERE source = 'backfill' → matches expected
# Run again → no new rows (idempotent)
uv run pytest tests/test_backfill.py -q
```

### Rollback
Stop backfill immediately. `DELETE FROM events WHERE source = 'backfill'` cleanly removes imported data. Retention mistakes recovered from Cloud SQL automated backups.

---

## 4. Integration Contracts

| Contract | Failure Mode | Detection |
|----------|-------------|-----------|
| **dedupe_key consistency** | Hooks, scrapers, backfill compute different keys for same event → double-counting | Unit tests per source type; integration test ingesting same event via hook + scraper |
| **scrub-before-sync** | Full prompt text leaks to Cloud SQL | Sync test asserts Cloud SQL payload is truncated |
| **session reconciliation fields** | Missing user_id/project/timestamp → unmatched events | Scraper tests verify all required fields populated |
| **query auth propagation** | Bearer token missing from hook/MCP → 401 errors | Hook tests send auth; MCP tests validate tool auth |
| **metric label alignment** | Inconsistent labels → sentinel dashboards break | Observability module defines labels once, all paths use same constants |

## 5. Testing Strategy

**Order:**
1. Phase 1 tests (models, buffer) before any API code
2. Phase 2 sync tests before enabling scrapers
3. Phase 3 scraper fixtures before scheduler wiring
4. Phase 4 query/MCP tests before exposing tools
5. Phase 6 CLI fixtures before enabling new scrapers
6. Phase 7 failure drills before declaring production readiness

**Layers:**
- **Unit:** Pydantic validation, dedupe_key computation, user normalization, scrubbing, eviction priority
- **Integration:** SQLite WAL behavior, Alembic migrations, Cloud SQL sync idempotency, scraper high-water marks, session reconciliation, materialized view refresh (via `testcontainers-python`)
- **E2E:** Full docker compose → ingest → sync → query → verify (post Phase 4)

## 6. Rollback Plan

| Phase | Rollback |
|-------|----------|
| **0** | Revert branch. No state. |
| **1** | `terraform destroy`. Delete buffer DB. |
| **2** | Stop container. Buffer retains events. Fix and restart. |
| **3** | Disable scraper jobs. Buffered events unaffected. |
| **4** | Remove MCP + hook config from settings.json. HTTP still works. |
| **5** | Revert sentinel PR. Metrics harmless if unused. |
| **6** | Disable individual scrapers. Drop materialized views. |
| **7** | `DELETE FROM events WHERE source = 'backfill'`. Session reconciliation sets nullable FK back to NULL. |

Each phase is independently removable — the SQLite write-ahead buffer is the only shared dependency and has no external side effects.
