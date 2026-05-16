#!/usr/bin/env python3
"""Canonical emit-queue CLI for the red-team subsystem (Phase 1).

Thin wrapper around the existing ``scripts/emit_queue.py`` module so the
TS Phase 1 lib (and any other cross-language consumer) has a stable
subprocess seam — same model as ``scripts/red_team_audit_cli.py``.

Subcommands:

  enqueue       Validate + persist an event to the local queue.
  peek          List pending or dead-letter rows as JSON.
  mark-done     Remove a pending row by event_id (idempotent).
  dead-letter   Move a pending row to dead_letter (idempotent).

Stdout discipline: every subcommand emits exactly one JSON envelope on
stdout; logs go to stderr. Idempotency: ``enqueue`` is idempotent on
``event_id`` via the underlying ``dedupe_key`` index — a second call
with the same event returns ``{"ok": true, "duplicate": true}`` with
the same row id semantics.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emit_queue  # noqa: E402


STUB_EXIT_CODE = 0
EXIT_BAD_INPUT = 2
EXIT_NOT_FOUND = 3


def _emit(envelope: dict[str, Any]) -> None:
    json.dump(envelope, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _read_stdin_json() -> Any:
    raw = sys.stdin.read()
    if not raw.strip():
        return None
    return json.loads(raw)


# ── enqueue ──────────────────────────────────────────────────────────────


def _cmd_enqueue(args: argparse.Namespace) -> int:
    """Build + enqueue an event. Payload from --payload-json or stdin."""
    payload_raw: str | None = args.payload_json
    if payload_raw == "-" or payload_raw is None:
        try:
            payload_data = _read_stdin_json()
        except json.JSONDecodeError as exc:
            _emit({"error": "bad_payload_json", "detail": str(exc)})
            return EXIT_BAD_INPUT
        if payload_data is None:
            _emit({"error": "missing_payload", "detail": "expected JSON payload via stdin or --payload-json"})
            return EXIT_BAD_INPUT
    elif payload_raw.startswith("@"):
        path = Path(payload_raw[1:])
        try:
            payload_data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            _emit({"error": "bad_payload_file", "path": str(path), "detail": str(exc)})
            return EXIT_BAD_INPUT
    else:
        try:
            payload_data = json.loads(payload_raw)
        except json.JSONDecodeError as exc:
            _emit({"error": "bad_payload_json", "detail": str(exc)})
            return EXIT_BAD_INPUT

    # Allow callers to pass either {"type": ..., "payload": {...}} or a bare
    # event payload + a --type flag. Idempotent on dedupe_key (which the
    # caller may supply explicitly; otherwise we mint one keyed on
    # event_id once the event is built).
    if isinstance(payload_data, dict) and "type" in payload_data and "payload" in payload_data:
        event_type = payload_data["type"]
        inner_payload = payload_data["payload"]
        dedupe_key = payload_data.get("dedupe_key")
    elif args.type:
        event_type = args.type
        inner_payload = payload_data
        dedupe_key = args.dedupe_key
    else:
        _emit({"error": "missing_type", "detail": "pass --type or include 'type' in the JSON envelope"})
        return EXIT_BAD_INPUT

    try:
        event = emit_queue.make_event(
            event_type,
            inner_payload,
            dedupe_key=dedupe_key,
        )
    except Exception as exc:  # noqa: BLE001 — surface validation errors as JSON
        _emit({"error": "make_event_failed", "detail": str(exc)})
        return EXIT_BAD_INPUT

    # If the caller didn't pass an explicit dedupe_key but emit_queue.make_event
    # also didn't compute one, fall back to event_id so a retry coalesces.
    if "dedupe_key" not in event:
        event["dedupe_key"] = event["event_id"]

    try:
        row_id = emit_queue.enqueue(event)
    except ValueError as exc:
        _emit({"error": "validation_failed", "detail": str(exc)})
        return EXIT_BAD_INPUT
    except Exception as exc:  # noqa: BLE001
        _emit({"error": "enqueue_failed", "detail": str(exc)})
        return 1

    duplicate = row_id is None
    _emit({
        "ok": True,
        "event_id": event["event_id"],
        "dedupe_key": event["dedupe_key"],
        "type": event["type"],
        "row_id": row_id,
        "duplicate": duplicate,
    })
    return 0


# ── peek ─────────────────────────────────────────────────────────────────


def _peek_table(table: str, limit: int) -> list[dict[str, Any]]:
    db = emit_queue._get_db()  # internal helper; the CLI is the only sanctioned external use.
    try:
        if table == "pending":
            rows = db.execute(
                "SELECT id, dedupe_key, event_json, created_at, retries, last_error "
                "FROM pending ORDER BY created_at LIMIT ?",
                (limit,),
            ).fetchall()
            cols = ["id", "dedupe_key", "event_json", "created_at", "retries", "last_error"]
        elif table == "dead_letter":
            rows = db.execute(
                "SELECT id, dedupe_key, event_json, created_at, retries, last_error "
                "FROM dead_letter ORDER BY created_at LIMIT ?",
                (limit,),
            ).fetchall()
            cols = ["id", "dedupe_key", "event_json", "created_at", "retries", "last_error"]
        else:
            raise ValueError(f"unknown source: {table!r}")
    finally:
        db.close()
    result: list[dict[str, Any]] = []
    for row in rows:
        entry: dict[str, Any] = dict(zip(cols, row))
        try:
            entry["event"] = json.loads(entry["event_json"])
        except (TypeError, json.JSONDecodeError):
            entry["event"] = None
        del entry["event_json"]
        result.append(entry)
    return result


def _cmd_peek(args: argparse.Namespace) -> int:
    source = args.source
    if source not in {"pending", "dead-letter"}:
        _emit({"error": "bad_source", "detail": f"--source must be pending|dead-letter, got {source!r}"})
        return EXIT_BAD_INPUT
    table = "dead_letter" if source == "dead-letter" else "pending"
    try:
        rows = _peek_table(table, max(1, args.limit))
    except Exception as exc:  # noqa: BLE001
        _emit({"error": "peek_failed", "source": source, "detail": str(exc)})
        return 1
    _emit({"ok": True, "source": source, "rows": rows, "count": len(rows)})
    return 0


# ── mark-done ────────────────────────────────────────────────────────────


def _resolve_row_by_event_id(
    db: sqlite3.Connection, table: str, event_id: str
) -> tuple[int, str] | None:
    """Find a row in ``table`` whose event_json carries ``event_id``."""
    rows = db.execute(
        f"SELECT id, dedupe_key, event_json FROM {table}",
    ).fetchall()
    for row_id, dedupe_key, event_json in rows:
        try:
            parsed = json.loads(event_json)
        except json.JSONDecodeError:
            continue
        if parsed.get("event_id") == event_id:
            return row_id, dedupe_key
    return None


def _cmd_mark_done(args: argparse.Namespace) -> int:
    """Delete a pending row by event_id. Idempotent (no-op if already gone)."""
    if not args.event_id and not args.dedupe_key:
        _emit({"error": "missing_id", "detail": "pass --event-id or --dedupe-key"})
        return EXIT_BAD_INPUT
    db = emit_queue._get_db()
    try:
        if args.dedupe_key:
            cur = db.execute(
                "DELETE FROM pending WHERE dedupe_key = ?", (args.dedupe_key,)
            )
            removed = cur.rowcount
            db.commit()
            _emit({"ok": True, "removed": removed, "dedupe_key": args.dedupe_key, "already_done": removed == 0})
            return 0
        match = _resolve_row_by_event_id(db, "pending", args.event_id)
        if match is None:
            _emit({"ok": True, "removed": 0, "event_id": args.event_id, "already_done": True})
            return 0
        row_id, _ = match
        db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
        db.commit()
        _emit({"ok": True, "removed": 1, "event_id": args.event_id, "already_done": False})
        return 0
    finally:
        db.close()


# ── dead-letter ──────────────────────────────────────────────────────────


def _cmd_dead_letter(args: argparse.Namespace) -> int:
    """Move a pending row to dead_letter with a reason. Idempotent."""
    if not args.event_id and not args.dedupe_key:
        _emit({"error": "missing_id", "detail": "pass --event-id or --dedupe-key"})
        return EXIT_BAD_INPUT
    reason = args.reason or "manually_dead_lettered"
    db = emit_queue._get_db()
    try:
        if args.dedupe_key:
            row = db.execute(
                "SELECT id, event_json, created_at, retries FROM pending "
                "WHERE dedupe_key = ?",
                (args.dedupe_key,),
            ).fetchone()
            if row is None:
                _emit({"ok": True, "moved": 0, "dedupe_key": args.dedupe_key, "already_dead_lettered": True})
                return 0
            row_id, event_json, created_at, retries = row
            db.execute(
                "INSERT OR IGNORE INTO dead_letter "
                "(dedupe_key, event_json, created_at, retries, last_error) "
                "VALUES (?, ?, ?, ?, ?)",
                (args.dedupe_key, event_json, created_at, retries, reason),
            )
            db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
            db.commit()
            _emit({"ok": True, "moved": 1, "dedupe_key": args.dedupe_key, "reason": reason})
            return 0
        match = _resolve_row_by_event_id(db, "pending", args.event_id)
        if match is None:
            _emit({"ok": True, "moved": 0, "event_id": args.event_id, "already_dead_lettered": True})
            return 0
        row_id, dedupe_key = match
        full = db.execute(
            "SELECT event_json, created_at, retries FROM pending WHERE id = ?",
            (row_id,),
        ).fetchone()
        event_json, created_at, retries = full
        db.execute(
            "INSERT OR IGNORE INTO dead_letter "
            "(dedupe_key, event_json, created_at, retries, last_error) "
            "VALUES (?, ?, ?, ?, ?)",
            (dedupe_key, event_json, created_at, retries, reason),
        )
        db.execute("DELETE FROM pending WHERE id = ?", (row_id,))
        db.commit()
        _emit({"ok": True, "moved": 1, "event_id": args.event_id, "dedupe_key": dedupe_key, "reason": reason})
        return 0
    finally:
        db.close()


# ── argparse ─────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_emit_queue_cli",
        description=(
            "Canonical emit-queue CLI for the red-team subsystem. Wraps "
            "scripts/emit_queue.py with JSON-in / JSON-out subcommands."
        ),
    )
    sub = p.add_subparsers(dest="subcommand", required=True)

    eq = sub.add_parser("enqueue", help="Persist an event to the local queue. Idempotent on dedupe_key.")
    eq.add_argument("--type", help="Event type (e.g. red_team_run). Required unless type is in the JSON envelope.")
    eq.add_argument(
        "--payload-json",
        default=None,
        help=(
            "Either a literal JSON string, an @filename, or '-' for stdin. "
            "Defaults to stdin when omitted."
        ),
    )
    eq.add_argument(
        "--dedupe-key",
        default=None,
        help="Explicit dedupe key. Defaults to event_id if not supplied.",
    )

    pk = sub.add_parser("peek", help="List queued or dead-lettered rows as JSON.")
    pk.add_argument(
        "--source",
        default="pending",
        choices=["pending", "dead-letter"],
        help="Which queue to read from. Default: pending.",
    )
    pk.add_argument("--limit", type=int, default=20, help="Max rows to return. Default: 20.")

    md = sub.add_parser(
        "mark-done",
        help="Delete a pending row by event_id (or --dedupe-key). Idempotent.",
    )
    md.add_argument("--event-id", default=None, help="Event id to delete.")
    md.add_argument("--dedupe-key", default=None, help="Alternative: delete by dedupe_key.")

    dl = sub.add_parser(
        "dead-letter",
        help="Move a pending row to the dead_letter table. Idempotent.",
    )
    dl.add_argument("--event-id", default=None)
    dl.add_argument("--dedupe-key", default=None)
    dl.add_argument(
        "--reason",
        default=None,
        help="Free-text reason recorded as last_error. Default: 'manually_dead_lettered'.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    handler = {
        "enqueue": _cmd_enqueue,
        "peek": _cmd_peek,
        "mark-done": _cmd_mark_done,
        "dead-letter": _cmd_dead_letter,
    }[args.subcommand]
    return handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
