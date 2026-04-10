#!/usr/bin/env python3
"""Session checkpoint generation for context window management.

Writes markdown checkpoints to:
    ~/.claude/code-review/sessions/{session_id}/checkpoint-{timestamp}.md

CLI:
    python3 scripts/context_compactor.py [--session-id ID] [--json]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import session_state as _session_state_module
from config_loader import get_context_compaction_config
from session_id import resolve_session_id
from session_state import SessionState

# Allow overriding the sessions directory for testing
SESSIONS_DIR = Path(
    os.environ.get("STARK_SESSIONS_DIR", "")
) if os.environ.get("STARK_SESSIONS_DIR") else Path.home() / ".claude" / "code-review" / "sessions"

# Re-export for test patching
session_state = _session_state_module


def _git_log_oneline(n: int = 10) -> str:
    """Return recent git log as oneline string."""
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", f"-{n}"],
            capture_output=True, text=True, check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else "(git log unavailable)"
    except OSError:
        return "(git log unavailable)"


def _git_modified_files(depth: int = 5) -> list[str]:
    """Return list of modified files in last N commits."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", f"HEAD~{depth}..HEAD"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip().splitlines()
        # Fallback: diff against HEAD
        result2 = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            capture_output=True, text=True, check=False,
        )
        return result2.stdout.strip().splitlines() if result2.returncode == 0 else []
    except OSError:
        return []


def _file_head(path_str: str, n: int = 3) -> str:
    """Return first n lines of a file as a string."""
    try:
        path = Path(path_str)
        if not path.exists() or not path.is_file():
            return "(file not found)"
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(lines[:n]) if lines else "(empty)"
    except OSError:
        return "(unreadable)"


def _build_checkpoint_content(ss: SessionState, cfg: dict) -> str:
    """Build checkpoint markdown content from session state and config."""
    lines: list[str] = []
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    lines.append(f"# Session Checkpoint")
    lines.append(f"")
    lines.append(f"**Generated:** {ts}")
    lines.append(f"")

    # --- Session summary ---
    lines.append("## Session Summary")
    lines.append(f"")
    lines.append(f"- **Session ID:** {ss.session_id}")
    lines.append(f"- **Started:** {ss.started_at}")
    lines.append(f"- **Branch:** {ss.branch}")
    lines.append(f"- **Repo:** {ss.repo}")
    lines.append(f"")

    # --- Recent commits ---
    lines.append("## Recent Commits")
    lines.append(f"")
    lines.append("```")
    lines.append(_git_log_oneline(10))
    lines.append("```")
    lines.append(f"")

    # --- Modified files ---
    modified = _git_modified_files(5)
    lines.append("## Modified Files")
    lines.append(f"")
    if modified:
        for f in modified:
            lines.append(f"- `{f}`")
        lines.append(f"")

        if cfg.get("include_file_summaries", True):
            lines.append("### File Summaries (first 3 lines)")
            lines.append(f"")
            for f in modified:
                lines.append(f"**{f}**")
                lines.append("```")
                lines.append(_file_head(f))
                lines.append("```")
                lines.append(f"")
    else:
        lines.append("_(no modified files detected)_")
        lines.append(f"")

    # --- Active tasks ---
    lines.append("## Tasks Completed")
    lines.append(f"")
    if ss.tasks_completed:
        for t in ss.tasks_completed:
            lines.append(f"- {t}")
    else:
        lines.append("_(none)_")
    lines.append(f"")

    # --- Key decisions / context ---
    if ss.context:
        lines.append("## Key Decisions")
        lines.append(f"")
        for k, v in ss.context.items():
            lines.append(f"- **{k}:** {v}")
        lines.append(f"")

    return "\n".join(lines)


def generate_checkpoint(session_id: str | None = None) -> str:
    """Generate a checkpoint for the given session (or current session).

    Returns the path to the written checkpoint file.
    """
    cfg = get_context_compaction_config()
    max_kb = cfg.get("max_checkpoint_size_kb", 50)

    # Resolve session
    sid = session_id or resolve_session_id()

    # Load or build session state
    # Use the patched SESSIONS_DIR-aware load
    _session_state_module.SESSIONS_DIR = SESSIONS_DIR
    ss = SessionState.load(sid)
    if ss is None:
        # Create a minimal session for the checkpoint
        ss = SessionState(
            session_id=sid,
            started_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            branch="",
            repo="",
        )

    content = _build_checkpoint_content(ss, cfg)

    # Enforce max size
    max_bytes = max_kb * 1024
    if len(content.encode("utf-8")) > max_bytes:
        content = content.encode("utf-8")[:max_bytes].decode("utf-8", errors="ignore")
        content += "\n\n_(checkpoint truncated due to size limit)_\n"

    # Write checkpoint
    ts_str = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    checkpoint_dir = SESSIONS_DIR / sid
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    checkpoint_path = checkpoint_dir / f"checkpoint-{ts_str}.md"
    checkpoint_path.write_text(content, encoding="utf-8")

    # Update session's last_checkpoint
    _session_state_module.SESSIONS_DIR = SESSIONS_DIR
    ss.last_checkpoint = str(checkpoint_path)
    ss.save()

    return str(checkpoint_path)


def get_latest_checkpoint(session_id: str | None = None) -> str | None:
    """Return the path to the most recent checkpoint for the session, or None."""
    sid = session_id or resolve_session_id()
    checkpoint_dir = SESSIONS_DIR / sid
    if not checkpoint_dir.is_dir():
        return None

    checkpoints = sorted(checkpoint_dir.glob("checkpoint-*.md"))
    if not checkpoints:
        return None

    return str(checkpoints[-1])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a session checkpoint for context window management."
    )
    parser.add_argument("--session-id", help="Session ID (default: current session)")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    checkpoint_path = generate_checkpoint(session_id=args.session_id)
    sid = args.session_id or resolve_session_id()

    if args.json:
        print(json.dumps({
            "session_id": sid,
            "checkpoint_path": checkpoint_path,
        }, indent=2))
    else:
        print(f"Checkpoint written: {checkpoint_path}")
        latest = get_latest_checkpoint(session_id=sid)
        if latest:
            print(f"Latest checkpoint:  {latest}")


if __name__ == "__main__":
    main()
