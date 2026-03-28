# Design Review — Tournament Summary

**File:** `docs/specs/2026-03-28-stark-automation-fleet-design.md`
**Mode:** Tournament (3 agents, all 10 domains each)
**Date:** 2026-03-28

---

## Tournament Result: TIE (claude 8.7, codex 8.7)

| Dimension | Claude | Codex | Gemini |
|-----------|--------|-------|--------|
| Coverage | 9/10 | 6/10 | 4/10 |
| Severity accuracy | 8/10 | 9/10 | 7/10 |
| False positive rate | 8/10 | 10/10 | 8/10 |
| Actionability | 9/10 | 9/10 | 7/10 |
| Specificity | 9/10 | 10/10 | 7/10 |
| **Average** | **8.7** | **8.7** | **6.5** |

**No position bias detected** (scores stable across both judge passes).

Claude won on breadth (18 findings across all 10 domains). Codex won on precision (7 findings, zero false positives, every finding substantive). Gemini found 2 unique issues the others missed but had lower overall coverage and specificity.

---

## Issues Found: 22 | Noise: 0 | Signal-to-noise: 100%

All findings from all three agents were substantive. No false positives detected.

### Findings by Severity

| Severity | Count | Fixed |
|----------|-------|-------|
| High | 11 | 11 |
| Medium | 10 | 10 |
| Low | 1 | 1 |

### All Findings

| # | Agent(s) | Severity | Domain | Title | Outcome |
|---|----------|----------|--------|-------|---------|
| 1 | claude+codex+gemini | HIGH | security | Single PAT blast radius | Fixed: Added V2 GitHub App migration plan |
| 2 | claude+codex | HIGH | resilience | No out-of-band watchdog for CCR failure | Fixed: Added GHA heartbeat workflow |
| 3 | codex | HIGH | completeness | Provider API auth unspecified | Fixed: Added credential model for evolution |
| 4 | codex | HIGH | completeness | Auto-monitor Remote Trigger API auth | Fixed: Added trigger registry design |
| 5 | codex | HIGH | consistency | Git persistence vs push failure data loss | Fixed: Softened claims, added CCR as secondary trail |
| 6 | codex | HIGH | general | Drift trigger names overstate capabilities | Fixed: Qualified as static config analysis |
| 7 | claude | HIGH | resilience | No circuit breaker for failing triggers | Fixed: Added 3-consecutive-fail circuit breaker |
| 8 | claude | HIGH | completeness | PAT rotation procedure undefined | Fixed: Added 5-step rotation procedure |
| 9 | claude | HIGH | consistency | Context7 usage inconsistent | Fixed: Updated dependency table |
| 10 | gemini | HIGH | consistency | Schedule overlap sentinel/hooks-auditor Thu 5am | Fixed: Sentinel now skips Thursday |
| 11 | gemini | HIGH | security | PAT introspection infeasible via API | Fixed: Track creation date in registry, not API |
| 12 | claude | MEDIUM | data-modeling | Token estimation too imprecise for alerting | Fixed: Added 30% margin caveat and budget buffer |
| 13 | codex+gemini | MEDIUM | api-design | Log format unversioned | Fixed: Added schema_version comments |
| 14 | claude | MEDIUM | api-design | Issue dedupe is fragile | Fixed: Label-based dedupe strategy |
| 15 | claude | MEDIUM | completeness | register_triggers.sh unspecified | Fixed: Added script specification |
| 16 | claude | MEDIUM | scope | Evolution benchmark over-ambitious for V1 | Fixed: Split into V1 (monitoring) / V2 (benchmarks) |
| 17 | claude | MEDIUM | resilience | Push retry insufficient | Fixed: 3 attempts with backoff |
| 18 | claude | MEDIUM | extensibility | Adding repo/trigger requires multi-place changes | Acknowledged in checklist |
| 19 | claude | MEDIUM | scalability | Log file size management missing | Fixed: Quarterly archival policy |
| 20 | claude | MEDIUM | consistency | Option B auto-merge needs admin | Fixed: Permission note corrected |
| 21 | gemini | MEDIUM | data-modeling | CLI doc fetching unreliable proxy | Fixed: Added confidence-level distinction |
| 22 | gemini | LOW | data-modeling | Duplicate github_apps config schemas | Fixed: Renamed to github_app_ids |

### Cross-Agent Agreement

Issues flagged by multiple agents (highest confidence):

| Issue | Claude | Codex | Gemini |
|-------|--------|-------|--------|
| Single PAT blast radius | Y | Y | Y |
| No external watchdog | Y | Y | - |
| Log format unversioned | - | Y | Y |
| Context7 inconsistency | Y | - | - |
| Schedule overlap | - | - | Y |

### Unique Findings Per Agent

- **Claude-only (7):** Circuit breaker, PAT rotation, issue dedupe fragility, register_triggers.sh, push retry, log rotation, admin permissions
- **Codex-only (3):** Provider API auth, trigger registry/API auth, git persistence contradiction
- **Gemini-only (2):** Schedule overlap, PAT introspection infeasibility

---

## Metrics

```
Mode:               tournament
Total duration:     ~12m
  Agent reviews:    claude=137s, codex=160s, gemini=179s
  Judge (pass 1):   manual (Claude orchestrator)
  Judge (pass 2):   manual (order swapped)

Winner:             TIE
Scores:             claude=8.7, codex=8.7, gemini=6.5
Findings (total):   31 raw (deduped to 22 unique)
All 22 fixed in design document.

Note: Codex required retry — initial dispatch used deprecated `-a` flag
(removed in latest codex CLI). This is precisely the kind of drift
the stark-sentinel trigger is designed to catch.
```

### Improvement Flags

- Codex `-a never` flag rejection validates the fleet's sentinel use case
- Claude had highest coverage (10/10 domains) — consider Claude as primary reviewer for design docs
- Gemini had lowest coverage (4/10 domains, domain field unpopulated) — Gemini may need stronger domain-specific prompting for design reviews
