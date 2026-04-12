"""Shared SQLite audit primitives for stark-skills pipelines.

Used by both `forge_audit` and `forged_review_audit`. All connections use
WAL mode + busy_timeout=5000ms for concurrent-access safety.

This module owns the low-level plumbing; each caller supplies its own
schema and insert statements.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, cast


def _to_dict(record: Any) -> Any:
    """Convert a dataclass instance to a dict; otherwise pass through."""
    if is_dataclass(record) and not isinstance(record, type):
        return asdict(cast(Any, record))
    return record


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection with WAL + busy_timeout pragmas."""
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(db_path: str | Path, schema_sql: str) -> None:
    """Create tables from schema_sql, creating parent dirs as needed."""
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = connect(db_path)
    try:
        conn.executescript(schema_sql)
        conn.commit()
    finally:
        conn.close()


def append_jsonl(path: str | Path, record: Any) -> None:
    """Append one JSON line to a file. `record` may be a dataclass or dict."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = _to_dict(record)
    with target.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload) + "\n")


def now_ts() -> float:
    """Unix timestamp helper — kept here so callers don't re-import time."""
    return time.time()
