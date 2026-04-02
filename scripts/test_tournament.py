"""Tests for tournament.py — extracted tournament engine functions."""
import json
import random
import subprocess
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
    evaluate_test,
    evaluate_review,
    REVIEW_EVAL_CRITERIA,
    REVIEW_SCALE_MAP,
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
    entry = {"skill": "stark-team-review", "audience": "usage", "winner": "claude", "winner_score": 8.25}
    write_audit_entry(audit_path, entry)
    lines = audit_path.read_text().strip().split("\n")
    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["skill"] == "stark-team-review"
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


# ── Test evaluation strategy tests ─────────────────────────────────────


def test_evaluate_test_strategy(tmp_path):
    """Correct implementation scores higher than incorrect one."""
    # Create a test file that imports from impl and checks add()
    test_file = tmp_path / "test_impl.py"
    test_file.write_text(textwrap.dedent("""\
        from impl import add

        def test_add_positive():
            assert add(2, 3) == 5

        def test_add_negative():
            assert add(-1, 1) == 0

        def test_add_zero():
            assert add(0, 0) == 0
    """))

    outputs = {
        "correct": "def add(a, b):\n    return a + b\n",
        "wrong": "def add(a, b):\n    return a * b\n",
    }

    results = evaluate_test(outputs, str(test_file), tmp_path / "work")

    assert "correct" in results
    assert "wrong" in results
    assert results["correct"]["_pass_rate"] > results["wrong"]["_pass_rate"]
    assert results["correct"]["_pass_rate"] == 10.0  # 3/3 passed


def test_evaluate_test_timeout(tmp_path):
    """Infinite loop code times out and gets pass_rate=0."""
    test_file = tmp_path / "test_impl.py"
    test_file.write_text(textwrap.dedent("""\
        from impl import compute

        def test_compute():
            assert compute(1) == 1
    """))

    outputs = {
        "looper": "def compute(x):\n    while True:\n        pass\n",
    }

    results = evaluate_test(outputs, str(test_file), tmp_path / "work", timeout=3)

    assert "looper" in results
    assert results["looper"]["_pass_rate"] == 0.0
    assert "_error" in results["looper"]


@patch("tournament.evaluate_test")
@patch("tournament.dispatch_competitor")
def test_tournament_test_strategy(mock_dispatch, mock_eval_test):
    """Tournament.run() with strategy='test' uses evaluate_test."""
    def fake_dispatch(agent, prompt, comp_id):
        return f"def add(a, b): return a + b  # {comp_id}"

    mock_dispatch.side_effect = fake_dispatch

    mock_eval_test.return_value = {
        "claude": {"_pass_rate": 10.0},
        "codex": {"_pass_rate": 6.67},
    }

    config = TournamentConfig.from_dict({
        "prompt_template": "Write an add function",
        "competitors": [
            {"id": "claude", "agent": "claude"},
            {"id": "codex", "agent": "codex"},
        ],
        "evaluation": {
            "strategy": "test",
            "factors": {
                "correctness": {"weight": 1.0},
                "_test_file": {"path": "/tmp/test.py"},
                "_test_timeout": {"weight": 30},
            },
        },
        "output": {
            "output_dir": "/tmp/tournament-test",
        },
    })

    t = Tournament(config)
    result = t.run()

    assert result.winner == "claude"
    assert result.winner_score == 10.0
    assert result.quality_flag == "good"
    mock_eval_test.assert_called_once()


# ── CLI tests ──────────────────────────────────────────────────────────

TOURNAMENT_SCRIPT = str(Path(__file__).parent / "tournament.py")


def test_cli_help():
    """Run --help, verify exit 0 and key flags in output."""
    proc = subprocess.run(
        [sys.executable, TOURNAMENT_SCRIPT, "--help"],
        capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0
    for flag in ["--config", "--prompt", "--competitors", "--strategy",
                 "--factors", "--judge", "--output-dir", "--audit-file",
                 "--keep-all", "--dry-run", "--json", "--timeout",
                 "--workers", "--retries", "--variables", "--test-file"]:
        assert flag in proc.stdout, f"Missing flag {flag} in --help output"


def test_cli_dry_run():
    """Run --dry-run with inline args, verify exit 0 and config output."""
    proc = subprocess.run(
        [sys.executable, TOURNAMENT_SCRIPT,
         "--dry-run", "--prompt", "Write hello world",
         "--competitors", "claude,codex"],
        capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0
    config = json.loads(proc.stdout)
    assert config["prompt_template"] == "Write hello world"
    assert len(config["competitors"]) == 2
    assert config["competitors"][0]["id"] == "claude"
    assert config["competitors"][1]["id"] == "codex"
    assert config["evaluation"]["strategy"] == "semantic"


# ── Review evaluation tests ────────────────────────────────────────────


def test_evaluate_review_importable():
    """evaluate_review function exists and is importable."""
    from tournament import evaluate_review, REVIEW_EVAL_CRITERIA, REVIEW_SCALE_MAP
    assert callable(evaluate_review)
    assert "coverage" in REVIEW_EVAL_CRITERIA
    assert "good" in REVIEW_SCALE_MAP


def test_review_scale_map_values():
    """REVIEW_SCALE_MAP converts text scales to numeric correctly."""
    from tournament import REVIEW_SCALE_MAP
    assert REVIEW_SCALE_MAP["good"] > REVIEW_SCALE_MAP["acceptable"] > REVIEW_SCALE_MAP["poor"]
    # For false_positive_rate, low is good (high score)
    assert REVIEW_SCALE_MAP["low"] > REVIEW_SCALE_MAP["high"]
