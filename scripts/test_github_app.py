#!/usr/bin/env python3
from __future__ import annotations

import github_app


def test_get_token_app_override_is_scoped(monkeypatch):
    seen: list[tuple] = []

    monkeypatch.setattr(github_app, "_active_app", "stark-claude")
    monkeypatch.setattr(github_app, "_read_cached_token", lambda app=None: seen.append(("read", app)) or None)
    monkeypatch.setattr(github_app, "_get_private_key", lambda app=None: seen.append(("key", app)) or "private-key")
    monkeypatch.setattr(
        github_app,
        "_make_jwt",
        lambda private_key, app=None: seen.append(("jwt", app, private_key)) or f"jwt-{app}",
    )
    monkeypatch.setattr(
        github_app,
        "_write_cached_token",
        lambda token, expires_at, app=None: seen.append(("write", app, token)),
    )

    class FakeResponse:
        status_code = 201
        text = ""

        def json(self):
            return {"token": "app-token", "expires_at": "2026-03-04T06:13:16Z"}

    def fake_post(url, headers, timeout):
        seen.append(("post", url, headers["Authorization"]))
        return FakeResponse()

    monkeypatch.setattr(github_app.requests, "post", fake_post)

    token = github_app.get_token(app="stark-gemini")

    assert token == "app-token"
    assert github_app._active_app == "stark-claude"
    assert ("read", "stark-gemini") in seen
    assert ("key", "stark-gemini") in seen
    assert ("jwt", "stark-gemini", "private-key") in seen
    assert ("write", "stark-gemini", "app-token") in seen
    assert any(item[0] == "post" and item[2] == "Bearer jwt-stark-gemini" for item in seen)
