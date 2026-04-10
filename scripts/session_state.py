#!/usr/bin/env python3
"""Persistent session management that survives /clear.

Session state is stored in ~/.claude/code-review/sessions/{session_id}.json
and can be reloaded in a fresh conversation using the same session ID.

CLI:
    python3 scripts/session_state.py [--session-id ID] [--json]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

from session_id import resolve_session_id

import os as _os
SESSIONS_DIR = Path(
    _os.environ.get("STARK_SESSIONS_DIR", "")
) if _os.environ.get("STARK_SESSIONS_DIR") else Path.home() / ".claude" / "code-review" / "sessions"


def _git_branch() -> str:
    """Return the current git branch name, or empty string on failure."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else ""
    except OSError:
        return ""


def _git_repo() -> str:
    """Return the remote origin URL (or a derived repo slug), or empty string."""
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0:
            url = result.stdout.strip()
            # Normalize: strip .git suffix and extract owner/repo
            url = url.rstrip("/")
            if url.endswith(".git"):
                url = url[:-4]
            # Handle both https://github.com/owner/repo and git@github.com:owner/repo
            for prefix in ("https://github.com/", "git@github.com:"):
                if url.startswith(prefix):
                    return url[len(prefix):]
            return url
        return ""
    except OSError:
        return ""


@dataclass
class SessionState:
    session_id: str
    started_at: str
    branch: str
    repo: str
    tasks_completed: list[str] = field(default_factory=list)
    last_checkpoint: str | None = None
    context: dict[str, Any] = field(default_factory=dict)
    name: str | None = None
    start_head: str | None = None

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    @staticmethod
    def _sanitize_id(session_id: str) -> str:
        """Strip path-traversal characters from session IDs."""
        return re.sub(r"[^a-zA-Z0-9_\-]", "", session_id)

    def _path(self) -> Path:
        return SESSIONS_DIR / f"{self._sanitize_id(self.session_id)}.json"

    def save(self) -> None:
        """Persist session state to disk."""
        SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
        self._path().write_text(
            json.dumps(asdict(self), indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, session_id: str) -> "SessionState | None":
        """Load session state from disk. Returns None if not found."""
        path = SESSIONS_DIR / f"{cls._sanitize_id(session_id)}.json"
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        if not isinstance(data, dict):
            return None
        return cls(
            session_id=data.get("session_id", session_id),
            started_at=data.get("started_at", ""),
            branch=data.get("branch", ""),
            repo=data.get("repo", ""),
            tasks_completed=data.get("tasks_completed", []),
            last_checkpoint=data.get("last_checkpoint"),
            context=data.get("context", {}),
            name=data.get("name"),
            start_head=data.get("start_head"),
        )

    @classmethod
    @lru_cache(maxsize=1)
    def get_current(cls) -> "SessionState":
        """Load existing session or create a new one for the current session ID."""
        sid = resolve_session_id()
        existing = cls.load(sid)
        if existing is not None:
            return existing
        return cls(
            session_id=sid,
            started_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            branch=_git_branch(),
            repo=_git_repo(),
        )

    # ------------------------------------------------------------------
    # Mutation helpers — each saves after mutating
    # ------------------------------------------------------------------

    def add_task(self, task_id: str) -> None:
        """Append task_id to tasks_completed and persist."""
        self.tasks_completed.append(task_id)
        self.save()

    def set_checkpoint(self, path: str) -> None:
        """Update last_checkpoint and persist."""
        self.last_checkpoint = path
        self.save()

    def update_context(self, key: str, value: Any) -> None:
        """Set a key in the context dict and persist."""
        self.context[key] = value
        self.save()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Show current session state."
    )
    parser.add_argument("--session-id", help="Session ID to load (default: current session)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    if args.session_id:
        ss = SessionState.load(args.session_id)
        if ss is None:
            print(f"Session not found: {args.session_id}", file=sys.stderr)
            sys.exit(1)
    else:
        ss = SessionState.get_current()

    if args.json:
        print(json.dumps(asdict(ss), indent=2))
    else:
        print(f"Session ID:      {ss.session_id}")
        print(f"Started at:      {ss.started_at}")
        print(f"Branch:          {ss.branch}")
        print(f"Repo:            {ss.repo}")
        print(f"Tasks completed: {len(ss.tasks_completed)}")
        if ss.tasks_completed:
            for t in ss.tasks_completed:
                print(f"  - {t}")
        print(f"Last checkpoint: {ss.last_checkpoint or '(none)'}")
        if ss.context:
            print("Context:")
            for k, v in ss.context.items():
                print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
