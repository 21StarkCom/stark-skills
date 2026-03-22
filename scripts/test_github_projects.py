"""Tests for graphql() function in github_app.py and github_projects.py."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

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


class TestIsLegalTransition(unittest.TestCase):
    """Tests for github_projects.is_legal_transition()."""

    def test_legal(self) -> None:
        self.assertTrue(github_projects.is_legal_transition("Backlog", "Needs Spec"))

    def test_illegal(self) -> None:
        self.assertFalse(github_projects.is_legal_transition("Backlog", "Done"))

    def test_unknown_from_status(self) -> None:
        self.assertFalse(github_projects.is_legal_transition("Nonexistent", "Done"))


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


if __name__ == "__main__":
    unittest.main()
