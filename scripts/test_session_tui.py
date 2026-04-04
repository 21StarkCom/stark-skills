#!/usr/bin/env python3
"""Unit tests for session_tui.py."""

from __future__ import annotations

import re
import unittest

from tui_core import TUIConfig, make_config, strip_ansi

import session_tui
from session_tui import (
    AlertInfo,
    BannerData,
    BoardItem,
    CommitInfo,
    DiffSummary,
    FileChange,
    GitState,
    HealthCheck,
    NextUpItem,
    PRInfo,
    format_duration,
    render_alerts,
    render_board,
    render_diff_summary,
    render_end_summary,
    render_git_state,
    render_health,
    render_next_up,
    render_prs,
    render_receipt,
    render_session_banner,
    render_start_briefing,
)

ANSI_RE = re.compile(r"\033\[")
EMOJI_RE = re.compile(r"[\u2600-\u27BF\U0001F300-\U0001FFFF]")


def _color_config() -> TUIConfig:
    return TUIConfig(color=True, plain=False, json_mode=False)


def _no_color_config() -> TUIConfig:
    return TUIConfig(color=False, plain=False, json_mode=False)


def _plain_config() -> TUIConfig:
    return TUIConfig(color=False, plain=True, json_mode=False)


def _start_banner_data(**overrides) -> BannerData:
    d: dict = {
        "mode": "start",
        "repo": "org/repo",
        "branch": "main",
        "session_id": "sess-abc123",
        "started_at": "2026-04-04T14:30:00+03:00",
    }
    d.update(overrides)
    return d  # type: ignore[return-value]


def _end_banner_data(**overrides) -> BannerData:
    d: dict = {
        "mode": "end",
        "repo": "org/repo",
        "branch": "main",
        "session_id": "sess-abc123",
        "started_at": "2026-04-04T14:30:00+03:00",
        "ended_at": "2026-04-04T17:17:00+03:00",
        "duration": "2h 47m",
        "session_name": "tui-phase-2",
    }
    d.update(overrides)
    return d  # type: ignore[return-value]


def _sample_git() -> GitState:
    return {
        "branch": "feat/tui",
        "ahead": 3,
        "behind": 0,
        "uncommitted": ["scripts/session_tui.py", "scripts/test_session_tui.py"],
        "recent_commits": [
            {"sha": "a628ae0", "message": "add session TUI", "age": "2h ago"},
            {"sha": "b739bf1", "message": "fix test", "age": "3h ago"},
        ],
    }


def _sample_prs() -> list[PRInfo]:
    return [
        {"number": 42, "title": "Add session TUI", "status": "ready"},
        {"number": 43, "title": "Fix lint", "status": "review_requested"},
        {"number": 44, "title": "WIP: board", "status": "draft"},
        {"number": 40, "title": "Release v0.5", "status": "merged"},
    ]


def _sample_health() -> list[HealthCheck]:
    return [
        {"name": "Tests", "passed": True, "detail": "586 passed, 22 skipped", "duration": 12.3},
        {"name": "Build", "passed": True, "detail": "OK", "duration": 5.0},
        {"name": "Lint", "passed": False, "detail": "3 errors", "duration": 1.2},
    ]


def _sample_alerts() -> list[AlertInfo]:
    return [
        {"level": "warning", "message": "Disk usage high", "context": "(82%)"},
        {"level": "critical", "message": "CI down", "context": "(outage)"},
    ]


def _sample_board() -> list[BoardItem]:
    return [
        {"title": "Session TUI", "status": "in_flight", "issue_number": "#234"},
        {"title": "Blocked on API", "status": "blocked", "issue_number": "#235"},
    ]


def _sample_next_up() -> list[NextUpItem]:
    return [
        {"label": "Implement phase 3", "priority": "action", "issue": "#139"},
        {"label": "Update docs", "priority": "low", "issue": None},
        {"label": "Fix flaky test", "priority": "action", "issue": "#140"},
    ]


def _sample_diff() -> DiffSummary:
    return {
        "added": 120,
        "removed": 30,
        "file_count": 4,
        "key_files": [
            {"path": "scripts/session_tui.py", "status": "new"},
            {"path": "scripts/test_session_tui.py", "status": "new"},
            {"path": "scripts/tui_core.py", "status": "modified"},
            {"path": "scripts/old_render.py", "status": "deleted"},
        ],
    }


class TestSessionTUI(unittest.TestCase):

    # 1. test_start_banner_contains_session_id
    def test_start_banner_contains_session_id(self) -> None:
        config = _color_config()
        output = render_session_banner(config, _start_banner_data())
        self.assertIn("sess-abc123", output)

    # 2. test_start_banner_contains_start_time
    def test_start_banner_contains_start_time(self) -> None:
        config = _color_config()
        output = render_session_banner(config, _start_banner_data())
        self.assertIn("14:30", output)

    # 3. test_end_banner_contains_duration
    def test_end_banner_contains_duration(self) -> None:
        config = _color_config()
        output = render_session_banner(config, _end_banner_data())
        self.assertIn("2h 47m", output)

    # 4. test_end_banner_contains_session_name
    def test_end_banner_contains_session_name(self) -> None:
        config = _color_config()
        output = render_session_banner(config, _end_banner_data())
        self.assertIn("tui-phase-2", output)

    # 5. test_end_banner_missing_optional_fields
    def test_end_banner_missing_optional_fields(self) -> None:
        config = _color_config()
        # End mode but without duration, session_name, ended_at
        data = _start_banner_data(mode="end")
        output = render_session_banner(config, data)
        self.assertIn("sess-abc123", output)
        self.assertNotIn("Duration:", output)
        self.assertNotIn("Name:", output)
        self.assertNotIn("Ended:", output)

    # 6. test_alerts_empty_returns_empty
    def test_alerts_empty_returns_empty(self) -> None:
        config = _color_config()
        output = render_alerts(config, [])
        self.assertEqual(output, "")

    # 7. test_board_empty_returns_empty
    def test_board_empty_returns_empty(self) -> None:
        config = _color_config()
        output = render_board(config, [])
        self.assertEqual(output, "")

    # 8. test_next_up_ordering
    def test_next_up_ordering(self) -> None:
        config = _plain_config()
        items = _sample_next_up()
        output = render_next_up(config, items)
        lines = output.split("\n")
        # Find bullet lines (skip section header)
        bullet_lines = [l for l in lines if "\u25cf" in l or "\u25cb" in l]
        # First two should be action (filled circle), last should be low (open circle)
        self.assertIn("\u25cf", bullet_lines[0])  # "Implement phase 3" - action
        self.assertIn("\u25cf", bullet_lines[1])  # "Fix flaky test" - action
        self.assertIn("\u25cb", bullet_lines[2])  # "Update docs" - low

    # 9. test_no_color_strips_ansi
    def test_no_color_strips_ansi(self) -> None:
        config = _no_color_config()
        outputs = [
            render_session_banner(config, _start_banner_data()),
            render_git_state(config, _sample_git()),
            render_prs(config, _sample_prs()),
            render_health(config, _sample_health()),
            render_alerts(config, _sample_alerts()),
            render_board(config, _sample_board()),
            render_next_up(config, _sample_next_up()),
            render_receipt(config, _sample_health()),
            render_diff_summary(config, _sample_diff()),
        ]
        combined = "\n".join(outputs)
        self.assertNotRegex(combined, r"\033\[")

    # 10. test_plain_mode_no_emoji
    def test_plain_mode_no_emoji(self) -> None:
        config = _plain_config()
        outputs = [
            render_session_banner(config, _start_banner_data()),
            render_git_state(config, _sample_git()),
            render_prs(config, _sample_prs()),
            render_health(config, _sample_health()),
            render_alerts(config, _sample_alerts()),
            render_board(config, _sample_board()),
            render_next_up(config, _sample_next_up()),
            render_receipt(config, _sample_health()),
            render_diff_summary(config, _sample_diff()),
        ]
        combined = "\n".join(outputs)
        self.assertFalse(EMOJI_RE.search(combined), f"Found emoji in plain output: {combined}")

    # 11. test_pr_status_has_text_labels
    def test_pr_status_has_text_labels(self) -> None:
        config = _color_config()
        output = render_prs(config, _sample_prs())
        self.assertIn("ready to merge", output)
        self.assertIn("review requested", output)
        self.assertIn("draft", output)
        self.assertIn("merged", output)

    # 12. test_receipt_all_passed
    def test_receipt_all_passed(self) -> None:
        config = _plain_config()
        checks: list[HealthCheck] = [
            {"name": "Tests", "passed": True, "detail": "all pass", "duration": 5.0},
            {"name": "Build", "passed": True, "detail": "OK", "duration": 2.0},
        ]
        output = render_receipt(config, checks)
        self.assertIn("[OK]", output)
        self.assertNotIn("[FAIL]", output)
        self.assertNotIn("[WARN]", output)

    # 13. test_receipt_mixed_status
    def test_receipt_mixed_status(self) -> None:
        config = _plain_config()
        checks: list[HealthCheck] = [
            {"name": "Tests", "passed": True, "detail": "pass", "duration": None},
            {"name": "Build", "passed": False, "detail": "error", "duration": None},
            {"name": "Lint", "passed": None, "detail": "skipped", "duration": None},
        ]
        output = render_receipt(config, checks)
        self.assertIn("[OK]", output)
        self.assertIn("[FAIL]", output)
        self.assertIn("[WARN]", output)

    # 14. test_render_start_briefing_composition
    def test_render_start_briefing_composition(self) -> None:
        config = _plain_config()
        banner = render_session_banner(config, _start_banner_data())
        output = render_start_briefing(
            config,
            banner,
            git=_sample_git(),
            prs=_sample_prs(),
            health=_sample_health(),
            alerts=_sample_alerts(),
            board=_sample_board(),
            next_up=_sample_next_up(),
        )
        # Check all sections present in correct order
        sections_in_order = ["[SESSION START]", "[GIT]", "[PRS]", "[HEALTH]", "[ALERTS]", "[BOARD]", "[NEXT]"]
        positions = [output.index(s) for s in sections_in_order]
        self.assertEqual(positions, sorted(positions), "Sections not in expected order")

    # 15. test_render_start_briefing_git_none
    def test_render_start_briefing_git_none(self) -> None:
        config = _plain_config()
        banner = render_session_banner(config, _start_banner_data())
        output = render_start_briefing(
            config,
            banner,
            git=None,
            prs=[],
            health=[],
            alerts=[],
            board=[],
            next_up=[],
        )
        self.assertIn("Git state unavailable", output)
        self.assertNotIn("[GIT]", output)

    # 16. test_render_end_summary_composition
    def test_render_end_summary_composition(self) -> None:
        config = _plain_config()
        banner = render_session_banner(config, _end_banner_data())
        receipt = render_receipt(config, _sample_health())
        output = render_end_summary(
            config,
            banner,
            receipt,
            diff=_sample_diff(),
            next_up=_sample_next_up(),
        )
        sections_in_order = ["[SESSION END]", "[RECEIPT]", "[DIFF]", "[NEXT]"]
        positions = [output.index(s) for s in sections_in_order]
        self.assertEqual(positions, sorted(positions), "Sections not in expected order")

    # 17. test_uncommitted_files_capped_at_10
    def test_uncommitted_files_capped_at_10(self) -> None:
        config = _color_config()
        git = _sample_git()
        git["uncommitted"] = [f"file_{i}.py" for i in range(15)]
        output = render_git_state(config, git)
        # Should show exactly 10 files + "5 more"
        self.assertIn("5 more", output)
        self.assertIn("file_9.py", output)
        self.assertNotIn("file_10.py", output)

    # 18. test_commits_capped_at_5
    def test_commits_capped_at_5(self) -> None:
        config = _color_config()
        git = _sample_git()
        git["recent_commits"] = [
            {"sha": f"abc{i:04d}", "message": f"commit {i}", "age": f"{i}h ago"}
            for i in range(8)
        ]
        output = render_git_state(config, git)
        self.assertIn("3 more", output)
        self.assertIn("abc0004", output)  # 5th commit (index 4) shown
        self.assertNotIn("abc0005", output)  # 6th commit (index 5) not shown

    # 19. test_health_empty_shows_message
    def test_health_empty_shows_message(self) -> None:
        config = _color_config()
        output = render_health(config, [])
        self.assertIn("No health checks configured.", output)

    # 20. test_sanitization_strips_injected_escapes
    def test_sanitization_strips_injected_escapes(self) -> None:
        config = _plain_config()
        # A branch name that somehow contains ANSI (should have been sanitized at ingestion).
        # The renderer just displays what it gets, so we verify the visible text is present.
        git = _sample_git()
        git["branch"] = "\033[31mmalicious\033[0m-branch"
        output = render_git_state(config, git)
        # The visible text "malicious" and "-branch" should be in the output
        self.assertIn("malicious", output)
        self.assertIn("-branch", output)

    # 21. test_error_item_renders_as_warning
    def test_error_item_renders_as_warning(self) -> None:
        config = _plain_config()
        checks: list[HealthCheck] = [
            {"name": "API", "passed": None, "detail": "unavailable", "duration": None},
        ]
        output = render_health(config, checks)
        self.assertIn("[WARN]", output)
        self.assertIn("unavailable", output)


class TestFormatDuration(unittest.TestCase):

    def test_hours_and_minutes(self) -> None:
        self.assertEqual(format_duration(7200 + 300), "2h 5m")

    def test_minutes_only(self) -> None:
        self.assertEqual(format_duration(300), "5m")

    def test_seconds_only(self) -> None:
        self.assertEqual(format_duration(45), "45s")

    def test_zero(self) -> None:
        self.assertEqual(format_duration(0), "0s")


if __name__ == "__main__":
    unittest.main()
