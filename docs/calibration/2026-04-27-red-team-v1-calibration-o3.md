# stark-red-team v1 Calibration

**Date:** 2026-04-27T06:40:37Z
**Fixture:** `docs/specs/2026-04-12-stark-red-team-design.md`
**Runs:** 1
**Mode:** LIVE

## Cost

| Metric | Value |
|---|---|
| Mean cost per run | $0.6879 |
| Stdev | $0.0000 |
| 95th percentile | $0.6879 |
| **Proposed `per_run_budget_usd`** | **$1.03** |

Raw cost per run (USD): [0.6879]

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
    "per_run_budget_usd": 1.03,
    "stability_overlap_jaccard_min": 0.0
  }
}
```
