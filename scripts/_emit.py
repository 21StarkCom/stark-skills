"""Thin subprocess wrapper around `tools/emit_queue_cli.ts enqueue`.

Replaces the prior `import emit_queue; emit_queue.make_event(...);
emit_queue.enqueue(event)` pattern across Python consumers. The canonical
implementation now lives in TypeScript (`tools/emit_queue_lib.ts`); this
module only forks a node subprocess to push events into the durable queue
without bringing a second Python implementation back.

Best-effort: every call swallows exceptions so telemetry emission cannot
break the host process (callers all wrapped the old emit_queue calls in
broad except handlers; the contract is preserved).

Usage:
    from _emit import emit_event
    emit_event("heal_attempt", {"key": "value"})

The TS lib auto-fills timestamp / event_id / schema_version / session_id
(from CLAUDE_SESSION_ID env or uuid4) and computes ADR-0014 dedupe keys.
Callers that need a specific session_id should pass it via the
CLAUDE_SESSION_ID env var or supply it directly.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

# Resolve the TS CLI both when run from an installed symlink tree
# (~/.claude/code-review/tools/emit_queue_cli.ts) and from the source repo
# (during install.sh or local dev). The installed path is checked first
# because hooks and skills resolve scripts from $SCRIPTS=~/.claude/...
_INSTALLED_CLI = Path.home() / ".claude" / "code-review" / "tools" / "emit_queue_cli.ts"
_REPO_CLI = Path(__file__).resolve().parent.parent / "tools" / "emit_queue_cli.ts"


def _cli_path() -> str | None:
    for candidate in (_INSTALLED_CLI, _REPO_CLI):
        if candidate.exists():
            return str(candidate)
    return None


def emit_event(
    event_type: str,
    payload: dict,
    *,
    cli: str = "claude",
    source: str = "skill",
    session_id: str | None = None,
    project: str | None = None,
    user_id: str | None = None,
    dedupe_key: str | None = None,
) -> None:
    """Best-effort enqueue of a single telemetry event. Never raises."""
    cli_path = _cli_path()
    if cli_path is None:
        return  # No TS CLI reachable — silently drop, same as the prior shim.

    args = [
        "node", "--experimental-strip-types", "--no-warnings",
        cli_path, "enqueue",
        "--type", event_type,
        "--payload", json.dumps(payload, default=str),
        "--cli", cli,
        "--source", source,
    ]
    if session_id is not None:
        args.extend(["--session-id", session_id])
    if project is not None:
        args.extend(["--project", project])
    if user_id is not None:
        args.extend(["--user-id", user_id])
    if dedupe_key is not None:
        args.extend(["--dedupe-key", dedupe_key])

    try:
        subprocess.run(args, check=False, capture_output=True, timeout=5)
    except Exception:  # noqa: BLE001 — telemetry MUST NOT break callers
        pass


# Surfaces NOT migrated to this shim because they have non-trivial Python
# state (record_context_pct's rolling file under STARK_QUEUE_DIR, the
# --health CLI invoked from /stark-session) or are pure SQLite reads
# (pending_count, dead_letter_count). Those callers shell out to
# `tools/emit_queue_cli.ts` directly via shell rather than this helper.

# Re-export for the small handful of test files that still patch
# `_emit.emit_event` to capture telemetry calls. Subsequent slices may
# add `validate` here if callers need pre-flight validation; for now the
# TS lib validates inside `enqueue`.
__all__ = ["emit_event"]
