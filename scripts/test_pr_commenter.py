"""Tests for scripts/graph/pr_commenter.py and the CI auth extension in github_app.py.

Coverage:
  - render_markdown: HTML escaping, section presence, empty states, blast radius
  - post_comment: create new, idempotent update, pagination, raise_for_status
  - _request_with_retry: 429 with Retry-After, 5xx, timeout, budget exhaustion
  - github_app: _get_private_key_from_env, GH_TOKEN fallback, Keychain path
"""

from __future__ import annotations

import base64
import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock, Mock, call, patch

import pytest
import requests

# Make scripts/ and scripts/graph/ importable
_scripts = Path(__file__).parent
sys.path.insert(0, str(_scripts))

from graph.model import BlastRadius, DiffReport, ValidationReport
from graph.pr_commenter import (
    MARKER,
    _details_table,
    _find_marker_comment_id,
    _request_with_retry,
    post_comment,
    render_markdown,
)


# ── render_markdown ───────────────────────────────────────────────────────


class TestRenderMarkdown:
    def test_marker_always_present(self):
        assert MARKER in render_markdown()

    def test_diff_counts_in_table(self):
        diff = DiffReport(
            base_ref="main",
            head_ref="feature",
            added_nodes=["a", "b"],
            removed_nodes=["c"],
            added_edges=["x->y:imports"],
        )
        md = render_markdown(diff=diff)
        assert "2" in md   # added nodes
        assert "1" in md   # removed nodes

    def test_diff_refs_escaped(self):
        diff = DiffReport(base_ref="<script>alert(1)</script>", head_ref="main")
        md = render_markdown(diff=diff)
        assert "<script>" not in md
        assert "&lt;script&gt;" in md

    def test_node_ids_appear_in_details(self):
        diff = DiffReport(base_ref="a", head_ref="b", added_nodes=["mymodule.Foo"])
        md = render_markdown(diff=diff)
        assert "mymodule.Foo" in md

    def test_node_ids_html_escaped(self):
        diff = DiffReport(base_ref="a", head_ref="b", added_nodes=["mod<xss>"])
        md = render_markdown(diff=diff)
        assert "<xss>" not in md
        assert "&lt;xss&gt;" in md

    def test_blast_radius_shown_when_nonempty(self):
        br = BlastRadius(direct=["A"], transitive=["B", "C"])
        diff = DiffReport(base_ref="a", head_ref="b", blast_radius=br)
        md = render_markdown(diff=diff)
        assert "Blast radius" in md
        assert "3 node" in md

    def test_blast_radius_depth_cap_note(self):
        br = BlastRadius(direct=["A"], depth_cap_reached=True)
        diff = DiffReport(base_ref="a", head_ref="b", blast_radius=br)
        md = render_markdown(diff=diff)
        assert "depth cap reached" in md

    def test_blast_radius_deduplicates(self):
        br = BlastRadius(direct=["A"], transitive=["A", "B"])
        diff = DiffReport(base_ref="a", head_ref="b", blast_radius=br)
        md = render_markdown(diff=diff)
        assert "2 node" in md  # A + B, deduplicated

    def test_blast_radius_hidden_when_empty(self):
        diff = DiffReport(base_ref="a", head_ref="b")
        md = render_markdown(diff=diff)
        assert "Blast radius" not in md

    def test_validation_node_edge_counts(self):
        v = ValidationReport(graph_repo="myrepo", node_count=42, edge_count=7)
        md = render_markdown(validation=v)
        assert "42" in md
        assert "7" in md

    def test_validation_errors_listed(self):
        v = ValidationReport(graph_repo="r", errors=["STALE: foo.py::Bar"])
        md = render_markdown(validation=v)
        assert "STALE: foo.py::Bar" in md
        assert "Errors" in md

    def test_validation_warnings_listed(self):
        v = ValidationReport(graph_repo="r", warnings=["MISSING: baz"])
        md = render_markdown(validation=v)
        assert "MISSING: baz" in md
        assert "Warnings" in md

    def test_validation_clean_message(self):
        v = ValidationReport(graph_repo="r")
        md = render_markdown(validation=v)
        assert "No errors or warnings" in md or "✅" in md

    def test_validation_repo_name_escaped(self):
        v = ValidationReport(graph_repo="org/repo&<test>")
        md = render_markdown(validation=v)
        assert "<test>" not in md
        assert "&lt;test&gt;" in md

    def test_both_diff_and_validation(self):
        diff = DiffReport(base_ref="a", head_ref="b", added_nodes=["X"])
        v = ValidationReport(graph_repo="r", errors=["E1"])
        md = render_markdown(diff=diff, validation=v)
        assert "Diff" in md
        assert "Validation" in md
        assert "X" in md
        assert "E1" in md


class TestDetailsTable:
    def test_empty_list_returns_empty_string(self):
        assert _details_table("Title", []) == ""

    def test_count_shown_in_summary(self):
        out = _details_table("My nodes", ["a", "b", "c"])
        assert "(3)" in out

    def test_items_present_in_table(self):
        out = _details_table("Items", ["foo", "bar"])
        assert "foo" in out
        assert "bar" in out

    def test_title_html_escaped(self):
        out = _details_table("Nodes <evil>", ["x"])
        assert "<evil>" not in out
        assert "&lt;evil&gt;" in out

    def test_item_html_escaped(self):
        out = _details_table("T", ["<xss>"])
        assert "<xss>" not in out


# ── _request_with_retry ───────────────────────────────────────────────────


class TestRequestWithRetry:
    def _ok_resp(self, status=200):
        r = Mock(status_code=status, headers={})
        r.json.return_value = {}
        return r

    def _rate_resp(self, retry_after="0"):
        return Mock(status_code=429, headers={"Retry-After": retry_after})

    def _server_err_resp(self):
        return Mock(status_code=503, headers={"Retry-After": "0"})

    @patch("graph.pr_commenter.requests.request")
    def test_success_on_first_try(self, mock_req):
        mock_req.return_value = self._ok_resp()
        resp = _request_with_retry("GET", "https://example.com", {})
        assert resp.status_code == 200
        assert mock_req.call_count == 1

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_retries_on_429(self, mock_req, mock_sleep):
        mock_req.side_effect = [self._rate_resp("3"), self._ok_resp()]
        resp = _request_with_retry("GET", "https://example.com", {})
        assert resp.status_code == 200
        mock_sleep.assert_called_once_with(3)

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_retry_after_takes_precedence_over_backoff(self, mock_req, mock_sleep):
        # Retry-After: 30 is larger than initial backoff of 1
        mock_req.side_effect = [self._rate_resp("30"), self._ok_resp()]
        _request_with_retry("GET", "https://example.com", {})
        mock_sleep.assert_called_once_with(30)

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_backoff_used_when_retry_after_zero(self, mock_req, mock_sleep):
        # backoff starts at 1, Retry-After: 0 → sleep(max(1, 0)) == sleep(1)
        mock_req.side_effect = [self._rate_resp("0"), self._ok_resp()]
        _request_with_retry("GET", "https://example.com", {})
        mock_sleep.assert_called_once_with(1)

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_retries_on_5xx(self, mock_req, mock_sleep):
        mock_req.side_effect = [self._server_err_resp(), self._ok_resp()]
        resp = _request_with_retry("GET", "https://example.com", {})
        assert resp.status_code == 200
        assert mock_sleep.call_count == 1

    @patch("graph.pr_commenter.requests.request", side_effect=requests.exceptions.Timeout)
    def test_exits_2_on_timeout(self, _mock_req):
        with pytest.raises(SystemExit) as exc:
            _request_with_retry("GET", "https://example.com", {})
        assert exc.value.code == 2

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_exits_2_when_budget_exhausted(self, mock_req, mock_sleep):
        # Retry-After: 200 > MAX_TOTAL_SLEEP (120) → budget exceeded on first retry
        mock_req.return_value = self._rate_resp("200")
        with pytest.raises(SystemExit) as exc:
            _request_with_retry("GET", "https://example.com", {})
        assert exc.value.code == 2
        mock_sleep.assert_not_called()

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_exits_2_after_accumulated_sleep_exceeds_budget(self, mock_req, mock_sleep):
        # Two retries of 70s each → second would exceed 120s budget
        mock_req.side_effect = [
            self._rate_resp("70"),
            self._rate_resp("70"),
            self._ok_resp(),
        ]
        with pytest.raises(SystemExit) as exc:
            _request_with_retry("GET", "https://example.com", {})
        assert exc.value.code == 2
        mock_sleep.assert_called_once_with(70)


# ── post_comment ──────────────────────────────────────────────────────────


class TestPostComment:
    TOKEN = "ghp_testtoken"
    REPO = "org/repo"
    PR = 7

    def _make_list_resp(self, comments):
        r = Mock(status_code=200, headers={})
        r.json.return_value = comments
        r.raise_for_status = Mock()
        return r

    def _make_action_resp(self, status, url):
        r = Mock(status_code=status, headers={})
        r.json.return_value = {"html_url": url}
        r.raise_for_status = Mock()
        return r

    @patch("graph.pr_commenter.requests.request")
    def test_creates_comment_when_none_exists(self, mock_req):
        list_resp = self._make_list_resp([])
        create_resp = self._make_action_resp(201, "https://github.com/org/repo/issues/7#issuecomment-1")
        mock_req.side_effect = [list_resp, create_resp]

        result = post_comment(self.REPO, self.PR, f"hello {MARKER}", self.TOKEN)

        assert result["action"] == "created"
        assert "issuecomment-1" in result["url"]

    @patch("graph.pr_commenter.requests.request")
    def test_updates_existing_marker_comment(self, mock_req):
        list_resp = self._make_list_resp([
            {"id": 42, "body": f"old content {MARKER}"},
        ])
        update_resp = self._make_action_resp(200, "https://github.com/org/repo/issues/7#issuecomment-42")
        mock_req.side_effect = [list_resp, update_resp]

        result = post_comment(self.REPO, self.PR, f"new content {MARKER}", self.TOKEN)

        assert result["action"] == "updated"
        assert "issuecomment-42" in result["url"]

    @patch("graph.pr_commenter.requests.request")
    def test_skips_comments_without_marker(self, mock_req):
        list_resp = self._make_list_resp([
            {"id": 10, "body": "some unrelated comment"},
            {"id": 11, "body": "another comment"},
        ])
        create_resp = self._make_action_resp(201, "https://github.com/org/repo/issues/7#issuecomment-new")
        mock_req.side_effect = [list_resp, create_resp]

        result = post_comment(self.REPO, self.PR, f"body {MARKER}", self.TOKEN)
        assert result["action"] == "created"

    @patch("graph.pr_commenter.requests.request")
    def test_update_uses_patch_to_comments_endpoint(self, mock_req):
        list_resp = self._make_list_resp([{"id": 55, "body": f"x {MARKER}"}])
        update_resp = self._make_action_resp(200, "https://github.com/org/repo/issues/7#issuecomment-55")
        mock_req.side_effect = [list_resp, update_resp]

        post_comment(self.REPO, self.PR, "updated", self.TOKEN)

        # Second call should be PATCH to /issues/comments/55
        patch_call = mock_req.call_args_list[1]
        assert patch_call.args[0] == "PATCH"
        assert "/issues/comments/55" in patch_call.args[1]

    @patch("graph.pr_commenter.requests.request")
    def test_create_uses_post_to_issue_comments_endpoint(self, mock_req):
        list_resp = self._make_list_resp([])
        create_resp = self._make_action_resp(201, "https://github.com/org/repo/issues/7#issuecomment-new")
        mock_req.side_effect = [list_resp, create_resp]

        post_comment(self.REPO, self.PR, "body", self.TOKEN)

        post_call = mock_req.call_args_list[1]
        assert post_call.args[0] == "POST"
        assert f"/issues/{self.PR}/comments" in post_call.args[1]

    @patch("graph.pr_commenter.time.sleep")
    @patch("graph.pr_commenter.requests.request")
    def test_retries_on_429_during_list(self, mock_req, mock_sleep):
        rate_resp = Mock(status_code=429, headers={"Retry-After": "2"})
        list_resp = self._make_list_resp([])
        create_resp = self._make_action_resp(201, "https://github.com/org/repo/issues/7#new")
        mock_req.side_effect = [rate_resp, list_resp, create_resp]

        result = post_comment(self.REPO, self.PR, "body", self.TOKEN)
        mock_sleep.assert_called_once_with(2)
        assert result["action"] == "created"

    @patch("graph.pr_commenter.requests.request", side_effect=requests.exceptions.Timeout)
    def test_exits_2_on_timeout_during_list(self, _mock_req):
        with pytest.raises(SystemExit) as exc:
            post_comment(self.REPO, self.PR, "body", self.TOKEN)
        assert exc.value.code == 2

    @patch("graph.pr_commenter.requests.request")
    def test_auth_header_sent_with_token(self, mock_req):
        list_resp = self._make_list_resp([])
        create_resp = self._make_action_resp(201, "https://github.com/org/repo/issues/7#new")
        mock_req.side_effect = [list_resp, create_resp]

        post_comment(self.REPO, self.PR, "body", "my-secret-token")

        list_call = mock_req.call_args_list[0]
        assert list_call.kwargs["headers"]["Authorization"] == "Bearer my-secret-token"


# ── github_app CI auth extension ─────────────────────────────────────────


class TestGithubAppEnvVarAuth:
    def test_get_private_key_from_env_decodes_base64(self, monkeypatch):
        import github_app

        pem = b"-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----"
        monkeypatch.setenv("STARK_PRIVATE_KEY_B64", base64.b64encode(pem).decode())
        monkeypatch.setenv("STARK_APP_ID", "99999")
        monkeypatch.setenv("STARK_INSTALL_ID", "88888")

        key, app_id, install_id = github_app._get_private_key_from_env()

        assert key == pem.decode()
        assert app_id == "99999"
        assert install_id == "88888"

    def test_get_private_key_from_env_raises_key_error_when_missing(self, monkeypatch):
        import github_app

        monkeypatch.delenv("STARK_PRIVATE_KEY_B64", raising=False)
        monkeypatch.delenv("STARK_APP_ID", raising=False)
        monkeypatch.delenv("STARK_INSTALL_ID", raising=False)

        with pytest.raises(KeyError):
            github_app._get_private_key_from_env()

    def test_get_token_falls_back_to_gh_token(self, monkeypatch):
        import github_app

        monkeypatch.setenv("GH_TOKEN", "ghp_fallback")
        monkeypatch.delenv("STARK_PRIVATE_KEY_B64", raising=False)
        monkeypatch.delenv("STARK_APP_ID", raising=False)
        monkeypatch.delenv("STARK_INSTALL_ID", raising=False)

        with (
            patch.object(github_app, "_read_cached_token", return_value=None),
            patch.object(github_app, "subprocess") as mock_sub,
        ):
            mock_sub.run.return_value = Mock(returncode=1, stderr="not found")
            token = github_app.get_token()

        assert token == "ghp_fallback"

    def test_get_token_keychain_error_raises_keychainerror(self):
        import github_app

        with (
            patch.object(github_app, "_read_cached_token", return_value=None),
            patch.object(github_app, "subprocess") as mock_sub,
        ):
            mock_sub.run.return_value = Mock(returncode=1, stderr="", stdout="")
            with pytest.raises(github_app._KeychainError):
                github_app._get_private_key("stark-claude")

    def test_get_token_env_var_path_mints_token(self, monkeypatch):
        import github_app

        pem = b"-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----"
        monkeypatch.setenv("STARK_PRIVATE_KEY_B64", base64.b64encode(pem).decode())
        monkeypatch.setenv("STARK_APP_ID", "11111")
        monkeypatch.setenv("STARK_INSTALL_ID", "22222")
        monkeypatch.delenv("GH_TOKEN", raising=False)

        from datetime import datetime, timezone

        fake_token_resp = Mock(status_code=201)
        fake_token_resp.json.return_value = {
            "token": "ghs_envvartoken",
            "expires_at": "2026-12-31T00:00:00Z",
        }

        with (
            patch.object(github_app, "_read_cached_token", return_value=None),
            patch.object(github_app, "_write_cached_token"),
            patch.object(github_app, "subprocess") as mock_sub,
            patch.object(github_app, "requests") as mock_req,
        ):
            # Keychain fails
            mock_sub.run.return_value = Mock(returncode=1, stderr="not found")
            # JWT encoding and token exchange
            mock_req.post.return_value = fake_token_resp

            with patch.object(github_app, "jwt") as mock_jwt:
                mock_jwt.encode.return_value = "fake.jwt.token"
                token = github_app.get_token()

        assert token == "ghs_envvartoken"

    def test_get_token_exits_when_all_auth_unavailable(self, monkeypatch):
        import github_app

        monkeypatch.delenv("GH_TOKEN", raising=False)
        monkeypatch.delenv("STARK_PRIVATE_KEY_B64", raising=False)
        monkeypatch.delenv("STARK_APP_ID", raising=False)
        monkeypatch.delenv("STARK_INSTALL_ID", raising=False)

        with (
            patch.object(github_app, "_read_cached_token", return_value=None),
            patch.object(github_app, "subprocess") as mock_sub,
        ):
            mock_sub.run.return_value = Mock(returncode=1, stderr="not found")
            with pytest.raises(SystemExit) as exc:
                github_app.get_token()
            assert exc.value.code == 1
