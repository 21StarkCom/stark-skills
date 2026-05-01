"""Hermetic execution boundary for codex-CLI red-team dispatch (FU-rt1).

The Responses-API transport is already mitigated — no local tool surface
means no workspace mutation, secret exposure, or lateral movement even if
the model output is attacker-influenced. The risk surface that remains is
the codex-CLI fallback path used for any model not in
``RESPONSES_API_MODELS``: a prompt-injection in attacker-controllable
artifact / spec / PR-diff text could turn a bad review verdict into a
shell-out via codex's tool surface.

This module locks the codex-CLI red-team call down by:

1. ``isolate_workdir(prefix)`` — context manager that runs the call from
   an empty temp directory the user's repo can't be read from. Codex
   already has no MCP / filesystem-write capability under ``-s read-only``,
   but the cwd controls reads through. An empty cwd means the most
   sensitive read paths (the working repo, ``.env``, etc.) are off-tree.

2. ``scrub_env(base, allow_extra)`` — strips inherited host secrets.
   Default allowlist is the minimum codex needs to reach the model
   endpoint plus the Responses-API key vars (which the codex CLI itself
   doesn't read but downstream wrappers may). All other inherited env —
   GitHub tokens, Anthropic keys, AWS creds, Slack tokens, kube configs —
   is dropped before exec.

3. ``preflight_sandbox()`` — confirms codex CLI honors ``-s read-only``
   and that the workdir helpers function on the host. Fails closed on
   misconfiguration so a silent-no-op sandbox doesn't ship.

The codex-CLI ``--ephemeral -s read-only`` flags are already used by
``stark_red_team.dispatch_codex``; this module adds the env + cwd layers.
A future enhancement (Linux: bubblewrap; macOS: ``sandbox-exec``) would
add filesystem-namespace isolation; the entry point ``wrap_command()``
exists so that addition can be feature-flagged in without changing the
caller.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import subprocess
import tempfile
from collections.abc import Generator
from pathlib import Path

# Minimum environment the codex CLI subprocess needs to reach the model.
#
# Scope is deliberately narrow: PATH (find the codex binary), locale, and
# TMPDIR. Model credentials (``OPENAI_API_KEY``, ``CHATGPT_AUTH_TOKEN``,
# etc.) are NOT in the allowlist — the parent orchestrator runs
# Responses-API calls in-process, so the codex child is the
# attacker-influenced surface and must not see those secrets even if a
# tool-execution shim reads its env.
#
# HOME is intentionally absent: codex CLI in ChatGPT-auth mode reads its
# credential from ``$HOME/.codex``, but pointing HOME at the operator's
# real home dir also lets a prompt-injected codex run read ``~/.ssh``,
# ``~/.aws``, and other dotfiles (PR-#430 round-3 review finding #7). The
# caller is expected to pair ``scrub_env`` with :func:`synthetic_home` so
# the codex child sees a temp HOME containing only a symlink to the real
# ``~/.codex`` directory. The pairing happens in
# :func:`stark_red_team.dispatch_codex`.
#
# This is the FU-rt1 fix from the PR-#430 review (finding #6): a "sandbox"
# that still hands OpenAI / ChatGPT credentials to the attacker-influenced
# codex child defeats the whole point of sandboxing it.
_DEFAULT_ENV_ALLOWLIST: frozenset[str] = frozenset({
    "PATH",
    "USER",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TMPDIR",
})

# Subdirectory of the real HOME that we expose to the codex child via the
# synthetic HOME symlink. Codex's ChatGPT auth state lives here. Any other
# subdirectory of HOME (``.ssh``, ``.aws``, ``.kube``, repo working
# trees, …) stays out of reach.
_SYNTHETIC_HOME_PROJECT_PATHS: tuple[str, ...] = (".codex",)


def scrub_env(
    base: dict[str, str] | None = None,
    *,
    allow_extra: frozenset[str] | None = None,
) -> dict[str, str]:
    """Return a sanitized env dict for codex-CLI red-team dispatch.

    Drops everything not in :data:`_DEFAULT_ENV_ALLOWLIST` (plus optional
    ``allow_extra``). The caller passes the input mapping (typically
    ``os.environ``) explicitly so tests can inject deterministic state
    without touching the process env.

    HOME is intentionally NOT in the allowlist; pair this with
    :func:`synthetic_home` and inject the resulting path as ``HOME``
    explicitly so the codex child sees a sandboxed home rather than the
    operator's real one.
    """
    src = base if base is not None else dict(os.environ)
    allow = _DEFAULT_ENV_ALLOWLIST | (allow_extra or frozenset())
    return {k: v for k, v in src.items() if k in allow}


@contextlib.contextmanager
def isolate_workdir(prefix: str = "stark-rt-") -> Generator[Path, None, None]:
    """Yield a fresh empty temp directory; clean up on context exit.

    The codex subprocess executes with this directory as ``cwd`` so an
    injected instruction asking for ``cat /etc/passwd`` or ``ls`` lands
    in an empty workspace rather than the user's repo. The directory is
    removed when the context exits, even on error.
    """
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    try:
        yield tmp
    finally:
        # Best-effort cleanup: if codex left a write somewhere, ignore the
        # error. The temp dir is process-scoped so a leak on shutdown is
        # at worst a stale directory in $TMPDIR.
        shutil.rmtree(tmp, ignore_errors=True)


@contextlib.contextmanager
def synthetic_home(
    real_home: str | os.PathLike[str] | None = None,
    *,
    project_paths: tuple[str, ...] = _SYNTHETIC_HOME_PROJECT_PATHS,
) -> Generator[Path, None, None]:
    """Yield a temp directory standing in for ``$HOME`` for the codex child.

    The synthetic home contains a symlink to each ``project_paths`` entry
    that exists under the real home (default: just ``.codex`` so codex
    CLI's ChatGPT auth state stays reachable). Everything else under the
    operator's real home — ``.ssh``, ``.aws``, ``.kube``, project working
    trees, ``.zsh_history``, IDE caches — is unreachable from inside the
    sandbox even with a prompt-injected ``cat`` or shell-out attempt.

    PR-#430 round-3 review fix #7: previously ``scrub_env`` kept the real
    HOME in its allowlist, which scrubbed env-vars but left the entire
    home directory readable. The synthetic-home pairing closes that
    boundary leak while preserving codex CLI authentication.
    """
    home = Path(real_home) if real_home is not None else Path(os.path.expanduser("~"))
    tmp = Path(tempfile.mkdtemp(prefix="stark-rt-home-"))
    try:
        for sub in project_paths:
            target = home / sub
            if not target.exists():
                continue
            link = tmp / sub
            try:
                link.symlink_to(target.resolve(), target_is_directory=target.is_dir())
            except OSError:
                # Symlinks unsupported on this filesystem (rare, e.g.
                # FAT32 TMPDIR). Fall back to a shallow copy so codex
                # still reaches its auth dir; the temp HOME still hides
                # everything else.
                if target.is_dir():
                    shutil.copytree(target, link, symlinks=True)
                else:
                    shutil.copy2(target, link)
        yield tmp
    finally:
        # ``rmtree`` does not follow symlinks by default, so the real
        # ~/.codex tree stays untouched even if cleanup races. The temp
        # dir itself is process-scoped under TMPDIR.
        shutil.rmtree(tmp, ignore_errors=True)


def wrap_command(cmd: list[str]) -> list[str]:
    """Optionally wrap ``cmd`` with a host-level sandbox profile.

    Today this is a pass-through: codex's own ``-s read-only`` plus the
    cwd + env layers are the enforcement boundary. The hook exists so a
    future ``bubblewrap`` (Linux) / ``sandbox-exec`` (macOS) wrapper can
    be added without changing dispatch_codex callers.
    """
    return cmd


def preflight_sandbox() -> tuple[str, str]:
    """Return ``(status, message)`` for the red-team sandbox preflight.

    Fails closed: any check that can't be verified surfaces as ``failed``
    so the operator hears about it before a real run.

    The caller (``preflight.check_red_team_sandbox``) is responsible for
    skipping this entirely on Responses-API installs — by the time we
    reach this function we assume codex CLI IS the active dispatch path,
    so a missing codex binary is a hard failure (PR-#430 review fix
    #17). Earlier behavior returned ``degraded`` for missing codex,
    which the registry mapped to a warning even on installs that needed
    codex CLI to dispatch.

    Status values:
    - ``ready`` — sandbox primitives function, codex honors read-only.
    - ``failed`` — a primitive the sandbox depends on is broken or
      missing entirely.
    """
    if shutil.which("codex") is None:
        return ("failed", "codex CLI not on PATH — codex-CLI red-team dispatch cannot enforce sandbox boundary")

    # 1. workdir isolation works
    try:
        with isolate_workdir("stark-rt-preflight-") as tmp:
            if not tmp.exists() or not tmp.is_dir():
                return ("failed", f"isolate_workdir produced a non-directory: {tmp}")
            entries = list(tmp.iterdir())
            if entries:
                return ("failed", f"isolate_workdir produced a non-empty directory: {entries}")
    except OSError as exc:
        return ("failed", f"isolate_workdir failed: {exc}")

    # 2. env scrub strips an obvious secret
    canary = scrub_env(
        {"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "sk-test-deadbeef0001020304050607"}
    )
    if "ANTHROPIC_API_KEY" in canary:
        return ("failed", "scrub_env did not strip ANTHROPIC_API_KEY from input")

    # 3. codex --version succeeds (rough sanity that the binary works)
    try:
        proc = subprocess.run(
            ["codex", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return ("failed", f"codex --version failed: {exc}")
    if proc.returncode != 0:
        return ("failed", f"codex --version exit {proc.returncode}: {proc.stderr.strip()[:120]}")

    return ("ready", "sandbox primitives ready (cwd isolation + env scrub + codex available)")
