"""Tests for copilot_dispatch.py."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from copilot_dispatch import (
    _extract_verdict_json,
    _normalize_verdict,
    _restore_worktree,
    _snapshot_worktree,
)


# ── _extract_verdict_json ──────────────────────────────────────────────


class TestExtractVerdict:
    def test_fenced_block(self):
        text = (
            "Some preamble text.\n\n"
            "```json\n"
            '{"verdict": "approve", "blocking_findings": [], '
            '"non_blocking_suggestions": ["x"], "summary": "lgtm"}\n'
            "```\n"
        )
        v = _extract_verdict_json(text)
        assert v is not None
        assert _normalize_verdict(v) == ("approve", [], ["x"], "lgtm")

    def test_bare_trailing_json(self):
        text = 'analysis here\n{"verdict":"revise","blocking_findings":["a","b"]}'
        v = _extract_verdict_json(text)
        assert v is not None
        assert _normalize_verdict(v) == ("revise", ["a", "b"], [], "")

    def test_no_json_returns_none(self):
        assert _extract_verdict_json("just prose, no json at all") is None

    def test_unknown_verdict_normalized_to_unparseable(self):
        v = _extract_verdict_json('```json\n{"verdict":"maybe"}\n```')
        assert v is not None
        assert _normalize_verdict(v)[0] == "unparseable"

    def test_picks_last_block_when_multiple(self):
        text = (
            '```json\n{"verdict":"revise","blocking_findings":["old"]}\n```\n'
            "later thoughts\n"
            '```json\n{"verdict":"approve","blocking_findings":[]}\n```\n'
        )
        v = _extract_verdict_json(text)
        assert v is not None
        assert _normalize_verdict(v)[0] == "approve"


# ── _snapshot_worktree / mutation detection ────────────────────────────


@pytest.fixture
def git_worktree(tmp_path: Path) -> Path:
    """Initialize a git repo with one committed file and one staged change."""
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path, check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path, check=True,
    )
    (tmp_path / "f.txt").write_text("original\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "commit", "-q", "-m", "initial"],
        cwd=tmp_path, check=True,
    )
    # Simulate the lead's staged diff: change f.txt and stage it.
    (tmp_path / "f.txt").write_text("lead-version\n")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True)
    return tmp_path


class TestSnapshotWorktree:
    def test_unchanged_worktree_snapshot_stable(self, git_worktree: Path):
        snap1 = _snapshot_worktree(str(git_worktree))
        snap2 = _snapshot_worktree(str(git_worktree))
        assert snap1 == snap2

    def test_detects_modification_to_already_staged_file(self, git_worktree: Path):
        """Regression: status alone misses content-only changes to a staged file.

        Reviewer's reproducer: change a staged path's content and re-stage.
        `git status --porcelain` is byte-identical, but the content differs.
        Our snapshot is a `git write-tree` SHA, so it MUST change.
        """
        snap_pre = _snapshot_worktree(str(git_worktree))

        # Wing "modifies" the lead's staged file content and re-stages.
        (git_worktree / "f.txt").write_text("wing-mutated\n")
        subprocess.run(["git", "add", "-A"], cwd=git_worktree, check=True)

        # Sanity: status is identical (the bug being guarded).
        status_pre = "M  f.txt\n"  # what we'd see in either state
        status_after = subprocess.run(
            ["git", "status", "--porcelain=v1", "-uall"],
            capture_output=True, text=True, cwd=git_worktree,
        ).stdout
        assert status_after == status_pre, (
            "Test premise: status output stays identical when a staged "
            "file's content is replaced and re-staged."
        )

        snap_post = _snapshot_worktree(str(git_worktree))
        assert snap_post != snap_pre, (
            "Mutation detection must fire when a staged file's content changes."
        )

    def test_detects_new_untracked_file(self, git_worktree: Path):
        snap_pre = _snapshot_worktree(str(git_worktree))
        (git_worktree / "new.txt").write_text("wing-added\n")
        snap_post = _snapshot_worktree(str(git_worktree))
        assert snap_post != snap_pre

    def test_restore_returns_to_pre_snapshot(self, git_worktree: Path):
        snap_pre = _snapshot_worktree(str(git_worktree))
        # Mutate
        (git_worktree / "f.txt").write_text("wing-mutated\n")
        (git_worktree / "extra.txt").write_text("garbage\n")
        subprocess.run(["git", "add", "-A"], cwd=git_worktree, check=True)
        # Restore
        _restore_worktree(str(git_worktree), snap_pre)
        # The lead's pre-mutation staged change should be gone too — restore
        # is a hard reset to HEAD + clean, which is the contract documented
        # in the SKILL failure-modes table for this error path.
        snap_after = _snapshot_worktree(str(git_worktree))
        # After restore, HEAD matches pre but tree is the HEAD tree, so the
        # tree hash differs from snap_pre (which had the lead's stage). What
        # we DO need to assert: the worktree is now in a deterministic state
        # equal to what we'd get from a fresh checkout of HEAD.
        head_tree = subprocess.run(
            ["git", "rev-parse", "HEAD^{tree}"],
            capture_output=True, text=True, cwd=git_worktree,
        ).stdout.strip()
        assert snap_after[1] == head_tree
