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
    "validation_result", "heal_attempt",
    # Workflow-improvement v2 spec names (docs/specs/2026-04-03-*.md).
    "context_compaction", "learning_captured", "skill_recommendation",
    # Pre-v2 aliases kept for back-compat so existing producers don't break
    # mid-migration. Prefer the v2 names in new code.
    "learning_capture", "skill_suggestion",
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
        # Migration: older dead_letter tables lack source_path, so a buffer
        # drain's poison row and an HTTP drain's network failure could share
        # a dedupe_key and retry_dead_letters would resurrect both into the
        # HTTP path. Add the column (defaulting legacy rows to 'http', which
        # preserves pre-split semantics) so retry can filter by sink.
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


_buffer_db_initialized: dict[str, float] = {}


# MUST match stark_insights.dimensions.NAMESPACE_INSIGHTS — verified by
# the canonical schema being asserted in tests/test_emit_queue.py.
NAMESPACE_INSIGHTS = _uuid.UUID("7a3f1b8e-1b7a-4f9e-8e47-5a3f1b8e7a3f")
_ORG_REPO_RE = re.compile(r"^[A-Za-z0-9._-]+/([A-Za-z0-9._-]+)$")
_WORKTREE_MARKERS = ("/.worktrees/", "/.claude/worktrees/")


def _strip_worktree_suffix(path):
    for marker in _WORKTREE_MARKERS:
        if marker in path:
            return path.split(marker)[0]
    return path


# Specific CI-layout anchors. The integer strategy takes segs[i] as repo;
# the string "last" takes segs[-1]. Without these specific matches, a bare
# /home/<user>/<anything> fallback wrongly turns /home/alice/.config/nvim
# into repo="alice" and breaks existing per-repo aggregations.
_CI_PATTERNS: tuple[tuple[tuple[str, ...], object], ...] = (
    # GitHub Actions: /home/runner/work/<repo>/<repo> → segs[3] (fixed layout)
    (("home", "runner", "work"), 3),
    # GitLab Runner: CI_PROJECT_DIR = /builds/<group>[/<subgroup>...]/<project>.
    # Subgroups are first-class namespaces so the project slug is always the
    # LAST segment, not a fixed index — the prior segs[2] attribution broke
    # every subgroup checkout into the subgroup bucket.
    (("builds",), "last"),
    # Jenkins-like: /workspace/<org>/<repo>[/<subgroup>/<repo>]
    (("workspace",), "last"),
    # Generic /srv/<org>/<repo>, /github/<org>/<repo> and their nested forms.
    (("srv",), "last"),
    (("github",), "last"),
)


def _normalize_path_to_repo(path):
    """Extract the repo slug for dimension tables.

    Recognizes three layouts, in order of reliability:
      * `/…/git/<org>/<repo>[/…]`     (macOS/Linux dev with go-style path)
      * `/<ci-root>/<org>/<repo>[/…]` (CI layouts; ci-root ∈ _CHECKOUT_ROOTS)
      * `"<org>/<repo>"`              (producers like multi_review.py)
    Returns None for unrecognized layouts so the dimension stays NULL
    rather than inventing a bad repo name.
    """
    if not path:
        return None
    if path.startswith("/"):
        base = _strip_worktree_suffix(path)
        # Prefer the `/git/<org>/<repo>` convention — handles deeper paths
        # like `/Users/<user>/git/<org>/<repo>/subdir` reliably. Use the
        # LAST `/git/` anchor so pathological dev trees such as
        # `/Users/git/<user>/git/<org>/<repo>` still attribute to <repo>,
        # not the intermediate "git" segment.
        if "/git/" in base:
            tail = base.rsplit("/git/", 1)[1]
            segs = [s for s in tail.split("/") if s]
            if len(segs) >= 2:
                return segs[1]
            return None
        # Match specific CI layout anchors. Arbitrary /home/alice/foo paths
        # stay NULL so we don't invent a repo from random Linux directories.
        segs = [s for s in base.split("/") if s]
        for prefix, strategy in _CI_PATTERNS:
            if tuple(segs[: len(prefix)]) != prefix:
                continue
            if isinstance(strategy, int):
                if len(segs) > strategy:
                    return segs[strategy]
                return None
            if strategy == "last" and len(segs) > len(prefix):
                return segs[-1]
            return None
        return None
    m = _ORG_REPO_RE.match(path)
    return m.group(1) if m else None


def _derive_workspace_type(path):
    if not path:
        return "external"
    if any(marker in path for marker in _WORKTREE_MARKERS):
        return "worktree"
    if path.startswith("/tmp/") or path.startswith("/private/tmp/"):
        return "tmp"
    if _normalize_path_to_repo(path):
        return "main"
    return "external"


def _worktree_parent_path(path):
    for marker in _WORKTREE_MARKERS:
        if marker in path:
            return path.split(marker)[0]
    return None


def _deterministic_user_id(login):
    return _uuid.uuid5(NAMESPACE_INSIGHTS, f"user:{login}")


def _deterministic_project_id(path):
    return _uuid.uuid5(NAMESPACE_INSIGHTS, f"project:{path}")


_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _looks_like_uuid(value) -> bool:
    return isinstance(value, str) and bool(_UUID_RE.match(value))


def _resolve_user(conn, github_login):
    """Upsert the user row and return the deterministic user_id (UUID str).

    Mirrors stark_insights.dimensions.resolve_user but sync. Returns None
    when the producer didn't supply a login so the events.user_id column
    stays NULL rather than joining everyone under a synthetic user row.

    Already-resolved UUIDs (from replayed partial-v2 rows) pass through
    WITHOUT creating a placeholder users row. An earlier design upserted
    `github_login = "recovered:<prefix>"`, but the ON CONFLICT clause made
    that placeholder permanent: a later drain with the real login could
    never replace "recovered:..." with the actual handle. We log the UUID
    to _recovered_dims for observability so the real login wins cleanly
    on its next drain.
    """
    if not github_login:
        return None
    now = datetime.now(timezone.utc).isoformat()
    if _looks_like_uuid(github_login):
        conn.execute(
            "INSERT OR IGNORE INTO _recovered_dims "
            "(id, kind, source_hint, recorded_at) "
            "VALUES (?, 'user', ?, ?)",
            (github_login, f"uuid-passthrough:{github_login[:8]}", now),
        )
        return github_login
    uid = str(_deterministic_user_id(github_login))
    conn.execute(
        """INSERT INTO users (id, github_login, display_name, aliases, created_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(id) DO NOTHING""",
        (uid, github_login, json.dumps([]), now),
    )
    return uid


def _resolve_project(conn, path):
    """Upsert the project row(s) and return the deterministic project_id.

    Mirrors stark_insights.dimensions.resolve_project but sync. Returns
    None when the producer didn't supply a path so the events.project_id
    column stays NULL rather than grouping under a synthetic project row.

    Already-resolved UUIDs pass through WITHOUT creating a placeholder
    projects row. The previous placeholder path set workspace_type='external'
    and relied on ON CONFLICT DO UPDATE (last_seen_at only), which meant a
    later drain with the real path could never upgrade the row to
    workspace_type='main' or populate repo/parent_project_id. We log the
    UUID to _recovered_dims instead so the real row wins on next drain.
    """
    if not path:
        return None
    now = datetime.now(timezone.utc).isoformat()
    if _looks_like_uuid(path):
        conn.execute(
            "INSERT OR IGNORE INTO _recovered_dims "
            "(id, kind, source_hint, recorded_at) "
            "VALUES (?, 'project', ?, ?)",
            (path, f"uuid-passthrough:{path[:8]}", now),
        )
        return path
    pid = str(_deterministic_project_id(path))
    repo = _normalize_path_to_repo(path)
    wtype = _derive_workspace_type(path)

    parent_id = None
    if wtype == "worktree":
        parent_path = _worktree_parent_path(path)
        if parent_path:
            parent_id = _resolve_project(conn, parent_path)

    conn.execute(
        """INSERT INTO projects
               (id, path, repo, workspace_type, parent_project_id,
                first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at""",
        (pid, path, repo, wtype, parent_id, now, now),
    )
    return pid


def _log_drain_failure(exc, context):
    """Append a failure record to drain-errors.log next to buffer.db.

    Silent on its own failure — drain must never raise into the caller.
    """
    import traceback
    try:
        log_path = BUFFER_PATH.parent / "drain-errors.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a") as f:
            f.write(f"--- {datetime.now(timezone.utc).isoformat()} ---\n")
            f.write(f"context: {context}\n")
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=f)
            f.write("\n")
    except Exception:
        pass


# Every column drain_to_buffer's INSERT references. If any of these are
# missing from an existing `events` table the DB is not v2-compatible.
_V2_EVENTS_COLUMNS = {
    "id", "dedupe_key", "session_id", "type", "timestamp", "cli",
    "user_id", "project_id", "tool_name", "skill_name", "duration_ms",
    "success", "error_text", "pr_number", "repo", "severity",
    "agent_name", "domain", "action", "passed", "score_value", "won",
    "prompt_text", "prompt_length", "is_correction", "payload_extra",
    "schema_version", "source", "synced_at",
}
_V2_USERS_COLUMNS = {
    "id", "github_login", "display_name", "aliases", "created_at",
}
_V2_PROJECTS_COLUMNS = {
    "id", "path", "repo", "workspace_type", "parent_project_id",
    "first_seen_at", "last_seen_at",
}


def _buffer_is_v2_compatible(buffer_path_str: str) -> bool:
    """Check that the existing buffer.db has the complete v2 surface.

    Returns False if any required table is missing or if any of the events
    / users / projects tables lack a column the v2 INSERT/UPSERT paths
    will write. A False return triggers quarantine + fresh v2 creation,
    so partial-v2 schemas can't wedge drains later.
    """
    probe = sqlite3.connect(buffer_path_str, timeout=10)
    try:
        tables = {
            row[0]
            for row in probe.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        for required in ("events", "users", "projects"):
            if required not in tables:
                return False
        events_cols = {
            row[1] for row in probe.execute("PRAGMA table_info(events)").fetchall()
        }
        users_cols = {
            row[1] for row in probe.execute("PRAGMA table_info(users)").fetchall()
        }
        projects_cols = {
            row[1] for row in probe.execute("PRAGMA table_info(projects)").fetchall()
        }
        return (
            _V2_EVENTS_COLUMNS.issubset(events_cols)
            and _V2_USERS_COLUMNS.issubset(users_cols)
            and _V2_PROJECTS_COLUMNS.issubset(projects_cols)
        )
    except sqlite3.DatabaseError:
        return False
    finally:
        probe.close()


def _replay_legacy_rows_into_queue(legacy_path: Path) -> int:
    """Copy unsynced rows out of a pre-upgrade buffer back into the pending queue.

    Handles both v1 schemas (`events(payload, project, ...)`) and partial-v2
    schemas (`events(payload_extra, project_id, lifted columns, ...)`) by
    inspecting the columns present and reconstructing a full event dict so
    drain_to_buffer can re-lift the canonical columns on the next run.

    Partial-v2 rows reference users/projects by UUID. We pre-load those
    dimension rows and map UUIDs back to their original `github_login` /
    `path` so the next drain re-upserts them into the fresh v2 buffer
    instead of inserting orphaned FKs.

    Raises if the DB is unreadable — the caller keeps the quarantined file
    in place so the operator can recover the backlog manually.
    """
    legacy = sqlite3.connect(str(legacy_path), timeout=10)
    legacy.row_factory = sqlite3.Row
    try:
        cols = {row[1] for row in legacy.execute("PRAGMA table_info(events)").fetchall()}
        if not {"type", "timestamp"}.issubset(cols):
            return 0
        if "payload_extra" not in cols and "payload" not in cols:
            return 0
        # Map UUID -> original login / path so partial-v2 FKs can be
        # re-resolved into dimension rows on the next drain.
        user_lookup: dict[str, str] = {}
        project_lookup: dict[str, str] = {}
        try:
            for u_row in legacy.execute("SELECT id, github_login FROM users"):
                if u_row["id"] and u_row["github_login"]:
                    user_lookup[u_row["id"]] = u_row["github_login"]
        except sqlite3.OperationalError:
            pass
        try:
            for p_row in legacy.execute("SELECT id, path FROM projects"):
                if p_row["id"] and p_row["path"]:
                    project_lookup[p_row["id"]] = p_row["path"]
        except sqlite3.OperationalError:
            pass
        # Replay only rows the backend hasn't already ingested. Earlier we
        # replayed every row (letting the API's dedupe reject duplicates),
        # but that pushed days of already-delivered history ahead of fresh
        # events every upgrade and starved the current drain. The original
        # buffer file is preserved as buffer.legacy.db so an operator can
        # still inspect synced history without re-delivering it.
        cols = {row[1] for row in legacy.execute("PRAGMA table_info(events)").fetchall()}
        if "synced_at" in cols:
            rows = legacy.execute(
                "SELECT * FROM events WHERE synced_at IS NULL"
            ).fetchall()
        else:
            rows = legacy.execute("SELECT * FROM events").fetchall()
    finally:
        legacy.close()

    replayed = 0
    failed = 0
    # Prefix synthesized keys with a hash of the source-file path so two
    # different quarantined buffers can both contain a row with id=1 without
    # colliding on legacy:1. The suffix is stable across replays of the
    # same file so re-running the replay stays a no-op.
    import hashlib
    source_tag = hashlib.sha256(str(legacy_path).encode("utf-8")).hexdigest()[:8]
    queue_db = _get_db()
    try:
        for raw in rows:
            row = dict(raw)
            # Synthesize a stable dedupe_key for legacy rows that didn't have
            # one so already-delivered history isn't re-delivered with a fresh
            # `drained:…` key. Prefer the legacy row.id (primary key); fall
            # back to a content hash over the envelope fields. Either key is
            # namespaced by source_tag so quarantines can't clobber each other.
            dedupe_key = row.get("dedupe_key")
            if not dedupe_key:
                legacy_id = row.get("id")
                if legacy_id:
                    dedupe_key = f"legacy:{source_tag}:{legacy_id}"
                else:
                    envelope = "|".join([
                        str(row.get("type") or ""),
                        str(row.get("timestamp") or ""),
                        str(row.get("user_id") or ""),
                        str(row.get("project") or row.get("project_id") or ""),
                    ])
                    digest = hashlib.sha256(envelope.encode("utf-8")).hexdigest()[:16]
                    dedupe_key = f"legacy:{source_tag}:sha256:{digest}"
            try:
                # Reconstruct a full payload: merge payload_extra (v2) or
                # payload (v1) with any lifted-column values present.
                base_json = row.get("payload_extra") or row.get("payload") or "{}"
                payload = json.loads(base_json) if base_json else {}
                for lifted in _V2_LIFTED_FIELDS:
                    value = row.get(lifted)
                    if value is not None and lifted not in payload:
                        payload[lifted] = value
                # Prefer the original login / path over the UUID FK when we
                # have it in the dimension tables, so the next drain rebuilds
                # the users/projects rows in the fresh v2 buffer.
                raw_user = row.get("user_id")
                user_value = (
                    user_lookup.get(raw_user)
                    if raw_user and _looks_like_uuid(raw_user)
                    else None
                ) or raw_user
                raw_project = row.get("project") or row.get("project_id")
                project_value = (
                    project_lookup.get(raw_project)
                    if raw_project and _looks_like_uuid(raw_project)
                    else None
                ) or raw_project
                event = {
                    "type": row.get("type") or "",
                    "timestamp": row.get("timestamp") or "",
                    "cli": row.get("cli"),
                    "user_id": user_value,
                    "project": project_value,
                    "payload": payload,
                    "schema_version": row.get("schema_version") or 1,
                    "source": row.get("source"),
                    "session_id": row.get("session_id"),
                    # Mirror the dedupe_key into the serialized event so that
                    # if drain() (HTTP path) picks up the replayed row later
                    # the backend still dedupes against the original key.
                    "dedupe_key": dedupe_key,
                }
                event_json = _redact(json.dumps(event, default=str))
                # Preserve the legacy created_at so these backlog rows keep
                # their original position in `ORDER BY created_at`; otherwise
                # they'd be restamped and risk indefinite overtake by newer
                # work after every upgrade.
                created_at = row.get("timestamp") or row.get("created_at")
                if created_at:
                    cursor = queue_db.execute(
                        "INSERT OR IGNORE INTO pending (dedupe_key, event_json, created_at) "
                        "VALUES (?, ?, ?)",
                        (dedupe_key, event_json, created_at),
                    )
                else:
                    cursor = queue_db.execute(
                        "INSERT OR IGNORE INTO pending (dedupe_key, event_json) VALUES (?, ?)",
                        (dedupe_key, event_json),
                    )
                if cursor.rowcount > 0:
                    replayed += 1
            except Exception as exc:
                failed += 1
                _log_drain_failure(exc, f"legacy-replay dedupe={dedupe_key}")
        queue_db.commit()
    finally:
        queue_db.close()
    if failed > 0:
        # Surface partial-replay failures so the caller keeps the legacy
        # file in place instead of renaming on a half-successful recovery.
        raise RuntimeError(
            f"legacy replay failed for {failed} of {len(rows)} rows"
        )
    return replayed


def _quarantine_legacy_buffer(buffer_path: Path) -> Path | None:
    """Rename a legacy (v1) buffer.db aside so a fresh v2 db can take its place.

    Replays unsynced rows from the legacy file back into the durable queue
    BEFORE the rename so that a replay failure (corrupt or locked DB) leaves
    the legacy file untouched at its original location — the caller can then
    retry the upgrade once the DB is readable instead of stranding events.
    """
    try:
        replayed = _replay_legacy_rows_into_queue(buffer_path)
    except (sqlite3.DatabaseError, RuntimeError) as exc:
        _log_drain_failure(
            exc,
            f"legacy buffer replay failed for {buffer_path}; leaving file in place for retry",
        )
        raise
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    legacy_path = buffer_path.with_name(f"{buffer_path.stem}.v1-{timestamp}.db")
    buffer_path.rename(legacy_path)
    for sidecar in ("-wal", "-shm"):
        sidecar_path = buffer_path.with_name(buffer_path.name + sidecar)
        if sidecar_path.exists():
            sidecar_path.rename(legacy_path.with_name(legacy_path.name + sidecar))
    _log_drain_failure(
        RuntimeError("legacy v1 buffer quarantined"),
        f"moved {buffer_path} -> {legacy_path}; replayed {replayed} unsynced rows",
    )
    return legacy_path


def _get_buffer_db() -> sqlite3.Connection:
    """Open the buffer database (creating v2 schema if needed).

    Schema mirrors stark_insights/db/buffer.py — keep in sync.
    """
    BUFFER_PATH.parent.mkdir(parents=True, exist_ok=True)
    buffer_path = str(BUFFER_PATH)

    # Buffers that aren't fully v2-compatible (legacy v1 or any partial
    # schema) cannot accept v2 inserts. Detect via the full probe and
    # quarantine before opening.
    if BUFFER_PATH.exists() and not _buffer_is_v2_compatible(buffer_path):
        _quarantine_legacy_buffer(BUFFER_PATH)
        _buffer_db_initialized.pop(buffer_path, None)

    db = sqlite3.connect(buffer_path, timeout=10)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA busy_timeout=5000")
    # _recovered_dims is an aux ledger for UUID pass-throughs. Create it on
    # every open so pre-existing v2 buffers gain it without a quarantine.
    # _buffer_is_v2_compatible does NOT require this table — the old code
    # created placeholder rows in users/projects instead, so omitting the
    # ledger is not itself a schema drift that justifies quarantining.
    db.execute(
        "CREATE TABLE IF NOT EXISTS _recovered_dims ("
        "id TEXT PRIMARY KEY, "
        "kind TEXT NOT NULL CHECK (kind IN ('user', 'project')), "
        "source_hint TEXT, "
        "recorded_at TEXT NOT NULL"
        ")"
    )
    if _needs_init(buffer_path, _buffer_db_initialized):
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                github_login TEXT NOT NULL UNIQUE,
                display_name TEXT,
                aliases TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                repo TEXT,
                workspace_type TEXT NOT NULL,
                parent_project_id TEXT REFERENCES projects(id),
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                timestamp TEXT NOT NULL,
                dedupe_key TEXT NOT NULL UNIQUE,
                type TEXT NOT NULL,
                cli TEXT,
                source TEXT,
                schema_version INTEGER NOT NULL DEFAULT 2,
                session_id TEXT,
                user_id TEXT REFERENCES users(id),
                project_id TEXT REFERENCES projects(id),
                tool_name TEXT,
                prompt_text TEXT,
                prompt_length INTEGER,
                is_correction INTEGER,
                skill_name TEXT,
                duration_ms INTEGER,
                success INTEGER,
                error_text TEXT,
                pr_number INTEGER,
                repo TEXT,
                severity TEXT,
                agent_name TEXT,
                domain TEXT,
                action TEXT,
                passed INTEGER,
                score_value REAL,
                won INTEGER,
                payload_extra TEXT NOT NULL DEFAULT '{}',
                synced_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_unsynced_timestamp
                ON events (synced_at, timestamp);
        """)
        _mark_initialized(buffer_path, _buffer_db_initialized)
    return db


_V2_LIFTED_FIELDS = (
    "tool_name", "skill_name", "duration_ms", "success", "error_text",
    "pr_number", "repo", "severity", "agent_name", "domain", "action",
    "passed", "score_value", "won", "prompt_text", "prompt_length",
    "is_correction",
)

_V2_BOOL_FIELDS = {"success", "passed", "won", "is_correction"}

# Legacy producers still emit these field names. Preserve v2 attribution
# by mapping them onto the canonical column when the canonical key isn't
# present. The original key is dropped from payload_extra to avoid double
# reporting.
_LEGACY_ALIASES: tuple[tuple[str, str], ...] = (
    ("skill", "skill_name"),
    ("tool", "tool_name"),
    ("agent", "agent_name"),
    ("duration_s", "duration_ms"),
)


def _coerce_bool(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int):
        return 1 if value else 0
    return None


def _lift_v2_columns(payload) -> tuple[dict, dict]:
    """Extract lifted v2 analytics columns from the event payload.

    Returns (lifted, extra) where `lifted` contains exactly the keys
    declared in _V2_LIFTED_FIELDS (None when missing) and `extra` is
    the remaining payload (preserved for forensic inspection in
    payload_extra). Legacy aliases (skill → skill_name, duration_s →
    duration_ms, etc.) are folded onto the canonical column when the
    canonical key isn't set, so pre-v2 producers keep their attribution.
    """
    if not isinstance(payload, dict):
        lifted = {field: None for field in _V2_LIFTED_FIELDS}
        return lifted, {}
    working = dict(payload)
    consumed: set[str] = set()
    for legacy_key, canonical in _LEGACY_ALIASES:
        if canonical in working and working.get(canonical) is not None:
            # Producer already used the canonical key — drop the alias if
            # present so we don't duplicate the data into payload_extra.
            if legacy_key in working:
                consumed.add(legacy_key)
            continue
        if legacy_key in working:
            value = working.pop(legacy_key)
            if canonical == "duration_ms" and isinstance(value, (int, float)):
                # Legacy producers sent seconds; v2 schema expects ms.
                value = int(round(value * 1000))
            working[canonical] = value
            consumed.add(legacy_key)
    lifted = {}
    for field in _V2_LIFTED_FIELDS:
        value = working.get(field)
        if field in _V2_BOOL_FIELDS:
            value = _coerce_bool(value)
        lifted[field] = value
    extra = {
        k: v for k, v in working.items()
        if k not in _V2_LIFTED_FIELDS and k not in consumed
    }
    return lifted, extra


def _write_event_to_buffer(buffer_db, dedupe_key, event_json, row_id=None):
    """Parse a queued event JSON and INSERT into buffer.events. Raises on
    validation failure so callers can decide whether to retry / dead-letter.
    Shared by drain_to_buffer's pending loop and retry_buffer_dead_letters,
    which writes directly to the buffer without going through pending.
    """
    event = json.loads(event_json)
    if not isinstance(event, dict):
        raise ValueError("event is not a JSON object")
    if not event.get("type"):
        raise ValueError("event is missing required `type` field")
    if not event.get("timestamp"):
        raise ValueError("event is missing required `timestamp` field")
    resolved_dedupe = (
        dedupe_key
        or event.get("dedupe_key")
        or event.get("event_id")
        or f"drained:{row_id if row_id is not None else 'retry'}:{event.get('type', '')}"
    )
    user_uuid = _resolve_user(buffer_db, event.get("user_id"))
    project_id = _resolve_project(buffer_db, event.get("project"))
    payload = event.get("payload") or {}
    lifted, extra = _lift_v2_columns(payload)
    buffer_db.execute(
        """INSERT OR IGNORE INTO events
           (id, dedupe_key, session_id,
            type, timestamp, cli, user_id, project_id,
            tool_name, skill_name, duration_ms, success, error_text,
            pr_number, repo, severity, agent_name, domain, action,
            passed, score_value, won, prompt_text, prompt_length,
            is_correction,
            payload_extra, schema_version, source, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, NULL)""",
        (
            str(_uuid.uuid4()),
            resolved_dedupe,
            event.get("session_id"),
            event.get("type", ""),
            event.get("timestamp", ""),
            event.get("cli"),
            user_uuid,
            project_id,
            lifted["tool_name"], lifted["skill_name"],
            lifted["duration_ms"], lifted["success"], lifted["error_text"],
            lifted["pr_number"], lifted["repo"], lifted["severity"],
            lifted["agent_name"], lifted["domain"], lifted["action"],
            lifted["passed"], lifted["score_value"], lifted["won"],
            lifted["prompt_text"], lifted["prompt_length"],
            lifted["is_correction"],
            json.dumps(extra),
            event.get("schema_version", 2),
            event.get("source"),
        ),
    )


def drain_to_buffer(batch_size: int = DRAIN_BATCH_SIZE) -> dict:
    """Flush pending events from queue.db directly into buffer.db (v2 schema).

    Resolves user_id/project to deterministic UUIDs and writes via lifted
    columns + payload_extra. Returns {sent, failed, dead_lettered}.
    Per-row failures are appended to drain-errors.log next to buffer.db
    and counted as retries; rows that fail MAX_RETRIES times are moved
    to dead_letter so poison rows cannot starve the pending window.
    """
    # Open queue_db first, then buffer_db. If buffer_db opening raises
    # (quarantine / probe failure), ensure queue_db is closed before
    # propagating — otherwise the WAL handle leaks and locks later
    # enqueue/drain attempts during recovery.
    queue_db = _get_db()
    try:
        buffer_db = _get_buffer_db()
    except BaseException:
        queue_db.close()
        raise
    stats = {"sent": 0, "failed": 0, "dead_lettered": 0}
    deletes: list[int] = []

    try:
        rows = queue_db.execute(
            "SELECT id, dedupe_key, event_json, created_at, retries FROM pending "
            "ORDER BY created_at LIMIT ?",
            (batch_size,),
        ).fetchall()

        for row_id, dedupe_key, event_json, created_at, retries in rows:
            try:
                _write_event_to_buffer(buffer_db, dedupe_key, event_json, row_id=row_id)
                deletes.append(row_id)
                stats["sent"] += 1
            except sqlite3.OperationalError as exc:
                error_text = f"{type(exc).__name__}: {exc}"[:500]
                lower = str(exc).lower()
                transient = (
                    "locked" in lower
                    or "busy" in lower
                    or "cannot start a transaction" in lower
                )
                if transient:
                    # Leave the row pending and let the next drain retry.
                    _log_drain_failure(
                        exc, f"row_id={row_id} dedupe={dedupe_key} (transient)"
                    )
                    queue_db.execute(
                        "UPDATE pending SET last_error = ? WHERE id = ?",
                        (error_text, row_id),
                    )
                    stats["failed"] += 1
                else:
                    # Permanent operational errors (read-only DB, disk I/O,
                    # schema mismatch) should count against retries so a
                    # genuinely broken buffer doesn't wedge the queue forever.
                    _log_drain_failure(
                        exc, f"row_id={row_id} dedupe={dedupe_key} (permanent)"
                    )
                    if retries + 1 >= MAX_RETRIES:
                        queue_db.execute(
                            "INSERT INTO dead_letter "
                            "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
                            "VALUES (?, ?, ?, ?, ?, 'buffer')",
                            (dedupe_key, event_json, created_at, retries + 1, error_text),
                        )
                        queue_db.execute(
                            "DELETE FROM pending WHERE id = ?", (row_id,)
                        )
                        stats["dead_lettered"] += 1
                    else:
                        queue_db.execute(
                            "UPDATE pending SET retries = ?, last_error = ? WHERE id = ?",
                            (retries + 1, error_text, row_id),
                        )
                        stats["failed"] += 1
            except Exception as exc:
                error_text = f"{type(exc).__name__}: {exc}"[:500]
                _log_drain_failure(exc, f"row_id={row_id} dedupe={dedupe_key}")
                if retries + 1 >= MAX_RETRIES:
                    queue_db.execute(
                        "INSERT INTO dead_letter "
                        "(dedupe_key, event_json, created_at, retries, last_error, source_path) "
                        "VALUES (?, ?, ?, ?, ?, 'buffer')",
                        (dedupe_key, event_json, created_at, retries + 1, error_text),
                    )
                    queue_db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
                    stats["dead_lettered"] += 1
                else:
                    queue_db.execute(
                        "UPDATE pending SET retries = ?, last_error = ? WHERE id = ?",
                        (retries + 1, error_text, row_id),
                    )
                    stats["failed"] += 1

        # Commit buffer FIRST — if this fails, the pending rows remain in
        # queue.db and will be retried (INSERT OR IGNORE handles duplicates
        # from any partial prior commit).
        buffer_db.commit()
        for row_id in deletes:
            queue_db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
        queue_db.commit()
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


def retry_buffer_dead_letters() -> int:
    """Write buffer-path dead letters directly to the v2 buffer and drop
    them from dead_letter on success. Returns count recovered.

    The recovery path deliberately bypasses `pending` so a concurrent
    `drain()` (HTTP sink) cannot pick up a row that was already rejected
    by the buffer sink — that would post the bad row to the API despite
    `source_path='buffer'`. Rows that still fail are left in dead_letter
    for the operator to triage.
    """
    queue_db = _get_db()
    try:
        buffer_db = _get_buffer_db()
    except BaseException:
        queue_db.close()
        raise
    recovered = 0
    try:
        rows = queue_db.execute(
            "SELECT id, dedupe_key, event_json FROM dead_letter "
            "WHERE source_path = 'buffer'"
        ).fetchall()
        for dl_id, dedupe_key, event_json in rows:
            try:
                _write_event_to_buffer(buffer_db, dedupe_key, event_json)
            except Exception as exc:
                _log_drain_failure(
                    exc, f"retry_buffer_dead_letters dl_id={dl_id}",
                )
                continue
            queue_db.execute("DELETE FROM dead_letter WHERE id = ?", (dl_id,))
            recovered += 1
        buffer_db.commit()
        queue_db.commit()
    finally:
        queue_db.close()
        buffer_db.close()
    return recovered


def retry_dead_letters() -> int:
    """Move HTTP-path dead-lettered events back to pending. Returns count moved.

    Buffer-path dead letters (source_path = 'buffer') are quarantined writes,
    not network failures, so re-queuing them would send a bad row to the API
    the next time the HTTP drain succeeds. They stay in dead_letter until an
    operator triages them directly — use retry_buffer_dead_letters() for
    that path. Legacy rows (source_path IS NULL) predate the split and are
    treated as HTTP so pre-existing behavior is preserved.
    """
    db = _get_db()
    try:
        rows = db.execute(
            "SELECT id, dedupe_key, event_json FROM dead_letter "
            "WHERE source_path = 'http' OR source_path IS NULL"
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
            (tool_use_id, tool_name, time.time()),
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
    now = time.time()
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
    now = time.time()
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
