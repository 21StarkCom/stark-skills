"""Pytest config: adds scripts/ to sys.path so `import multi_review` works."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))


@pytest.fixture(autouse=True)
def _clear_config_cache(tmp_path, monkeypatch):
    """Reset config_loader's lru_cache and isolate tests from the real config.

    Redirects CONFIG_PATH to a non-existent tmp file so config_loader falls
    back to DEFAULT_*, making tests deterministic regardless of whatever is
    symlinked at ~/.claude/code-review/config.json on the host.
    """
    import config_loader
    config_loader.load_config.cache_clear()
    monkeypatch.setattr(config_loader, "CONFIG_PATH", tmp_path / "no-config.json")
    yield
    config_loader.load_config.cache_clear()


@pytest.fixture(autouse=True)
def _ensure_anthropic_agents(monkeypatch):
    """Ensure ANTHROPIC_AGENTS is present so claude env construction doesn't
    raise in tests that don't explicitly mock the environment."""
    if "ANTHROPIC_AGENTS" not in os.environ:
        monkeypatch.setenv("ANTHROPIC_AGENTS", "sk-ant-test-fixture-key")


@pytest.fixture(autouse=True)
def _stub_github_app_token(request, monkeypatch):
    """Stub github_app.get_token so dispatcher tests don't need keychain access.

    Tests that specifically exercise github_app (test_github_app*.py) opt out
    by setting the pytest marker `no_github_app_stub` or by re-patching inside
    the test.
    """
    if request.node.get_closest_marker("no_github_app_stub"):
        return
    # Skip stubbing for tests that exercise github auth / token plumbing directly.
    nodeid = request.node.nodeid
    if any(
        name in nodeid
        for name in ("test_github_app", "test_github_projects", "test_pr_commenter")
    ):
        return
    try:
        import github_app
    except ImportError:
        return
    monkeypatch.setattr(github_app, "get_token", lambda app=None: "ghs_test_fixture_token")
