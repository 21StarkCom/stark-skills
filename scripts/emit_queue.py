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
import sqlite3
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

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
    "skill_invocation", "review_finding", "agent_dispatch", "prompt",
    "correction", "memory_write", "code_change", "bug_fix",
    "pr_event", "tool_usage", "ci_signal",
}
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
    event_json = json.dumps(event, default=str)
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
# Session cost tracking
# ---------------------------------------------------------------------------

# Pricing per million tokens (USD) — Opus 4.6 (1M context)
_PRICING = {
    "input": 15.0,
    "output": 75.0,
}


def add_cost(input_tokens: int = 0, output_tokens: int = 0) -> None:
    """Accumulate token usage for the current session."""
    if input_tokens <= 0 and output_tokens <= 0:
        return
    db = _get_db()
    try:
        for key, delta in [("input_tokens", input_tokens), ("output_tokens", output_tokens)]:
            if delta > 0:
                db.execute(
                    "INSERT INTO session_stats (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)",
                    (key, str(delta), delta),
                )
        db.commit()
    finally:
        db.close()


def get_session_cost() -> tuple[int, int, float]:
    """Returns (input_tokens, output_tokens, cost_usd)."""
    db = _get_db()
    try:
        rows = db.execute("SELECT key, value FROM session_stats WHERE key IN ('input_tokens', 'output_tokens')").fetchall()
        stats = dict(rows)
        inp = int(stats.get("input_tokens", 0))
        out = int(stats.get("output_tokens", 0))
        cost = (inp * _PRICING["input"] + out * _PRICING["output"]) / 1_000_000
        return (inp, out, cost)
    finally:
        db.close()


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

    # Cost
    inp, out, cost = get_session_cost()
    if inp > 0 or out > 0:
        parts.append(f"cost={cost:.2f}")
        parts.append(f"input_tokens={inp}")
        parts.append(f"output_tokens={out}")

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
    """Build a validated event dict with defaults filled in."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    event = {
        "type": event_type,
        "timestamp": now,
        "cli": cli,
        "source": source,
        "schema_version": 1,
        "payload": payload,
    }
    if session_id:
        event["session_id"] = session_id
    if project:
        event["project"] = project
    if user_id:
        event["user_id"] = user_id
    if dedupe_key:
        event["dedupe_key"] = dedupe_key
    elif session_id:
        ts = int(time.time())
        event["dedupe_key"] = f"{event_type}:{session_id}:{ts}"
    return event
