# Design Review — stark-host-aware-monorepo-design

**File:** `docs/superpowers/specs/2026-04-05-stark-host-aware-monorepo-design.md`
**Mode:** standard (2 agents × 12 domains)
**Rounds:** 2 fix + 1 final
**Date:** 2026-04-05

---

## Headline

**Issues found:** 38 (35 fixed, 3 unresolved) | **Noise:** 73 | **Ignored:** 39
**Signal-to-noise:** 34%

---

## All Findings Table

### Round 1 (114 findings → 27 deduplicated themes fixed)

| # | Agent(s) | Domain(s) | Severity | Section | Title | Outcome |
|---|----------|-----------|----------|---------|-------|---------|
| 1 | both | consistency | critical | Rollout Plan | Runtime normalization described as "now" but deferred to Phase 4 | **fixed** — collapsed to 3 phases, runtime in Phase A |
| 2 | both | consistency | high | Host Adapter Model | HostAdapter Protocol ↔ capabilities table mismatch (3 capabilities with no interface) | **fixed** — split into base + optional protocols, matched capabilities |
| 3 | both | consistency | high | Packaging/Install | Host ID naming inconsistency (claude-code in config vs claude in CLI) | **fixed** — canonical IDs + short aliases documented |
| 4 | both | consistency | high | Configuration Model | Config ownership split (shared vs host-local undefined) | **fixed** — separate shared/host config files, merge order defined |
| 5 | both | completeness | high | Shared Workflow Model | Artifact/telemetry schemas never defined | **fixed** — added WorkflowResult schema, noted schemas are implementation plan deliverables |
| 6 | both | api-design | high | Shared Workflow Model | Contract versioning has no evolution policy | **fixed** — added integer versioning, breaking/additive rules |
| 7 | both | api-design | high | Failure Handling | No standard error envelope for workflow outcomes | **fixed** — added WorkflowResult with outcome + worker_results + blocked_reason |
| 8 | both | extensibility | high | Host Adapter Model | Adapter is monolithic and unversioned | **fixed** — split into HostAdapterBase + optional capability protocols |
| 9 | both | scope | high | Host Adapter/Phase 1 | Adapter surface broader than first-wave needs | **fixed** — marked 3 capabilities as optional, minimal first-wave scope |
| 10 | both | scope | high | Shared Workflow/Phase 1 | Phase 1 contract scope unbounded (implies all 26 workflows) | **fixed** — scoped to 5 first-wave workflows only |
| 11 | both | resilience/completeness | high | Worker Model | Worker degradation thresholds undefined | **fixed** — added degradation_policy per workflow contract |
| 12 | both | scalability/resilience | high | Runtime Layout | Concurrent runtime access undefined, parallel runs collide | **fixed** — added run-scoped namespacing, concurrency model, lock protocol |
| 13 | both | data-modeling | high | Runtime Layout | Telemetry 3-store confusion (queue.db + buffer.db + events.jsonl) | **fixed** — collapsed to events.jsonl only for V1 |
| 14 | both | resilience/completeness | high | Migration | No rollback, idempotency, or recovery for migration | **fixed** — added 3-phase migration, checkpoints, rollback, dry-run |
| 15 | both | security | high | Configuration Model | Secrets management omitted | **fixed** — added secrets section, approved backends, never-in-config rule |
| 16 | claude | api-design | medium | Shared Workflow Model | Worker dispatch/result API unspecified | **fixed** — added WorkerDispatchRequest/Result dataclasses |
| 17 | claude | completeness | high | Repository Topology | Python package import model unspecified | **fixed** — added Python packaging section (pyproject.toml, editable install) |
| 18 | claude | general | high | Codex Product Strategy | Codex CLI skill extensibility model not verified | **fixed** — added blocking prerequisite + fallback path |
| 19 | claude | general | high | Host Adapter Model | HostAdapter has no concurrency contract | **fixed** — added thread-safety requirement, serialization rules |
| 20 | claude | security | high | Worker Model | Worker CLI invocation lacks input sanitization | **fixed** — added subprocess list-only requirement, security tests |
| 21 | both | security | medium | Runtime Layout | Sensitive artifacts stored with no permission spec | **fixed** — added mode 0700/0600 requirements |
| 22 | both | test-plan | high | Testing Strategy | No unit test strategy for shared core | **fixed** — added unit test layer |
| 23 | both | test-plan | high | Testing Strategy | No test environment/worker dependency strategy | **fixed** — added test environment matrix |
| 24 | both | test-plan | high | Testing Strategy | Failure scenario tests absent | **fixed** — added failure scenario test matrix |
| 25 | claude | general | medium | Migration Table | org/evinced/ migration unowned | **fixed** — assigned to Phase B |
| 26 | both | data-modeling | medium | Runtime Layout | No retention/rotation policy | **fixed** — added configurable retention with defaults |
| 27 | claude | completeness | high | Topology | Layout over-nested (packages/core/python/) | **fixed** — flattened to stark_core/ at repo root |

### Round 2 (116 findings → 11 fixed, 2 recurring)

| # | Agent(s) | Domain | Severity | Section | Title | Outcome |
|---|----------|--------|----------|---------|-------|---------|
| 28 | claude | general | **critical** | Telemetry Model | PIPE_BUF atomicity does not apply to regular files | **fixed (recurring)** — replaced with flock-based writes |
| 29 | claude | general | **critical** | Migration | New-format artifacts invisible on rollback | **fixed (recurring)** — added rollback limitation docs |
| 30 | both | consistency | high | Workflow paths | Stale packages/contracts/ reference | **fixed** — updated to contracts/ |
| 31 | claude | api-design | high | Host Adapter | ProgressHandle type undefined | **fixed** — added dataclass definition |
| 32 | claude | api-design | high | Host Adapter | EnvironmentInfo type undefined | **fixed** — added dataclass definition |
| 33 | codex | resilience | high | Adapter error contract | runtime_paths failure classified as degraded instead of blocked | **fixed** — changed to blocked |
| 34 | claude | resilience | high | Worker dispatch | No retry policy for worker dispatch | **fixed** — added max_retries to dispatch request |
| 35 | both | general/completeness | high | Codex Strategy | Codex prerequisite has no owner or deadline | **fixed** — added owner, deadline, and fallback |
| 36 | codex | consistency | high | Success Criteria | Sessions required now but deferred to Phase C | **fixed** — updated SC4 to exclude sessions |
| 37 | claude | resilience | medium | Concurrency Model | Lock acquisition timeout undefined | **fixed** — added 30s default timeout |
| 38 | codex | security | high | Runtime Telemetry | No telemetry redaction policy | **fixed** — added redaction requirements |

### Final Round (110 findings — review only, no fixes)

| Status | Count | Notes |
|--------|-------|-------|
| Unresolved | 3 | capability taxonomy consistency, config example, lock recovery Phase A assignment |
| Deferred to implementation plan | ~50 | full artifact/telemetry schemas, history record format, detailed API contracts |
| Noise | ~40 | extensibility plugin models, load test detail, accessibility UX in architecture spec |
| Ignored (low) | 16 | |

---

## Unresolved (from final round)

1. **Capability taxonomy: contract `capabilities` field structure contradicts taxonomy** (critical, claude/consistency) — The workflow contract example still uses a flat string array, but the taxonomy section defines 3 types (host capabilities, core services, external prerequisites). The contract schema shape should use separate fields. *Resolution: fix during implementation plan's contract definition work.*

2. **Config example shows `stark-review` as 3-worker workflow** (high, claude/consistency) — The config example lists `"worker_set": ["claude", "codex", "gemini"]` for `stark-review`, but `/stark-review` is the single-agent review. This should be `stark-team-review`. *Resolution: trivial fix, will address during plan.*

3. **Stale lock recovery has no Phase A implementation** (high, claude/resilience) — Lock recovery was assigned to `stark_doctor.py` which is deferred to Phase B. Phase A needs basic lock timeout without the full doctor tool. *Resolution: include basic timeout-based recovery in Phase A's runtime implementation.*

---

## Noise & False Positives

| Root Cause | Count | Assessment |
|------------|-------|-----------|
| **Requesting implementation-plan detail in design spec** | ~50 | Agents want full JSON schemas for artifacts, telemetry events, history records. These are appropriate for the implementation plan, not the architectural design spec. The spec correctly identifies what needs schemas; defining them is plan/implementation work. |
| **Extensibility concerns for V1 scope** | ~15 | Worker plugin models, host registration discovery, capability version negotiation. Valid for a mature system but premature when only 2 hosts and 3 workers exist. |
| **Accessibility UX in architecture spec** | ~6 | Codex agent consistently flags accessibility requirements. Valid for an accessibility company, but this is an architecture spec, not a UX spec. Accessibility requirements belong in host product specs. |
| **Load/stress test detail** | ~8 | Agents want specific load test plans. The spec correctly identifies concurrency testing as a category; detailed test plans are implementation work. |

---

## Changes Made

Two fix rounds applied 38 changes across 27+11 themes:

**Structural:**
- Collapsed 5 rollout phases to 3 (A/B/C), moved runtime normalization before host extraction
- Flattened repository topology (stark_core/ not packages/core/python/)
- Split HostAdapter into required base + 3 optional capability protocols
- Defined separate shared/host/org config files with explicit merge order

**Contracts and APIs:**
- Added WorkflowResult return schema
- Added WorkerDispatchRequest/Result with timeout and retry
- Added worker degradation policy per workflow contract
- Added contract versioning policy (integer versions, additive/breaking rules)
- Added ProgressHandle and EnvironmentInfo type definitions

**Runtime:**
- Collapsed telemetry to events.jsonl only (no premature SQLite)
- Added run-scoped namespacing for artifact isolation
- Added concurrency model (locks with TTL and timeout, flock for telemetry)
- Added retention policy with configurable defaults
- Added file permission requirements (0700/0600)

**Security:**
- Added secrets management section (Keychain/env vars, never in config/runtime)
- Added worker CLI safety (subprocess list-only, no shell=True)
- Added telemetry redaction policy

**Migration:**
- Added 3-phase migration with checkpoints and dry-run
- Added source precedence rules (Stark > legacy, epoch-based)
- Added rollback support with documented limitations
- Added installer idempotency requirements

**Testing:**
- Added unit test layer (hermetic, no live workers)
- Added failure scenario test matrix (per failure class)
- Added security conformance tests (mandatory in CI)
- Added test environment strategy matrix

**Codex:**
- Added Codex wrapper format (AGENTS.md) and blocking prerequisite
- Added fallback path (Python CLI) if Codex CLI lacks extension support
- Added prerequisite owner and deadline

---

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Both agents persistently request full schemas in a design spec | Global | `global/prompts/design-review/*/completeness.md` — add context that design specs define what needs schemas, not the schemas themselves |
| Codex agent flags accessibility UX in every architecture review | Global | `global/prompts/design-review/codex/accessibility.md` — distinguish architecture specs from product/UX specs |
| Both agents re-flag deferred items as unresolved across rounds | Global | All domain prompts — add round-awareness: if a prior round classified something as deferred-to-plan, don't re-flag it |

---

## Metrics

```
Total duration:     22m 47s
Phases:
  Phase 1 (Setup):        8s
  Phase 2 (Review-Fix):   ~16m
    Round 1 dispatch:     2m 58s (178s)
    Round 1 classify+fix: ~5m
    Round 2 dispatch:     3m 36s (216s)
    Round 2 classify+fix: ~4m
  Phase 3 (Final):        ~4m (review-only dispatch)
  Phase 4 (Summary):      ~2m
  Phase 5 (Output):       pending

Issues found:        38 (35 fixed, 3 unresolved)
Noise:               73
Ignored (low):       39
Signal-to-noise:     34%
Agents:              72 dispatched (24×3 rounds), 72 succeeded, 0 failed
Rounds:              2 fix + 1 final
```

### Improvement flags

- Signal-to-noise at 34% — agents generate ~2x noise vs real issues. Round-awareness in prompts would reduce repeat noise.
- Round 2 had only 2 recurring issues (both from round 1 additions) — fix quality was high.
- Triage consistently timed out and fell back to full dispatch — triage agent performance should be investigated.
