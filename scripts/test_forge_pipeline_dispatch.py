"""Tests for forge_orchestrator._run_pipeline real dispatch + phase helpers.

These tests mock individual phase functions (forge_classifier, forge_review,
forge_plan, forge_tasks) so they can exercise orchestrator-level routing,
state persistence, halt propagation, and exception handling without booting
the real agent stack.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from forge_orchestrator import (
    ForgeProgress,
    _dispatch_phase,
    _run_pipeline,
    _spec_path_in_worktree,
    _write_phase_state,
    init_state,
    write_state_atomic,
)


# ── _spec_path_in_worktree ───────────────────────────────────────────────


class TestSpecPathInWorktree:
    def test_prefers_worktree_copy_when_exists(self, tmp_path):
        worktree = tmp_path / "wt"
        worktree.mkdir()
        (worktree / "spec.md").write_text("# wt copy")
        original = tmp_path / "spec.md"
        original.write_text("# original")
        state = {"spec_path": str(original)}
        resolved = _spec_path_in_worktree(worktree, state)
        assert resolved == worktree / "spec.md"

    def test_falls_back_to_original_when_worktree_missing(self, tmp_path):
        worktree = tmp_path / "wt"
        worktree.mkdir()
        original = tmp_path / "spec.md"
        original.write_text("# original")
        state = {"spec_path": str(original)}
        resolved = _spec_path_in_worktree(worktree, state)
        assert resolved == original

    def test_handles_missing_spec_path_key(self, tmp_path):
        worktree = tmp_path / "wt"
        worktree.mkdir()
        # Should not raise — returns Path('') which is harmless
        resolved = _spec_path_in_worktree(worktree, {})
        assert resolved == Path("")


# ── _write_phase_state ───────────────────────────────────────────────────


class TestWritePhaseState:
    def test_updates_status_and_persists(self, tmp_path):
        state = init_state(tmp_path / "spec.md", "abc")
        state_path = tmp_path / ".forge-state.json"
        _write_phase_state(
            state, state_path, "classify", "completed", backup_dir=None,
        )
        assert state_path.exists()
        loaded = json.loads(state_path.read_text())
        assert loaded["phases"]["classify"]["status"] == "completed"
        assert "updated_at" in loaded

    def test_merges_extra_fields(self, tmp_path):
        state = init_state(tmp_path / "spec.md", "abc")
        state_path = tmp_path / ".forge-state.json"
        _write_phase_state(
            state, state_path, "classify", "completed",
            backup_dir=None,
            extra={"domains": ["security", "api-design"], "tier_used": 1},
        )
        loaded = json.loads(state_path.read_text())
        assert loaded["phases"]["classify"]["domains"] == ["security", "api-design"]
        assert loaded["phases"]["classify"]["tier_used"] == 1

    def test_writes_backup_when_requested(self, tmp_path):
        state = init_state(tmp_path / "spec.md", "abc")
        state_path = tmp_path / ".forge-state.json"
        backup_dir = tmp_path / "backup"
        _write_phase_state(
            state, state_path, "classify", "starting", backup_dir=backup_dir,
        )
        assert (backup_dir / "state-backup.json").exists()


# ── _dispatch_phase routing ──────────────────────────────────────────────


def _make_state(tmp_path: Path) -> dict:
    state = init_state(tmp_path / "spec.md", "abc")
    state["spec_path"] = str(tmp_path / "spec.md")
    return state


class TestDispatchPhaseRouting:
    def test_classify_calls_classifier(self, tmp_path):
        from forge_classifier import ClassificationResult

        spec = tmp_path / "spec.md"
        spec.write_text("# Spec\nbackend service")
        state = _make_state(tmp_path)
        fake = ClassificationResult(
            domains=["security"], skipped_domains=["accessibility"],
            design_type="backend", tier_used=1, confidence=0.9,
        )
        with patch("forge_classifier.classify_spec", return_value=fake):
            status, extra = _dispatch_phase(
                "classify",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=False,
            )
        assert status == "completed"
        assert extra["domains"] == ["security"]
        assert extra["design_type"] == "backend"
        assert extra["tier_used"] == 1

    def test_design_review_dry_run_skips(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        # Should NOT call into forge_review when dry-running
        with patch("forge_review.run_design_review") as mock_run:
            status, extra = _dispatch_phase(
                "design_review",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=True,
            )
        assert status == "skipped"
        assert "reason" in extra
        mock_run.assert_not_called()

    def test_design_review_propagates_halt(self, tmp_path):
        from forge_review import PhaseResult as ReviewPhaseResult

        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        halted = ReviewPhaseResult(
            status="halted", findings_fixed=2, noise=5, commit_shas=["abc"],
        )
        with patch("forge_review.run_design_review", return_value=halted):
            status, extra = _dispatch_phase(
                "design_review",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=False,
            )
        assert status == "halted"
        assert extra["findings_fixed"] == 2
        assert extra["commit_shas"] == ["abc"]
        assert "reason" in extra

    def test_plan_passes_plan_path_into_state(self, tmp_path):
        from forge_plan import PhaseResult as PlanPhaseResult

        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        plan_path = tmp_path / "spec-plan.md"
        plan_path.write_text("# Plan")
        completed = PlanPhaseResult(
            status="completed", commit_shas=["xyz"], plan_path=plan_path,
        )
        with patch("forge_plan.run_plan_phase", return_value=completed):
            status, extra = _dispatch_phase(
                "plan",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=False,
            )
        assert status == "completed"
        assert extra["plan_path"] == str(plan_path)
        assert extra["commit_shas"] == ["xyz"]

    def test_plan_review_halts_when_no_plan_path(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        # plan phase never set plan_path
        status, extra = _dispatch_phase(
            "plan_review",
            spec_path=spec,
            worktree_path=tmp_path,
            state=state,
            cfg={},
            dry_run=False,
        )
        assert status == "halted"
        assert "plan_path" in extra["reason"]

    def test_plan_review_halts_when_plan_missing(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        state["phases"]["plan"]["plan_path"] = str(tmp_path / "missing-plan.md")
        status, extra = _dispatch_phase(
            "plan_review",
            spec_path=spec,
            worktree_path=tmp_path,
            state=state,
            cfg={},
            dry_run=False,
        )
        assert status == "halted"
        assert "missing" in extra["reason"]

    def test_plan_review_dispatches_when_plan_present(self, tmp_path):
        from forge_plan import PhaseResult as PlanPhaseResult

        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        plan = tmp_path / "spec-plan.md"
        plan.write_text("# Plan")
        state = _make_state(tmp_path)
        state["phases"]["plan"]["plan_path"] = str(plan)
        completed = PlanPhaseResult(
            status="completed",
            findings_fixed=3,
            noise=1,
            commit_shas=["q"],
            plan_hash="deadbeef",
        )
        with patch("forge_plan.run_plan_review", return_value=completed):
            status, extra = _dispatch_phase(
                "plan_review",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=False,
            )
        assert status == "completed"
        assert extra["plan_hash"] == "deadbeef"
        assert extra["findings_fixed"] == 3

    def test_tdd_completes_immediately(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        status, extra = _dispatch_phase(
            "tdd",
            spec_path=spec,
            worktree_path=tmp_path,
            state=state,
            cfg={},
            dry_run=False,
        )
        assert status == "completed"
        assert extra["skipped"] is True

    def test_tasks_halts_when_no_plan_path(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        status, extra = _dispatch_phase(
            "tasks",
            spec_path=spec,
            worktree_path=tmp_path,
            state=state,
            cfg={},
            dry_run=False,
        )
        assert status == "halted"
        assert "plan_path" in extra["reason"]

    def test_tasks_dispatches_to_run_tasks_phase(self, tmp_path):
        from forge_plan import PhaseResult as PlanPhaseResult

        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        plan = tmp_path / "spec-plan.md"
        plan.write_text("# Plan")
        state = _make_state(tmp_path)
        state["phases"]["plan"]["plan_path"] = str(plan)
        completed = PlanPhaseResult(status="completed")
        with patch("forge_tasks.run_tasks_phase", return_value=completed):
            status, _ = _dispatch_phase(
                "tasks",
                spec_path=spec,
                worktree_path=tmp_path,
                state=state,
                cfg={},
                dry_run=False,
            )
        assert status == "completed"

    def test_unknown_phase_returns_error(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = _make_state(tmp_path)
        status, extra = _dispatch_phase(
            "bogus",
            spec_path=spec,
            worktree_path=tmp_path,
            state=state,
            cfg={},
            dry_run=False,
        )
        assert status == "error"
        assert "bogus" in extra["reason"]


# ── _run_pipeline integration ────────────────────────────────────────────


class TestRunPipeline:
    def test_all_completed_returns_zero(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)
        with patch(
            "forge_orchestrator._dispatch_phase",
            return_value=("completed", {}),
        ):
            code = _run_pipeline(tmp_path, state, state_path, progress)
        assert code == 0
        loaded = json.loads(state_path.read_text())
        for phase in ("classify", "design_review", "plan", "plan_review", "tdd", "tasks"):
            assert loaded["phases"][phase]["status"] == "completed"

    def test_halt_in_phase_returns_one(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)

        results = {
            "classify": ("completed", {}),
            "design_review": ("halted", {"reason": "findings remain"}),
        }

        def fake_dispatch(phase, **_kwargs):
            return results[phase]

        with patch(
            "forge_orchestrator._dispatch_phase", side_effect=fake_dispatch,
        ):
            code = _run_pipeline(tmp_path, state, state_path, progress)
        assert code == 1
        loaded = json.loads(state_path.read_text())
        assert loaded["phases"]["classify"]["status"] == "completed"
        assert loaded["phases"]["design_review"]["status"] == "halted"
        # Subsequent phases never ran
        assert loaded["phases"]["plan"]["status"] == "pending"

    def test_exception_in_phase_returns_two(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)

        def fake_dispatch(phase, **_kwargs):
            if phase == "classify":
                return ("completed", {})
            raise RuntimeError("boom")

        with patch(
            "forge_orchestrator._dispatch_phase", side_effect=fake_dispatch,
        ):
            code = _run_pipeline(tmp_path, state, state_path, progress)
        assert code == 2
        loaded = json.loads(state_path.read_text())
        assert loaded["phases"]["design_review"]["status"] == "error"
        assert "boom" in loaded["phases"]["design_review"]["error"]

    def test_dry_run_stops_after_design_review(self, tmp_path):
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)

        called: list[str] = []

        def fake_dispatch(phase, **_kwargs):
            called.append(phase)
            return ("completed", {})

        with patch(
            "forge_orchestrator._dispatch_phase", side_effect=fake_dispatch,
        ):
            code = _run_pipeline(
                tmp_path, state, state_path, progress, dry_run=True,
            )
        assert code == 0
        # Only classify and design_review should have been dispatched
        assert called == ["classify", "design_review"]

    def test_starting_phase_is_resumed_completed_skipped(self, tmp_path):
        """Resume: classify=completed, design_review=starting → only the
        latter (and downstream) should get redispatched."""
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state["phases"]["classify"]["status"] = "completed"
        state["phases"]["design_review"]["status"] = "starting"
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)

        called: list[str] = []

        def fake_dispatch(phase, **_kwargs):
            called.append(phase)
            return ("completed", {})

        with patch(
            "forge_orchestrator._dispatch_phase", side_effect=fake_dispatch,
        ):
            _run_pipeline(tmp_path, state, state_path, progress)
        assert "classify" not in called
        assert called[0] == "design_review"

    def test_phase_marked_starting_before_dispatch(self, tmp_path):
        """During dispatch the phase status should be 'starting' on disk
        so a crash mid-phase is recoverable."""
        spec = tmp_path / "spec.md"
        spec.write_text("# Spec")
        state = init_state(spec, "abc")
        state_path = tmp_path / ".forge-state.json"
        write_state_atomic(state_path, state)
        progress = ForgeProgress(is_tty=False)

        observed: list[str] = []

        def fake_dispatch(phase, **kwargs):
            # Read state from disk during dispatch to confirm "starting"
            disk = json.loads(state_path.read_text())
            observed.append(disk["phases"][phase]["status"])
            return ("completed", {})

        with patch(
            "forge_orchestrator._dispatch_phase", side_effect=fake_dispatch,
        ):
            _run_pipeline(tmp_path, state, state_path, progress)
        assert all(s == "starting" for s in observed)
