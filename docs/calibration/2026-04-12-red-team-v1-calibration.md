# stark-red-team v1 Calibration

**Date:** 2026-04-12T14:21:27Z
**Fixture:** `docs/specs/2026-04-12-stark-red-team-design.md`
**Runs:** 20
**Mode:** SYNTHETIC (mocked dispatch)

## Cost

| Metric | Value |
|---|---|
| Mean cost per run | $0.0544 |
| Stdev | $0.0090 |
| 95th percentile | $0.0709 |
| **Proposed `per_run_budget_usd`** | **$0.11** |

Raw cost per run (USD): [0.045, 0.0668, 0.0594, 0.0723, 0.0466, 0.0394, 0.052, 0.0511, 0.0595, 0.0496, 0.0447, 0.0543, 0.0571, 0.0709, 0.0539, 0.0579, 0.0486, 0.0445, 0.052, 0.0628]

## Stability (Jaccard overlap of blocking findings across pairs)

| Metric | Value |
|---|---|
| Mean pair-Jaccard | 0.727 |
| Stdev | 0.311 |
| **Proposed `stability_overlap_jaccard_min`** | **0.416** |

Pair Jaccards: [0.6, 1.0, 1.0, 1.0, 1.0, 1.0, 0.6, 0.6, 0.667, 1.0, 1.0, 0.556, 1.0, 1.0, 0.556, 1.0, 0.556, 1.0, 0.556, 0.667, 1.0, 0.6, 1.0, 1.0, 1.0, 1.0, 1.0, 0.556, 0.5, 1.0, 0.5, 1.0, 0.5, 1.0, 1.0, 1.0, 1.0, 0.0, 0.667, 0.667, 0.556, 0.667, 0.0, 0.75, 0.0, 0.0, 0.556, 0.556, 0.75, 0.556, 1.0, 0.556, 0.667, 0.556, 0.0, 0.6, 1.0, 0.6, 1.0, 1.0, 1.0, 0.778, 1.0, 0.778, 1.0, 0.0, 0.556, 0.0, 0.778, 0.0, 1.0, 0.0, 0.6, 0.0, 0.667, 0.0, 0.0, 0.0, 0.0, 0.667, 0.0, 0.6, 0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.667, 0.6, 0.6, 1.0, 0.6, 1.0, 0.556, 0.6, 1.0, 1.0, 0.556, 0.6, 1.0, 1.0, 1.0, 1.0, 1.0, 0.778, 1.0, 0.556, 0.556, 1.0, 1.0, 1.0, 1.0, 0.667, 0.6, 0.6, 0.556, 1.0, 0.667, 1.0, 1.0, 0.556, 0.6, 1.0, 1.0, 0.6, 0.6, 1.0, 0.6, 1.0, 0.5, 0.556, 1.0, 0.6, 1.0, 0.556, 0.556, 1.0, 0.5, 1.0, 0.5, 0.667, 1.0, 0.667, 1.0, 1.0, 0.556, 0.778, 1.0, 0.0, 1.0, 0.556, 1.0, 1.0, 0.0, 1.0, 0.778, 1.0, 1.0, 1.0, 1.0, 1.0, 0.556, 1.0, 0.556, 0.556, 1.0, 1.0, 0.556, 0.778, 1.0, 1.0, 1.0, 1.0, 1.0, 0.556, 0.667, 1.0, 1.0, 1.0, 0.556, 1.0, 0.556, 1.0, 0.556, 1.0, 0.556, 1.0, 0.556, 0.556]

## Durations and findings

| Metric | Values |
|---|---|
| Durations (s) | [13.8, 11.7, 10.7, 17.2, 23.3, 24.7, 19.5, 23.0, 8.6, 11.3, 11.3, 8.4, 23.3, 13.7, 19.5, 17.7, 10.1, 13.8, 21.7, 24.4] |
| Total findings per run | [4, 6, 4, 4, 4, 5, 7, 4, 6, 5, 4, 6, 4, 6, 7, 5, 6, 4, 7, 4] |
| Blocking counts per run | [4, 4, 2, 2, 1, 4, 5, 3, 4, 4, 3, 4, 2, 4, 5, 3, 4, 4, 5, 3] |

## Errors

None.

## Notes for v1

This calibration was run in **SYNTHETIC (mocked dispatch)** mode. The synthetic distribution
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
    "per_run_budget_usd": 0.11,
    "stability_overlap_jaccard_min": 0.416
  }
}
```
