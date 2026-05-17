#!/usr/bin/env python3
"""Durable local event queue for stark-insights telemetry (producer side).

SQLite write-ahead queue that decouples event emission from delivery.
Events are durable the moment they're enqueued, regardless of whether
the stark-insights drain is running.

Producer-only. The drain side (HTTP delivery, buffer.db, dim resolution,
v1→v2 quarantine, tool inflight tracking, status snapshot) lives in the
stark-insights repo (`stark_insights/queue_drain.py`, `hooks/hook-emit.py`).

Usage:
    from emit_queue import enqueue, make_event

    event = make_event("skill_invocation", {"skill": "stark-session"})
    enqueue(event)
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

import session_id as _session_id

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

QUEUE_DIR = Path(os.environ.get("STARK_QUEUE_DIR", Path.home() / ".stark-insights"))
QUEUE_DB = QUEUE_DIR / "queue.db"

# ---------------------------------------------------------------------------
# Schema validation (lightweight, no external deps)
# ---------------------------------------------------------------------------

_REQUIRED_FIELDS = ("type", "timestamp", "cli", "source", "schema_version", "payload")
_VALID_TYPES = {
    "skill_invocation", "review_finding", "review_quality",
    "agent_dispatch", "prompt", "correction", "memory_write",
    "code_change", "bug_fix", "pr_event", "tool_usage", "ci_signal",
    "tournament_result",
    "preflight_check", "approach_contract",
    "validation_result", "heal_attempt",
    # Workflow-improvement v2 spec names (docs/specs/2026-04-03-*.md).
    "context_compaction", "learning_captured", "skill_recommendation",
    # Pre-v2 aliases kept for back-compat so existing producers don't break
    # mid-migration. Prefer the v2 names in new code.
    "learning_capture", "skill_suggestion",
    # Red-team config: locked-field override rejection. Spec §6 requires a
    # durable audit signal so a downstream pipeline can spot bypass attempts
    # that an operator might miss in stderr noise.
    "red_team_override_rejected",
    "red_team_run", "red_team_finding", "red_team_fix_plan",
    # FU-rt11 — Per-call telemetry. Run-level events hide phase attribution
    # (was the budget halt at primary, verification, regen, or inner-review?
    # which model actually ran post-fallback? was the prompt truncated?).
    # call.start fires before each call so latency-spike forensics can pair
    # against call.end on the orchestrator side.
    "red_team_call_start", "red_team_call_end",
}

_VALID_CLIS = {"claude", "codex", "gemini"}
_VALID_SOURCES = {"skill", "hook", "scraper", "backfill"}

# Patterns that look like API keys or tokens. Applied to the serialized
# event JSON before persistence. Kept in lockstep with the TS port at
# `tools/emit_queue_lib.ts::REDACT_PATTERNS`.
_REDACT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r'sk-[A-Za-z0-9_-]{10,}'), "sk-[REDACTED]"),
    (re.compile(r'ghp_[A-Za-z0-9]{10,}'), "ghp_[REDACTED]"),
    (re.compile(r'ghs_[A-Za-z0-9]{10,}'), "ghs_[REDACTED]"),
    # Base64-encoded secrets (>40 chars, includes + and / from base64 alphabet)
    (re.compile(r'[A-Za-z0-9+/]{41,}={0,2}'), "[BASE64-REDACTED]"),
]


def _redact(text: str) -> str:
    """Strip patterns that look like API keys or tokens from a serialized string."""
    for pattern, replacement in _REDACT_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def validate(event: dict) -> list[str]:
    """Validate event against the schema. Returns list of errors (empty = valid)."""
    errors: list[str] = []
    for field in _REQUIRED_FIELDS:
        if field not in event:
            errors.append(f"missing required field: {field}")
    if errors:
        return errors

    # Required envelope fields must be non-empty strings. The original
    # "field present" check accepted empty strings, numbers, and dicts —
    # v2 events.* declares these NOT NULL TEXT columns, and the HTTP path
    # POSTs the raw payload, so bad shapes would fail late on the server.
    for field in ("type", "timestamp", "cli", "source"):
        value = event.get(field)
        if not isinstance(value, str):
            errors.append(
                f"{field} must be a non-empty string, got: {type(value).__name__}"
            )
        elif not value:
            errors.append(f"{field} must be a non-empty string")

    # Only run enum checks on string values — the earlier type check will
    # have already flagged dicts/numbers, and `value not in _SET` on a
    # non-hashable like a dict would itself raise TypeError.
    if isinstance(event.get("type"), str) and event["type"] not in _VALID_TYPES:
        errors.append(f"invalid type: {event['type']}")
    if isinstance(event.get("cli"), str) and event["cli"] not in _VALID_CLIS:
        errors.append(f"invalid cli: {event['cli']}")
    if isinstance(event.get("source"), str) and event["source"] not in _VALID_SOURCES:
        errors.append(f"invalid source: {event['source']}")
    if not isinstance(event.get("schema_version"), int) or event["schema_version"] < 1:
        errors.append(f"schema_version must be int >= 1, got: {event.get('schema_version')}")
    if not isinstance(event.get("payload"), dict):
        errors.append(f"payload must be a dict, got: {type(event.get('payload')).__name__}")
    # event_id is optional for back-compat with legacy producers, but when it
    # IS present it must be a non-empty string. make_event always generates a
    # uuid4 here, so anything weaker points at a malformed producer path.
    if "event_id" in event:
        event_id = event["event_id"]
        if not isinstance(event_id, str) or not event_id:
            errors.append(
                f"event_id must be a non-empty string, got: {event_id!r}"
            )
    return errors


# ---------------------------------------------------------------------------
# SQLite queue
# ---------------------------------------------------------------------------

_db_initialized: dict[str, float] = {}


def _needs_init(db_path: str, cache: dict[str, float]) -> bool:
    """Check if the DB at *db_path* needs DDL initialization.

    Tracks the inode of the file when DDL was last run.  If the file was
    deleted and recreated (different inode or missing), we re-run DDL.
    """
    if db_path not in cache:
        return True
    try:
        current_ino = os.stat(db_path).st_ino
    except OSError:
        return True
    return current_ino != cache[db_path]


def _mark_initialized(db_path: str, cache: dict[str, float]) -> None:
    """Record the inode of *db_path* so we can detect recreation."""
    try:
        cache[db_path] = os.stat(db_path).st_ino
    except OSError:
        cache.pop(db_path, None)


def _get_db() -> sqlite3.Connection:
    """Open (and initialize if needed) the queue database."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    db_path = str(QUEUE_DB)
    db = sqlite3.connect(db_path, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    if _needs_init(db_path, _db_initialized):
        db.executescript("""
            CREATE TABLE IF NOT EXISTS pending (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key  TEXT UNIQUE,
                event_json  TEXT NOT NULL,
                created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                retries     INTEGER NOT NULL DEFAULT 0,
                last_error  TEXT
            );
            CREATE TABLE IF NOT EXISTS dead_letter (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                dedupe_key  TEXT,
                event_json  TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                failed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                retries     INTEGER NOT NULL,
                last_error  TEXT,
                source_path TEXT NOT NULL DEFAULT 'http'
            );
            CREATE INDEX IF NOT EXISTS idx_pending_created ON pending(created_at);
        """)
        # Older dead_letter tables lack source_path. Stark-insights' drain
        # writes this column when dead-lettering buffer-path failures, so the
        # idempotent ALTER stays for back-compat with pre-split DBs.
        columns = {row[1] for row in db.execute("PRAGMA table_info(dead_letter)").fetchall()}
        if "source_path" not in columns:
            db.execute(
                "ALTER TABLE dead_letter ADD COLUMN source_path TEXT NOT NULL DEFAULT 'http'"
            )
            db.commit()
        _mark_initialized(db_path, _db_initialized)
    return db


def enqueue(event: dict) -> int | None:
    """Validate and enqueue an event. Returns row id or None on duplicate/error."""
    errors = validate(event)
    if errors:
        raise ValueError(f"Invalid event: {'; '.join(errors)}")

    dedupe_key = event.get("dedupe_key")
    event_json = _redact(json.dumps(event, default=str))
    db = _get_db()
    try:
        cursor = db.execute(
            "INSERT OR IGNORE INTO pending (dedupe_key, event_json) VALUES (?, ?)",
            (dedupe_key, event_json),
        )
        db.commit()
        return cursor.lastrowid if cursor.rowcount > 0 else None
    finally:
        db.close()


def pending_count() -> int:
    """Number of events waiting to be drained."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*) FROM pending").fetchone()
        return row[0] if row else 0
    finally:
        db.close()


def dead_letter_count() -> int:
    """Number of events in the dead-letter table (written by stark-insights drain)."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*) FROM dead_letter").fetchone()
        return row[0] if row else 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Context velocity tracking (consumed by config/statusline-command.sh)
# ---------------------------------------------------------------------------

CTX_HISTORY_PATH = QUEUE_DIR / "ctx-history"


def record_context_pct(pct: float) -> str:
    """Record context % and return trend indicator: ▲ (fast), ▸ (stable), or empty."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    now = int(time.time())
    # Append to a rolling file (keep last 10 entries)
    entries: list[tuple[int, float]] = []
    try:
        for line in CTX_HISTORY_PATH.read_text().strip().splitlines():
            parts = line.split("\t")
            if len(parts) == 2:
                entries.append((int(parts[0]), float(parts[1])))
    except (OSError, ValueError):
        pass

    entries.append((now, pct))
    entries = entries[-10:]  # keep last 10

    tmp = CTX_HISTORY_PATH.with_suffix(".tmp")
    try:
        tmp.write_text("\n".join(f"{ts}\t{p}" for ts, p in entries) + "\n")
        tmp.rename(CTX_HISTORY_PATH)
    except OSError:
        pass

    # Compute trend: compare current to entry from ~60s ago
    if len(entries) < 2:
        return ""
    prev_pct = entries[0][1]
    delta = pct - prev_pct
    if delta >= 5:
        return "▲"  # ▲ fast growth
    elif delta >= 1:
        return "▸"  # ▸ moderate
    return ""


# ---------------------------------------------------------------------------
# Health CLI
# ---------------------------------------------------------------------------


def _health() -> dict:
    """Query queue.db and return count + max created_at as a JSON-serialisable dict."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*), MAX(created_at) FROM pending").fetchone()
        count, max_ts = row if row else (0, None)
        return {"pending_count": count, "max_created_at": max_ts}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Helpers for event construction
# ---------------------------------------------------------------------------

def make_event(
    event_type: str,
    payload: dict,
    *,
    cli: str = "claude",
    source: str = "skill",
    session_id: str | None = None,
    project: str | None = None,
    user_id: str | None = None,
    dedupe_key: str | None = None,
) -> dict:
    """Build a validated event dict with defaults filled in.

    V2 behavior (schema_version=2):
    - event_id: auto-generated uuid4, always present
    - schema_version: set to 2
    - session_id: auto-resolved via session_id.resolve_session_id() if not provided
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    resolved_session_id: str = session_id if session_id is not None else _session_id.resolve_session_id()

    event: dict = {
        "type": event_type,
        "event_id": str(_uuid.uuid4()),
        "timestamp": now,
        "cli": cli,
        "source": source,
        "schema_version": 2,
        "session_id": resolved_session_id,
        "payload": payload,
    }
    if project:
        event["project"] = project
    if user_id:
        event["user_id"] = user_id
    if dedupe_key:
        event["dedupe_key"] = dedupe_key
    else:
        event["dedupe_key"] = _default_dedupe_key(
            event_type=event_type,
            source=source,
            cli=cli,
            session_id=resolved_session_id,
            payload=payload,
        )
    return event


def _default_dedupe_key(
    *,
    event_type: str,
    source: str,
    cli: str,
    session_id: str,
    payload: dict,
) -> str:
    """Synthesize a dedupe key when the caller didn't pass one.

    ADR-0014 pins source-specific formulas so the backend can dedupe
    replays at the event-semantic level instead of collapsing unrelated
    events that happened to share event_type + session_id + wall-clock:

    - Skill:   ``{skill}:{session_id}:{start_timestamp}``
    - Hook:    ``{cli}:{session_id}:{sequence_number}``
    - Scraper: ``{cli}:{file_path}:{byte_offset}``

    Falls back to the generic `{event_type}:{session_id}:{ts}` form when
    payload is missing the source-specific fields — better a generic key
    than no key.
    """
    ts = int(time.time())
    generic = f"{event_type}:{session_id}:{ts}"
    if source == "skill":
        skill = payload.get("skill")
        start_ts = payload.get("start_timestamp") or ts
        if skill:
            return f"{skill}:{session_id}:{start_ts}"
    elif source == "hook":
        seq = payload.get("sequence_number")
        if seq is not None:
            return f"{cli}:{session_id}:{seq}"
    elif source == "scraper":
        file_path = payload.get("file_path")
        byte_offset = payload.get("byte_offset")
        if file_path is not None and byte_offset is not None:
            return f"{cli}:{file_path}:{byte_offset}"
    return generic


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="emit_queue utility")
    parser.add_argument("--health", action="store_true",
                        help="Print queue health stats as JSON and exit")
    args = parser.parse_args()

    if args.health:
        print(json.dumps(_health(), indent=2))
    else:
        parser.print_help()
