#!/usr/bin/env python3
"""Unit tests for domain_triage.py."""

from __future__ import annotations

import hashlib
import json
import subprocess
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import domain_triage


def _sample_domains() -> dict[str, domain_triage.DomainMeta]:
    return {
        "architecture": {
            "order": "01",
            "label": "Architecture",
            "filename": "architecture.md",
            "description": "Architecture review",
        },
        "security": {
            "order": "02",
            "label": "Security",
            "filename": "security.md",
            "description": "Security review",
        },
        "testing": {
            "order": "03",
            "label": "Testing",
            "filename": "testing.md",
            "description": "Testing review",
        },
    }


def _triage_json(*domains: dict[str, object]) -> str:
    return json.dumps({"domains": list(domains)})


class TestDomainTriage(unittest.TestCase):
    def setUp(self) -> None:
        self.domains = _sample_domains()
        self.content = "diff --git a/app.py b/app.py\n+print('hello')\n"

    def _run_triage(self, **kwargs: object) -> domain_triage.TriageResult:
        return domain_triage.triage_domains(
            content=kwargs.pop("content", self.content),
            review_type=kwargs.pop("review_type", "pr"),
            domains=kwargs.pop("domains", self.domains),
            mode=kwargs.pop("mode", "aggressive"),
            agent=kwargs.pop("agent", "claude"),
            **kwargs,
        )

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage.subprocess.run")
    def test_full_mode_skips_llm(self, mock_run: MagicMock, _mock_model: MagicMock) -> None:
        result = self._run_triage(mode="full")
        self.assertEqual(result.dispatched_domains, ["architecture", "security", "testing"])
        self.assertTrue(all(verdict.relevant for verdict in result.verdicts))
        mock_run.assert_not_called()

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_aggressive_filters_irrelevant(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "security", "relevant": False, "confidence": 0.95, "reason": "no match"},
                {"domain": "testing", "relevant": True, "confidence": 0.8, "reason": "tests"},
            ),
            None,
        )

        result = self._run_triage(mode="aggressive")

        self.assertEqual(result.dispatched_domains, ["architecture", "testing"])
        self.assertEqual(result.skipped_domains, ["security"])

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_conservative_keeps_low_confidence(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "security", "relevant": False, "confidence": 0.4, "reason": "uncertain"},
                {"domain": "testing", "relevant": False, "confidence": 0.95, "reason": "skip"},
            ),
            None,
        )

        result = self._run_triage(mode="conservative")

        self.assertEqual(result.dispatched_domains, ["architecture", "security"])
        self.assertEqual(result.skipped_domains, ["testing"])

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_conservative_threshold_configurable(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": False, "confidence": 0.59, "reason": "uncertain"},
                {"domain": "security", "relevant": False, "confidence": 0.6, "reason": "exclude"},
                {"domain": "testing", "relevant": True, "confidence": 0.9, "reason": "match"},
            ),
            None,
        )

        result = self._run_triage(mode="conservative", confidence_threshold=0.6)

        self.assertEqual(result.dispatched_domains, ["architecture", "testing"])
        self.assertEqual(result.skipped_domains, ["security"])

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_missing_verdicts_fail_open(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json({"domain": "architecture", "relevant": False, "confidence": 0.95, "reason": "skip"}),
            None,
        )

        result = self._run_triage(mode="aggressive")

        self.assertEqual(result.dispatched_domains, ["security", "testing"])
        missing = {verdict.domain: verdict for verdict in result.verdicts}
        self.assertTrue(missing["security"].relevant)
        self.assertEqual(missing["security"].confidence, 1.0)
        self.assertIn("Missing from triage response", missing["security"].reason)

    def test_duplicate_verdicts_first_wins(self) -> None:
        verdicts, error = domain_triage._parse_triage_response(
            _triage_json(
                {"domain": "architecture", "relevant": False, "confidence": 0.2, "reason": "first"},
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "second"},
                {"domain": "security", "relevant": True, "confidence": 0.7, "reason": "security"},
                {"domain": "testing", "relevant": True, "confidence": 0.8, "reason": "testing"},
            ),
            ["architecture", "security", "testing"],
        )

        self.assertIsNone(error)
        self.assertEqual(verdicts[0].domain, "architecture")
        self.assertFalse(verdicts[0].relevant)
        self.assertEqual(verdicts[0].reason, "first")

    def test_confidence_clamped(self) -> None:
        verdicts, error = domain_triage._parse_triage_response(
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": -0.5, "reason": "low"},
                {"domain": "security", "relevant": False, "confidence": 1.5, "reason": "high"},
                {"domain": "testing", "relevant": True, "confidence": 0.4, "reason": "ok"},
            ),
            ["architecture", "security", "testing"],
        )

        self.assertIsNone(error)
        self.assertEqual([verdict.confidence for verdict in verdicts], [0.0, 1.0, 0.4])

    def test_unknown_domains_ignored(self) -> None:
        verdicts, error = domain_triage._parse_triage_response(
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.8, "reason": "known"},
                {"domain": "unknown", "relevant": True, "confidence": 0.9, "reason": "ignore"},
            ),
            ["architecture"],
        )

        self.assertIsNone(error)
        self.assertEqual(len(verdicts), 1)
        self.assertEqual(verdicts[0].domain, "architecture")

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_disabled_domains_excluded(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "testing", "relevant": True, "confidence": 0.8, "reason": "match"},
            ),
            None,
        )

        result = self._run_triage(disabled_domains=["security"])

        prompt = mock_dispatch.call_args[0][1]
        self.assertNotIn("security", prompt)
        self.assertEqual(result.dispatched_domains, ["architecture", "testing"])
        self.assertNotIn("security", [verdict.domain for verdict in result.verdicts])

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_zero_domains_exits_cleanly(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": False, "confidence": 0.95, "reason": "skip"},
                {"domain": "security", "relevant": False, "confidence": 0.92, "reason": "skip"},
                {"domain": "testing", "relevant": False, "confidence": 0.91, "reason": "skip"},
            ),
            None,
        )

        result = self._run_triage(mode="aggressive")

        self.assertEqual(result.dispatched_domains, [])
        self.assertEqual(result.skipped_domains, ["architecture", "security", "testing"])
        self.assertIsNone(result.error)

    def test_invalid_mode_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid mode: random"):
            self._run_triage(mode="random")

    def test_invalid_agent_raises(self) -> None:
        with self.assertRaisesRegex(ValueError, "Invalid agent: gemini"):
            self._run_triage(agent="gemini")

    def test_parse_valid_json(self) -> None:
        verdicts, error = domain_triage._parse_triage_response(
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.75, "reason": "fits"},
                {"domain": "security", "relevant": False, "confidence": 0.9, "reason": "out of scope"},
            ),
            ["architecture", "security"],
        )

        self.assertIsNone(error)
        self.assertEqual(
            verdicts,
            [
                domain_triage.DomainVerdict("architecture", True, 0.75, "fits"),
                domain_triage.DomainVerdict("security", False, 0.9, "out of scope"),
            ],
        )

    def test_parse_json_with_prose_wrapper(self) -> None:
        raw = (
            "I reviewed the input.\n\n```json\n"
            + _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.8, "reason": "fits"},
                {"domain": "security", "relevant": False, "confidence": 0.85, "reason": "skip"},
            )
            + "\n```"
        )

        verdicts, error = domain_triage._parse_triage_response(raw, ["architecture", "security"])

        self.assertIsNone(error)
        self.assertEqual([verdict.domain for verdict in verdicts], ["architecture", "security"])

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage.subprocess.run")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    def test_parse_malformed_json_fallback(
        self,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        mock_run: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_run.return_value = SimpleNamespace(stdout="not json at all", stderr="", returncode=0)

        result = self._run_triage(agent="claude")

        self.assertEqual(result.dispatched_domains, ["architecture", "security", "testing"])
        self.assertIsNotNone(result.error)
        self.assertIn("json_parse_error", result.error)
        self.assertTrue(all(verdict.relevant for verdict in result.verdicts))

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_content_hash_computed(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "security", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "testing", "relevant": True, "confidence": 0.9, "reason": "match"},
            ),
            None,
        )

        result = self._run_triage(content="plain content")

        self.assertEqual(result.content_hash, hashlib.sha256(b"plain content").hexdigest())

    @patch("domain_triage.get_model_id", return_value="test-model")
    @patch("domain_triage._load_domain_descriptions", return_value={})
    @patch("domain_triage._load_prompt", return_value="{domains}\n\n{content}")
    @patch("domain_triage._dispatch_to_agent")
    def test_large_input_summarized(
        self,
        mock_dispatch: MagicMock,
        _mock_prompt: MagicMock,
        _mock_descriptions: MagicMock,
        _mock_model: MagicMock,
    ) -> None:
        mock_dispatch.return_value = (
            _triage_json(
                {"domain": "architecture", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "security", "relevant": True, "confidence": 0.9, "reason": "match"},
                {"domain": "testing", "relevant": True, "confidence": 0.9, "reason": "match"},
            ),
            None,
        )
        content = "# Heading\n" + ("A" * 120001)

        result = self._run_triage(content=content, review_type="design")

        prompt = mock_dispatch.call_args[0][1]
        self.assertEqual(result.input_strategy, "summary")
        self.assertIn("Document Summary", prompt)


if __name__ == "__main__":
    unittest.main()
