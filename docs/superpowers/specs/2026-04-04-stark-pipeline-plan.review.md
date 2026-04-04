# Plan Review — stark-pipeline

**File:** `docs/superpowers/specs/2026-04-04-stark-pipeline-plan.md`
**Review date:** 2026-04-04
**Mode:** standard (2 agents × 10 domains)
**Rounds:** 1 fix + 1 final

---

**Issues found:** 28 fixed + ~20 unresolved | **Noise:** ~85 | **Ignored (low):** 21
**Signal-to-noise:** ~36% (adversarial plan review is intentionally noisy — assumes the plan will fail)

---

## Fixed (Round 1) — 28 issues

| # | Agent(s) | Domain | Severity | Title | Fix |
|---|----------|--------|----------|-------|-----|
| 1 | both | feasibility | critical | `gh issue list` truncates at 30 items | Added `--limit 200` + pagination |
| 2 | both | completeness | critical | Implementation dispatch step missing from task loop | Added step ② (dispatch_worktree) to 4.2 |
| 3 | both | sequencing | critical | Startup orphan sweep deletes worktree needed for resume | Sweep checks state.json current_task, preserves it |
| 4 | claude | completeness | critical | No behavior for escalation in headless environments | Auto-abort critical, auto-skip medium when !isatty |
| 5 | claude | risk | critical | Stale lock reclaim races corrupt checkpoint | PID liveness check via os.kill(pid, 0) |
| 6 | claude | risk | critical | Rebase conflict after merge has no handling | Escalate with conflict details |
| 7 | both | general | high | base_sha capture point undefined | Assigned to checkpoint init in 2.1 |
| 8 | claude | sequencing | high | Engine needs escalation.py before Phase 4 creates it | Stub escalation.py in Phase 3 |
| 9 | codex | sequencing | high | --start-at can bypass required upstream artifacts | Validation added: error if artifacts missing |
| 10 | both | gates | high | PR merge doesn't wait for checks/mergeable | Poll gh pr view --json mergeable, 60s timeout |
| 11 | claude | general | high | plan-to-tasks is significant refactor in 1 task | Split into 4 subtasks (3.4a-d) |
| 12 | both | risk | high | Cost ceiling checked too late (after stage) | Check per-invocation during fan-out |
| 13 | claude | feasibility | high | git checkout main runs in wrong CWD | git -C {repo_root} for main refresh |
| 14 | claude | risk | high | Release tag created but Release fails → deadlock | Idempotent: tag exists + no Release → create Release |
| 15 | codex | general | high | Issue ordering can execute in wrong dependency order | Tasks ordered by issue number (creation order from plan-to-tasks) |
| 16 | claude | general | high | design_to_plan_dispatch.py mode interface assumed | Added prereq verification step |
| 17 | codex | completeness | high | plan-to-tasks adapter omits label contract | Added label validation subtask 3.4c |
| 18 | codex | completeness | high | Handle plan changes on resume | Added drift detection subtask 3.4d |
| 19 | claude | security | high | dispatch_cli shell injection risk | list[str] command, no shell=True |
| 20 | both | security | high | Thread-unsafe GH_TOKEN | Per-subprocess env dict, never process-wide |
| 21 | claude | risk | high | Token extraction may crash on CLI changes | Resilient extraction: warn + None on missing fields |
| 22 | codex | risk | high | Orphan sweep deletes live worktree | Only sweep slugs with no active state.lock |
| 23 | codex | feasibility | high | Release can tag stale main after docs PR | Refresh main after docs-update merge |
| 24 | claude | general | high | No overarching measurable success criteria | Added 7 measurable success criteria |
| 25 | both | completeness | high | Required modules not verified before start | Added pre-implementation verification step |
| 26 | both | feasibility | high | Semaphore limits hardcoded | Made configurable in pipeline config section |
| 27 | codex | gates | high | Reconciliation gate between issues and execution | Added reconciliation check in 4.2 |
| 28 | both | operability | high | Disk space not checked before worktree | Added 1GB free space guard |

## Unresolved (Final Review) — notable findings

These findings from the final review represent real refinements to address during implementation:

| # | Severity | Domain | Title |
|---|----------|--------|-------|
| 1 | critical | rollback | No rollback for code already merged to main (intentional — rollback disables tool, doesn't revert work) |
| 2 | critical | general | Review/fix loop may not converge — agent could oscillate between fixes |
| 3 | high | timeline | No calendar timeline or contingency buffer |
| 4 | high | gates | No formal go/no-go between phases |
| 5 | high | operability | No monitoring/alerting beyond TUI |
| 6 | high | rollback | Schema migrations have no downgrade path |
| 7 | high | risk | GitHub API rate limiting for high-task pipelines |
| 8 | high | security | PAT scope/rotation not specified |
| 9 | high | completeness | Intra-stage checkpointing for long fan-out stages |
| 10 | high | feasibility | Lock helper atomicity unclear |

Most of these (#3-5, #8) are intentional scope decisions for a v1 local dev tool. #2, #6, #7, #9, #10 are implementation-time decisions that don't need plan-level specification.

## Noise Analysis

| Root Cause | Count | Examples |
|------------|-------|---------|
| **Enterprise-grade expectations on v1 local tool** | ~30 | Formal phase gates, calendar timeline, monitoring dashboards, PAT rotation, trust boundaries |
| **Adversarial scope inflation** | ~25 | Canary deploys, bake periods, circuit breakers, approval workflows, soak gates |
| **Redundant re-flagging of intentional design decisions** | ~15 | Claude-only implementation, fixed stage list, no plugin architecture |
| **Implementation details not needed in plan** | ~15 | Specific error message wording, exact retry classification per exit code, audit log format |

## Changes Made (Round 1)

```
 docs/superpowers/specs/2026-04-04-stark-pipeline-plan.md | 74 insertions(+), 24 deletions(-)
```

---

## Metrics

```
Total duration:     ~17m
Phases:
  Phase 1 (Setup):        1s
  Phase 2 (Review-Fix):   11m 14s
    Round 1 dispatch:     5m 30s (20/20 succeeded)
    Round 1 classify+fix: 5m 44s
  Phase 3 (Final):        5m 46s (20/20 succeeded)
  Phase 4 (Summary):      ~1m
  Phase 5 (Output):       ~30s

Issues found:        ~48 real (28 fixed, ~20 unresolved)
Noise:               ~85
Ignored (low):       21
Signal-to-noise:     ~36%
Agents:              40 dispatched, 40 succeeded, 0 failed
Rounds:              1 fix + 1 final
```

No improvement opportunities detected (all agents succeeded, no phase > 70% of total).
