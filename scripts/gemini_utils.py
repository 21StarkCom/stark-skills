"""Shared utilities for Gemini CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Gemini CLI.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Generator
from pathlib import Path

try:
    from config_loader import get_model_id, is_agent_enabled
except ImportError:  # pragma: no cover - backward compat for older installs
    def get_model_id(agent: str) -> str | None:
        return None

    def is_agent_enabled(agent: str) -> bool:
        return True

# Default model — pinned to avoid auto-routing unpredictability in automation.
# Available on Vertex AI via the global endpoint (GOOGLE_CLOUD_LOCATION=global).
GEMINI_MODEL = "gemini-3.1-pro-preview"


class AgentDisabledError(RuntimeError):
    pass


def get_gemini_model() -> str:
    if not is_agent_enabled("gemini"):
        raise AgentDisabledError("gemini agent is disabled in config")
    return get_model_id("gemini") or GEMINI_MODEL

# Auth files to copy from the real Gemini home to isolated session dirs.
_AUTH_FILES = ("settings.json", "oauth_creds.json", "google_accounts.json", "installation_id")

# ── API key fallback ──────────────────────────────────────────────────

_gemini_api_key_cache: str | None = None

_RED = "\033[1;31m"
_RED_BG = "\033[1;37;41m"
_RESET = "\033[0m"
_FALLBACK_LOG = Path.home() / ".claude" / "code-review" / "gemini-api-key-fallback.log"


def get_gemini_api_key() -> str | None:
    """Retrieve Gemini API key from macOS Keychain (cached)."""
    global _gemini_api_key_cache
    if _gemini_api_key_cache is not None:
        return _gemini_api_key_cache or None
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", "GEMINI_API_KEY", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0 and result.stdout.strip():
            _gemini_api_key_cache = result.stdout.strip()
            return _gemini_api_key_cache
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    _gemini_api_key_cache = ""
    return None


def log_api_key_fallback(agent: str, task: str, reason: str) -> None:
    """Log API key fallback event to stderr (red+border) and to a persistent log file."""
    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    border = f"{_RED_BG}{'=' * 60}{_RESET}"
    print(border, file=sys.stderr)
    print(f"{_RED_BG}  GEMINI API KEY FALLBACK  {_RESET}", file=sys.stderr)
    print(f"{_RED}  Agent: {agent}:{task}{_RESET}", file=sys.stderr)
    print(f"{_RED}  Reason: {reason}{_RESET}", file=sys.stderr)
    print(f"{_RED}  Vertex AI auth failed -> using GEMINI_API_KEY from Keychain{_RESET}", file=sys.stderr)
    print(border, file=sys.stderr)
    try:
        _FALLBACK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(_FALLBACK_LOG, "a") as f:
            f.write(f"{ts}  {agent}:{task}  reason={reason}\n")
    except OSError:
        pass


# Error patterns that indicate Vertex AI auth failure (retryable with API key).
GEMINI_AUTH_ERROR_PATTERNS = ("ModelNotFound", "403", "PERMISSION_DENIED")


def should_fallback_to_api_key(stderr: str) -> bool:
    """Check if a Gemini CLI error looks like a Vertex AI auth failure."""
    return any(p in stderr for p in GEMINI_AUTH_ERROR_PATTERNS)


def try_gemini_api_key_fallback(
    run_kwargs: dict,
    context_label: str,
    stderr_snippet: str,
) -> bool:
    """Attempt Gemini API key fallback after a Vertex AI auth error.

    Mutates *run_kwargs* in place to inject GEMINI_API_KEY.
    Returns True if fallback was applied (caller should retry), False otherwise.
    """
    api_key = get_gemini_api_key()
    if not api_key or "env" not in run_kwargs:
        return False
    log_api_key_fallback("gemini", context_label, stderr_snippet[:120])
    run_kwargs["env"]["GEMINI_API_KEY"] = api_key
    return True


# ── Session isolation ─────────────────────────────────────────────────


def setup_gemini_home(
    prefix: str,
    project_dir: str,
    project_label: str = "session",
    approval_mode: str | None = None,
) -> str:
    """Create an isolated GEMINI_CLI_HOME with auth files and project scope.

    Args:
        prefix: Temp directory prefix (e.g. "gemini-review-").
        project_dir: Absolute path to the project directory.
        project_label: Label for the project in projects.json.
        approval_mode: If set, patch the copied settings.json with this
            ``defaultApprovalMode`` (e.g. "plan", "yolo"). This is the
            correct way to set approval mode — ``--approval-mode`` is not
            a documented CLI flag in Gemini CLI v0.34+.

    Returns the path to the temporary home directory (caller must clean up).
    """
    import tempfile
    gemini_home = tempfile.mkdtemp(prefix=prefix)
    gemini_dir = os.path.join(gemini_home, ".gemini")
    os.makedirs(gemini_dir, exist_ok=True)

    real_gemini = os.environ.get("GEMINI_CLI_HOME", os.path.expanduser("~"))
    real_gemini_dir = os.path.join(real_gemini, ".gemini")
    for auth_file in _AUTH_FILES:
        src = os.path.join(real_gemini_dir, auth_file)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(gemini_dir, auth_file))

    # Patch settings.json for headless dispatch:
    # - Preserve the user's auth config (Vertex AI, API key, etc.) as-is
    # - Set approval mode if requested
    # API key fallback is handled by try_gemini_api_key_fallback() on auth errors.
    settings_path = os.path.join(gemini_dir, "settings.json")
    settings: dict = {}
    if os.path.exists(settings_path):
        with open(settings_path) as f:
            settings = json.load(f)
    if approval_mode:
        settings["defaultApprovalMode"] = approval_mode
    with open(settings_path, "w") as f:
        json.dump(settings, f)

    with open(os.path.join(gemini_dir, "projects.json"), "w") as f:
        json.dump({"projects": {project_dir: project_label}}, f)

    return gemini_home



@contextlib.contextmanager
def gemini_session(
    prefix: str,
    project_dir: str,
    project_label: str = "session",
    approval_mode: str | None = None,
) -> Generator[str, None, None]:
    """Context manager: create an isolated Gemini home, yield its path, clean up on exit."""
    home = setup_gemini_home(prefix, project_dir, project_label, approval_mode)
    try:
        yield home
    finally:
        if os.path.isdir(home):
            shutil.rmtree(home, ignore_errors=True)


_BLOCKED_ENV_KEYS = {"ANTHROPIC_API_KEY"}
_BLOCKED_PREFIX = "ANTHROPIC_"
_ALLOWED_ANTHROPIC_KEYS = {"ANTHROPIC_CODE_CLI", "ANTHROPIC_VERTEX_PROJECT_ID"}


def make_gemini_env(gemini_home: str) -> dict[str, str]:
    """Build env dict with GEMINI_CLI_HOME for headless dispatch.

    Sets GOOGLE_CLOUD_LOCATION=global so that preview models (e.g.
    gemini-3.1-pro-preview) are reachable via Vertex AI's global endpoint.
    Regional endpoints only carry GA models.

    Strips ANTHROPIC_API_KEY and Anthropic-specific vars to match the
    sanitization applied to Claude/Codex subprocesses.

    Does NOT inject GEMINI_API_KEY by default — the user's configured auth
    (Vertex AI, OAuth, etc.) is respected as-is. API key injection only
    happens via try_gemini_api_key_fallback() when the primary auth fails.
    """
    env = {
        k: v for k, v in os.environ.items()
        if k not in _BLOCKED_ENV_KEYS
        and not (k.startswith(_BLOCKED_PREFIX) and k not in _ALLOWED_ANTHROPIC_KEYS)
    }
    env["GEMINI_CLI_HOME"] = gemini_home
    env["GOOGLE_CLOUD_LOCATION"] = "global"
    return env


# ── Output parsing ────────────────────────────────────────────────────


def parse_json_output(raw: str) -> str:
    """Extract text from Gemini ``-o json`` / ``--output-format json`` output.

    Gemini wraps responses in ``{"response": "..."}`` or sometimes returns
    a JSON array of such objects. Returns the unwrapped text, or the
    original *raw* string if no envelope is detected.
    """
    if not raw.strip():
        return raw

    try:
        obj = json.loads(raw)
        # Single envelope: {"response": "..."}
        if isinstance(obj, dict) and "response" in obj:
            return obj["response"]
        # Array of envelopes: [{"response": "..."}, ...]
        if isinstance(obj, list):
            parts = []
            for item in obj:
                if isinstance(item, dict) and "response" in item:
                    parts.append(item["response"])
            if parts:
                return "\n".join(parts)
    except (json.JSONDecodeError, AttributeError):
        pass

    return raw
