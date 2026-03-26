"""Tests for tournament.py — extracted tournament engine functions."""
import json
import random
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).parent))
from tournament import (
    compute_weighted_average,
    select_winner,
    parse_scores,
    write_audit_entry,
    unescape_json_string,
    FACTOR_WEIGHTS,
    TournamentConfig,
    TournamentResult,
    CompetitorConfig,
    Tournament,
    evaluate_semantic,
)

import pytest
import textwrap


def test_compute_weighted_average():
    scores = {
        "visual_clarity": 8, "completeness": 9, "info_architecture": 7,
        "accuracy": 9, "design_quality": 7, "audience_fit": 8,
    }
    avg = compute_weighted_average(scores, FACTOR_WEIGHTS)
    assert abs(avg - 8.15) < 0.1


def test_select_winner_clear():
    agent_scores = {"claude": 9.0, "codex": 7.5, "gemini": 8.0}
    accuracy_scores = {"claude": 9.0, "codex": 8.0, "gemini": 8.5}
    winner = select_winner(agent_scores, accuracy_scores)
    assert winner == "claude"


def test_select_winner_tie_break():
    agent_scores = {"claude": 8.15, "codex": 7.5, "gemini": 8.15}
    accuracy_scores = {"claude": 9.0, "codex": 8.0, "gemini": 8.5}
    winner = select_winner(agent_scores, accuracy_scores)
    assert winner == "claude"


def test_select_winner_float_tie():
    agent_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    accuracy_scores = {"claude": 8.0, "codex": 8.0, "gemini": 8.0}
    random.seed(42)
    winner_a = select_winner(agent_scores, accuracy_scores)
    random.seed(99)
    winner_b = select_winner(agent_scores, accuracy_scores)
    assert winner_a in ("claude", "codex", "gemini")
    assert winner_b in ("claude", "codex", "gemini")
    assert not (winner_a == "claude" and winner_b == "claude"), \
        "Tie-breaking appears alphabetical, not random"


def test_parse_scores():
    raw = json.dumps({
        "scores": [
            {"agent": "claude", "visual_clarity": 8, "completeness": 9,
             "info_architecture": 7, "accuracy": 9, "design_quality": 7, "audience_fit": 8},
            {"agent": "codex", "visual_clarity": 7, "completeness": 8,
             "info_architecture": 8, "accuracy": 8, "design_quality": 6, "audience_fit": 7},
            {"agent": "gemini", "visual_clarity": 9, "completeness": 7,
             "info_architecture": 8, "accuracy": 7, "design_quality": 8, "audience_fit": 9},
        ]
    })
    scores = parse_scores(raw)
    assert len(scores) == 3
    assert scores[0]["agent"] == "claude"


def test_write_audit_entry(tmp_path):
    audit_path = tmp_path / "scores.jsonl"
    entry = {"skill": "stark-review", "audience": "usage", "winner": "claude", "winner_score": 8.25}
    write_audit_entry(audit_path, entry)
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["skill"] == "stark-review"
    assert "timestamp" in parsed

    write_audit_entry(audit_path, {**entry, "skill": "stark-session"})
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 2


def test_unescape_json_string():
    escaped = '<html>\\n<body>\\n<div class=\\"node-phase\\">Phase 1</div>\\n</body>\\n</html>'
    result = unescape_json_string(escaped)
    assert "\n" in result
    assert "\\n" not in result
    assert '"node-phase"' in result


def test_unescape_json_string_passthrough():
    clean = '<html>\n<body>\n<div class="node-phase">Phase 1</div>\n</body>\n</html>'
    result = unescape_json_string(clean)
    assert result == clean


# ── TournamentConfig / TournamentResult tests ─────────────────────────


def test_tournament_config_from_dict():
    """Minimal config with just prompt_template, verify defaults."""
    cfg = TournamentConfig.from_dict({"prompt_template": "Generate {thing}"})
    assert cfg.prompt_template == "Generate {thing}"
    assert len(cfg.competitors) == 3
    assert cfg.evaluation.strategy == "semantic"
    assert cfg.execution.max_workers == 6
    assert cfg.execution.timeout_seconds == 300
    assert cfg.output.keep_all is False


def test_tournament_config_from_yaml(tmp_path):
    """Write YAML to tmp_path, load it, verify fields."""
    yaml_content = textwrap.dedent("""\
        schema_version: 1
        prompt_template: "Build a {component} for {audience}"
        competitors:
          - id: claude
            agent: claude
          - id: codex
            agent: codex
        evaluation:
          strategy: visual
          factors:
            accuracy:
              weight: 3.0
        execution:
          max_workers: 4
          timeout_seconds: 600
        output:
          keep_all: true
    """)
    yaml_file = tmp_path / "tournament.yaml"
    yaml_file.write_text(yaml_content)

    cfg = TournamentConfig.from_yaml(yaml_file)
    assert cfg.prompt_template == "Build a {component} for {audience}"
    assert len(cfg.competitors) == 2
    assert cfg.competitors[0].id == "claude"
    assert cfg.evaluation.strategy == "visual"
    assert cfg.evaluation.factors["accuracy"]["weight"] == 3.0
    assert cfg.execution.max_workers == 4
    assert cfg.execution.timeout_seconds == 600
    assert cfg.output.keep_all is True


def test_tournament_config_validates_schema_version(tmp_path):
    """Bad version raises ValueError."""
    yaml_content = textwrap.dedent("""\
        schema_version: 99
        prompt_template: "test"
    """)
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text(yaml_content)

    with pytest.raises(ValueError, match="Unsupported schema_version: 99"):
        TournamentConfig.from_yaml(yaml_file)


def test_tournament_config_defaults():
    """Verify 3 competitors, semantic strategy, max_workers=6, timeout=300."""
    cfg = TournamentConfig.from_dict({"prompt_template": "test"})
    assert [c.id for c in cfg.competitors] == ["claude", "codex", "gemini"]
    assert cfg.evaluation.strategy == "semantic"
    assert cfg.evaluation.judge == "claude-sonnet-4-6"
    assert cfg.execution.max_workers == 6
    assert cfg.execution.timeout_seconds == 300
    assert cfg.execution.retries == 1
    expected_factors = {"correctness", "completeness", "quality"}
    assert set(cfg.evaluation.factors.keys()) == expected_factors


def test_tournament_config_prompt_override():
    """Verify resolve_prompt handles variable substitution and prompt_override."""
    cfg = TournamentConfig.from_dict({
        "prompt_template": "Generate a {component} for {audience}",
        "competitors": [
            {"id": "plain", "agent": "claude"},
            {"id": "wrapped", "agent": "codex",
             "prompt_override": "Be extra careful.\n{base_prompt}"},
        ],
    })

    plain = cfg.competitors[0]
    wrapped = cfg.competitors[1]

    resolved_plain = cfg.resolve_prompt(plain, component="chart", audience="devs")
    assert resolved_plain == "Generate a chart for devs"

    resolved_wrapped = cfg.resolve_prompt(wrapped, component="chart", audience="devs")
    assert resolved_wrapped == "Be extra careful.\nGenerate a chart for devs"


def test_tournament_result_structure():
    """Create a TournamentResult, verify fields."""
    result = TournamentResult(
        winner="claude",
        winner_score=8.5,
        scores={"claude": {"correctness": 9, "completeness": 8}},
        artifacts={"claude": "/tmp/out.html"},
        audit={"rounds": 1},
        quality_flag="good",
    )
    assert result.winner == "claude"
    assert result.winner_score == 8.5
    assert "claude" in result.scores
    assert result.artifacts["claude"] == "/tmp/out.html"
    assert result.audit["rounds"] == 1
    assert result.quality_flag == "good"

    # Verify defaults
    empty = TournamentResult(winner=None, winner_score=0.0, scores={})
    assert empty.artifacts == {}
    assert empty.audit == {}
    assert empty.quality_flag == "unknown"


# ── Tournament orchestrator tests ──────────────────────────────────────


def _make_config(**overrides):
    """Helper to build a TournamentConfig for tests."""
    defaults = {
        "prompt_template": "Generate a widget",
        "competitors": [
            {"id": "claude", "agent": "claude"},
            {"id": "codex", "agent": "codex"},
            {"id": "gemini", "agent": "gemini"},
        ],
    }
    defaults.update(overrides)
    return TournamentConfig.from_dict(defaults)


@patch("tournament.evaluate_semantic")
@patch("tournament.dispatch_competitor")
def test_tournament_semantic_mock(mock_dispatch, mock_eval):
    """Mock dispatch and evaluate_semantic, run Tournament.run(), verify winner."""
    # dispatch_competitor returns string output for each competitor
    def fake_dispatch(agent, prompt, comp_id):
        return f"Output from {comp_id}"

    mock_dispatch.side_effect = fake_dispatch

    # evaluate_semantic returns factor scores
    mock_eval.return_value = {
        "claude": {"correctness": 9, "completeness": 8, "quality": 7},
        "codex": {"correctness": 7, "completeness": 7, "quality": 6},
        "gemini": {"correctness": 8, "completeness": 9, "quality": 8},
    }

    config = _make_config()
    t = Tournament(config)
    result = t.run()

    assert result.winner is not None
    assert result.winner in ("claude", "codex", "gemini")
    assert result.quality_flag in ("good", "acceptable", "poor")
    assert result.scores  # scores dict should not be empty
    mock_eval.assert_called_once()


@patch("tournament.dispatch_competitor")
def test_tournament_all_fail(mock_dispatch):
    """All competitors fail, verify all_failed result."""
    mock_dispatch.side_effect = Exception("CLI not found")

    config = _make_config()
    t = Tournament(config)
    result = t.run()

    assert result.winner is None
    assert result.quality_flag == "all_failed"
    assert result.scores == {}


@patch("tournament.evaluate_semantic")
@patch("tournament.dispatch_competitor")
def test_tournament_eval_failure_fallback(mock_dispatch, mock_eval):
    """Evaluation raises exception, verify first-valid fallback with eval_failed flag."""
    def fake_dispatch(agent, prompt, comp_id):
        return f"Output from {comp_id}"

    mock_dispatch.side_effect = fake_dispatch
    mock_eval.side_effect = RuntimeError("Judge API down")

    config = _make_config()
    t = Tournament(config)
    result = t.run()

    assert result.winner is not None  # falls back to first valid
    assert result.quality_flag == "eval_failed"
    assert result.winner_score == 0.0


@patch("tournament.dispatch_competitor")
def test_tournament_single_survivor(mock_dispatch):
    """Only 1 competitor succeeds, verify degraded flag without evaluation."""
    def fake_dispatch(agent, prompt, comp_id):
        if comp_id == "claude":
            return "Claude output"
        raise Exception(f"{comp_id} failed")

    mock_dispatch.side_effect = fake_dispatch

    config = _make_config()
    t = Tournament(config)
    result = t.run()

    assert result.winner == "claude"
    assert result.quality_flag == "degraded"
    assert result.scores == {}  # evaluation was skipped
