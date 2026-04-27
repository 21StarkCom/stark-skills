#!/usr/bin/env python3
"""Week-0 calibration runner for stark-red-team.

Runs the red team N times on a fixture design doc, measures per-run cost and
Jaccard overlap across pairs, and outputs a calibration summary that proposes
stability_overlap_jaccard_min and per_run_budget_usd values for v1.

Usage:
    python3 calibrate_red_team.py <fixture-design-doc.md> <source-spec.md> [--runs 20] [--synthetic]

The --synthetic flag short-circuits the real Codex dispatch with a fixed
distribution of token counts and finding shapes. Use it for v1 to satisfy
the Week-0 acceptance gate without spending real LLM credits.

Output:
    docs/calibration/YYYY-MM-DD-red-team-v1-calibration.md
"""

from __future__ import annotations

import argparse
import itertools
import json
import random
import statistics
import sys
import time
from pathlib import Path

import stark_red_team as rt
from config_loader import get_red_team_config, get_model_rates


def _synthetic_dispatch_factory(seed: int = 42):
    """Returns a function that mimics dispatch_codex with a fixed distribution.

    Each call returns one of a small set of plausible RedTeamResult outputs
    with realistic-but-varying cost and finding patterns. Deterministic per
    invocation order but varies across runs to populate the Jaccard matrix.
    """
    rng = random.Random(seed)
    sample_findings = [
        # Persona, severity, concern templates
        ("security-trust", "critical", "Trust boundary leaks across the {layer} layer"),
        ("security-trust", "high", "Authentication bypass possible via {vector}"),
        ("reliability-distsys", "critical", "No retry semantics for {operation}"),
        ("reliability-distsys", "high", "Single point of failure in {component}"),
        ("data", "high", "Schema migration lacks backfill plan for {field}"),
        ("data", "medium", "Query pattern will not scale beyond {threshold}"),
        ("product-dx", "high", "API ergonomics make {operation} a footgun"),
        ("product-dx", "medium", "Error messages do not guide users to {action}"),
        ("cost-ops", "high", "Runtime cost grows linearly with {dimension}"),
        ("cost-ops", "medium", "Observability gap around {component}"),
    ]

    layers = ["service", "API gateway", "data store", "auth"]
    vectors = ["header injection", "session fixation", "token replay"]
    operations = ["webhook delivery", "background job", "cache invalidation"]
    components = ["primary database", "queue dispatcher", "rate limiter"]
    fields = ["user_id", "tenant_id", "subscription_status"]
    thresholds = ["10k rows", "100 QPS", "1M records"]
    dimensions = ["request volume", "user count", "data size"]
    actions = ["retry", "contact support", "check the docs"]

    def _fill(template: str) -> str:
        return template.format(
            layer=rng.choice(layers),
            vector=rng.choice(vectors),
            operation=rng.choice(operations),
            component=rng.choice(components),
            field=rng.choice(fields),
            threshold=rng.choice(thresholds),
            dimension=rng.choice(dimensions),
            action=rng.choice(actions),
        )

    def fake_dispatch_codex(**kwargs):
        # 4-7 findings per call, 800-1500 input tokens, 400-900 output tokens
        n_findings = rng.randint(4, 7)
        chosen = rng.sample(sample_findings, k=min(n_findings, len(sample_findings)))
        findings = []
        for i, (persona, severity, template) in enumerate(chosen):
            findings.append({
                "id": f"rt{i+1}",
                "persona": persona,
                "severity": severity,
                "concern": _fill(template),
                "consequence": "Concrete consequences would unfold in production.",
                "counter_proposal": "Adopt the architectural alternative described.",
                "trade_off": "Slightly more complexity at boundary X.",
            })
        synth = (
            f"Synthesis: tension between {chosen[0][0]} and "
            f"{chosen[1][0] if len(chosen) > 1 else chosen[0][0]} on the same surface."
        )
        payload = {"synthesis": synth, "findings": findings}
        return rt.CodexCallResult(
            raw_output=json.dumps(payload),
            duration_s=rng.uniform(8.0, 25.0),
            input_tokens=rng.randint(800, 1500),
            output_tokens=rng.randint(400, 900),
        )

    return fake_dispatch_codex


def run_calibration(
    fixture_path: Path,
    source_spec_path: Path,
    n_runs: int,
    synthetic: bool,
    model_override: str | None = None,
    findings_dump_path: Path | None = None,
) -> dict:
    cfg = get_red_team_config()
    model_rates = get_model_rates()
    if model_override:
        cfg = {**cfg, "model": model_override}
        print(f"[calibration] model override: {model_override}", file=sys.stderr)
    artifact = fixture_path.read_text(encoding="utf-8")
    source_spec = source_spec_path.read_text(encoding="utf-8")

    if synthetic:
        rt.dispatch_codex = _synthetic_dispatch_factory(seed=42)  # type: ignore[assignment]
        # Also patch PROMPTS_ROOT to the worktree location so assemble_prompt
        # can load prompt files without requiring the install symlink.
        worktree_prompts = Path(__file__).parent.parent / "global" / "prompts" / "red-team"
        if worktree_prompts.exists():
            rt.PROMPTS_ROOT = worktree_prompts  # type: ignore[assignment]
        print("[calibration] SYNTHETIC mode — dispatch_codex mocked", file=sys.stderr)

    results: list[rt.RedTeamResult] = []
    print(f"[calibration] Running {n_runs} passes…", file=sys.stderr)
    for i in range(n_runs):
        print(f"  run {i+1}/{n_runs}…", file=sys.stderr)
        result = rt.run_red_team(
            stage="design",
            artifact=artifact,
            source_spec=source_spec,
            pr_diff=None,
            personas=cfg["personas"],
            model=cfg["model"],
            model_rates=model_rates,
            cwd=None,
            timeout_s=cfg["timeout_s"],
            min_severity_to_block=cfg["min_severity_to_block"],
            max_input_chars=cfg["max_input_chars"],
            round_num=i + 1,
        )
        results.append(result)
        print(
            f"    cost=${result.cost_usd:.4f} "
            f"findings={len(result.findings)} "
            f"blocking={result.blocking_count} "
            f"duration={result.duration_s:.1f}s",
            file=sys.stderr,
        )

    costs = [r.cost_usd for r in results]
    mean_cost = statistics.mean(costs) if costs else 0.0
    stdev_cost = statistics.stdev(costs) if len(costs) > 1 else 0.0
    sorted_costs = sorted(costs)
    p95_cost = sorted_costs[int(0.95 * (len(sorted_costs) - 1))] if sorted_costs else 0.0
    proposed_budget = round(p95_cost * 1.5, 2) if p95_cost > 0 else 10.00

    pair_jaccards: list[float] = []
    for a, b in itertools.combinations(results, 2):
        if not a.findings or not b.findings:
            pair_jaccards.append(0.0)
            continue
        max_j = 0.0
        for fa in a.findings:
            if rt.SEVERITY_RANK.get(fa.severity, 0) < rt.SEVERITY_RANK["high"]:
                continue
            for fb in b.findings:
                if fa.persona != fb.persona:
                    continue
                j = rt._jaccard(rt._tokenize(fa.concern), rt._tokenize(fb.concern))
                if j > max_j:
                    max_j = j
        pair_jaccards.append(max_j)

    if pair_jaccards:
        mean_jaccard = statistics.mean(pair_jaccards)
        stdev_jaccard = statistics.stdev(pair_jaccards) if len(pair_jaccards) > 1 else 0.0
    else:
        mean_jaccard = 0.0
        stdev_jaccard = 0.0
    proposed_jaccard_min = max(0.0, round(mean_jaccard - stdev_jaccard, 3))

    if findings_dump_path is not None:
        dump = {
            "model": cfg["model"],
            "fixture": str(fixture_path),
            "runs": [
                {
                    "round_num": r.round_num,
                    "synthesis": r.synthesis,
                    "cost_usd": r.cost_usd,
                    "duration_s": r.duration_s,
                    "input_tokens": r.input_tokens,
                    "output_tokens": r.output_tokens,
                    "blocking_count": r.blocking_count,
                    "human_review_count": r.human_review_count,
                    "error": r.error,
                    "findings": [
                        {
                            "id": f.id,
                            "persona": f.persona,
                            "severity": f.severity,
                            "concern": f.concern,
                            "consequence": f.consequence,
                            "counter_proposal": f.counter_proposal,
                            "trade_off": f.trade_off,
                            "reason_for_uncertainty": f.reason_for_uncertainty,
                        }
                        for f in r.findings
                    ],
                }
                for r in results
            ],
        }
        findings_dump_path.parent.mkdir(parents=True, exist_ok=True)
        findings_dump_path.write_text(
            json.dumps(dump, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"[calibration] findings dumped to {findings_dump_path}", file=sys.stderr)

    return {
        "n_runs": n_runs,
        "synthetic": synthetic,
        "costs": costs,
        "mean_cost_usd": mean_cost,
        "stdev_cost_usd": stdev_cost,
        "p95_cost_usd": p95_cost,
        "proposed_per_run_budget_usd": proposed_budget,
        "pair_jaccards": pair_jaccards,
        "mean_jaccard": mean_jaccard,
        "stdev_jaccard": stdev_jaccard,
        "proposed_stability_overlap_jaccard_min": proposed_jaccard_min,
        "durations_s": [r.duration_s for r in results],
        "total_findings": [len(r.findings) for r in results],
        "blocking_counts": [r.blocking_count for r in results],
        "errors": [r.error for r in results if r.error],
    }


def write_calibration_doc(output_path: Path, summary: dict, fixture: Path) -> None:
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    mode_label = "SYNTHETIC (mocked dispatch)" if summary["synthetic"] else "LIVE"
    body = f"""# stark-red-team v1 Calibration

**Date:** {now_iso}
**Fixture:** `{fixture}`
**Runs:** {summary['n_runs']}
**Mode:** {mode_label}

## Cost

| Metric | Value |
|---|---|
| Mean cost per run | ${summary['mean_cost_usd']:.4f} |
| Stdev | ${summary['stdev_cost_usd']:.4f} |
| 95th percentile | ${summary['p95_cost_usd']:.4f} |
| **Proposed `per_run_budget_usd`** | **${summary['proposed_per_run_budget_usd']:.2f}** |

Raw cost per run (USD): {[round(c, 4) for c in summary['costs']]}

## Stability (Jaccard overlap of blocking findings across pairs)

| Metric | Value |
|---|---|
| Mean pair-Jaccard | {summary['mean_jaccard']:.3f} |
| Stdev | {summary['stdev_jaccard']:.3f} |
| **Proposed `stability_overlap_jaccard_min`** | **{summary['proposed_stability_overlap_jaccard_min']:.3f}** |

Pair Jaccards: {[round(j, 3) for j in summary['pair_jaccards']]}

## Durations and findings

| Metric | Values |
|---|---|
| Durations (s) | {[round(d, 1) for d in summary['durations_s']]} |
| Total findings per run | {summary['total_findings']} |
| Blocking counts per run | {summary['blocking_counts']} |

## Errors

{summary['errors'] if summary['errors'] else 'None.'}

## Notes for v1

This calibration was run in **{mode_label}** mode. The synthetic distribution
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
{{
  "red_team": {{
    "per_run_budget_usd": {summary['proposed_per_run_budget_usd']},
    "stability_overlap_jaccard_min": {summary['proposed_stability_overlap_jaccard_min']}
  }}
}}
```
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(body, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path, help="Path to fixture design doc")
    parser.add_argument("source_spec", type=Path, help="Path to source spec for the fixture")
    parser.add_argument("--runs", type=int, default=20)
    parser.add_argument("--synthetic", action="store_true",
                        help="Mock dispatch_codex with a fixed distribution (no real LLM calls)")
    parser.add_argument("--model", default=None,
                        help="Override red_team.model for this calibration run "
                             "(e.g. o3, gpt-5.5-pro). Used to A/B models without "
                             "editing the locked global config.")
    parser.add_argument("--dump-findings", action="store_true",
                        help="Write each run's full findings + synthesis to a "
                             "JSON sidecar next to the calibration doc. Useful "
                             "for substantive A/B comparison across models.")
    args = parser.parse_args()

    model_slug = (args.model or "default").replace(".", "-").replace("/", "-")
    out = Path("docs/calibration") / (
        f"{time.strftime('%Y-%m-%d')}-red-team-v1-calibration-{model_slug}.md"
    )
    findings_dump_path = (
        out.with_suffix(".findings.json") if args.dump_findings else None
    )

    summary = run_calibration(
        args.fixture, args.source_spec, args.runs, args.synthetic,
        model_override=args.model,
        findings_dump_path=findings_dump_path,
    )
    write_calibration_doc(out, summary, args.fixture)
    print(f"Calibration written to {out}", file=sys.stderr)
    print(json.dumps({
        "proposed_per_run_budget_usd": summary["proposed_per_run_budget_usd"],
        "proposed_stability_overlap_jaccard_min": summary["proposed_stability_overlap_jaccard_min"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
