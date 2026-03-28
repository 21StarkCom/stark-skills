"""Shared utilities for Gemini CLI integration.

Constants and helpers used across all dispatch scripts that invoke the Gemini CLI.
"""

from __future__ import annotations

import datetime
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

# Default model — pinned to avoid auto-routing unpredictability in automation.
GEMINI_MODEL = "gemini-3.1-pro-preview"

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


# ── Session isolation ─────────────────────────────────────────────────


def setup_gemini_home(prefix: str, project_dir: str, project_label: str = "session") -> str:
    """Create an isolated GEMINI_CLI_HOME with auth files and project scope.

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

    with open(os.path.join(gemini_dir, "projects.json"), "w") as f:
        json.dump({"projects": {project_dir: project_label}}, f)

    return gemini_home


def make_gemini_env(gemini_home: str) -> dict[str, str]:
    """Build env dict with GEMINI_CLI_HOME and GOOGLE_CLOUD_LOCATION set."""
    return {
        **os.environ,
        "GEMINI_CLI_HOME": gemini_home,
        "GOOGLE_CLOUD_LOCATION": "global",
    }


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
