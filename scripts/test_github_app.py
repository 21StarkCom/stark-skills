#!/usr/bin/env python3
from __future__ import annotations

import github_app


def test_get_token_app_override_is_scoped(monkeypatch):
    """Passing app= scopes all internal calls without mutating _active_app."""
    seen: list[tuple] = []

    monkeypatch.setattr(github_app, "_active_app", "stark-claude")
    monkeypatch.setattr(
        github_app, "_read_cached_token",
        lambda app=None, installation_id=None: seen.append(("read", app)) or None,
    )
    monkeypatch.setattr(
        github_app, "_get_private_key",
        lambda app=None: seen.append(("key", app)) or "private-key",
    )
    monkeypatch.setattr(
        github_app, "_mint_installation_token",
        lambda private_key, app_id, install_id: (
            seen.append(("mint", app_id, install_id, private_key))
            or ("app-token", 9999999999.0)
        ),
    )
    monkeypatch.setattr(
        github_app, "_write_cached_token",
        lambda token, expires_at, app=None, installation_id=None: seen.append(("write", app, token)),
    )

    token = github_app.get_token(app="stark-gemini")

    assert token == "app-token"
    assert github_app._active_app == "stark-claude"
    assert ("read", "stark-gemini") in seen
    assert ("key", "stark-gemini") in seen
    assert ("write", "stark-gemini", "app-token") in seen
    # _mint_installation_token should be called with gemini's app_id
    mint_calls = [s for s in seen if s[0] == "mint"]
    assert len(mint_calls) == 1
    assert mint_calls[0][1] == "3066689"  # stark-gemini app_id
    assert mint_calls[0][3] == "private-key"
