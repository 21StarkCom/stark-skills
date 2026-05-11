"""Tests for red_team_sandbox — FU-rt1 hermetic execution boundary."""

from __future__ import annotations

from pathlib import Path

import red_team_sandbox as sb


def test_scrub_env_strips_anthropic_key():
    """Most basic invariant: a leaked Anthropic key in inherited env does
    not flow to the codex-CLI subprocess."""
    out = sb.scrub_env({"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-secret"})
    assert "ANTHROPIC_API_KEY" not in out
    assert out["PATH"] == "/usr/bin"


def test_scrub_env_strips_gh_token_and_aws_creds():
    inputs = {
        "PATH": "/usr/bin",
        "GH_TOKEN": "ghs_secret",
        "GITHUB_TOKEN": "ghs_secret_2",
        "AWS_ACCESS_KEY_ID": "AKIA...",
        "AWS_SECRET_ACCESS_KEY": "secret",
        "SLACK_TOKEN": "xoxb-secret",
        "KUBECONFIG": "/home/user/.kube/config",
    }
    out = sb.scrub_env(inputs)
    for key in (
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "SLACK_TOKEN",
        "KUBECONFIG",
    ):
        assert key not in out, f"{key} leaked through scrub_env"


def test_scrub_env_strips_model_credentials():
    """Model credentials must NOT leak into the codex sandbox.

    Earlier the default allowlist included OPENAI_API_KEY / CHATGPT_AUTH_TOKEN
    on the theory the in-process Responses-API fallback might need them —
    but that fallback runs in the PARENT, not the codex subprocess. The
    codex child is the attacker-influenced surface; passing model
    credentials into it lets a prompt-injected tool call exfiltrate them.
    Fixed in PR #430 review (rt1 finding #6).
    """
    inputs = {
        "PATH": "/usr/bin",
        "OPENAI_API_KEY": "sk-real",
        "OPENAI_API_KEY_FILE": "/tmp/keys",
        "OPENAI_API_KEY_LABEL": "stark",
        "CHATGPT_AUTH_TOKEN": "chat-secret",
        "CODEX_HOME": "/Users/x/.codex",
    }
    out = sb.scrub_env(inputs)
    for key in (
        "OPENAI_API_KEY",
        "OPENAI_API_KEY_FILE",
        "OPENAI_API_KEY_LABEL",
        "CHATGPT_AUTH_TOKEN",
        "CODEX_HOME",
    ):
        assert key not in out, f"{key} leaked through scrub_env"


def test_scrub_env_allow_extra():
    out = sb.scrub_env(
        {"PATH": "/usr/bin", "MY_CUSTOM": "value", "OTHER": "drop"},
        allow_extra=frozenset({"MY_CUSTOM"}),
    )
    assert out.get("MY_CUSTOM") == "value"
    assert "OTHER" not in out


def test_scrub_env_default_uses_os_environ(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-leak")
    monkeypatch.setenv("PATH", "/usr/bin")
    out = sb.scrub_env(None)
    assert "ANTHROPIC_API_KEY" not in out
    assert "PATH" in out


def test_isolate_workdir_yields_empty_directory():
    with sb.isolate_workdir() as tmp:
        assert isinstance(tmp, Path)
        assert tmp.is_dir()
        assert list(tmp.iterdir()) == []


def test_isolate_workdir_cleans_up_on_exit():
    with sb.isolate_workdir() as tmp:
        path = tmp
        (path / "sentinel.txt").write_text("hi")
        assert (path / "sentinel.txt").exists()
    # After context exit the directory is gone, even though we wrote into it.
    assert not path.exists()


def test_isolate_workdir_cleans_up_even_on_exception():
    captured: list[Path] = []
    try:
        with sb.isolate_workdir() as tmp:
            captured.append(tmp)
            raise RuntimeError("boom")
    except RuntimeError:
        pass
    assert captured
    assert not captured[0].exists()


def test_scrub_env_does_not_pass_through_home():
    """PR-#430 round-3 review fix #7: HOME used to ride along so codex
    could read ``~/.codex``, but that also exposed ``~/.ssh``, ``~/.aws``,
    and other dotfiles to a prompt-injected codex run. The synthetic-home
    pairing now provides ``HOME`` separately, so ``scrub_env`` must drop
    the inherited HOME unconditionally."""
    out = sb.scrub_env({"PATH": "/usr/bin", "HOME": "/Users/operator"})
    assert "HOME" not in out


def test_synthetic_home_exposes_only_codex_subdir(tmp_path):
    """The synthetic HOME contains a symlink to ``~/.codex`` and nothing
    else from the operator's real home."""
    # Build a fake real-home with the dotfiles a real one would have.
    real = tmp_path / "real-home"
    (real / ".codex").mkdir(parents=True)
    (real / ".codex" / "auth.json").write_text("token-stub")
    (real / ".ssh").mkdir()
    (real / ".ssh" / "id_rsa").write_text("PRIVATE-KEY-MATERIAL")
    (real / ".aws").mkdir()
    (real / ".aws" / "credentials").write_text("aws-secret")

    with sb.synthetic_home(real_home=real) as fake:
        # Only .codex is reachable.
        assert (fake / ".codex").exists()
        assert (fake / ".codex" / "auth.json").read_text() == "token-stub"
        # Real home's other dotfiles are NOT exposed.
        assert not (fake / ".ssh").exists()
        assert not (fake / ".aws").exists()


def test_synthetic_home_is_cleaned_up_on_exit(tmp_path):
    real = tmp_path / "real-home"
    (real / ".codex").mkdir(parents=True)
    (real / ".codex" / "auth.json").write_text("x")
    captured: list[Path] = []
    with sb.synthetic_home(real_home=real) as fake:
        captured.append(fake)
        assert fake.exists()
    assert not captured[0].exists()
    # Real home untouched.
    assert (real / ".codex" / "auth.json").exists()


def test_synthetic_home_works_when_codex_dir_missing(tmp_path):
    """If ``~/.codex`` doesn't exist (codex not configured), the synthetic
    home is still a fresh empty dir — codex will fail with a clear auth
    error rather than silently inheriting the real home."""
    real = tmp_path / "real-home"
    real.mkdir()
    with sb.synthetic_home(real_home=real) as fake:
        assert fake.is_dir()
        assert list(fake.iterdir()) == []


def test_wrap_command_is_passthrough_today():
    """Sanity: wrap_command exists as a feature-flag hook for future
    bubblewrap/sandbox-exec wrappers; today it returns the input
    untouched."""
    cmd = ["codex", "exec", "-m", "o3", "-"]
    assert sb.wrap_command(cmd) == cmd


def test_preflight_sandbox_returns_status_and_message():
    """preflight runs end-to-end against the host. We don't assert ready vs.
    degraded here (codex CLI may or may not be installed in CI) — only that
    the contract holds."""
    status, message = sb.preflight_sandbox()
    assert status in {"ready", "degraded", "failed"}
    assert isinstance(message, str)
    assert message


# ---------------------------------------------------------------------------
# Integration: dispatch_codex sandbox path scrubs env + isolates cwd
# ---------------------------------------------------------------------------


def test_dispatch_codex_sandbox_path_scrubs_env_and_uses_temp_cwd(monkeypatch):
    """End-to-end: when sandbox=True, codex sees a scrubbed env and an
    empty temp cwd, regardless of the cwd / env the caller passes."""
    import subprocess

    import stark_red_team as rt

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["env"] = dict(kwargs.get("env") or {})
        captured["cwd"] = kwargs.get("cwd")
        return subprocess.CompletedProcess(
            args=cmd, returncode=0,
            stdout='{"synthesis":"S","findings":[]}', stderr="",
        )

    monkeypatch.setattr("stark_red_team.subprocess.run", fake_run)

    leaky_env = {
        "PATH": "/usr/bin",
        "ANTHROPIC_API_KEY": "sk-secret",
        "GH_TOKEN": "ghs-secret",
    }
    rt.dispatch_codex(
        prompt="hi",
        model="o3",
        cwd="/Users/aryeh/Code/Playground/stark-skills",  # caller's repo
        timeout_s=60,
        env=leaky_env,
        sandbox=True,
    )

    # cwd swapped to an empty temp dir, NOT the caller's repo
    cwd = captured["cwd"]
    assert cwd != "/Users/aryeh/Code/Playground/stark-skills"
    assert cwd is not None and Path(cwd).name.startswith("stark-rt-")

    # leaky env scrubbed: PATH retained, secrets dropped
    env = captured["env"]
    assert env.get("PATH") == "/usr/bin"
    assert "ANTHROPIC_API_KEY" not in env
    assert "GH_TOKEN" not in env


def test_dispatch_codex_sandbox_off_passes_cwd_and_env_through(monkeypatch):
    """sandbox=False is the escape hatch for paths that pre-isolate."""
    import subprocess

    import stark_red_team as rt

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["env"] = dict(kwargs.get("env") or {})
        captured["cwd"] = kwargs.get("cwd")
        return subprocess.CompletedProcess(
            args=cmd, returncode=0,
            stdout='{"synthesis":"S","findings":[]}', stderr="",
        )

    monkeypatch.setattr("stark_red_team.subprocess.run", fake_run)

    rt.dispatch_codex(
        prompt="hi",
        model="o3",
        cwd="/some/cwd",
        timeout_s=60,
        env={"CUSTOM": "value", "PATH": "/usr/bin"},
        sandbox=False,
    )
    assert captured["cwd"] == "/some/cwd"
    assert captured["env"].get("CUSTOM") == "value"
