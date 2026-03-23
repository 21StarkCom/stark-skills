# Plan Review — stark-signals Implementation Plan

**File:** `docs/superpowers/plans/2026-03-23-stark-signals.md`
**Date:** 2026-03-23
**Rounds:** 2 fix + 1 final
**Agents:** claude, codex (14/14 sub-agents per round; gemini not dispatched)

---

## Headline

**Issues found:** 27 | **Noise:** 18 | **Ignored:** 16
**Signal-to-noise:** 60%

---

## All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|
| 1 | R1 | claude, codex | completeness, feasibility | critical | Task 3: Dockerfile | Dockerfile `pip install .` runs before `COPY src/` — build fails | **Fixed R1** |
| 2 | R1 | claude, codex | completeness, operability, security, feasibility | critical | Task 2: Terraform | IAP cannot attach directly to Cloud Run v2 service | **Fixed R1** |
| 3 | R1 | claude, codex | security, operability, completeness | critical | Task 2: Terraform | Webhook secret passed as plaintext env var | **Fixed R1** |
| 4 | R1 | claude, codex | completeness, general, feasibility | critical | Task 7: Tests | Test suite uses SQLite but models use PostgreSQL-specific types (UUID, JSONB) | **Fixed R1** |
| 5 | R1 | claude, codex | general, completeness, feasibility | high | Task 5: Models | ORM models missing ForeignKey declarations on relationship columns | **Fixed R1** |
| 6 | R1 | codex | security | critical | Task 8: FastAPI | Admin guard fails open — defaults to `dev@evinced.com` when header missing in production | **Fixed R1** |
| 7 | R1 | claude, codex | general, completeness | medium | File Map, Task 5, Task 6 | Table count inconsistency — plan says 8 tables but creates 9 | **Fixed R1** |
| 8 | R1 | claude, codex | scope, completeness | high | Tasks 21-25 | Five dashboard tasks are undefined placeholders with no implementation detail | **Fixed R1** |
| 9 | R1 | claude, codex | general, completeness | medium | Phase 1-3 | No CI/CD pipeline defined | **Fixed R1** |
| 10 | R1 | claude | security | medium | Task 2: Terraform | Cloud Scheduler SA needs run.jobs.run but has no IAM binding | **Fixed R1** |
| 11 | R1 | claude | completeness | high | Task 2: Terraform | Cloud SQL IAM user needs full service account email, not short name | **Fixed R1** |
| 12 | R1 | claude, codex | general | medium | Task 12: Webhook | Webhook assigns `agent='all'` which doesn't match any real agent name | **Fixed R1** |
| 13 | R1 | claude | completeness | high | Task 9: Ingest | TournamentImplIn schema missing cross_review_critical and cross_review_high fields | **Fixed R1** |
| 14 | R1 | claude | completeness | medium | Task 7: Consensus | Redundant Levenshtein implementation despite python-Levenshtein dependency | **Fixed R1** |
| 15 | R1 | claude | completeness | medium | Task 8: Health | Health endpoint doesn't verify database connectivity | **Fixed R1** |
| 16 | R1 | claude | api-design | high | Task 8: Schemas | No standard error response schema defined | **Fixed R1** |
| 17 | R1 | claude, codex | general | medium | Summary | No success criteria defined for overall project | **Fixed R1** |
| 18 | R1 | claude, codex | scope | high | Summary | Plan scope too ambitious for 7-week timeline | **Fixed R1** (scope acknowledgment added) |
| 19 | R1 | codex | general | high | File Map | scripts/consensus.py listed but never scheduled for implementation | **Fixed R1** (reference added to Task 14) |
| 20 | R1 | claude | feasibility | high | Task 13: signal_client | gcloud identity token auth won't work for CLI-invoked reviews | **Fixed R1** (API key auth added) |
| 21 | R2 | claude, codex | security, feasibility | critical | Task 2: Terraform | GitHub webhooks can't reach IAM-protected Cloud Run (GitHub IPs not in domain) | **Fixed R2** (allUsers binding + server-side auth) |
| 22 | R2 | codex | api-design | high | Task 13: signal_client | Client has API key auth but server doesn't accept it | **Fixed R2** (require_auth + api_key config) |
| 23 | R2 | claude, codex | api-design | high | Task 8: FastAPI | ErrorResponse schema defined but not wired into exception handler | **Fixed R2** |
| 24 | R2 | claude | general | medium | Task 7: Tests | Test database name doesn't match docker-compose database | **Fixed R2** |
| 25 | Final | claude, codex | security | critical | Task 2: Terraform | allUsers IAM binding exposes all endpoints, not just webhooks | **Unresolved** |
| 26 | Final | claude, codex | security, completeness | critical | Task 9: Ingest | Ingest/read endpoints have no authentication middleware wired in | **Unresolved** |
| 27 | Final | claude, codex | operability | high | Phase 1 | No migration rollback procedure for production database | **Unresolved** |

---

## Fixed (Rounds 1-2)

### Round 1 — 20 findings fixed:
1. **Dockerfile build order** — moved `COPY src/` before `pip install .`
2. **IAP misconfiguration** — replaced IAP resource with IAM-based access control, documented GCLB requirement
3. **Webhook secret plaintext** — moved to Secret Manager with `value_source.secret_key_ref`
4. **SQLite test backend** — changed to PostgreSQL matching docker-compose
5. **ORM ForeignKey declarations** — added `ForeignKey()` to all relationship columns in agents.py, reviews.py, tournaments.py
6. **Admin guard fail-open** — added GCP_PROJECT check, returns 403 in production
7. **Table count** — corrected "8 tables" to "9 tables" throughout
8. **Tasks 21-25 detail** — added API endpoints, chart types, and acceptance criteria per task
9. **CI/CD** — added CI/CD section with minimum viable pipeline description
10. **Cloud Scheduler IAM** — added `roles/run.invoker` binding for service account
11. **Cloud SQL IAM user** — changed to `google_service_account.stark_signals.email`
12. **Webhook agent='all'** — emit per-agent signals from `review_run.agent_versions`
13. **TournamentImplIn schema** — added `cross_review_critical` and `cross_review_high` fields
14. **Redundant Levenshtein** — replaced custom implementation with `Levenshtein.distance()` library call
15. **Health endpoint** — added database connectivity check with 503 on failure
16. **Error schema** — added `ErrorResponse` Pydantic model
17. **Success criteria** — added 6-point success criteria section
18. **Scope acknowledgment** — added scope risk statement with Phase 2 deferral guidance
19. **scripts/consensus.py** — added Task 14 cross-reference
20. **Client auth** — added `STARK_SIGNALS_API_KEY` env var support

### Round 2 — 4 findings fixed:
1. **Webhook routing** — added `allUsers` IAM binding + server-side auth architecture
2. **Server API key auth** — added `require_auth` dependency and `api_key` config field
3. **Error handler** — wired `ErrorResponse` into FastAPI exception handler
4. **Test DB name** — aligned with docker-compose database name

---

## Unresolved (Final Round)

These findings remain after 2 fix rounds and represent design-level decisions for the implementer:

### 1. allUsers IAM binding exposes all endpoints (critical)
**Both agents flagged this.** The `allUsers` binding for webhook access also exposes all other endpoints. Mitigation options:
- Add `require_auth` dependency to all non-webhook routers (plan includes the dependency but doesn't wire it)
- Use a separate Cloud Run service for webhooks
- Use Cloud Endpoints or API Gateway for path-based auth routing

### 2. Ingest/read endpoints lack auth middleware (critical)
The `require_auth` dependency was defined but not added as a dependency to the ingest or read routers. The implementer should add `Depends(require_auth)` to all non-webhook routes.

### 3. No migration rollback procedure (high)
The plan has no runbook for rolling back a failed Alembic migration in production. Recommend adding a "Migration Safety" section to Task 6 with `alembic downgrade -1` procedure and pre-migration backup step.

---

## Noise & False Positives

| # | Agent | Domain | Title | Reasoning |
|---|-------|--------|-------|-----------|
| 1 | claude | scope | GCS archival premature | Valid design feedback but this is a planned Phase 3 task, not a bug |
| 2 | claude | scope | Bronze signals add complexity | Design choice, explicitly documented as diagnostic-only |
| 3 | claude | scope | Observability before validation | Standard practice for new services |
| 4 | codex | scope | Tournament unvalidated value | Acknowledged in scope section — Phase 2 gated on Phase 1 |
| 5 | claude | general | Static mount shadows routes | FP — FastAPI routes take precedence over mounts |
| 6 | claude | feasibility | Consensus weights empty first run | FP — seed data provides initial weights |
| 7 | claude | security | Levenshtein O(n*m) no guard | Noise — titles bounded by String(500) |
| 8 | claude | completeness | No rollback for registry | Noise — registry changes are additive |
| 9 | claude | general | lru_cache prevents test config | Standard pattern, `cache_clear()` available |
| 10 | claude | security | docker-compose exposes postgres | Noise — local dev only |
| 11 | claude | security | Deterministic seed UUIDs | Noise — agent IDs aren't security-sensitive |
| 12 | codex | api-design | API evolution strategy | Premature for v0.1 |
| 13 | codex | security | CSRF protection | API behind IAP/IAM, not browser forms |
| 14 | codex | api-design | Pagination incomplete | FP — PaginatedResponse has items/total/page |
| 15 | claude | scope | React dashboard premature | Design choice — acknowledged in scope |
| 16 | codex | operability | Capacity hard-coded | Noise — min 0 / max 3 is appropriate for a new service |
| 17 | claude | security | Spool world-readable | Noise — `~/.cache` has user-only permissions by default |
| 18 | codex | general | No end-to-end success definition | Fixed — success criteria now defined |

---

## Misalignment Analysis

| Root Cause | Count | Improvement Action |
|------------|-------|--------------------|
| **Missing auth architecture detail** | 12 | Plan should explicitly document the auth flow for each endpoint category (webhook/ingest/read/admin) |
| **Overly aggressive security prompts** | 6 | Security domain flags local-dev concerns (docker-compose ports, spool permissions) as production issues |
| **Scope criticism on deliberate choices** | 5 | Scope prompt flags Phase 2/3 items even when plan acknowledges they're gated/deferrable |
| **Migration/deployment not in scope** | 4 | CI/CD and migration runbooks are operational concerns the plan explicitly defers — prompts should weight in-scope items higher |
| **Already addressed in earlier sections** | 3 | Cross-referencing between sections is poor — reviewer misses context from other parts of the plan |

---

## Changes Made

281 insertions, 102 deletions across 24 distinct edits:

- **Added:** Success criteria section, scope acknowledgment, CI/CD section
- **Fixed (Terraform):** IAP → IAM-based auth, Secret Manager for webhook secret, Cloud SQL IAM user email, Cloud Scheduler IAM, webhook routing
- **Fixed (Code):** Dockerfile build order, ORM ForeignKeys, SQLite→PostgreSQL tests, admin guard, health endpoint DB check, error handler, API key auth, Levenshtein library, TournamentImplIn schema, webhook per-agent signals
- **Fixed (Documentation):** Table count 8→9, Tasks 21-25 detail, scripts/consensus.py reference

---

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Security domain flags local-dev config as production risk (docker-compose, spool perms) | **Global** | `global/prompts/plan-review/*/security.md` — add context: distinguish local-dev from production code |
| Scope domain re-flags items acknowledged by scope section | **Global** | `global/prompts/plan-review/*/scope.md` — instruct to check for existing scope acknowledgments |
| All agents miss the require_auth wiring gap | **Global** | `global/prompts/plan-review/*/api-design.md` — check that auth dependencies are wired into routers, not just defined |
| Gemini not dispatched for plan reviews | **Config** | Check `plan_review_dispatch.py` Gemini configuration |

---

## Metrics

```
Total duration:     ~21m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   ~17m
    Round 1 dispatch:     2m 24s
    Round 1 classify+fix: ~5m
    Round 2 dispatch:     3m 44s
    Round 2 classify+fix: ~2m
  Phase 3 (Final):        ~3m 30s
  Phase 4 (Summary):      ~30s
  Phase 5 (Output):       ~10s

Issues found:        27 (24 fixed, 3 unresolved)
Noise:               18 (10 false positive, 8 noise)
Ignored:             16 (low severity)
Agents:              14 dispatched per round, 14 succeeded, 0 failed
Rounds:              2 fix + 1 final
```

### Improvement Flags

- **Gemini not dispatched** — only 2/3 agents participated (14/21 sub-agents). Check dispatch script configuration.
- **Round 2 → Final finding count increased** (125 → 133) — round 2 fixes introduced new issues (allUsers binding). Consider adding a "regression check" step after fixes.
- **Security domain > 70% noise** — security prompts flag too many local-dev and theoretical concerns. Consider tuning severity thresholds.
