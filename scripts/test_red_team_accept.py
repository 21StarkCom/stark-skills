"""Tests for the ``red_team_accept`` CLI safety paths (PR-#430 round-3 fix #22).

The accept CLI is the operator's halt-acknowledgement entry point, so the
pre-persistence guards — non-TTY refusal without ``--no-confirm`` and the
``ValueError`` raised by :func:`compute_accept_key` for unresolved repos —
need explicit coverage. Without it, the next regression that loosens
either guard could re-introduce the silent halt-suppression behavior PR
review fixes #21 / #22 specifically tightened.
"""

from __future__ import annotations

import io
import sys

import red_team_accept


def _meta(repo: str = "evinced/stark-skills") -> dict:
    return {
        "stable_key": "run1:design:1:data:rt3:abc",
        "run_id": "run1",
        "stage": "design",
        "round_num": 1,
        "persona": "data",
        "finding_id": "rt3",
        "concern_hash": "abc",
        "severity": "high",
        "counter_proposal": "REQUEST_HUMAN_REVIEW",
        "concern_excerpt": "Schema migration may break readers",
        "repo": repo,
    }


def test_accept_one_refuses_non_tty_without_no_confirm(monkeypatch, capsys):
    """confirm=True + no TTY now errors instead of silently accepting.

    The earlier code only prompted when ``sys.stdin.isatty()`` returned True
    and otherwise fell through to ``accept_finding``, so cron / piped
    invocations could acknowledge halts by default. The fix surfaces a
    distinct exit code (2) and instructs the caller to opt in explicitly.
    """
    monkeypatch.setattr(
        "red_team_human_review.lookup_finding_metadata", lambda key, **kw: _meta()
    )
    accept_calls: list[tuple] = []
    monkeypatch.setattr(
        "red_team_human_review.accept_finding",
        lambda *args, **kwargs: accept_calls.append((args, kwargs)),
    )
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)

    rc = red_team_accept.accept_one(
        "run1:design:1:data:rt3:abc",
        note=None,
        accepted_by=None,
        confirm=True,
        out=io.StringIO(),
    )

    assert rc == 2
    assert accept_calls == []
    err = capsys.readouterr().err
    assert "stdin is not a TTY" in err
    assert "--no-confirm" in err


def test_accept_one_no_confirm_skips_prompt_even_without_tty(monkeypatch):
    """``confirm=False`` is the explicit non-interactive opt-in."""
    monkeypatch.setattr(
        "red_team_human_review.lookup_finding_metadata", lambda key, **kw: _meta()
    )
    accept_calls: list[dict] = []

    def fake_accept(stable_key, **kwargs):
        accept_calls.append({"stable_key": stable_key, **kwargs})

    monkeypatch.setattr("red_team_human_review.accept_finding", fake_accept)
    monkeypatch.setattr(sys.stdin, "isatty", lambda: False)

    rc = red_team_accept.accept_one(
        "run1:design:1:data:rt3:abc",
        note=None,
        accepted_by=None,
        confirm=False,
        out=io.StringIO(),
    )

    assert rc == 0
    assert len(accept_calls) == 1
    assert accept_calls[0]["repo"] == "evinced/stark-skills"


def test_accept_one_surfaces_unresolved_repo_value_error(monkeypatch, capsys):
    """compute_accept_key raises for unresolved repos; the CLI reports it."""
    monkeypatch.setattr(
        "red_team_human_review.lookup_finding_metadata",
        lambda key, **kw: _meta(repo="unknown"),
    )

    def raising_accept(*args, **kwargs):
        raise ValueError("compute_accept_key requires a resolved repository")

    monkeypatch.setattr("red_team_human_review.accept_finding", raising_accept)

    rc = red_team_accept.accept_one(
        "run1:design:1:data:rt3:abc",
        note=None,
        accepted_by=None,
        confirm=False,
        out=io.StringIO(),
    )

    assert rc == 2
    err = capsys.readouterr().err
    assert "resolved repository" in err
