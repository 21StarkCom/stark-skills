"""Tests for scripts/automation/logs.py."""

import sys
from pathlib import Path

# Ensure scripts/ is on the path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from automation.logs import parse_run_history, prepend_run_record


def test_prepend_inserts_after_schema_version(tmp_path):
    log = tmp_path / "log.md"
    log.write_text("# Run Log\n<!-- schema_version: 1 -->\n")
    prepend_run_record(log, "## Run 2026-03-28T10:00:00Z\n- **Status**: success")
    content = log.read_text()
    lines = content.split("\n")
    schema_idx = next(i for i, l in enumerate(lines) if "schema_version" in l)
    assert "## Run 2026-03-28T10:00:00Z" in lines[schema_idx + 1]


def test_prepend_maintains_order(tmp_path):
    log = tmp_path / "log.md"
    log.write_text("# Run Log\n<!-- schema_version: 1 -->\n")
    prepend_run_record(log, "## Run 2026-03-28T09:00:00Z\n- **Status**: success")
    prepend_run_record(log, "## Run 2026-03-28T10:00:00Z\n- **Status**: failure")
    content = log.read_text()
    # Newest should appear before oldest
    assert content.index("10:00:00Z") < content.index("09:00:00Z")


def test_parse_run_history_extracts_fields(tmp_path):
    log = tmp_path / "log.md"
    log.write_text(
        """\
# Run Log
<!-- schema_version: 1 -->
## Run 2026-03-28T10:00:00Z
- **Status**: success
- **Duration**: 42.5
- **Prompt tokens**: 1000
- **Completion tokens**: 500
- **Total tokens**: 1500
- **Cost**: $0.018
- **Findings**: 3
- **Actions**: opened PR #42
---
"""
    )
    records = parse_run_history(log)
    assert len(records) == 1
    r = records[0]
    assert r["timestamp"] == "2026-03-28T10:00:00Z"
    assert r["status"] == "success"
    assert r["duration_s"] == 42.5
    assert r["tokens"]["prompt"] == 1000
    assert r["tokens"]["completion"] == 500
    assert r["tokens"]["total"] == 1500
    assert r["cost_usd"] == 0.018
    assert r["findings"] == 3
    assert r["actions"] == "opened PR #42"
    assert "error" not in r


def test_parse_empty_log_returns_empty_list(tmp_path):
    log = tmp_path / "nonexistent.md"
    assert parse_run_history(log) == []
