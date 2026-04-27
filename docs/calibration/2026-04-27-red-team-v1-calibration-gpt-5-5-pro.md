# stark-red-team v1 Calibration

**Date:** 2026-04-27T06:48:29Z
**Fixture:** `docs/specs/2026-04-12-stark-red-team-design.md`
**Runs:** 1
**Mode:** LIVE

## Cost

| Metric | Value |
|---|---|
| Mean cost per call | $1.9009 |
| Stdev | $0.0000 |
| 95th percentile (per-call) | $1.9009 |
| **Per-call ceiling (p95 × 1.5)** | **$2.85** |

Raw cost per call (USD): [1.9009]

> **Note (round-2 review #4):** the $2.85 figure above is a *per-call*
> ceiling, not a `per_run_budget_usd`. The latter is a total-cycle ceiling
> covering red-team calls + stability verification + design regens + inner
> design-review loop calls. For default `max_rounds=2`, treat ~5× the
> per-call ceiling as the cycle budget (≈$15.00) — which is the value the
> v1.1 default in `global/config.json` ships with.

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
| Durations (s) | [464.7] |
| Total findings per run | [11] |
| Blocking counts per run | [10] |

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
    // Cycle factor ~5× per-call ceiling (max_rounds=2). 2.85 × 5 = 14.25.
    "per_run_budget_usd": 14.25,
    "stability_overlap_jaccard_min": 0.0
  }
}
```
