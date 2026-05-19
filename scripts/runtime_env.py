#!/usr/bin/env python3
"""Build isolated environment dicts for subagent dispatches.

Controls which env vars reach CLI subprocesses, injects GitHub App tokens for
operations that need repo access, manages process-scoped temp dirs, and
injects ANTHROPIC_API_KEY (from the ANTHROPIC_AGENTS host var) for the claude
agent while keeping it out of codex/gemini subprocesses.
"""
from __future__ import annotations

import atexit
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from config_loader import get_runtime_config, load_config

# TS CLI for GitHub App auth (replaces former in-process `import github_app`).
# Path is resolved relative to the repo root (one level up from scripts/).
_REPO_ROOT = Path(__file__).resolve().parent.parent
_GITHUB_APP_TS = str(_REPO_ROOT / "tools" / "github_app.ts")


def _get_token_via_ts(app_name: str) -> str:
    """Mint / fetch a GitHub App installation token via the TS CLI.

    Shells out to `node --experimental-strip-types tools/github_app.ts
    --app NAME token`. The TS CLI shares the on-disk token cache with any
    prior Python invocations so this is cheap on the cache-hit path.
    """
    result = subprocess.run(
        ["node", "--experimental-strip-types", _GITHUB_APP_TS, "--app", app_name, "token"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"github_app.ts token failed for app={app_name!r}: "
            f"{result.stderr.strip() or 'unknown error'}"
        )
    return result.stdout.strip()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Operations that require a GitHub App token (review bot identity).
_GH_TOKEN_OPS: frozenset[str] = frozenset({"review"})

# Operations using the user's native gh auth — no bot token injected.
# "local" covers Claude callers that never touch GitHub (e.g. forge_fix_loop)
# and just need a sanitized subprocess env.
_USER_AUTH_OPS: frozenset[str] = frozenset({"pr_create", "issue_ops", "local"})

# Host env var holding the Anthropic API key. Read at dispatch time and
# passed to the claude subprocess as ANTHROPIC_API_KEY; never reaches
# codex or gemini subprocesses.
_API_KEY_SOURCE_VAR = "ANTHROPIC_AGENTS"

# Host env keys that must NEVER appear in subprocess environments as-is.
# ANTHROPIC_API_KEY: host value is unreliable — we re-inject from the source var.
# ANTHROPIC_AGENTS: internal; never leaks verbatim.
_BLOCKED_KEYS: frozenset[str] = frozenset({"ANTHROPIC_API_KEY", _API_KEY_SOURCE_VAR})


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
        ANTHROPIC_API_KEY is injected for the claude agent (sourced from
        ANTHROPIC_AGENTS) and absent from codex/gemini envs.
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
        if k in allowlist and k not in _BLOCKED_KEYS
    }

    # Inject ANTHROPIC_API_KEY for the claude agent, sourced from ANTHROPIC_AGENTS.
    if agent == "claude":
        source_key = os.environ.get(_API_KEY_SOURCE_VAR)
        if not source_key:
            raise RuntimeError(
                f"{_API_KEY_SOURCE_VAR} not set in environment. "
                "Source your Anthropic key file before dispatching claude."
            )
        env["ANTHROPIC_API_KEY"] = source_key

    # GH_TOKEN: inject bot token only for review operations.
    if operation in _GH_TOKEN_OPS:
        app_name = github_apps.get(agent, f"stark-{agent}")
        env["GH_TOKEN"] = _get_token_via_ts(app_name)
    elif operation not in _USER_AUTH_OPS:
        print(
            f"runtime_env: warning: unknown operation {operation!r} for agent {agent!r};"
            " defaulting to no GH_TOKEN",
            file=sys.stderr,
        )

    # Final safety rail — never leak the raw source key var.
    env.pop(_API_KEY_SOURCE_VAR, None)
    # For non-claude agents, ensure ANTHROPIC_API_KEY is absent.
    if agent != "claude":
        env.pop("ANTHROPIC_API_KEY", None)

    # Temp dir lifecycle: create a process-scoped dir and inject its path.
    prefix = runtime_cfg.get("temp_dir_prefix", "stark-env")
    _run_cleanup_once(prefix)
    env["STARK_AGENT_TMPDIR"] = _make_temp_dir(prefix)

    return env
