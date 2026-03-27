# Design Review — stark-insights

**File:** `docs/specs/2026-03-27-stark-insights-design.md`
**Mode:** Tournament (3 agents, all 10 domains, 2 judge passes)
**Date:** 2026-03-27

---

## Tournament Result

| Agent | Score | Coverage | Severity Accuracy | False Positive Rate | Actionability | Specificity |
|-------|-------|----------|-------------------|---------------------|---------------|-------------|
| **claude** | **9.00** | good | good | low | good | good |
| codex | 6.66 | acceptable | acceptable | low | acceptable | acceptable |
| gemini | 6.38 | acceptable | acceptable | medium | acceptable | acceptable |

**Winner: claude** (consistent across both judge passes, no position bias detected)

---

## Headline

**Issues found:** 26 (9 high, 12 medium, 5 low)
**All 26 fixed** in a single tournament fix pass.

---

## All Findings

| # | Severity | Domain | Title | Outcome |
|---|----------|--------|-------|---------|
| 1 | HIGH | Data Collection | Hook shell variable expansion broken (single-quoted `$TOOL_NAME`) | Fixed: added hook-emit.py helper script |
| 2 | HIGH | Architecture | MCP stdio-via-docker-exec cold start per call | Fixed: switched to HTTP/SSE MCP transport |
| 3 | HIGH | Security | Docker port binding exposes to all interfaces | Fixed: `127.0.0.1:7420:7420` |
| 4 | HIGH | Security | SA key file on disk is GCP anti-pattern | Fixed: switched to ADC via `gcloud auth application-default login` |
| 5 | HIGH | Security | No data classification or PII scrubbing | Fixed: added Data Classification & PII section |
| 6 | HIGH | Resilience | Direct-write-first loses events on transient failures | Fixed: write-ahead buffer is now the primary path for ALL events |
| 7 | HIGH | Data Modeling | Content-hash idempotency key can't dedupe across sources | Fixed: added source-stable `dedupe_key` with per-source formulas |
| 8 | HIGH | Architecture | Contradictory network model (private IP vs public IP) | Fixed: unified to public IP + Auth Proxy, localhost-only binding |
| 9 | HIGH | Scalability | db-f1-micro undersized for workload | Fixed: upgraded to db-g1-small, configurable Terraform variable |
| 10 | MEDIUM | Offline Buffer | No buffer size cap during extended outages | Fixed: 100K events / 500MB cap with priority-based eviction |
| 11 | MEDIUM | Data Model | No time-based partitioning | Fixed: monthly range partitioning on `timestamp` |
| 12 | MEDIUM | Data Model | Materialized view refresh blocks readers | Fixed: `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| 13 | MEDIUM | HTTP API | /query accepts arbitrary SQL with no limits | Fixed: statement_timeout=10s, row limit=10K |
| 14 | MEDIUM | Metrics | Pushgateway vs pull model contradiction | Fixed: pull-only, removed Pushgateway reference |
| 15 | MEDIUM | Scheduler | Simultaneous scraper starts cause resource spikes | Fixed: staggered offsets, max_instances=1 |
| 16 | MEDIUM | Scheduler | High-water mark advancement on failure undefined | Fixed: mark only advances after successful commit |
| 17 | MEDIUM | Data Collection | GitHub scraper no rate limit handling | Fixed: ETags, rate limit backoff documented |
| 18 | MEDIUM | Completeness | No sessionization algorithm | Fixed: added Session Reconciliation section |
| 19 | MEDIUM | API Design | Error responses undefined | Fixed: added Error Responses section with JSON envelope |
| 20 | MEDIUM | Data Collection | Codex/Gemini history paths unverified | Fixed: noted as verify-during-implementation, added resilience requirement |
| 21 | MEDIUM | Completeness | No acceptance criteria or SLOs | Fixed: added Success Metrics section |
| 22 | LOW | Dependencies | APScheduler 3.x risks accidental 4.x upgrade | Fixed: pinned `>=3.11,<4` |
| 23 | LOW | Architecture | 128MB memory limit tight | Fixed: bumped to 256MB |
| 24 | LOW | Data Model | user_id not normalized | Fixed: added Identity Normalization section with alias table |
| 25 | LOW | Consistency | Backfill source lists inconsistent | Fixed: reconciled to canonical list |
| 26 | LOW | Resilience | APScheduler restart loses pagination progress | Fixed: per-page high-water mark updates documented |

---

## Per-Agent Raw Findings

### Claude (22 findings)

9 high, 8 medium, 5 low. Most comprehensive coverage — identified the write-ahead durability gap, the MCP stdio cold-start problem, and the hook shell expansion issue that other agents missed. Strongest on architecture and security domains.

### Codex (10 findings)

6 high, 3 medium, 1 low. Focused on systemic issues — the trust/authorization model, network contradictions, ingestion durability, and idempotency design. Fewer findings but higher density of real architectural problems.

### Gemini (14 findings)

4 high, 7 medium, 3 low. Good coverage of operational concerns — scraper failure recovery, concurrent execution, resource contention. Some overlap with Claude's findings on SQL endpoint and instance sizing.

---

## Metrics

```
Mode:               tournament
Total duration:     22m 19s
  Phase 1 (Setup):        5s
  Agent reviews:          8m 49s (3 agents, all 10 domains each)
  Judge (pass 1):         ~90s
  Judge (pass 2):         ~90s
  Fix pass:               ~10m
  Summary + output:       ~2m

Winner:             claude
Scores:             claude=9.00, codex=6.66, gemini=6.38
Position bias:      none detected (claude won both passes)
Findings total:     26 (9 high, 12 medium, 5 low)
Findings fixed:     26 (100%)
Findings unresolved: 0
```

---

## Prompt Improvement Assessment

| Signal | Level | Note |
|--------|-------|------|
| Gemini had medium false positive rate | Global | May need prompt tuning for Gemini design-review prompts to reduce noise |
| All agents flagged the same network contradiction | N/A | Good convergence — real issue, not a prompt problem |
| Codex missed hook expansion issue | Global | Codex design-review prompts could benefit from a "verify code examples actually work" check |
| No agents flagged database migration strategy | Global | Consider adding "operational lifecycle" as an explicit check in completeness domain |
