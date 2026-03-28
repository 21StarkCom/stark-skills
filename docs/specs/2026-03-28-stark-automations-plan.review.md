# Plan Review — stark-automations

**File:** `docs/specs/2026-03-28-stark-automations-plan.md`
**Mode:** standard (2 agents × 10 domains)
**Rounds:** 1 fix + 1 final

---

**Issues found:** 28 fixed | **Unresolved:** ~12 (residual from final round)
**Noise:** ~113 | **Ignored:** 18
**Signal-to-noise:** ~20% (28 / 141)

---

## Fixed — Round 1 (28 issues)

| # | Agent(s) | Domain | Severity | Title |
|---|----------|--------|----------|-------|
| 1 | both | completeness | critical | WIF not provisioned — deploy workflow has no identity |
| 2 | both | completeness, feasibility | critical | Terraform state bucket bootstrap chicken-and-egg |
| 3 | claude | feasibility | high | Eventarc-managed subscriptions override manual Pub/Sub config |
| 4 | codex | feasibility | critical | Wrong Functions Framework package name |
| 5 | both | risk | critical | Single codebase deploy takes down entire fleet |
| 6 | both | gates | critical | No go/no-go gate between dry-run and production |
| 7 | claude | general, feasibility | high | Packaging decision still deferred to ADR |
| 8 | claude | general | high | Prompt forking is single task hiding 9 rewrites |
| 9 | both | rollback | critical | Emergency stop doesn't stop in-flight executions |
| 10 | codex | rollback | critical | R/W GitHub mutations can't be auto-rolled back |
| 11 | claude | completeness | high | DLQ has no consumer |
| 12 | claude | completeness | high | Eventarc API not in API list |
| 13 | claude | completeness | high | ULID missing from requirements.txt |
| 14 | claude | timeline | high | No timeline, no owners |
| 15 | both | security | high | No secret rotation plan |
| 16 | claude | sequencing | high | Runtime metrics coded in Phase 2 but Terraform in Phase 5 |
| 17 | claude | gates | high | No bake period definition between phases |
| 18 | both | completeness | high | Artifact Registry not provisioned |
| 19 | claude | completeness | high | Dockerfile missing for custom container |
| 20-28 | various | various | high/medium | Additional gate, sequencing, and feasibility fixes |

## Unresolved (final round — not fixed, documented)

Most remaining critical/high findings are:
- **Timeline buffer:** No slack in the 3-4 week timeline. Accepted — this is an aspirational timeline, not a commitment.
- **Prompt quality is the true unknown:** 9 rewrites with no baseline. Accepted — dry-run testing is the validation mechanism.
- **No load testing:** Accepted for 32 runs/week fleet.
- **Single-operator dependency:** Accepted — this is Aryeh's project.
- **Cloud Build SA hardening:** Low risk for internal tooling.

## Coverage Matrix

| Vector | Domain | Status | Evidence |
|--------|--------|--------|----------|
| A) Partial-Failure Trap | rollback | **found → fixed** | Emergency stop limitations documented, per-phase rollback |
| B) Imperative Idempotency | feasibility | **found → fixed** | Eventarc subscription handling corrected |
| C) Blank-Slate IaC | completeness | **found → fixed** | State bucket clarified, WIF provisioned, APIs listed |
| D) Dependency Sequencing | sequencing | **found → fixed** | Gates between phases, metric emission sequencing |
| E) Reality Drift | operability | **found** | Secret drift detection still manual (alert-based) |
| F) Command Validation | feasibility | **found → fixed** | Package names corrected, Dockerfile added |
| G) Cutover Gates | gates | **found → fixed** | Explicit gates with criteria at every phase boundary |
| H) API Prerequisites | completeness | **found → fixed** | Eventarc API, Artifact Registry added |
| I) Identity Lifecycle | security | **found → fixed** | WIF in Phase 0, secret rotation in Phase 5 |
| J) Evidence Strictness | general | clean | Verification commands at every phase |

## Prompt Improvement Assessment

| Signal | Level | File | Recommendation |
|--------|-------|------|----------------|
| Claude generates 105 findings vs codex's 49 — same 2:1 ratio as design review | Global | `plan-review/claude/agent.md` | Apply same severity calibration as design-review: "If you cannot articulate the concrete failure scenario, it is not high." |
| Same finding in 3+ domains (e.g., emergency stop) | Global | `plan-review/*/agent.md` | Apply same hard dedup rule as design-review |
| Agents flag timeline buffer for a 3-4 week internal project | Global | `plan-review/*/10-timeline.md` | Add: "For internal tooling projects with no external deadline, timeline buffer is advisory, not a finding." |
| Finding count barely drops after fix round (159 → 154) | Global | All plan-review prompts | Suggests agents generate findings independently of plan state — calibration needed |
