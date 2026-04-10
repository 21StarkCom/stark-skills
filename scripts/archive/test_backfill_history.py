"""Tests for backfill_history.py — historical data backfill."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

import backfill_history


@pytest.fixture()
def history_dir(tmp_path):
    """Create a mock history directory structure with sample review JSON files."""
    h = tmp_path / "history"
    h.mkdir()
    return h


@pytest.fixture()
def sample_pr_review(history_dir):
    """Create a sample PR review rounds.json file."""
    pr_dir = history_dir / "GetEvinced" / "stark-skills" / "42"
    pr_dir.mkdir(parents=True)
    data = {
        "repo": "GetEvinced/stark-skills",
        "pr": 42,
        "mode": "full",
        "rounds": [
            {
                "results": [
                    {"agent": "claude", "domain": "architecture", "duration_s": 30.0, "findings": ["f1", "f2"]},
                    {"agent": "claude", "domain": "security", "duration_s": 25.0, "findings": ["f3"]},
                    {"agent": "codex", "domain": "architecture", "duration_s": 45.0, "findings": []},
                ]
            }
        ],
    }
    (pr_dir / "rounds.json").write_text(json.dumps(data))
    return pr_dir


@pytest.fixture()
def sample_skill_log(history_dir):
    """Create sample skill invocation log entries."""
    runs_dir = history_dir / "runs"
    runs_dir.mkdir()
    for i, skill in enumerate(["stark-team-review", "stark-team-review", "stark-pr-flow"]):
        data = {
            "skill": skill,
            "started_at": f"2026-0{i+1}-01T10:00:00",
            "completed_at": f"2026-0{i+1}-01T10:05:00",
            "duration_s": 300.0,
            "outcome": "success",
        }
        (runs_dir / f"run-{i:03d}.json").write_text(json.dumps(data))
    return runs_dir


class TestScanHistoryFiles:
    def test_scan_finds_pr_review_files(self, history_dir, sample_pr_review):
        with patch.object(backfill_history, "HISTORY_DIR", history_dir):
            files = backfill_history.scan_history_files()
        assert len(files) >= 1
        assert any(f.name == "rounds.json" for f in files)

    def test_scan_returns_empty_for_missing_dir(self, tmp_path):
        missing = tmp_path / "nonexistent"
        with patch.object(backfill_history, "HISTORY_DIR", missing):
            files = backfill_history.scan_history_files()
        assert files == []

    def test_scan_since_filters_by_date(self, history_dir, sample_pr_review):
        with patch.object(backfill_history, "HISTORY_DIR", history_dir):
            # Future date — nothing should match
            files = backfill_history.scan_history_files(since="2099-01-01")
        assert files == []


class TestExtractMetrics:
    def test_extract_total_findings_from_pr_review(self, history_dir, sample_pr_review):
        rounds_file = sample_pr_review / "rounds.json"
        data = json.loads(rounds_file.read_text())
        metrics = backfill_history.extract_metrics(data, rounds_file)
        assert metrics["total_findings"] == 3  # f1, f2, f3

    def test_extract_agent_performance(self, history_dir, sample_pr_review):
        rounds_file = sample_pr_review / "rounds.json"
        data = json.loads(rounds_file.read_text())
        metrics = backfill_history.extract_metrics(data, rounds_file)
        assert "by_agent" in metrics
        assert metrics["by_agent"]["claude"] >= 3
        assert metrics["by_agent"]["codex"] == 0

    def test_extract_findings_by_domain(self, history_dir, sample_pr_review):
        rounds_file = sample_pr_review / "rounds.json"
        data = json.loads(rounds_file.read_text())
        metrics = backfill_history.extract_metrics(data, rounds_file)
        assert "by_domain" in metrics
        assert metrics["by_domain"]["architecture"] == 2
        assert metrics["by_domain"]["security"] == 1

    def test_extract_handles_empty_data(self, tmp_path):
        dummy = tmp_path / "empty.json"
        dummy.write_text("{}")
        metrics = backfill_history.extract_metrics({}, dummy)
        assert metrics["total_findings"] == 0

    def test_extract_includes_duration(self, history_dir, sample_pr_review):
        rounds_file = sample_pr_review / "rounds.json"
        data = json.loads(rounds_file.read_text())
        metrics = backfill_history.extract_metrics(data, rounds_file)
        assert "review_duration_s" in metrics
        assert metrics["review_duration_s"] == pytest.approx(100.0)  # 30 + 25 + 45


class TestGenerateBaseline:
    def test_baseline_written_to_file(self, history_dir, sample_pr_review, tmp_path):
        output = tmp_path / "baselines.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "BASELINES_PATH", output):
            result = backfill_history.generate_baseline(dry_run=False)
        assert output.exists()
        data = json.loads(output.read_text())
        assert "total_reviews" in data
        assert data["total_reviews"] >= 1

    def test_dry_run_does_not_write(self, history_dir, sample_pr_review, tmp_path):
        output = tmp_path / "baselines.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "BASELINES_PATH", output):
            backfill_history.generate_baseline(dry_run=True)
        assert not output.exists()

    def test_baseline_includes_total_findings(self, history_dir, sample_pr_review, tmp_path):
        output = tmp_path / "baselines.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "BASELINES_PATH", output):
            backfill_history.generate_baseline(dry_run=False)
        data = json.loads(output.read_text())
        assert "total_findings" in data
        assert data["total_findings"] >= 3

    def test_baseline_is_idempotent(self, history_dir, sample_pr_review, tmp_path):
        output = tmp_path / "baselines.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "BASELINES_PATH", output):
            backfill_history.generate_baseline(dry_run=False)
            first = json.loads(output.read_text())
            backfill_history.generate_baseline(dry_run=False)
            second = json.loads(output.read_text())
        assert first["total_reviews"] == second["total_reviews"]


class TestGenerateSkillUsage:
    def test_skill_usage_written_to_file(self, history_dir, sample_skill_log, tmp_path):
        output = tmp_path / "skill-usage.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "SKILL_USAGE_PATH", output):
            backfill_history.generate_skill_usage(dry_run=False)
        assert output.exists()
        data = json.loads(output.read_text())
        assert "by_skill" in data

    def test_skill_usage_counts_frequency(self, history_dir, sample_skill_log, tmp_path):
        output = tmp_path / "skill-usage.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "SKILL_USAGE_PATH", output):
            backfill_history.generate_skill_usage(dry_run=False)
        data = json.loads(output.read_text())
        assert data["by_skill"]["stark-team-review"] == 2
        assert data["by_skill"]["stark-pr-flow"] == 1

    def test_skill_usage_dry_run_does_not_write(self, history_dir, sample_skill_log, tmp_path):
        output = tmp_path / "skill-usage.json"
        with patch.object(backfill_history, "HISTORY_DIR", history_dir), \
             patch.object(backfill_history, "SKILL_USAGE_PATH", output):
            backfill_history.generate_skill_usage(dry_run=True)
        assert not output.exists()


class TestCLI:
    def test_main_dry_run_exits_zero(self, history_dir, sample_pr_review, tmp_path):
        """CLI with --dry-run should run without error."""
        import subprocess, sys
        script = Path(__file__).parent / "backfill_history.py"
        result = subprocess.run(
            [sys.executable, str(script), "--dry-run"],
            capture_output=True, text=True,
            env={**__import__("os").environ, "HOME": str(tmp_path)},
        )
        assert result.returncode == 0

    def test_main_since_flag_accepted(self, tmp_path):
        import subprocess, sys
        script = Path(__file__).parent / "backfill_history.py"
        result = subprocess.run(
            [sys.executable, str(script), "--dry-run", "--since", "2026-01-01"],
            capture_output=True, text=True,
            env={**__import__("os").environ, "HOME": str(tmp_path)},
        )
        assert result.returncode == 0
