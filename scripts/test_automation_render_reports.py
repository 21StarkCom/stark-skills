"""Tests for scripts/automation/render_reports.py."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from automation.render_reports import estimate_tokens, render_report


def test_estimate_tokens_returns_correct_structure():
    result = estimate_tokens(4000, 2000)
    assert set(result.keys()) == {"prompt_tokens", "completion_tokens", "total", "cost_usd"}
    assert result["prompt_tokens"] == 1000
    assert result["completion_tokens"] == 500
    assert result["total"] == 1500


def test_estimate_tokens_cost_calculation():
    result = estimate_tokens(4_000_000, 400_000)
    # prompt: 1_000_000 * 3 / 1_000_000 = 3.0
    # completion: 100_000 * 15 / 1_000_000 = 1.5
    assert result["cost_usd"] == 4.5


def test_render_report_with_simple_template(tmp_path):
    tpl = tmp_path / "report.md.j2"
    tpl.write_text("# {{ title }}\nFindings: {{ count }}")
    result = render_report(tpl, {"title": "Test Report", "count": 7})
    assert "# Test Report" in result
    assert "Findings: 7" in result
