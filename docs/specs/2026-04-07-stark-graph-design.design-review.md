# Design Review — stark-graph (revised 2026-04-08)

**File:** `docs/specs/2026-04-07-stark-graph-design.md`
**Date:** 2026-04-08
**Mode:** Standard (2 agents x 12 domains)
**Rounds:** 2 fix + 1 final

---

## Headline

**Issues found:** 30 (21 round 1 + 9 round 2) | **Noise:** ~283 across 3 rounds
**Signal-to-noise:** ~10% (324 total findings, 30 real issues fixed, 5 unresolved)

---

## Fixed — Round 1 (21 issues)

| # | Agent(s) | Domain | Severity | Title | Outcome |
|---|----------|--------|----------|-------|---------|
| 1 | both | completeness | CRITICAL | No write-back mechanism for generated docstrings | Added Stage 4 (write-back) with --write flag |
| 2 | both | api-design | CRITICAL | `audit` exposed in CLI/skill but no stage definition | Defined audit as reporting mode |
| 3 | both | consistency | HIGH | Single-pass claim contradicts separate stages | Removed claim; acknowledged two traversals |
| 4 | codex | consistency | HIGH | CLI/CI examples omit parse prerequisite | Added auto-prerequisite resolution |
| 5 | both | consistency | HIGH | Validation scope doesn't cover function-level docstrings | Added correctness_validator.py |
| 6 | both | resilience | HIGH | No timeout/retry/fallback for LLM API calls | Added LLM call contract |
| 7 | claude | scope | HIGH | consumer_count creates stage ordering dependency | Deferred to optional post-graph pass |
| 8 | claude | data-modeling | HIGH | Base graph path missing from workdir | Added base-parse-python.json |
| 9 | claude | general | HIGH | GitHub App auth can't work on Linux CI | Added env-var fallback |
| 10 | claude | completeness | HIGH | Formatter rules never defined | Added formatting rules section |
| 11 | codex | security | HIGH | LLM can exfiltrate sensitive code metadata | Added redaction policy |
| 12 | both | api-design | HIGH | Intermediate JSONs lack schema versioning | Added schema_version to all |
| 13 | claude | test-plan | HIGH | Prompt injection mitigations untested | Added test coverage |
| 14 | claude | resilience | HIGH | Worktree checkout failure unhandled | Added retry + fallback |
| 15 | codex | consistency | MEDIUM | Module suppression syntax impossible | Added file-header pragma |
| 16 | claude | consistency | MEDIUM | Publishes "flagged if removed" not implemented | Clarified: diff-only visibility |
| 17 | claude | general | MEDIUM | Dual tier naming scheme | Standardized on Skip/Template/LLM/Protected |
| 18 | claude | consistency | MEDIUM | Default skill contradicts pipeline | Aligned skill table with CLI |
| 19 | codex | consistency | MEDIUM | Sole input claim vs tests in context | Changed to "primary input" |
| 20 | claude | consistency | MEDIUM | validate skill entry implies two stages | Added explicit CLI mapping |
| 21 | codex | security | HIGH | Write-capable token in all CI jobs | Scoped credentials per job |

## Fixed — Round 2 (9 issues)

| # | Agent(s) | Domain | Severity | Title | Outcome |
|---|----------|--------|----------|-------|---------|
| 22 | claude | consistency | HIGH | Skill default includes write-back without --write | Removed write-back from default |
| 23 | claude | api-design | HIGH | --include flag referenced but not in CLI | Added --include spec |
| 24 | both | general | HIGH | CI YAML doesn't show write-back | Updated YAML sketch |
| 25 | claude | consistency | MEDIUM | generate-report.json missing schema_version | Added |
| 26 | claude | consistency | HIGH | Template tier "no branches" contradicts code | Fixed to "<=1 branch" |
| 27 | both | completeness | HIGH | Depends scope (stdlib/third-party) undefined | Clarified: intra-repo only |
| 28 | claude | api-design | MEDIUM | --stage vs --stages conflict undefined | Added precedence rules |
| 29 | claude | completeness | MEDIUM | LLM prompt template format unspecified | Added input documentation |
| 30 | both | consistency | MEDIUM | CI YAML credential inconsistency | Fixed to STARK_CLAUDE_PRIVATE_KEY |

## Unresolved — Final Round (5 issues)

| # | Agent(s) | Domain | Severity | Title | Recommendation |
|---|----------|--------|----------|-------|----------------|
| U1 | both | general | CRITICAL | CI jobs don't share write-back artifacts | Implementation plan must consolidate generate+validate into one job, or use Actions artifacts to pass modified files |
| U2 | claude | completeness | HIGH | TYPE_CHECKING imports produce false MISSING | Add exclusion for `if TYPE_CHECKING:` blocks and `from __future__ import annotations` |
| U3 | both | resilience | HIGH | Write-back not atomic | Use temp-file + atomic rename pattern; document in implementation plan |
| U4 | claude | security | HIGH | LLM API key provisioning for CI undefined | Add `ANTHROPIC_API_KEY` to CI secrets documentation alongside GitHub App key |
| U5 | claude | scalability | HIGH | LLM concurrency unspecified | Add batching/concurrency model: ThreadPoolExecutor with max_workers=5 |

## Noise & False Positives

**Root cause analysis:**

| Root Cause | Count | Action |
|------------|-------|--------|
| **Phase 2/3 scope applied to MVP** | ~120 | Reviewers flag Phase 2 extensibility/scalability as MVP issues. Design already explicitly defers these. No action needed. |
| **Intentional scope decision** | ~80 | "MVP bundles two products" flagged repeatedly. This is a deliberate architecture choice. No action. |
| **Accessibility for deferred features** | ~15 | Interactive D3 explorer and SVG renderer are Phase 2; accessibility requirements don't apply yet. |
| **Testing depth beyond design scope** | ~40 | Reviewers want CI workflow E2E tests, real LLM integration tests, etc. Valid for implementation plan, not design doc. |
| **Depends semantics philosophical debate** | ~20 | "Depends is semantic but validated as imports" flagged repeatedly. The pragmatic proxy approach is documented and intentional. |
| **Prompt refinement suggestions** | ~8 | Style, wording, and presentation suggestions. Not design issues. |

## Changes Made

```
2 fix rounds, 30 issues total:
- Round 1: +180 lines, -48 lines (21 fixes)
- Round 2: +35 lines, -14 lines (9 fixes)
- Total: +215 lines, -62 lines
```

Major structural additions:
- Stage 4 (Write-back) with --write flag, safety rules, backup mechanism
- Audit Mode definition (reporting mode, not pipeline stage)
- Correctness Validator (function-level docstring validation)
- Docstring Formatting section (Google style, 88-char width)
- LLM call contract (timeout, retry, circuit breaker)
- LLM input redaction policy
- Worktree failure handling (prune + retry)
- --include, --write, --stage vs --stages CLI documentation
- CI credential scoping (no token on generate/validate jobs)
- Module-level suppression syntax

## Prompt Improvement Assessment

| Signal | Level | File |
|--------|-------|------|
| Both agents repeatedly flag Phase 2 scope as MVP issues | **Global** | `global/prompts/design-review/*/scope.md` -- add instruction to respect explicit scope boundaries |
| Codex flags "two products" as critical every round despite intentional design | **Global** | `global/prompts/design-review/codex/scope.md` -- add "do not flag deliberate scope bundling if the design explains its rationale" |
| Both agents produce ~10 accessibility findings for deferred Phase 2 features | **Global** | `global/prompts/design-review/*/accessibility.md` -- add "only flag accessibility for in-scope features, not deferred ones" |
| Depends semantics debate recurs across general, consistency, data-modeling | **Repo** | Consider adding a "Design Decisions" section explaining the Depends proxy approach |

---

## Metrics

```
Total duration:     ~13m 15s
Phases:
  Phase 1 (Setup):        15s
  Phase 2 (Review-Fix):   ~9m 30s
    Round 1 dispatch:     4m 03s
    Round 1 classify+fix: ~3m 00s
    Round 2 dispatch:     3m 47s  
    Round 2 classify+fix: ~1m 30s
  Phase 3 (Final):        5m 22s
  Phase 4 (Summary):      ~30s
  Phase 5 (Output):       ~10s

Issues found:        30 (21 round 1, 9 round 2; 5 unresolved)
Noise:               ~283 (across 3 rounds)
Agents:              72 dispatched (24 per round), all succeeded
Rounds:              2 fix + 1 final

Improvement flags:
- Triage timeout on all 3 rounds -> fell back to full mode
- High noise ratio (~10% signal) -> scope/accessibility prompts need tuning
```
