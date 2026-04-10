"""Tests for cost_controls.py — cost tracking, alert thresholds, hard-stop."""
from __future__ import annotations

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest

import cost_controls


def _ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _entry(cost_usd: float, source: str, when: datetime | None = None) -> dict:
    return {"timestamp": _ts(when or _now()), "cost_usd": cost_usd, "source": source}


def _write_tracking(path: Path, entries: list[dict]) -> None:
    with path.open("w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")


_DEFAULT_CONFIG = {
    "weekly_budget_usd": 50.0,
    "daily_alert_usd": 15.0,
    "hard_stop_usd": 100.0,
    "track_rolling_7d": True,
}


# ---------------------------------------------------------------------------
# record_cost
# ---------------------------------------------------------------------------

class TestRecordCost:
    def test_creates_file_and_appends_entry(self, tmp_path):
        tracking = tmp_path / "cost-tracking.jsonl"
        with patch.object(cost_controls, "COST_TRACKING_PATH", tracking):
            cost_controls.record_cost(1.23, "test-source")

        assert tracking.exists()
        entry = json.loads(tracking.read_text().strip())
        assert entry["cost_usd"] == pytest.approx(1.23)
        assert entry["source"] == "test-source"
        assert "timestamp" in entry

    def test_appends_multiple_entries(self, tmp_path):
        tracking = tmp_path / "cost-tracking.jsonl"
        with patch.object(cost_controls, "COST_TRACKING_PATH", tracking):
            cost_controls.record_cost(1.0, "a")
            cost_controls.record_cost(2.0, "b")

        lines = tracking.read_text().strip().splitlines()
        assert len(lines) == 2
        assert json.loads(lines[0])["cost_usd"] == pytest.approx(1.0)
        assert json.loads(lines[1])["cost_usd"] == pytest.approx(2.0)

    def test_creates_parent_dirs(self, tmp_path):
        tracking = tmp_path / "deep" / "dir" / "cost-tracking.jsonl"
        with patch.object(cost_controls, "COST_TRACKING_PATH", tracking):
            cost_controls.record_cost(0.5, "src")
        assert tracking.exists()


# ---------------------------------------------------------------------------
# check_costs
# ---------------------------------------------------------------------------

class TestCheckCosts:
    def _check(self, tmp_path, entries, config=None):
        tracking = tmp_path / "cost-tracking.jsonl"
        _write_tracking(tracking, entries)
        return cost_controls.check_costs(
            tracking_path=tracking,
            alerts_path=tmp_path / "alerts.jsonl",
            hard_stop_path=tmp_path / "cost-hard-stop",
            config=config or _DEFAULT_CONFIG,
        )

    def test_returns_required_fields(self, tmp_path):
        result = self._check(tmp_path, [])
        for key in ("daily_usd", "weekly_usd", "budget_remaining_usd", "alert_level"):
            assert key in result

    def test_ok_when_under_limits(self, tmp_path):
        result = self._check(tmp_path, [_entry(1.0, "test")])
        assert result["alert_level"] == "ok"
        assert result["daily_usd"] == pytest.approx(1.0)
        assert result["weekly_usd"] == pytest.approx(1.0)
        assert result["budget_remaining_usd"] == pytest.approx(49.0)

    def test_empty_tracking_returns_ok(self, tmp_path):
        result = self._check(tmp_path, [])
        assert result["alert_level"] == "ok"
        assert result["daily_usd"] == pytest.approx(0.0)
        assert result["weekly_usd"] == pytest.approx(0.0)

    def test_warning_when_daily_exceeds_alert_threshold(self, tmp_path):
        result = self._check(tmp_path, [_entry(16.0, "test")])
        assert result["alert_level"] in ("warning", "critical", "hard_stop")

    def test_warning_alert_logged_to_alerts_jsonl(self, tmp_path):
        alerts_path = tmp_path / "alerts.jsonl"
        tracking = tmp_path / "cost-tracking.jsonl"
        _write_tracking(tracking, [_entry(16.0, "test")])
        cost_controls.check_costs(
            tracking_path=tracking,
            alerts_path=alerts_path,
            hard_stop_path=tmp_path / "cost-hard-stop",
            config=_DEFAULT_CONFIG,
        )
        assert alerts_path.exists()
        entry = json.loads(alerts_path.read_text().strip().splitlines()[0])
        assert entry.get("level") in ("warning", "critical")

    def test_hard_stop_file_created_when_weekly_exceeds_limit(self, tmp_path):
        hard_stop = tmp_path / "cost-hard-stop"
        tracking = tmp_path / "cost-tracking.jsonl"
        _write_tracking(tracking, [_entry(101.0, "test")])
        result = cost_controls.check_costs(
            tracking_path=tracking,
            alerts_path=tmp_path / "alerts.jsonl",
            hard_stop_path=hard_stop,
            config=_DEFAULT_CONFIG,
        )
        assert result["alert_level"] == "hard_stop"
        assert hard_stop.exists()

    def test_old_entries_excluded_from_daily_window(self, tmp_path):
        two_days_ago = _now() - timedelta(days=2)
        result = self._check(tmp_path, [
            _entry(20.0, "old", two_days_ago),
            _entry(1.0, "today"),
        ])
        assert result["daily_usd"] == pytest.approx(1.0)
        assert result["alert_level"] == "ok"

    def test_entries_older_than_7d_excluded_from_weekly(self, tmp_path):
        eight_days_ago = _now() - timedelta(days=8)
        result = self._check(tmp_path, [
            _entry(99.0, "old", eight_days_ago),
            _entry(1.0, "recent"),
        ])
        assert result["weekly_usd"] == pytest.approx(1.0)
        assert result["alert_level"] == "ok"

    def test_budget_remaining_reflects_weekly_spend(self, tmp_path):
        result = self._check(tmp_path, [_entry(10.0, "test")])
        assert result["budget_remaining_usd"] == pytest.approx(40.0)

    def test_hard_stop_when_daily_exceeds_hard_stop(self, tmp_path):
        # daily spend of 101 exceeds hard_stop_usd=100 — triggers hard_stop
        config = {**_DEFAULT_CONFIG, "weekly_budget_usd": 200.0, "hard_stop_usd": 100.0}
        result = self._check(tmp_path, [_entry(101.0, "test")], config=config)
        assert result["alert_level"] == "hard_stop"

    def test_malformed_jsonl_lines_are_skipped(self, tmp_path):
        from datetime import datetime, timezone
        now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        tracking = tmp_path / "cost-tracking.jsonl"
        tracking.write_text(f'not-json\n{{"timestamp":"{now_str}","cost_usd":5.0,"source":"x"}}\n')
        result = cost_controls.check_costs(
            tracking_path=tracking,
            alerts_path=tmp_path / "alerts.jsonl",
            hard_stop_path=tmp_path / "cost-hard-stop",
            config=_DEFAULT_CONFIG,
        )
        # The valid entry is counted; the bad line is skipped without crashing
        assert result["weekly_usd"] == pytest.approx(5.0)
        assert result["alert_level"] == "ok"


# ---------------------------------------------------------------------------
# reset_costs
# ---------------------------------------------------------------------------

class TestResetCosts:
    def test_removes_hard_stop_file(self, tmp_path):
        hard_stop = tmp_path / "cost-hard-stop"
        hard_stop.touch()
        audit = tmp_path / "audit.jsonl"
        cost_controls.reset_costs(hard_stop_path=hard_stop, audit_path=audit)
        assert not hard_stop.exists()

    def test_noop_if_no_hard_stop_file(self, tmp_path):
        hard_stop = tmp_path / "cost-hard-stop"
        audit = tmp_path / "audit.jsonl"
        cost_controls.reset_costs(hard_stop_path=hard_stop, audit_path=audit)
        assert not hard_stop.exists()

    def test_logs_reset_to_audit(self, tmp_path):
        hard_stop = tmp_path / "cost-hard-stop"
        hard_stop.touch()
        audit = tmp_path / "audit.jsonl"
        cost_controls.reset_costs(hard_stop_path=hard_stop, audit_path=audit)
        assert audit.exists()
        entry = json.loads(audit.read_text().strip())
        assert "reset" in json.dumps(entry).lower()
        assert "timestamp" in entry

    def test_logs_reset_even_if_no_hard_stop_file(self, tmp_path):
        audit = tmp_path / "audit.jsonl"
        cost_controls.reset_costs(
            hard_stop_path=tmp_path / "cost-hard-stop",
            audit_path=audit,
        )
        assert audit.exists()


# ---------------------------------------------------------------------------
# CLI output
# ---------------------------------------------------------------------------

class TestCLI:
    def test_check_json_output_is_valid(self, tmp_path, capsys):
        tracking = tmp_path / "cost-tracking.jsonl"
        tracking.write_text("")
        with patch.object(cost_controls, "COST_TRACKING_PATH", tracking), \
             patch.object(cost_controls, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(cost_controls, "HARD_STOP_PATH", tmp_path / "cost-hard-stop"), \
             patch.object(cost_controls, "AUDIT_PATH", tmp_path / "audit.jsonl"):
            cost_controls.main(["--check", "--json"])

        out = capsys.readouterr().out
        data = json.loads(out)
        assert "alert_level" in data

    def test_check_human_readable_output(self, tmp_path, capsys):
        tracking = tmp_path / "cost-tracking.jsonl"
        tracking.write_text("")
        with patch.object(cost_controls, "COST_TRACKING_PATH", tracking), \
             patch.object(cost_controls, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(cost_controls, "HARD_STOP_PATH", tmp_path / "cost-hard-stop"), \
             patch.object(cost_controls, "AUDIT_PATH", tmp_path / "audit.jsonl"):
            cost_controls.main(["--check"])

        out = capsys.readouterr().out
        assert "Alert level" in out
        assert "Daily spend" in out
        assert "Weekly spend" in out
        assert "Budget left" in out

    def test_reset_json_output_is_valid(self, tmp_path, capsys):
        with patch.object(cost_controls, "COST_TRACKING_PATH", tmp_path / "cost-tracking.jsonl"), \
             patch.object(cost_controls, "ALERTS_PATH", tmp_path / "alerts.jsonl"), \
             patch.object(cost_controls, "HARD_STOP_PATH", tmp_path / "cost-hard-stop"), \
             patch.object(cost_controls, "AUDIT_PATH", tmp_path / "audit.jsonl"):
            cost_controls.main(["--reset", "--json"])

        out = capsys.readouterr().out
        data = json.loads(out)
        assert "status" in data
