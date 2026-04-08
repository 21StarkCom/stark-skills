#!/usr/bin/env python3
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from unittest.mock import patch

import analyze_shadow


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_json(directory: Path, name: str, data: dict) -> None:
    (directory / name).write_text(json.dumps(data), encoding="utf-8")


def _pr_record(
    *,
    triage_duration_s: float = 1.5,
    total_domains: int = 9,
    skipped: list[str] | None = None,
    dispatched: list[str] | None = None,
    decisions: list[dict] | None = None,
) -> dict:
    if skipped is None:
        skipped = ["style", "docs", "ux", "perf"]
    if dispatched is None:
        dispatched = ["security", "logic", "architecture", "testing", "a11y"]
    if decisions is None:
        decisions = [
            {"domain": "security", "action": "dispatch", "severity": "high"},
            {"domain": "logic", "action": "dispatch", "severity": "medium"},
            {"domain": "style", "action": "skip", "severity": "low"},
            {"domain": "docs", "action": "skip", "severity": "low"},
            {"domain": "ux", "action": "skip", "severity": "low"},
            {"domain": "perf", "action": "skip", "severity": "low"},
        ]
    return {
        "review_type": "pr",
        "triage_duration_s": triage_duration_s,
        "total_domains": total_domains,
        "dispatched_domains": dispatched,
        "skipped_domains": skipped,
        "decisions": decisions,
    }


def _passing_pr_record() -> dict:
    """A PR record that passes all three gates."""
    return _pr_record(
        triage_duration_s=2.0,
        total_domains=9,
        skipped=["style", "docs", "ux", "perf", "i18n"],  # 55.6% skip rate
        decisions=[
            {"domain": "security", "action": "dispatch", "severity": "high"},
            {"domain": "style", "action": "skip", "severity": "low"},
            {"domain": "docs", "action": "skip", "severity": "low"},
            {"domain": "ux", "action": "skip", "severity": "low"},
            {"domain": "perf", "action": "skip", "severity": "low"},
            {"domain": "i18n", "action": "skip", "severity": "low"},
        ],
    )


def _passing_metrics() -> dict:
    return {
        "sample_count": 5,
        "avg_skip_rate": 0.50,
        "missed_critical_high": 0,
        "p95_latency_s": 5.0,
    }


# ---------------------------------------------------------------------------
# _p95
# ---------------------------------------------------------------------------


def test_p95_single_value() -> None:
    assert analyze_shadow._p95([5.0]) == 5.0


def test_p95_two_values() -> None:
    assert analyze_shadow._p95([1.0, 2.0]) == 2.0


def test_p95_empty() -> None:
    assert analyze_shadow._p95([]) == 0.0


def test_p95_twenty_values() -> None:
    # p95 of [1..20]: ceil(0.95 * 20) - 1 = 19 - 1 = 18 → sorted[18] = 19
    values = [float(v) for v in range(1, 21)]
    assert analyze_shadow._p95(values) == 19.0


def test_p95_ten_values() -> None:
    # p95 of [1..10]: ceil(0.95 * 10) - 1 = 10 - 1 = 9 → sorted[9] = 10
    values = [float(v) for v in range(1, 11)]
    assert analyze_shadow._p95(values) == 10.0


# ---------------------------------------------------------------------------
# load_shadow_files
# ---------------------------------------------------------------------------


def test_load_empty_dir() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        records = analyze_shadow.load_shadow_files(Path(tmpdir))
    assert records == []


def test_load_missing_dir() -> None:
    records = analyze_shadow.load_shadow_files(Path("/tmp/nonexistent-shadow-xyz-99"))
    assert records == []


def test_load_reads_json_files() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        _write_json(d, "a.json", _pr_record())
        _write_json(d, "b.json", _pr_record(triage_duration_s=2.0))
        records = analyze_shadow.load_shadow_files(d)
    assert len(records) == 2


def test_load_skips_invalid_json() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        _write_json(d, "good.json", _pr_record())
        (d / "bad.json").write_text("not json", encoding="utf-8")
        records = analyze_shadow.load_shadow_files(d)
    assert len(records) == 1


def test_load_skips_non_dict_json() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        _write_json(d, "good.json", _pr_record())
        (d / "list.json").write_text("[1, 2, 3]", encoding="utf-8")
        records = analyze_shadow.load_shadow_files(d)
    assert len(records) == 1


# ---------------------------------------------------------------------------
# compute_metrics
# ---------------------------------------------------------------------------


def test_metrics_skip_rate() -> None:
    # 4 skipped out of 9 total
    records = [_pr_record(total_domains=9, skipped=["a", "b", "c", "d"])]
    metrics = analyze_shadow.compute_metrics(records)
    assert abs(metrics["avg_skip_rate"] - 4 / 9) < 1e-9


def test_metrics_skip_rate_average_across_records() -> None:
    # 3/9 and 6/9 → average = 4.5/9 = 0.5
    records = [
        _pr_record(total_domains=9, skipped=["a", "b", "c"]),
        _pr_record(total_domains=9, skipped=["a", "b", "c", "d", "e", "f"]),
    ]
    metrics = analyze_shadow.compute_metrics(records)
    assert abs(metrics["avg_skip_rate"] - 0.5) < 1e-9


def test_metrics_zero_total_domains_excluded_from_avg() -> None:
    # total_domains=0 should not contribute to skip rate average
    records = [
        _pr_record(total_domains=0, skipped=[]),
        _pr_record(total_domains=10, skipped=["a", "b", "c", "d", "e"]),
    ]
    metrics = analyze_shadow.compute_metrics(records)
    assert abs(metrics["avg_skip_rate"] - 0.5) < 1e-9


def test_metrics_missed_critical_high() -> None:
    decisions = [
        {"domain": "security", "action": "skip", "severity": "critical"},
        {"domain": "logic", "action": "skip", "severity": "high"},
        {"domain": "style", "action": "skip", "severity": "low"},
        {"domain": "ux", "action": "dispatch", "severity": "critical"},  # dispatched — not missed
    ]
    records = [_pr_record(decisions=decisions)]
    metrics = analyze_shadow.compute_metrics(records)
    assert metrics["missed_critical_high"] == 2


def test_metrics_no_missed_critical_high() -> None:
    decisions = [
        {"domain": "security", "action": "dispatch", "severity": "critical"},
        {"domain": "style", "action": "skip", "severity": "low"},
    ]
    records = [_pr_record(decisions=decisions)]
    metrics = analyze_shadow.compute_metrics(records)
    assert metrics["missed_critical_high"] == 0


def test_metrics_missed_accumulates_across_records() -> None:
    decisions = [{"domain": "sec", "action": "skip", "severity": "high"}]
    records = [_pr_record(decisions=decisions), _pr_record(decisions=decisions)]
    metrics = analyze_shadow.compute_metrics(records)
    assert metrics["missed_critical_high"] == 2


def test_metrics_p95_latency() -> None:
    records = [_pr_record(triage_duration_s=float(i)) for i in range(1, 21)]
    metrics = analyze_shadow.compute_metrics(records)
    assert metrics["p95_latency_s"] == 19.0


def test_metrics_empty_records() -> None:
    metrics = analyze_shadow.compute_metrics([])
    assert metrics["sample_count"] == 0
    assert metrics["avg_skip_rate"] == 0.0
    assert metrics["missed_critical_high"] == 0
    assert metrics["p95_latency_s"] == 0.0


def test_metrics_sample_count() -> None:
    records = [_pr_record(), _pr_record(), _pr_record()]
    metrics = analyze_shadow.compute_metrics(records)
    assert metrics["sample_count"] == 3


# ---------------------------------------------------------------------------
# evaluate_gates
# ---------------------------------------------------------------------------


def test_gates_all_pass() -> None:
    gates = analyze_shadow.evaluate_gates(_passing_metrics())
    assert gates["skip_rate"]["pass"] is True
    assert gates["missed_critical_high"]["pass"] is True
    assert gates["p95_latency_s"]["pass"] is True


def test_gates_skip_rate_fail() -> None:
    metrics = {**_passing_metrics(), "avg_skip_rate": 0.39}
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["skip_rate"]["pass"] is False
    assert gates["missed_critical_high"]["pass"] is True
    assert gates["p95_latency_s"]["pass"] is True


def test_gates_skip_rate_boundary_pass() -> None:
    metrics = {**_passing_metrics(), "avg_skip_rate": 0.40}
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["skip_rate"]["pass"] is True


def test_gates_missed_critical_fail() -> None:
    metrics = {**_passing_metrics(), "missed_critical_high": 1}
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["missed_critical_high"]["pass"] is False
    assert gates["skip_rate"]["pass"] is True
    assert gates["p95_latency_s"]["pass"] is True


def test_gates_latency_boundary_fail() -> None:
    # exactly 10.0 — not < 10 → fail
    metrics = {**_passing_metrics(), "p95_latency_s": 10.0}
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["p95_latency_s"]["pass"] is False


def test_gates_latency_boundary_pass() -> None:
    metrics = {**_passing_metrics(), "p95_latency_s": 9.999}
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["p95_latency_s"]["pass"] is True


def test_gates_all_fail() -> None:
    metrics = {
        "sample_count": 1,
        "avg_skip_rate": 0.10,
        "missed_critical_high": 3,
        "p95_latency_s": 15.0,
    }
    gates = analyze_shadow.evaluate_gates(metrics)
    assert gates["skip_rate"]["pass"] is False
    assert gates["missed_critical_high"]["pass"] is False
    assert gates["p95_latency_s"]["pass"] is False


def test_gates_include_threshold_strings() -> None:
    gates = analyze_shadow.evaluate_gates(_passing_metrics())
    assert ">=" in gates["skip_rate"]["threshold"]
    assert "== 0" in gates["missed_critical_high"]["threshold"]
    assert "< 10s" in gates["p95_latency_s"]["threshold"]


# ---------------------------------------------------------------------------
# analyze() — integration
# ---------------------------------------------------------------------------


def test_analyze_empty_dir() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        result = analyze_shadow.analyze(Path(tmpdir))
    assert result["total_files"] == 0
    assert result["types"] == {}
    assert result["overall_pass"] is False


def test_analyze_all_gates_pass() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        _write_json(Path(tmpdir), "run.json", _passing_pr_record())
        result = analyze_shadow.analyze(Path(tmpdir))
    assert result["overall_pass"] is True
    assert result["types"]["pr"]["pass"] is True


def test_analyze_skip_rate_gate_fail() -> None:
    # only 1/9 skipped → ~11%
    record = _pr_record(
        total_domains=9,
        skipped=["style"],
        decisions=[{"domain": "style", "action": "skip", "severity": "low"}],
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        _write_json(Path(tmpdir), "run.json", record)
        result = analyze_shadow.analyze(Path(tmpdir))
    assert result["overall_pass"] is False
    assert result["types"]["pr"]["gates"]["skip_rate"]["pass"] is False


def test_analyze_missed_critical_gate_fail() -> None:
    record = _pr_record(
        total_domains=9,
        skipped=["security", "style", "docs", "perf"],
        decisions=[
            {"domain": "security", "action": "skip", "severity": "critical"},
            {"domain": "style", "action": "skip", "severity": "low"},
            {"domain": "docs", "action": "skip", "severity": "low"},
            {"domain": "perf", "action": "skip", "severity": "low"},
        ],
    )
    with tempfile.TemporaryDirectory() as tmpdir:
        _write_json(Path(tmpdir), "run.json", record)
        result = analyze_shadow.analyze(Path(tmpdir))
    assert result["overall_pass"] is False
    assert result["types"]["pr"]["gates"]["missed_critical_high"]["pass"] is False


def test_analyze_multiple_review_types() -> None:
    design_record = {
        "review_type": "design",
        "triage_duration_s": 3.0,
        "total_domains": 12,
        "dispatched_domains": ["architecture", "security"],
        "skipped_domains": ["style", "docs", "ux", "perf", "i18n", "a11y", "api"],
        "decisions": [{"domain": "style", "action": "skip", "severity": "low"}],
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        _write_json(d, "pr.json", _passing_pr_record())
        _write_json(d, "design.json", design_record)
        result = analyze_shadow.analyze(d)
    assert "pr" in result["types"]
    assert "design" in result["types"]
    assert result["total_files"] == 2


def test_analyze_partial_failure_reported_per_type() -> None:
    """One type passes, another fails — overall fails, individual types reported correctly."""
    failing_plan = {
        "review_type": "plan",
        "triage_duration_s": 2.0,
        "total_domains": 10,
        "dispatched_domains": list("abcdefghi"),
        "skipped_domains": ["x"],  # 10% → fail
        "decisions": [{"domain": "x", "action": "skip", "severity": "low"}],
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        _write_json(d, "pr.json", _passing_pr_record())
        _write_json(d, "plan.json", failing_plan)
        result = analyze_shadow.analyze(d)
    assert result["overall_pass"] is False
    assert result["types"]["pr"]["pass"] is True
    assert result["types"]["plan"]["pass"] is False


def test_analyze_total_files_count() -> None:
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        for i in range(5):
            _write_json(d, f"run{i}.json", _passing_pr_record())
        result = analyze_shadow.analyze(d)
    assert result["total_files"] == 5


# ---------------------------------------------------------------------------
# render_markdown
# ---------------------------------------------------------------------------


def test_render_markdown_empty() -> None:
    result = {
        "input_dir": "/tmp/shadow-validation",
        "total_files": 0,
        "types": {},
        "overall_pass": False,
    }
    md = analyze_shadow.render_markdown(result)
    assert "# Triage Shadow Validation Report" in md
    assert "No shadow files found" in md
    assert "Overall: FAIL" in md


def test_render_markdown_overall_pass() -> None:
    metrics = _passing_metrics()
    result = {
        "input_dir": "/tmp/shadow-validation",
        "total_files": 5,
        "types": {
            "pr": {
                "metrics": metrics,
                "gates": analyze_shadow.evaluate_gates(metrics),
                "pass": True,
            }
        },
        "overall_pass": True,
    }
    md = analyze_shadow.render_markdown(result)
    assert "Overall: PASS" in md
    assert "PR — PASS" in md


def test_render_markdown_includes_numeric_values() -> None:
    metrics = {
        "sample_count": 3,
        "avg_skip_rate": 0.45,
        "missed_critical_high": 1,
        "p95_latency_s": 8.3,
    }
    result = {
        "input_dir": "/tmp/shadow",
        "total_files": 3,
        "types": {
            "pr": {
                "metrics": metrics,
                "gates": analyze_shadow.evaluate_gates(metrics),
                "pass": False,
            }
        },
        "overall_pass": False,
    }
    md = analyze_shadow.render_markdown(result)
    assert "45.0%" in md
    assert "8.30s" in md
    assert "| 1 |" in md or "| 1|" in md or " 1 " in md


def test_render_markdown_per_type_pass_fail_labels() -> None:
    pass_metrics = _passing_metrics()
    fail_metrics = {**_passing_metrics(), "avg_skip_rate": 0.10}
    result = {
        "input_dir": "/tmp/shadow",
        "total_files": 2,
        "types": {
            "pr": {
                "metrics": pass_metrics,
                "gates": analyze_shadow.evaluate_gates(pass_metrics),
                "pass": True,
            },
            "plan": {
                "metrics": fail_metrics,
                "gates": analyze_shadow.evaluate_gates(fail_metrics),
                "pass": False,
            },
        },
        "overall_pass": False,
    }
    md = analyze_shadow.render_markdown(result)
    assert "PR — PASS" in md
    assert "PLAN — FAIL" in md


def test_render_markdown_input_dir_shown() -> None:
    result = {
        "input_dir": "/custom/shadow/dir",
        "total_files": 0,
        "types": {},
        "overall_pass": False,
    }
    md = analyze_shadow.render_markdown(result)
    assert "/custom/shadow/dir" in md


# ---------------------------------------------------------------------------
# main() — exit codes
# ---------------------------------------------------------------------------


def test_main_exits_0_on_all_pass() -> None:
    with tempfile.TemporaryDirectory() as input_dir:
        _write_json(Path(input_dir), "run.json", _passing_pr_record())
        with tempfile.TemporaryDirectory() as output_dir:
            output_file = Path(output_dir) / "report.md"
            with patch(
                "sys.argv",
                ["analyze_shadow.py", "--input-dir", input_dir, "--output-file", str(output_file)],
            ):
                rc = analyze_shadow.main()
            assert rc == 0
            assert output_file.exists()


def test_main_exits_1_on_gate_fail() -> None:
    # 1/9 skip rate → fail
    record = _pr_record(
        total_domains=9,
        skipped=["style"],
        decisions=[{"domain": "style", "action": "skip", "severity": "low"}],
    )
    with tempfile.TemporaryDirectory() as input_dir:
        _write_json(Path(input_dir), "run.json", record)
        with tempfile.TemporaryDirectory() as output_dir:
            output_file = Path(output_dir) / "report.md"
            with patch(
                "sys.argv",
                ["analyze_shadow.py", "--input-dir", input_dir, "--output-file", str(output_file)],
            ):
                rc = analyze_shadow.main()
            assert rc == 1
            assert output_file.exists()


def test_main_exits_1_on_empty_dir() -> None:
    with tempfile.TemporaryDirectory() as input_dir:
        with tempfile.TemporaryDirectory() as output_dir:
            output_file = Path(output_dir) / "report.md"
            with patch(
                "sys.argv",
                ["analyze_shadow.py", "--input-dir", input_dir, "--output-file", str(output_file)],
            ):
                rc = analyze_shadow.main()
            assert rc == 1


def test_main_writes_markdown_file() -> None:
    with tempfile.TemporaryDirectory() as input_dir:
        _write_json(Path(input_dir), "run.json", _passing_pr_record())
        with tempfile.TemporaryDirectory() as output_dir:
            output_file = Path(output_dir) / "subdir" / "report.md"
            with patch(
                "sys.argv",
                ["analyze_shadow.py", "--input-dir", input_dir, "--output-file", str(output_file)],
            ):
                analyze_shadow.main()
            assert output_file.exists()
            content = output_file.read_text(encoding="utf-8")
            assert "# Triage Shadow Validation Report" in content
