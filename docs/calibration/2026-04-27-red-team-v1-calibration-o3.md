# stark-red-team v1 Calibration

**Date:** 2026-04-27T06:40:37Z
**Fixture:** `docs/specs/2026-04-12-stark-red-team-design.md`
**Runs:** 1
**Mode:** LIVE

## Cost

| Metric | Value |
|---|---|
| Mean cost per call | $0.6879 |
| Stdev | $0.0000 |
| 95th percentile (per-call) | $0.6879 |
| **Per-call ceiling (p95 × 1.5)** | **$1.03** |

Raw cost per call (USD): [0.6879]

> **Note (round-2 review #4):** `red_team.per_run_budget_usd` is a total-cycle ceiling, not per-call. For default `max_rounds=2`, multiply the per-call ceiling above by ~5 to get a cycle budget. The v1.1 default ships with `gpt-5.5-pro` at `$15.00`; this o3 calibration is retained as A/B reference.

## Stability (Jaccard overlap of blocking findings across pairs)

| Metric | Value |
|---|---|
| Mean pair-Jaccard | 0.000 |
| Stdev | 0.000 |
| **Proposed `stability_overlap_jaccard_min`** | **0.000** |

Pair Jaccards: []

## Durations and findings

| Metric | Values |
|---|---|
| Durations (s) | [45.7] |
| Total findings per run | [10] |
| Blocking counts per run | [5] |

## Errors

None.

## Notes for v1

This calibration was run in **LIVE** mode. The synthetic distribution
is a placeholder for the Week-0 acceptance gate; real calibration on a live
Codex o3 endpoint should happen in Week 1–2 based on dogfood data. The values
proposed here are reasonable starting defaults but should be revisited once
real PRs flow through the red team.

The synthetic token counts (800-1500 input, 400-900 output) combined with o3
rates ($15/$60 per 1M tokens) yield very small per-run costs. These are
structurally meaningful (the calibration pipeline works end-to-end) but NOT
operationally meaningful — the `per_run_budget_usd` in config remains at the
$10.00 placeholder until real calibration data arrives from live o3 runs.

## Applying these values

```json
{
  "red_team": {
    // Cycle factor ~5× per-call ceiling (max_rounds=2). 1.03 × 5 = 5.15.
    "per_run_budget_usd": 5.15,
    "stability_overlap_jaccard_min": 0.0
  }
}
```
