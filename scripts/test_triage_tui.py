#!/usr/bin/env python3
"""Unit tests for triage_tui.py."""

from __future__ import annotations

import re
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import triage_tui


EMOJI_RE = re.compile(r"[\u2600-\u27BF\U0001F300-\U0001FFFF]")


def _sample_result() -> SimpleNamespace:
    verdicts = [
        SimpleNamespace(domain="architecture", relevant=True, confidence=0.91, reason="match"),
        SimpleNamespace(domain="security", relevant=False, confidence=0.87, reason="skip"),
    ]
    return SimpleNamespace(
        verdicts=verdicts,
        dispatched_domains=["architecture"],
        skipped_domains=["security"],
        duration_s=1.23,
    )


def _all_outputs(config: triage_tui.TUIConfig) -> list[str]:
    return [
        triage_tui.render_banner(config, "pr", "org/repo", 42, "aggressive", "claude", "model-x"),
        triage_tui.render_triage(config, _sample_result()),
        triage_tui.render_dispatch_progress(config, 1, 2, "claude", "architecture", "success", 3, 0.5),
        triage_tui.render_summary(
            config,
            total_findings=4,
            by_severity={"critical": 1, "high": 1, "medium": 1, "low": 1},
            succeeded=1,
            failed=1,
            total_duration=2.5,
            triage_duration=0.5,
        ),
        triage_tui.render_insights(config, success=False, error="offline"),
        triage_tui.render_zero_domains(config),
    ]


class TestTriageTUI(unittest.TestCase):
    def test_no_color_strips_ansi(self) -> None:
        with patch.dict("os.environ", {"NO_COLOR": "1"}, clear=False), patch("sys.stdout.isatty", return_value=True):
            config = triage_tui.make_config()

        output = "\n".join(_all_outputs(config))
        self.assertNotRegex(output, r"\033\[")

    def test_non_tty_strips_ansi(self) -> None:
        with patch.dict("os.environ", {}, clear=False), patch("sys.stdout.isatty", return_value=False):
            config = triage_tui.make_config()

        output = "\n".join(_all_outputs(config))
        self.assertNotRegex(output, r"\033\[")

    def test_plain_mode_strips_emojis(self) -> None:
        config = triage_tui.make_config(plain=True)

        output = "\n".join(_all_outputs(config))
        self.assertIsNone(EMOJI_RE.search(output))

    def test_plain_mode_ascii_borders(self) -> None:
        config = triage_tui.make_config(plain=True)

        output = triage_tui.render_banner(config, "pr", "org/repo", 42, "aggressive", "claude", "model-x")
        self.assertNotRegex(output, r"[╔═╗║╚╝─]")
        self.assertIn("=" * 72, output)


if __name__ == "__main__":
    unittest.main()
