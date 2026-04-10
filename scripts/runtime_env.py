#!/usr/bin/env python3
"""Build isolated environment dicts for subagent dispatches.

Controls which env vars reach CLI subprocesses, injects GitHub App tokens for
operations that need repo access, manages process-scoped temp dirs, and
enforces that ANTHROPIC_API_KEY never leaks into subprocesses.
"""
from __future__ import annotations

import atexit
import os
import shutil
import sys
import uuid
from pathlib import Path

from config_loader import get_runtime_config, load_config
import github_app

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Operations that require a GitHub App token (review bot identity).
_GH_TOKEN_OPS: frozenset[str] = frozenset({"review"})

# Operations using the user's native gh auth — no bot token injected.
_USER_AUTH_OPS: frozenset[str] = frozenset({"pr_create", "issue_ops"})

# Vertex AI config — mirrors claude_utils._VERTEX_ENV to avoid circular import.
# These are injected unconditionally for the claude agent regardless of
# whether the vars are already in os.environ.
# Global region required for latest model versions (opus-4-6, sonnet-4-6).
_VERTEX_ENV: dict[str, str] = {
    "CLAUDE_CODE_USE_VERTEX": "1",
    "ANTHROPIC_VERTEX_PROJECT_ID": "infra-ai-platform",
    "CLOUD_ML_REGION": "global",
}

# This key must NEVER appear in any subprocess environment.
_BLOCKED_KEY = "ANTHROPIC_API_KEY"


# ---------------------------------------------------------------------------
# Stale temp-dir cleanup
# ---------------------------------------------------------------------------


def _cleanup_stale_temp_dirs(prefix: str) -> None:
    """Remove temp dirs from dead processes.

    Format: /tmp/{prefix}-{pid}-{uuid8}.
    Iterates /tmp/, parses the PID from the dirname, and removes dirs whose
    owner process no longer exists.
    """
    try:
        tmp_entries = list(Path("/tmp").iterdir())
    except OSError:
        return

    marker = prefix + "-"
    for d in tmp_entries:
        if not d.is_dir() or not d.name.startswith(marker):
            continue
        # Extract PID: everything between marker and next '-'
        remainder = d.name[len(marker):]  # e.g. "12345-ab12cd34"
        pid_str = remainder.split("-")[0]
        try:
            pid = int(pid_str)
        except ValueError:
            continue
        # Check if the process is still alive
        try:
            os.kill(pid, 0)
            # Signal 0 succeeded → process alive, skip
        except ProcessLookupError:
            # Process is dead — remove stale dir
            try:
                shutil.rmtree(str(d), ignore_errors=True)
            except OSError:
                pass
        except PermissionError:
            pass  # Alive but owned by another user


_cleanup_done: bool = False


def _run_cleanup_once(prefix: str) -> None:
    """Run stale temp-dir cleanup at most once per process."""
    global _cleanup_done
    if not _cleanup_done:
        _cleanup_stale_temp_dirs(prefix)
        _cleanup_done = True


def _make_temp_dir(prefix: str) -> str:
    """Create a process-scoped temp dir with 0o700 permissions.

    Registers an atexit handler to remove it on process exit.
    Returns the path as a string.
    """
    uid8 = uuid.uuid4().hex[:8]
    path = Path(f"/tmp/{prefix}-{os.getpid()}-{uid8}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    atexit.register(shutil.rmtree, str(path), True)
    return str(path)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_agent_env(agent: str, operation: str) -> dict[str, str]:
    """Build a sanitized environment dict for a subagent subprocess.

    Args:
        agent: "claude", "codex", or "gemini".
        operation: One of "review", "pr_create", "issue_ops", or other.

    Returns:
        A dict of env vars safe to pass to subprocess.Popen(env=...).
        ANTHROPIC_API_KEY is never present.
        GH_TOKEN is present only when operation == "review".
    """
    runtime_cfg = get_runtime_config()
    full_cfg = load_config()

    allowlist: set[str] = set(runtime_cfg.get("subagent_env_allowlist", []))
    github_apps: dict[str, str] = full_cfg.get("github_apps", {})

    # Start from allowlisted os.environ keys, excluding blocked keys.
    env: dict[str, str] = {
        k: v
        for k, v in os.environ.items()
        if k in allowlist and k != _BLOCKED_KEY
    }

    # Inject Vertex AI vars for the claude agent (unconditional — needed for ADC auth).
    if agent == "claude":
        env.update(_VERTEX_ENV)

    # GH_TOKEN: inject bot token only for review operations.
    if operation in _GH_TOKEN_OPS:
        app_name = github_apps.get(agent, f"stark-{agent}")
        env["GH_TOKEN"] = github_app.get_token(app=app_name)
    elif operation not in _USER_AUTH_OPS:
        print(
            f"runtime_env: warning: unknown operation {operation!r} for agent {agent!r};"
            " defaulting to no GH_TOKEN",
            file=sys.stderr,
        )

    # Final safety rail — strip the API key even if it somehow slipped through.
    env.pop(_BLOCKED_KEY, None)

    # Temp dir lifecycle: create a process-scoped dir and inject its path.
    prefix = runtime_cfg.get("temp_dir_prefix", "stark-env")
    _run_cleanup_once(prefix)
    env["STARK_AGENT_TMPDIR"] = _make_temp_dir(prefix)

    return env
