#!/usr/bin/env python3
"""Analyze shadow validation output files and compute gate metrics.

CLI: python3 scripts/analyze_shadow.py [--input-dir DIR] [--output-file PATH]

Exit 0 if all gates pass, exit 1 if any gate fails or no data is found.
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

GATE_SKIP_RATE_MIN = 0.40          # average skip rate must be >= 40%
GATE_MISSED_CRITICAL_HIGH_MAX = 0  # zero missed critical/high domains
GATE_P95_LATENCY_MAX_S = 10.0     # p95 triage latency must be < 10s

CRITICAL_HIGH = {"critical", "high"}

SCRIPTS_DIR = Path(__file__).resolve().parent.parent  # scripts/
REPO_ROOT = SCRIPTS_DIR.parent
DEFAULT_INPUT_DIR = Path("/tmp/shadow-validation/")
DEFAULT_OUTPUT_FILE = REPO_ROOT / "docs" / "triage-shadow-validation.md"


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def _p95(values: list[float]) -> float:
    """Return the p95 value from a sorted list of floats."""
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    index = max(0, math.ceil(0.95 * len(sorted_vals)) - 1)
    return sorted_vals[index]


def load_shadow_files(input_dir: Path) -> list[dict]:
    """Read all JSON files from input_dir and return parsed records.

    Silently skips files that are missing, unreadable, or not JSON dicts.
    Returns an empty list if the directory does not exist.
    """
    if not input_dir.exists():
        return []
    records = []
    for json_file in sorted(input_dir.glob("*.json")):
        try:
            data = json.loads(json_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                records.append(data)
        except (json.JSONDecodeError, OSError):
            pass
    return records


def group_by_type(records: list[dict]) -> dict[str, list[dict]]:
    """Group records by their review_type field."""
    groups: dict[str, list[dict]] = {}
    for record in records:
        review_type = str(record.get("review_type", "unknown"))
        groups.setdefault(review_type, []).append(record)
    return groups


def compute_metrics(records: list[dict]) -> dict:
    """Compute gate metrics for a list of shadow records of the same review type.

    Returns:
        sample_count: number of records
        avg_skip_rate: mean of (skipped_domains / total_domains) across records
        missed_critical_high: count of decisions where action==skip and severity in {critical,high}
        p95_latency_s: p95 of triage_duration_s values
    """
    skip_rates: list[float] = []
    missed_critical_high = 0
    latencies: list[float] = []

    for record in records:
        total_domains = int(record.get("total_domains", 0))
        skipped = record.get("skipped_domains", [])
        skipped_count = len(skipped) if isinstance(skipped, list) else 0

        if total_domains > 0:
            skip_rates.append(skipped_count / total_domains)

        for decision in record.get("decisions", []) or []:
            if (
                isinstance(decision, dict)
                and decision.get("action") == "skip"
                and str(decision.get("severity", "")).lower() in CRITICAL_HIGH
            ):
                missed_critical_high += 1

        duration = record.get("triage_duration_s")
        if duration is not None:
            latencies.append(float(duration))

    avg_skip_rate = sum(skip_rates) / len(skip_rates) if skip_rates else 0.0

    return {
        "sample_count": len(records),
        "avg_skip_rate": avg_skip_rate,
        "missed_critical_high": missed_critical_high,
        "p95_latency_s": _p95(latencies),
    }


def evaluate_gates(metrics: dict) -> dict:
    """Evaluate the three gate criteria against computed metrics.

    Returns a dict keyed by gate name, each with pass (bool), value, and threshold.
    """
    skip_rate_pass = metrics["avg_skip_rate"] >= GATE_SKIP_RATE_MIN
    missed_pass = metrics["missed_critical_high"] == GATE_MISSED_CRITICAL_HIGH_MAX
    latency_pass = metrics["p95_latency_s"] < GATE_P95_LATENCY_MAX_S

    return {
        "skip_rate": {
            "pass": skip_rate_pass,
            "value": metrics["avg_skip_rate"],
            "threshold": f">= {GATE_SKIP_RATE_MIN:.0%}",
        },
        "missed_critical_high": {
            "pass": missed_pass,
            "value": metrics["missed_critical_high"],
            "threshold": f"== {GATE_MISSED_CRITICAL_HIGH_MAX}",
        },
        "p95_latency_s": {
            "pass": latency_pass,
            "value": metrics["p95_latency_s"],
            "threshold": f"< {GATE_P95_LATENCY_MAX_S:.0f}s",
        },
    }


def analyze(input_dir: Path) -> dict:
    """Load shadow files, compute per-type metrics, evaluate gates, return result dict."""
    records = load_shadow_files(input_dir)
    groups = group_by_type(records)

    type_results: dict[str, dict] = {}
    for review_type, type_records in sorted(groups.items()):
        metrics = compute_metrics(type_records)
        gates = evaluate_gates(metrics)
        type_results[review_type] = {
            "metrics": metrics,
            "gates": gates,
            "pass": all(g["pass"] for g in gates.values()),
        }

    overall_pass = bool(type_results) and all(r["pass"] for r in type_results.values())

    return {
        "input_dir": str(input_dir),
        "total_files": len(records),
        "types": type_results,
        "overall_pass": overall_pass,
    }


# ---------------------------------------------------------------------------
# Markdown rendering
# ---------------------------------------------------------------------------


def _status(passed: bool) -> str:
    return "PASS" if passed else "FAIL"


def render_markdown(result: dict) -> str:
    """Render a human-readable markdown report from an analyze() result dict."""
    lines: list[str] = [
        "# Triage Shadow Validation Report",
        "",
        f"**Overall: {_status(result['overall_pass'])}**",
        "",
        f"- Input directory: `{result['input_dir']}`",
        f"- Total files analyzed: {result['total_files']}",
        "",
    ]

    if not result["types"]:
        lines.append("_No shadow files found in input directory._")
        return "\n".join(lines)

    for review_type, type_result in sorted(result["types"].items()):
        metrics = type_result["metrics"]
        gates = type_result["gates"]

        lines += [
            f"## {review_type.upper()} — {_status(type_result['pass'])}",
            "",
            f"- Samples: {metrics['sample_count']}",
            "",
            "| Gate | Value | Threshold | Result |",
            "|------|-------|-----------|--------|",
        ]

        skip = gates["skip_rate"]
        lines.append(
            f"| Skip rate | {skip['value']:.1%} | {skip['threshold']} | {_status(skip['pass'])} |"
        )

        missed = gates["missed_critical_high"]
        lines.append(
            f"| Missed critical/high | {missed['value']} | {missed['threshold']} | {_status(missed['pass'])} |"
        )

        latency = gates["p95_latency_s"]
        lines.append(
            f"| p95 latency | {latency['value']:.2f}s | {latency['threshold']} | {_status(latency['pass'])} |"
        )

        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze shadow validation JSON files and compute gate metrics."
    )
    parser.add_argument(
        "--input-dir",
        default=str(DEFAULT_INPUT_DIR),
        help=f"Directory containing shadow JSON files (default: {DEFAULT_INPUT_DIR})",
    )
    parser.add_argument(
        "--output-file",
        default=str(DEFAULT_OUTPUT_FILE),
        help=f"Output markdown file path (default: {DEFAULT_OUTPUT_FILE})",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    input_dir = Path(args.input_dir)
    output_file = Path(args.output_file)

    result = analyze(input_dir)
    markdown = render_markdown(result)

    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(markdown, encoding="utf-8")

    print(markdown)

    return 0 if result["overall_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
