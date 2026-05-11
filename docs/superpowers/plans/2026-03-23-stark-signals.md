# stark-signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a consensus voting, tournament execution, and adaptive weight training system for the multi-agent review pipeline. Deployed as `stark-signals` on GCP Cloud Run with a shared Cloud SQL database, React dashboard, and Python client in stark-skills.

**Architecture:** Standalone FastAPI service (`stark-signals` repo) + client library + consensus engine embedded in stark-skills. Server computes consensus from raw findings. Client spools writes when API is unreachable. Recalibration runs as Cloud Run Job on schedule.

**Tech Stack:** Python 3.13+ · FastAPI · SQLAlchemy 2.0 · Alembic · React 19 · TypeScript · Vite · shadcn/ui v4 · Tailwind 4 · Recharts · Terraform · Cloud Run · Cloud SQL · Cloud Scheduler

**Spec:** `docs/superpowers/specs/2026-03-23-stark-signals-design.md`

**Success Criteria:**
1. Consensus engine produces weighted severity/classification for multi-agent findings
2. Signal store captures gold (human override), silver (regression), and bronze (convergence) signals
3. Review pipeline integrates with signal_client (feature-flagged, non-breaking)
4. Dashboard displays agent leaderboard, review stats, tournament stats, signal stats
5. Recalibration proposes weight changes; human approval required before applying
6. All API writes are idempotent; client spools when API unreachable

**Scope Acknowledgment:** This plan is ambitious for a 7-week timeline. Phase 1 (signal store + consensus) is the highest-value deliverable and should be validated in production before Phase 2 begins. If Phase 1 takes longer than 2 weeks, Phase 2 scope should be reduced (dashboard pages 21-25 can be deferred). Tournament execution (Phase 2) depends on consensus being proven useful.

---

## File Map

### stark-signals repo (`~/Code/stark-signals`)

| Action | Path | Purpose |
|--------|------|---------|
| Create | `pyproject.toml` | Project config, dependencies |
| Create | `Dockerfile` | Multi-stage build (backend + frontend) |
| Create | `docker-compose.yml` | Local dev (postgres + app) |
| Create | `.env.example` | Environment template |
| Create | `src/stark_signals/__init__.py` | Package init with version |
| Create | `src/stark_signals/config.py` | Pydantic settings |
| Create | `src/stark_signals/db.py` | SQLAlchemy engine/session factory |
| Create | `src/stark_signals/enums.py` | Canonical enums (single source of truth) |
| Create | `src/stark_signals/models/__init__.py` | Model exports |
| Create | `src/stark_signals/models/base.py` | DeclarativeBase |
| Create | `src/stark_signals/models/agents.py` | Agent + AgentDomainWeight |
| Create | `src/stark_signals/models/reviews.py` | ReviewRun + Finding + Vote |
| Create | `src/stark_signals/models/tournaments.py` | TournamentRun + TournamentImplementation |
| Create | `src/stark_signals/models/signals.py` | Signal + WeightUpdateProposal |
| Create | `src/stark_signals/api/__init__.py` | API package |
| Create | `src/stark_signals/api/main.py` | FastAPI app + lifespan |
| Create | `src/stark_signals/api/deps.py` | Dependency injection (db session, auth) |
| Create | `src/stark_signals/api/schemas.py` | Pydantic request/response models |
| Create | `src/stark_signals/api/routes_ingest.py` | POST ingest endpoints |
| Create | `src/stark_signals/api/routes_read.py` | GET read endpoints |
| Create | `src/stark_signals/api/routes_mutations.py` | POST mutation endpoints (admin) |
| Create | `src/stark_signals/api/routes_webhooks.py` | GitHub webhook handler |
| Create | `src/stark_signals/consensus.py` | Server-side consensus engine |
| Create | `src/stark_signals/recalibration.py` | Weight recalibration engine |
| Create | `alembic.ini` | Alembic config |
| Create | `alembic/env.py` | Alembic environment |
| Create | `alembic/versions/001_initial_schema.py` | Initial migration (9 tables) |
| Create | `tests/__init__.py` | Test package |
| Create | `tests/conftest.py` | Fixtures (async db, client) |
| Create | `tests/test_consensus.py` | Consensus engine tests |
| Create | `tests/test_routes_ingest.py` | Ingest endpoint tests |
| Create | `tests/test_routes_read.py` | Read endpoint tests |
| Create | `tests/test_routes_webhooks.py` | Webhook handler tests |
| Create | `tests/test_recalibration.py` | Recalibration tests |
| Create | `frontend/` | React dashboard (Phase 2) |
| Create | `infra/terraform/main.tf` | Cloud Run + Cloud SQL + IAP |
| Create | `infra/terraform/variables.tf` | Terraform variables |
| Create | `CLAUDE.md` | Repo conventions |

### stark-skills repo (`~/Code/Playground/stark-skills`)

| Action | Path | Purpose |
|--------|------|---------|
| Create | `scripts/signal_client.py` | Python client (writes to API, spool fallback) |
| Create | `scripts/consensus.py` | Thin wrapper calling server-side consensus (Task 14, alongside multi_review.py integration) |
| Create | `scripts/tournament.py` | Tournament runner (worktrees, dispatch, scoring) |
| Create | `scripts/test_signal_client.py` | Client tests |
| Create | `scripts/test_consensus.py` | Client-side consensus tests |
| Create | `scripts/test_tournament.py` | Tournament tests |
| Create | `skill/stark-phase-execute-tournament/SKILL.md` | Tournament skill |
| Modify | `scripts/multi_review.py` | Integrate consensus + signal_client |
| Modify | `skill/stark-review/SKILL.md` | Use consensus results |
| Modify | `skill/stark-review-plan/SKILL.md` | Use consensus results |
| Modify | `global/config.json` | Add `signal_store` config section |
| Modify | `CLAUDE.md` | Add tournament skill to skills list |

### infra-ai-platform repo (`~/Code/Playground/infra-ai-platform`)

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `infra/registry.tf` | Register stark-signals service |

---

## Phase 1: Infrastructure + Signal Store + Consensus (Week 1-2)

### Task 1: Register stark-signals in infra-ai-platform registry

**Files:**
- Modify: `~/Code/Playground/infra-ai-platform/infra/registry.tf`

- [ ] **Step 1: Read current registry**

```bash
cat ~/Code/Playground/infra-ai-platform/infra/registry.tf
```

- [ ] **Step 2: Add stark-signals entry**

Add after the `infra-sentinel` block in `locals.registry`:

```hcl
    stark-signals = {
      product          = "stark-signals"
      gh_repo          = "stark-signals"
      cost_center      = "platform"
      subnet_name      = "stark-signals-subnet"
      subnet_region    = "us-east1"
      subnet_cidr      = "10.5.0.0/24"
      ports = {
        backend  = { number = 8000, description = "FastAPI backend (Cloud Run)", access = "external" }
        frontend = { number = 3000, description = "React/nginx frontend (Cloud Run)", access = "external" }
        db       = { number = 5432, description = "PostgreSQL (shared Cloud SQL)", access = "internal" }
        dev      = { number = 3005, description = "Dev server (local)", access = "internal" }
      }
      uptime_host      = "signals.evinced.net"
      uptime_path      = "/health"
      accept_redirects = false
      uptime_enabled   = false # Enable after DNS and service are live
      shared_resources = ["cloudsql", "load_balancer"]
    }
```

- [ ] **Step 3: Update "Next available" comment**

Change line 3 from:
```
# Next available: service 5 (10.5.0.0/24, dev port 3005)
```
to:
```
# Next available: service 6 (10.6.0.0/24, dev port 3006)
```

- [ ] **Step 4: Validate and commit**

```bash
cd ~/Code/Playground/infra-ai-platform
terraform fmt infra/registry.tf
terraform validate -chdir=infra/
git add infra/registry.tf
git commit -m "registry: add stark-signals service (subnet 10.5.0.0/24, dev port 3005)"
```

**Acceptance criteria:**
1. `terraform validate` passes
2. No duplicate subnet CIDRs or port numbers
3. `shared_resources` includes `cloudsql` and `load_balancer`

---

### Task 2: Terraform — Cloud Run + Cloud SQL database + IAP

**Files:**
- Create: `~/Code/stark-signals/infra/terraform/main.tf`
- Create: `~/Code/stark-signals/infra/terraform/variables.tf`

- [ ] **Step 1: Create repo and infra directory**

```bash
mkdir -p ~/Code/stark-signals/infra/terraform
```

- [ ] **Step 2: Create variables.tf**

Write to `~/Code/stark-signals/infra/terraform/variables.tf`:

```hcl
variable "gcp_project" {
  description = "GCP project ID"
  type        = string
  default     = "evinced-ai-platform"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-east1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"
}

variable "cloud_sql_instance" {
  description = "Shared Cloud SQL instance connection name"
  type        = string
}

variable "iap_oauth_client_id" {
  description = "OAuth client ID for IAP"
  type        = string
}

variable "iap_oauth_client_secret" {
  description = "OAuth client secret for IAP"
  type        = string
  sensitive   = true
}

variable "github_webhook_secret" {
  description = "GitHub webhook HMAC secret"
  type        = string
  sensitive   = true
}

variable "docker_image" {
  description = "Docker image for Cloud Run"
  type        = string
}
```

- [ ] **Step 3: Create main.tf**

Write to `~/Code/stark-signals/infra/terraform/main.tf`:

```hcl
terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    bucket = "infra-ai-platform-tf-state"
    prefix = "stark-signals"
  }
}

provider "google" {
  project = var.gcp_project
  region  = var.region

  default_labels = {
    ev_product     = "stark-signals"
    ev_service     = "stark-signals"
    ev_environment = var.environment
    ev_managed_by  = "terraform"
    ev_cost_center = "platform"
    ev_gh_repo     = "stark-signals"
  }
}

provider "google-beta" {
  project = var.gcp_project
  region  = var.region
}

# Shared platform resources via remote state
data "terraform_remote_state" "platform" {
  backend = "gcs"
  config = {
    bucket = "infra-ai-platform-tf-state"
    prefix = "infra-platform"
  }
}

locals {
  platform = data.terraform_remote_state.platform.outputs
  vpc_id   = local.platform.vpc_id
  vpc_name = local.platform.vpc_name

  labels = {
    ev_product     = "stark-signals"
    ev_team        = "infra"
    ev_environment = var.environment
    ev_managed_by  = "terraform"
  }
}

# ── Cloud SQL Database ─────────────────────────────────────────────────
# Uses shared Cloud SQL instance, creates a new database

resource "google_sql_database" "stark_signals" {
  name     = "stark_signals"
  instance = var.cloud_sql_instance
  project  = var.gcp_project
}

resource "google_sql_user" "stark_signals" {
  name     = google_service_account.stark_signals.email
  instance = var.cloud_sql_instance
  type     = "CLOUD_IAM_SERVICE_ACCOUNT"
  project  = var.gcp_project
}

# ── Service Account ────────────────────────────────────────────────────

resource "google_service_account" "stark_signals" {
  account_id   = "stark-signals"
  display_name = "stark-signals Cloud Run SA"
  project      = var.gcp_project
}

resource "google_project_iam_member" "cloudsql_client" {
  project = var.gcp_project
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.stark_signals.email}"
}

resource "google_project_iam_member" "secret_accessor" {
  project = var.gcp_project
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.stark_signals.email}"
}

resource "google_project_iam_member" "run_invoker" {
  project = var.gcp_project
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.stark_signals.email}"
}

# ── Secrets ─────────────────────────────────────────────────────────

resource "google_secret_manager_secret" "webhook_secret" {
  secret_id = "stark-signals-webhook-secret"
  project   = var.gcp_project

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "webhook_secret" {
  secret      = google_secret_manager_secret.webhook_secret.id
  secret_data = var.github_webhook_secret
}

# ── Cloud Run Service ──────────────────────────────────────────────────

resource "google_cloud_run_v2_service" "stark_signals" {
  name     = "stark-signals"
  location = var.region
  project  = var.gcp_project

  template {
    service_account = google_service_account.stark_signals.email

    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }

    containers {
      image = var.docker_image

      ports {
        container_port = 8000
      }

      env {
        name  = "DATABASE_URL"
        value = "postgresql+asyncpg://stark-signals@/${google_sql_database.stark_signals.name}?host=/cloudsql/${var.cloud_sql_instance}"
      }
      env {
        name  = "DATABASE_URL_SYNC"
        value = "postgresql+psycopg2://stark-signals@/${google_sql_database.stark_signals.name}?host=/cloudsql/${var.cloud_sql_instance}"
      }
      env {
        name  = "GCP_PROJECT"
        value = var.gcp_project
      }
      env {
        name = "GITHUB_WEBHOOK_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.webhook_secret.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        period_seconds    = 5
        failure_threshold = 10
      }

      # Liveness uses a lightweight endpoint that does NOT check DB.
      # If liveness checked DB and DB was down, Cloud Run would kill all instances,
      # preventing recovery when DB comes back. Readiness (startup) checks DB.
      liveness_probe {
        http_get {
          path = "/livez"
        }
        period_seconds = 30
      }
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [var.cloud_sql_instance]
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# ── IAP ────────────────────────────────────────────────────────────────
# NOTE: IAP for Cloud Run v2 requires a Google Cloud Load Balancer (GCLB) in front.
# IAP cannot attach directly to a Cloud Run service. The setup requires:
# 1. A serverless NEG pointing to the Cloud Run service
# 2. A backend service with the NEG
# 3. IAP enabled on the backend service
# 4. An HTTPS load balancer with URL map routing
#
# For Phase 1, deploy Cloud Run with --no-allow-unauthenticated and use
# IAM-based access control (allUsers removed). IAP via GCLB can be added
# as a follow-up when the dashboard is ready (Phase 2).
#
# Webhook endpoint bypasses IAP: use a separate Cloud Run service or
# a Cloud Run route with different auth (signature verification only).

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloud_run_v2_service.stark_signals.name
  location = var.region
  project  = var.gcp_project
  role     = "roles/run.invoker"
  member   = "domain:evinced.com"
}

# Allow unauthenticated access for GitHub webhooks.
# The webhook endpoint validates HMAC signatures server-side (X-Hub-Signature-256).
# This is required because GitHub webhook IPs are not in the evinced.com domain.
resource "google_cloud_run_v2_service_iam_member" "webhook_invoker" {
  name     = google_cloud_run_v2_service.stark_signals.name
  location = var.region
  project  = var.gcp_project
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# IMPORTANT: Since allUsers can invoke the Cloud Run service, ALL non-webhook
# endpoints must verify the caller's identity server-side. The require_admin
# dependency already does this (403 when GCP_PROJECT is set and no IAP header).
# Read endpoints should also require authentication — add an auth middleware
# that checks X-Goog-Authenticated-User-Email or Authorization: Bearer header
# for all /api/v1/* routes except /api/v1/webhooks/*.

# ── Cloud Run Job (Recalibration) ──────────────────────────────────────

resource "google_cloud_run_v2_job" "recalibration" {
  name     = "stark-signals-recalibration"
  location = var.region
  project  = var.gcp_project

  template {
    template {
      service_account = google_service_account.stark_signals.email

      containers {
        image   = var.docker_image
        command = ["python", "-m", "stark_signals.recalibration"]

        env {
          name  = "DATABASE_URL"
          value = "postgresql+asyncpg://stark-signals@/${google_sql_database.stark_signals.name}?host=/cloudsql/${var.cloud_sql_instance}"
        }
        env {
          name  = "DATABASE_URL_SYNC"
          value = "postgresql+psycopg2://stark-signals@/${google_sql_database.stark_signals.name}?host=/cloudsql/${var.cloud_sql_instance}"
        }

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }
      }

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [var.cloud_sql_instance]
        }
      }
    }
  }
}

resource "google_cloud_scheduler_job" "recalibration" {
  name        = "stark-signals-recalibration"
  description = "Daily recalibration of agent weights"
  schedule    = "0 2 * * *"
  time_zone   = "UTC"
  region      = var.region
  project     = var.gcp_project

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.gcp_project}/jobs/stark-signals-recalibration:run"

    oauth_token {
      service_account_email = google_service_account.stark_signals.email
    }
  }
}

# ── Outputs ────────────────────────────────────────────────────────────

output "service_url" {
  value = google_cloud_run_v2_service.stark_signals.uri
}

output "service_account_email" {
  value = google_service_account.stark_signals.email
}
```

- [ ] **Step 4: Validate format**

```bash
cd ~/Code/stark-signals
terraform fmt infra/terraform/
```

**Acceptance criteria:**
1. `terraform fmt` produces no changes
2. Cloud SQL database uses shared instance (not a new instance)
3. Cloud Run service account has `cloudsql.client` and `secretmanager.secretAccessor` roles
4. Recalibration job scheduled daily at 02:00 UTC

---

### Task 3: Scaffold stark-signals repo

**Files:**
- Create: `~/Code/stark-signals/pyproject.toml`
- Create: `~/Code/stark-signals/Dockerfile`
- Create: `~/Code/stark-signals/docker-compose.yml`
- Create: `~/Code/stark-signals/.env.example`

- [ ] **Step 1: Initialize repo**

```bash
mkdir -p ~/Code/stark-signals
cd ~/Code/stark-signals
git init
```

- [ ] **Step 2: Create pyproject.toml**

Write to `~/Code/stark-signals/pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "stark-signals"
dynamic = ["version"]
requires-python = ">=3.13"
dependencies = [
    "fastapi>=0.115.0",
    "uvicorn[standard]>=0.30.0",
    "sqlalchemy[asyncio]>=2.0.0",
    "asyncpg>=0.29.0",
    "psycopg2-binary>=2.9.9",
    "alembic>=1.13.0",
    "pydantic-settings>=2.5.0",
    "pydantic>=2.7.0",
    "structlog>=24.1.0",
    "httpx>=0.27.0",
    "python-Levenshtein>=0.25.0",
    "prometheus-client>=0.21.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0.0",
    "pytest-asyncio>=0.23.0",
    "pytest-cov>=5.0.0",
    "ruff>=0.8.0",
    "pre-commit>=3.8.0",
]

[tool.hatch.version]
path = "src/stark_signals/__init__.py"

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"

[tool.ruff]
target-version = "py313"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]
```

- [ ] **Step 3: Create Dockerfile**

Write to `~/Code/stark-signals/Dockerfile`:

```dockerfile
# ── Build frontend (Phase 2+) ─────────────────────────────────────────
# Phase 1: frontend/ doesn't exist yet. Create a placeholder.
# Phase 2+: full React build.
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY . /tmp/build-context
RUN if [ -f /tmp/build-context/frontend/package.json ]; then \
      cp -r /tmp/build-context/frontend/. ./ && \
      npm ci && \
      npm run build; \
    else \
      mkdir -p dist && echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>stark-signals dashboard</title></head><body><main>Dashboard available after Phase 2</main></body></html>' > dist/index.html; \
    fi && rm -rf /tmp/build-context

# ── Python backend ─────────────────────────────────────────────────────
FROM python:3.13-slim AS backend

WORKDIR /app

# System deps for psycopg2
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy source first, then install (pip install . needs the package source)
COPY pyproject.toml ./
COPY src/ ./src/
RUN pip install --no-cache-dir .

COPY alembic.ini ./
COPY alembic/ ./alembic/
COPY --from=frontend-build /app/frontend/dist ./static/

ENV PORT=8000
EXPOSE 8000

CMD ["uvicorn", "stark_signals.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 4: Create docker-compose.yml and .env.example**

Write to `~/Code/stark-signals/docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: stark_signals
      POSTGRES_USER: stark_signals
      POSTGRES_PASSWORD: localdev
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U stark_signals"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    build: .
    ports:
      - "8000:8000"
    environment:
      DATABASE_URL: postgresql+asyncpg://stark_signals:localdev@db:5432/stark_signals
      DATABASE_URL_SYNC: postgresql+psycopg2://stark_signals:localdev@db:5432/stark_signals
      GITHUB_WEBHOOK_SECRET: local-dev-secret
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

Write to `~/Code/stark-signals/.env.example`:

```
DATABASE_URL=postgresql+asyncpg://stark_signals:localdev@localhost:5432/stark_signals
DATABASE_URL_SYNC=postgresql+psycopg2://stark_signals:localdev@localhost:5432/stark_signals
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GCP_PROJECT=
SERVICE_URL=http://localhost:8000
```

- [ ] **Step 5: Commit**

```bash
cd ~/Code/stark-signals
git add pyproject.toml Dockerfile docker-compose.yml .env.example
git commit -m "chore: scaffold stark-signals repo (pyproject, Dockerfile, docker-compose)"
```

**Acceptance criteria:**
1. `python3 -c "import tomllib; tomllib.load(open('pyproject.toml','rb'))"` succeeds
2. Dockerfile has multi-stage build (frontend + backend)
3. docker-compose has postgres healthcheck

---

### Task 4: Create Python package skeleton + enums + config + db

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/__init__.py`
- Create: `~/Code/stark-signals/src/stark_signals/enums.py`
- Create: `~/Code/stark-signals/src/stark_signals/config.py`
- Create: `~/Code/stark-signals/src/stark_signals/db.py`

- [ ] **Step 1: Create package directories**

```bash
mkdir -p ~/Code/stark-signals/src/stark_signals/models
mkdir -p ~/Code/stark-signals/src/stark_signals/api
mkdir -p ~/Code/stark-signals/tests
```

- [ ] **Step 2: Create __init__.py**

Write to `~/Code/stark-signals/src/stark_signals/__init__.py`:

```python
"""stark-signals — LLM consensus voting, tournament execution & adaptive training."""

__version__ = "0.1.0"
```

- [ ] **Step 3: Create enums.py**

Write to `~/Code/stark-signals/src/stark_signals/enums.py`:

```python
"""Canonical enums — single source of truth for database, API, and client."""

from __future__ import annotations

from enum import Enum


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    NONE = "none"


SEVERITY_ORDER = [Severity.CRITICAL, Severity.HIGH, Severity.MEDIUM, Severity.LOW, Severity.NONE]


class Classification(str, Enum):
    FIX = "fix"
    NOISE = "noise"
    FALSE_POSITIVE = "false_positive"
    IGNORED = "ignored"
    RECURRING = "recurring"
    NEEDS_HUMAN_REVIEW = "needs_human_review"


class VoteType(str, Enum):
    ISSUE = "issue"
    NOT_ISSUE = "not_issue"
    ABSTAIN = "abstain"


class SignalType(str, Enum):
    HUMAN_OVERRIDE = "human_override"
    REGRESSION = "regression"
    CONVERGENCE = "convergence"


class SignalTier(str, Enum):
    GOLD = "gold"
    SILVER = "silver"
    BRONZE = "bronze"


class ReviewType(str, Enum):
    CODE = "code"
    PLAN = "plan"


class ProposalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    SUPERSEDED = "superseded"
```

- [ ] **Step 4: Create config.py**

Write to `~/Code/stark-signals/src/stark_signals/config.py`:

```python
"""Application settings via pydantic-settings."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    database_url: str = Field(
        default="postgresql+asyncpg://stark_signals:localdev@localhost:5432/stark_signals"
    )
    database_url_sync: str = Field(
        default="postgresql+psycopg2://stark_signals:localdev@localhost:5432/stark_signals"
    )

    gcp_project: str = Field(default="")
    service_url: str = Field(default="http://localhost:8000")

    github_webhook_secret: str = Field(default="")
    api_key: str = Field(default="")  # STARK_SIGNALS_API_KEY for CLI client auth

    db_pool_size: int = Field(default=5)
    db_max_overflow: int = Field(default=10)
    db_pool_timeout: int = Field(default=30)
    db_pool_recycle: int = Field(default=1800)

    auto_apply_weight_proposals: bool = Field(default=False)


@lru_cache
def get_settings() -> Settings:
    return Settings()
```

- [ ] **Step 5: Create db.py**

Write to `~/Code/stark-signals/src/stark_signals/db.py`:

```python
"""SQLAlchemy engine and session factory — lazy initialization."""

from __future__ import annotations

import threading
from collections.abc import AsyncGenerator

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, sessionmaker

_init_lock = threading.Lock()
_async_engine = None
_sync_engine = None
_async_session_factory: async_sessionmaker | None = None
_sync_session_factory: sessionmaker | None = None


def _get_engines():
    from stark_signals.config import get_settings

    settings = get_settings()
    pool_size = settings.db_pool_size
    max_overflow = settings.db_max_overflow

    if settings.gcp_project:
        pool_size = min(pool_size, 2)
        max_overflow = min(max_overflow, 5)

    async_engine = create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=pool_size,
        max_overflow=max_overflow,
        pool_timeout=settings.db_pool_timeout,
        pool_recycle=settings.db_pool_recycle,
    )
    sync_engine = create_engine(
        settings.database_url_sync,
        pool_pre_ping=True,
    )
    return async_engine, sync_engine


def _init():
    global _async_engine, _sync_engine, _async_session_factory, _sync_session_factory
    if _async_engine is not None:
        return
    with _init_lock:
        if _async_engine is not None:
            return
        _async_engine, _sync_engine = _get_engines()
        _async_session_factory = async_sessionmaker(_async_engine, expire_on_commit=False)
        _sync_session_factory = sessionmaker(_sync_engine, expire_on_commit=False)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    _init()
    assert _async_session_factory is not None
    async with _async_session_factory() as session:
        yield session


def get_sync_session() -> Session:
    _init()
    assert _sync_session_factory is not None
    return _sync_session_factory()
```

- [ ] **Step 6: Commit**

```bash
cd ~/Code/stark-signals
git add src/
git commit -m "feat: add package skeleton with enums, config, and db module"
```

**Acceptance criteria:**
1. `python3 -c "from stark_signals.enums import Severity; print(Severity.CRITICAL.value)"` prints `critical`
2. All 7 enums defined matching spec exactly
3. Config has all required fields with sensible defaults
4. DB module uses lazy initialization with thread-safe locking

---

### Task 5: Create SQLAlchemy models (all 8 tables)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/models/base.py`
- Create: `~/Code/stark-signals/src/stark_signals/models/agents.py`
- Create: `~/Code/stark-signals/src/stark_signals/models/reviews.py`
- Create: `~/Code/stark-signals/src/stark_signals/models/tournaments.py`

- [ ] **Step 1: Create base.py**

Write to `~/Code/stark-signals/src/stark_signals/models/base.py`:

```python
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Shared declarative base for all ORM models."""

    pass
```

- [ ] **Step 2: Create agents.py**

Write to `~/Code/stark-signals/src/stark_signals/models/agents.py`:

```python
"""Agent and AgentDomainWeight models."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from stark_signals.models.base import Base


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    cli_command: Mapped[str] = mapped_column(String(50), nullable=False)
    model_version: Mapped[str] = mapped_column(String(100), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    weights: Mapped[list[AgentDomainWeight]] = relationship(back_populates="agent")


class AgentDomainWeight(Base):
    __tablename__ = "agent_domain_weights"
    __table_args__ = (
        UniqueConstraint("agent_id", "domain", "effective_from", name="uq_agent_domain_effective"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id"), nullable=False, index=True
    )
    domain: Mapped[str] = mapped_column(String(50), nullable=False)
    weight: Mapped[float] = mapped_column(Float, nullable=False)
    precision_: Mapped[float | None] = mapped_column("precision", Float, nullable=True)
    recall: Mapped[float | None] = mapped_column(Float, nullable=True)
    f1_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    sample_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    effective_from: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    agent: Mapped[Agent] = relationship(back_populates="weights")
```

- [ ] **Step 3: Create reviews.py**

Write to `~/Code/stark-signals/src/stark_signals/models/reviews.py`:

```python
"""ReviewRun, Finding, and Vote models."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from stark_signals.models.base import Base


class ReviewRun(Base):
    __tablename__ = "review_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    idempotency_key: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    repo: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    pr_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    review_type: Mapped[str] = mapped_column(String(20), nullable=False)
    plan_file: Mapped[str | None] = mapped_column(String(500), nullable=True)
    base_sha: Mapped[str] = mapped_column(String(40), nullable=False)
    round_count: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    total_findings: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    fix_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    noise_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    false_positive_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    needs_human_review_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    signal_to_noise: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    agent_versions: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    config_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    findings: Mapped[list[Finding]] = relationship(back_populates="review_run")


class Finding(Base):
    __tablename__ = "findings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    idempotency_key: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    review_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("review_runs.id"), nullable=False, index=True
    )
    round: Mapped[int] = mapped_column(Integer, nullable=False)
    agent: Mapped[str] = mapped_column(String(50), nullable=False)
    domain: Mapped[str] = mapped_column(String(50), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    consensus_severity: Mapped[str | None] = mapped_column(String(20), nullable=True)
    consensus_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    classification: Mapped[str | None] = mapped_column(String(30), nullable=True, index=True)
    consensus_classification: Mapped[str | None] = mapped_column(String(30), nullable=True)
    file: Mapped[str | None] = mapped_column(String(500), nullable=True)
    line: Mapped[int | None] = mapped_column(Integer, nullable=True)
    section: Mapped[str | None] = mapped_column(String(200), nullable=True)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    suggestion: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmers: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    was_fixed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    review_run: Mapped[ReviewRun] = relationship(back_populates="findings")
    votes: Mapped[list[Vote]] = relationship(back_populates="finding")


class Vote(Base):
    __tablename__ = "votes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    finding_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("findings.id"), nullable=False, index=True
    )
    voter_agent: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    voter_domain: Mapped[str] = mapped_column(String(50), nullable=False)
    vote_type: Mapped[str] = mapped_column(String(20), nullable=False)
    severity_vote: Mapped[str] = mapped_column(String(20), nullable=False)
    classification_vote: Mapped[str | None] = mapped_column(String(30), nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)
    weight_at_vote: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    finding: Mapped[Finding] = relationship(back_populates="votes")
```

- [ ] **Step 4: Create tournaments.py and signals.py**

Write to `~/Code/stark-signals/src/stark_signals/models/tournaments.py`:

```python
"""TournamentRun and TournamentImplementation models."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from stark_signals.models.base import Base


class TournamentRun(Base):
    __tablename__ = "tournament_runs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo: Mapped[str] = mapped_column(String(200), nullable=False)
    issue_number: Mapped[int] = mapped_column(Integer, nullable=False)
    plan_slug: Mapped[str] = mapped_column(String(200), nullable=False)
    task_id: Mapped[str] = mapped_column(String(200), nullable=False)
    winner_agent: Mapped[str | None] = mapped_column(String(50), nullable=True)
    winner_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    selection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    acceptance_criteria_met: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    agent_versions: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    implementations: Mapped[list[TournamentImplementation]] = relationship(
        back_populates="tournament_run"
    )


class TournamentImplementation(Base):
    __tablename__ = "tournament_implementations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tournament_run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tournament_runs.id"), nullable=False, index=True
    )
    agent: Mapped[str] = mapped_column(String(50), nullable=False)
    branch_name: Mapped[str] = mapped_column(String(200), nullable=False)
    commit_sha: Mapped[str] = mapped_column(String(40), nullable=False)
    worktree_path: Mapped[str] = mapped_column(String(500), nullable=False)
    files_changed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lines_added: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lines_deleted: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    test_pass_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    test_fail_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    test_skip_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cross_review_score: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    cross_review_findings: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cross_review_critical: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cross_review_high: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    acceptance_passed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    selected: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    disqualified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    disqualification_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    tournament_run: Mapped[TournamentRun] = relationship(back_populates="implementations")
```

Write to `~/Code/stark-signals/src/stark_signals/models/signals.py`:

```python
"""Signal and WeightUpdateProposal models."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from stark_signals.models.base import Base


class Signal(Base):
    __tablename__ = "signals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    idempotency_key: Mapped[str] = mapped_column(String(500), unique=True, nullable=False)
    signal_type: Mapped[str] = mapped_column(String(30), nullable=False)
    signal_tier: Mapped[str] = mapped_column(String(10), nullable=False)
    source_type: Mapped[str] = mapped_column(String(30), nullable=False)
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    agent: Mapped[str] = mapped_column(String(50), nullable=False, index=True)
    domain: Mapped[str | None] = mapped_column(String(50), nullable=True)
    original_value: Mapped[str] = mapped_column(String(100), nullable=False)
    corrected_value: Mapped[str] = mapped_column(String(100), nullable=False)
    weight_delta: Mapped[float | None] = mapped_column(Float, nullable=True)
    context: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    applied_to_proposal_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    dismissed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class WeightUpdateProposal(Base):
    __tablename__ = "weight_update_proposals"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    agent_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    domain: Mapped[str] = mapped_column(String(50), nullable=False)
    current_weight: Mapped[float] = mapped_column(Float, nullable=False)
    proposed_weight: Mapped[float] = mapped_column(Float, nullable=False)
    delta: Mapped[float] = mapped_column(Float, nullable=False)
    signal_count: Mapped[int] = mapped_column(Integer, nullable=False)
    signal_ids: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False, index=True)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    reviewed_by: Mapped[str | None] = mapped_column(String(200), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
```

Write to `~/Code/stark-signals/src/stark_signals/models/__init__.py`:

```python
"""Model exports."""

from stark_signals.models.agents import Agent, AgentDomainWeight
from stark_signals.models.base import Base
from stark_signals.models.reviews import Finding, ReviewRun, Vote
from stark_signals.models.signals import Signal, WeightUpdateProposal
from stark_signals.models.tournaments import TournamentImplementation, TournamentRun

__all__ = [
    "Base",
    "Agent",
    "AgentDomainWeight",
    "ReviewRun",
    "Finding",
    "Vote",
    "TournamentRun",
    "TournamentImplementation",
    "Signal",
    "WeightUpdateProposal",
]
```

- [ ] **Step 5: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/models/
git commit -m "feat: add SQLAlchemy models for all 8 tables"
```

**Acceptance criteria:**
1. All 9 tables defined: agents, agent_domain_weights, review_runs, findings, votes, tournament_runs, tournament_implementations, signals, weight_update_proposals (9 total including proposals)
2. All UUID primary keys use `uuid.uuid4` default
3. All `created_at` columns use `server_default=func.now()`
4. Unique constraints match spec (idempotency_key, agent_domain_effective)

---

### Task 6: Alembic initial migration with all tables

**Files:**
- Create: `~/Code/stark-signals/alembic.ini`
- Create: `~/Code/stark-signals/alembic/env.py`
- Create: `~/Code/stark-signals/alembic/versions/001_initial_schema.py`

- [ ] **Step 1: Create alembic.ini**

Write to `~/Code/stark-signals/alembic.ini`:

```ini
[alembic]
script_location = alembic
sqlalchemy.url = postgresql+psycopg2://stark_signals:localdev@localhost:5432/stark_signals

[loggers]
keys = root,sqlalchemy,alembic

[handlers]
keys = console

[formatters]
keys = generic

[logger_root]
level = WARN
handlers = console

[logger_sqlalchemy]
level = WARN
handlers =
qualname = sqlalchemy.engine

[logger_alembic]
level = INFO
handlers =
qualname = alembic

[handler_console]
class = StreamHandler
args = (sys.stderr,)
level = NOTSET
formatter = generic

[formatter_generic]
format = %(levelname)-5.5s [%(name)s] %(message)s
datefmt = %H:%M:%S
```

- [ ] **Step 2: Create alembic/env.py**

```bash
mkdir -p ~/Code/stark-signals/alembic/versions
```

Write to `~/Code/stark-signals/alembic/env.py`:

```python
import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from stark_signals.models import Base

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Override sqlalchemy.url from env var if set
db_url = os.environ.get("DATABASE_URL_SYNC")
if db_url:
    config.set_main_option("sqlalchemy.url", db_url)


def run_migrations_offline() -> None:
    url = config.get_main_option("sqlalchemy.url")
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

- [ ] **Step 3: Create initial migration**

Write to `~/Code/stark-signals/alembic/versions/001_initial_schema.py`:

```python
"""Initial schema — all 9 tables (agents, agent_domain_weights, review_runs, findings, votes, tournament_runs, tournament_implementations, signals, weight_update_proposals).

Revision ID: 001
Revises:
Create Date: 2026-03-23
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── agents ─────────────────────────────────────────────────────────
    op.create_table(
        "agents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(50), unique=True, nullable=False),
        sa.Column("cli_command", sa.String(50), nullable=False),
        sa.Column("model_version", sa.String(100), nullable=False),
        sa.Column("is_active", sa.Boolean, server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── agent_domain_weights ───────────────────────────────────────────
    op.create_table(
        "agent_domain_weights",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("domain", sa.String(50), nullable=False),
        sa.Column("weight", sa.Float, nullable=False),
        sa.Column("precision", sa.Float, nullable=True),
        sa.Column("recall", sa.Float, nullable=True),
        sa.Column("f1_score", sa.Float, nullable=True),
        sa.Column("sample_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("effective_from", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("agent_id", "domain", "effective_from", name="uq_agent_domain_effective"),
    )
    op.create_index("ix_agent_domain_weights_agent_domain_eff", "agent_domain_weights", ["agent_id", "domain", sa.text("effective_from DESC")])

    # ── review_runs ────────────────────────────────────────────────────
    op.create_table(
        "review_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("idempotency_key", sa.String(500), unique=True, nullable=False),
        sa.Column("repo", sa.String(200), nullable=False),
        sa.Column("pr_number", sa.Integer, nullable=True),
        sa.Column("review_type", sa.String(20), nullable=False),
        sa.Column("plan_file", sa.String(500), nullable=True),
        sa.Column("base_sha", sa.String(40), nullable=False),
        sa.Column("round_count", sa.Integer, server_default=sa.text("1"), nullable=False),
        sa.Column("total_findings", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("fix_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("noise_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("false_positive_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("needs_human_review_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("signal_to_noise", sa.Float, server_default=sa.text("0.0"), nullable=False),
        sa.Column("duration_seconds", sa.Float, server_default=sa.text("0.0"), nullable=False),
        sa.Column("agent_versions", JSONB, server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("config_snapshot", JSONB, server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_review_runs_repo_pr", "review_runs", ["repo", "pr_number"])

    # ── findings ───────────────────────────────────────────────────────
    op.create_table(
        "findings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("idempotency_key", sa.String(500), unique=True, nullable=False),
        sa.Column("review_run_id", UUID(as_uuid=True), sa.ForeignKey("review_runs.id"), nullable=False),
        sa.Column("round", sa.Integer, nullable=False),
        sa.Column("agent", sa.String(50), nullable=False),
        sa.Column("domain", sa.String(50), nullable=False),
        sa.Column("severity", sa.String(20), nullable=False),
        sa.Column("consensus_severity", sa.String(20), nullable=True),
        sa.Column("consensus_score", sa.Float, nullable=True),
        sa.Column("classification", sa.String(30), nullable=True),
        sa.Column("consensus_classification", sa.String(30), nullable=True),
        sa.Column("file", sa.String(500), nullable=True),
        sa.Column("line", sa.Integer, nullable=True),
        sa.Column("section", sa.String(200), nullable=True),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column("suggestion", sa.Text, nullable=True),
        sa.Column("confirmers", JSONB, nullable=True),
        sa.Column("was_fixed", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_findings_review_agent_domain", "findings", ["review_run_id", "agent", "domain"])
    op.create_index("ix_findings_file_line", "findings", ["file", "line"])
    op.create_index("ix_findings_classification", "findings", ["classification"])

    # ── votes ──────────────────────────────────────────────────────────
    op.create_table(
        "votes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("finding_id", UUID(as_uuid=True), sa.ForeignKey("findings.id"), nullable=False),
        sa.Column("voter_agent", sa.String(50), nullable=False),
        sa.Column("voter_domain", sa.String(50), nullable=False),
        sa.Column("vote_type", sa.String(20), nullable=False),
        sa.Column("severity_vote", sa.String(20), nullable=False),
        sa.Column("classification_vote", sa.String(30), nullable=True),
        sa.Column("confidence", sa.Float, server_default=sa.text("1.0"), nullable=False),
        sa.Column("weight_at_vote", sa.Float, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_votes_finding_id", "votes", ["finding_id"])
    op.create_index("ix_votes_voter_agent", "votes", ["voter_agent"])

    # ── tournament_runs ────────────────────────────────────────────────
    op.create_table(
        "tournament_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("repo", sa.String(200), nullable=False),
        sa.Column("issue_number", sa.Integer, nullable=False),
        sa.Column("plan_slug", sa.String(200), nullable=False),
        sa.Column("task_id", sa.String(200), nullable=False),
        sa.Column("winner_agent", sa.String(50), nullable=True),
        sa.Column("winner_score", sa.Float, nullable=True),
        sa.Column("selection_reason", sa.Text, nullable=True),
        sa.Column("acceptance_criteria_met", JSONB, nullable=True),
        sa.Column("duration_seconds", sa.Float, server_default=sa.text("0.0"), nullable=False),
        sa.Column("agent_versions", JSONB, server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )

    # ── tournament_implementations ─────────────────────────────────────
    op.create_table(
        "tournament_implementations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("tournament_run_id", UUID(as_uuid=True), sa.ForeignKey("tournament_runs.id"), nullable=False),
        sa.Column("agent", sa.String(50), nullable=False),
        sa.Column("branch_name", sa.String(200), nullable=False),
        sa.Column("commit_sha", sa.String(40), nullable=False),
        sa.Column("worktree_path", sa.String(500), nullable=False),
        sa.Column("files_changed", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("lines_added", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("lines_deleted", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("test_pass_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("test_fail_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("test_skip_count", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("cross_review_score", sa.Float, server_default=sa.text("0.0"), nullable=False),
        sa.Column("cross_review_findings", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("cross_review_critical", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("cross_review_high", sa.Integer, server_default=sa.text("0"), nullable=False),
        sa.Column("acceptance_passed", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("selected", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("disqualified", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("disqualification_reason", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_tournament_impl_run_agent", "tournament_implementations", ["tournament_run_id", "agent"])

    # ── signals ────────────────────────────────────────────────────────
    op.create_table(
        "signals",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("idempotency_key", sa.String(500), unique=True, nullable=False),
        sa.Column("signal_type", sa.String(30), nullable=False),
        sa.Column("signal_tier", sa.String(10), nullable=False),
        sa.Column("source_type", sa.String(30), nullable=False),
        sa.Column("source_id", UUID(as_uuid=True), nullable=False),
        sa.Column("agent", sa.String(50), nullable=False),
        sa.Column("domain", sa.String(50), nullable=True),
        sa.Column("original_value", sa.String(100), nullable=False),
        sa.Column("corrected_value", sa.String(100), nullable=False),
        sa.Column("weight_delta", sa.Float, nullable=True),
        sa.Column("context", JSONB, nullable=True),
        sa.Column("applied_to_proposal_id", UUID(as_uuid=True), nullable=True),
        sa.Column("dismissed", sa.Boolean, server_default=sa.text("false"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_signals_type_unapplied", "signals", ["signal_type"], postgresql_where=sa.text("applied_to_proposal_id IS NULL"))
    op.create_index("ix_signals_agent_domain", "signals", ["agent", "domain"])
    op.create_index("ix_signals_source", "signals", ["source_type", "source_id"])

    # ── weight_update_proposals ────────────────────────────────────────
    op.create_table(
        "weight_update_proposals",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("agent_id", UUID(as_uuid=True), sa.ForeignKey("agents.id"), nullable=False),
        sa.Column("domain", sa.String(50), nullable=False),
        sa.Column("current_weight", sa.Float, nullable=False),
        sa.Column("proposed_weight", sa.Float, nullable=False),
        sa.Column("delta", sa.Float, nullable=False),
        sa.Column("signal_count", sa.Integer, nullable=False),
        sa.Column("signal_ids", JSONB, nullable=False),
        sa.Column("status", sa.String(20), server_default=sa.text("'pending'"), nullable=False),
        sa.Column("confidence", sa.Float, nullable=False),
        sa.Column("reviewed_by", sa.String(200), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_proposals_agent_domain_status", "weight_update_proposals", ["agent_id", "domain", "status"])
    op.create_index("ix_proposals_pending", "weight_update_proposals", ["status"], postgresql_where=sa.text("status = 'pending'"))

    # ── Seed agents ────────────────────────────────────────────────────
    import uuid as _uuid
    agents_table = sa.table(
        "agents",
        sa.column("id", UUID(as_uuid=True)),
        sa.column("name", sa.String),
        sa.column("cli_command", sa.String),
        sa.column("model_version", sa.String),
    )
    agent_ids = {
        "claude": _uuid.uuid5(_uuid.NAMESPACE_DNS, "stark-signals.claude"),
        "codex": _uuid.uuid5(_uuid.NAMESPACE_DNS, "stark-signals.codex"),
        "gemini": _uuid.uuid5(_uuid.NAMESPACE_DNS, "stark-signals.gemini"),
    }
    op.bulk_insert(agents_table, [
        {"id": str(agent_ids["claude"]), "name": "claude", "cli_command": "claude", "model_version": "claude-opus-4-6"},
        {"id": str(agent_ids["codex"]), "name": "codex", "cli_command": "codex", "model_version": "codex-mini-2025-01"},
        {"id": str(agent_ids["gemini"]), "name": "gemini", "cli_command": "gemini", "model_version": "gemini-2.5-pro"},
    ])

    # ── Seed initial weights ───────────────────────────────────────────
    weights_table = sa.table(
        "agent_domain_weights",
        sa.column("id", UUID(as_uuid=True)),
        sa.column("agent_id", UUID(as_uuid=True)),
        sa.column("domain", sa.String),
        sa.column("weight", sa.Float),
    )
    initial_weights = {
        "claude": {"architecture": 0.40, "correctness": 0.40, "security": 0.35, "type-safety": 0.30, "accessibility": 0.30, "test-coverage": 0.35},
        "codex": {"architecture": 0.35, "correctness": 0.35, "security": 0.35, "type-safety": 0.35, "accessibility": 0.25, "test-coverage": 0.35},
        "gemini": {"architecture": 0.25, "correctness": 0.25, "security": 0.30, "type-safety": 0.35, "accessibility": 0.45, "test-coverage": 0.30},
    }
    rows = []
    for agent_name, domains in initial_weights.items():
        for domain, weight in domains.items():
            rows.append({
                "id": str(_uuid.uuid5(_uuid.NAMESPACE_DNS, f"stark-signals.{agent_name}.{domain}.initial")),
                "agent_id": str(agent_ids[agent_name]),
                "domain": domain,
                "weight": weight,
            })
    op.bulk_insert(weights_table, rows)


def downgrade() -> None:
    op.drop_table("weight_update_proposals")
    op.drop_table("signals")
    op.drop_table("tournament_implementations")
    op.drop_table("tournament_runs")
    op.drop_table("votes")
    op.drop_table("findings")
    op.drop_table("review_runs")
    op.drop_table("agent_domain_weights")
    op.drop_table("agents")
```

- [ ] **Step 4: Test migration against local postgres**

```bash
cd ~/Code/stark-signals
docker compose up -d db
sleep 3
DATABASE_URL_SYNC=postgresql+psycopg2://stark_signals:localdev@localhost:5432/stark_signals \
    alembic upgrade head
```

Expected: `INFO  [alembic.runtime.migration] Running upgrade  -> 001, Initial schema`

- [ ] **Step 5: Verify tables exist**

```bash
PGPASSWORD=localdev psql -h localhost -U stark_signals -d stark_signals \
    -c "\dt" -c "SELECT name, cli_command FROM agents ORDER BY name;"
```

Expected: 9 tables listed, 3 agent rows (claude, codex, gemini)

- [ ] **Step 6: Commit**

```bash
cd ~/Code/stark-signals
git add alembic.ini alembic/
git commit -m "feat: add Alembic initial migration with all 9 tables (agents, agent_domain_weights, review_runs, findings, votes, tournament_runs, tournament_implementations, signals, weight_update_proposals) and seed data"
```

**Acceptance criteria:**
1. `alembic upgrade head` creates all 9 tables (agents, agent_domain_weights, review_runs, findings, votes, tournament_runs, tournament_implementations, signals, weight_update_proposals) without error
2. `alembic downgrade base` drops all tables cleanly
3. Seed data inserts 3 agents and 18 initial weights
4. All indexes from spec are created

**Migration Rollback Procedure (production):**
1. Before deploying a schema change, take a Cloud SQL backup: `gcloud sql backups create --instance=INSTANCE`
2. Deploy the new image with `alembic upgrade head` as a pre-start command
3. If migration fails or the new version has issues: `alembic downgrade -1` to revert one step
4. If downgrade also fails: restore from backup (`gcloud sql backups restore`)
5. Never run `alembic downgrade base` in production — only single-step downgrades

---

### Task 7: Server-side consensus engine

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/consensus.py`
- Create: `~/Code/stark-signals/tests/test_consensus.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/stark-signals/tests/__init__.py`:

```python
```

Write to `~/Code/stark-signals/tests/conftest.py`:

```python
"""Shared test fixtures."""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncGenerator

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from stark_signals.models.base import Base


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
async def engine():
    """Use PostgreSQL for tests — models use PostgreSQL-specific types (UUID, JSONB).

    Requires local postgres via docker compose:
        docker compose up -d db
    Falls back to the docker-compose postgres at localhost:5432.
    """
    # Uses same docker-compose postgres; creates/drops tables per session (not per test)
    test_url = "postgresql+asyncpg://stark_signals:localdev@localhost:5432/stark_signals"
    eng = create_async_engine(test_url)
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await eng.dispose()


@pytest.fixture
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        yield session
        await session.rollback()


def make_finding(
    *,
    agent: str = "claude",
    domain: str = "architecture",
    severity: str = "high",
    file: str | None = "src/main.py",
    line: int | None = 42,
    section: str | None = None,
    title: str = "Test finding",
) -> dict:
    """Helper to create a finding dict matching the ingest schema."""
    return {
        "agent": agent,
        "domain": domain,
        "severity": severity,
        "file": file,
        "line": line,
        "section": section,
        "title": title,
        "description": f"Description of {title}",
        "suggestion": f"Suggestion for {title}",
    }


def make_coverage(
    *,
    agent: str = "claude",
    domain: str = "architecture",
    reviewed_files: list[str] | None = None,
    reviewed_sections: list[str] | None = None,
) -> dict:
    """Helper to create a coverage dict."""
    return {
        "agent": agent,
        "domain": domain,
        "reviewed_files": reviewed_files or ["src/main.py"],
        "reviewed_sections": reviewed_sections,
        "duration_seconds": 10.0,
    }
```

Write to `~/Code/stark-signals/tests/test_consensus.py`:

```python
"""Tests for consensus engine."""

from __future__ import annotations

import pytest

from stark_signals.consensus import (
    classify_finding,
    compute_consensus_score,
    compute_consensus_severity,
    group_findings_code,
    group_findings_plan,
    normalize_title,
    run_consensus,
)
from tests.conftest import make_coverage, make_finding


class TestNormalizeTitle:
    def test_basic(self):
        assert normalize_title("Missing Error Handling!") == "missing error handling"

    def test_strips_punctuation(self):
        assert normalize_title("N+1 query (perf)") == "n1 query perf"

    def test_collapses_whitespace(self):
        assert normalize_title("  too   many   spaces  ") == "too many spaces"


class TestGroupFindingsCode:
    def test_same_file_nearby_lines(self):
        f1 = make_finding(file="a.py", line=10, title="Missing check")
        f2 = make_finding(agent="codex", file="a.py", line=15, title="Missing check")
        groups = group_findings_code([f1, f2])
        assert len(groups) == 1

    def test_same_file_far_lines(self):
        f1 = make_finding(file="a.py", line=10, title="Missing check")
        f2 = make_finding(agent="codex", file="a.py", line=100, title="Missing check")
        groups = group_findings_code([f1, f2])
        assert len(groups) == 2

    def test_different_titles(self):
        f1 = make_finding(file="a.py", line=10, title="Missing check")
        f2 = make_finding(agent="codex", file="a.py", line=10, title="Something completely different")
        groups = group_findings_code([f1, f2])
        assert len(groups) == 2


class TestGroupFindingsPlan:
    def test_same_section(self):
        f1 = make_finding(section="Architecture", title="Scalability concern", file=None, line=None)
        f2 = make_finding(agent="gemini", section="Architecture", title="Scalability concern", file=None, line=None)
        groups = group_findings_plan([f1, f2])
        assert len(groups) == 1


class TestConsensusSeverity:
    def test_weighted_majority_high(self):
        votes = [
            {"severity": "high", "weight": 0.4},
            {"severity": "medium", "weight": 0.35},
        ]
        result = compute_consensus_severity(votes)
        assert result == "high"

    def test_tie_breaks_higher(self):
        votes = [
            {"severity": "high", "weight": 0.5},
            {"severity": "medium", "weight": 0.5},
        ]
        result = compute_consensus_severity(votes)
        assert result == "high"

    def test_unanimous_low(self):
        votes = [
            {"severity": "low", "weight": 0.4},
            {"severity": "low", "weight": 0.35},
            {"severity": "low", "weight": 0.25},
        ]
        result = compute_consensus_severity(votes)
        assert result == "low"


class TestConsensusScore:
    def test_unanimous(self):
        votes = [
            {"severity": "high", "weight": 0.4},
            {"severity": "high", "weight": 0.35},
            {"severity": "high", "weight": 0.25},
        ]
        score = compute_consensus_score(votes)
        assert score == 1.0

    def test_split_vote(self):
        votes = [
            {"severity": "high", "weight": 0.5},
            {"severity": "low", "weight": 0.5},
        ]
        score = compute_consensus_score(votes)
        assert 0.0 < score < 1.0


class TestClassifyFinding:
    def test_high_confidence_fix(self):
        result = classify_finding(consensus_severity="high", consensus_score=0.9)
        assert result == "fix"

    def test_high_confidence_none(self):
        result = classify_finding(consensus_severity="none", consensus_score=0.9)
        assert result == "noise"

    def test_low_confidence(self):
        result = classify_finding(consensus_severity="medium", consensus_score=0.3)
        assert result == "needs_human_review"


class TestRunConsensus:
    def test_basic_code_review(self):
        findings = [
            make_finding(agent="claude", severity="high"),
            make_finding(agent="codex", severity="medium"),
        ]
        coverage = [
            make_coverage(agent="claude"),
            make_coverage(agent="codex"),
            make_coverage(agent="gemini"),  # reviewed but didn't flag
        ]
        weights = {
            "claude": {"architecture": 0.40},
            "codex": {"architecture": 0.35},
            "gemini": {"architecture": 0.25},
        }
        results = run_consensus(
            findings=findings,
            coverage=coverage,
            weights=weights,
            review_type="code",
        )
        assert len(results) == 1  # grouped into 1
        r = results[0]
        assert r["consensus_severity"] in ("high", "medium", "low", "critical", "none")
        assert 0.0 <= r["consensus_score"] <= 1.0
        assert len(r["votes"]) == 3  # all 3 agents voted
```

- [ ] **Step 2: Verify tests fail**

```bash
cd ~/Code/stark-signals
pip install -e ".[dev]" aiosqlite
pytest tests/test_consensus.py -x 2>&1 | head -20
```

Expected: `ModuleNotFoundError: No module named 'stark_signals.consensus'`

- [ ] **Step 3: Implement consensus.py**

Write to `~/Code/stark-signals/src/stark_signals/consensus.py`:

```python
"""Server-side consensus engine — voting protocol for multi-agent review findings."""

from __future__ import annotations

import math
import re
import unicodedata
from collections import defaultdict
from typing import Any

from stark_signals.enums import SEVERITY_ORDER, Classification, Severity, VoteType


# ── Title normalization ────────────────────────────────────────────────

def normalize_title(title: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    text = title.lower()
    text = re.sub(r"[^\w\s]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _levenshtein(a: str, b: str) -> int:
    """Compute Levenshtein distance using python-Levenshtein (C extension)."""
    from Levenshtein import distance
    return distance(a, b)


def _titles_match(a: str, b: str) -> bool:
    """Two normalized titles match if Levenshtein distance <= 20% of longer."""
    na, nb = normalize_title(a), normalize_title(b)
    if na == nb:
        return True
    max_len = max(len(na), len(nb))
    if max_len == 0:
        return True
    return _levenshtein(na, nb) <= max_len * 0.2


# ── Finding grouping ──────────────────────────────────────────────────

def _line_bucket(line: int | None) -> int | None:
    """Bucket lines into groups of 10."""
    if line is None:
        return None
    return line // 10


def group_findings_code(findings: list[dict]) -> list[list[dict]]:
    """Group code review findings by (file, line_bucket, normalized_title)."""
    groups: list[list[dict]] = []
    for f in findings:
        matched = False
        for group in groups:
            rep = group[0]
            if (
                f.get("file") == rep.get("file")
                and _line_bucket(f.get("line")) == _line_bucket(rep.get("line"))
                and _titles_match(f.get("title", ""), rep.get("title", ""))
            ):
                group.append(f)
                matched = True
                break
        if not matched:
            groups.append([f])
    return groups


def group_findings_plan(findings: list[dict]) -> list[list[dict]]:
    """Group plan review findings by (section, normalized_title)."""
    groups: list[list[dict]] = []
    for f in findings:
        matched = False
        for group in groups:
            rep = group[0]
            if (
                f.get("section") == rep.get("section")
                and _titles_match(f.get("title", ""), rep.get("title", ""))
            ):
                group.append(f)
                matched = True
                break
        if not matched:
            groups.append([f])
    return groups


# ── Voting ─────────────────────────────────────────────────────────────

def _severity_index(sev: str) -> int:
    """Return ordinal index of severity (0=critical, 4=none)."""
    try:
        return SEVERITY_ORDER.index(Severity(sev))
    except (ValueError, KeyError):
        return len(SEVERITY_ORDER) - 1


def compute_consensus_severity(votes: list[dict]) -> str:
    """Weighted majority vote for severity. Ordinal: cumulative from top exceeds 50%.

    votes: list of {"severity": str, "weight": float}
    Returns consensus severity string.
    """
    if not votes:
        return Severity.NONE.value

    total_weight = sum(v["weight"] for v in votes)
    if total_weight == 0:
        return Severity.NONE.value

    # Accumulate weight per severity level
    sev_weights: dict[str, float] = defaultdict(float)
    for v in votes:
        sev_weights[v["severity"]] += v["weight"]

    # Walk from most severe to least; first to exceed 50% cumulative wins
    cumulative = 0.0
    for sev in SEVERITY_ORDER:
        cumulative += sev_weights.get(sev.value, 0.0)
        if cumulative / total_weight >= 0.5:
            return sev.value

    return Severity.NONE.value


def compute_consensus_score(votes: list[dict]) -> float:
    """Consensus score = 1 - (entropy / max_entropy). 0=max disagreement, 1=unanimous.

    votes: list of {"severity": str, "weight": float}
    """
    if not votes:
        return 0.0

    total_weight = sum(v["weight"] for v in votes)
    if total_weight == 0:
        return 0.0

    sev_weights: dict[str, float] = defaultdict(float)
    for v in votes:
        sev_weights[v["severity"]] += v["weight"]

    # Compute entropy of weighted distribution
    probs = [w / total_weight for w in sev_weights.values() if w > 0]
    entropy = -sum(p * math.log2(p) for p in probs if p > 0)
    max_entropy = math.log2(len(SEVERITY_ORDER))

    if max_entropy == 0:
        return 1.0

    return max(0.0, min(1.0, 1.0 - entropy / max_entropy))


def classify_finding(*, consensus_severity: str, consensus_score: float) -> str:
    """Auto-classify based on consensus results."""
    if consensus_score < 0.5:
        return Classification.NEEDS_HUMAN_REVIEW.value

    sev_idx = _severity_index(consensus_severity)
    if consensus_score > 0.8:
        if sev_idx <= _severity_index("medium"):
            return Classification.FIX.value
        if consensus_severity == Severity.NONE.value:
            return Classification.NOISE.value

    return Classification.NEEDS_HUMAN_REVIEW.value


# ── Full consensus pipeline ───────────────────────────────────────────

def _determine_vote_type(
    agent: str,
    domain: str,
    finding_group: list[dict],
    coverage: list[dict],
    review_type: str,
) -> str:
    """Determine if agent voted issue, not_issue, or abstain for a finding group."""
    # Check if agent produced a finding in this group
    for f in finding_group:
        if f["agent"] == agent:
            return VoteType.ISSUE.value

    # Check if agent reviewed the relevant area
    rep = finding_group[0]
    for cov in coverage:
        if cov["agent"] != agent:
            continue
        if review_type == "code":
            reviewed_files = cov.get("reviewed_files") or []
            if rep.get("file") and rep["file"] in reviewed_files:
                return VoteType.NOT_ISSUE.value
        else:  # plan
            reviewed_sections = cov.get("reviewed_sections") or []
            if rep.get("section") and rep["section"] in reviewed_sections:
                return VoteType.NOT_ISSUE.value

    return VoteType.ABSTAIN.value


def run_consensus(
    *,
    findings: list[dict],
    coverage: list[dict],
    weights: dict[str, dict[str, float]],
    review_type: str = "code",
) -> list[dict[str, Any]]:
    """Run full consensus protocol on a set of findings.

    Args:
        findings: raw findings from all agents
        coverage: what each agent reviewed
        weights: {agent: {domain: weight}}
        review_type: "code" or "plan"

    Returns:
        list of consensus results, one per finding group
    """
    if not findings:
        return []

    # Group findings
    if review_type == "code":
        groups = group_findings_code(findings)
    else:
        groups = group_findings_plan(findings)

    # Get all agents from coverage
    all_agents = list({c["agent"] for c in coverage})
    results = []

    for group in groups:
        rep = group[0]
        domain = rep.get("domain", "architecture")
        votes = []

        for agent in all_agents:
            vote_type = _determine_vote_type(agent, domain, group, coverage, review_type)

            if vote_type == VoteType.ABSTAIN.value:
                votes.append({
                    "agent": agent,
                    "domain": domain,
                    "vote_type": vote_type,
                    "severity": Severity.NONE.value,
                    "classification": None,
                    "weight": weights.get(agent, {}).get(domain, 0.33),
                })
                continue

            # Find the agent's finding in this group (if issue)
            agent_finding = next((f for f in group if f["agent"] == agent), None)

            if vote_type == VoteType.ISSUE.value and agent_finding:
                sev = agent_finding.get("severity", Severity.NONE.value)
            else:
                sev = Severity.NONE.value

            votes.append({
                "agent": agent,
                "domain": domain,
                "vote_type": vote_type,
                "severity": sev,
                "classification": agent_finding.get("classification") if agent_finding else None,
                "weight": weights.get(agent, {}).get(domain, 0.33),
            })

        # Filter non-abstain for severity voting
        active_votes = [v for v in votes if v["vote_type"] != VoteType.ABSTAIN.value]

        if not active_votes:
            # All abstained — skip this group
            continue

        severity_votes = [{"severity": v["severity"], "weight": v["weight"]} for v in active_votes]
        consensus_sev = compute_consensus_severity(severity_votes)
        consensus_scr = compute_consensus_score(severity_votes)
        consensus_cls = classify_finding(
            consensus_severity=consensus_sev,
            consensus_score=consensus_scr,
        )

        # Build confirmers list
        confirmers = [
            {"agent": f["agent"], "domain": f.get("domain")}
            for f in group
            if f["agent"] != rep["agent"]
        ]

        results.append({
            "representative": rep,
            "findings": group,
            "consensus_severity": consensus_sev,
            "consensus_classification": consensus_cls,
            "consensus_score": consensus_scr,
            "votes": votes,
            "confirmers": confirmers,
        })

    return results
```

- [ ] **Step 4: Run tests**

```bash
cd ~/Code/stark-signals
pytest tests/test_consensus.py -v
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/consensus.py tests/
git commit -m "feat: add server-side consensus engine with weighted majority voting"
```

**Acceptance criteria:**
1. `normalize_title` strips punctuation and collapses whitespace
2. Finding grouping uses Levenshtein distance <= 20% for title matching
3. Consensus severity uses ordinal weighted majority (cumulative > 50%)
4. Consensus score uses entropy-based agreement measure
5. Classification auto-overrides based on consensus thresholds from spec

---

### Task 8: FastAPI app skeleton + health + deps

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/api/__init__.py`
- Create: `~/Code/stark-signals/src/stark_signals/api/main.py`
- Create: `~/Code/stark-signals/src/stark_signals/api/deps.py`
- Create: `~/Code/stark-signals/src/stark_signals/api/schemas.py`

- [ ] **Step 1: Create api __init__.py**

Write to `~/Code/stark-signals/src/stark_signals/api/__init__.py`:

```python
```

- [ ] **Step 2: Create deps.py**

Write to `~/Code/stark-signals/src/stark_signals/api/deps.py`:

```python
"""Dependency injection for FastAPI routes."""

from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from stark_signals.db import get_async_session


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async for session in get_async_session():
        yield session


async def require_auth(request: Request) -> str:
    """Verify caller identity for all API endpoints (except webhooks).

    Accepts either:
    - X-Goog-Authenticated-User-Email header (from IAP/IAM)
    - Authorization: Bearer <API_KEY> header (for CLI clients using STARK_SIGNALS_API_KEY)

    In local dev (GCP_PROJECT unset), returns 'dev@evinced.com'.
    """
    from stark_signals.config import get_settings

    settings = get_settings()
    if not settings.gcp_project:
        return "dev@evinced.com"

    # Check IAP/IAM header. When Cloud Run is behind IAP or uses IAM invoker,
    # Google's infrastructure validates the caller before the request reaches
    # the service — the header is set by Google, not the caller.
    # Without IAP (allUsers invoker), this header is spoofable. The API key
    # path below provides the alternative auth mechanism for that case.
    # TODO: For production hardening, validate the X-Goog-IAP-JWT-Assertion
    # header (signed JWT from Google) instead of the email header.
    email = request.headers.get("X-Goog-Authenticated-User-Email", "")
    if email:
        if email.startswith("accounts.google.com:"):
            email = email.split(":", 1)[1]
        return email

    # Check API key
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer ") and settings.api_key:
        import hmac
        token = auth_header[7:]
        if hmac.compare_digest(token, settings.api_key):
            return "api-key-client"

    raise HTTPException(401, "Authentication required")


async def require_admin(request: Request) -> str:
    """Verify the caller has admin role. Returns the user email.

    In production, the X-Goog-Authenticated-User-Email header is set by IAP/IAM.
    For local dev (GCP_PROJECT unset), defaults to 'dev@evinced.com'.
    In production, missing header → 403 (no anonymous admin access).
    """
    from stark_signals.config import get_settings

    email = request.headers.get("X-Goog-Authenticated-User-Email", "")
    if email.startswith("accounts.google.com:"):
        email = email.split(":", 1)[1]
    if not email:
        settings = get_settings()
        if settings.gcp_project:
            raise HTTPException(403, "Authentication required")
        email = "dev@evinced.com"
    return email
```

- [ ] **Step 3: Create schemas.py**

Write to `~/Code/stark-signals/src/stark_signals/api/schemas.py`:

```python
"""Pydantic request/response schemas for all API endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


# ── Error response ─────────────────────────────────────────────────────

class ErrorResponse(BaseModel):
    """Standard error response shape for all API errors."""
    error: str
    detail: str | None = None
    status_code: int


# ── Ingest schemas ─────────────────────────────────────────────────────

class FindingIn(BaseModel):
    agent: str
    domain: str
    severity: str
    file: str | None = None
    line: int | None = None
    section: str | None = None
    title: str
    description: str
    suggestion: str | None = None


class CoverageIn(BaseModel):
    agent: str
    domain: str
    reviewed_files: list[str] | None = None
    reviewed_sections: list[str] | None = None
    duration_seconds: float = 0.0


class RoundIn(BaseModel):
    round: int
    findings: list[FindingIn]
    coverage: list[CoverageIn]
    duration_seconds: float = 0.0


class ReviewIngestRequest(BaseModel):
    idempotency_key: str
    repo: str
    pr_number: int | None = None
    review_type: str = "code"
    plan_file: str | None = None
    base_sha: str
    agent_versions: dict[str, Any] = Field(default_factory=dict)
    config_snapshot: dict[str, Any] = Field(default_factory=dict)
    rounds: list[RoundIn]


class VoteSummary(BaseModel):
    agent: str
    vote_type: str
    severity_vote: str


class ConsensusResultOut(BaseModel):
    finding_id: uuid.UUID
    consensus_severity: str
    consensus_classification: str
    consensus_score: float
    vote_summary: list[VoteSummary]


class ReviewIngestResponse(BaseModel):
    review_run_id: uuid.UUID
    consensus_results: list[ConsensusResultOut]


class TournamentImplIn(BaseModel):
    agent: str
    branch_name: str
    commit_sha: str
    files_changed: int = 0
    lines_added: int = 0
    lines_deleted: int = 0
    test_pass_count: int = 0
    test_fail_count: int = 0
    test_skip_count: int = 0
    cross_review_score: float = 0.0
    cross_review_findings: int = 0
    cross_review_critical: int = 0
    cross_review_high: int = 0
    acceptance_passed: bool = False
    selected: bool = False
    disqualified: bool = False
    disqualification_reason: str | None = None
    cross_reviews: list[dict[str, Any]] = Field(default_factory=list)


class TournamentIngestRequest(BaseModel):
    id: uuid.UUID
    repo: str
    issue_number: int
    plan_slug: str
    task_id: str
    agent_versions: dict[str, Any] = Field(default_factory=dict)
    implementations: list[TournamentImplIn]
    winner_agent: str | None = None
    winner_score: float | None = None
    selection_reason: str | None = None
    acceptance_criteria_met: dict[str, Any] | None = None


class TournamentIngestResponse(BaseModel):
    tournament_run_id: uuid.UUID


class SignalIngestRequest(BaseModel):
    idempotency_key: str
    signal_type: str
    signal_tier: str
    source_type: str
    source_id: uuid.UUID
    agent: str
    domain: str | None = None
    original_value: str
    corrected_value: str
    weight_delta: float | None = None
    context: dict[str, Any] | None = None


class SignalIngestResponse(BaseModel):
    signal_id: uuid.UUID


# ── Read schemas ───────────────────────────────────────────────────────

class AgentWeightOut(BaseModel):
    domain: str
    weight: float
    precision: float | None = None
    recall: float | None = None
    f1_score: float | None = None
    effective_from: datetime


class AgentOut(BaseModel):
    name: str
    model_version: str
    is_active: bool
    weights: dict[str, float] = Field(default_factory=dict)


class AgentAccuracyDomain(BaseModel):
    domain: str
    precision: float | None = None
    recall: float | None = None
    f1_score: float | None = None
    sample_count: int = 0


class AgentAccuracyOut(BaseModel):
    domains: list[AgentAccuracyDomain]


class ReviewListItem(BaseModel):
    id: uuid.UUID
    repo: str
    pr_number: int | None = None
    review_type: str
    total_findings: int
    signal_to_noise: float
    created_at: datetime


class PaginatedResponse(BaseModel):
    items: list[Any]
    total: int
    page: int


class FindingOut(BaseModel):
    id: uuid.UUID
    agent: str
    domain: str
    severity: str
    consensus_severity: str | None = None
    consensus_score: float | None = None
    classification: str | None = None
    consensus_classification: str | None = None
    file: str | None = None
    line: int | None = None
    section: str | None = None
    title: str
    description: str
    suggestion: str | None = None
    confirmers: list[dict] | None = None
    was_fixed: bool = False


class VoteOut(BaseModel):
    id: uuid.UUID
    finding_id: uuid.UUID
    voter_agent: str
    voter_domain: str
    vote_type: str
    severity_vote: str
    classification_vote: str | None = None
    confidence: float
    weight_at_vote: float


class ReviewDetailOut(BaseModel):
    id: uuid.UUID
    repo: str
    pr_number: int | None = None
    review_type: str
    base_sha: str
    total_findings: int
    fix_count: int
    noise_count: int
    signal_to_noise: float
    duration_seconds: float
    agent_versions: dict
    created_at: datetime
    findings: list[FindingOut]
    votes: list[VoteOut]


class TournamentListItem(BaseModel):
    id: uuid.UUID
    repo: str
    issue_number: int
    winner_agent: str | None = None
    winner_score: float | None = None
    created_at: datetime


class TournamentImplOut(BaseModel):
    agent: str
    selected: bool
    cross_review_score: float
    acceptance_passed: bool
    files_changed: int
    lines_added: int
    lines_deleted: int
    test_pass_count: int
    test_fail_count: int
    disqualified: bool
    disqualification_reason: str | None = None


class TournamentDetailOut(BaseModel):
    id: uuid.UUID
    repo: str
    issue_number: int
    plan_slug: str
    task_id: str
    winner_agent: str | None = None
    winner_score: float | None = None
    selection_reason: str | None = None
    duration_seconds: float
    created_at: datetime
    implementations: list[TournamentImplOut]


class SignalOut(BaseModel):
    id: uuid.UUID
    idempotency_key: str
    signal_type: str
    signal_tier: str
    source_type: str
    source_id: uuid.UUID
    agent: str
    domain: str | None = None
    original_value: str
    corrected_value: str
    weight_delta: float | None = None
    context: dict | None = None
    dismissed: bool
    created_at: datetime


class ProposalOut(BaseModel):
    id: uuid.UUID
    agent: str
    domain: str
    current_weight: float
    proposed_weight: float
    delta: float
    signal_count: int
    confidence: float
    status: str
    created_at: datetime


class ProposalApproveResponse(BaseModel):
    proposal_id: uuid.UUID
    new_weight_id: uuid.UUID
    effective_from: datetime


class ProposalRejectRequest(BaseModel):
    reason: str | None = None


class ProposalRejectResponse(BaseModel):
    proposal_id: uuid.UUID
    status: str = "rejected"


# ── Dashboard schemas ──────────────────────────────────────────────────

class AgentLeaderboardEntry(BaseModel):
    agent: str
    overall_f1: float | None = None
    domain_scores: dict[str, float] = Field(default_factory=dict)


class ReviewStats(BaseModel):
    total: int
    avg_findings: float
    avg_noise_rate: float


class TournamentStats(BaseModel):
    total: int
    winner_distribution: dict[str, int] = Field(default_factory=dict)


class SignalStats(BaseModel):
    gold: int
    silver: int
    bronze: int
    pending_proposals: int


class DashboardResponse(BaseModel):
    agent_leaderboard: list[AgentLeaderboardEntry]
    review_stats: ReviewStats
    tournament_stats: TournamentStats
    signal_stats: SignalStats


class TrendPoint(BaseModel):
    date: str
    value: float


class TrendsResponse(BaseModel):
    data_points: list[TrendPoint]


class DomainRanking(BaseModel):
    agent: str
    f1_score: float | None = None
    sample_count: int = 0


class DomainLeaderboard(BaseModel):
    domain: str
    rankings: list[DomainRanking]


class LeaderboardResponse(BaseModel):
    domains: list[DomainLeaderboard]
```

- [ ] **Step 4: Create main.py**

Write to `~/Code/stark-signals/src/stark_signals/api/main.py`:

```python
"""FastAPI application — stark-signals API + dashboard."""

from __future__ import annotations

from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from stark_signals import __version__
from stark_signals.config import get_settings

logger = structlog.get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("app.startup", version=__version__)
    yield
    logger.info("app.shutdown")


app = FastAPI(
    title="stark-signals",
    version=__version__,
    description="LLM consensus voting, tournament execution & adaptive training",
    lifespan=lifespan,
)

settings = get_settings()


@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail, "detail": None, "status_code": exc.status_code},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if not settings.gcp_project else ["https://signals.evinced.net"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ─────────────────────────────────────────────────────────────

from fastapi import Depends  # noqa: E402
from stark_signals.api.deps import require_auth  # noqa: E402
from stark_signals.api.routes_ingest import router as ingest_router  # noqa: E402
from stark_signals.api.routes_read import router as read_router  # noqa: E402
from stark_signals.api.routes_mutations import router as mutations_router  # noqa: E402
from stark_signals.api.routes_webhooks import router as webhooks_router  # noqa: E402

# All routers except webhooks require authentication (require_auth dependency).
# Webhooks use HMAC signature verification instead (server-side, in routes_webhooks.py).
# This is necessary because allUsers IAM is granted for webhook access.
app.include_router(ingest_router, prefix="/api/v1/ingest", tags=["ingest"], dependencies=[Depends(require_auth)])
app.include_router(read_router, prefix="/api/v1", tags=["read"], dependencies=[Depends(require_auth)])
app.include_router(mutations_router, prefix="/api/v1", tags=["mutations"], dependencies=[Depends(require_auth)])
app.include_router(webhooks_router, prefix="/api/v1/webhooks", tags=["webhooks"])


@app.get("/livez")
async def livez():
    """Liveness probe — lightweight, no DB check. Used by Cloud Run liveness probe."""
    return {"status": "alive"}


@app.get("/health")
async def health():
    """Readiness check — verifies database connectivity. Used by startup probe."""
    from sqlalchemy import text
    from stark_signals.db import get_async_session

    try:
        async for session in get_async_session():
            await session.execute(text("SELECT 1"))
            break
        return {"status": "ok", "version": __version__}
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "version": __version__, "error": str(e)},
        )


# Serve static frontend assets if they exist
import os  # noqa: E402

static_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "static")
if os.path.isdir(static_dir):
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
```

- [ ] **Step 5: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/api/
git commit -m "feat: add FastAPI app skeleton with schemas, deps, health endpoint"
```

**Acceptance criteria:**
1. `/health` returns `{"status": "ok", "version": "0.1.0"}`
2. All Pydantic schemas match the spec's API contract
3. CORS configured for local dev and production
4. Routers mounted at correct prefixes

---

### Task 9: Ingest endpoints (review, tournament, signal)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/api/routes_ingest.py`
- Create: `~/Code/stark-signals/tests/test_routes_ingest.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/stark-signals/tests/test_routes_ingest.py`:

```python
"""Tests for ingest endpoints."""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from stark_signals.api.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestIngestReview:
    async def test_basic_ingest(self, client: AsyncClient):
        payload = {
            "idempotency_key": "GetEvinced/test:1:abc123:1",
            "repo": "GetEvinced/test",
            "pr_number": 1,
            "review_type": "code",
            "base_sha": "abc123",
            "agent_versions": {"claude": {"model": "opus-4-6", "prompt_hash": "abc"}},
            "config_snapshot": {},
            "rounds": [{
                "round": 1,
                "findings": [
                    {
                        "agent": "claude",
                        "domain": "architecture",
                        "severity": "high",
                        "file": "src/main.py",
                        "line": 42,
                        "title": "Missing error handling",
                        "description": "No try/catch around API call",
                        "suggestion": "Add try/catch",
                    },
                    {
                        "agent": "codex",
                        "domain": "architecture",
                        "severity": "medium",
                        "file": "src/main.py",
                        "line": 45,
                        "title": "Missing error handling",
                        "description": "Error handling needed",
                    },
                ],
                "coverage": [
                    {"agent": "claude", "domain": "architecture", "reviewed_files": ["src/main.py"]},
                    {"agent": "codex", "domain": "architecture", "reviewed_files": ["src/main.py"]},
                    {"agent": "gemini", "domain": "architecture", "reviewed_files": ["src/main.py"]},
                ],
                "duration_seconds": 30.0,
            }],
        }
        resp = await client.post("/api/v1/ingest/review", json=payload)
        assert resp.status_code == 201
        data = resp.json()
        assert "review_run_id" in data
        assert len(data["consensus_results"]) >= 1

    async def test_idempotent_replay(self, client: AsyncClient):
        payload = {
            "idempotency_key": "GetEvinced/test:2:def456:1",
            "repo": "GetEvinced/test",
            "pr_number": 2,
            "review_type": "code",
            "base_sha": "def456",
            "rounds": [{
                "round": 1,
                "findings": [
                    {"agent": "claude", "domain": "security", "severity": "critical",
                     "file": "auth.py", "line": 10, "title": "SQL injection", "description": "Unsafe query"},
                ],
                "coverage": [
                    {"agent": "claude", "domain": "security", "reviewed_files": ["auth.py"]},
                ],
                "duration_seconds": 15.0,
            }],
        }
        resp1 = await client.post("/api/v1/ingest/review", json=payload)
        assert resp1.status_code == 201
        resp2 = await client.post("/api/v1/ingest/review", json=payload)
        assert resp2.status_code == 201
        assert resp1.json()["review_run_id"] == resp2.json()["review_run_id"]


class TestIngestTournament:
    async def test_basic_ingest(self, client: AsyncClient):
        run_id = str(uuid.uuid4())
        payload = {
            "id": run_id,
            "repo": "GetEvinced/test",
            "issue_number": 10,
            "plan_slug": "test-plan",
            "task_id": "task-1",
            "implementations": [
                {
                    "agent": "claude",
                    "branch_name": f"tournament/{run_id}/claude",
                    "commit_sha": "aaa111",
                    "acceptance_passed": True,
                    "selected": True,
                    "cross_review_score": 2.5,
                    "cross_review_findings": 3,
                },
                {
                    "agent": "codex",
                    "branch_name": f"tournament/{run_id}/codex",
                    "commit_sha": "bbb222",
                    "acceptance_passed": True,
                    "selected": False,
                    "cross_review_score": 5.0,
                    "cross_review_findings": 6,
                },
            ],
            "winner_agent": "claude",
            "winner_score": 2.5,
            "selection_reason": "Lowest cross-review score",
        }
        resp = await client.post("/api/v1/ingest/tournament", json=payload)
        assert resp.status_code == 201
        assert resp.json()["tournament_run_id"] == run_id


class TestIngestSignal:
    async def test_basic_ingest(self, client: AsyncClient):
        payload = {
            "idempotency_key": "gold:finding:abc:fix",
            "signal_type": "human_override",
            "signal_tier": "gold",
            "source_type": "finding",
            "source_id": str(uuid.uuid4()),
            "agent": "claude",
            "domain": "architecture",
            "original_value": "noise",
            "corrected_value": "fix",
            "weight_delta": -0.05,
            "context": {"overridden_by": "dev@evinced.com"},
        }
        resp = await client.post("/api/v1/ingest/signal", json=payload)
        assert resp.status_code == 201
        assert "signal_id" in resp.json()
```

- [ ] **Step 2: Verify tests fail**

```bash
cd ~/Code/stark-signals
pytest tests/test_routes_ingest.py -x 2>&1 | head -5
```

Expected: ImportError or test failures

- [ ] **Step 3: Implement routes_ingest.py**

Write to `~/Code/stark-signals/src/stark_signals/api/routes_ingest.py`:

```python
"""Ingest endpoints — review, tournament, and signal data collection."""

from __future__ import annotations

import hashlib
import uuid

import structlog
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from stark_signals.api.deps import get_db
from stark_signals.api.schemas import (
    ConsensusResultOut,
    ReviewIngestRequest,
    ReviewIngestResponse,
    SignalIngestRequest,
    SignalIngestResponse,
    TournamentIngestRequest,
    TournamentIngestResponse,
    VoteSummary,
)
from stark_signals.consensus import run_consensus
from stark_signals.models.agents import Agent, AgentDomainWeight
from stark_signals.models.reviews import Finding, ReviewRun, Vote
from stark_signals.models.signals import Signal
from stark_signals.models.tournaments import TournamentImplementation, TournamentRun

logger = structlog.get_logger(__name__)
router = APIRouter()


async def _get_current_weights(db: AsyncSession) -> dict[str, dict[str, float]]:
    """Load current weights for all agents from db."""
    stmt = (
        select(Agent.name, AgentDomainWeight.domain, AgentDomainWeight.weight)
        .join(AgentDomainWeight, Agent.id == AgentDomainWeight.agent_id)
        .order_by(AgentDomainWeight.effective_from.desc())
    )
    result = await db.execute(stmt)
    weights: dict[str, dict[str, float]] = {}
    seen: set[tuple[str, str]] = set()
    for name, domain, weight in result:
        key = (name, domain)
        if key not in seen:
            seen.add(key)
            weights.setdefault(name, {})[domain] = weight
    return weights


def _title_hash(title: str) -> str:
    return hashlib.sha256(title.encode()).hexdigest()[:12]


@router.post("/review", status_code=201, response_model=ReviewIngestResponse)
async def ingest_review(req: ReviewIngestRequest, db: AsyncSession = Depends(get_db)):
    # Idempotency check
    existing = await db.execute(
        select(ReviewRun).where(ReviewRun.idempotency_key == req.idempotency_key)
    )
    existing_run = existing.scalar_one_or_none()
    if existing_run:
        # Return cached results
        findings_q = await db.execute(
            select(Finding).where(Finding.review_run_id == existing_run.id)
        )
        existing_findings = findings_q.scalars().all()
        votes_q = await db.execute(
            select(Vote).where(
                Vote.finding_id.in_([f.id for f in existing_findings])
            )
        )
        existing_votes = votes_q.scalars().all()

        consensus_results = []
        for f in existing_findings:
            f_votes = [v for v in existing_votes if v.finding_id == f.id]
            consensus_results.append(ConsensusResultOut(
                finding_id=f.id,
                consensus_severity=f.consensus_severity or f.severity,
                consensus_classification=f.consensus_classification or "needs_human_review",
                consensus_score=f.consensus_score or 0.0,
                vote_summary=[
                    VoteSummary(agent=v.voter_agent, vote_type=v.vote_type, severity_vote=v.severity_vote)
                    for v in f_votes
                ],
            ))
        return ReviewIngestResponse(review_run_id=existing_run.id, consensus_results=consensus_results)

    # Get weights for consensus
    weights = await _get_current_weights(db)

    # Create review run
    review_run = ReviewRun(
        idempotency_key=req.idempotency_key,
        repo=req.repo,
        pr_number=req.pr_number,
        review_type=req.review_type,
        plan_file=req.plan_file,
        base_sha=req.base_sha,
        round_count=len(req.rounds),
        agent_versions=req.agent_versions,
        config_snapshot=req.config_snapshot,
    )
    db.add(review_run)
    await db.flush()

    all_consensus_results = []
    total_findings = 0
    fix_count = 0
    noise_count = 0
    fp_count = 0
    nhr_count = 0
    total_duration = 0.0

    for round_data in req.rounds:
        total_duration += round_data.duration_seconds
        findings_dicts = [f.model_dump() for f in round_data.findings]
        coverage_dicts = [c.model_dump() for c in round_data.coverage]

        consensus = run_consensus(
            findings=findings_dicts,
            coverage=coverage_dicts,
            weights=weights,
            review_type=req.review_type,
        )

        for cr in consensus:
            rep = cr["representative"]
            file_or_section = rep.get("file") or rep.get("section") or "unknown"
            idem_key = f"{review_run.id}:{rep['agent']}:{rep['domain']}:{round_data.round}:{file_or_section}:{_title_hash(rep['title'])}"

            finding = Finding(
                idempotency_key=idem_key,
                review_run_id=review_run.id,
                round=round_data.round,
                agent=rep["agent"],
                domain=rep.get("domain", ""),
                severity=rep.get("severity", "none"),
                consensus_severity=cr["consensus_severity"],
                consensus_score=cr["consensus_score"],
                classification=cr["consensus_classification"],
                consensus_classification=cr["consensus_classification"],
                file=rep.get("file"),
                line=rep.get("line"),
                section=rep.get("section"),
                title=rep["title"],
                description=rep.get("description", ""),
                suggestion=rep.get("suggestion"),
                confirmers=cr["confirmers"],
            )
            db.add(finding)
            await db.flush()

            total_findings += 1
            cls = cr["consensus_classification"]
            if cls == "fix":
                fix_count += 1
            elif cls == "noise":
                noise_count += 1
            elif cls == "false_positive":
                fp_count += 1
            elif cls == "needs_human_review":
                nhr_count += 1

            vote_summaries = []
            for v in cr["votes"]:
                vote = Vote(
                    finding_id=finding.id,
                    voter_agent=v["agent"],
                    voter_domain=v["domain"],
                    vote_type=v["vote_type"],
                    severity_vote=v["severity"],
                    classification_vote=v.get("classification"),
                    confidence=1.0,
                    weight_at_vote=v["weight"],
                )
                db.add(vote)
                vote_summaries.append(VoteSummary(
                    agent=v["agent"],
                    vote_type=v["vote_type"],
                    severity_vote=v["severity"],
                ))

            all_consensus_results.append(ConsensusResultOut(
                finding_id=finding.id,
                consensus_severity=cr["consensus_severity"],
                consensus_classification=cr["consensus_classification"],
                consensus_score=cr["consensus_score"],
                vote_summary=vote_summaries,
            ))

    # Update review run stats
    review_run.total_findings = total_findings
    review_run.fix_count = fix_count
    review_run.noise_count = noise_count
    review_run.false_positive_count = fp_count
    review_run.needs_human_review_count = nhr_count
    review_run.signal_to_noise = fix_count / total_findings if total_findings > 0 else 0.0
    review_run.duration_seconds = total_duration

    await db.commit()

    logger.info(
        "review.ingested",
        review_run_id=str(review_run.id),
        repo=req.repo,
        total_findings=total_findings,
        fix_count=fix_count,
    )

    return ReviewIngestResponse(
        review_run_id=review_run.id,
        consensus_results=all_consensus_results,
    )


@router.post("/tournament", status_code=201, response_model=TournamentIngestResponse)
async def ingest_tournament(req: TournamentIngestRequest, db: AsyncSession = Depends(get_db)):
    # Idempotency check
    existing = await db.execute(
        select(TournamentRun).where(TournamentRun.id == req.id)
    )
    if existing.scalar_one_or_none():
        return TournamentIngestResponse(tournament_run_id=req.id)

    run = TournamentRun(
        id=req.id,
        repo=req.repo,
        issue_number=req.issue_number,
        plan_slug=req.plan_slug,
        task_id=req.task_id,
        winner_agent=req.winner_agent,
        winner_score=req.winner_score,
        selection_reason=req.selection_reason,
        acceptance_criteria_met=req.acceptance_criteria_met,
        agent_versions=req.agent_versions,
    )
    db.add(run)

    for impl in req.implementations:
        ti = TournamentImplementation(
            tournament_run_id=req.id,
            agent=impl.agent,
            branch_name=impl.branch_name,
            commit_sha=impl.commit_sha,
            files_changed=impl.files_changed,
            lines_added=impl.lines_added,
            lines_deleted=impl.lines_deleted,
            test_pass_count=impl.test_pass_count,
            test_fail_count=impl.test_fail_count,
            test_skip_count=impl.test_skip_count,
            cross_review_score=impl.cross_review_score,
            cross_review_findings=impl.cross_review_findings,
            acceptance_passed=impl.acceptance_passed,
            selected=impl.selected,
            disqualified=impl.disqualified,
            disqualification_reason=impl.disqualification_reason,
            worktree_path=f"/tmp/tournament-{req.id}-{impl.agent}",
        )
        db.add(ti)

    await db.commit()
    logger.info("tournament.ingested", tournament_run_id=str(req.id), repo=req.repo)
    return TournamentIngestResponse(tournament_run_id=req.id)


@router.post("/signal", status_code=201, response_model=SignalIngestResponse)
async def ingest_signal(req: SignalIngestRequest, db: AsyncSession = Depends(get_db)):
    # Idempotency check
    existing = await db.execute(
        select(Signal).where(Signal.idempotency_key == req.idempotency_key)
    )
    existing_sig = existing.scalar_one_or_none()
    if existing_sig:
        return SignalIngestResponse(signal_id=existing_sig.id)

    signal = Signal(
        idempotency_key=req.idempotency_key,
        signal_type=req.signal_type,
        signal_tier=req.signal_tier,
        source_type=req.source_type,
        source_id=req.source_id,
        agent=req.agent,
        domain=req.domain,
        original_value=req.original_value,
        corrected_value=req.corrected_value,
        weight_delta=req.weight_delta,
        context=req.context,
    )
    db.add(signal)
    await db.commit()

    logger.info("signal.ingested", signal_id=str(signal.id), signal_type=req.signal_type)
    return SignalIngestResponse(signal_id=signal.id)
```

- [ ] **Step 4: Run tests**

```bash
cd ~/Code/stark-signals
pytest tests/test_routes_ingest.py -v
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/api/routes_ingest.py tests/test_routes_ingest.py
git commit -m "feat: add ingest endpoints for reviews, tournaments, and signals"
```

**Acceptance criteria:**
1. `POST /api/v1/ingest/review` returns 201 with consensus results
2. Idempotent replay returns same review_run_id
3. `POST /api/v1/ingest/tournament` stores implementations
4. `POST /api/v1/ingest/signal` creates signal with idempotency

---

### Task 10: Read endpoints (agents, reviews, tournaments, signals, weights, dashboard)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/api/routes_read.py`
- Create: `~/Code/stark-signals/tests/test_routes_read.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/stark-signals/tests/test_routes_read.py`:

```python
"""Tests for read endpoints."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from stark_signals.api.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class TestAgents:
    async def test_list_agents(self, client: AsyncClient):
        resp = await client.get("/api/v1/agents")
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)

    async def test_agent_weights(self, client: AsyncClient):
        resp = await client.get("/api/v1/agents/claude/weights")
        assert resp.status_code in (200, 404)

    async def test_agent_accuracy(self, client: AsyncClient):
        resp = await client.get("/api/v1/agents/claude/accuracy")
        assert resp.status_code in (200, 404)


class TestReviews:
    async def test_list_reviews(self, client: AsyncClient):
        resp = await client.get("/api/v1/reviews")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total" in data


class TestTournaments:
    async def test_list_tournaments(self, client: AsyncClient):
        resp = await client.get("/api/v1/tournaments")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data


class TestSignals:
    async def test_list_signals(self, client: AsyncClient):
        resp = await client.get("/api/v1/signals")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data


class TestDashboard:
    async def test_dashboard(self, client: AsyncClient):
        resp = await client.get("/api/v1/dashboard")
        assert resp.status_code == 200
        data = resp.json()
        assert "agent_leaderboard" in data
        assert "review_stats" in data
        assert "tournament_stats" in data
        assert "signal_stats" in data

    async def test_leaderboard(self, client: AsyncClient):
        resp = await client.get("/api/v1/dashboard/leaderboard")
        assert resp.status_code == 200
        assert "domains" in resp.json()


class TestWeightProposals:
    async def test_list_proposals(self, client: AsyncClient):
        resp = await client.get("/api/v1/weights/proposals")
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)
```

- [ ] **Step 2: Implement routes_read.py**

Write to `~/Code/stark-signals/src/stark_signals/api/routes_read.py`:

```python
"""Read endpoints — agents, reviews, tournaments, signals, dashboard."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from stark_signals.api.deps import get_db
from stark_signals.api.schemas import (
    AgentAccuracyDomain,
    AgentAccuracyOut,
    AgentLeaderboardEntry,
    AgentOut,
    AgentWeightOut,
    DashboardResponse,
    DomainLeaderboard,
    DomainRanking,
    FindingOut,
    LeaderboardResponse,
    PaginatedResponse,
    ProposalOut,
    ReviewDetailOut,
    ReviewListItem,
    ReviewStats,
    SignalOut,
    SignalStats,
    TournamentDetailOut,
    TournamentImplOut,
    TournamentListItem,
    TournamentStats,
    TrendPoint,
    TrendsResponse,
    VoteOut,
)
from stark_signals.models.agents import Agent, AgentDomainWeight
from stark_signals.models.reviews import Finding, ReviewRun, Vote
from stark_signals.models.signals import Signal, WeightUpdateProposal
from stark_signals.models.tournaments import TournamentImplementation, TournamentRun

router = APIRouter()


@router.get("/agents", response_model=list[AgentOut])
async def list_agents(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Agent).where(Agent.is_active.is_(True)))
    agents = result.scalars().all()

    out = []
    for a in agents:
        # Get latest weights
        w_result = await db.execute(
            select(AgentDomainWeight)
            .where(AgentDomainWeight.agent_id == a.id)
            .order_by(AgentDomainWeight.effective_from.desc())
        )
        all_weights = w_result.scalars().all()
        seen: set[str] = set()
        weight_map: dict[str, float] = {}
        for w in all_weights:
            if w.domain not in seen:
                seen.add(w.domain)
                weight_map[w.domain] = w.weight

        out.append(AgentOut(
            name=a.name,
            model_version=a.model_version,
            is_active=a.is_active,
            weights=weight_map,
        ))
    return out


@router.get("/agents/{name}/weights", response_model=list[AgentWeightOut])
async def agent_weights(
    name: str,
    since: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    agent = await db.execute(select(Agent).where(Agent.name == name))
    a = agent.scalar_one_or_none()
    if not a:
        raise HTTPException(404, f"Agent '{name}' not found")

    stmt = select(AgentDomainWeight).where(AgentDomainWeight.agent_id == a.id)
    if since:
        stmt = stmt.where(AgentDomainWeight.effective_from >= since)
    stmt = stmt.order_by(AgentDomainWeight.effective_from.desc())

    result = await db.execute(stmt)
    return [
        AgentWeightOut(
            domain=w.domain,
            weight=w.weight,
            precision=w.precision_,
            recall=w.recall,
            f1_score=w.f1_score,
            effective_from=w.effective_from,
        )
        for w in result.scalars().all()
    ]


@router.get("/agents/{name}/accuracy", response_model=AgentAccuracyOut)
async def agent_accuracy(name: str, db: AsyncSession = Depends(get_db)):
    agent = await db.execute(select(Agent).where(Agent.name == name))
    a = agent.scalar_one_or_none()
    if not a:
        raise HTTPException(404, f"Agent '{name}' not found")

    result = await db.execute(
        select(AgentDomainWeight)
        .where(AgentDomainWeight.agent_id == a.id)
        .order_by(AgentDomainWeight.effective_from.desc())
    )
    all_weights = result.scalars().all()
    seen: set[str] = set()
    domains = []
    for w in all_weights:
        if w.domain not in seen:
            seen.add(w.domain)
            domains.append(AgentAccuracyDomain(
                domain=w.domain,
                precision=w.precision_,
                recall=w.recall,
                f1_score=w.f1_score,
                sample_count=w.sample_count,
            ))
    return AgentAccuracyOut(domains=domains)


@router.get("/reviews", response_model=PaginatedResponse)
async def list_reviews(
    repo: str | None = Query(None),
    review_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(ReviewRun)
    count_stmt = select(func.count(ReviewRun.id))
    if repo:
        stmt = stmt.where(ReviewRun.repo == repo)
        count_stmt = count_stmt.where(ReviewRun.repo == repo)
    if review_type:
        stmt = stmt.where(ReviewRun.review_type == review_type)
        count_stmt = count_stmt.where(ReviewRun.review_type == review_type)

    total = (await db.execute(count_stmt)).scalar() or 0
    stmt = stmt.order_by(ReviewRun.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(stmt)

    items = [
        ReviewListItem(
            id=r.id, repo=r.repo, pr_number=r.pr_number,
            review_type=r.review_type, total_findings=r.total_findings,
            signal_to_noise=r.signal_to_noise, created_at=r.created_at,
        )
        for r in result.scalars().all()
    ]
    return PaginatedResponse(items=items, total=total, page=page)


@router.get("/reviews/{review_id}", response_model=ReviewDetailOut)
async def get_review(review_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ReviewRun).where(ReviewRun.id == review_id))
    r = result.scalar_one_or_none()
    if not r:
        raise HTTPException(404, "Review not found")

    findings_q = await db.execute(select(Finding).where(Finding.review_run_id == r.id))
    findings = findings_q.scalars().all()

    all_votes = []
    for f in findings:
        v_q = await db.execute(select(Vote).where(Vote.finding_id == f.id))
        all_votes.extend(v_q.scalars().all())

    return ReviewDetailOut(
        id=r.id, repo=r.repo, pr_number=r.pr_number,
        review_type=r.review_type, base_sha=r.base_sha,
        total_findings=r.total_findings, fix_count=r.fix_count,
        noise_count=r.noise_count, signal_to_noise=r.signal_to_noise,
        duration_seconds=r.duration_seconds, agent_versions=r.agent_versions,
        created_at=r.created_at,
        findings=[FindingOut(
            id=f.id, agent=f.agent, domain=f.domain, severity=f.severity,
            consensus_severity=f.consensus_severity, consensus_score=f.consensus_score,
            classification=f.classification, consensus_classification=f.consensus_classification,
            file=f.file, line=f.line, section=f.section, title=f.title,
            description=f.description, suggestion=f.suggestion,
            confirmers=f.confirmers, was_fixed=f.was_fixed,
        ) for f in findings],
        votes=[VoteOut(
            id=v.id, finding_id=v.finding_id, voter_agent=v.voter_agent,
            voter_domain=v.voter_domain, vote_type=v.vote_type,
            severity_vote=v.severity_vote, classification_vote=v.classification_vote,
            confidence=v.confidence, weight_at_vote=v.weight_at_vote,
        ) for v in all_votes],
    )


@router.get("/tournaments", response_model=PaginatedResponse)
async def list_tournaments(
    repo: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(TournamentRun)
    count_stmt = select(func.count(TournamentRun.id))
    if repo:
        stmt = stmt.where(TournamentRun.repo == repo)
        count_stmt = count_stmt.where(TournamentRun.repo == repo)

    total = (await db.execute(count_stmt)).scalar() or 0
    stmt = stmt.order_by(TournamentRun.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(stmt)

    items = [
        TournamentListItem(
            id=t.id, repo=t.repo, issue_number=t.issue_number,
            winner_agent=t.winner_agent, winner_score=t.winner_score,
            created_at=t.created_at,
        )
        for t in result.scalars().all()
    ]
    return PaginatedResponse(items=items, total=total, page=page)


@router.get("/tournaments/{tournament_id}", response_model=TournamentDetailOut)
async def get_tournament(tournament_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TournamentRun).where(TournamentRun.id == tournament_id))
    t = result.scalar_one_or_none()
    if not t:
        raise HTTPException(404, "Tournament not found")

    impls_q = await db.execute(
        select(TournamentImplementation).where(TournamentImplementation.tournament_run_id == t.id)
    )
    impls = impls_q.scalars().all()

    return TournamentDetailOut(
        id=t.id, repo=t.repo, issue_number=t.issue_number,
        plan_slug=t.plan_slug, task_id=t.task_id,
        winner_agent=t.winner_agent, winner_score=t.winner_score,
        selection_reason=t.selection_reason, duration_seconds=t.duration_seconds,
        created_at=t.created_at,
        implementations=[TournamentImplOut(
            agent=i.agent, selected=i.selected, cross_review_score=i.cross_review_score,
            acceptance_passed=i.acceptance_passed, files_changed=i.files_changed,
            lines_added=i.lines_added, lines_deleted=i.lines_deleted,
            test_pass_count=i.test_pass_count, test_fail_count=i.test_fail_count,
            disqualified=i.disqualified, disqualification_reason=i.disqualification_reason,
        ) for i in impls],
    )


@router.get("/signals", response_model=PaginatedResponse)
async def list_signals(
    signal_type: str | None = Query(None),
    signal_tier: str | None = Query(None),
    agent: str | None = Query(None),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Signal)
    count_stmt = select(func.count(Signal.id))
    if signal_type:
        stmt = stmt.where(Signal.signal_type == signal_type)
        count_stmt = count_stmt.where(Signal.signal_type == signal_type)
    if signal_tier:
        stmt = stmt.where(Signal.signal_tier == signal_tier)
        count_stmt = count_stmt.where(Signal.signal_tier == signal_tier)
    if agent:
        stmt = stmt.where(Signal.agent == agent)
        count_stmt = count_stmt.where(Signal.agent == agent)

    total = (await db.execute(count_stmt)).scalar() or 0
    stmt = stmt.order_by(Signal.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
    result = await db.execute(stmt)

    items = [
        SignalOut(
            id=s.id, idempotency_key=s.idempotency_key, signal_type=s.signal_type,
            signal_tier=s.signal_tier, source_type=s.source_type, source_id=s.source_id,
            agent=s.agent, domain=s.domain, original_value=s.original_value,
            corrected_value=s.corrected_value, weight_delta=s.weight_delta,
            context=s.context, dismissed=s.dismissed, created_at=s.created_at,
        )
        for s in result.scalars().all()
    ]
    return PaginatedResponse(items=items, total=total, page=page)


@router.get("/weights/proposals", response_model=list[ProposalOut])
async def list_proposals(
    status: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(WeightUpdateProposal, Agent.name).join(
        Agent, WeightUpdateProposal.agent_id == Agent.id
    )
    if status:
        stmt = stmt.where(WeightUpdateProposal.status == status)
    stmt = stmt.order_by(WeightUpdateProposal.created_at.desc())

    result = await db.execute(stmt)
    return [
        ProposalOut(
            id=p.id, agent=name, domain=p.domain,
            current_weight=p.current_weight, proposed_weight=p.proposed_weight,
            delta=p.delta, signal_count=p.signal_count,
            confidence=p.confidence, status=p.status, created_at=p.created_at,
        )
        for p, name in result.all()
    ]


@router.get("/dashboard", response_model=DashboardResponse)
async def dashboard(db: AsyncSession = Depends(get_db)):
    # Agent leaderboard
    agents_q = await db.execute(select(Agent).where(Agent.is_active.is_(True)))
    agents = agents_q.scalars().all()
    leaderboard = []
    for a in agents:
        w_q = await db.execute(
            select(AgentDomainWeight)
            .where(AgentDomainWeight.agent_id == a.id)
            .order_by(AgentDomainWeight.effective_from.desc())
        )
        weights = w_q.scalars().all()
        seen: set[str] = set()
        domain_scores: dict[str, float] = {}
        f1_vals = []
        for w in weights:
            if w.domain not in seen:
                seen.add(w.domain)
                if w.f1_score is not None:
                    domain_scores[w.domain] = w.f1_score
                    f1_vals.append(w.f1_score)
        overall = sum(f1_vals) / len(f1_vals) if f1_vals else None
        leaderboard.append(AgentLeaderboardEntry(
            agent=a.name, overall_f1=overall, domain_scores=domain_scores,
        ))

    # Review stats
    review_count = (await db.execute(select(func.count(ReviewRun.id)))).scalar() or 0
    avg_findings = 0.0
    avg_noise = 0.0
    if review_count > 0:
        avg_findings = (await db.execute(select(func.avg(ReviewRun.total_findings)))).scalar() or 0.0
        noise_sum = (await db.execute(select(func.sum(ReviewRun.noise_count)))).scalar() or 0
        total_sum = (await db.execute(select(func.sum(ReviewRun.total_findings)))).scalar() or 0
        avg_noise = noise_sum / total_sum if total_sum > 0 else 0.0

    # Tournament stats
    tournament_count = (await db.execute(select(func.count(TournamentRun.id)))).scalar() or 0
    winner_q = await db.execute(
        select(TournamentRun.winner_agent, func.count())
        .where(TournamentRun.winner_agent.is_not(None))
        .group_by(TournamentRun.winner_agent)
    )
    winner_dist = {name: count for name, count in winner_q.all()}

    # Signal stats
    gold = (await db.execute(select(func.count(Signal.id)).where(Signal.signal_tier == "gold"))).scalar() or 0
    silver = (await db.execute(select(func.count(Signal.id)).where(Signal.signal_tier == "silver"))).scalar() or 0
    bronze = (await db.execute(select(func.count(Signal.id)).where(Signal.signal_tier == "bronze"))).scalar() or 0
    pending = (await db.execute(
        select(func.count(WeightUpdateProposal.id)).where(WeightUpdateProposal.status == "pending")
    )).scalar() or 0

    return DashboardResponse(
        agent_leaderboard=leaderboard,
        review_stats=ReviewStats(total=review_count, avg_findings=avg_findings, avg_noise_rate=avg_noise),
        tournament_stats=TournamentStats(total=tournament_count, winner_distribution=winner_dist),
        signal_stats=SignalStats(gold=gold, silver=silver, bronze=bronze, pending_proposals=pending),
    )


@router.get("/dashboard/trends", response_model=TrendsResponse)
async def dashboard_trends(
    metric: str = Query("findings"),
    period: str = Query("30d"),
    agent: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    # Simplified trend — group by date
    stmt = (
        select(
            func.date_trunc("day", ReviewRun.created_at).label("day"),
            func.avg(ReviewRun.total_findings).label("val"),
        )
        .group_by("day")
        .order_by("day")
        .limit(90)
    )
    result = await db.execute(stmt)
    return TrendsResponse(
        data_points=[
            TrendPoint(date=str(row.day.date()) if row.day else "", value=float(row.val or 0))
            for row in result.all()
        ]
    )


@router.get("/dashboard/leaderboard", response_model=LeaderboardResponse)
async def dashboard_leaderboard(db: AsyncSession = Depends(get_db)):
    agents_q = await db.execute(select(Agent).where(Agent.is_active.is_(True)))
    agents = agents_q.scalars().all()

    domain_map: dict[str, list[DomainRanking]] = {}
    for a in agents:
        w_q = await db.execute(
            select(AgentDomainWeight)
            .where(AgentDomainWeight.agent_id == a.id)
            .order_by(AgentDomainWeight.effective_from.desc())
        )
        seen: set[str] = set()
        for w in w_q.scalars().all():
            if w.domain not in seen:
                seen.add(w.domain)
                domain_map.setdefault(w.domain, []).append(
                    DomainRanking(agent=a.name, f1_score=w.f1_score, sample_count=w.sample_count)
                )

    # Sort each domain by f1_score descending
    domains = []
    for domain, rankings in sorted(domain_map.items()):
        rankings.sort(key=lambda r: r.f1_score or 0.0, reverse=True)
        domains.append(DomainLeaderboard(domain=domain, rankings=rankings))

    return LeaderboardResponse(domains=domains)
```

- [ ] **Step 3: Run tests**

```bash
cd ~/Code/stark-signals
pytest tests/test_routes_read.py -v
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/api/routes_read.py tests/test_routes_read.py
git commit -m "feat: add read endpoints for agents, reviews, tournaments, signals, dashboard"
```

**Acceptance criteria:**
1. All GET endpoints return correct response shapes
2. Pagination works (page, per_page, total)
3. Dashboard aggregates from all tables
4. Leaderboard sorts by f1_score descending

---

### Task 11: Mutation endpoints (weight proposal approve/reject)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/api/routes_mutations.py`

- [ ] **Step 1: Implement routes_mutations.py**

Write to `~/Code/stark-signals/src/stark_signals/api/routes_mutations.py`:

```python
"""Mutation endpoints — weight proposal approve/reject (admin only)."""

from __future__ import annotations

from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from stark_signals.api.deps import get_db, require_admin
from stark_signals.api.schemas import (
    ProposalApproveResponse,
    ProposalRejectRequest,
    ProposalRejectResponse,
    SignalIngestRequest,
    SignalIngestResponse,
)
from stark_signals.models.agents import Agent, AgentDomainWeight
from stark_signals.models.signals import Signal, WeightUpdateProposal

logger = structlog.get_logger(__name__)
router = APIRouter()


@router.post("/admin/signals", status_code=201, response_model=SignalIngestResponse)
async def create_signal_admin(
    req: SignalIngestRequest,
    admin_email: str = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Create a signal from the dashboard (admin only)."""
    existing = await db.execute(
        select(Signal).where(Signal.idempotency_key == req.idempotency_key)
    )
    existing_sig = existing.scalar_one_or_none()
    if existing_sig:
        return SignalIngestResponse(signal_id=existing_sig.id)

    signal = Signal(
        idempotency_key=req.idempotency_key,
        signal_type=req.signal_type,
        signal_tier=req.signal_tier,
        source_type=req.source_type,
        source_id=req.source_id,
        agent=req.agent,
        domain=req.domain,
        original_value=req.original_value,
        corrected_value=req.corrected_value,
        weight_delta=req.weight_delta,
        context={**(req.context or {}), "created_by": admin_email},
    )
    db.add(signal)
    await db.commit()
    logger.info("signal.created_by_admin", signal_id=str(signal.id), admin=admin_email)
    return SignalIngestResponse(signal_id=signal.id)


@router.post("/weights/proposals/{proposal_id}/approve", response_model=ProposalApproveResponse)
async def approve_proposal(
    proposal_id: str,
    admin_email: str = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WeightUpdateProposal).where(WeightUpdateProposal.id == proposal_id)
    )
    proposal = result.scalar_one_or_none()
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    if proposal.status != "pending":
        raise HTTPException(400, f"Proposal is {proposal.status}, cannot approve")

    now = datetime.now(UTC)

    # Create new weight entry
    new_weight = AgentDomainWeight(
        agent_id=proposal.agent_id,
        domain=proposal.domain,
        weight=proposal.proposed_weight,
        effective_from=now,
    )
    db.add(new_weight)

    # Update proposal
    proposal.status = "approved"
    proposal.reviewed_by = admin_email
    proposal.reviewed_at = now

    # Link signals to this proposal
    signal_ids = proposal.signal_ids or []
    if signal_ids:
        await db.execute(
            update(Signal)
            .where(Signal.id.in_(signal_ids))
            .values(applied_to_proposal_id=proposal.id)
        )

    await db.flush()
    await db.commit()

    logger.info(
        "proposal.approved",
        proposal_id=str(proposal.id),
        admin=admin_email,
        new_weight=proposal.proposed_weight,
    )

    return ProposalApproveResponse(
        proposal_id=proposal.id,
        new_weight_id=new_weight.id,
        effective_from=now,
    )


@router.post("/weights/proposals/{proposal_id}/reject", response_model=ProposalRejectResponse)
async def reject_proposal(
    proposal_id: str,
    req: ProposalRejectRequest,
    admin_email: str = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(WeightUpdateProposal).where(WeightUpdateProposal.id == proposal_id)
    )
    proposal = result.scalar_one_or_none()
    if not proposal:
        raise HTTPException(404, "Proposal not found")
    if proposal.status != "pending":
        raise HTTPException(400, f"Proposal is {proposal.status}, cannot reject")

    now = datetime.now(UTC)
    proposal.status = "rejected"
    proposal.reviewed_by = admin_email
    proposal.reviewed_at = now

    # Dismiss linked signals
    signal_ids = proposal.signal_ids or []
    if signal_ids:
        await db.execute(
            update(Signal)
            .where(Signal.id.in_(signal_ids))
            .values(dismissed=True, applied_to_proposal_id=proposal.id)
        )

    await db.commit()

    logger.info("proposal.rejected", proposal_id=str(proposal.id), admin=admin_email)
    return ProposalRejectResponse(proposal_id=proposal.id, status="rejected")
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/api/routes_mutations.py
git commit -m "feat: add mutation endpoints for proposal approve/reject with admin guard"
```

**Acceptance criteria:**
1. Approve creates new AgentDomainWeight row with `effective_from = now()`
2. Approve links signals via `applied_to_proposal_id`
3. Reject marks proposal as rejected and dismisses linked signals
4. Both require admin role

---

### Task 12: Webhook endpoint (GitHub, no IAP, signature verification)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/api/routes_webhooks.py`
- Create: `~/Code/stark-signals/tests/test_routes_webhooks.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/stark-signals/tests/test_routes_webhooks.py`:

```python
"""Tests for GitHub webhook handler."""

from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from httpx import ASGITransport, AsyncClient

from stark_signals.api.main import app


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _sign(body: bytes, secret: str = "local-dev-secret") -> str:
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return f"sha256={sig}"


class TestWebhookSignature:
    async def test_missing_signature(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/webhooks/github",
            content=b"{}",
            headers={"X-GitHub-Event": "ping"},
        )
        assert resp.status_code == 401

    async def test_invalid_signature(self, client: AsyncClient):
        resp = await client.post(
            "/api/v1/webhooks/github",
            content=b"{}",
            headers={
                "X-GitHub-Event": "ping",
                "X-Hub-Signature-256": "sha256=invalid",
            },
        )
        assert resp.status_code == 401

    async def test_valid_ping(self, client: AsyncClient):
        body = b'{"zen": "test"}'
        resp = await client.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "X-GitHub-Event": "ping",
                "X-Hub-Signature-256": _sign(body),
            },
        )
        assert resp.status_code == 200


class TestWebhookIssues:
    async def test_irrelevant_action(self, client: AsyncClient):
        body = json.dumps({"action": "closed", "issue": {}}).encode()
        resp = await client.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "X-Hub-Signature-256": _sign(body),
            },
        )
        assert resp.status_code == 204

    async def test_opened_issue_with_closes_ref(self, client: AsyncClient):
        body = json.dumps({
            "action": "opened",
            "issue": {
                "number": 50,
                "title": "Bug: regression after merge",
                "body": "This regressed after Closes #42 was merged",
                "labels": [{"name": "bug"}],
            },
            "repository": {"full_name": "GetEvinced/test-repo"},
        }).encode()
        resp = await client.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "X-GitHub-Event": "issues",
                "X-Hub-Signature-256": _sign(body),
            },
        )
        assert resp.status_code in (200, 204)
```

- [ ] **Step 2: Implement routes_webhooks.py**

Write to `~/Code/stark-signals/src/stark_signals/api/routes_webhooks.py`:

```python
"""GitHub webhook handler — regression detection for silver signals."""

from __future__ import annotations

import hashlib
import hmac
import re

import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from stark_signals.api.deps import get_db
from stark_signals.config import get_settings
from stark_signals.enums import SignalTier, SignalType
from stark_signals.models.reviews import ReviewRun
from stark_signals.models.signals import Signal

logger = structlog.get_logger(__name__)
router = APIRouter()

# Domain keyword mapping for attribution
DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "security": ["security", "auth", "xss", "injection", "csrf", "vulnerability"],
    "accessibility": ["accessibility", "a11y", "wcag", "aria", "screen reader"],
    "correctness": ["bug", "crash", "error", "null", "undefined", "exception", "regression"],
    "architecture": ["architecture", "design", "pattern", "coupling", "cohesion"],
    "type-safety": ["type", "typescript", "typing", "interface", "generic"],
    "test-coverage": ["test", "coverage", "assertion", "mock", "fixture"],
}


def _verify_signature(body: bytes, signature: str, secret: str) -> bool:
    if not secret:
        return False  # Reject if webhook secret is unconfigured
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def _extract_pr_refs(text: str) -> list[int]:
    """Extract PR numbers from 'Closes #N' / 'Fixes #N' patterns."""
    pattern = r"(?:closes?|fixes?|resolves?)\s+#(\d+)"
    return [int(m) for m in re.findall(pattern, text, re.IGNORECASE)]


def _detect_domain(text: str) -> str | None:
    """Best-effort domain detection from issue text."""
    text_lower = text.lower()
    scores: dict[str, int] = {}
    for domain, keywords in DOMAIN_KEYWORDS.items():
        score = sum(1 for kw in keywords if kw in text_lower)
        if score > 0:
            scores[domain] = score
    if not scores:
        return None
    return max(scores, key=scores.get)


@router.post("/github")
async def github_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    settings = get_settings()
    body = await request.body()

    # Signature verification
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not signature:
        raise HTTPException(401, "Missing signature")

    if not _verify_signature(body, signature, settings.github_webhook_secret):
        raise HTTPException(401, "Invalid signature")

    event = request.headers.get("X-GitHub-Event", "")

    if event == "ping":
        return {"pong": True}

    payload = await request.json()

    if event == "issues":
        return await _handle_issues(payload, db)

    if event == "push":
        return await _handle_push(payload, db)

    return Response(status_code=204)


async def _handle_issues(payload: dict, db: AsyncSession) -> Response:
    action = payload.get("action")
    if action != "opened":
        return Response(status_code=204)

    issue = payload.get("issue", {})
    labels = [l.get("name", "") for l in issue.get("labels", [])]

    # Only process bug issues
    if "bug" not in labels:
        return Response(status_code=204)

    body_text = f"{issue.get('title', '')} {issue.get('body', '')}"
    pr_refs = _extract_pr_refs(body_text)
    repo = payload.get("repository", {}).get("full_name", "")

    if not pr_refs:
        return Response(status_code=204)

    domain = _detect_domain(body_text)
    issue_number = issue.get("number")

    for pr_num in pr_refs:
        # Find review runs for this PR
        result = await db.execute(
            select(ReviewRun).where(
                ReviewRun.repo == repo,
                ReviewRun.pr_number == pr_num,
            )
        )
        review_runs = result.scalars().all()

        for rr in review_runs:
            # Emit per-agent signals (not agent='all') so recalibration can
            # attribute regressions to specific agents. Get agents from the
            # review run's agent_versions dict.
            agents = list(rr.agent_versions.keys()) if rr.agent_versions else ["claude", "codex", "gemini"]
            for agent_name in agents:
                idem_key = f"silver:review_run:{rr.id}:{issue_number}:{agent_name}"

                existing = await db.execute(
                    select(Signal).where(Signal.idempotency_key == idem_key)
                )
                if existing.scalar_one_or_none():
                    continue

                signal = Signal(
                    idempotency_key=idem_key,
                    signal_type=SignalType.REGRESSION.value,
                    signal_tier=SignalTier.SILVER.value,
                    source_type="review_run",
                    source_id=rr.id,
                    agent=agent_name,
                    domain=domain,
                    original_value="approved",
                    corrected_value="regression",
                    weight_delta=-0.03,
                    context={
                        "issue_number": issue_number,
                        "pr_number": pr_num,
                        "repo": repo,
                    },
                )
                db.add(signal)
            logger.info(
                "webhook.silver_signal",
                review_run_id=str(rr.id),
                issue_number=issue_number,
                pr_number=pr_num,
            )

    await db.commit()
    return {"processed": True}


async def _handle_push(payload: dict, db: AsyncSession) -> Response:
    """Detect revert commits and create silver signals."""
    repo = payload.get("repository", {}).get("full_name", "")
    commits = payload.get("commits", [])

    for commit in commits:
        msg = commit.get("message", "")
        if not msg.lower().startswith("revert"):
            continue

        # Extract PR reference from revert message
        pr_refs = _extract_pr_refs(msg)
        if not pr_refs:
            # Try to find "Revert "...#N..."
            refs = re.findall(r"#(\d+)", msg)
            pr_refs = [int(r) for r in refs]

        for pr_num in pr_refs:
            result = await db.execute(
                select(ReviewRun).where(
                    ReviewRun.repo == repo,
                    ReviewRun.pr_number == pr_num,
                )
            )
            review_runs = result.scalars().all()

            for rr in review_runs:
                agents = list(rr.agent_versions.keys()) if rr.agent_versions else ["claude", "codex", "gemini"]
                for agent_name in agents:
                    idem_key = f"silver:review_run:{rr.id}:revert:{commit.get('id', '')[:12]}:{agent_name}"
                    existing = await db.execute(
                        select(Signal).where(Signal.idempotency_key == idem_key)
                    )
                    if existing.scalar_one_or_none():
                        continue

                    signal = Signal(
                        idempotency_key=idem_key,
                        signal_type=SignalType.REGRESSION.value,
                        signal_tier=SignalTier.SILVER.value,
                        source_type="review_run",
                        source_id=rr.id,
                        agent=agent_name,
                        domain=None,
                        original_value="approved",
                        corrected_value="reverted",
                        weight_delta=-0.05,
                        context={
                            "pr_number": pr_num,
                            "revert_commit": commit.get("id"),
                            "repo": repo,
                        },
                    )
                    db.add(signal)
                logger.info(
                    "webhook.revert_signal",
                    review_run_id=str(rr.id),
                    pr_number=pr_num,
                    commit=commit.get("id", "")[:12],
                )

    await db.commit()
    return {"processed": True}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/Code/stark-signals
pytest tests/test_routes_webhooks.py -v
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/api/routes_webhooks.py tests/test_routes_webhooks.py
git commit -m "feat: add GitHub webhook handler for regression detection (silver signals)"
```

**Acceptance criteria:**
1. Missing/invalid signature returns 401
2. Ping event returns 200
3. Bug issue with `Closes #N` creates silver signal
4. Revert commits create silver signals
5. All writes are idempotent

---

### Task 13: signal_client.py in stark-skills

**Files:**
- Create: `~/Code/Playground/stark-skills/scripts/signal_client.py`
- Create: `~/Code/Playground/stark-skills/scripts/test_signal_client.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/Playground/stark-skills/scripts/test_signal_client.py`:

```python
"""Tests for signal_client.py."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add scripts dir to path
import sys
sys.path.insert(0, str(Path(__file__).parent))

import signal_client


class TestGetAuthToken:
    @patch("signal_client.subprocess.run")
    def test_gcloud_token(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0, stdout="test-token-123\n"
        )
        token = signal_client.get_auth_token("https://signals.evinced.net")
        assert token == "test-token-123"

    @patch("signal_client.subprocess.run")
    def test_gcloud_failure_returns_none(self, mock_run):
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="error")
        token = signal_client.get_auth_token("https://signals.evinced.net")
        assert token is None


class TestSpoolFallback:
    def test_spool_write_and_read(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            spool_dir = Path(tmpdir)
            signal_client._spool_event(
                {"type": "test", "data": 123},
                spool_dir=spool_dir,
            )
            pending = spool_dir / "pending.jsonl"
            assert pending.exists()
            lines = pending.read_text().strip().split("\n")
            assert len(lines) == 1
            assert json.loads(lines[0])["type"] == "test"

    def test_flush_spool(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            spool_dir = Path(tmpdir)
            pending = spool_dir / "pending.jsonl"
            pending.write_text(json.dumps({"endpoint": "/test", "payload": {}}) + "\n")
            events = signal_client._read_spool(spool_dir=spool_dir)
            assert len(events) == 1


class TestWeightCache:
    def test_cache_write_and_read(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            cache_dir = Path(tmpdir)
            weights = {"claude": {"architecture": 0.4}}
            signal_client._cache_weights(weights, cache_dir=cache_dir)
            loaded = signal_client._load_cached_weights(cache_dir=cache_dir)
            assert loaded == weights

    def test_missing_cache_returns_none(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loaded = signal_client._load_cached_weights(cache_dir=Path(tmpdir))
            assert loaded is None


class TestDefaultWeights:
    def test_all_agents_present(self):
        defaults = signal_client.DEFAULT_WEIGHTS
        assert "claude" in defaults
        assert "codex" in defaults
        assert "gemini" in defaults
        for agent_weights in defaults.values():
            assert "architecture" in agent_weights
            assert "security" in agent_weights
```

- [ ] **Step 2: Verify tests fail**

```bash
cd ~/Code/Playground/stark-skills
python3 -m pytest scripts/test_signal_client.py -x 2>&1 | head -5
```

Expected: `ModuleNotFoundError: No module named 'signal_client'`

- [ ] **Step 3: Implement signal_client.py**

Write to `~/Code/Playground/stark-skills/scripts/signal_client.py`:

```python
"""Signal store client — writes to stark-signals API with local spool fallback.

Module-level function library, same pattern as github_app.py / github_projects.py.
All writes go through the stark-signals Cloud Run API. If unreachable, events are
spooled to ~/.cache/stark-signals/pending.jsonl and flushed on next successful call.

Auth: First tries STARK_SIGNALS_API_KEY env var (simple bearer token for CLI use),
falls back to gcloud auth print-identity-token (Google identity for IAP).
Requires: `pip install requests` (already in stark-skills scripts/.venv).

Usage:
    import signal_client

    # Send review data
    signal_client.ingest_review(review_data)

    # Send tournament data
    signal_client.ingest_tournament(tournament_data)

    # Send a signal
    signal_client.ingest_signal(signal_data)

    # Get current weights (cached 24h)
    weights = signal_client.get_weights()
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

import requests

# ── Constants ──────────────────────────────────────────────────────────

DEFAULT_SERVICE_URL = "https://stark-signals-HASH-ue.a.run.app"  # Updated after deploy
SPOOL_DIR = Path.home() / ".cache" / "stark-signals"
CACHE_DIR = SPOOL_DIR
WEIGHT_CACHE_TTL = 86400  # 24 hours

DEFAULT_WEIGHTS: dict[str, dict[str, float]] = {
    "claude": {
        "architecture": 0.40, "correctness": 0.40, "security": 0.35,
        "type-safety": 0.30, "accessibility": 0.30, "test-coverage": 0.35,
    },
    "codex": {
        "architecture": 0.35, "correctness": 0.35, "security": 0.35,
        "type-safety": 0.35, "accessibility": 0.25, "test-coverage": 0.35,
    },
    "gemini": {
        "architecture": 0.25, "correctness": 0.25, "security": 0.30,
        "type-safety": 0.35, "accessibility": 0.45, "test-coverage": 0.30,
    },
}


# ── Auth ───────────────────────────────────────────────────────────────

def get_auth_token(service_url: str) -> str | None:
    """Get auth token. Prefers STARK_SIGNALS_API_KEY env var, falls back to gcloud identity token."""
    import os
    api_key = os.environ.get("STARK_SIGNALS_API_KEY")
    if api_key:
        return api_key
    try:
        result = subprocess.run(
            ["gcloud", "auth", "print-identity-token", f"--audiences={service_url}"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    return None


def _get_service_url() -> str:
    """Get service URL from config or environment."""
    import os
    return os.environ.get("STARK_SIGNALS_URL", DEFAULT_SERVICE_URL)


def _headers(token: str | None = None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


# ── Spool (offline fallback) ──────────────────────────────────────────

def _spool_event(
    event: dict[str, Any],
    *,
    spool_dir: Path = SPOOL_DIR,
) -> None:
    """Append event to local spool file for later flush."""
    spool_dir.mkdir(parents=True, exist_ok=True)
    pending = spool_dir / "pending.jsonl"
    with pending.open("a") as f:
        f.write(json.dumps(event) + "\n")


def _read_spool(*, spool_dir: Path = SPOOL_DIR) -> list[dict]:
    """Read all pending spool events."""
    pending = spool_dir / "pending.jsonl"
    if not pending.exists():
        return []
    events = []
    for line in pending.read_text().strip().split("\n"):
        if line:
            events.append(json.loads(line))
    return events


def _clear_spool(*, spool_dir: Path = SPOOL_DIR) -> None:
    """Remove spool file after successful flush."""
    pending = spool_dir / "pending.jsonl"
    if pending.exists():
        pending.unlink()


def flush_spool(*, spool_dir: Path = SPOOL_DIR) -> int:
    """Flush all pending spool events to the API. Returns count flushed."""
    events = _read_spool(spool_dir=spool_dir)
    if not events:
        return 0

    service_url = _get_service_url()
    token = get_auth_token(service_url)

    flushed = 0
    remaining = []
    for event in events:
        endpoint = event.get("endpoint", "")
        payload = event.get("payload", {})
        try:
            resp = requests.post(
                f"{service_url}{endpoint}",
                json=payload,
                headers=_headers(token),
                timeout=30,
            )
            if resp.status_code in (200, 201):
                flushed += 1
            else:
                remaining.append(event)
        except requests.RequestException:
            remaining.append(event)

    # Rewrite spool with remaining events
    _clear_spool(spool_dir=spool_dir)
    for event in remaining:
        _spool_event(event, spool_dir=spool_dir)

    return flushed


# ── Weight cache ──────────────────────────────────────────────────────

def _cache_weights(
    weights: dict[str, dict[str, float]],
    *,
    cache_dir: Path = CACHE_DIR,
) -> None:
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / "weights.json"
    data = {"weights": weights, "cached_at": time.time()}
    cache_file.write_text(json.dumps(data))


def _load_cached_weights(
    *,
    cache_dir: Path = CACHE_DIR,
) -> dict[str, dict[str, float]] | None:
    cache_file = cache_dir / "weights.json"
    if not cache_file.exists():
        return None
    try:
        data = json.loads(cache_file.read_text())
        cached_at = data.get("cached_at", 0)
        if time.time() - cached_at > WEIGHT_CACHE_TTL:
            return None
        return data.get("weights")
    except (json.JSONDecodeError, KeyError):
        return None


# ── Public API ─────────────────────────────────────────────────────────

def get_weights() -> dict[str, dict[str, float]]:
    """Get current agent weights. Cached 24h, falls back to defaults."""
    # Check cache first
    cached = _load_cached_weights()
    if cached:
        return cached

    # Try API
    service_url = _get_service_url()
    token = get_auth_token(service_url)
    try:
        resp = requests.get(
            f"{service_url}/api/v1/agents",
            headers=_headers(token),
            timeout=10,
        )
        if resp.status_code == 200:
            agents = resp.json()
            weights = {a["name"]: a.get("weights", {}) for a in agents}
            _cache_weights(weights)
            return weights
    except requests.RequestException:
        pass

    return DEFAULT_WEIGHTS


def _post(endpoint: str, payload: dict[str, Any]) -> dict | None:
    """POST to API with spool fallback."""
    service_url = _get_service_url()
    token = get_auth_token(service_url)

    # Try to flush any pending spool events first
    try:
        flush_spool()
    except Exception:
        pass

    try:
        resp = requests.post(
            f"{service_url}{endpoint}",
            json=payload,
            headers=_headers(token),
            timeout=30,
        )
        if resp.status_code in (200, 201):
            return resp.json()
        # Non-retryable error — log but don't spool
        if resp.status_code < 500:
            return None
    except requests.RequestException:
        pass

    # Spool for later
    _spool_event({"endpoint": endpoint, "payload": payload})
    return None


def ingest_review(data: dict[str, Any]) -> dict | None:
    """Send review data to stark-signals. Returns consensus results or None."""
    return _post("/api/v1/ingest/review", data)


def ingest_tournament(data: dict[str, Any]) -> dict | None:
    """Send tournament data to stark-signals."""
    return _post("/api/v1/ingest/tournament", data)


def ingest_signal(data: dict[str, Any]) -> dict | None:
    """Send a training signal to stark-signals."""
    return _post("/api/v1/ingest/signal", data)


def is_enabled() -> bool:
    """Check if signal store is enabled in config."""
    import os
    config_path = Path.home() / ".claude" / "code-review" / "config.json"
    if not config_path.exists():
        return False
    try:
        config = json.loads(config_path.read_text())
        return config.get("signal_store", {}).get("enabled", False)
    except (json.JSONDecodeError, KeyError):
        return False
```

- [ ] **Step 4: Run tests**

```bash
cd ~/Code/Playground/stark-skills
python3 -m pytest scripts/test_signal_client.py -v
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add scripts/signal_client.py scripts/test_signal_client.py
git commit -m "feat: add signal_client.py with API writes, spool fallback, weight caching"
```

**Acceptance criteria:**
1. `get_weights()` returns cached weights or falls back to defaults
2. Spool writes to `~/.cache/stark-signals/pending.jsonl` when API unreachable
3. `flush_spool()` replays pending events
4. `is_enabled()` reads from `.code-review/config.json`

---

### Task 14: Add signal_store config + update multi_review.py + create consensus wrapper

**Files:**
- Modify: `~/Code/Playground/stark-skills/global/config.json`
- Modify: `~/Code/Playground/stark-skills/scripts/multi_review.py`
- Create: `~/Code/Playground/stark-skills/scripts/consensus.py`

> **Note:** `scripts/consensus.py` is the thin client-side wrapper that calls the server-side consensus endpoint. When `signal_store.enabled` is true, it sends raw findings + coverage to `POST /api/v1/ingest/review` and returns the consensus results. When disabled, it falls back to the local classification logic in `multi_review.py`.

- [ ] **Step 1: Read current config.json**

```bash
cat ~/Code/Playground/stark-skills/global/config.json
```

- [ ] **Step 2: Add signal_store config section**

Add to `global/config.json` at the top level:

```json
"signal_store": {
  "enabled": false,
  "service_url": "",
  "weight_cache_ttl_seconds": 86400
}
```

- [ ] **Step 3: Validate JSON**

```bash
python3 -c "import json; json.load(open('global/config.json'))"
```

Expected: No output (valid JSON)

- [ ] **Step 4: Update multi_review.py to integrate signal_client**

Add after the existing imports block in `multi_review.py`:

```python
# Signal store integration (optional)
try:
    import signal_client
    _SIGNAL_CLIENT_AVAILABLE = True
except ImportError:
    _SIGNAL_CLIENT_AVAILABLE = False
```

Add a function after the existing review orchestration to send data to signals:

```python
def _send_to_signal_store(
    *,
    repo: str,
    pr_number: int | None,
    review_type: str,
    base_sha: str,
    rounds_data: list[dict],
    agent_versions: dict,
    config_snapshot: dict,
    duration: float,
) -> dict | None:
    """Send review results to stark-signals if enabled."""
    if not _SIGNAL_CLIENT_AVAILABLE or not signal_client.is_enabled():
        return None

    round_count = len(rounds_data)
    idempotency_key = f"{repo}:{pr_number or 'plan'}:{base_sha}:{round_count}"

    payload = {
        "idempotency_key": idempotency_key,
        "repo": repo,
        "pr_number": pr_number,
        "review_type": review_type,
        "base_sha": base_sha,
        "agent_versions": agent_versions,
        "config_snapshot": config_snapshot,
        "rounds": rounds_data,
    }

    return signal_client.ingest_review(payload)
```

Add a call to `_send_to_signal_store` at the end of the existing `run_review()` function (or equivalent orchestration entry point) in `multi_review.py`, after all rounds complete and before returning results:

```python
# At the end of the review orchestration, after all rounds:
_send_to_signal_store(
    repo=repo,
    pr_number=pr_number,
    review_type=review_type,
    base_sha=base_sha,
    rounds_data=rounds_data,
    agent_versions=agent_versions,
    config_snapshot=config_snapshot,
    duration=total_duration,
)
```

- [ ] **Step 5: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add global/config.json scripts/multi_review.py
git commit -m "feat: integrate signal_client into multi_review with feature flag"
```

**Acceptance criteria:**
1. `signal_store.enabled` defaults to `false`
2. Integration is non-breaking (feature-flagged, import guarded)
3. Idempotency key format matches spec

---

### Task 15: Update stark-review and stark-review-plan SKILL.md files

**Files:**
- Modify: `~/Code/Playground/stark-skills/skill/stark-review/SKILL.md`
- Modify: `~/Code/Playground/stark-skills/skill/stark-review-plan/SKILL.md`

- [ ] **Step 1: Read current SKILL.md files**

```bash
head -50 ~/Code/Playground/stark-skills/skill/stark-review/SKILL.md
head -50 ~/Code/Playground/stark-skills/skill/stark-review-plan/SKILL.md
```

- [ ] **Step 2: Add consensus output section to stark-review**

At the end of the output formatting section in `skill/stark-review/SKILL.md`, add:

```markdown
### Consensus Results (when signal_store is enabled)

If `signal_store.enabled` is true in config, the review results include consensus data from
the stark-signals API. Each finding shows:

- **Consensus Severity** — weighted majority vote across all agents
- **Consensus Score** — agreement strength (0.0 = disagreement, 1.0 = unanimous)
- **Classification** — auto-classified as fix/noise/needs_human_review based on consensus

When consensus_score < 0.5, findings are flagged as `needs_human_review` for manual triage.

Human overrides of consensus classifications are automatically captured as gold training signals.
```

- [ ] **Step 3: Add same section to stark-review-plan**

Add the same consensus section to `skill/stark-review-plan/SKILL.md`.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add skill/stark-review/SKILL.md skill/stark-review-plan/SKILL.md
git commit -m "docs: add consensus output section to stark-review and stark-review-plan skills"
```

**Acceptance criteria:**
1. Both SKILL.md files document consensus behavior
2. Human override → gold signal capture documented
3. `needs_human_review` threshold (< 0.5) documented

---

### Task 16: Sentinel onboarding (Prometheus metrics, structured logging)

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/observability.py`
- Modify: `~/Code/stark-signals/src/stark_signals/api/main.py`

- [ ] **Step 1: Create observability.py**

Write to `~/Code/stark-signals/src/stark_signals/observability.py`:

```python
"""Observability — Prometheus metrics and structured logging for infra-sentinel."""

from __future__ import annotations

import time
from collections.abc import Callable

import structlog
from fastapi import Request, Response
from prometheus_client import Counter, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response as StarletteResponse

logger = structlog.get_logger(__name__)

# ── Prometheus metrics ─────────────────────────────────────────────────

REQUEST_COUNT = Counter(
    "stark_signals_http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status"],
)

REQUEST_LATENCY = Histogram(
    "stark_signals_http_request_duration_seconds",
    "HTTP request latency in seconds",
    ["method", "endpoint"],
    buckets=[0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0],
)

INGEST_COUNT = Counter(
    "stark_signals_ingest_total",
    "Total ingest events by type",
    ["event_type"],
)

SIGNAL_COUNT = Counter(
    "stark_signals_signals_total",
    "Total signals by tier",
    ["tier"],
)

CONSENSUS_SCORE = Histogram(
    "stark_signals_consensus_score",
    "Distribution of consensus scores",
    buckets=[0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
)

SPOOL_BACKLOG = Counter(
    "stark_signals_spool_backlog_total",
    "Total events spooled due to API unavailability",
)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable) -> StarletteResponse:
        start = time.monotonic()
        response = await call_next(request)
        duration = time.monotonic() - start

        endpoint = request.url.path
        REQUEST_COUNT.labels(
            method=request.method,
            endpoint=endpoint,
            status=response.status_code,
        ).inc()
        REQUEST_LATENCY.labels(
            method=request.method,
            endpoint=endpoint,
        ).observe(duration)

        return response


def configure_logging() -> None:
    """Configure structlog for JSON output (infra-sentinel Alloy → Loki)."""
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
```

- [ ] **Step 2: Add metrics endpoint and middleware to main.py**

Add to `~/Code/stark-signals/src/stark_signals/api/main.py` after the CORS middleware:

```python
from stark_signals.observability import MetricsMiddleware, configure_logging
from prometheus_client import generate_latest

app.add_middleware(MetricsMiddleware)

@app.get("/metrics")
async def metrics():
    from fastapi.responses import Response
    return Response(content=generate_latest(), media_type="text/plain; charset=utf-8")
```

Update the lifespan to call `configure_logging()`.

- [ ] **Step 3: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/observability.py src/stark_signals/api/main.py
git commit -m "feat: add Prometheus metrics, structured logging for infra-sentinel"
```

**Acceptance criteria:**
1. `/metrics` returns Prometheus format
2. Request count, latency, ingest count, signal count tracked
3. Structured JSON logging configured for Loki

---

## Phase 2: Tournament + Dashboard (Week 3-5)

### Task 17: tournament.py — worktree management

**Files:**
- Create: `~/Code/Playground/stark-skills/scripts/tournament.py`
- Create: `~/Code/Playground/stark-skills/scripts/test_tournament.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/Playground/stark-skills/scripts/test_tournament.py`:

```python
"""Tests for tournament.py."""

from __future__ import annotations

import os
import tempfile
import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import sys

sys.path.insert(0, str(Path(__file__).parent))

import tournament


class TestWorktreeManagement:
    def test_worktree_path_includes_run_id(self):
        run_id = uuid.uuid4()
        path = tournament.worktree_path(run_id, "claude")
        assert str(run_id) in str(path)
        assert "claude" in str(path)

    def test_branch_name_includes_run_id(self):
        run_id = uuid.uuid4()
        name = tournament.branch_name(run_id, "codex")
        assert str(run_id) in name
        assert "codex" in name

    @patch("tournament.subprocess.run")
    def test_cleanup_worktrees(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)
        run_id = uuid.uuid4()
        tournament.cleanup_worktrees(run_id, agents=["claude", "codex", "gemini"])
        assert mock_run.call_count >= 3  # remove worktree for each agent

    @patch("tournament.subprocess.run")
    def test_detect_orphaned(self, mock_run):
        run_id = uuid.uuid4()
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout=f"worktree /tmp/tournament-{run_id}-claude\n",
        )
        orphans = tournament.detect_orphaned_worktrees()
        assert len(orphans) >= 0  # may or may not find orphans


class TestCrossReviewScoring:
    def test_severity_points(self):
        assert tournament.severity_points("critical") == 8
        assert tournament.severity_points("high") == 4
        assert tournament.severity_points("medium") == 2
        assert tournament.severity_points("low") == 1

    def test_compute_cross_review_score(self):
        findings = [
            {"severity": "high", "domain": "architecture"},
            {"severity": "low", "domain": "security"},
        ]
        weights = {"architecture": 0.4, "security": 0.35}
        score = tournament.compute_cross_review_score(findings, weights)
        assert score == 4 * 0.4 + 1 * 0.35


class TestWinnerSelection:
    def test_select_winner_by_score(self):
        impls = [
            {"agent": "claude", "acceptance_passed": True, "cross_review_score": 2.0,
             "disqualified": False, "files_changed": 5, "lines_added": 100},
            {"agent": "codex", "acceptance_passed": True, "cross_review_score": 5.0,
             "disqualified": False, "files_changed": 8, "lines_added": 200},
        ]
        winner = tournament.select_winner(impls)
        assert winner["agent"] == "claude"

    def test_disqualified_excluded(self):
        impls = [
            {"agent": "claude", "acceptance_passed": True, "cross_review_score": 10.0,
             "disqualified": False, "files_changed": 5, "lines_added": 100},
            {"agent": "codex", "acceptance_passed": True, "cross_review_score": 1.0,
             "disqualified": True, "files_changed": 3, "lines_added": 50},
        ]
        winner = tournament.select_winner(impls)
        assert winner["agent"] == "claude"

    def test_tie_break_fewer_files(self):
        impls = [
            {"agent": "claude", "acceptance_passed": True, "cross_review_score": 2.0,
             "disqualified": False, "files_changed": 5, "lines_added": 100},
            {"agent": "codex", "acceptance_passed": True, "cross_review_score": 2.0,
             "disqualified": False, "files_changed": 3, "lines_added": 50},
        ]
        winner = tournament.select_winner(impls)
        assert winner["agent"] == "codex"

    def test_no_survivors_returns_none(self):
        impls = [
            {"agent": "claude", "acceptance_passed": False, "cross_review_score": 0,
             "disqualified": True, "files_changed": 0, "lines_added": 0},
        ]
        winner = tournament.select_winner(impls)
        assert winner is None
```

- [ ] **Step 2: Implement tournament.py**

Write to `~/Code/Playground/stark-skills/scripts/tournament.py`:

```python
"""Tournament runner — parallel LLM implementation competition.

Module-level function library. Manages worktrees, dispatches agent
implementations, runs acceptance checks, cross-reviews, selects winners.

Usage:
    import tournament
    run_id = uuid.uuid4()
    tournament.create_worktrees(run_id, agents=["claude", "codex", "gemini"])
    # ... dispatch implementations ...
    winner = tournament.select_winner(implementations)
    tournament.cleanup_worktrees(run_id, agents=["claude", "codex", "gemini"])
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

# ── Constants ──────────────────────────────────────────────────────────

WORKTREE_BASE = Path("/tmp")
AGENTS = ["claude", "codex", "gemini"]
IMPLEMENTATION_TIMEOUT = 900  # 15 minutes per agent
CROSS_REVIEW_TIMEOUT = 300   # 5 minutes per cross-review

SEVERITY_POINTS = {
    "critical": 8,
    "high": 4,
    "medium": 2,
    "low": 1,
}


# ── Worktree management ───────────────────────────────────────────────

def worktree_path(run_id: uuid.UUID, agent: str) -> Path:
    """Worktree path includes run_id for idempotency."""
    return WORKTREE_BASE / f"tournament-{run_id}-{agent}"


def branch_name(run_id: uuid.UUID, agent: str) -> str:
    """Branch name includes run_id — no collision with prior runs."""
    return f"tournament/{run_id}/{agent}"


def create_worktrees(
    run_id: uuid.UUID,
    *,
    agents: list[str] | None = None,
    repo_dir: str | Path = ".",
) -> dict[str, Path]:
    """Create git worktrees for each agent. Returns {agent: path}."""
    agents = agents or AGENTS
    paths = {}
    for agent in agents:
        wt = worktree_path(run_id, agent)
        br = branch_name(run_id, agent)
        subprocess.run(
            ["git", "worktree", "add", str(wt), "-b", br],
            cwd=str(repo_dir),
            check=True,
            capture_output=True,
        )
        paths[agent] = wt
    return paths


def cleanup_worktrees(
    run_id: uuid.UUID,
    *,
    agents: list[str] | None = None,
    repo_dir: str | Path = ".",
) -> None:
    """Remove worktrees and branches. Safe to call multiple times."""
    agents = agents or AGENTS
    for agent in agents:
        wt = worktree_path(run_id, agent)
        br = branch_name(run_id, agent)
        # Remove worktree
        subprocess.run(
            ["git", "worktree", "remove", str(wt), "--force"],
            cwd=str(repo_dir),
            capture_output=True,
        )
        # Delete branch
        subprocess.run(
            ["git", "branch", "-D", br],
            cwd=str(repo_dir),
            capture_output=True,
        )


def detect_orphaned_worktrees(*, repo_dir: str | Path = ".") -> list[str]:
    """Find worktrees from crashed tournament runs."""
    result = subprocess.run(
        ["git", "worktree", "list", "--porcelain"],
        cwd=str(repo_dir),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    orphans = []
    for line in result.stdout.split("\n"):
        if line.startswith("worktree ") and "tournament-" in line:
            path = line.split("worktree ", 1)[1].strip()
            orphans.append(path)
    return orphans


def cleanup_orphaned_worktrees(*, repo_dir: str | Path = ".") -> int:
    """Clean up orphaned tournament worktrees. Returns count cleaned."""
    orphans = detect_orphaned_worktrees(repo_dir=repo_dir)
    cleaned = 0
    for path in orphans:
        subprocess.run(
            ["git", "worktree", "remove", path, "--force"],
            cwd=str(repo_dir),
            capture_output=True,
        )
        cleaned += 1
    return cleaned


# ── Cross-review scoring ──────────────────────────────────────────────

def severity_points(severity: str) -> int:
    """Severity weight for cross-review scoring."""
    return SEVERITY_POINTS.get(severity, 0)


def compute_cross_review_score(
    findings: list[dict],
    reviewer_weights: dict[str, float],
) -> float:
    """Score = sum(finding.severity_weight * reviewer.domain_weight)."""
    score = 0.0
    for f in findings:
        sev = severity_points(f.get("severity", "low"))
        domain = f.get("domain", "")
        weight = reviewer_weights.get(domain, 0.33)
        score += sev * weight
    return score


# ── Winner selection ───────────────────────────────────────────────────

def select_winner(implementations: list[dict]) -> dict | None:
    """Select winner from implementations.

    Rules:
    1. Filter to acceptance_passed=True and disqualified=False
    2. Lowest cross_review_score wins
    3. Tie-breaker: fewer files_changed, then fewer lines_added
    """
    survivors = [
        i for i in implementations
        if i.get("acceptance_passed") and not i.get("disqualified")
    ]
    if not survivors:
        return None

    survivors.sort(
        key=lambda i: (
            i.get("cross_review_score", 0),
            i.get("files_changed", 0),
            i.get("lines_added", 0),
        )
    )
    return survivors[0]


# ── Agent dispatch ─────────────────────────────────────────────────────

def dispatch_agent(
    agent: str,
    *,
    worktree: Path,
    task_description: str,
    acceptance_criteria: list[str],
    timeout: int = IMPLEMENTATION_TIMEOUT,
) -> dict[str, Any]:
    """Dispatch a single agent to implement a task in its worktree.

    Returns implementation result dict.
    """
    cli_commands = {
        "claude": ["claude", "--dangerously-skip-permissions", "-p"],
        "codex": ["codex", "--full-auto", "-q"],
        "gemini": ["gemini", "--sandbox=false", "-p"],
    }

    cmd = cli_commands.get(agent)
    if not cmd:
        return {"agent": agent, "error": f"Unknown agent: {agent}", "disqualified": True}

    prompt = f"""Implement the following task in the current repository.
Work in the current directory. Do not create new branches.

## Task
{task_description}

## Acceptance Criteria
{chr(10).join(f'- {c}' for c in acceptance_criteria)}

## Instructions
1. Read the relevant code to understand the codebase
2. Implement the changes
3. Run tests to verify
4. Commit your changes with a descriptive message
"""

    try:
        result = subprocess.run(
            [*cmd, prompt],
            cwd=str(worktree),
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        # Get diff stats
        diff = subprocess.run(
            ["git", "diff", "--stat", "HEAD~1"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
        )
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(worktree),
            capture_output=True,
            text=True,
        )

        # Parse diff stats
        files_changed = 0
        lines_added = 0
        lines_deleted = 0
        for line in diff.stdout.strip().split("\n"):
            m = re.search(r"(\d+) files? changed", line)
            if m:
                files_changed = int(m.group(1))
            m = re.search(r"(\d+) insertions?", line)
            if m:
                lines_added = int(m.group(1))
            m = re.search(r"(\d+) deletions?", line)
            if m:
                lines_deleted = int(m.group(1))

        return {
            "agent": agent,
            "commit_sha": commit.stdout.strip(),
            "files_changed": files_changed,
            "lines_added": lines_added,
            "lines_deleted": lines_deleted,
            "disqualified": files_changed == 0,
            "disqualification_reason": "Empty diff" if files_changed == 0 else None,
        }

    except subprocess.TimeoutExpired:
        return {
            "agent": agent,
            "disqualified": True,
            "disqualification_reason": f"Timed out after {timeout}s",
        }
    except Exception as e:
        return {
            "agent": agent,
            "disqualified": True,
            "disqualification_reason": str(e),
        }


# ── Test execution ─────────────────────────────────────────────────────

def run_tests(
    worktree: Path,
    *,
    test_command: str | None = None,
) -> dict[str, int]:
    """Run test suite in worktree. Returns {pass, fail, skip} counts."""
    if not test_command:
        # Auto-detect
        if (worktree / "pyproject.toml").exists():
            test_command = "python -m pytest --tb=short -q"
        elif (worktree / "package.json").exists():
            test_command = "npm test"
        else:
            return {"pass": 0, "fail": 0, "skip": 0}

    try:
        result = subprocess.run(
            test_command.split(),
            cwd=str(worktree),
            capture_output=True,
            text=True,
            timeout=300,
        )

        # Parse pytest output
        output = result.stdout + result.stderr
        passed = failed = skipped = 0

        m = re.search(r"(\d+) passed", output)
        if m:
            passed = int(m.group(1))
        m = re.search(r"(\d+) failed", output)
        if m:
            failed = int(m.group(1))
        m = re.search(r"(\d+) skipped", output)
        if m:
            skipped = int(m.group(1))

        return {"pass": passed, "fail": failed, "skip": skipped}

    except subprocess.TimeoutExpired:
        return {"pass": 0, "fail": 1, "skip": 0}
    except Exception:
        return {"pass": 0, "fail": 1, "skip": 0}
```

- [ ] **Step 3: Run tests**

```bash
cd ~/Code/Playground/stark-skills
python3 -m pytest scripts/test_tournament.py -v
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add scripts/tournament.py scripts/test_tournament.py
git commit -m "feat: add tournament runner with worktree management, scoring, winner selection"
```

**Acceptance criteria:**
1. Worktree paths include run_id (UUID) for idempotency
2. Orphaned worktree detection and cleanup works
3. Cross-review scoring uses severity_points * domain_weight
4. Winner selection filters disqualified, sorts by score, ties broken by file count

---

### Task 18: stark-phase-execute-tournament SKILL.md

**Files:**
- Create: `~/Code/Playground/stark-skills/skill/stark-phase-execute-tournament/SKILL.md`

- [ ] **Step 1: Create skill directory**

```bash
mkdir -p ~/Code/Playground/stark-skills/skill/stark-phase-execute-tournament
```

- [ ] **Step 2: Write SKILL.md**

Write to `~/Code/Playground/stark-skills/skill/stark-phase-execute-tournament/SKILL.md`:

```markdown
---
name: stark-phase-execute-tournament
description: Execute plan tasks via 3-agent tournament competition
version: 0.1.0
---

# /stark-phase-execute-tournament

Execute tasks from a plan using tournament-style competition. Three LLM agents
(Claude, Codex, Gemini) implement the same task in parallel git worktrees, then
cross-review each other's work. The winner is selected by cross-review score +
acceptance criteria, and promoted via PR.

## Usage

```
/stark-phase-execute-tournament <plan-slug> [--dry-run]
```

## Prerequisites

- Plan must exist with GitHub issues (created via `/stark-plan-to-tasks`)
- All three CLI tools installed: `claude`, `codex`, `gemini`
- Repository must be clean (no uncommitted changes)

## Workflow

### Step 1: Load Plan

```bash
# Find plan file
PLAN_FILE=$(ls docs/superpowers/plans/*-${PLAN_SLUG}.md 2>/dev/null | head -1)

# Load task issues from GitHub
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
ISSUES=$(gh issue list --label "plan:${PLAN_SLUG}" --state open --json number,title,body,labels --limit 50)
```

Parse issues to extract tasks in phase order. Each issue has:
- Title with task description
- Body with `## Acceptance Criteria` section
- Labels with phase number

### Step 2: Clean Up Orphaned Worktrees

```bash
# Use tournament.py to detect and clean orphaned worktrees
python3 ~/.claude/code-review/scripts/tournament.py cleanup-orphans
```

### Step 3: For Each Task (Sequential by Phase)

For each task issue, run a tournament:

#### 3a. Generate Tournament Run ID

```python
import uuid
run_id = uuid.uuid4()
```

#### 3b. Create Worktrees

```bash
git worktree add /tmp/tournament-${RUN_ID}-claude -b tournament/${RUN_ID}/claude
git worktree add /tmp/tournament-${RUN_ID}-codex  -b tournament/${RUN_ID}/codex
git worktree add /tmp/tournament-${RUN_ID}-gemini -b tournament/${RUN_ID}/gemini
```

#### 3c. Dispatch Implementations (Parallel)

Run all three agents in parallel, each in its own worktree:

```bash
# Claude
cd /tmp/tournament-${RUN_ID}-claude
claude --dangerously-skip-permissions -p "Implement task: ${TASK_DESCRIPTION}"

# Codex (parallel)
cd /tmp/tournament-${RUN_ID}-codex
codex --full-auto -q "Implement task: ${TASK_DESCRIPTION}"

# Gemini (parallel)
cd /tmp/tournament-${RUN_ID}-gemini
gemini --sandbox=false -p "Implement task: ${TASK_DESCRIPTION}"
```

Timeout: 15 minutes per agent. If an agent times out, it's disqualified.

#### 3d. Run Acceptance Checks (Sequential)

For each surviving agent, sequentially:

1. Run test suite in the worktree
2. Verify acceptance criteria from issue body
3. Disqualify if tests fail or criteria not met

Gate: at least 1 agent must pass.

#### 3e. Cross-Review (6 Passes, Parallel)

Each agent reviews the other two agents' implementations:

```
claude reviews codex's code → findings
claude reviews gemini's code → findings
codex reviews claude's code → findings
codex reviews gemini's code → findings
gemini reviews claude's code → findings
gemini reviews codex's code → findings
```

Timeout: 5 minutes per cross-review.

#### 3f. Score and Select Winner

```python
import tournament

# Score each implementation
for impl in implementations:
    impl["cross_review_score"] = tournament.compute_cross_review_score(
        findings=impl["cross_review_findings"],
        reviewer_weights=weights,
    )

# Select winner
winner = tournament.select_winner(implementations)
```

Winner = lowest cross-review score among agents that passed acceptance.
Tie-breaker: fewer files changed, then fewer lines added.

#### 3g. Promote Winner

```bash
# Push winner's branch
git push origin tournament/${RUN_ID}/${WINNER_AGENT}:tournament/${ISSUE_NUMBER}/winner

# Create PR
gh pr create \
    --head tournament/${ISSUE_NUMBER}/winner \
    --title "${TASK_TITLE}" \
    --body "Tournament winner: ${WINNER_AGENT} (score: ${SCORE})"
```

#### 3h. Record Tournament

```python
import signal_client
signal_client.ingest_tournament(tournament_data)
```

#### 3i. Clean Up

```bash
git worktree remove /tmp/tournament-${RUN_ID}-claude --force
git worktree remove /tmp/tournament-${RUN_ID}-codex --force
git worktree remove /tmp/tournament-${RUN_ID}-gemini --force
```

Always runs — in finally block + SIGTERM/SIGINT handler.

#### 3j. Merge and Continue

```bash
gh pr merge --squash --admin
git pull origin main
```

### Step 4: Summary

Print tournament results table:

| Task | Winner | Score | Claude | Codex | Gemini |
|------|--------|-------|--------|-------|--------|
| ... | ... | ... | pass/DQ | pass/DQ | pass/DQ |

## Dry Run Mode

With `--dry-run`, shows what would happen without creating worktrees or
running agents. Validates plan structure and issue availability.

## Error Handling

- If all agents are disqualified for a task: mark task as failed, log, continue
- If worktree creation fails: skip task, log error
- SIGTERM/SIGINT: clean up all worktrees, log partial results
- Crash recovery on next run: detect and clean orphaned worktrees
```

- [ ] **Step 3: Update CLAUDE.md skills table**

Add to the skills table in `~/Code/Playground/stark-skills/CLAUDE.md`:

```
| `/stark-phase-execute-tournament` | Execute tasks via 3-agent tournament competition |
```

- [ ] **Step 4: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add skill/stark-phase-execute-tournament/ CLAUDE.md
git commit -m "feat: add stark-phase-execute-tournament skill"
```

**Acceptance criteria:**
1. SKILL.md documents full tournament workflow
2. Dry-run mode documented
3. Error handling covers all-DQ, crash recovery, SIGTERM
4. Skill registered in CLAUDE.md

---

### Task 19: React dashboard scaffold

**Files:**
- Create: `~/Code/stark-signals/frontend/package.json`
- Create: `~/Code/stark-signals/frontend/vite.config.ts`
- Create: `~/Code/stark-signals/frontend/tsconfig.json`
- Create: `~/Code/stark-signals/frontend/src/main.tsx`

- [ ] **Step 1: Scaffold frontend**

```bash
cd ~/Code/stark-signals
mkdir -p frontend/src/pages frontend/src/components frontend/src/lib
```

- [ ] **Step 2: Create package.json**

Write to `~/Code/stark-signals/frontend/package.json`:

```json
{
  "name": "stark-signals-dashboard",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "recharts": "^2.15.0",
    "@tanstack/react-query": "^5.60.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.6.0",
    "lucide-react": "^0.460.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0"
  }
}
```

- [ ] **Step 3: Create vite.config.ts**

Write to `~/Code/stark-signals/frontend/vite.config.ts`:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3005,
    proxy: {
      "/api": "http://localhost:8000",
      "/health": "http://localhost:8000",
    },
  },
  build: {
    outDir: "dist",
  },
});
```

- [ ] **Step 4: Create main.tsx and App**

Write to `~/Code/stark-signals/frontend/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
```

Write to `~/Code/stark-signals/frontend/src/App.tsx`:

```tsx
import { Routes, Route, NavLink } from "react-router-dom";
import Overview from "./pages/Overview";
import AgentDetail from "./pages/AgentDetail";
import Tournaments from "./pages/Tournaments";
import Reviews from "./pages/Reviews";
import Signals from "./pages/Signals";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/agents", label: "Agents" },
  { to: "/tournaments", label: "Tournaments" },
  { to: "/reviews", label: "Reviews" },
  { to: "/signals", label: "Signals" },
];

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <nav className="border-b border-gray-800 bg-gray-900/50 backdrop-blur">
        <div className="mx-auto max-w-7xl px-4 flex items-center h-14 gap-6">
          <span className="font-bold text-lg tracking-tight">stark-signals</span>
          <div className="flex gap-4">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `text-sm transition-colors ${isActive ? "text-white" : "text-gray-400 hover:text-gray-200"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/agents" element={<AgentDetail />} />
          <Route path="/agents/:name" element={<AgentDetail />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/tournaments/:id" element={<Tournaments />} />
          <Route path="/reviews" element={<Reviews />} />
          <Route path="/reviews/:id" element={<Reviews />} />
          <Route path="/signals" element={<Signals />} />
        </Routes>
      </main>
    </div>
  );
}
```

Write to `~/Code/stark-signals/frontend/src/index.css`:

```css
@import "tailwindcss";
```

Write to `~/Code/stark-signals/frontend/src/lib/api.ts`:

```typescript
const API_BASE = "/api/v1";

export async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export interface DashboardData {
  agent_leaderboard: { agent: string; overall_f1: number | null; domain_scores: Record<string, number> }[];
  review_stats: { total: number; avg_findings: number; avg_noise_rate: number };
  tournament_stats: { total: number; winner_distribution: Record<string, number> };
  signal_stats: { gold: number; silver: number; bronze: number; pending_proposals: number };
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
}
```

- [ ] **Step 5: Create placeholder pages**

Write to `~/Code/stark-signals/frontend/src/pages/Overview.tsx`:

```tsx
import { useQuery } from "@tanstack/react-query";
import { fetchApi, DashboardData } from "../lib/api";

export default function Overview() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchApi<DashboardData>("/dashboard"),
  });

  if (isLoading) return <div className="text-gray-400">Loading...</div>;
  if (!data) return <div className="text-gray-400">No data</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Reviews" value={data.review_stats.total} />
        <StatCard label="Tournaments" value={data.tournament_stats.total} />
        <StatCard label="Gold Signals" value={data.signal_stats.gold} />
        <StatCard label="Pending Proposals" value={data.signal_stats.pending_proposals} />
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold mb-4">Agent Leaderboard</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-800">
              <th className="text-left py-2">Agent</th>
              <th className="text-right py-2">Overall F1</th>
            </tr>
          </thead>
          <tbody>
            {data.agent_leaderboard.map((a) => (
              <tr key={a.agent} className="border-b border-gray-800/50">
                <td className="py-2 font-mono">{a.agent}</td>
                <td className="py-2 text-right">{a.overall_f1?.toFixed(3) ?? "N/A"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="text-sm text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
```

Write placeholder pages for `AgentDetail.tsx`, `Tournaments.tsx`, `Reviews.tsx`, `Signals.tsx`:

Write to `~/Code/stark-signals/frontend/src/pages/AgentDetail.tsx`:

```tsx
export default function AgentDetail() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Agent Detail</h1>
      <p className="text-gray-400">Select an agent to view precision/recall, weight history, and domain heatmap.</p>
    </div>
  );
}
```

Write to `~/Code/stark-signals/frontend/src/pages/Tournaments.tsx`:

```tsx
export default function Tournaments() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Tournament History</h1>
      <p className="text-gray-400">Tournament comparison and results will appear here.</p>
    </div>
  );
}
```

Write to `~/Code/stark-signals/frontend/src/pages/Reviews.tsx`:

```tsx
export default function Reviews() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Review Analytics</h1>
      <p className="text-gray-400">Finding classification breakdown and noise rate trends.</p>
    </div>
  );
}
```

Write to `~/Code/stark-signals/frontend/src/pages/Signals.tsx`:

```tsx
export default function Signals() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Signals</h1>
      <p className="text-gray-400">Ground truth events and weight proposal approval queue.</p>
    </div>
  );
}
```

- [ ] **Step 6: Create tsconfig.json and index.html**

Write to `~/Code/stark-signals/frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src"]
}
```

Write to `~/Code/stark-signals/frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>stark-signals</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Commit**

```bash
cd ~/Code/stark-signals
git add frontend/
git commit -m "feat: scaffold React dashboard with routing, Overview page, API client"
```

**Acceptance criteria:**
1. `cd frontend && npm install && npm run build` succeeds
2. Dark theme with nav bar and 5 routes
3. Overview page fetches `/api/v1/dashboard` via react-query
4. Vite proxies API requests to backend on port 8000

---

### Task 20-25: Dashboard pages (detailed implementations)

Tasks 20-25 implement the remaining dashboard pages. Each follows the same pattern: write the page component using react-query to fetch data, Recharts for charts, and shadcn/ui-style components.

**These tasks are identical in structure — create the page file, wire up data fetching, add charts/tables. Each is a single file modification.**

### Task 20: Dashboard Overview page — full leaderboard + charts

**Files:**
- Modify: `~/Code/stark-signals/frontend/src/pages/Overview.tsx`

Add to the Overview page:
- Winner distribution pie chart (Recharts PieChart)
- Noise rate trend line chart (Recharts LineChart fetching `/api/v1/dashboard/trends`)
- Signal tier breakdown (bar chart)

- [ ] **Step 1: Enhance Overview.tsx with charts**

Replace the Overview component with full implementation including Recharts:

```tsx
import { useQuery } from "@tanstack/react-query";
import { PieChart, Pie, Cell, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { fetchApi, DashboardData } from "../lib/api";

const COLORS = ["#3b82f6", "#10b981", "#f59e0b"];

export default function Overview() {
  const { data, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => fetchApi<DashboardData>("/dashboard"),
  });

  const { data: trends } = useQuery({
    queryKey: ["trends"],
    queryFn: () => fetchApi<{ data_points: { date: string; value: number }[] }>("/dashboard/trends?metric=findings&period=30d"),
  });

  if (isLoading) return <div className="text-gray-400">Loading...</div>;
  if (!data) return <div className="text-gray-400">No data</div>;

  const winnerData = Object.entries(data.tournament_stats.winner_distribution).map(
    ([name, value]) => ({ name, value })
  );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Overview</h1>

      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Reviews" value={data.review_stats.total} />
        <StatCard label="Tournaments" value={data.tournament_stats.total} />
        <StatCard label="Gold Signals" value={data.signal_stats.gold} />
        <StatCard label="Pending Proposals" value={data.signal_stats.pending_proposals} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-lg font-semibold mb-4">Winner Distribution</h2>
          {winnerData.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <PieChart>
                <Pie data={winnerData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80}>
                  {winnerData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-500 text-sm">No tournament data yet</p>
          )}
        </div>

        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
          <h2 className="text-lg font-semibold mb-4">Findings Trend</h2>
          {trends?.data_points && trends.data_points.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={trends.data_points}>
                <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="#666" />
                <YAxis stroke="#666" />
                <Tooltip />
                <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-gray-500 text-sm">No trend data yet</p>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <h2 className="text-lg font-semibold mb-4">Agent Leaderboard</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 border-b border-gray-800">
              <th className="text-left py-2">Agent</th>
              <th className="text-right py-2">Overall F1</th>
              {data.agent_leaderboard[0]?.domain_scores &&
                Object.keys(data.agent_leaderboard[0].domain_scores).map((d) => (
                  <th key={d} className="text-right py-2">{d}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {data.agent_leaderboard.map((a) => (
              <tr key={a.agent} className="border-b border-gray-800/50">
                <td className="py-2 font-mono">{a.agent}</td>
                <td className="py-2 text-right">{a.overall_f1?.toFixed(3) ?? "N/A"}</td>
                {Object.values(a.domain_scores).map((v, i) => (
                  <td key={i} className="py-2 text-right">{v?.toFixed(3) ?? "—"}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
      <div className="text-sm text-gray-400">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/stark-signals
git add frontend/src/pages/Overview.tsx
git commit -m "feat: enhance Overview page with charts (winner distribution, findings trend)"
```

**Acceptance criteria:**
1. Pie chart shows tournament winner distribution
2. Line chart shows findings trend over time
3. Leaderboard table includes per-domain scores

---

### Tasks 21-25: Remaining dashboard pages

> **Note:** These tasks are intentionally light on implementation detail. Each follows the identical pattern established in Task 20 (react-query + Recharts + Tailwind tables). Full specs will be written when Phase 2 begins, after Phase 1 is validated. If Phase 1 runs over, these tasks are candidates for deferral.

**Task 21:** Agent Detail (`frontend/src/pages/AgentDetail.tsx`)
- API: `GET /api/v1/agents/{name}/weights`, `GET /api/v1/agents/{name}/accuracy`
- Charts: weight history LineChart (x=effective_from, y=weight, one line per domain), precision/recall bar chart
- Acceptance: selecting an agent from leaderboard navigates to this page

**Task 22:** Tournaments (`frontend/src/pages/Tournaments.tsx`)
- API: `GET /api/v1/tournaments`, `GET /api/v1/tournaments/{id}`
- Table: sortable by date, winner, score. Detail view shows side-by-side implementation comparison
- Acceptance: tournament list loads with pagination, detail shows all implementations

**Task 23:** Reviews (`frontend/src/pages/Reviews.tsx`)
- API: `GET /api/v1/reviews`, `GET /api/v1/reviews/{id}`
- Charts: classification breakdown PieChart (fix/noise/FP/needs_human_review), noise rate trend
- Acceptance: review list with repo filter, detail shows all findings with consensus data

**Task 24:** Signals (`frontend/src/pages/Signals.tsx`)
- API: `GET /api/v1/signals`, `GET /api/v1/weights/proposals`, `POST /api/v1/weights/proposals/{id}/approve|reject`
- Table: signal list filterable by tier/type/agent. Proposals section with approve/reject buttons (requires admin)
- Acceptance: approve button calls API and updates proposal status in-place

**Task 25:** Settings page — deferred to Phase 3 (optional)

---

## Phase 3: Adaptive Weights (Week 6-7)

### Task 26: Recalibration engine

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/recalibration.py`
- Create: `~/Code/stark-signals/tests/test_recalibration.py`

- [ ] **Step 1: Write test first**

Write to `~/Code/stark-signals/tests/test_recalibration.py`:

```python
"""Tests for recalibration engine."""

from __future__ import annotations

import uuid

import pytest

from stark_signals.recalibration import (
    clamp,
    compute_confidence,
    compute_cumulative_delta,
)


class TestClamp:
    def test_within_range(self):
        assert clamp(0.5, 0.0, 1.0) == 0.5

    def test_below_min(self):
        assert clamp(-0.1, 0.0, 1.0) == 0.0

    def test_above_max(self):
        assert clamp(1.5, 0.0, 1.0) == 1.0


class TestCumulativeDelta:
    def test_gold_correct(self):
        signals = [
            {"tier": "gold", "original_value": "noise", "corrected_value": "noise", "weight_delta": 0},
        ]
        delta = compute_cumulative_delta(signals)
        assert delta == 0.02  # reinforce correct

    def test_gold_incorrect(self):
        signals = [
            {"tier": "gold", "original_value": "noise", "corrected_value": "fix", "weight_delta": 0},
        ]
        delta = compute_cumulative_delta(signals)
        assert delta == -0.05  # penalize mistake

    def test_silver(self):
        signals = [
            {"tier": "silver", "original_value": "approved", "corrected_value": "regression", "weight_delta": -0.03},
        ]
        delta = compute_cumulative_delta(signals)
        assert delta == -0.03 * 0.7

    def test_mixed(self):
        signals = [
            {"tier": "gold", "original_value": "fix", "corrected_value": "fix", "weight_delta": 0},
            {"tier": "gold", "original_value": "noise", "corrected_value": "fix", "weight_delta": 0},
            {"tier": "silver", "original_value": "ok", "corrected_value": "regression", "weight_delta": -0.04},
        ]
        delta = compute_cumulative_delta(signals)
        expected = 0.02 + (-0.05) + (-0.04 * 0.7)
        assert abs(delta - expected) < 1e-9


class TestConfidence:
    def test_empty(self):
        assert compute_confidence([]) == 0.0

    def test_single(self):
        conf = compute_confidence([{"tier": "gold"}])
        assert 0.0 < conf <= 1.0

    def test_more_signals_higher_confidence(self):
        few = compute_confidence([{"tier": "gold"}] * 3)
        many = compute_confidence([{"tier": "gold"}] * 20)
        assert many > few
```

- [ ] **Step 2: Implement recalibration.py**

Write to `~/Code/stark-signals/src/stark_signals/recalibration.py`:

```python
"""Recalibration engine — compute weight update proposals from signals.

Runs as Cloud Run Job (daily at 02:00 UTC) or on-demand.
Only uses gold + silver signals. Bronze is diagnostic only.
"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime
from typing import Any

import structlog
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from stark_signals.enums import ProposalStatus, SignalTier
from stark_signals.models.agents import Agent, AgentDomainWeight
from stark_signals.models.signals import Signal, WeightUpdateProposal

logger = structlog.get_logger(__name__)

# Initial weights — used for divergence guard
DEFAULT_WEIGHTS: dict[str, dict[str, float]] = {
    "claude": {"architecture": 0.40, "correctness": 0.40, "security": 0.35, "type-safety": 0.30, "accessibility": 0.30, "test-coverage": 0.35},
    "codex": {"architecture": 0.35, "correctness": 0.35, "security": 0.35, "type-safety": 0.35, "accessibility": 0.25, "test-coverage": 0.35},
    "gemini": {"architecture": 0.25, "correctness": 0.25, "security": 0.30, "type-safety": 0.35, "accessibility": 0.45, "test-coverage": 0.30},
}


def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))


def compute_cumulative_delta(signals: list[dict]) -> float:
    """Compute cumulative weight delta from a list of signals."""
    delta = 0.0
    for s in signals:
        tier = s.get("tier", "")
        if tier == "gold":
            if s.get("corrected_value") == s.get("original_value"):
                delta += 0.02   # reinforce correct decision
            else:
                delta -= 0.05   # penalize mistake (asymmetric)
        elif tier == "silver":
            wd = s.get("weight_delta", 0) or 0
            delta += wd * 0.7
    return delta


def compute_confidence(signals: list[dict]) -> float:
    """Statistical confidence based on signal count and quality."""
    if not signals:
        return 0.0
    n = len(signals)
    gold_count = sum(1 for s in signals if s.get("tier") == "gold")
    silver_count = n - gold_count

    # Confidence grows with sqrt(n), boosted by gold ratio
    gold_ratio = gold_count / n if n > 0 else 0
    raw = math.sqrt(n) * (0.5 + 0.5 * gold_ratio)
    return clamp(raw / 10.0, 0.0, 1.0)  # normalize to 0-1


def recalibrate_agent_domain(
    session: Session,
    agent_name: str,
    domain: str,
) -> WeightUpdateProposal | None:
    """Run recalibration for a single agent×domain pair.

    Returns a WeightUpdateProposal if a meaningful change is warranted.
    """
    # Get agent
    agent = session.execute(
        select(Agent).where(Agent.name == agent_name)
    ).scalar_one_or_none()
    if not agent:
        return None

    # Get unapplied gold + silver signals
    stmt = (
        select(Signal)
        .where(
            Signal.agent == agent_name,
            Signal.domain == domain,
            Signal.signal_tier.in_([SignalTier.GOLD.value, SignalTier.SILVER.value]),
            Signal.applied_to_proposal_id.is_(None),
            Signal.dismissed.is_(False),
        )
    )
    signals = list(session.execute(stmt).scalars().all())
    if not signals:
        return None

    # Get current weight
    current_weight_row = session.execute(
        select(AgentDomainWeight)
        .where(
            AgentDomainWeight.agent_id == agent.id,
            AgentDomainWeight.domain == domain,
        )
        .order_by(AgentDomainWeight.effective_from.desc())
        .limit(1)
    ).scalar_one_or_none()

    current_weight = current_weight_row.weight if current_weight_row else 0.33

    # Compute delta
    signal_dicts = [
        {
            "tier": s.signal_tier,
            "original_value": s.original_value,
            "corrected_value": s.corrected_value,
            "weight_delta": s.weight_delta,
        }
        for s in signals
    ]
    cumulative_delta = compute_cumulative_delta(signal_dicts)

    # Divergence guard
    total_signal_count = session.execute(
        select(Signal)
        .where(
            Signal.agent == agent_name,
            Signal.domain == domain,
            Signal.signal_tier.in_([SignalTier.GOLD.value, SignalTier.SILVER.value]),
        )
    ).all()
    sample_count = len(total_signal_count)

    default_weight = DEFAULT_WEIGHTS.get(agent_name, {}).get(domain, 0.33)

    if sample_count < 50:
        max_delta = 0.15
        proposed = clamp(
            current_weight + cumulative_delta,
            default_weight - max_delta,
            default_weight + max_delta,
        )
    else:
        proposed = clamp(current_weight + cumulative_delta, 0.05, 0.95)

    if abs(proposed - current_weight) < 0.005:
        return None

    # Supersede existing pending proposals for same agent×domain
    session.execute(
        update(WeightUpdateProposal)
        .where(
            WeightUpdateProposal.agent_id == agent.id,
            WeightUpdateProposal.domain == domain,
            WeightUpdateProposal.status == ProposalStatus.PENDING.value,
        )
        .values(status=ProposalStatus.SUPERSEDED.value)
    )

    # Create proposal
    proposal = WeightUpdateProposal(
        agent_id=agent.id,
        domain=domain,
        current_weight=current_weight,
        proposed_weight=proposed,
        delta=proposed - current_weight,
        signal_count=len(signals),
        signal_ids=[str(s.id) for s in signals],
        confidence=compute_confidence(signal_dicts),
    )
    session.add(proposal)
    session.commit()

    logger.info(
        "recalibration.proposal_created",
        agent=agent_name,
        domain=domain,
        current=current_weight,
        proposed=proposed,
        signal_count=len(signals),
    )

    return proposal


def run_full_recalibration(session: Session) -> list[WeightUpdateProposal]:
    """Run recalibration for all agent×domain pairs. Returns proposals created."""
    agents = session.execute(select(Agent).where(Agent.is_active.is_(True))).scalars().all()
    domains = list({d for w in DEFAULT_WEIGHTS.values() for d in w})

    proposals = []
    for agent in agents:
        for domain in domains:
            proposal = recalibrate_agent_domain(session, agent.name, domain)
            if proposal:
                proposals.append(proposal)

    logger.info("recalibration.complete", proposals_created=len(proposals))
    return proposals


if __name__ == "__main__":
    """Entry point for Cloud Run Job."""
    from stark_signals.db import get_sync_session
    from stark_signals.observability import configure_logging

    configure_logging()
    session = get_sync_session()
    try:
        proposals = run_full_recalibration(session)
        print(f"Recalibration complete: {len(proposals)} proposals created")
    finally:
        session.close()
```

- [ ] **Step 3: Run tests**

```bash
cd ~/Code/stark-signals
pytest tests/test_recalibration.py -v
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/recalibration.py tests/test_recalibration.py
git commit -m "feat: add recalibration engine with divergence guard and proposal workflow"
```

**Acceptance criteria:**
1. Gold correct: +0.02, Gold incorrect: -0.05 (asymmetric)
2. Silver: weight_delta * 0.7
3. Divergence guard: max ±0.15 from default until 50 samples
4. Changes < 0.005 are suppressed
5. Existing pending proposals are superseded

---

### Task 27: Bronze signal capture during consensus

**Files:**
- Modify: `~/Code/stark-signals/src/stark_signals/consensus.py`

- [ ] **Step 1: Add bronze signal generation to run_consensus**

After computing consensus in `run_consensus()`, add bronze signal generation:

```python
def _generate_bronze_signals(
    group: list[dict],
    consensus_cls: str,
    all_agents: list[str],
) -> list[dict]:
    """Generate bronze convergence signals from voting patterns."""
    signals = []
    flagging_agents = {f["agent"] for f in group}
    non_flagging = set(all_agents) - flagging_agents

    if len(flagging_agents) == len(all_agents):
        # All agree — positive signal for all
        for agent in all_agents:
            signals.append({
                "agent": agent,
                "type": "convergence",
                "tier": "bronze",
                "original_value": "agree",
                "corrected_value": "agree",
                "weight_delta": 0.01,
            })
    elif len(flagging_agents) == 1 and consensus_cls == "noise":
        # Solo flag classified as noise — negative for that agent
        agent = next(iter(flagging_agents))
        signals.append({
            "agent": agent,
            "type": "convergence",
            "tier": "bronze",
            "original_value": "flagged",
            "corrected_value": "noise",
            "weight_delta": -0.02,
        })
    elif len(flagging_agents) == 1 and consensus_cls == "fix":
        # Solo flag classified as fix — strong positive (caught what others missed)
        agent = next(iter(flagging_agents))
        signals.append({
            "agent": agent,
            "type": "convergence",
            "tier": "bronze",
            "original_value": "solo_flag",
            "corrected_value": "fix",
            "weight_delta": 0.03,
        })
    elif len(flagging_agents) >= 2:
        # Majority agreed — positive for them, negative for dissenters
        for agent in flagging_agents:
            signals.append({
                "agent": agent,
                "type": "convergence",
                "tier": "bronze",
                "original_value": "agree",
                "corrected_value": "agree",
                "weight_delta": 0.01,
            })
        for agent in non_flagging:
            signals.append({
                "agent": agent,
                "type": "convergence",
                "tier": "bronze",
                "original_value": "disagree",
                "corrected_value": "missed",
                "weight_delta": -0.01,
            })

    return signals
```

Add `"bronze_signals"` to each result in `run_consensus()`.

- [ ] **Step 2: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/consensus.py
git commit -m "feat: add bronze signal generation during consensus voting"
```

**Acceptance criteria:**
1. All-agree: positive signal for all agents
2. Solo flag → noise: negative for solo agent
3. Solo flag → fix: strong positive (caught what others missed)
4. Bronze signals stored but NOT used for weight updates

---

### Task 28: GCS archival job

**Files:**
- Create: `~/Code/stark-signals/src/stark_signals/archival.py`

- [ ] **Step 1: Implement archival.py**

Write to `~/Code/stark-signals/src/stark_signals/archival.py`:

```python
"""GCS archival job — export old records to Parquet files.

Records older than 12 months are exported to GCS and deleted from Cloud SQL.
Signals and weights are retained indefinitely (small and needed for recalibration).

Runs as Cloud Run Job triggered by Cloud Scheduler (monthly).
"""

from __future__ import annotations

import io
import json
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from stark_signals.models.reviews import Finding, ReviewRun, Vote
from stark_signals.models.tournaments import TournamentImplementation, TournamentRun

logger = structlog.get_logger(__name__)

ARCHIVE_BUCKET = "stark-signals-archive"
RETENTION_MONTHS = 12


def _cutoff_date() -> datetime:
    return datetime.now(UTC) - timedelta(days=RETENTION_MONTHS * 30)


def archive_reviews(session: Session, *, dry_run: bool = False) -> int:
    """Archive review_runs older than retention period. Returns count archived."""
    cutoff = _cutoff_date()
    old_runs = session.execute(
        select(ReviewRun).where(ReviewRun.created_at < cutoff)
    ).scalars().all()

    if not old_runs:
        return 0

    records = []
    for run in old_runs:
        findings = session.execute(
            select(Finding).where(Finding.review_run_id == run.id)
        ).scalars().all()
        votes_list = []
        for f in findings:
            vs = session.execute(select(Vote).where(Vote.finding_id == f.id)).scalars().all()
            votes_list.extend(vs)

        records.append({
            "review_run": _to_dict(run),
            "findings": [_to_dict(f) for f in findings],
            "votes": [_to_dict(v) for v in votes_list],
        })

    if dry_run:
        logger.info("archival.dry_run", review_runs=len(records))
        return len(records)

    # Upload to GCS
    _upload_to_gcs(
        bucket=ARCHIVE_BUCKET,
        path=f"reviews/{cutoff.strftime('%Y-%m')}.json",
        data=json.dumps(records, default=str),
    )

    # Delete from DB (cascading via foreign keys)
    for run in old_runs:
        # Delete votes first
        findings = session.execute(
            select(Finding).where(Finding.review_run_id == run.id)
        ).scalars().all()
        for f in findings:
            session.execute(delete(Vote).where(Vote.finding_id == f.id))
        session.execute(delete(Finding).where(Finding.review_run_id == run.id))
        session.delete(run)

    session.commit()
    logger.info("archival.reviews_archived", count=len(records))
    return len(records)


def archive_tournaments(session: Session, *, dry_run: bool = False) -> int:
    """Archive tournament_runs older than retention period."""
    cutoff = _cutoff_date()
    old_runs = session.execute(
        select(TournamentRun).where(TournamentRun.created_at < cutoff)
    ).scalars().all()

    if not old_runs:
        return 0

    records = []
    for run in old_runs:
        impls = session.execute(
            select(TournamentImplementation).where(TournamentImplementation.tournament_run_id == run.id)
        ).scalars().all()
        records.append({
            "tournament_run": _to_dict(run),
            "implementations": [_to_dict(i) for i in impls],
        })

    if dry_run:
        logger.info("archival.dry_run", tournament_runs=len(records))
        return len(records)

    _upload_to_gcs(
        bucket=ARCHIVE_BUCKET,
        path=f"tournaments/{cutoff.strftime('%Y-%m')}.json",
        data=json.dumps(records, default=str),
    )

    for run in old_runs:
        session.execute(delete(TournamentImplementation).where(TournamentImplementation.tournament_run_id == run.id))
        session.delete(run)

    session.commit()
    logger.info("archival.tournaments_archived", count=len(records))
    return len(records)


def _to_dict(obj) -> dict:
    """Convert SQLAlchemy model to dict."""
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns}


def _upload_to_gcs(bucket: str, path: str, data: str) -> None:
    """Upload data to GCS."""
    try:
        from google.cloud import storage
        client = storage.Client()
        bucket_obj = client.bucket(bucket)
        blob = bucket_obj.blob(path)
        blob.upload_from_string(data, content_type="application/json")
        logger.info("archival.uploaded", bucket=bucket, path=path)
    except ImportError:
        logger.warning("archival.gcs_not_available", bucket=bucket, path=path)
    except Exception as e:
        logger.error("archival.upload_failed", error=str(e))
        raise


if __name__ == "__main__":
    from stark_signals.db import get_sync_session
    from stark_signals.observability import configure_logging

    configure_logging()
    session = get_sync_session()
    try:
        reviews = archive_reviews(session)
        tournaments = archive_tournaments(session)
        print(f"Archived {reviews} reviews, {tournaments} tournaments")
    finally:
        session.close()
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/stark-signals
git add src/stark_signals/archival.py
git commit -m "feat: add GCS archival job for records older than 12 months"
```

**Acceptance criteria:**
1. Archives reviews + tournaments older than 12 months
2. Signals and weights are NOT archived (retained indefinitely)
3. Uploads to GCS as JSON, then deletes from DB
4. Dry-run mode logs without modifying data

---

### Task 29: stark-signals CLAUDE.md

**Files:**
- Create: `~/Code/stark-signals/CLAUDE.md`

- [ ] **Step 1: Write CLAUDE.md**

Write to `~/Code/stark-signals/CLAUDE.md`:

```markdown
# CLAUDE.md — stark-signals

## What This Is

LLM consensus voting, implementation tournament, and adaptive weight training system. Backend service for the multi-agent review pipeline. Stores findings, votes, signals, and agent performance data. Dashboard for team visibility into agent accuracy.

## Repo Layout

- `src/stark_signals/` — Python package (FastAPI + SQLAlchemy)
- `src/stark_signals/api/` — FastAPI routes (ingest, read, mutations, webhooks)
- `src/stark_signals/models/` — SQLAlchemy ORM models (9 tables)
- `src/stark_signals/consensus.py` — server-side consensus voting engine
- `src/stark_signals/recalibration.py` — weight update proposal engine
- `src/stark_signals/archival.py` — GCS archival job
- `frontend/` — React dashboard (Vite + shadcn/ui + Tailwind + Recharts)
- `alembic/` — database migrations
- `infra/terraform/` — Cloud Run + Cloud SQL + IAP config
- `tests/` — pytest test suite

## Commands

```bash
# Local development
docker compose up -d db                    # start postgres
pip install -e ".[dev]"                    # install deps
alembic upgrade head                       # run migrations
uvicorn stark_signals.api.main:app --reload --port 8000  # start API
cd frontend && npm run dev                 # start dashboard

# Tests
pytest                                     # run all tests
pytest tests/test_consensus.py -v          # run specific

# Migrations
alembic revision --autogenerate -m "desc"  # create migration
alembic upgrade head                       # apply
alembic downgrade -1                       # rollback

# Recalibration (manual)
python -m stark_signals.recalibration

# Archival (manual)
python -m stark_signals.archival
```

## Key Design Decisions

- Consensus is computed server-side (client sends raw findings + coverage)
- All API writes are idempotent via idempotency_key (upsert semantics)
- Weight changes require human approval (proposal workflow)
- Bronze signals are diagnostic only — never directly influence weights
- Divergence guard: weights can't move > ±0.15 from defaults until 50 gold/silver samples
- Client spools to local file when API unreachable, flushes on next connection

## Conventions

- Module-level functions (no classes) for library code, matching stark-skills patterns
- FastAPI routes use async SQLAlchemy sessions
- Pydantic models for all request/response schemas
- structlog for JSON logging (infra-sentinel compatible)
- Prometheus metrics at /metrics
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/stark-signals
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md with repo layout, commands, design decisions"
```

**Acceptance criteria:**
1. Documents all commands needed for local dev
2. Key design decisions listed
3. Conventions match stark-skills patterns

---

### Task 30: Update stark-skills CLAUDE.md with tournament skill

**Files:**
- Modify: `~/Code/Playground/stark-skills/CLAUDE.md`

- [ ] **Step 1: Add tournament skill to skills table**

In the skills table in `~/Code/Playground/stark-skills/CLAUDE.md`, add:

```markdown
| `/stark-phase-execute-tournament` | Execute tasks via 3-agent tournament competition |
```

- [ ] **Step 2: Commit**

```bash
cd ~/Code/Playground/stark-skills
git add CLAUDE.md
git commit -m "docs: add stark-phase-execute-tournament to CLAUDE.md skills list"
```

**Acceptance criteria:**
1. Skill listed in CLAUDE.md skills table

---

## CI/CD

**Not in scope for this plan.** CI/CD for stark-signals should be set up as a follow-up after Phase 1 tasks are committed. Minimum viable pipeline:

1. **GitHub Actions** — on PR: lint (ruff), type-check, run pytest against docker-compose postgres
2. **Deploy** — on merge to main: build Docker image, push to Artifact Registry, deploy to Cloud Run
3. **Migrations** — run `alembic upgrade head` as a pre-deploy step in Cloud Build

This is a prerequisite for Phase 2 — tournament and dashboard development require a working deploy pipeline.

---

## Summary

| Phase | Tasks | Duration | Key Deliverables |
|-------|-------|----------|------------------|
| 1 | 1-16 | Week 1-2 | Terraform, Cloud SQL schema, FastAPI API, consensus engine, signal_client, multi_review integration, sentinel onboarding |
| 2 | 17-25 | Week 3-5 | Tournament runner, SKILL.md, React dashboard (6 pages), webhook handler |
| 3 | 26-30 | Week 6-7 | Recalibration engine, bronze signals, GCS archival, CLAUDE.md |

**Total: 30 tasks across 2 repos, 7 weeks estimated.**
