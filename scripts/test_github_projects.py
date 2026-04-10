"""Tests for graphql() function in github_app.py and github_projects.py."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, call, patch

import pytest
import requests.exceptions

import github_app
import github_projects


class TestGraphQL(unittest.TestCase):
    """Tests for github_app.graphql()."""

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_sends_post_to_graphql_endpoint(self, mock_post: MagicMock, mock_headers: MagicMock) -> None:
        """graphql() POSTs to /graphql with correct headers and query body."""
        mock_post.return_value = MagicMock(status_code=200, json=lambda: {"data": {"viewer": {"login": "bot"}}})

        result = github_app.graphql("{ viewer { login } }")

        mock_post.assert_called_once_with(
            "https://api.github.com/graphql",
            headers={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"},
            json={"query": "{ viewer { login } }"},
            timeout=30,
        )
        self.assertEqual(result, {"data": {"viewer": {"login": "bot"}}})
        mock_headers.assert_called_once()

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_raises_on_graphql_errors(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() raises RuntimeError when response contains 'errors' key."""
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"errors": [{"message": "Field 'foo' not found"}]},
        )

        with self.assertRaises(RuntimeError) as ctx:
            github_app.graphql("{ bad }")

        self.assertIn("Field 'foo' not found", str(ctx.exception))

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_includes_variables_in_body(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() includes variables dict in request body when provided."""
        mock_post.return_value = MagicMock(status_code=200, json=lambda: {"data": {"node": {"id": "123"}}})

        github_app.graphql("query($id: ID!) { node(id: $id) { id } }", variables={"id": "123"})

        call_kwargs = mock_post.call_args[1]
        self.assertEqual(call_kwargs["json"]["variables"], {"id": "123"})

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_retries_once_on_connection_error(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() retries once on ConnectionError, then succeeds."""
        mock_post.side_effect = [
            requests.exceptions.ConnectionError("connection reset"),
            MagicMock(status_code=200, json=lambda: {"data": {"ok": True}}),
        ]

        result = github_app.graphql("{ viewer { login } }")

        self.assertEqual(mock_post.call_count, 2)
        self.assertEqual(result, {"data": {"ok": True}})

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_raises_after_retry_exhausted(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() raises ConnectionError after retry is exhausted."""
        mock_post.side_effect = [
            requests.exceptions.ConnectionError("first"),
            requests.exceptions.ConnectionError("second"),
        ]

        with self.assertRaises(requests.exceptions.ConnectionError):
            github_app.graphql("{ viewer { login } }")

        self.assertEqual(mock_post.call_count, 2)

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_retry_false_disables_retry(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql(retry=False) does not retry on ConnectionError."""
        mock_post.side_effect = requests.exceptions.ConnectionError("no retry")

        with self.assertRaises(requests.exceptions.ConnectionError):
            github_app.graphql("{ viewer { login } }", retry=False)

        self.assertEqual(mock_post.call_count, 1)


    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_graphql_errors_are_not_retried(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """GraphQL error responses are not retried — fail-closed contract."""
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"errors": [{"message": "Some error"}]},
            raise_for_status=MagicMock(),
        )

        with self.assertRaises(RuntimeError):
            github_app.graphql("{ bad }")

        self.assertEqual(mock_post.call_count, 1)


class TestTokenSelection(unittest.TestCase):
    @patch("github_app._mint_installation_token", return_value=("token-for-claude", 9999999999.0))
    @patch("github_app._get_private_key", return_value="private-key")
    @patch("github_app._write_cached_token")
    @patch("github_app._read_cached_token", return_value=None)
    def test_get_token_with_explicit_app_does_not_mutate_active_app(
        self,
        mock_read_cached: MagicMock,
        mock_write_cached: MagicMock,
        mock_get_private_key: MagicMock,
        mock_mint: MagicMock,
    ) -> None:
        with patch.object(github_app, "_active_app", "stark-codex"):
            token = github_app.get_token(app="stark-claude")
            self.assertEqual(token, "token-for-claude")
            self.assertEqual(github_app._active_app, "stark-codex")

        mock_read_cached.assert_called_once()
        mock_get_private_key.assert_called_once_with("stark-claude")
        mock_mint.assert_called_once()
        mock_write_cached.assert_called_once()

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_variables_none_omits_key_from_body(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() without variables does not include 'variables' key in body."""
        mock_post.return_value = MagicMock(
            status_code=200,
            json=lambda: {"data": {"viewer": {"login": "bot"}}},
            raise_for_status=MagicMock(),
        )

        github_app.graphql("query { viewer { login } }")

        self.assertNotIn("variables", mock_post.call_args[1]["json"])

    @patch("github_app._headers", return_value={"Authorization": "Bearer fake", "Accept": "application/vnd.github+json"})
    @patch("github_app.requests.post")
    def test_http_error_status_raises(self, mock_post: MagicMock, _mock_headers: MagicMock) -> None:
        """graphql() raises HTTPError on non-200 status via raise_for_status()."""
        mock_response = MagicMock(status_code=500)
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("500 Server Error")
        mock_post.return_value = mock_response

        with self.assertRaises(requests.exceptions.HTTPError):
            github_app.graphql("{ viewer { login } }")


class TestFindProject(unittest.TestCase):
    """Tests for github_projects.find_project()."""

    @patch("github_app.graphql")
    def test_find_project_by_name(self, mock_gql: MagicMock) -> None:
        """find_project returns matching project dict."""
        mock_gql.return_value = {
            "data": {
                "organization": {
                    "projectsV2": {
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": [
                            {"id": "PVT_1", "title": "Other Project", "number": 1},
                            {"id": "PVT_2", "title": "Platform Board", "number": 2},
                        ],
                    }
                }
            }
        }

        result = github_projects.find_project("GetEvinced", "Platform Board")

        self.assertEqual(result, {"id": "PVT_2", "title": "Platform Board", "number": 2})
        mock_gql.assert_called_once()

    @patch("github_app.graphql")
    def test_find_project_not_found_raises(self, mock_gql: MagicMock) -> None:
        """find_project raises ValueError when project not found."""
        mock_gql.return_value = {
            "data": {
                "organization": {
                    "projectsV2": {
                        "pageInfo": {"hasNextPage": False, "endCursor": None},
                        "nodes": [
                            {"id": "PVT_1", "title": "Other Project", "number": 1},
                        ],
                    }
                }
            }
        }

        with self.assertRaises(ValueError) as ctx:
            github_projects.find_project("GetEvinced", "Nonexistent")

        self.assertIn("Nonexistent", str(ctx.exception))
        self.assertIn("GetEvinced", str(ctx.exception))


class TestAddIssueToProject(unittest.TestCase):
    """Tests for github_projects.add_issue_to_project()."""

    @patch("github_app.graphql")
    def test_add_issue_returns_item_id(self, mock_gql: MagicMock) -> None:
        """add_issue_to_project returns the new item ID."""
        mock_gql.return_value = {
            "data": {
                "addProjectV2ItemById": {
                    "item": {"id": "PVTI_abc123"}
                }
            }
        }

        result = github_projects.add_issue_to_project("PVT_project1", "I_issue1")

        self.assertEqual(result, "PVTI_abc123")
        mock_gql.assert_called_once()
        call_vars = mock_gql.call_args[1]["variables"]
        self.assertEqual(call_vars["projectId"], "PVT_project1")
        self.assertEqual(call_vars["contentId"], "I_issue1")


class TestGetFieldIds(unittest.TestCase):
    """Tests for github_projects.get_field_ids()."""

    def setUp(self) -> None:
        github_projects._field_cache.clear()

    @patch("github_app.graphql")
    def test_get_field_ids_caches_result(self, mock_gql: MagicMock) -> None:
        """get_field_ids caches and returns field definitions."""
        mock_gql.return_value = {
            "data": {
                "node": {
                    "fields": {
                        "nodes": [
                            {"id": "F1", "name": "Status", "dataType": "SINGLE_SELECT",
                             "options": [{"id": "O1", "name": "Backlog"}, {"id": "O2", "name": "Done"}]},
                            {"id": "F2", "name": "Priority", "dataType": "NUMBER"},
                        ]
                    }
                }
            }
        }

        result = github_projects.get_field_ids("PVT_1")
        result2 = github_projects.get_field_ids("PVT_1")

        self.assertEqual(result["Status"]["id"], "F1")
        self.assertEqual(result["Status"]["options"]["Backlog"], "O1")
        self.assertEqual(result["Priority"]["type"], "NUMBER")
        # Second call uses cache
        self.assertEqual(mock_gql.call_count, 1)
        self.assertEqual(result, result2)


class TestSetField(unittest.TestCase):
    """Tests for github_projects.set_field()."""

    def setUp(self) -> None:
        github_projects._field_cache.clear()

    @patch("github_projects.time.sleep")
    @patch("github_app.graphql")
    def test_set_single_select_field(self, mock_gql: MagicMock, mock_sleep: MagicMock) -> None:
        """set_field resolves option ID for SINGLE_SELECT fields."""
        # Pre-populate cache
        github_projects._field_cache["PVT_1"] = {
            "Status": {"id": "F1", "type": "SINGLE_SELECT", "options": {"Backlog": "O1", "Done": "O2"}},
        }
        mock_gql.return_value = {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}}}

        github_projects.set_field("PVT_1", "PVTI_1", "Status", "Done")

        call_vars = mock_gql.call_args[1]["variables"]
        self.assertEqual(call_vars["value"], {"singleSelectOptionId": "O2"})
        mock_sleep.assert_called_once_with(0.1)

    @patch("github_projects.time.sleep")
    @patch("github_app.graphql")
    def test_set_number_field(self, mock_gql: MagicMock, mock_sleep: MagicMock) -> None:
        """set_field sends value as float for NUMBER fields."""
        github_projects._field_cache["PVT_1"] = {
            "Priority": {"id": "F2", "type": "NUMBER", "options": {}},
        }
        mock_gql.return_value = {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}}}

        github_projects.set_field("PVT_1", "PVTI_1", "Priority", 5)

        call_vars = mock_gql.call_args[1]["variables"]
        self.assertEqual(call_vars["value"], {"number": 5.0})
        self.assertIsInstance(call_vars["value"]["number"], float)

    @patch("github_projects.time.sleep")
    @patch("github_app.graphql")
    def test_set_text_field(self, mock_gql: MagicMock, mock_sleep: MagicMock) -> None:
        """set_field sends value as string for TEXT fields."""
        github_projects._field_cache["PVT_1"] = {
            "Notes": {"id": "F3", "type": "TEXT", "options": {}},
        }
        mock_gql.return_value = {"data": {"updateProjectV2ItemFieldValue": {"projectV2Item": {"id": "PVTI_1"}}}}

        github_projects.set_field("PVT_1", "PVTI_1", "Notes", "some text")

        call_vars = mock_gql.call_args[1]["variables"]
        self.assertEqual(call_vars["value"], {"text": "some text"})

    def test_set_invalid_option_raises(self) -> None:
        """set_field raises ValueError for invalid SINGLE_SELECT option."""
        github_projects._field_cache["PVT_1"] = {
            "Status": {"id": "F1", "type": "SINGLE_SELECT", "options": {"Backlog": "O1", "Done": "O2"}},
        }

        with self.assertRaises(ValueError) as ctx:
            github_projects.set_field("PVT_1", "PVTI_1", "Status", "InvalidOption")

        self.assertIn("InvalidOption", str(ctx.exception))
        self.assertIn("not found", str(ctx.exception))

    @patch("github_projects.time.sleep")
    @patch("github_app.graphql")
    def test_set_mutation_failure_raises(self, mock_gql: MagicMock, mock_sleep: MagicMock) -> None:
        """set_field raises RuntimeError when GraphQL mutation fails."""
        github_projects._field_cache["PVT_1"] = {
            "Status": {"id": "F1", "type": "SINGLE_SELECT", "options": {"Backlog": "O1"}},
        }
        mock_gql.side_effect = RuntimeError("GraphQL error: mutation failed")

        with self.assertRaises(RuntimeError):
            github_projects.set_field("PVT_1", "PVTI_1", "Status", "Backlog")

    @patch("github_app.graphql")
    def test_set_field_unknown_field_raises(self, mock_gql: MagicMock) -> None:
        """set_field raises ValueError for unknown field name."""
        github_projects._field_cache["PVT_1"] = {}

        with self.assertRaises(ValueError) as ctx:
            github_projects.set_field("PVT_1", "PVTI_1", "Nonexistent", "val")

        self.assertIn("Nonexistent", str(ctx.exception))


class TestTransitionStatus(unittest.TestCase):
    """Tests for github_projects.transition_status()."""

    def setUp(self) -> None:
        github_projects._field_cache.clear()

    @patch("github_projects.set_field")
    @patch("github_projects.get_item_fields")
    def test_legal_transition(self, mock_get_fields: MagicMock, mock_set: MagicMock) -> None:
        """transition_status succeeds for legal transitions."""
        mock_get_fields.return_value = {"Status": "Backlog"}

        result = github_projects.transition_status("PVT_1", "PVTI_1", "Needs Spec")

        self.assertTrue(result)
        mock_set.assert_called_once_with("PVT_1", "PVTI_1", "Status", "Needs Spec")

    @patch("github_projects.get_item_fields")
    def test_illegal_transition_raises(self, mock_get_fields: MagicMock) -> None:
        """transition_status raises ValueError for illegal transitions."""
        mock_get_fields.return_value = {"Status": "Backlog"}

        with self.assertRaises(ValueError) as ctx:
            github_projects.transition_status("PVT_1", "PVTI_1", "Done")

        self.assertIn("Illegal transition", str(ctx.exception))

    @patch("github_projects.get_item_fields")
    def test_idempotent_returns_false(self, mock_get_fields: MagicMock) -> None:
        """transition_status returns False if already in target status."""
        mock_get_fields.return_value = {"Status": "Backlog"}

        result = github_projects.transition_status("PVT_1", "PVTI_1", "Backlog")

        self.assertFalse(result)

    @patch("github_projects.set_field")
    @patch("github_projects.get_item_fields")
    def test_validate_false_skips_validation(self, mock_get_fields: MagicMock, mock_set: MagicMock) -> None:
        """transition_status with validate=False skips reading current status."""
        result = github_projects.transition_status("PVT_1", "PVTI_1", "Done", validate=False)

        self.assertTrue(result)
        mock_get_fields.assert_not_called()
        mock_set.assert_called_once_with("PVT_1", "PVTI_1", "Status", "Done")


class TestIsLegalTransition(unittest.TestCase):
    """Tests for github_projects.is_legal_transition()."""

    def test_legal(self) -> None:
        self.assertTrue(github_projects.is_legal_transition("Backlog", "Needs Spec"))

    def test_illegal(self) -> None:
        self.assertFalse(github_projects.is_legal_transition("Backlog", "Done"))

    def test_unknown_from_status(self) -> None:
        self.assertFalse(github_projects.is_legal_transition("Nonexistent", "Done"))

    def test_done_has_no_outgoing_transitions(self) -> None:
        """Done is a terminal state — no outgoing transitions."""
        self.assertFalse(github_projects.is_legal_transition("Done", "Backlog"))
        self.assertFalse(github_projects.is_legal_transition("Done", "Needs Spec"))


# ── Parametrized is_legal_transition coverage ─────────────────────────────

_LEGAL_CASES = [
    ("Backlog", "Needs Spec", True),
    ("Backlog", "Done", False),
    ("Backlog", "Agent Working", False),
    ("Needs Spec", "Ready for Agent", True),
    ("Needs Spec", "Human Working", True),
    ("Needs Spec", "Blocked", True),
    ("Needs Spec", "Done", False),
    ("Needs Spec", "Backlog", False),
    ("Ready for Agent", "Agent Working", True),
    ("Ready for Agent", "Blocked", True),
    ("Ready for Agent", "Done", False),
    ("Ready for Agent", "Backlog", False),
    ("Agent Working", "Human Review", True),
    ("Agent Working", "Needs Clarification", True),
    ("Agent Working", "Blocked", True),
    ("Agent Working", "Done", False),
    ("Agent Working", "Backlog", False),
    ("Human Working", "Human Review", True),
    ("Human Working", "Blocked", True),
    ("Human Working", "Done", False),
    ("Human Working", "Backlog", False),
    ("Needs Clarification", "Ready for Agent", True),
    ("Needs Clarification", "Blocked", True),
    ("Needs Clarification", "Done", False),
    ("Needs Clarification", "Backlog", False),
    ("Human Review", "Agent Working", True),
    ("Human Review", "Human Working", True),
    ("Human Review", "Ready to Merge", True),
    ("Human Review", "Blocked", True),
    ("Human Review", "Done", False),
    ("Human Review", "Backlog", False),
    ("Ready to Merge", "Ready to Release", True),
    ("Ready to Merge", "Human Review", True),
    ("Ready to Merge", "Blocked", True),
    ("Ready to Merge", "Done", False),
    ("Ready to Merge", "Backlog", False),
    ("Ready to Release", "Done", True),
    ("Ready to Release", "Human Review", True),
    ("Ready to Release", "Blocked", True),
    ("Ready to Release", "Backlog", False),
    # Blocked can go to any working state
    ("Blocked", "Backlog", True),
    ("Blocked", "Needs Spec", True),
    ("Blocked", "Ready for Agent", True),
    ("Blocked", "Agent Working", True),
    ("Blocked", "Human Working", True),
    ("Blocked", "Needs Clarification", True),
    ("Blocked", "Human Review", True),
    ("Blocked", "Ready to Merge", True),
    ("Blocked", "Ready to Release", True),
    ("Blocked", "Done", False),
    # Done has no outgoing transitions
    ("Done", "Backlog", False),
    ("Done", "Needs Spec", False),
    ("Done", "Agent Working", False),
    # Unknown status
    ("Nonexistent", "Backlog", False),
]


@pytest.mark.parametrize("from_status,to_status,expected", _LEGAL_CASES)
def test_is_legal_transition_parametrized(from_status: str, to_status: str, expected: bool) -> None:
    """Parametrized: is_legal_transition covers every status."""
    assert github_projects.is_legal_transition(from_status, to_status) == expected


class TestCheckSpecCompleteness(unittest.TestCase):
    """Tests for github_projects.check_spec_completeness()."""

    def test_complete_low_risk(self) -> None:
        fields = {"Risk": "Low", "AI Suitability": "agent-led"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertTrue(ok)
        self.assertEqual(missing, [])

    def test_missing_risk(self) -> None:
        fields = {"AI Suitability": "agent-led"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertFalse(ok)
        self.assertIn("Risk field is not set", missing)

    def test_missing_ai_suitability(self) -> None:
        fields = {"Risk": "Low"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertFalse(ok)
        self.assertIn("AI Suitability field is not set", missing)

    def test_high_risk_needs_approval(self) -> None:
        fields = {"Risk": "High", "AI Suitability": "agent-led"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertFalse(ok)
        self.assertIn("Spec Approval required for high-risk items", missing)

    def test_high_risk_with_approval(self) -> None:
        fields = {"Risk": "High", "AI Suitability": "agent-led", "Spec Approval": "Approved"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertTrue(ok)


class TestLoadProjectConfig(unittest.TestCase):
    """Tests for github_projects.load_project_config()."""

    def test_returns_none_for_missing_file(self) -> None:
        result = github_projects.load_project_config("/nonexistent/path")
        self.assertIsNone(result)


class TestFindItemForIssue(unittest.TestCase):
    """Tests for github_projects.find_item_for_issue()."""

    @patch("github_app.graphql")
    def test_finds_matching_item(self, mock_gql: MagicMock) -> None:
        mock_gql.return_value = {
            "data": {
                "repository": {
                    "issue": {
                        "id": "I_1",
                        "projectItems": {
                            "nodes": [
                                {"id": "PVTI_1", "project": {"id": "PVT_1"}},
                                {"id": "PVTI_2", "project": {"id": "PVT_2"}},
                            ]
                        },
                    }
                }
            }
        }

        result = github_projects.find_item_for_issue("GetEvinced", "my-repo", 42, "PVT_2")
        self.assertEqual(result, "PVTI_2")

    @patch("github_app.graphql")
    def test_returns_none_when_not_in_project(self, mock_gql: MagicMock) -> None:
        mock_gql.return_value = {
            "data": {
                "repository": {
                    "issue": {
                        "id": "I_1",
                        "projectItems": {
                            "nodes": [
                                {"id": "PVTI_1", "project": {"id": "PVT_1"}},
                            ]
                        },
                    }
                }
            }
        }

        result = github_projects.find_item_for_issue("GetEvinced", "my-repo", 42, "PVT_99")
        self.assertIsNone(result)


class TestGetIssueNodeId(unittest.TestCase):
    """Tests for github_projects.get_issue_node_id()."""

    @patch("github_app.graphql")
    def test_returns_node_id(self, mock_gql: MagicMock) -> None:
        mock_gql.return_value = {
            "data": {
                "repository": {
                    "issue": {
                        "id": "I_abc123",
                        "projectItems": {"nodes": []},
                    }
                }
            }
        }

        result = github_projects.get_issue_node_id("GetEvinced", "my-repo", 10)
        self.assertEqual(result, "I_abc123")


class TestCheckSpecCompletenessStricter(unittest.TestCase):
    """Additional tests for check_spec_completeness Spec Approval gate."""

    def test_high_risk_pending_approval_fails(self) -> None:
        """High-risk item with 'Pending' Spec Approval must fail."""
        fields = {"Risk": "High", "AI Suitability": "agent-led", "Spec Approval": "Pending"}
        ok, missing = github_projects.check_spec_completeness(fields)
        self.assertFalse(ok)
        self.assertIn("Spec Approval required for high-risk items", missing)


class TestFindItemForIssueNullGuard(unittest.TestCase):
    """Tests for find_item_for_issue when issue is null."""

    @patch("github_app.graphql")
    def test_returns_none_when_issue_is_null(self, mock_gql: MagicMock) -> None:
        """find_item_for_issue returns None when GraphQL returns issue: null."""
        mock_gql.return_value = {
            "data": {"repository": {"issue": None}}
        }

        result = github_projects.find_item_for_issue("GetEvinced", "my-repo", 9999, "PVT_1")
        self.assertIsNone(result)


class TestGetIssueNodeIdNullGuard(unittest.TestCase):
    """Tests for get_issue_node_id when issue is null."""

    @patch("github_app.graphql")
    def test_raises_when_issue_is_null(self, mock_gql: MagicMock) -> None:
        """get_issue_node_id raises ValueError when GraphQL returns issue: null."""
        mock_gql.return_value = {
            "data": {"repository": {"issue": None}}
        }

        with self.assertRaises(ValueError) as ctx:
            github_projects.get_issue_node_id("GetEvinced", "my-repo", 9999)

        self.assertIn("9999", str(ctx.exception))
        self.assertIn("not found", str(ctx.exception))


class TestTransitionStatusMissingField(unittest.TestCase):
    """Tests for transition_status when Status field is missing."""

    @patch("github_projects.get_item_fields")
    def test_raises_when_status_field_missing(self, mock_get_fields: MagicMock) -> None:
        """transition_status raises ValueError when Status field is absent and validate=True."""
        mock_get_fields.return_value = {"Priority": "High"}  # no Status

        with self.assertRaises(ValueError) as ctx:
            github_projects.transition_status("PVT_1", "PVTI_1", "Needs Spec")

        self.assertIn("current Status field is missing", str(ctx.exception))


class TestGetItems(unittest.TestCase):
    """Tests for github_projects.get_items()."""

    def _make_page(self, nodes: list[dict], has_next: bool = False, cursor: str | None = None) -> dict:
        """Helper to build a GraphQL response page for get_items."""
        return {
            "data": {
                "node": {
                    "items": {
                        "pageInfo": {"hasNextPage": has_next, "endCursor": cursor},
                        "nodes": nodes,
                    }
                }
            }
        }

    def _make_item_node(self, item_id: str, number: int, title: str, repo: str, state: str, field_values: list[dict] | None = None) -> dict:
        return {
            "id": item_id,
            "content": {
                "number": number,
                "title": title,
                "repository": {"nameWithOwner": repo},
                "state": state,
            },
            "fieldValues": {"nodes": field_values or []},
        }

    @patch("github_app.graphql")
    def test_single_page(self, mock_gql: MagicMock) -> None:
        """get_items returns all items from a single page."""
        mock_gql.return_value = self._make_page([
            self._make_item_node("PVTI_1", 1, "Issue 1", "GetEvinced/repo", "OPEN"),
            self._make_item_node("PVTI_2", 2, "Issue 2", "GetEvinced/repo", "CLOSED"),
        ])

        result = github_projects.get_items("PVT_1")

        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]["item_id"], "PVTI_1")
        self.assertEqual(result[1]["issue_number"], 2)
        mock_gql.assert_called_once()

    @patch("github_app.graphql")
    def test_multi_page_pagination(self, mock_gql: MagicMock) -> None:
        """get_items paginates through multiple pages."""
        mock_gql.side_effect = [
            self._make_page(
                [self._make_item_node("PVTI_1", 1, "Issue 1", "GetEvinced/repo", "OPEN")],
                has_next=True, cursor="cursor_1",
            ),
            self._make_page(
                [self._make_item_node("PVTI_2", 2, "Issue 2", "GetEvinced/repo", "OPEN")],
                has_next=False,
            ),
        ]

        result = github_projects.get_items("PVT_1")

        self.assertEqual(len(result), 2)
        self.assertEqual(mock_gql.call_count, 2)
        # Second call should include cursor
        second_call_vars = mock_gql.call_args_list[1][1]["variables"]
        self.assertEqual(second_call_vars["cursor"], "cursor_1")

    @patch("github_app.graphql")
    def test_client_side_filtering_by_state(self, mock_gql: MagicMock) -> None:
        """get_items filters by top-level keys."""
        mock_gql.return_value = self._make_page([
            self._make_item_node("PVTI_1", 1, "Issue 1", "GetEvinced/repo", "OPEN"),
            self._make_item_node("PVTI_2", 2, "Issue 2", "GetEvinced/repo", "CLOSED"),
        ])

        result = github_projects.get_items("PVT_1", state="OPEN")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["item_id"], "PVTI_1")

    @patch("github_app.graphql")
    def test_client_side_filtering_by_field(self, mock_gql: MagicMock) -> None:
        """get_items filters by fields dict entries."""
        field_values = [
            {"field": {"name": "Status"}, "name": "Backlog"},
        ]
        mock_gql.return_value = self._make_page([
            self._make_item_node("PVTI_1", 1, "Issue 1", "GetEvinced/repo", "OPEN", field_values),
            self._make_item_node("PVTI_2", 2, "Issue 2", "GetEvinced/repo", "OPEN"),
        ])

        result = github_projects.get_items("PVT_1", Status="Backlog")

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["item_id"], "PVTI_1")

    @patch("github_app.graphql")
    def test_client_side_filtering_no_match(self, mock_gql: MagicMock) -> None:
        """get_items returns empty list when filter matches nothing."""
        mock_gql.return_value = self._make_page([
            self._make_item_node("PVTI_1", 1, "Issue 1", "GetEvinced/repo", "OPEN"),
        ])

        result = github_projects.get_items("PVT_1", state="MERGED")

        self.assertEqual(result, [])


class TestGetItemFields(unittest.TestCase):
    """Tests for github_projects.get_item_fields() and _parse_field_values()."""

    @patch("github_app.graphql")
    def test_parses_all_field_types(self, mock_gql: MagicMock) -> None:
        """get_item_fields parses text, number, single_select, iteration, date fields."""
        mock_gql.return_value = {
            "data": {
                "node": {
                    "id": "PVTI_1",
                    "fieldValues": {
                        "nodes": [
                            {"text": "some notes", "field": {"name": "Notes"}},
                            {"number": 3.0, "field": {"name": "Priority"}},
                            {"name": "Backlog", "field": {"name": "Status"}},
                            {"title": "Sprint 5", "field": {"name": "Sprint"}},
                            {"date": "2026-03-22", "field": {"name": "Due Date"}},
                            # Node without field ref should be skipped
                            {"text": "orphan"},
                        ],
                    },
                }
            }
        }

        result = github_projects.get_item_fields("PVTI_1")

        self.assertEqual(result["Notes"], "some notes")
        self.assertEqual(result["Priority"], 3.0)
        self.assertEqual(result["Status"], "Backlog")
        self.assertEqual(result["Sprint"], "Sprint 5")
        self.assertEqual(result["Due Date"], "2026-03-22")
        self.assertEqual(len(result), 5)  # orphan node skipped


class TestSetFields(unittest.TestCase):
    """Tests for github_projects.set_fields()."""

    def setUp(self) -> None:
        github_projects._field_cache.clear()

    @patch("github_projects.set_field")
    def test_calls_set_field_for_each_entry(self, mock_set: MagicMock) -> None:
        """set_fields calls set_field once per field in the dict."""
        github_projects.set_fields("PVT_1", "PVTI_1", {"Status": "Backlog", "Priority": 3})

        self.assertEqual(mock_set.call_count, 2)
        mock_set.assert_any_call("PVT_1", "PVTI_1", "Status", "Backlog")
        mock_set.assert_any_call("PVT_1", "PVTI_1", "Priority", 3)

    @patch("github_projects.set_field")
    def test_empty_dict_calls_nothing(self, mock_set: MagicMock) -> None:
        """set_fields with empty dict is a no-op."""
        github_projects.set_fields("PVT_1", "PVTI_1", {})

        mock_set.assert_not_called()


if __name__ == "__main__":
    unittest.main()
