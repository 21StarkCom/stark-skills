#!/usr/bin/env python3
"""Durable local event queue for stark-insights telemetry.

SQLite write-ahead queue that decouples event emission from delivery.
Events are durable the moment they're enqueued, regardless of whether
the stark-insights API is reachable.

Usage:
    from emit_queue import enqueue, drain

    enqueue({"type": "skill_invocation", "cli": "claude", ...})
    drain()  # flush pending events to the API
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import time
import urllib.request
import uuid as _uuid
from datetime import datetime, timezone
from pathlib import Path

import session_id as _session_id

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

QUEUE_DIR = Path(os.environ.get("STARK_QUEUE_DIR", Path.home() / ".stark-insights"))
QUEUE_DB = QUEUE_DIR / "queue.db"
TOKEN_PATH = QUEUE_DIR / "api-token"
API_URL = os.environ.get("STARK_API_URL", "http://localhost:7420/events")

MAX_RETRIES = 5
DRAIN_BATCH_SIZE = 50
DRAIN_TIMEOUT_S = 5

SCHEMA_PATH = Path(__file__).parent / "event_schema.json"

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
}

# ---------------------------------------------------------------------------
# Redaction (applied before persisting event JSON)
# ---------------------------------------------------------------------------

# Patterns that look like API keys or tokens.
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
_VALID_CLIS = {"claude", "codex", "gemini"}
_VALID_SOURCES = {"skill", "hook", "scraper", "backfill"}


def validate(event: dict) -> list[str]:
    """Validate event against the schema. Returns list of errors (empty = valid)."""
    errors: list[str] = []
    for field in _REQUIRED_FIELDS:
        if field not in event:
            errors.append(f"missing required field: {field}")
    if errors:
        return errors

    if event["type"] not in _VALID_TYPES:
        errors.append(f"invalid type: {event['type']}")
    if event["cli"] not in _VALID_CLIS:
        errors.append(f"invalid cli: {event['cli']}")
    if event["source"] not in _VALID_SOURCES:
        errors.append(f"invalid source: {event['source']}")
    if not isinstance(event.get("schema_version"), int) or event["schema_version"] < 1:
        errors.append(f"schema_version must be int >= 1, got: {event.get('schema_version')}")
    if not isinstance(event.get("payload"), dict):
        errors.append(f"payload must be a dict, got: {type(event.get('payload')).__name__}")
    return errors


# ---------------------------------------------------------------------------
# SQLite queue
# ---------------------------------------------------------------------------

def _get_db() -> sqlite3.Connection:
    """Open (and initialize if needed) the queue database."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(QUEUE_DB), timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
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
            last_error  TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pending_created ON pending(created_at);
        CREATE TABLE IF NOT EXISTS inflight (
            tool_use_id TEXT PRIMARY KEY,
            tool_name   TEXT NOT NULL,
            started_at  REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_stats (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    """)
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


def drain(batch_size: int = DRAIN_BATCH_SIZE) -> dict:
    """Flush pending events to the API. Returns {sent, failed, dead_lettered}."""
    token = _read_token()
    db = _get_db()
    stats = {"sent": 0, "failed": 0, "dead_lettered": 0}

    try:
        rows = db.execute(
            "SELECT id, dedupe_key, event_json, created_at, retries FROM pending "
            "ORDER BY created_at LIMIT ?",
            (batch_size,),
        ).fetchall()

        for row_id, dedupe_key, event_json, created_at, retries in rows:
            success, error = _post_event(event_json, token)
            if success:
                db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
                stats["sent"] += 1
            elif retries + 1 >= MAX_RETRIES:
                db.execute(
                    "INSERT INTO dead_letter (dedupe_key, event_json, created_at, retries, last_error) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (dedupe_key, event_json, created_at, retries + 1, error),
                )
                db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
                stats["dead_lettered"] += 1
            else:
                db.execute(
                    "UPDATE pending SET retries = ?, last_error = ? WHERE id = ?",
                    (retries + 1, error, row_id),
                )
                stats["failed"] += 1

        db.commit()
    finally:
        db.close()

    # If the API is reachable (we sent at least one), recover dead letters
    if stats["sent"] > 0:
        recovered = retry_dead_letters()
        stats["recovered"] = recovered

    return stats


BUFFER_PATH = Path(os.environ.get("BUFFER_PATH", Path.home() / ".stark-insights" / "buffer.db"))


def _get_buffer_db() -> sqlite3.Connection:
    """Open the buffer database (creating schema if needed)."""
    BUFFER_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(BUFFER_PATH), timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            dedupe_key TEXT UNIQUE,
            session_id TEXT,
            normalized_session_id TEXT,
            type TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            cli TEXT,
            user_id TEXT,
            project TEXT,
            payload TEXT NOT NULL,
            schema_version INTEGER DEFAULT 1,
            source TEXT,
            synced_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_unsynced_timestamp
            ON events (synced_at, timestamp);
    """)
    return db


def drain_to_buffer(batch_size: int = DRAIN_BATCH_SIZE) -> dict:
    """Flush pending events from queue.db directly into buffer.db (no HTTP).

    Returns {sent, failed}.
    """
    import uuid as _uuid

    queue_db = _get_db()
    buffer_db = _get_buffer_db()
    stats = {"sent": 0, "failed": 0}

    try:
        rows = queue_db.execute(
            "SELECT id, dedupe_key, event_json, created_at FROM pending "
            "ORDER BY created_at LIMIT ?",
            (batch_size,),
        ).fetchall()

        for row_id, dedupe_key, event_json, created_at in rows:
            try:
                event = json.loads(event_json)
                buffer_db.execute(
                    """INSERT OR IGNORE INTO events
                       (id, dedupe_key, session_id, normalized_session_id,
                        type, timestamp, cli, user_id, project,
                        payload, schema_version, source, synced_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)""",
                    (
                        str(_uuid.uuid4()),
                        dedupe_key,
                        event.get("session_id"),
                        event.get("normalized_session_id"),
                        event.get("type", ""),
                        event.get("timestamp", ""),
                        event.get("cli"),
                        event.get("user_id"),
                        event.get("project"),
                        json.dumps(event.get("payload", {})),
                        event.get("schema_version", 1),
                        event.get("source"),
                    ),
                )
                queue_db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
                stats["sent"] += 1
            except Exception:
                stats["failed"] += 1

        queue_db.commit()
        buffer_db.commit()
    finally:
        queue_db.close()
        buffer_db.close()

    return stats


def pending_count() -> int:
    """Number of events waiting to be sent."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*) FROM pending").fetchone()
        return row[0] if row else 0
    finally:
        db.close()


def dead_letter_count() -> int:
    """Number of events in the dead-letter table."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*) FROM dead_letter").fetchone()
        return row[0] if row else 0
    finally:
        db.close()


def retry_dead_letters() -> int:
    """Move dead-lettered events back to pending for another attempt. Returns count moved."""
    db = _get_db()
    try:
        rows = db.execute(
            "SELECT id, dedupe_key, event_json FROM dead_letter"
        ).fetchall()
        moved = 0
        for dl_id, dedupe_key, event_json in rows:
            db.execute(
                "INSERT OR IGNORE INTO pending (dedupe_key, event_json, retries) VALUES (?, ?, 0)",
                (dedupe_key, event_json),
            )
            db.execute("DELETE FROM dead_letter WHERE id = ?", (dl_id,))
            moved += 1
        db.commit()
        return moved
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Tool duration tracking
# ---------------------------------------------------------------------------

LAST_TOOL_PATH = QUEUE_DIR / "last-tool"


def start_tool(tool_use_id: str, tool_name: str) -> None:
    """Record that a tool call has started. Called from PreToolUse hook."""
    if not tool_use_id:
        return
    db = _get_db()
    try:
        db.execute(
            "INSERT OR REPLACE INTO inflight (tool_use_id, tool_name, started_at) VALUES (?, ?, ?)",
            (tool_use_id, tool_name, time.monotonic()),
        )
        db.commit()
    finally:
        db.close()


def end_tool(tool_use_id: str) -> tuple[str, int] | None:
    """Complete a tool call. Returns (tool_name, duration_ms) or None if not tracked.

    Also writes the result to last-tool file for status line consumption and
    prunes stale inflight records (>10 min old).
    """
    if not tool_use_id:
        return None
    now = time.monotonic()
    db = _get_db()
    try:
        row = db.execute(
            "SELECT tool_name, started_at FROM inflight WHERE tool_use_id = ?",
            (tool_use_id,),
        ).fetchone()
        if not row:
            return None
        tool_name, started_at = row
        duration_ms = int((now - started_at) * 1000)

        db.execute("DELETE FROM inflight WHERE tool_use_id = ?", (tool_use_id,))
        # Prune stale entries (tools that never got a PostToolUse)
        db.execute("DELETE FROM inflight WHERE started_at < ?", (now - 600,))
        db.commit()

        # Write for status line (atomic via temp + rename)
        _write_last_tool(tool_name, duration_ms)

        return (tool_name, duration_ms)
    finally:
        db.close()


def _write_last_tool(tool_name: str, duration_ms: int) -> None:
    """Write last completed tool to a file for the status line."""
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = LAST_TOOL_PATH.with_suffix(".tmp")
    try:
        tmp.write_text(f"{tool_name}\t{duration_ms}\t{int(time.time())}\n")
        tmp.rename(LAST_TOOL_PATH)
    except OSError:
        pass


def read_last_tool() -> tuple[str, int, int] | None:
    """Read the last completed tool. Returns (tool_name, duration_ms, unix_ts) or None."""
    try:
        parts = LAST_TOOL_PATH.read_text().strip().split("\t")
        if len(parts) == 3:
            return (parts[0], int(parts[1]), int(parts[2]))
    except (OSError, ValueError):
        pass
    return None


# ---------------------------------------------------------------------------
# Inflight queries (for status line)
# ---------------------------------------------------------------------------

def inflight_count() -> int:
    """Number of tools currently in-flight."""
    db = _get_db()
    try:
        row = db.execute("SELECT COUNT(*) FROM inflight").fetchone()
        return row[0] if row else 0
    finally:
        db.close()


def longest_inflight() -> tuple[str, int] | None:
    """Longest-running inflight tool. Returns (tool_name, elapsed_s) or None."""
    now = time.monotonic()
    db = _get_db()
    try:
        row = db.execute(
            "SELECT tool_name, started_at FROM inflight ORDER BY started_at ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        tool_name, started_at = row
        elapsed_s = int(now - started_at)
        return (tool_name, elapsed_s)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Session cost tracking (reads from Claude Code transcript)
# ---------------------------------------------------------------------------

# Pricing per million tokens (USD) — Claude Opus 4.6
_PRICING = {
    "input": 15.0,
    "cache_read": 1.5,
    "cache_create": 18.75,
    "output": 75.0,
}


def compute_cost_from_transcript(transcript_path: str) -> tuple[int, int, float] | None:
    """Parse a Claude Code transcript JSONL and compute session cost.

    Returns (input_tokens, output_tokens, cost_usd) or None if unreadable.
    Token fields from message.usage: input_tokens, output_tokens,
    cache_read_input_tokens, cache_creation_input_tokens.
    """
    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cache_create = 0

    try:
        with open(transcript_path) as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "assistant":
                    continue
                usage = (obj.get("message") or {}).get("usage")
                if not usage or not isinstance(usage, dict):
                    continue
                total_input += usage.get("input_tokens", 0)
                total_output += usage.get("output_tokens", 0)
                total_cache_read += usage.get("cache_read_input_tokens", 0)
                total_cache_create += usage.get("cache_creation_input_tokens", 0)
    except OSError:
        return None

    if total_input == 0 and total_output == 0:
        return None

    cost = (
        total_input * _PRICING["input"]
        + total_cache_read * _PRICING["cache_read"]
        + total_cache_create * _PRICING["cache_create"]
        + total_output * _PRICING["output"]
    ) / 1_000_000

    return (total_input + total_cache_read + total_cache_create, total_output, cost)


# ---------------------------------------------------------------------------
# Context velocity tracking
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
        return "\u25b2"  # ▲ fast growth
    elif delta >= 1:
        return "\u25b8"  # ▸ moderate
    return ""


# ---------------------------------------------------------------------------
# Status line snapshot (single file, all indicators)
# ---------------------------------------------------------------------------

STATUS_PATH = QUEUE_DIR / "status"


def write_status_snapshot() -> None:
    """Write a consolidated status file for the status line to read.

    Format: tab-separated key=value pairs on one line.
    """
    QUEUE_DIR.mkdir(parents=True, exist_ok=True)
    parts: list[str] = []

    # Inflight
    ifc = inflight_count()
    if ifc > 0:
        parts.append(f"inflight={ifc}")
        li = longest_inflight()
        if li:
            parts.append(f"longest_tool={li[0]}")
            parts.append(f"longest_s={li[1]}")

    # Cost is computed from transcript in the status line script (not here)

    tmp = STATUS_PATH.with_suffix(".tmp")
    try:
        tmp.write_text("\t".join(parts) + "\n")
        tmp.rename(STATUS_PATH)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# HTTP delivery
# ---------------------------------------------------------------------------

def _read_token() -> str:
    try:
        return TOKEN_PATH.read_text().strip()
    except OSError:
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
# HTTP delivery
# ---------------------------------------------------------------------------


def _post_event(event_json: str, token: str) -> tuple[bool, str | None]:
    """POST a single event to the API. Returns (success, error_message)."""
    req = urllib.request.Request(
        API_URL,
        data=event_json.encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    try:
        resp = urllib.request.urlopen(req, timeout=DRAIN_TIMEOUT_S)
        return (True, None)
    except urllib.error.HTTPError as e:
        return (False, f"HTTP {e.code}: {e.reason}")
    except Exception as e:
        return (False, str(e))


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

    V2 changes (schema_version=2):
    - event_id: auto-generated uuid4, always present
    - schema_version: now set to 2
    - session_id: auto-resolved via session_id.resolve_session_id() if not provided
    """
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Auto-resolve session_id if not provided (v2 behaviour).
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
        ts = int(time.time())
        event["dedupe_key"] = f"{event_type}:{resolved_session_id}:{ts}"
    return event


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
