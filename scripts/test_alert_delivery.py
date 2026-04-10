"""Tests for alert_delivery.py — alert emission, marker files, acknowledgement."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import alert_delivery


# ---------------------------------------------------------------------------
# emit_alert
# ---------------------------------------------------------------------------

class TestEmitAlert:
    def test_appends_entry_to_alerts_jsonl(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("info", "test-source", "hello world")

        assert alerts.exists()
        entry = json.loads(alerts.read_text().strip())
        assert entry["level"] == "info"
        assert entry["source"] == "test-source"
        assert entry["message"] == "hello world"
        assert "timestamp" in entry

    def test_critical_creates_marker_file(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("critical", "cost_controls", "hard stop exceeded")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 1

    def test_warning_does_not_create_marker(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("warning", "cost_controls", "approaching budget")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 0

    def test_info_does_not_create_marker(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("info", "preflight", "all checks passed")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 0

    def test_multiple_criticals_each_get_marker(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("critical", "src1", "msg1")
            alert_delivery.emit_alert("critical", "src2", "msg2")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 2

    def test_same_second_collision_counter(self, tmp_path):
        """When two criticals land at the same unix second, the counter suffix prevents clobbering."""
        alerts = tmp_path / "alerts.jsonl"
        fixed_ts = 1700000000
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path), \
             patch("time.time", return_value=fixed_ts):
            alert_delivery.emit_alert("critical", "src1", "first")
            alert_delivery.emit_alert("critical", "src2", "second")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 2
        names = {m.name for m in markers}
        assert f"alert-{fixed_ts}.marker" in names
        assert f"alert-{fixed_ts}-1.marker" in names

    def test_marker_file_name_contains_timestamp(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("critical", "src", "msg")

        markers = list(tmp_path.glob("alert-*.marker"))
        assert len(markers) == 1
        # Name should be alert-<timestamp>.marker
        name = markers[0].name
        assert name.startswith("alert-")
        assert name.endswith(".marker")

    def test_creates_parent_dirs_if_missing(self, tmp_path):
        alerts = tmp_path / "deep" / "alerts.jsonl"
        markers_dir = tmp_path / "deep" / "markers"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", markers_dir):
            alert_delivery.emit_alert("info", "src", "msg")

        assert alerts.exists()

    def test_appends_multiple_entries(self, tmp_path):
        alerts = tmp_path / "alerts.jsonl"
        with patch.object(alert_delivery, "ALERTS_PATH", alerts), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.emit_alert("info", "a", "first")
            alert_delivery.emit_alert("warning", "b", "second")

        lines = alerts.read_text().strip().splitlines()
        assert len(lines) == 2


# ---------------------------------------------------------------------------
# acknowledge_alert
# ---------------------------------------------------------------------------

class TestAcknowledgeAlert:
    def test_removes_marker_file(self, tmp_path):
        marker = tmp_path / "alert-12345.marker"
        marker.touch()
        alert_delivery.acknowledge_alert(str(marker))
        assert not marker.exists()

    def test_noop_if_marker_does_not_exist(self, tmp_path):
        marker = tmp_path / "alert-99999.marker"
        # Should not raise
        alert_delivery.acknowledge_alert(str(marker))

    def test_accepts_path_object(self, tmp_path):
        marker = tmp_path / "alert-11111.marker"
        marker.touch()
        alert_delivery.acknowledge_alert(marker)
        assert not marker.exists()


# ---------------------------------------------------------------------------
# check_alerts
# ---------------------------------------------------------------------------

class TestCheckAlerts:
    def test_returns_dict_with_unacknowledged_key(self, tmp_path):
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            result = alert_delivery.check_alerts()

        assert "unacknowledged" in result

    def test_returns_unacknowledged_markers(self, tmp_path):
        (tmp_path / "alert-11111.marker").touch()
        (tmp_path / "alert-22222.marker").touch()
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            result = alert_delivery.check_alerts()

        assert len(result["unacknowledged"]) == 2

    def test_returns_empty_when_no_markers(self, tmp_path):
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            result = alert_delivery.check_alerts()

        assert result["unacknowledged"] == []

    def test_ignores_non_marker_files(self, tmp_path):
        (tmp_path / "somefile.txt").touch()
        (tmp_path / "alert-11111.marker").touch()
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            result = alert_delivery.check_alerts()

        assert len(result["unacknowledged"]) == 1

    def test_each_unacknowledged_entry_has_path(self, tmp_path):
        marker = tmp_path / "alert-12345.marker"
        marker.touch()
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            result = alert_delivery.check_alerts()

        assert len(result["unacknowledged"]) == 1
        assert "path" in result["unacknowledged"][0]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

class TestCLI:
    def test_check_json_output_is_valid(self, tmp_path, capsys):
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.main(["--check", "--json"])

        out = capsys.readouterr().out
        data = json.loads(out)
        assert "unacknowledged" in data

    def test_check_default_output_is_human_readable(self, tmp_path, capsys):
        (tmp_path / "alert-11111.marker").touch()
        with patch.object(alert_delivery, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(alert_delivery, "MARKERS_DIR", tmp_path):
            alert_delivery.main(["--check"])

        out = capsys.readouterr().out
        assert "1" in out or "unacknowledged" in out.lower()
