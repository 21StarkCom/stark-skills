#!/usr/bin/env python3
"""End-to-end integration tests for github_projects.py.

These tests hit the real GitHub API. They are skipped unless RUN_INTEGRATION=1.
Requires: GITHUB_APP_PRIVATE_KEY in macOS Keychain (stark-claude app).

Usage:
    RUN_INTEGRATION=1 scripts/.venv/bin/python3 -m pytest scripts/test_github_projects_e2e.py -v
"""

import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(__file__))

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_INTEGRATION") != "1",
    reason="Integration tests skipped (set RUN_INTEGRATION=1 to run)",
)

# Test constants — use the real AI-DD Tracker project
PROJECT_NAME = "AI-DD Tracker"
ORG = "GetEvinced"
REPO = "stark-skills"


# ── Helpers ──────────────────────────────────────────────────────────────

def _gh_env() -> dict[str, str]:
    """Return env dict with GH_TOKEN removed so gh uses user's PAT."""
    return {k: v for k, v in os.environ.items() if k != "GH_TOKEN"}


def _gh_api(endpoint: str, method: str = "GET", **fields: str) -> dict:
    """Call gh api and return parsed JSON."""
    cmd = ["gh", "api", endpoint, "--method", method]
    for key, val in fields.items():
        cmd.extend(["--field", f"{key}={val}"])
    result = subprocess.run(cmd, capture_output=True, text=True, env=_gh_env())
    if result.returncode != 0:
        raise RuntimeError(f"gh api failed: {result.stderr}")
    return json.loads(result.stdout)


# ── Fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def project():
    """Find the AI-DD Tracker project once for all tests."""
    import github_app
    import github_projects

    github_app.select_app("stark-claude")
    return github_projects.find_project(ORG, PROJECT_NAME)


@pytest.fixture
def test_issue(project):
    """Create a temporary test issue and clean up after.

    Yields a dict with keys: number, node_id, title.
    On teardown: removes from project (if added) and closes the issue.
    """
    import github_app
    import github_projects

    github_app.select_app("stark-claude")

    # Create issue via gh CLI (user's PAT)
    issue_data = _gh_api(
        f"/repos/{ORG}/{REPO}/issues",
        method="POST",
        title="E2E test issue (auto-delete)",
        body="Created by test_github_projects_e2e.py. Safe to delete.",
    )

    info = {
        "number": issue_data["number"],
        "node_id": issue_data["node_id"],
        "title": issue_data["title"],
    }

    yield info

    # Cleanup: remove from project if present
    item_id = github_projects.find_item_for_issue(
        ORG, REPO, info["number"], project["id"]
    )
    if item_id:
        try:
            github_app.graphql(
                """mutation($projectId: ID!, $itemId: ID!) {
                    deleteProjectV2Item(input: {projectId: $projectId, itemId: $itemId}) {
                        deletedItemId
                    }
                }""",
                variables={"projectId": project["id"], "itemId": item_id},
            )
        except Exception:
            pass  # best-effort cleanup

    # Close the issue
    try:
        _gh_api(
            f"/repos/{ORG}/{REPO}/issues/{info['number']}",
            method="PATCH",
            state="closed",
        )
    except Exception:
        pass  # best-effort cleanup


# ── Tests: Pure functions (no API) ───────────────────────────────────────

class TestIsLegalTransition:
    """Tests for is_legal_transition — pure function, no API calls."""

    def test_legal_forward(self):
        from github_projects import is_legal_transition

        assert is_legal_transition("Backlog", "Needs Spec") is True

    def test_legal_blocked(self):
        from github_projects import is_legal_transition

        assert is_legal_transition("Agent Working", "Blocked") is True

    def test_illegal_skip(self):
        from github_projects import is_legal_transition

        assert is_legal_transition("Backlog", "Done") is False

    def test_illegal_backward(self):
        from github_projects import is_legal_transition

        assert is_legal_transition("Done", "Backlog") is False

    def test_blocked_can_go_anywhere(self):
        from github_projects import LEGAL_TRANSITIONS, is_legal_transition

        for target in LEGAL_TRANSITIONS["Blocked"]:
            assert is_legal_transition("Blocked", target) is True

    def test_unknown_source(self):
        from github_projects import is_legal_transition

        assert is_legal_transition("Nonexistent", "Backlog") is False


class TestCheckSpecCompleteness:
    """Tests for check_spec_completeness — pure function, no API calls."""

    def test_complete(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness(
            {"Risk": "Low", "AI Suitability": "High"}
        )
        assert ok is True
        assert missing == []

    def test_missing_risk(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness({"AI Suitability": "High"})
        assert ok is False
        assert any("Risk" in m for m in missing)

    def test_missing_ai_suitability(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness({"Risk": "Low"})
        assert ok is False
        assert any("AI Suitability" in m for m in missing)

    def test_high_risk_needs_approval(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness(
            {"Risk": "High", "AI Suitability": "High"}
        )
        assert ok is False
        assert any("Spec Approval" in m for m in missing)

    def test_high_risk_with_approval(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness(
            {"Risk": "High", "AI Suitability": "High", "Spec Approval": "Approved"}
        )
        assert ok is True
        assert missing == []

    def test_empty_fields(self):
        from github_projects import check_spec_completeness

        ok, missing = check_spec_completeness({})
        assert ok is False
        assert len(missing) == 2


# ── Tests: API integration ───────────────────────────────────────────────

class TestFindProject:
    """Test find_project against real GitHub API."""

    def test_find_project(self, project):
        assert project["title"] == PROJECT_NAME
        assert project["id"]  # non-empty string (GraphQL node ID)
        assert isinstance(project["number"], int)

    def test_find_project_not_found(self):
        import github_app
        import github_projects

        github_app.select_app("stark-claude")
        with pytest.raises(ValueError, match="not found"):
            github_projects.find_project(ORG, "Nonexistent Project 9999")


class TestGetFieldIds:
    """Test get_field_ids against real project."""

    def test_get_field_ids(self, project):
        import github_projects

        fields = github_projects.get_field_ids(project["id"])
        assert isinstance(fields, dict)
        assert len(fields) > 0

        # These fields must exist on the AI-DD Tracker
        for expected in ("Status", "Priority", "Risk", "AI Suitability"):
            assert expected in fields, f"Field '{expected}' not found in project fields"
            assert "id" in fields[expected]
            assert "type" in fields[expected]

    def test_status_has_options(self, project):
        import github_projects

        fields = github_projects.get_field_ids(project["id"])
        status = fields["Status"]
        assert status["type"] == "SINGLE_SELECT"
        assert len(status["options"]) > 0
        assert "Backlog" in status["options"]


class TestGetItems:
    """Test get_items against real project."""

    def test_get_items_returns_list(self, project):
        import github_projects

        items = github_projects.get_items(project["id"])
        assert isinstance(items, list)
        # Project should have at least one item
        assert len(items) > 0

    def test_item_structure(self, project):
        import github_projects

        items = github_projects.get_items(project["id"])
        item = items[0]
        assert "item_id" in item
        assert "fields" in item
        assert isinstance(item["fields"], dict)


class TestAddIssueAndSetFields:
    """Test adding an issue to the project and setting fields."""

    def test_add_and_set_fields(self, project, test_issue):
        import github_projects

        # Add to project
        item_id = github_projects.add_issue_to_project(
            project["id"], test_issue["node_id"]
        )
        assert item_id  # non-empty string

        # Set fields
        github_projects.set_fields(
            project["id"],
            item_id,
            {"Story Points": 3, "Phase": "Phase 1"},
        )

        # Verify
        field_values = github_projects.get_item_fields(item_id)
        assert field_values.get("Story Points") == 3.0  # NUMBER fields come back as float


class TestTransitionStatus:
    """Test transition_status with legal and illegal transitions."""

    def test_legal_transition(self, project, test_issue):
        import github_projects

        # Add to project
        item_id = github_projects.add_issue_to_project(
            project["id"], test_issue["node_id"]
        )

        # Set initial status to Backlog
        github_projects.set_field(project["id"], item_id, "Status", "Backlog")

        # Legal transition: Backlog → Needs Spec
        result = github_projects.transition_status(
            project["id"], item_id, "Needs Spec"
        )
        assert result is True

        # Verify new status
        fields = github_projects.get_item_fields(item_id)
        assert fields.get("Status") == "Needs Spec"

    def test_illegal_transition(self, project, test_issue):
        import github_projects

        # Add to project
        item_id = github_projects.add_issue_to_project(
            project["id"], test_issue["node_id"]
        )

        # Set initial status to Backlog
        github_projects.set_field(project["id"], item_id, "Status", "Backlog")

        # Illegal transition: Backlog → Done
        with pytest.raises(ValueError, match="Illegal transition"):
            github_projects.transition_status(project["id"], item_id, "Done")

    def test_idempotent_transition(self, project, test_issue):
        import github_projects

        # Add to project
        item_id = github_projects.add_issue_to_project(
            project["id"], test_issue["node_id"]
        )

        # Set status to Backlog
        github_projects.set_field(project["id"], item_id, "Status", "Backlog")

        # Transition to same status should return False (no-op)
        result = github_projects.transition_status(
            project["id"], item_id, "Backlog"
        )
        assert result is False
