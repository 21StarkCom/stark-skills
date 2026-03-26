"""Tests for tournament.py — extracted tournament engine functions."""
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tournament import (
    compute_weighted_average,
    select_winner,
    parse_scores,
    write_audit_entry,
    unescape_json_string,
    FACTOR_WEIGHTS,
)


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
