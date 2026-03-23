# Plan Review — stark-signals Implementation Plan (Run 2)

**File:** `docs/superpowers/plans/2026-03-23-stark-signals.md`
**Date:** 2026-03-23
**Rounds:** 2 fix + 1 final (this is the second review pass; first pass fixed 24 issues)
**Agents:** claude, codex (14/14 sub-agents per round; gemini not dispatched)

---

## Headline

**Issues found:** 10 | **Noise:** 15 | **Ignored:** 20
**Signal-to-noise:** 40%

---

## All Findings Table

| # | Round | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|-------|----------|--------|----------|---------|-------|---------|
| 1 | R1 | claude, codex | security, operability, api-design, completeness, feasibility | critical | Task 2: Terraform | allUsers IAM binding + no auth on routers = unauthenticated access | **Fixed R1** |
| 2 | R1 | codex | general, feasibility | critical | Task 3: Dockerfile | Phase 1 container build depends on Phase 2 frontend | **Fixed R1** |
| 3 | R1 | claude, codex | general, feasibility | high | Task 14: multi_review.py | `_send_to_signal_store` defined but never called | **Fixed R1** |
| 4 | R1 | claude | general | high | File Map | `scripts/consensus.py` listed but no task creates it | **Fixed R1** |
| 5 | R1 | claude | operability | high | Task 6: Alembic | No rollback plan for database migrations | **Fixed R1** |
| 6 | R1 | claude | security | high | Task 12: Webhook | Webhook secret empty-string default bypasses HMAC verification | **Fixed R1** |
| 7 | R1 | codex | operability | high | Task 2: Terraform | Liveness probe depends on DB — kills instances during DB outage | **Fixed R1** |
| 8 | R1 | claude | api-design | high | Task 11: Mutations | Duplicate `/signals` POST endpoint across two routers | **Fixed R1** |
| 9 | R1 | claude, codex | security | critical | Task 8: FastAPI | `require_auth` trusts spoofable header without JWT validation | **Fixed R1** (JWT TODO + API key path added) |
| 10 | Final | claude, codex | security | critical | Task 2: Terraform | allUsers IAM + header-based auth = identity spoofing risk | **Unresolved** |

---

## Fixed (Round 1) — 9 issues

1. **Auth wired into routers** — added `dependencies=[Depends(require_auth)]` to ingest, read, and mutations routers; webhooks exempt (HMAC-verified)
2. **Dockerfile conditional frontend** — build stage checks if `frontend/package.json` exists, produces placeholder if not
3. **`_send_to_signal_store` call site** — added explicit call at end of review orchestration
4. **`scripts/consensus.py` task** — added creation reference to Task 14 with description of client-side consensus wrapper
5. **Migration rollback procedure** — added 5-step procedure (backup → deploy → downgrade → restore) to Task 6
6. **Webhook secret empty check** — `_verify_signature` now returns `False` when secret is empty
7. **Liveness vs readiness probes** — liveness uses `/livez` (no DB check), startup/readiness uses `/health` (checks DB)
8. **Duplicate `/signals` endpoint** — renamed admin signal creation to `POST /admin/signals`
9. **JWT validation TODO** — added detailed comment about validating `X-Goog-IAP-JWT-Assertion` instead of email header; API key provides alternative auth path

---

## Unresolved (Final Round)

### 1. allUsers IAM + spoofable auth header (critical, both agents)

The fundamental architectural tension: GitHub webhooks require `allUsers` IAM invoker access to Cloud Run, but that makes `X-Goog-Authenticated-User-Email` headers spoofable for non-webhook requests.

**Current mitigations (all applied in previous + this review):**
- `require_auth` dependency on all non-webhook routers
- API key auth as alternative to header-based auth
- JWT validation TODO documented

**Remaining options for the implementer:**
1. **Validate JWT assertion header** (`X-Goog-IAP-JWT-Assertion`) instead of email header — this is signed by Google and can't be spoofed
2. **Split services** — separate Cloud Run service for webhooks (allUsers) and API (IAM-restricted)
3. **Cloud Endpoints / API Gateway** — path-based auth routing in front of Cloud Run

This is a design decision that depends on operational preferences. All three options are viable.

---

## Noise & False Positives (15)

| # | Agent | Domain | Title | Reasoning |
|---|-------|--------|-------|-----------|
| 1 | claude | scope | GCS archival premature | Design choice — Phase 3 task, acknowledged |
| 2 | claude | scope | Bronze signals add complexity | Diagnostic-only by design |
| 3 | claude | scope | Observability before validation | Standard practice for new services |
| 4 | claude | scope | Tasks 21-25 underspecified | Already acknowledged in plan text |
| 5 | codex | scope | Tournament unvalidated | Phase 2 gated on Phase 1 validation |
| 6 | codex | scope | Initial schema includes Phase 2/3 tables | Acceptable for a monolithic initial migration |
| 7 | codex | general | Consensus ownership contradictory | Server-side computation with client-side orchestration is the intended design |
| 8 | codex | operability | No deploy pipeline | CI/CD section exists, declared as follow-up |
| 9 | codex | operability | Observability stops at metrics | Reasonable for Phase 1 scope |
| 10 | codex | api-design | API versioning no evolution policy | Premature for v0.1 |
| 11 | codex | completeness | Bronze signals no persistence | Diagnostic-only by design |
| 12 | codex | completeness | Multi-round review semantics unspecified | Each round is independent; consensus runs per-round |
| 13 | codex | security | Webhook secrets in Terraform state | Inherent to Terraform; Secret Manager stores the runtime value |
| 14 | claude | security | Spool file unencrypted on disk | `~/.cache` has user-only permissions |
| 15 | claude | feasibility | Tournament requires all 3 CLIs | By design — graceful degradation if one is missing |

---

## Changes Made (this run)

68 insertions, 13 deletions across 10 edits:
- Wired `require_auth` into all non-webhook router dependencies
- Conditional Dockerfile frontend build
- `_send_to_signal_store` call site
- `scripts/consensus.py` in Task 14
- Migration rollback procedure
- Webhook secret empty check
- Liveness (`/livez`) vs readiness (`/health`) probe split
- Admin signal endpoint renamed to `/admin/signals`
- JWT validation TODO + explanation
- `require_auth` header trust documentation

---

## Prompt Improvement Assessment

| Signal | Recommended Level | File |
|--------|-------------------|------|
| Both agents repeatedly flag allUsers + header auth across all domains (15+ findings on same issue) | **Global** | All plan-review prompts — add dedup: if the same architectural issue appears in another domain's findings, reference it rather than re-flagging |
| Security domain flags local-dev concerns (spool encryption, docker ports) | **Global** | `global/prompts/plan-review/*/security.md` — distinguish local-dev from production code |
| Scope domain re-flags items already acknowledged | **Global** | `global/prompts/plan-review/*/scope.md` — check for scope acknowledgment sections before flagging |
| Gemini not dispatched | **Config** | Investigate `plan_review_dispatch.py` Gemini configuration |

---

## Metrics

```
Total duration:     ~13m
Phases:
  Phase 1 (Setup):        3s
  Phase 2 (Review-Fix):   ~9m
    Round 1 dispatch:     2m 20s
    Round 1 classify+fix: ~3m 30s
    Round 2 dispatch:     3m 44s
    Round 2 classify:     ~30s (no fixes needed)
  Phase 3 (Final):        ~3m 30s
  Phase 4 (Summary):      ~30s
  Phase 5 (Output):       ~10s

Findings: R1: 127 → R2: 129 → Final: 131
Issues found:      10 (9 fixed, 1 unresolved)
Noise:             15
Ignored:           20 (low severity)
Agents:            14 dispatched per round, 14 succeeded, 0 failed
Rounds:            2 fix + 1 final
```

### Improvement Flags

- **Gemini not dispatched** — only 2/3 agents (14/21 sub-agents). Check dispatch script.
- **Finding deduplication needed** — allUsers auth issue accounts for 15+ findings across domains. Cross-domain dedup would reduce noise by ~12%.
- **Security domain > 60% noise** — security prompts flag theoretical and local-dev concerns disproportionately.

### Comparison with Run 1

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| Starting findings | 157 | 127 |
| Critical (R1) | 6 | 6 → 2 (after fix) |
| Issues fixed | 24 | 9 |
| Final unresolved (critical) | 3 | 1 |
| Signal-to-noise | 60% | 40% |

Run 2 found fewer actionable issues (plan was already improved), but signal-to-noise degraded because agents keep re-flagging the same architectural tension.
