# stark-agents — Implementation Plan

## 1. Overview

Build `stark-agents` in nine phases so each increment stays shippable. Phase ordering: lock the runtime layout, provision GCP infrastructure, create data stores, ship an authenticated MCP server skeleton with management tools, build the review engine (tool runner, context assembler, LLM dispatch, ensemble scorer), add knowledge sync, integrate with `/stark-review` and roll out DevOps, then roll out Accessibility, then the remaining four agents one at a time.

**Design resolutions (from open questions):**
- **Framework:** Python MCP SDK
- **Embedding model:** text-embedding-3-small (1536 dims) — switch only if retrieval quality is measurably poor
- **Drive scope:** Folder-level access with `.stark-ignore` exclusions
- **Remediation:** Disabled by default (`remediation_enabled = false`), enable per-repo after 80%+ finding precision over 50+ findings
- **Tool packaging:** Baked into container image, pinned versions
- **Finding format:** Extend existing `Finding` dataclass with optional `confidence`, `agreed_by`, `cross_validated_by` fields
- **Cloud SQL connectivity:** Cloud SQL Python connector (not Auth Proxy sidecar)
- **Cost agent:** Post-dispatch hook integrated into LLM Dispatch layer, not a file-pattern agent

**Critical path:** Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5 -> Phase 6 -> Phase 7 (DevOps production)

**Parallelization:** Phases 2+3 can partially overlap (Firestore setup doesn't depend on Cloud SQL). Agent prompt writing for all agents can happen in parallel with any phase.

---

## 2. Prerequisites

- GCP project with billing enabled
- GCP admin or Terraform roles for the target project
- GitHub App admin access (stark-claude, stark-codex, stark-gemini installation IDs and private keys)
- API keys: Anthropic, OpenAI, Google AI, ClickUp
- Google Drive service account with read access to DevOps docs folder
- Local tooling: `gcloud`, `terraform`, `python3.11+`, Docker, `gh`

### Bootstrap Commands

```bash
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com firestore.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com monitoring.googleapis.com \
  vpcaccess.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com logging.googleapis.com

python3.11 -m venv scripts/.venv
scripts/.venv/bin/pip install -U pip pytest alembic sqlalchemy pgvector \
  "psycopg[binary]" google-cloud-firestore google-cloud-secret-manager \
  google-cloud-logging google-cloud-monitoring google-cloud-sql-connector \
  anthropic openai google-genai tiktoken pydantic pyyaml mcp

terraform -chdir=infra/gcp/stark_agents init
```

---

## Phase 1: Lock Runtime Layout

**Goal:** Remove design ambiguities that would invalidate later phases. Create skeleton directories.
**Dependencies:** None
**Effort:** S (1-2 days)

### Tasks

1. **Create ADR and skeleton directories**
   - Files: `docs/adr/NNNN-stark-agents-runtime.md`, `stark_agents/`, `agents/devops/`, `infra/gcp/stark_agents/`
   - Resolve: Cloud SQL connector choice, egress strategy for tool network, embedding model, Accessibility browser runner (Playwright + axe-core)
   - Done: Every open design gap that affects infrastructure or API contracts is decided

2. **Freeze MCP and integration contracts**
   - Files: `stark_agents/contracts.py` (Pydantic models for request/response envelope)
   - Freeze: standard response envelope, tool names (`devops_review`, `agents_list`, etc.), activation input/output schema
   - Done: Server and client teams can implement in parallel

3. **Create agent YAML schema validator**
   - Files: `stark_agents/schema.py`, `tests/test_schema.py`
   - JSON Schema for `agent.yaml` validation at startup
   - Done: Invalid YAML fails validation with clear error messages

### Verification
```bash
rg -n "stark-agents-runtime|Cloud SQL|egress|embedding model" docs/adr
pytest tests/test_schema.py -q
```

### Rollback
No infrastructure created — delete skeleton directories.

---

## Phase 2: Provision GCP Foundation

**Goal:** Stand up Cloud Run, Cloud SQL, Firestore, Secret Manager, IAM, networking, CI/CD.
**Dependencies:** Phase 1
**Effort:** L (3-5 days)

### Tasks

1. **Provision infrastructure with Terraform**
   - Files: `infra/gcp/stark_agents/{providers,apis,artifact_registry,iam,network,cloud_run,cloud_sql,firestore,secret_manager,scheduler,monitoring}.tf`
   - Create: service accounts (with least-privilege per-secret bindings), Artifact Registry, Cloud Run service, VPC connector, Cloud SQL (db-f1-micro, pgvector extension, daily backups + PITR), Firestore (Native mode), Secret Manager secrets, Cloud Scheduler jobs (paused), alert policies
   - IAM: explicit `roles/run.invoker` for Claude Code operator identities
   - Done: `terraform apply` completes, all resources exist

2. **Wire CI/CD pipeline**
   - Files: `cloudbuild.stark-agents.yaml`, `infra/gcp/stark_agents/cloudbuild_trigger.tf`
   - Build image, push to Artifact Registry, deploy Cloud Run revision, retain prior revision for rollback
   - Done: Merge to `main` produces a new revision without manual steps

### Verification
```bash
terraform -chdir=infra/gcp/stark_agents validate
terraform -chdir=infra/gcp/stark_agents plan
gcloud run services describe stark-agents --region "$REGION" --format='value(status.url)'
gcloud sql instances describe stark-agents --format='value(settings.backupConfiguration.enabled)'
```

### Rollback
```bash
terraform -chdir=infra/gcp/stark_agents destroy
```

---

## Phase 3: Create Persistent Stores

**Goal:** Make Cloud SQL and Firestore data plane real, versioned, and maintainable.
**Dependencies:** Phase 2
**Effort:** M (2-3 days)

### Tasks

1. **Implement schema migrations with Alembic**
   - Files: `alembic.ini`, `alembic/env.py`, `alembic/versions/0001_create_knowledge_tables.py`
   - Create: `knowledge_chunks` table (shared, with `agent_namespace` column), partial indexes per namespace, `embeddings_meta` table
   - Alembic is the only schema writer — no manual SQL
   - Done: `alembic upgrade head` runs idempotently, `alembic downgrade -1` works

2. **Implement Firestore repositories**
   - Files: `stark_agents/storage/firestore.py`, `tests/test_firestore.py`
   - Collections: `findings` (with optimistic locking via `version` field), `cost_tracking`, `agent_configs`, `sync_locks`, `clickup_snapshots`
   - Seed `agent_configs` for all six agents with `enabled: false`
   - Done: CRUD operations pass against Firestore emulator

3. **Implement Postgres knowledge repository**
   - Files: `stark_agents/storage/postgres.py`, `tests/test_postgres.py`
   - SQLAlchemy with `pool_size=5, max_overflow=5, pool_recycle=1800`
   - Cloud SQL Python connector for auth (no Auth Proxy sidecar)
   - pgvector similarity search with configurable similarity threshold and limit
   - Done: Insert embeddings, query by similarity, verify namespace isolation

### Verification
```bash
alembic upgrade head
pytest tests/test_firestore.py tests/test_postgres.py -q
```

### Rollback
```bash
alembic downgrade base
# Firestore collections are created lazily — no cleanup needed
```

---

## Phase 4: Ship MCP Server Skeleton

**Goal:** Deploy an authenticated server with health/readiness and management tools only.
**Dependencies:** Phase 3
**Effort:** M (2-3 days)

### Tasks

1. **Build server shell with auth and health**
   - Files: `stark_agents/app.py`, `stark_agents/config.py`, `stark_agents/mcp_server.py`, `Dockerfile.stark-agents`
   - Initialize: config loading, Secret Manager cache (1hr TTL with in-memory fallback), structured JSON logging, `/healthz`, `/readyz` (503 only on Secret Manager failure), SSE `/mcp` endpoint
   - Done: Cloud Run serves health endpoints, starts cleanly from cold

2. **Implement agent loader and management tools**
   - Files: `stark_agents/agent_loader.py`, `stark_agents/mcp_tools/management.py`
   - Load `agents/*/agent.yaml`, validate schema, build in-memory registry
   - Tools: `agents_list`, `agents_activate` (match files against patterns), `agents_status`, `agents_enable`
   - Invalid agents disabled with error surfaced via `agents_status`, don't block healthy agents
   - Tool version metadata in MCP listing
   - Done: `agents_activate` with Terraform files returns `["devops"]`

3. **Create DevOps agent definition**
   - Files: `agents/devops/agent.yaml`, `agents/devops/knowledge/{domain,standards}.md`, `agents/devops/prompts/{claude,codex,gemini}/review.md`, `agents/devops/tools/{terraform-validate,tflint,checkov}.yaml`
   - Done: Agent loader parses DevOps config, file patterns match correctly

### Verification
```bash
pytest tests/test_agent_loader.py tests/test_mcp_server.py -q
ID_TOKEN="$(gcloud auth print-identity-token)"
curl -fsS -H "Authorization: Bearer ${ID_TOKEN}" "${MCP_URL}/healthz"
curl -fsS -H "Authorization: Bearer ${ID_TOKEN}" "${MCP_URL}/readyz"
```

### Rollback
Revert to prior Cloud Run revision: `gcloud run services update-traffic stark-agents --to-revisions=PREVIOUS=100`

---

## Phase 5: Build Review Engine

**Goal:** Implement the core review pipeline: workspace, tool runner, context assembler, LLM dispatch, ensemble scorer.
**Dependencies:** Phase 4
**Effort:** L (5-7 days)

### Tasks

1. **Request-scoped repo workspace**
   - Files: `stark_agents/workspace.py`, `tests/test_workspace.py`
   - Shallow clone PR head ref via GitHub App installation token (private repos)
   - Cleanup after review completes (always, even on error)
   - Done: Clone a private test repo, verify files exist, verify cleanup

2. **Tool runner**
   - Files: `stark_agents/tool_runner.py`, `tests/test_tool_runner.py`
   - Parse tool YAML, execute commands as non-root, enforce timeouts, collect structured JSON output
   - Only `${repo_root}` variable expanded, reject other `${}` patterns
   - Stderr sanitization (regex strip API keys, tokens, connection strings)
   - `required: false` tools that fail don't block review; `required: true` failures fail the review
   - Done: Run terraform validate + tflint against test fixtures, verify JSON output

3. **Context assembler with token budgeting**
   - Files: `stark_agents/context_assembler.py`, `tests/test_context_assembler.py`
   - Assembly order: preamble -> knowledge chunks -> tool results -> diff -> instructions
   - Token counting via `tiktoken` (cl100k_base)
   - Overflow truncation priority: knowledge (10->5->3->0) -> tool results (summarize) -> diff (filter to agent patterns) -> preamble (never)
   - Per-model context limits configured in provider adapter
   - Done: Prompt stays within budget for oversized diffs, preamble always present

4. **LLM provider adapters with circuit breakers**
   - Files: `stark_agents/providers/{base,anthropic,openai,google}.py`, `tests/test_providers.py`
   - `LLMProvider` protocol: `generate()`, `check_health()`, `model_id`, `cost_per_1k_input/output`
   - Per-provider circuit breaker: 3 failures in 5min -> open 2min -> half-open retry
   - Cost tracking middleware: record `tokens_in`, `tokens_out`, `cost_usd` per call to Firestore
   - Done: Mock tests for all 3 providers + one real-provider smoke test with cheap prompt

5. **Ensemble scorer**
   - Files: `stark_agents/scoring.py`, `tests/test_scoring.py`
   - Three modes: ensemble (3 LLMs, semantic dedup, 3/3=HIGH 2/3=MEDIUM 1/3=LOW), verify (2 LLMs), single (1 LLM + tools)
   - Severity adjustment based on consensus
   - Graceful degradation: 1 LLM fails -> cap confidence at MEDIUM, 2 fail -> advisory-only, all fail -> 502
   - Done: Unit tests for all agreement scenarios from design Section 7

6. **Wire `devops_review` MCP tool**
   - Files: `stark_agents/mcp_tools/review.py`, `tests/test_devops_review.py`
   - Orchestrate: activate -> workspace -> tools -> context -> dispatch -> score -> envelope
   - Return standard response envelope with `data`, `warnings`, `error`, `request_id`, `duration_ms`
   - Done: End-to-end test against a Terraform fixture PR

### Verification
```bash
pytest tests/test_workspace.py tests/test_tool_runner.py tests/test_context_assembler.py \
       tests/test_providers.py tests/test_scoring.py tests/test_devops_review.py -q
```

### Rollback
No production impact — server still only exposes management tools until Phase 7 enables integration.

---

## Phase 6: Add Knowledge Sync

**Goal:** Turn DevOps from tool-only review into RAG-backed review with safe refresh behavior.
**Dependencies:** Phase 5
**Effort:** L (3-5 days)

### Tasks

1. **Knowledge sync pipeline**
   - Files: `stark_agents/knowledge/{chunker,sync}.py`, `stark_agents/knowledge/sources/{google_drive,clickup}.py`
   - Fetch Drive/ClickUp content, chunk by heading/paragraph, embed with text-embedding-3-small (OpenAI API)
   - Upsert by `(agent_namespace, source, chunk_index)`, update `embeddings_meta`
   - Deletion detection: compare source checksums, tombstone missing docs, hard-delete after 7 days
   - Done: Manual DevOps sync updates `embeddings_meta` with correct counts

2. **Staleness checker with distributed lock**
   - Files: `stark_agents/knowledge/staleness.py`, `tests/test_staleness.py`
   - Check `embeddings_meta.last_refresh` before each agent run
   - Firestore distributed lock (`sync_locks/{namespace}` with TTL)
   - First instance acquires lock and refreshes, others poll (max 30s wait)
   - Circuit breaker: 3 consecutive failures -> skip inline refresh for 1 hour, use stale data + warning
   - Done: Concurrent requests don't stampede, circuit breaker activates correctly

3. **Enable scheduled sync for DevOps**
   - Files: `infra/gcp/stark_agents/scheduler.tf`
   - Schedule DevOps sync every 4 hours, other agents' sync jobs created but paused
   - Done: Cloud Scheduler history shows successful authenticated invocations

### Verification
```bash
pytest tests/test_sync.py tests/test_staleness.py -q
python scripts/stark_agents_sync.py --agent devops --once
```

### Rollback
Disable scheduler jobs, drop knowledge data: `DELETE FROM knowledge_chunks WHERE agent_namespace = 'devops'`

---

## Phase 7: Integrate with `/stark-review` and Roll Out DevOps

**Goal:** Add agent reviews to the existing flow. Ship DevOps to production.
**Dependencies:** Phase 6
**Effort:** M (3-4 days)

### Tasks

1. **MCP client in multi_review.py**
   - Files: `scripts/multi_review.py`, `scripts/stark_agents_client.py`
   - After standard 6-domain review: collect changed files, call `agents_activate`, invoke matched agent review tools
   - Append `## Agent Reviews` section to PR comment (separate from standard domains)
   - Fail-open: if MCP server unreachable, skip agent section with warning, standard review unaffected
   - Done: Terraform PR yields both standard review and DevOps agent section

2. **GitHub posting and Firestore writes**
   - Files: `stark_agents/github.py`, `stark_agents/findings.py`
   - Post agent findings under correct bot identity (stark-claude/codex/gemini)
   - Write high-confidence findings to Firestore `findings` (status: pending, for v1 metrics only — remediation disabled)
   - Write `cost_tracking` on every run
   - Done: One DevOps review produces PR comment + Firestore finding doc + cost doc

3. **DevOps canary rollout**
   - Set `agent_configs/devops.enabled = true` in Firestore
   - Cap Cloud Run max instances
   - Run one full sync cycle, monitor: p95 latency < 120s, error rate < 5%, weekly cost < $50
   - Done: Stable for one full sync cycle (4 hours)

### Verification
```bash
pytest tests/test_multi_review.py -q
python scripts/multi_review.py --pr $TEST_PR --repo GetEvinced/infra-pulse --dry-run
```

### Rollback
Set `agent_configs/devops.enabled = false` in Firestore. `/stark-review` immediately stops calling DevOps agent.

---

## Phase 8: Roll Out Accessibility

**Goal:** Prove two agents coexist safely. Validate multi-agent dispatch.
**Dependencies:** Phase 7
**Effort:** M (3-4 days)

### Tasks

1. **Accessibility agent definition and tools**
   - Files: `agents/accessibility/agent.yaml`, `agents/accessibility/prompts/{claude,codex,gemini}/review.md`, `agents/accessibility/tools/axe-core.yaml`
   - Browser runner: Playwright + axe-core baked into container image
   - Knowledge: WCAG 2.1 AA specs, Evinced internal standards embedded in pgvector
   - Done: `a11y_review` returns findings with ensemble consensus

2. **Multi-agent isolation testing**
   - Test: PR touching `.tf` and `.tsx` activates both DevOps and Accessibility
   - Test: Each agent gets separate workspace, separate prompt, separate finding section
   - Test: Disabling one agent doesn't affect the other
   - Test: Per-agent cost attribution is accurate
   - Done: Both agents run, post separate sections, no interference

3. **Accessibility canary rollout**
   - Enable `agent_configs/accessibility.enabled = true`
   - Enable accessibility sync schedule
   - Monitor for one full sync cycle
   - Done: Stable alongside DevOps for one cycle

### Verification
```bash
pytest tests/test_multi_agent.py -q
```

### Rollback
Set `agent_configs/accessibility.enabled = false`.

---

## Phase 9: Roll Out Remaining Agents

**Goal:** Ship Dependency, Cost, Docs, APICompat. Harden operations.
**Dependencies:** Phase 8
**Effort:** M (4-6 days)

### Tasks

1. **Enable agents one at a time** (order: Dependency -> Docs -> APICompat -> Cost)
   - Each agent: create `agents/{name}/` directory, write prompts, implement tools if any, create sync schedule
   - Each agent must pass one full sync cycle with stable metrics before enabling the next
   - Cost agent is last — it's a post-dispatch hook, not a file-pattern agent, needs all others running to have data

2. **Operational hardening**
   - Finalize Cloud Monitoring dashboards
   - Weekly budget alerting (configurable threshold, default $50/week)
   - Retention cleanup automation (tombstone purge, findings TTL, cost_tracking TTL)
   - Incident runbooks in `docs/observability/stark-agents.md`
   - Emergency disable procedure: `agents_enable` MCP tool or direct Firestore update
   - Done: On-call can disable any agent within minutes, scheduled jobs prove retention controls work

### Verification
```bash
pytest tests/test_dependency.py tests/test_docs.py tests/test_apicompat.py -q
```

### Rollback
Per-agent kill switches via Firestore `agent_configs`.

---

## Integration Points

| Component | Depends On | Failure Mode |
|-----------|-----------|--------------|
| `multi_review.py` (client) | MCP server URL, IAM token | Fail-open: skip agent section, standard review unaffected |
| `agent.yaml` schema | `stark_agents/schema.py` | Invalid config disables that agent, others unaffected |
| `knowledge_chunks` table | Alembic migrations, Cloud SQL | Reviews proceed without knowledge (degraded) |
| `embeddings_meta` | Embedding model version | Changing model without re-embed breaks retrieval |
| GitHub posting | Secret Manager (GitHub App keys) | Findings computed but not posted; logged for retry |
| Firestore `agent_configs` | Firestore availability | Default to last in-memory state if unavailable |
| Cost tracking | LLM provider response metadata | Inaccurate if provider doesn't return usage |

## Testing Strategy

### Unit Tests
- YAML schema validation (valid/invalid configs)
- File pattern activation (nested globs: `helm/**/values.yaml`, `**/api/**`)
- Prompt budget truncation (each tier independently)
- Circuit breaker state transitions
- Ensemble scoring (3/3, 2/3, 1/3, 0/3 agreement)
- Tool command sanitization
- Firestore optimistic locking

### Integration Tests
- Alembic migrations against real Postgres + pgvector (Testcontainers)
- Firestore CRUD against emulator
- Workspace clone lifecycle (create, use, cleanup)
- Real tool execution against Terraform fixtures
- One real-provider LLM call per provider (cheap prompt, verify parsing)

### E2E Tests
- Full DevOps review against a test PR
- Multi-agent activation (Terraform + React PR)
- Degraded mode (Cloud SQL down -> review without knowledge)
- Staleness recovery (stale embeddings -> inline refresh)
- All 10 key scenarios from design Section 7

### Rollout Gates
Each phase must pass before the next begins:
- Phase 7 (DevOps): p95 latency < 120s, error rate < 5%, weekly cost < $50
- Phase 8 (Accessibility): above thresholds maintained, no DevOps regression
- Phase 9 (each agent): above thresholds maintained, per-agent cost within budget
