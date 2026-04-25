#!/usr/bin/env python3
from __future__ import annotations

import pytest

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


def test_get_private_key_raises_keychain_error_when_security_binary_missing(monkeypatch):
    """On Linux runners the `security` binary is absent, so subprocess.run
    raises FileNotFoundError before we ever inspect a returncode. The
    raw error must be converted to _KeychainError so `get_token`'s
    fallback chain (env vars → GH_TOKEN) can run — otherwise the CI
    `Post graph comment` step crashes with FileNotFoundError instead of
    using STARK_PRIVATE_KEY_B64."""
    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "security")

    monkeypatch.setattr(github_app.subprocess, "run", fake_run)

    with pytest.raises(github_app._KeychainError, match="Keychain unavailable"):
        github_app._get_private_key()


def test_get_token_falls_through_to_env_when_keychain_missing(monkeypatch):
    """End-to-end: with `security` missing AND STARK_* env vars set,
    `get_token` must mint via the env-var path instead of crashing.
    This is the exact CI scenario that broke `Post graph comment`."""
    import base64

    monkeypatch.setattr(github_app, "_active_app", "stark-claude")
    monkeypatch.setattr(
        github_app, "_read_cached_token",
        lambda app=None, installation_id=None: None,
    )

    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "security")

    monkeypatch.setattr(github_app.subprocess, "run", fake_run)

    monkeypatch.setenv("STARK_PRIVATE_KEY_B64", base64.b64encode(b"env-key").decode())
    monkeypatch.setenv("STARK_APP_ID", "12345")
    monkeypatch.setenv("STARK_INSTALL_ID", "67890")

    minted: list[tuple] = []

    def fake_mint(private_key, app_id, install_id):
        minted.append((private_key, app_id, install_id))
        return ("env-token", 9999999999.0)

    monkeypatch.setattr(github_app, "_mint_installation_token", fake_mint)
    monkeypatch.setattr(
        github_app, "_write_cached_token",
        lambda token, expires_at, app=None, installation_id=None: None,
    )

    token = github_app.get_token()

    assert token == "env-token"
    assert minted == [("env-key", "12345", "67890")]


def test_get_token_falls_through_to_gh_token_when_stark_envs_empty(monkeypatch):
    """When STARK_* env vars are present but empty (GitHub Actions exposes
    unset secrets as empty strings), the env-var path must raise KeyError so
    the GH_TOKEN fallback fires. Without this, `_get_private_key_from_env`
    proceeds with empty strings and crashes inside JWT signing with
    InvalidKeyError. Regression: `Post graph comment` workflow on every PR."""
    monkeypatch.setattr(github_app, "_active_app", "stark-claude")
    monkeypatch.setattr(
        github_app, "_read_cached_token",
        lambda app=None, installation_id=None: None,
    )

    def fake_run(*args, **kwargs):
        raise FileNotFoundError(2, "No such file or directory", "security")

    monkeypatch.setattr(github_app.subprocess, "run", fake_run)

    # Simulate GH Actions: STARK_* secrets are empty, GITHUB_TOKEN is provided
    monkeypatch.setenv("STARK_PRIVATE_KEY_B64", "")
    monkeypatch.setenv("STARK_APP_ID", "")
    monkeypatch.setenv("STARK_INSTALL_ID", "")
    monkeypatch.setenv("GH_TOKEN", "gha-fallback-token")

    token = github_app.get_token()

    assert token == "gha-fallback-token"


def test_get_private_key_from_env_rejects_empty_strings(monkeypatch):
    """Empty env vars must raise KeyError, not return empty-string tuples."""
    monkeypatch.setenv("STARK_PRIVATE_KEY_B64", "")
    monkeypatch.setenv("STARK_APP_ID", "")
    monkeypatch.setenv("STARK_INSTALL_ID", "")
    with pytest.raises(KeyError):
        github_app._get_private_key_from_env()

    # Partially set is also rejected
    import base64
    monkeypatch.setenv("STARK_PRIVATE_KEY_B64", base64.b64encode(b"k").decode())
    monkeypatch.setenv("STARK_APP_ID", "123")
    monkeypatch.setenv("STARK_INSTALL_ID", "")
    with pytest.raises(KeyError):
        github_app._get_private_key_from_env()
