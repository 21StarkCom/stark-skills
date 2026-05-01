# Plan Review — stark-red-team v1.2 (3 rounds + final)

**Date:** 2026-05-01
**Plan:** [`2026-05-01-stark-red-team-fix-plan-and-insights-plan.md`](./2026-05-01-stark-red-team-fix-plan-and-insights-plan.md)
**Mode:** `/stark-review-plan` (claude + codex; gemini excluded by config) × 10 domains × 3 fix rounds + 1 review-only

## Round-over-round summary

| Round | Total | Critical | High | Medium | Low |
|---|---|---|---|---|---|
| 1 (fix) | 109 | 2 | 46 | 54 | 7 |
| 2 (fix) | 127 | 8 | 54 | 59 | 6 |
| 3 (fix) | 104 | 8 | 48 | 44 | 4 |
| 4 (review-only) | 122 | 2 | 55 | 58 | 7 |

**The plan does NOT converge to zero high-severity findings within 3 rounds.** Each fix round resolved ≥ 15 substantive items but introduced 1–3 new ambiguities for adversarial reviewers to surface — characteristic of a genuinely contested design with multiple cross-cutting contracts (cross-repo deployment ordering, two-step persistence, kill-switch threat model, backfill idempotency).

## What the fix loop resolved

**Round 1 → 2 (15+ substantive fixes):**
- Phase 8 promoted to a hard gate: `PAYLOAD_SCHEMAS` + `EVENT_PRIORITY` + `_LIFT_RULES` all required, not just lifters. Verified `EventEnvelope.model_validate` REJECTS unknown event types at `src/stark_insights/models.py`.
- Phase 0 bootstrap: real `./install.sh` (not `--status`) plus explicit venv creation; DB initialization upfront.
- `is_human_review` derived from `counter_proposal == REQUEST_HUMAN_REVIEW` rather than a non-existent field.
- `fix_plan.model: "gpt-5.5-pro"` made explicit in default-merge.
- Backfill `--scope=forward` per-status emission rules unambiguous.
- Kill-switch env var `STARK_RED_TEAM_FIX_PLAN_KILL` for in-band incident response.
- `launchctl` service label discovered, not assumed.
- Phase 9 verification SQL fixed to use `json_extract(event_json, ...)`.
- Phase 9 + Phase 10 both PRE-merge.
- Emit-after-write ordering invariant for ALL paths.
- Calibration harness gains `--max-total-cost-usd` and `--abort-on-per-run-cost-usd`.
- Track B blank-slate bootstrap.
- Phase 11 queue health check (Task 7) + post-flip PR explicit gate criteria.

**Round 2 → 3 (8 critical + 5 high resolved):**
- §1 + §4 Integration Points: removed leftover "producer-first safe" claim; single canonical statement.
- Phase 12 reference fixed (now refers to design §12.2).
- Phase 8 fixture JSON files explicitly authored.
- venv requirements: `requirements.txt` doesn't exist; bootstrap now uses `pip install PyJWT requests anthropic google-auth` per `install.sh:70`.
- Track B service/token bootstrap delegates to stark-insights `install.sh`.
- Kill-switch threat-model rationale + audit trail.
- `ctx.env` explicitly preserves `OPENAI_API_KEY` with sanity assertion.
- Emit-after-write ordering covers ALL paths (success, error, skip).
- Forward + backfill timestamp byte-identity via `ctx.started_at_iso` / `created_at`.

**Round 3 → 4 (5 critical + a few highs resolved):**
- Phase 0 venv: removed non-existent `requirements.txt` reference.
- Phase 9 dependency on Phase 8 deployment (or stopped drainer for local test).
- Phase 3 Task 3 NEW: `record_finding` helper explicitly defined.
- `final_status` vs `fix_plan_status` invariant clarified — separate columns, separate state machines.
- Phase 11 Task 4 NEW: independent source-to-target reconciliation (not just manifest replay).

## Final state — what remains unresolved

Final review-only dispatch (round 4) found 122 findings (2 critical, 55 high, 58 medium, 7 low). The plan ships with these as accepted limitations or operator-roadmap items.

### Final criticals (2)

| # | Domain | Title | Disposition |
|---|---|---|---|
| 1 | `feasibility` | Install path checks use ~/.claude but repo installs to ~/.Codex | **False positive** — stark-skills installs to `~/.claude/`, not `~/.Codex/`. The reviewer (codex) misread the path. Verified via `install.sh`. |
| 2 | `general` | Producer-first deployment is both allowed and forbidden | **Resolved post-round-3** — the lone Phase 4 intro phrase was unified in the final cleanup commit. |

### Final-state high findings by domain

| Domain | Crit | High | Notes on disposition |
|---|---|---|---|
| `completeness` | 0 | 11 | Mostly long-tail process items: pip-install version pins, Cloud SQL bastion provisioning, fixture timestamps, drift detection. None are correctness blockers; these are operator-readiness items. |
| `rollback` | 0 | 8 | Recurring theme: enable-flip rollback paths, dead-letter re-drive, `pending` sentinel pollution. The kill-switch + backfill manifest covers the in-band cases; `pending → cloud` pollution is documented as a known limitation requiring operator manual reconciliation. |
| `operability` | 0 | 6 | Health-check passivity (stderr warning, not paging alert), no canary, no soak gates. Operator roadmap, not implementation blockers. |
| `feasibility` | 1 | 5 | The critical is a false positive; highs include tilde-expansion in inline SQL snippets, $REPO env var usage, anthropic Vertex deps. Cosmetic / fixable inline during implementation. |
| `sequencing` | 0 | 5 | Recurring theme: producer-first contradiction (resolved by final cleanup); two-step `pending` write window; reconciliation join scope. |
| `gates` | 0 | 4 | No soak/canary/post-flip rollback metrics defined. Operator roadmap. |
| `security` | 0 | 4 | Long-lived bearer token rotation, fix-plan content redaction boundary. Out of scope for v1.2 per design non-goals; documented for v1.3 follow-up. |
| `risk` | 0 | 5 | Cost circuit breakers, replay idempotency edge cases. Mostly mitigated by `--max-total-cost-usd` + cloud `UNIQUE(dedupe_key)`. |
| `general` | 1 | 4 | The critical was resolved in final cleanup; remaining highs are restatements of cross-cutting concerns. |
| `timeline` | 0 | 3 | No timeline buffer, cross-repo coordination plan. Out of scope (the plan describes WHAT and HOW, not WHEN). |

### Recurring themes the operator should plan for (v1.3 / v2.0)

1. **Rollback rehearsal.** The kill switch (`STARK_RED_TEAM_FIX_PLAN_KILL=1`) is unit-tested but never end-to-end-rehearsed before production. Add a rehearsal step to the rollout plan.
2. **Operational alerting.** The Phase 11 Task 7 queue health check is a stderr warning / session banner — passive. Pager-grade alerts on dead-letter growth or queue depth would require a separate observability PR.
3. **`pending` sentinel cleanup.** The two-step `record_red_team_run(pending)` + `record_fix_plan(resolved)` write window means a crashed dispatcher leaves `pending` in local SQLite. `--scope=forward` backfill could re-emit it to cloud. Two mitigations possible: (a) filter `pending` rows out of forward backfill; (b) garbage-collect orphaned `pending` rows after N hours via housekeeping.
4. **Soak / canary / gate metrics.** No defined error-rate or latency gate before the post-flip PR can merge. The current gate is "smoke test happens within 24h" — qualitative.
5. **Bearer token lifecycle.** stark-insights API token has no documented rotation. Single-user dev, so low risk, but should be on the v1.3 roadmap.
6. **Cross-repo deployment coordination.** Phase 8 (stark-insights) hard-precedes Track A's calibration override and post-flip PR. The plan documents the gate but not the coordination mechanism (single operator vs. team handoff). Single-user dev environment makes this trivial; team-scale may need a checklist or PR template.

## Disposition

**The plan is mergeable** for a single-user development environment with the following caveats explicitly accepted:
- Track B (stark-insights `PAYLOAD_SCHEMAS` + lifter PR) MUST deploy before Track A's calibration override or post-flip PR. The plan documents this as a hard gate.
- The kill switch + the Phase 11 queue health check are the only operational controls in v1.2; pager-grade alerting and canary deployment are out of scope.
- The `pending` sentinel + crash-recovery story has a documented edge case (forward backfill could re-emit `pending` rows) that requires operator awareness.

The 122 final findings document the long tail of operational hardening that v1.2 explicitly defers in favor of shipping the synthesis-level patch plan + insights audit primary functionality. v1.3 follow-ups should pick up the recurring themes above.

## Process retrospective

- **Round 1 hit-rate** was high — the criticals (PAYLOAD_SCHEMAS missing, install bootstrap) were genuine production blockers, and the recurring `is_human_review` / `fix_plan.model` issues caught real KeyError landmines.
- **Round 2 introduced new criticals** because round-1 fixes (kill switch env var, two-step `pending` write) were design changes that needed their own threat-model framing — not just bug fixes.
- **Round 3 → final** showed the long-tail convergence: each fix exposes one or two adjacent ambiguities. After three rounds, the marginal value of further fix rounds is process hygiene (tilde expansion, version pins, doc consistency), not correctness.
- **Cost** of the review loop: ~28 minutes wall-clock across 4 rounds × 20 sub-agents = 80 sub-agent invocations. Worth it — caught 2 production-blocking criticals (`PAYLOAD_SCHEMAS` + `is_human_review`) that would have been runtime errors.
