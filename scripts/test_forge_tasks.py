"""Tests for forge_tasks.py — task decomposition and GitHub issue creation."""
from __future__ import annotations

import json
import subprocess
from unittest.mock import MagicMock, patch

import pytest

from forge_tasks import (  # pyright: ignore[reportMissingImports]
    Task,
    _build_decomposer_prompt,
    _create_issue,
    _extract_json_object,
    _extract_tasks,
    _format_validation_feedback,
    _search_existing_issue,
    _validation_passed,
    create_issues,
    run_tasks_phase,
)


# ── Fixtures ───────────────────────────────────────────────────────────────


@pytest.fixture
def plan_file(tmp_path):
    p = tmp_path / "my-spec-plan.md"
    p.write_text("# Plan\n\nPhase 1: Set up.\nPhase 2: Build.\n")
    return p


@pytest.fixture
def minimal_state():
    return {
        "phases": {
            "plan": {"status": "completed", "plan_hash": "abc123"},
            "tasks": {"status": "pending"},
        },
        "updated_at": "2026-01-01T00:00:00+00:00",
    }


@pytest.fixture
def minimal_cfg():
    return {"timeout": 60}


@pytest.fixture
def sample_breakdown():
    return {
        "phases": [
            {
                "phase_id": "P1",
                "name": "Setup",
                "tasks": [
                    {
                        "task_id": "P1.1",
                        "title": "Initialize repository",
                        "body": "Create git repo and install dependencies.",
                        "labels": ["forge", "phase-1"],
                    },
                    {
                        "task_id": "P1.2",
                        "title": "Add CI pipeline",
                        "body": "Set up GitHub Actions workflow.",
                        "labels": ["forge", "phase-1"],
                    },
                ],
            },
            {
                "phase_id": "P2",
                "name": "Implementation",
                "tasks": [
                    {
                        "task_id": "P2.1",
                        "title": "Implement core module",
                        "body": "Write the main logic.",
                        "labels": ["forge", "phase-2"],
                    },
                ],
            },
        ]
    }


# ── _extract_tasks ─────────────────────────────────────────────────────────


class TestExtractTasks:
    def test_extracts_all_tasks(self, sample_breakdown):
        tasks = _extract_tasks(sample_breakdown)
        assert len(tasks) == 3

    def test_task_fields_correct(self, sample_breakdown):
        tasks = _extract_tasks(sample_breakdown)
        p1_tasks = [t for t in tasks if t.phase_id == "P1"]
        assert len(p1_tasks) == 2
        titles = {t.title for t in p1_tasks}
        assert "Initialize repository" in titles
        assert "Add CI pipeline" in titles

    def test_empty_phases(self):
        assert _extract_tasks({"phases": []}) == []

    def test_missing_phases_key(self):
        assert _extract_tasks({}) == []

    def test_task_labels_preserved(self, sample_breakdown):
        tasks = _extract_tasks(sample_breakdown)
        assert tasks[0].labels == ["forge", "phase-1"]


# ── _validation_passed ─────────────────────────────────────────────────────


class TestValidationPassed:
    def test_empty_results_is_passed(self):
        assert _validation_passed([]) is True

    def test_all_approved(self):
        r1 = MagicMock(approved=True)
        r2 = MagicMock(approved=True)
        assert _validation_passed([r1, r2]) is True

    def test_one_rejected(self):
        r1 = MagicMock(approved=True)
        r2 = MagicMock(approved=False)
        assert _validation_passed([r1, r2]) is False

    def test_all_rejected(self):
        r1 = MagicMock(approved=False)
        assert _validation_passed([r1]) is False


# ── run_tasks_phase ────────────────────────────────────────────────────────


class TestRunTasksPhase:
    def test_successful_decomposition_and_validation(
        self, plan_file, minimal_state, minimal_cfg, tmp_path, sample_breakdown
    ):
        """Happy path: decomposition succeeds, validation passes."""
        mock_validator = MagicMock(approved=True, issues=[])

        with (
            patch("forge_tasks._decompose_plan", return_value=sample_breakdown),
            patch("forge_tasks._validate_breakdown", return_value=[mock_validator]),
        ):
            result = run_tasks_phase(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "completed"
        assert minimal_state["phases"]["tasks"]["task_count"] == 3

    def test_retry_on_validation_failure(
        self, plan_file, minimal_state, minimal_cfg, tmp_path, sample_breakdown
    ):
        """Validation failure triggers retry; second attempt passes."""
        fail_validator = MagicMock(approved=False, issues=[MagicMock()])
        pass_validator = MagicMock(approved=True, issues=[])
        decompose_calls = [0]

        def decompose_side_effect(_plan_text, _cfg, prior_issues=None):
            decompose_calls[0] += 1
            return sample_breakdown

        validation_results = [
            [fail_validator],  # First attempt: fail
            [pass_validator],  # Second attempt: pass
        ]
        validation_iter = iter(validation_results)

        with (
            patch("forge_tasks._decompose_plan", side_effect=decompose_side_effect),
            patch("forge_tasks._validate_breakdown", side_effect=lambda *_a, **_k: next(validation_iter)),
            patch("forge_tasks.time.sleep"),  # Skip backoff
        ):
            result = run_tasks_phase(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "completed"
        assert decompose_calls[0] == 2  # Two decomposition attempts

    def test_halts_after_all_retries_fail(
        self, plan_file, minimal_state, minimal_cfg, tmp_path
    ):
        """All 3 attempts fail -> halted."""
        fail_validator = MagicMock(approved=False, issues=[MagicMock()])

        with (
            patch("forge_tasks._decompose_plan", return_value={"phases": []}),
            patch("forge_tasks._validate_breakdown", return_value=[fail_validator]),
            patch("forge_tasks.time.sleep"),
        ):
            result = run_tasks_phase(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "halted"

    def test_halts_when_decomposition_always_fails(
        self, plan_file, minimal_state, minimal_cfg, tmp_path
    ):
        """Empty decomposition result after all retries -> halted."""
        with (
            patch("forge_tasks._decompose_plan", return_value={}),
            patch("forge_tasks.time.sleep"),
        ):
            result = run_tasks_phase(plan_file, minimal_state, minimal_cfg, tmp_path)

        assert result.status == "halted"


# ── create_issues ──────────────────────────────────────────────────────────


class TestCreateIssues:
    def _make_tasks(self, count: int = 2) -> list[Task]:
        return [
            Task(
                phase_id="P1",
                task_id=f"P1.{i}",
                title=f"Task {i}",
                body=f"Body for task {i}.",
                labels=["forge"],
            )
            for i in range(1, count + 1)
        ]

    def test_dry_run_no_subprocess_calls(self, minimal_state, minimal_cfg):
        """In dry_run mode, no subprocess calls are made."""
        tasks = self._make_tasks()

        with patch("forge_tasks._run_subprocess") as mock_run:
            numbers = create_issues(tasks, minimal_state, minimal_cfg, dry_run=True)

        mock_run.assert_not_called()
        assert numbers == []

    def test_skips_existing_issue(self, minimal_state, minimal_cfg):
        """When an existing issue is found, it's recorded without creation."""
        tasks = self._make_tasks(1)

        with (
            patch("forge_tasks._search_existing_issue", return_value=42),
            patch("forge_tasks._create_issue") as mock_create,
        ):
            numbers = create_issues(tasks, minimal_state, minimal_cfg)

        mock_create.assert_not_called()
        assert numbers == [42]
        assert minimal_state["phases"]["tasks"]["issue_numbers"]["P1.1"] == 42

    def test_creates_new_issue_when_not_found(self, minimal_state, minimal_cfg):
        """When no existing issue is found, a new one is created."""
        tasks = self._make_tasks(1)

        with (
            patch("forge_tasks._search_existing_issue", return_value=None),
            patch("forge_tasks._create_issue", return_value=99),
        ):
            numbers = create_issues(tasks, minimal_state, minimal_cfg)

        assert numbers == [99]
        assert minimal_state["phases"]["tasks"]["issue_numbers"]["P1.1"] == 99

    def test_records_issue_numbers_in_state(self, minimal_state, minimal_cfg):
        """Issue numbers for all tasks are recorded in state."""
        tasks = self._make_tasks(3)

        with (
            patch("forge_tasks._search_existing_issue", return_value=None),
            patch("forge_tasks._create_issue", side_effect=[10, 11, 12]),
        ):
            numbers = create_issues(tasks, minimal_state, minimal_cfg)

        assert numbers == [10, 11, 12]
        issue_map = minimal_state["phases"]["tasks"]["issue_numbers"]
        assert issue_map["P1.1"] == 10
        assert issue_map["P1.2"] == 11
        assert issue_map["P1.3"] == 12

    def test_mixed_existing_and_new_issues(self, minimal_state, minimal_cfg):
        """Mix of existing and new issues handled correctly."""
        tasks = self._make_tasks(2)

        def mock_search(title, **_kwargs):
            return 5 if "Task 1" in title else None

        with (
            patch("forge_tasks._search_existing_issue", side_effect=mock_search),
            patch("forge_tasks._create_issue", return_value=50),
        ):
            numbers = create_issues(tasks, minimal_state, minimal_cfg)

        assert numbers == [5, 50]


# ── _search_existing_issue ─────────────────────────────────────────────────


class TestSearchExistingIssue:
    def _make_completed_process(self, stdout: str, returncode: int = 0):
        proc = MagicMock(spec=subprocess.CompletedProcess)
        proc.returncode = returncode
        proc.stdout = stdout
        proc.stderr = ""
        return proc

    def test_returns_issue_number_when_found(self):
        issues_json = json.dumps([{"number": 42, "title": "Initialize repository"}])
        mock_proc = self._make_completed_process(issues_json)

        with patch("forge_tasks._run_subprocess", return_value=mock_proc):
            result = _search_existing_issue("Initialize repository")

        assert result == 42

    def test_returns_none_when_not_found(self):
        issues_json = json.dumps([{"number": 1, "title": "Totally different issue"}])
        mock_proc = self._make_completed_process(issues_json)

        with patch("forge_tasks._run_subprocess", return_value=mock_proc):
            result = _search_existing_issue("Initialize repository with very long title")

        # Title prefix matching: "Initialize reposito" (40 chars) vs "Totally different"
        # They don't match, so None should be returned
        assert result is None

    def test_returns_none_on_gh_failure(self):
        mock_proc = self._make_completed_process("", returncode=1)

        with (
            patch("forge_tasks._run_subprocess", return_value=mock_proc),
            patch("forge_tasks.time.sleep"),
        ):
            result = _search_existing_issue("Some title")

        assert result is None

    def test_returns_none_on_empty_response(self):
        mock_proc = self._make_completed_process("[]")

        with patch("forge_tasks._run_subprocess", return_value=mock_proc):
            result = _search_existing_issue("Some title")

        assert result is None


# ── _create_issue ──────────────────────────────────────────────────────────


class TestCreateIssue:
    def _make_proc(self, stdout: str = "", returncode: int = 0):
        proc = MagicMock(spec=subprocess.CompletedProcess)
        proc.returncode = returncode
        proc.stdout = stdout
        proc.stderr = ""
        return proc

    def test_returns_issue_number_from_url(self):
        task = Task(
            phase_id="P1", task_id="P1.1",
            title="My task", body="Body", labels=["forge"]
        )
        url = "https://github.com/GetEvinced/my-repo/issues/77"
        mock_proc = self._make_proc(stdout=url)

        with patch("forge_tasks._run_subprocess", return_value=mock_proc):
            result = _create_issue(task)

        assert result == 77

    def test_returns_none_on_failure(self):
        task = Task(
            phase_id="P1", task_id="P1.1",
            title="My task", body="Body", labels=["forge"]
        )
        mock_proc = self._make_proc(returncode=1)

        with (
            patch("forge_tasks._run_subprocess", return_value=mock_proc),
            patch("forge_tasks.time.sleep"),
        ):
            result = _create_issue(task)

        assert result is None

    def test_gh_token_excluded_from_env(self):
        """GH_TOKEN must not be in the subprocess environment."""
        import os  # noqa: PLC0415
        task = Task(
            phase_id="P1", task_id="P1.1",
            title="My task", body="Body", labels=["forge"]
        )
        url = "https://github.com/GetEvinced/repo/issues/10"
        captured_env = {}

        def capture_run(_cmd, **kwargs):
            captured_env.update(kwargs.get("env", {}))
            proc = MagicMock(spec=subprocess.CompletedProcess)
            proc.returncode = 0
            proc.stdout = url
            proc.stderr = ""
            return proc

        with (
            patch.dict(os.environ, {"GH_TOKEN": "secret-token"}),
            patch("forge_tasks._run_subprocess", side_effect=capture_run),
        ):
            _create_issue(task)

        assert "GH_TOKEN" not in captured_env


# ═══════════════════════════════════════════════════════════════════════════
# Decomposer fragility fixes — JSON extraction + retry feedback
# ═══════════════════════════════════════════════════════════════════════════


class TestExtractJsonObject:
    """The brace-balanced extractor must survive realistic LLM output."""

    def test_clean_object(self):
        assert _extract_json_object('{"a": 1}') == {"a": 1}

    def test_object_with_leading_chatter(self):
        raw = "Sure, here is the breakdown:\n\n{\"phases\": []}"
        assert _extract_json_object(raw) == {"phases": []}

    def test_object_with_trailing_chatter(self):
        raw = '{"phases": []}\n\nLet me know if you need anything else!'
        assert _extract_json_object(raw) == {"phases": []}

    def test_object_with_fenced_code_block(self):
        raw = '```json\n{"phases": [{"phase_id": "P1"}]}\n```'
        assert _extract_json_object(raw) == {"phases": [{"phase_id": "P1"}]}

    def test_object_with_nested_braces_in_strings(self):
        # A string value containing literal braces must not confuse the scanner
        raw = '{"body": "Use {x} as the placeholder"}'
        assert _extract_json_object(raw) == {"body": "Use {x} as the placeholder"}

    def test_object_with_escaped_quotes_in_string(self):
        raw = r'{"body": "She said \"hi\""}'
        assert _extract_json_object(raw) == {"body": 'She said "hi"'}

    def test_returns_none_on_no_object(self):
        assert _extract_json_object("just prose, no JSON at all") is None

    def test_returns_none_on_unterminated_object(self):
        assert _extract_json_object('{"phases": [') is None

    def test_skips_invalid_then_finds_valid(self):
        # First "{" starts an invalid object; scanner should keep looking
        raw = 'note: { broken } and then {"phases": []}'
        result = _extract_json_object(raw)
        assert result == {"phases": []}

    def test_picks_largest_top_level_object(self):
        # Realistic: the LLM emits the breakdown wrapped in a parent object
        raw = '{"phases": [{"phase_id": "P1", "tasks": []}]}'
        assert _extract_json_object(raw) == {
            "phases": [{"phase_id": "P1", "tasks": []}]
        }


class TestFormatValidationFeedback:
    def test_empty_returns_empty_string(self):
        assert _format_validation_feedback([]) == ""

    def test_renders_issue_fields(self):
        issue = MagicMock(
            phase_id="P1",
            task_id="P1.1",
            field="acceptance",
            problem="Too many criteria (7 > 5)",
            suggestion="Split into two tasks",
        )
        result = _format_validation_feedback([issue])
        assert "P1/P1.1" in result
        assert "acceptance" in result
        assert "Too many criteria" in result
        assert "Split into two tasks" in result

    def test_caps_at_30_issues(self):
        issues = [
            MagicMock(
                phase_id=f"P{i}", task_id=f"P{i}.1",
                field="x", problem=f"problem {i}", suggestion="",
            )
            for i in range(50)
        ]
        result = _format_validation_feedback(issues)
        # Issue 30+ should be omitted
        assert "problem 0" in result
        assert "problem 29" in result
        assert "problem 30" not in result


class TestBuildDecomposerPrompt:
    def test_includes_guardrails(self):
        prompt = _build_decomposer_prompt("# plan body", prior_issues=None)
        assert "≤5 acceptance criteria" in prompt
        assert "self-contained" in prompt
        assert "# Plan" in prompt
        # No retry-feedback header on a fresh attempt
        assert "Previous attempt" not in prompt

    def test_includes_feedback_header_on_retry(self):
        issue = MagicMock(
            phase_id="P1", task_id="P1.1",
            field="size", problem="too big", suggestion="split",
        )
        prompt = _build_decomposer_prompt("# plan body", prior_issues=[issue])
        assert "Previous attempt" in prompt
        assert "P1/P1.1" in prompt
        assert "too big" in prompt


class TestRetryFeedbackLoop:
    """Validator issues from attempt N must reach attempt N+1's prompt."""

    def test_prior_issues_threaded_through_retry(
        self, plan_file, minimal_state, minimal_cfg, tmp_path
    ):
        """On validation failure, the next _decompose_plan call should
        receive prior_issues populated with the failing validator's issues."""
        sample_breakdown = {"phases": [{"phase_id": "P1", "tasks": []}]}
        # Two attempts: first fails validation, second passes
        first_issue = MagicMock(
            phase_id="P1", task_id="P1.1",
            field="size", problem="task too big", suggestion="split",
        )
        fail_validator = MagicMock(approved=False, issues=[first_issue])
        pass_validator = MagicMock(approved=True, issues=[])
        validation_iter = iter([[fail_validator], [pass_validator]])

        decompose_calls: list[list] = []

        def fake_decompose(_plan_text, _cfg, prior_issues=None):
            decompose_calls.append(list(prior_issues or []))
            return sample_breakdown

        with (
            patch("forge_tasks._decompose_plan", side_effect=fake_decompose),
            patch(
                "forge_tasks._validate_breakdown",
                side_effect=lambda *_a, **_k: next(validation_iter),
            ),
            patch("forge_tasks.time.sleep"),
        ):
            result = run_tasks_phase(
                plan_file, minimal_state, minimal_cfg, tmp_path
            )

        assert result.status == "completed"
        assert len(decompose_calls) == 2
        # First attempt has no feedback; second attempt has the failing issue
        assert decompose_calls[0] == []
        assert decompose_calls[1] == [first_issue]

