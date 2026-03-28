# stark-agents — Design Document

## 1. Overview

stark-agents adds domain-expert AI agents to the stark-skills review pipeline. Where the current system runs 3 LLMs x 6 generic domains (architecture, accessibility, correctness, type-safety, security, test-coverage), agents bring specialized knowledge, external tool output, and vector-backed domain expertise. Six agents ship in staged rollout: DevOps, Accessibility, Dependency, Cost, Docs, and APICompat.

The system deploys as a single MCP server on GCP Cloud Run, backed by Cloud SQL + pgvector for knowledge retrieval and Firestore for operational state. Agents activate automatically during `/stark-review` when PR file patterns match, or explicitly via `/stark-agent <name> "task"`. The existing 6-domain review pipeline runs unchanged — agents are additive.

### Key Architectural Decisions

| Decision | Rationale |
|----------|-----------|
| Single MCP server (not per-agent) | One deployment, one health check, simpler ops. Blast radius is acceptable — agents are stateless and isolated by request. |
| Orchestrator-driven tools (not LLM-driven) | Deterministic execution, structured output, debuggable. LLMs analyze tool results, they don't invoke tools. |
| Direct LLM API calls (not CLI wrappers) | Cloud-native, no version drift, works from Cloud Run. Trade-off: loses Claude Code session features — acceptable for stateless reviews. |
| GCP-first, Docker Compose later | Focus on the primary deployment target. Docker is a packaging task, not an architecture decision. |
| Staged rollout (DevOps -> A11y -> rest) | Validate the full pipeline end-to-end before expanding scope. |

### Scope

**In (v1):** Agent abstraction, MCP server, knowledge sync pipeline, tool execution, ensemble/verify/single review modes, Cloud Run deployment, finding merge into existing review flow, review capability only.

**Deferred to v2:** Generate and validate capabilities (design them now, enable after review quality is proven), automated remediation loop (behind config flag, default off), Docker Compose local deployment, Config Provider abstraction (hardcode GCP in v1, abstract when Docker milestone arrives), custom agent authoring SDK, UI for agent management.

**Out:** Per-repo agent definitions (agents live in stark-skills repo only for now).

### Architectural Patterns

| Pattern | Application |
|---------|-------------|
| **Hexagonal Architecture (Ports and Adapters)** | Core agent logic is isolated from the environment via a Config Provider that abstracts Cloud SQL vs local Postgres, Secret Manager vs env vars, Firestore vs Postgres tables. |
| **Orchestrator Pattern** | The MCP server manages tool execution and context assembly prior to LLM invocation — deterministic, not agentic multi-turn loops. |
| **Scatter-Gather** | Parallel dispatch to multiple LLM providers followed by semantic deduplication and consensus scoring (Ensemble mode). |
| **RAG (Retrieval-Augmented Generation)** | Semantic search over external documentation and runbooks via pgvector, injected into prompts at assembly time. |

### Agent Registry

| Agent | Review Mode | Capabilities | File Patterns | Tools | Phase |
|-------|-------------|-------------|---------------|-------|-------|
| DevOps | ensemble (3x) | review, generate, validate | `*.tf`, `*.tfvars`, `Dockerfile`, `docker-compose.*`, `.github/workflows/*`, `helm/**`, `k8s/**` | terraform validate, tflint, checkov | 1 |
| Accessibility | ensemble (3x) | review, validate | `*.tsx`, `*.jsx`, `*.vue`, `*.html`, `*.css`, `*.scss` | axe-core | 2 |
| Dependency | single + tools (1x) | review, validate | `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `requirements*.txt`, `*.lock` | npm audit, pip audit, license scanner | 3 |
| Cost | N/A (not an LLM agent) | telemetry | Always-on post-processing hook — intercepts LLM dispatch responses to record token usage, cost, and budget status. Not activated via file patterns. | — | 3 |
| Docs | verify (2x) | review | `*.md`, `docs/**`, `CLAUDE.md`, `docs/adr/**` | — | 3 |
| APICompat | verify (2x) | review, validate | `**/api/**`, `**/routes/**`, `**/handlers/**`, `openapi.*`, `swagger.*`, `*.proto` | — | 3 |

### Staged Rollout

- **Phase 1 (DevOps):** Validate the full agent pipeline end-to-end — activation, context assembly, tool execution, ensemble scoring, finding merge, GitHub posting, remediation queue.
- **Phase 2 (Accessibility):** Validate multi-agent dispatch — two agents activating on the same PR, separate finding sections, no interference.
- **Phase 3 (remaining four):** Enable one at a time with per-agent kill switches in Firestore `agent_configs`. Each new agent must run for one full sync cycle with stable queue depth, latency, and cost before the next is enabled.

---

## 2. Architecture

### Component Responsibilities

**Agent Loader** — Reads `agents/*/agent.yaml` at startup, validates schema, registers tool definitions and file patterns. Maintains an in-memory registry of active agents. Exposes agent metadata via `agents_list` and `agents_status` MCP tools. Invalid agents are marked `disabled` and surfaced through `agents_status`; they do not block healthy agents.

**MCP Protocol Handler** — Implements the MCP server protocol (tool listing, tool invocation, resource listing). Maps incoming tool calls (`devops_review`, `a11y_validate`, etc.) to the appropriate agent + capability. Handles request lifecycle, error wrapping, and response formatting.

**Context Assembler** — Composes the LLM prompt from multiple sources in fixed order: agent preamble -> knowledge chunks (selected via pgvector similarity to the diff, within 4K token budget) -> tool execution results (JSON) -> PR diff -> review instructions. This is the critical path — prompt quality determines review quality.

**Prompt budget overflow strategy:** When the assembled prompt exceeds the model's context window, components are truncated in this priority order (lowest priority cut first):
1. Knowledge chunks — reduce from 10 to 5, then to 3, then drop entirely
2. Tool results — summarize verbose JSON output to key findings only
3. PR diff — truncate to changed files most relevant to the agent's file patterns
4. Agent preamble — never truncated (required for correct behavior)

Token counting uses `tiktoken` (cl100k_base) for budget estimation. Each model's context limit is configured in the LLM provider adapter.

**LLM Dispatch** — Sends assembled prompts to Claude (Anthropic SDK), Codex (OpenAI SDK), and Gemini (Google AI SDK) via direct API calls. Handles retries, timeouts, and rate limiting. Returns raw LLM output for parsing. All providers implement a common interface:

```python
class LLMProvider(Protocol):
    async def generate(self, prompt: str, system: str, max_tokens: int) -> LLMResponse: ...
    async def check_health(self) -> bool: ...
    @property
    def model_id(self) -> str: ...
    @property
    def cost_per_1k_input(self) -> float: ...
    @property
    def cost_per_1k_output(self) -> float: ...
```

LLM calls use a circuit breaker pattern: if a provider fails 3 consecutive requests within 5 minutes, the circuit opens and that provider is skipped for 2 minutes before retrying. This prevents wasting time and tokens on a provider that's down. Each provider has its own circuit breaker. When a circuit is open, ensemble mode degrades to 2-model or 1-model consensus with appropriately reduced confidence.

**Ensemble Scorer** — Implements three review modes: ensemble (3 LLMs, consensus scoring), verify (2 LLMs, cross-check), single (1 LLM + tool validation). Deduplicates findings by semantic similarity, assigns confidence levels (HIGH/MEDIUM/LOW based on agreement), adjusts severity. Implements a strategy interface so future agents can define custom resolution logic.

**Tool Runner** — Executes agent tools as a pre-step before LLM dispatch. Runs commands (terraform validate, axe-core, npm audit, etc.) in the Cloud Run container with restricted permissions. Collects structured JSON output. Non-required tools that fail don't block the review. Tools are constrained by an allow-list derived from YAML definitions checked into the repo — no shell interpolation beyond approved variables like `${repo_root}`.

**Knowledge Sync** — Scheduled pipeline (Cloud Scheduler -> Cloud Run endpoint) that pulls documents from external sources (Google Drive, ClickUp), chunks them, generates embeddings (via LLM API), and upserts to pgvector. Maintains `embeddings_meta` table with last_refresh timestamps.

**Staleness Checker** — Before each agent run, checks `embeddings_meta.last_refresh` for the agent's namespace. If older than 2x the scheduled sync interval, triggers an inline refresh. Uses a singleflight pattern (mutex per namespace) so concurrent requests don't stampede — the first request triggers the refresh, others wait on the same result. The refresh has a 30s timeout with circuit breaker: if 3 consecutive refreshes fail, skip inline refresh for 1 hour and rely on stale data with a warning. Prevents stale knowledge from degrading review quality while avoiding thundering herd.

**Config Provider** — Abstracts Cloud SQL vs local Postgres, Secret Manager vs env vars, and Firestore vs Postgres-backed operational storage. Agent code calls `config.get_secret()`, `config.query_knowledge()`, `config.write_finding()` without knowing the backend.

### Data Flow

1. **Review trigger**: `/stark-review` calls `multi_review.py`, which fetches the PR diff and changed file list.
2. **Agent matching**: Changed files are matched against `file_patterns` from all `agent.yaml` configs. Matched agents are activated.
3. **Context assembly**: For each activated agent x LLM: load knowledge chunks (pgvector query with diff as input), run tools, compose prompt.
4. **LLM dispatch**: Assembled prompts sent to configured LLMs in parallel (ThreadPoolExecutor, reusing existing patterns from `multi_review.py`).
5. **Scoring**: Raw outputs parsed into findings. Ensemble scorer applies review mode logic (3-way consensus, 2-way verify, or single+tool).
6. **Posting**: Agent findings formatted as a separate labeled section in the PR review comment, posted via the appropriate GitHub App bot.
7. **Remediation queue**: High-confidence actionable findings written to Firestore (status: pending) for optional automated fix loop.

### Extension Points

- **New agent:** Drop a directory into `agents/` with a valid `agent.yaml`. The Agent Loader discovers it at startup, registers its tools and patterns. No code changes needed.
- **Storage adapters:** The Config Provider pattern allows swapping backends (Cloud SQL -> local Postgres, Secret Manager -> env vars, Firestore -> Postgres tables) without modifying agent logic. This enables the Docker Compose milestone.
- **Scoring strategies:** The Ensemble Scorer implements a strategy interface. Future agents can define custom resolution logic (e.g., weighted voting, domain-specific dedup thresholds) beyond the default 2/3 or 3/3 agreement rules.
- **Tool registry:** Tools are declarative YAML. Adding a new tool to an agent requires only a YAML file — the Tool Runner handles execution, parsing, and timeout enforcement.

### Finding Merge Strategy

Agent findings and standard 6-domain findings (from `multi_review.py`) appear in **separate labeled sections** in the PR review comment:

```
## Standard Review
### Architecture
- [high] ...
### Security
- [medium] ...

## Agent Reviews
### DevOps Agent (ensemble, 3/3 consensus)
- [high, HIGH confidence] Security group allows 0.0.0.0/0 ingress
### Accessibility Agent (ensemble, 2/3 consensus)
- [medium, MEDIUM confidence] Missing aria-label on interactive element
```

**No deduplication** across agents and domains. If the Security domain and the DevOps agent both flag the same issue, both findings appear. The duplicate is flagged as `cross_validated_by: ["security-domain"]` in the finding metadata — a positive signal that increases confidence.

**Rationale:** Deduplication requires semantic similarity thresholds that are hard to tune and may suppress valid distinct findings. Separate sections with cross-validation flags are transparent, debuggable, and let the user see exactly what each reviewer found.

### External Dependencies

| Dependency | Purpose | Failure Mode |
|------------|---------|--------------|
| Cloud SQL + pgvector | Knowledge retrieval | Agent runs without knowledge context (degraded, not blocked) |
| Firestore | Operational state, findings queue | Review succeeds, remediation queue unavailable |
| Secret Manager | API keys, GitHub App keys | Fatal — cannot authenticate to LLMs or GitHub |
| Google Drive API | Knowledge sync source | Sync skipped, existing embeddings used |
| ClickUp API | Task snapshots for context | Sync skipped, existing snapshots used |
| Anthropic API | Claude LLM dispatch | Claude findings missing, other LLMs continue |
| OpenAI API | Codex LLM dispatch | Codex findings missing, other LLMs continue |
| Google AI API | Gemini LLM dispatch | Gemini findings missing, other LLMs continue |

---

## 3. Data Model

### Agent Configuration (`agent.yaml`)

```yaml
# agents/devops/agent.yaml
name: devops
display_name: "DevOps Agent"
description: "IaC, CI/CD, Terraform, Docker, Helm, Kubernetes specialist"

file_patterns:
  - "*.tf"
  - "*.tfvars"
  - "Dockerfile"
  - "docker-compose.*"
  - ".github/workflows/*"
  - "helm/**"
  - "k8s/**"

review_mode: ensemble        # ensemble | verify | single

capabilities:
  - review
  - generate
  - validate

tools:
  - name: terraform-validate
    command: "terraform validate -json"
    working_dir: "${repo_root}"
    parser: json
    timeout: 30s
    required: false

  - name: tflint
    command: "tflint --format=json"
    working_dir: "${repo_root}"
    parser: json
    timeout: 30s
    required: false

  - name: checkov
    command: "checkov -d . --output json --quiet"
    working_dir: "${repo_root}"
    parser: json
    timeout: 60s
    required: false

connections:
  pgvector:
    namespace: devops-runbooks
  google_drive:
    folder_id: "1abc..."       # DevOps docs folder
  clickup:
    project_id: "12345"        # DevOps project

sync:
  schedule: "every 4h"
  staleness_threshold: "8h"    # 2x schedule — triggers inline refresh
  sources:
    - type: google_drive
      folder_id: "1abc..."
    - type: clickup
      project_id: "12345"
```

### Agent Directory Structure

```
agents/
  devops/
    agent.yaml                  # Identity, patterns, connections, review_mode
    knowledge/
      domain.md                 # IaC expertise, cloud conventions
      standards.md              # Org-specific infra standards
    prompts/
      claude/
        review.md               # Claude-tuned IaC review prompt
        generate.md             # Claude-tuned IaC generation
      codex/
        review.md
        generate.md
      gemini/
        review.md
        generate.md
    tools/
      terraform-validate.yaml
      tflint.yaml
      checkov.yaml
```

### Cloud SQL Schema (pgvector)

A single shared table with a namespace column — no DDL needed when adding new agents.

```sql
CREATE TABLE knowledge_chunks (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_namespace TEXT NOT NULL,          -- "devops", "accessibility", etc.
    source          TEXT NOT NULL,          -- "google_drive:doc_id" or "clickup:task_id"
    source_checksum TEXT NOT NULL,          -- SHA-256 of source doc for deletion detection
    chunk_index     INTEGER NOT NULL,       -- Position within source document
    content         TEXT NOT NULL,          -- Raw markdown chunk
    embedding       vector(1536) NOT NULL,  -- Configurable: matches embedding model dimension
    metadata        JSONB DEFAULT '{}',     -- source_title, last_modified, tags
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(agent_namespace, source, chunk_index)
);

-- Partial indexes per namespace for efficient filtered similarity search
CREATE INDEX idx_knowledge_devops_embedding
    ON knowledge_chunks USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 20)
    WHERE agent_namespace = 'devops';

-- Embeddings freshness tracking
CREATE TABLE embeddings_meta (
    namespace       TEXT PRIMARY KEY,       -- "devops", "accessibility", etc.
    embedding_model TEXT NOT NULL,          -- "text-embedding-3-small" — tracks which model produced the vectors
    embedding_dim   INTEGER NOT NULL,      -- 1536 — allows model changes without schema changes
    last_refresh    TIMESTAMPTZ NOT NULL,
    doc_count       INTEGER DEFAULT 0,
    chunk_count     INTEGER DEFAULT 0,
    error           TEXT,                   -- Last sync error, if any
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Schema migrations managed via alembic (versioned, idempotent, run at container startup)
-- Cloud SQL automated daily backups with 7-day retention
-- Point-in-time recovery enabled (binary logging)
```

**Why single table with namespace:** Adding a new agent requires zero DDL — just insert rows with a new `agent_namespace`. Partial indexes per namespace give the same query performance as separate tables while keeping the schema simple. The `embedding_model` and `embedding_dim` fields in `embeddings_meta` track which model produced the vectors, so changing embedding models is a metadata update + re-embed, not a schema change.

**Deletion detection:** The `source_checksum` field tracks the hash of the source document. During sync, if a source document is no longer present in Drive/ClickUp, its chunks are tombstoned (metadata `{"deleted": true, "deleted_at": timestamp}`) and hard-deleted after 7 days.

### Firestore Collections

```
findings/
  {finding_id}/
    agent: "devops"
    pr_number: 42
    repo: "GetEvinced/infra-pulse"
    severity: "high"
    confidence: "HIGH"          # From ensemble scoring
    file: "terraform/main.tf"
    line: 15
    title: "Security group allows 0.0.0.0/0 ingress"
    description: "..."
    suggestion: "..."
    status: "pending"           # pending -> in_progress -> fixed -> verified -> abandoned
    version: 1                  # Optimistic locking — increment on every update, reject stale writes
    created_at: Timestamp
    updated_at: Timestamp
    fix_pr: null                # Set when CCR opens a fix PR
    retry_count: 0
    retry_backoff_until: null   # Exponential backoff: 5min, 15min, 45min before retry
    context: {}                 # Additional context for retry

cost_tracking/
  {run_id}/
    agent: "devops"
    review_mode: "ensemble"
    repo: "GetEvinced/infra-pulse"
    pr_number: 42
    tokens_in: 12500
    tokens_out: 3200
    llm_calls: [
      {model: "claude-opus-4-6", tokens_in: 4200, tokens_out: 1100, cost_usd: 0.15},
      {model: "o3", tokens_in: 4100, tokens_out: 1000, cost_usd: 0.12},
      {model: "gemini-2.5-pro", tokens_in: 4200, tokens_out: 1100, cost_usd: 0.08}
    ]
    total_cost_usd: 0.35
    duration_s: 45.2
    created_at: Timestamp

dep_versions/
  {repo}/{package_manager}/
    dependencies: {
      "react": {current: "18.2.0", latest: "19.1.0", severity: "major"},
      ...
    }
    last_audit: Timestamp
    vulnerabilities: [...]

clickup_snapshots/
  {project_id}/
    tasks: [...]
    last_sync: Timestamp

agent_configs/
  {agent_name}/
    enabled: true
    last_run: Timestamp
    error_count: 0
    last_error: null
```

### Data Flow

**Ingestion (Knowledge Sync):**
```
Google Drive folder -> fetch docs (Drive API) -> chunk by heading/paragraph
-> generate embeddings (text-embedding-3-small via OpenAI API)
-> upsert to knowledge_{agent} table (ON CONFLICT UPDATE)
-> update embeddings_meta.last_refresh
```

**Query (Context Assembly):**
```
PR diff text -> generate embedding -> query knowledge_{agent}
WHERE cosine_similarity > 0.7, LIMIT 10, ORDER BY similarity DESC
-> concatenate chunks within 4K token budget
-> inject into prompt
```

**Exit (Finding Lifecycle):**
```
LLM output -> parse findings JSON -> ensemble scoring -> confidence assignment
-> post to GitHub PR (via GitHub App) -> write high-confidence to Firestore
-> CCR picks up pending findings -> applies fix -> opens PR -> agent re-reviews
```

### Data Lifecycle

| Collection | Retention | Rationale |
|------------|-----------|-----------|
| `knowledge_{agent}` | Refreshed every 4-6h, stale docs tombstoned after 7 days | Keeps corpus current, prevents unbounded growth |
| `findings` | Terminal state + 180 days | Needed for metrics and improvement analysis |
| `cost_tracking` | 400 days | Enables annual budgeting and trend analysis |
| `clickup_snapshots` | Overwritten on each sync | Only latest state matters |
| `dep_versions` | Overwritten on each sync + 90 days history | Version drift detection |
| `agent_configs` | Permanent (in Firestore) | Runtime toggles, error counts |

### Remediation Loop

The remediation loop is the closed feedback cycle from finding detection to automated fix:

1. **Queue write:** After ensemble scoring, findings with `confidence: HIGH` and `severity >= medium` are written to Firestore `findings` collection with `status: pending`.
2. **CCR consumption:** Claude Code Remote polls or receives Firestore triggers for `status: pending` findings. It clones the repo at the PR's HEAD, applies the fix, and opens a new PR.
3. **Fix reference:** The finding document is updated with `fix_pr: <PR number>` and `status: in_progress`.
4. **Re-review:** When the fix PR is opened, `/stark-review` runs on it. The originating agent re-reviews and either confirms the fix (`status: verified`) or re-queues with context (`status: pending`, `retry_count += 1`).
5. **Retry limit:** Max 2 retries. After 3 failed attempts, finding moves to `status: abandoned` and requires human review.
6. **Activation gate:** The remediation loop is behind a config flag (`remediation_enabled`), default `false`. Enabled per-repo after the agent's finding quality is validated.

---

## 4. API / Interface Design

### MCP Server Tools

The MCP server exposes tools following the MCP protocol. Each tool maps to an agent + capability.

**Agent Review Tools:**

```json
{
  "name": "devops_review",
  "description": "DevOps domain review: IaC, CI/CD, Terraform, Docker, Helm, Kubernetes",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": {"type": "string", "description": "GitHub repo (owner/name)"},
      "pr_number": {"type": "integer", "description": "PR number to review"},
      "base": {"type": "string", "description": "Base ref for diff", "default": "main"}
    },
    "required": ["repo", "pr_number"]
  }
}
```

Response format (all review tools return the same shape):

```json
{
  "agent": "devops",
  "review_mode": "ensemble",
  "degraded": false,
  "findings": [
    {
      "severity": "high",
      "confidence": "HIGH",
      "file": "terraform/main.tf",
      "line": 15,
      "title": "Security group allows unrestricted ingress",
      "description": "The ingress rule on line 15 allows traffic from 0.0.0.0/0...",
      "suggestion": "Restrict to VPC CIDR or specific IP ranges...",
      "agreed_by": ["claude", "codex", "gemini"],
      "cross_validated_by": []
    }
  ],
  "tool_results": {
    "terraform-validate": {"status": "passed", "output": {"valid": true, "diagnostics": []}},
    "checkov": {"status": "passed", "output": {"passed": 12, "failed": 1, "skipped": 0}}
  },
  "warnings": [],
  "cost": {"tokens_in": 12500, "tokens_out": 3200, "cost_usd": 0.35},
  "duration_s": 45.2
}
```

**Agent Generate Tools:**

```json
{
  "name": "devops_generate",
  "description": "Generate DevOps artifacts (Dockerfiles, CI configs, Helm charts)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": {"type": "string"},
      "prompt": {"type": "string", "description": "What to generate"},
      "context_files": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Paths to include as context"
      }
    },
    "required": ["repo", "prompt"]
  }
}
```

**Agent Validate Tools:**

```json
{
  "name": "devops_validate",
  "description": "Validate DevOps configs against best practices and agent knowledge",
  "inputSchema": {
    "type": "object",
    "properties": {
      "repo": {"type": "string"},
      "files": {
        "type": "array",
        "items": {"type": "string"},
        "description": "Paths to validate"
      }
    },
    "required": ["repo", "files"]
  }
}
```

**Management Tools:**

| Tool | Description | Input |
|------|-------------|-------|
| `agents_list` | List all registered agents with status | `{}` |
| `agents_activate` | Match agents against file list, return activated agents | `{changed_files: string[], repo: string}` |
| `agents_status` | Detailed status for one agent (health, last run, error count) | `{agent: string}` |
| `agents_enable` | Enable or disable an agent at runtime | `{agent: string, enabled: bool}` |

### CLI Invocation

Explicit: `/stark-agent devops "check this terraform"` — maps to the skill in `skill/stark-agent/SKILL.md`, which calls the MCP server's `devops_review` (or `devops_generate`/`devops_validate` based on intent parsing).

Automatic (during `/stark-review`): `multi_review.py` gains a new phase after standard domain reviews:
1. Fetch changed file paths from PR diff
2. Call `agents_activate` MCP tool with the file list
3. For each activated agent, call the MCP server tool (e.g., `devops_review`)
4. Append agent findings to the review output as a separate section

### Standard Error Envelope

All MCP tool responses (success and error) use the same envelope:

```json
{
  "ok": true,
  "data": { ... },
  "warnings": [],
  "error": null,
  "error_code": null,
  "request_id": "uuid",
  "duration_ms": 1234
}
```

On error: `ok: false`, `data: null`, `error: "human-readable message"`, `error_code: "TOOL_TIMEOUT"`.

### MCP Tool Versioning

Tools are versioned via a `version` field in the MCP server's tool listing metadata. Breaking changes (removing fields, changing semantics) require a new tool name (e.g., `devops_review_v2`). Additive changes (new optional fields) are backward-compatible and don't require versioning. Deprecated tools are marked with `deprecated: true` in their metadata and removed after 2 release cycles.

### Idempotency

Agent reviews are **read-only** with respect to the source code — they produce findings but don't modify the repo. However, they have side effects: GitHub review comments and Firestore queue writes. Rerunning a review produces a new set of findings (not deduplicated against previous runs). The `request_id` in the response envelope allows correlating runs. GitHub posting uses `COMMENT` event (not `APPROVE`/`REQUEST_CHANGES`), so duplicate posts are harmless.

### Error Taxonomy

| Error Code | Description |
|------------|-------------|
| `INVALID_AGENT_CONFIG` | Malformed `agent.yaml`, missing prompt, unsupported review mode |
| `ACTIVATION_ERROR` | Override conflict, file pattern parse failure |
| `TOOL_EXECUTION_ERROR` | Command failed and tool is `required: true` |
| `TOOL_TIMEOUT` | Tool exceeded timeout budget |
| `KNOWLEDGE_STALE` | Corpus too old and inline refresh also failed |
| `LLM_PROVIDER_ERROR` | Provider timeout, auth failure, or quota exceeded |
| `PROMPT_BUDGET_EXCEEDED` | Diff + context could not be reduced to fit model context |
| `DEPENDENCY_UNAVAILABLE` | Drive, ClickUp, Cloud SQL, or Firestore unavailable |

### Error Handling

| Error | HTTP Status | Behavior |
|-------|-------------|----------|
| Unknown agent/tool | 404 | `{"error": "unknown_tool", "message": "No agent tool 'foo_review'"}` |
| Agent disabled | 409 | `{"error": "agent_disabled", "message": "Agent 'devops' is currently disabled"}` |
| Tool execution failure (required=true) | 500 | `{"error": "tool_failed", "tool": "terraform-validate", "stderr": "..."}` |
| Tool execution failure (required=false) | 200 | Review proceeds, `tool_results` includes error for that tool |
| LLM timeout | 504 | Individual LLM skipped, remaining LLMs continue. Findings note which LLMs responded |
| All LLMs failed | 502 | `{"error": "all_llms_failed", "message": "No LLM returned a valid response"}` |
| Knowledge DB unreachable | 200 | Review proceeds without knowledge context, `warnings` field notes degradation |
| Firestore unreachable | 200 | Review succeeds, findings not queued for remediation, warning logged |

### Graceful Degradation Per Review Mode

| Mode | 1 LLM fails | 2 LLMs fail | All fail |
|------|-------------|-------------|----------|
| **Ensemble** | Degrades to 2-model consensus, confidence capped at MEDIUM | Run marked degraded, findings advisory-only | Agent review fails (502) |
| **Verify** | Result marked degraded, findings advisory-only | Agent review fails (502) | — |
| **Single + Tools** | Agent review fails if tool also fails; proceeds if tool succeeds | — | — |

---

## 5. Security Considerations

### Authentication and Authorization

**Cloud Run IAM**: The MCP server endpoint is public but requires IAM authentication. Only authenticated service accounts and authorized users can invoke tools. No anonymous access.

**Workload Identity**: Service-to-service auth uses GCP Workload Identity. No static GCP credentials stored in the container.

**Secret Manager**: All secrets (GitHub App private keys, LLM API keys) stored in GCP Secret Manager. The Cloud Run service account has `secretmanager.secretAccessor` role scoped to the specific secrets it needs. Secrets loaded at startup into an in-memory cache with 1hr TTL, refreshed on version change. If Secret Manager is unreachable at refresh time, the cached value is used until TTL expires. If both cache and Secret Manager are unavailable, the server returns 503 (this is the only fatal dependency). Retry with exponential backoff on transient access errors.

**GitHub App tokens**: Short-lived installation tokens (1hr TTL) obtained via JWT exchange, same pattern as current `github_app.py` but using Secret Manager for the private key instead of Keychain.

### Data Sensitivity

**PR diffs**: Sent to 3 LLM providers (Anthropic, OpenAI, Google). This is the same trust model as the current review pipeline. No change in data exposure.

**Knowledge corpus**: Contains internal docs (runbooks, standards, ClickUp tasks). Stored in Cloud SQL with VPC-only access (no public IP). Embeddings are not reversible to source text, but raw chunks are stored alongside them — access control matters.

**Findings**: May reference security vulnerabilities in the codebase. Firestore access restricted to the Cloud Run service account.

### Attack Surface

| Surface | Mitigation |
|---------|------------|
| MCP endpoint (public) | IAM auth required, no anonymous access |
| Tool execution (in-container) | Tools run as a non-root user (`nobody`) in a read-only filesystem (except `/tmp`). No network access (iptables drop). Timeout enforced via `subprocess.run(timeout=)`. Command allow-list from YAML definitions checked into git — no arbitrary shell interpolation. Only `${repo_root}` variable is expanded; all other `${}` patterns are rejected at config validation. Tool stderr is sanitized (regex strip of patterns matching API keys, tokens, connection strings) before inclusion in responses. |
| pgvector queries | Parameterized queries only — embedding vectors are numeric arrays, no SQL injection path |
| Prompt injection via PR content | LLM prompts use structured delimiters; tool results are JSON-encoded; findings are parsed strictly. Prompt sanitization strips known secret formats from diffs and tool output. |
| Secret rotation | Agents discover rotated secrets via Secret Manager versioning; retry with exponential backoff on auth failure |
| Knowledge corpus poisoning | Sync pipeline validates source ownership (Drive folder ACL, ClickUp project membership); embedding updates are append/update only, no arbitrary deletion |

### Secrets in Prompts

Never. Tool results are structured JSON. Knowledge chunks are plaintext content. No credentials, tokens, or connection strings appear in assembled prompts. The config abstraction layer resolves secrets at the infrastructure level, not the prompt level.

---

## 6. Operational Concerns

### Observability

**Structured Logging** (Cloud Run -> Cloud Logging):
- Every MCP tool invocation: `{event: "tool_call", agent: "devops", capability: "review", repo: "...", pr: 42, duration_ms: ...}`
- Every LLM dispatch: `{event: "llm_dispatch", agent: "devops", model: "claude-opus-4-6", tokens_in: ..., tokens_out: ..., duration_ms: ..., error: null}`
- Every tool execution: `{event: "tool_run", agent: "devops", tool: "terraform-validate", exit_code: 0, duration_ms: ...}`
- Knowledge sync: `{event: "knowledge_sync", namespace: "devops-runbooks", docs_processed: 15, chunks_upserted: 142, duration_ms: ...}`

**Metrics** (Cloud Monitoring):
- `agent_review_duration_seconds` (histogram, labels: agent, review_mode)
- `agent_finding_count` (counter, labels: agent, severity, confidence)
- `agent_llm_cost_usd` (counter, labels: agent, model)
- `agent_tool_errors` (counter, labels: agent, tool)
- `knowledge_sync_age_seconds` (gauge, labels: namespace)

**Alerts**:
- Cloud Run 5xx rate > 5% over 5min
- LLM dispatch latency p95 > 120s
- Knowledge sync age > 2x scheduled interval for any namespace
- Weekly LLM cost exceeds `cost_alert_threshold_usd_per_week` (configurable, default $50)
- Any agent error count > 10 in 1hr

### Health Endpoints

| Endpoint | Purpose | Failure Behavior |
|----------|---------|------------------|
| `GET /healthz` | Process liveness check | Returns 200 if server is running |
| `GET /readyz` | Dependency readiness | Returns 503 only if Secret Manager is unavailable (fatal — can't authenticate). Cloud SQL unavailability does NOT fail readyz — reviews proceed in degraded mode without knowledge context. Does NOT check optional sources (Drive, ClickUp) or LLM providers. |

### Deployment Strategy

**CI/CD**: Push to `main` triggers Cloud Build -> build container -> push to Artifact Registry -> deploy to Cloud Run (zero-downtime rolling update with gradual traffic shifting). Keep one prior revision for instant rollback.

**Container**: Single image containing MCP server, agent configs, tool binaries (terraform, tflint, checkov, axe-core, npm). Multi-stage Dockerfile: build stage installs tools, runtime stage copies binaries + Python app. Tools are baked into the image for determinism — no on-demand installation.

**Configuration**: Agent YAML files baked into the container image. Runtime toggles via Firestore `agent_configs` (enable/disable, error thresholds). Config overrides do not require redeployment.

**Rollback**: Cloud Run revision history. If a deploy causes elevated errors, revert to previous revision via `gcloud run services update-traffic`.

### Scaling

**Cloud Run auto-scaling**: Scale-to-zero when idle, scale up on request load. Each request (one agent review) is independent — horizontal scaling is trivial.

**Concurrency**: Each Cloud Run instance handles up to 4 concurrent requests. LLM API calls are I/O-bound (waiting on provider responses), so CPU is idle during dispatch. Tool execution is brief (<60s) and serialized per request. Max instances capped to control LLM API spend.

**Runtime sizing**: 2 vCPU / 2 GiB, request timeout 900s. Raise limits only after observed pressure.

**Connection pooling**: Cloud SQL connections managed via `sqlalchemy` with `pool_size=5`, `max_overflow=5`, `pool_recycle=1800s`. Uses Cloud SQL Auth Proxy sidecar for secure connections without public IP. Firestore client is initialized once at startup and reused across requests.

**pgvector**: Cloud SQL with pgvector handles the knowledge query load. With ~6 agents x ~1000 chunks each, the dataset is small. IVFFlat indexes are sufficient; no need for HNSW at this scale.

### Failure Modes and Recovery

| Failure | Impact | Recovery |
|---------|--------|----------|
| Cloud Run instance crash mid-review | One agent review lost | MCP client retries. Reviews are idempotent — rerunning produces a new review, doesn't corrupt state. |
| Cloud SQL down | No knowledge context | Review proceeds in degraded mode (no knowledge chunks in prompt). Warning logged. |
| Firestore down | No remediation queue, no cost tracking | Review succeeds (these are write-after-review). Data loss limited to that run's metadata. |
| LLM API outage (one provider) | That LLM's findings missing | Ensemble/verify mode degrades gracefully. Single mode fails for that agent. |
| LLM API outage (all providers) | Agent review fails | 502 returned. `/stark-review` standard domain reviews still run (they use CLI, not this server). |
| Tool execution timeout | One tool's output missing | If `required: false`, review proceeds without that tool's context. If `required: true`, agent review fails with 500. |
| Knowledge sync failure | Stale knowledge | Staleness checker triggers inline refresh. If that also fails, review proceeds with stale data + warning. Alert fires after 1 missed interval. |
| Secret rotation without deploy | Auth failures | Secret Manager versioning + retry with backoff. Service account auto-picks latest secret version. |

### Cost Estimation

| Component | Monthly Cost |
|-----------|-------------|
| Cloud Run (scale-to-zero, ~100 reviews/month) | $5-15 |
| Cloud SQL (db-f1-micro, 10GB) | $8-12 |
| Firestore (< 1GB, < 50K reads/day) | $0-2 |
| Secret Manager (6 secrets, ~3K accesses/month) | < $1 |
| Cloud Build (< 120 min/month) | $0-2 |
| Artifact Registry (< 5 images) | < $1 |
| Cloud Scheduler (< 10 jobs) | $0 |
| Cloud Monitoring (included tier) | $0 |
| **GCP Total** | **$16-33** |
| LLM API (varies by usage) | $20-200+ |

---

## 7. Testing Strategy

### Unit Tests

- **Agent Loader**: Parse valid/invalid YAML, file pattern matching (glob expansion), config validation (missing required fields, unknown review modes).
- **Context Assembler**: Token budget enforcement (4K limit), chunk selection ordering, prompt structure verification (correct section order and delimiters).
- **Ensemble Scorer**: 3/3, 2/3, 1/3 agreement scenarios. Severity adjustment logic. Deduplication by semantic similarity. Confidence assignment.
- **Tool Runner**: Command construction from YAML, timeout enforcement, required vs optional failure handling, JSON parser for tool output.
- **Config Provider**: Secret Manager vs env var resolution, Cloud SQL vs local Postgres URL construction, Firestore vs Postgres table routing.

### Integration Tests

- **MCP Protocol**: End-to-end tool invocation -> response. Verify request/response schema compliance.
- **pgvector Knowledge Query**: Insert test embeddings -> query with known input -> verify chunk selection and ordering.
- **Tool Execution**: Run actual tools (terraform validate, tflint) against test fixtures.
- **LLM Dispatch**: Send a known prompt to each LLM API, verify response parsing produces valid findings JSON. (Uses small, cheap prompts to keep costs low.)
- **GitHub App Token Exchange**: JWT generation -> token acquisition -> API call. Verify against test installation.
- **Firestore Queue**: Write findings, verify status transitions, test retry logic.

### End-to-End Tests

- **Full Review Flow**: Create a test PR with Terraform files -> trigger devops agent review -> verify findings posted to PR, cost tracked in Firestore.
- **Multi-Agent Activation**: PR touching both `.tf` and `.tsx` files -> verify both DevOps and Accessibility agents activate.
- **Degraded Mode**: Kill Cloud SQL -> verify review proceeds without knowledge -> verify warning in output.
- **Staleness Recovery**: Set embeddings_meta.last_refresh to 24h ago -> verify inline sync triggers before review.

### Key Test Scenarios

1. Agent YAML with all optional fields omitted — defaults applied correctly
2. File pattern matching with nested globs (`helm/**/values.yaml`)
3. Knowledge chunks exceeding 4K token budget — correct truncation
4. Tool that times out with `required: true` — review fails with clear error
5. Tool that times out with `required: false` — review succeeds, tool output missing
6. Ensemble mode with 3 identical findings — deduplicated to 1 with HIGH confidence
7. Ensemble mode with 3 completely different findings — 3 findings with LOW confidence
8. PR with no matching file patterns — no agents activate, standard review only
9. Concurrent reviews for different PRs — no state leakage between requests
10. Provider outage during ensemble — graceful degradation to 2-model consensus

### Rollout Testing

- **Phase 1**: DevOps-only behind `agent_configs.devops.enabled = true` (all others false). Monitor for 1 sync cycle.
- **Phase 2**: Accessibility enabled after stable queue depth, latency, and cost.
- **Phase 3**: Remaining agents enabled one at a time with per-agent kill switches.

---

## 8. Open Questions

### Needs Stakeholder Input

1. **Embedding model choice**: text-embedding-3-small (1536 dims, cheaper) vs text-embedding-3-large (3072 dims, better retrieval). The knowledge corpus is small enough that the cost difference is negligible — this is purely a quality question. **Recommendation**: Start with text-embedding-3-small, switch if retrieval quality is measurably poor.

2. **Google Drive access scope**: Should the sync pipeline have read access to the entire DevOps Drive folder, or specific documents only? Broader access means less manual curation but more noise in the knowledge corpus. **Recommendation**: Folder-level access with a `.stark-ignore` file for exclusions.

3. **Remediation loop activation**: Should the Firestore findings queue -> CCR auto-fix loop be enabled from Phase 1, or gated behind a config flag? Auto-fixes opening PRs is high-value but also high-risk if finding quality is poor early on. **Recommendation**: Config flag, default off. Enable per-repo after the agent's finding quality is validated.

4. **Cost agent scope**: The Cost agent monitors all agent runs for token usage and budget enforcement. Should it have the power to *block* an agent run that would exceed budget, or only alert? **Recommendation**: Alert only in Phase 1-2, optional blocking in Phase 3.

### Trade-offs That Could Go Either Way

5. **Knowledge chunk size**: 512 tokens (more chunks, finer granularity) vs 1024 tokens (fewer chunks, more context per chunk). Smaller chunks mean more precise retrieval but risk losing context. Larger chunks may include irrelevant content but preserve document structure. Both are standard approaches in RAG systems. No strong recommendation — needs empirical testing with real DevOps runbooks.

6. **MCP server framework**: Build on the Anthropic MCP SDK (Python, well-documented, native Claude integration) vs FastAPI with MCP protocol implemented manually (more flexibility, team familiarity). The MCP SDK is relatively new but purpose-built. **Decided**: MCP SDK — reduces protocol-level bugs, native SSE support.

7. **Tool installation in container**: Bake tools (terraform, tflint, checkov, axe-core) into the container image vs install on-demand at runtime. **Decided**: Bake tools in. Determinism matters more than image size for Cloud Run. Tools are pinned to specific versions in the Dockerfile.

8. **Agent finding format vs existing finding format**: The existing pipeline uses `Finding(agent, domain, severity, file, line, title, description, suggestion)`. Agent findings add `confidence`, `agreed_by`, and `cross_validated_by` fields. **Decided**: Extend `Finding` with optional fields — downstream consumers benefit from a single type.
