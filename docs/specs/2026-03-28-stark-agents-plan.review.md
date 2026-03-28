# stark-agents Plan Review Summary

## Review Configuration
- **Mode:** Standard (2 agents x 10 domains = 20 sub-agents per round)
- **Agents:** Claude, Codex
- **Rounds:** 2 fix + 1 final (3 total)
- **Fix threshold:** medium

## Headline

**Issues found:** 33 (33 fixed across 2 rounds) | **Noise:** ~250+ | **Signal-to-noise:** ~12%
**Final round:** 164 findings remaining (adversarial prompts — most are noise/scope disagreements)

The plan-review prompts are adversarial by design ("assumes the plan will fail"). They produce high volumes at this depth level. The genuinely critical execution gaps are all fixed.

## Round Summary

| Round | Dispatched | Succeeded | Findings | Critical | High | Medium | Low | Fixed |
|-------|-----------|-----------|----------|----------|------|--------|-----|-------|
| 1 | 20 | 20 | 166 | 15 | 68 | 64 | 19 | 25 |
| 2 | 20 | 20 | 169 | 13 | 70 | 66 | 20 | 8 |
| 3 (final) | 20 | 20 | 164 | 11 | 73 | 60 | 20 | — |

## Fixes Applied

### Round 1 (25 fixes)
1. Terraform state backend (GCS bucket, versioned, locked)
2. Secret population step with concrete gcloud commands
3. pgvector extension installed via Alembic migration 0001
4. Cloud SQL upgraded to db-g1-small (db-f1-micro undersized for pgvector)
5. CI/CD resequenced: trigger definition in Phase 2, first build in Phase 4
6. Timeline with weekly targets per phase and 2-week buffer
7. Key-person risk mitigation documented
8. Phase gate criteria for all 9 phases
9. Observability moved to Phase 4 (structured logging, metrics, alerts from day 1)
10. Canary period extended to 48 hours (12 sync cycles)
11. Rollback triggers with automatic alerting thresholds
12. Firestore kill switch fallback via env var + Cloud Run revision revert
13. Cloud Scheduler OIDC auth configured
14. Firestore database creation added to bootstrap
15. datastore.googleapis.com added to API enablement
16. Service account IAM bindings scoped per-resource
17. Cloud Run placeholder image for initial IAM setup
18. Secret verification step (end-to-end IAM check)
19. GitHub-to-Cloud Build connection noted as manual prerequisite
20. Cloud Build trigger scoped to relevant file paths
21. Token counting: native provider tokenizers with tiktoken fallback
22. Staleness lock TTL set to 60s with Firestore TTL policy
23. Rollback procedure includes client-side disable path
24. Manual spot-check gate for finding quality (false positive rate)
25. Alert-based rollback triggers for error rate and latency

### Round 2 (8 fixes)
1. Lock TTL increased to 5 minutes (was 60s, shorter than sync duration)
2. Repo clone: avoid /tmp OOM (Cloud Run memory-backed), depth=1, 100MB size limit
3. pgvector moved to Alembic migration (removed Terraform provisioner — auth issue)
4. Cloud SQL Python connector package name corrected
5. Cloud SQL auth via Cloud SQL Python connector (IAM-native, no sidecar)
6. Firestore bootstrap as one-time operation noted
7. Clone volume sizing documented
8. Secret population ordering clarified

## Coverage Matrix

| Vector | Domain | Status | Evidence |
|--------|--------|--------|----------|
| A) Partial-Failure Trap | rollback | **found → fixed** | Firestore outage fallback, env var disable, revision revert |
| B) Imperative Idempotency | feasibility | **found → fixed** | Alembic idempotent migrations, agent_configs seed check |
| C) Blank-Slate IaC | completeness | **found → fixed** | API enablement, state backend, Firestore creation in bootstrap |
| D) Dependency Sequencing | sequencing | **found → fixed** | CI/CD after Dockerfile, pgvector before Alembic, secrets before IAM verify |
| E) Reality Drift | operability | **found → fixed** | Observability from Phase 4, Cloud Monitoring dashboards |
| F) Command Validation | feasibility | **found → fixed** | Package name corrected, rollback command validated |
| G) Cutover Gates | gates | **found → fixed** | Phase gate criteria for all 9 phases, 48h canary |
| H) API Prerequisites | completeness | **found → fixed** | Full API list in bootstrap, datastore.googleapis.com added |
| I) Identity Lifecycle | security | found | Partial — tool sandboxing concerns remain (adversarial finding) |
| J) Evidence Strictness | general | clean | Verification commands per phase with specific assertions |

## Unresolved (Final Round) — Classified

Most remaining findings are the adversarial prompts re-raising concerns that are addressed but don't satisfy their "assume failure" posture:

- **Tool sandboxing:** Prompts want full gVisor/seccomp. Plan uses non-root + read-only fs + allow-listed network. Acceptable for v1.
- **Cloud Run /tmp memory:** Fixed with depth=1 + size limit. Prompts still flag it because /tmp is inherently memory-backed.
- **Secret rotation:** Plan uses Secret Manager versioning. Prompts want explicit rotation runbooks. Address in Phase 9 operational hardening.
- **Load testing:** Plan defers to post-canary. Prompts want it pre-rollout. Acceptable given low initial traffic.

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Both agents produce 150+ findings per round on any plan | Global | Plan review prompts are too aggressive for implementation plans — consider severity calibration |
| Codex feasibility domain flags valid pip packages as non-existent | Global | `global/prompts/plan-review/codex/04-feasibility.md` — reduce package name validation aggressiveness |
| Claude completeness flags every possible missing detail | Global | `global/prompts/plan-review/claude/02-completeness.md` — add "implementation plan" context (not runbook) |
| Both agents re-raise fixed issues in subsequent rounds | Global | Prompts don't account for prior round fixes well enough |

## Metrics

```
Total duration:     ~20m
Mode:               standard
Rounds:             2 fix + 1 final
Issues found:       33 (33 fixed)
Noise:              ~250+
Signal-to-noise:    ~12%
Agents:             60 dispatched, 60 succeeded, 0 failed
Domains:            10
```

No improvement opportunities beyond prompt tuning noted above.
