from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from config_loader import DEFAULT_FORGE
from forge_classifier import (
    ClassificationResult,
    append_classification_log,
    classify_spec,
    match_heuristics,
    maybe_patch_heuristics,
)

DEFAULT_CFG = DEFAULT_FORGE


def _write_heuristics(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "version": 1,
                "always_include": [
                    "general",
                    "completeness",
                    "scope",
                    "consistency",
                ],
                "conditional": {
                    "api-design": {
                        "patterns": [
                            "\\bREST\\b",
                            "\\bAPI\\b",
                            "\\bendpoint",
                            "\\bHTTP\\b",
                            "\\bGraphQL\\b",
                        ]
                    },
                    "data-modeling": {
                        "patterns": [
                            "\\bdatabase\\b",
                            "\\bschema\\b",
                            "\\bPostgreSQL\\b",
                            "\\bSQLite\\b",
                            "\\bmodel\\b",
                        ]
                    },
                    "security": {
                        "patterns": [
                            "\\bauth\\b",
                            "\\btoken\\b",
                            "\\bencrypt\\b",
                            "\\bsecret\\b",
                            "\\bpermission\\b",
                        ]
                    },
                    "scalability": {
                        "patterns": [
                            "\\bconcurren\\b",
                            "\\bscale\\b",
                            "\\bperformanc\\b",
                            "\\bthroughput\\b",
                        ]
                    },
                    "resilience": {
                        "patterns": [
                            "\\bretry\\b",
                            "\\bfailover\\b",
                            "\\bcircuit.breaker\\b",
                            "\\btimeout\\b",
                        ]
                    },
                    "extensibility": {
                        "patterns": [
                            "\\bplugin\\b",
                            "\\bhook\\b",
                            "\\bextend\\b",
                            "\\bregist\\b",
                        ]
                    },
                    "accessibility": {
                        "patterns": [
                            "\\ba11y\\b",
                            "\\baccessib\\b",
                            "\\bscreen.reader\\b",
                            "\\bWCAG\\b",
                            "\\bARIA\\b",
                        ]
                    },
                    "implementation-feasibility": {"patterns": ["always"]},
                },
                "patches_since_consolidation": 0,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def test_backend_spec_skips_accessibility(tmp_path):
    heuristics = tmp_path / "forge_heuristics.json"
    _write_heuristics(heuristics)
    content = "This service exposes REST API endpoints with PostgreSQL database storage and auth token validation"
    with patch("forge_classifier._heuristics_path", return_value=heuristics):
        result = classify_spec(content, Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    assert "accessibility" not in result.domains
    assert "api-design" in result.domains
    assert "security" in result.domains
    assert "data-modeling" in result.domains


def test_always_included_domains(tmp_path):
    heuristics = tmp_path / "forge_heuristics.json"
    _write_heuristics(heuristics)
    with patch("forge_classifier._heuristics_path", return_value=heuristics):
        result = classify_spec("minimal spec", Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    for d in ["general", "completeness", "scope", "consistency"]:
        assert d in result.domains


def test_implementation_feasibility_always_included(tmp_path):
    heuristics = tmp_path / "forge_heuristics.json"
    _write_heuristics(heuristics)
    with patch("forge_classifier._heuristics_path", return_value=heuristics):
        result = classify_spec("minimal spec", Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    assert "implementation-feasibility" in result.domains


def test_tier_2_fallback_when_confidence_low(tmp_path):
    heuristics = tmp_path / "forge_heuristics.json"
    _write_heuristics(heuristics)
    with patch("forge_classifier._heuristics_path", return_value=heuristics), patch(
        "forge_classifier._llm_classify",
        return_value={
            "domains": ["security", "api-design"],
            "confidence": 0.9,
            "explanation": "security api",
        },
    ):
        result = classify_spec("minimal spec", Path("test.md"), auto_detect=True, cfg=DEFAULT_CFG)
    assert result.tier_used == 2
    assert result.confidence == 0.9
    assert "security" in result.domains
    assert "api-design" in result.domains


def test_poisoning_guard(tmp_path):
    """Raw spec text cannot become a heuristic pattern."""
    tmp_heuristics = tmp_path / "forge_heuristics.json"
    _write_heuristics(tmp_heuristics)
    spec_text = "This is a very long specification document about REST APIs"
    maybe_patch_heuristics(
        explanation_terms=["REST API", spec_text],
        domain="api-design",
        heuristics_path=tmp_heuristics,
    )
    heuristics = json.loads(tmp_heuristics.read_text())
    for pattern in heuristics["conditional"]["api-design"]["patterns"]:
        assert len(pattern) < 50, f"Pattern too long (poisoning risk): {pattern}"


def test_log_rotation_at_1000_entries(tmp_path):
    log_path = tmp_path / "forge_classification_log.jsonl"
    for index in range(1000):
        append_classification_log(log_path, {"i": index})
    append_classification_log(log_path, {"i": 1000})
    backup = tmp_path / "forge_classification_log.jsonl.bak"
    assert backup.exists()
    assert len(backup.read_text(encoding="utf-8").splitlines()) == 1000
    assert log_path.read_text(encoding="utf-8").splitlines() == ['{"i": 1000}']
