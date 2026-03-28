#!/usr/bin/env python3
"""stark-persona — session persona system.

Assigns a famous character voice to Claude for the session. Supports weighted
random selection, mashup combos, feedback learning, and date-aware picks.

Usage:
    stark_persona.py select [--name NAME] [--combo] [--auto]
    stark_persona.py deactivate
    stark_persona.py rate --rating {like,hate}
    stark_persona.py survey
    stark_persona.py add --name NAME --source SOURCE --traits TRAITS
    stark_persona.py stats [--format {inline,table}]
    stark_persona.py history
    stark_persona.py print-roster
    stark_persona.py print-weights
    stark_persona.py session-end
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class PersonaRecord:
    """A character available for persona selection."""

    slug: str
    name: str
    source: str
    type: str  # "character" or "person"
    traits: list[str] = field(default_factory=list)
    catchphrase: Optional[str] = None
    speaking_style: str = ""
    date_signals: dict[str, str] = field(default_factory=dict)  # name → YYYY-MM-DD


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

DATA_DIR = Path.home() / ".stark-persona"
DB_PATH = DATA_DIR / "persona.db"


def ensure_dirs() -> None:
    """Create ~/.stark-persona/ if missing."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at    TEXT,
    persona     TEXT    NOT NULL,
    combo       TEXT,
    deactivated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ratings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  INTEGER NOT NULL REFERENCES sessions(id),
    persona     TEXT    NOT NULL,
    rating      TEXT    NOT NULL CHECK (rating IN ('like', 'hate')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS survey_responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    question    TEXT    NOT NULL,
    answer      TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS weights (
    persona     TEXT    PRIMARY KEY,
    weight      REAL    NOT NULL DEFAULT 1.0,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorite_combos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    combo       TEXT    NOT NULL,
    rating      REAL    NOT NULL DEFAULT 0.0,
    times_used  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
"""


def init_db(db_path: Path | str | None = None) -> sqlite3.Connection:
    """Initialize the persona database, creating tables if needed."""
    if db_path is None:
        db_path = DB_PATH
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn


# ---------------------------------------------------------------------------
# Roster (stub)
# ---------------------------------------------------------------------------

def load_roster() -> list[PersonaRecord]:
    """Load the character roster. STUB — returns empty list until #152."""
    return []


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_select(args: argparse.Namespace) -> int:
    """Select a persona for the session."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()
    if not roster:
        print(json.dumps({"error": "roster is empty — populate with 'add' or wait for #152"}))
        conn.close()
        return 1
    conn.close()
    return 0


def cmd_deactivate(args: argparse.Namespace) -> int:
    """Deactivate the current persona."""
    ensure_dirs()
    conn = init_db()
    # Mark the latest session as deactivated
    conn.execute(
        "UPDATE sessions SET deactivated = 1 WHERE id = (SELECT MAX(id) FROM sessions)"
    )
    conn.commit()
    print(json.dumps({"status": "deactivated"}))
    conn.close()
    return 0


def cmd_rate(args: argparse.Namespace) -> int:
    """Rate the current persona."""
    ensure_dirs()
    conn = init_db()
    row = conn.execute("SELECT id, persona FROM sessions ORDER BY id DESC LIMIT 1").fetchone()
    if not row:
        print(json.dumps({"error": "no active session"}))
        conn.close()
        return 1
    conn.execute(
        "INSERT INTO ratings (session_id, persona, rating) VALUES (?, ?, ?)",
        (row["id"], row["persona"], args.rating),
    )
    conn.commit()
    print(json.dumps({"status": "rated", "persona": row["persona"], "rating": args.rating}))
    conn.close()
    return 0


def cmd_survey(args: argparse.Namespace) -> int:
    """Run a quick preference survey."""
    ensure_dirs()
    init_db()
    # Survey questions will be populated in #152
    print(json.dumps({"questions": [], "note": "survey not yet implemented"}))
    return 0


def cmd_add(args: argparse.Namespace) -> int:
    """Add a new character to the roster."""
    ensure_dirs()
    conn = init_db()
    traits = [t.strip() for t in args.traits.split(",") if t.strip()]
    record = PersonaRecord(
        slug=args.name.lower().replace(" ", "-"),
        name=args.name,
        source=args.source,
        type="character",
        traits=traits,
    )
    # Store weight entry so the character appears in selections
    conn.execute(
        "INSERT OR REPLACE INTO weights (persona, weight) VALUES (?, ?)",
        (record.slug, 1.0),
    )
    conn.commit()
    print(json.dumps({"status": "added", "slug": record.slug, "name": record.name}))
    conn.close()
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    """Show persona usage statistics."""
    ensure_dirs()
    conn = init_db()
    total = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
    likes = conn.execute("SELECT COUNT(*) AS n FROM ratings WHERE rating = 'like'").fetchone()["n"]
    hates = conn.execute("SELECT COUNT(*) AS n FROM ratings WHERE rating = 'hate'").fetchone()["n"]

    data = {"sessions": total, "likes": likes, "hates": hates}

    if args.format == "table":
        print(f"{'Metric':<20} {'Value':>8}")
        print(f"{'-'*20} {'-'*8}")
        for k, v in data.items():
            print(f"{k:<20} {v:>8}")
    else:
        print(json.dumps(data))

    conn.close()
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    """Show session persona history."""
    ensure_dirs()
    conn = init_db()
    rows = conn.execute(
        "SELECT id, started_at, persona, combo, deactivated FROM sessions ORDER BY id DESC LIMIT 20"
    ).fetchall()
    if not rows:
        print("No sessions recorded yet.")
        return 0
    print(f"{'#':<4} {'Started':<20} {'Persona':<25} {'Combo':<15} {'Active':<6}")
    print(f"{'-'*4} {'-'*20} {'-'*25} {'-'*15} {'-'*6}")
    for r in rows:
        active = "no" if r["deactivated"] else "yes"
        combo = r["combo"] or ""
        print(f"{r['id']:<4} {r['started_at']:<20} {r['persona']:<25} {combo:<15} {active:<6}")
    conn.close()
    return 0


def cmd_print_roster(args: argparse.Namespace) -> int:
    """Print the full character roster."""
    ensure_dirs()
    roster = load_roster()
    if not roster:
        print(f"{'Slug':<25} {'Name':<25} {'Source':<20} {'Type':<10} {'Traits'}")
        print(f"{'-'*25} {'-'*25} {'-'*20} {'-'*10} {'-'*30}")
        print("(empty roster)")
        return 0
    print(f"{'Slug':<25} {'Name':<25} {'Source':<20} {'Type':<10} {'Traits'}")
    print(f"{'-'*25} {'-'*25} {'-'*20} {'-'*10} {'-'*30}")
    for r in roster:
        print(f"{r.slug:<25} {r.name:<25} {r.source:<20} {r.type:<10} {', '.join(r.traits)}")
    return 0


def cmd_print_weights(args: argparse.Namespace) -> int:
    """Print selection weights for all characters."""
    ensure_dirs()
    conn = init_db()
    rows = conn.execute("SELECT persona, weight, updated_at FROM weights ORDER BY weight DESC").fetchall()
    print(f"{'Persona':<30} {'Weight':>8} {'Updated':<20}")
    print(f"{'-'*30} {'-'*8} {'-'*20}")
    if not rows:
        print("(no weights recorded)")
    else:
        for r in rows:
            print(f"{r['persona']:<30} {r['weight']:>8.2f} {r['updated_at']:<20}")
    conn.close()
    return 0


def cmd_session_end(args: argparse.Namespace) -> int:
    """Mark the current session as ended."""
    ensure_dirs()
    conn = init_db()
    conn.execute(
        "UPDATE sessions SET ended_at = datetime('now') WHERE id = (SELECT MAX(id) FROM sessions)"
    )
    conn.commit()
    print(json.dumps({"status": "session_ended"}))
    conn.close()
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="stark_persona", description="Session persona system")
    sub = parser.add_subparsers(dest="command", required=True)

    # select
    p_sel = sub.add_parser("select", help="Select a persona")
    p_sel.add_argument("--name", help="Pick a specific character by name")
    p_sel.add_argument("--combo", action="store_true", help="Mashup 2-3 characters")
    p_sel.add_argument("--auto", action="store_true", help="JSON output for stark-session")

    # deactivate
    sub.add_parser("deactivate", help="Deactivate the current persona")

    # rate
    p_rate = sub.add_parser("rate", help="Rate the current persona")
    p_rate.add_argument("--rating", required=True, choices=["like", "hate"])

    # survey
    sub.add_parser("survey", help="Quick preference survey")

    # add
    p_add = sub.add_parser("add", help="Add a new character")
    p_add.add_argument("--name", required=True, help="Character name")
    p_add.add_argument("--source", required=True, help="Source (movie, book, etc.)")
    p_add.add_argument("--traits", required=True, help="Comma-separated traits")

    # stats
    p_stats = sub.add_parser("stats", help="Usage statistics")
    p_stats.add_argument("--format", choices=["inline", "table"], default="inline")

    # history
    sub.add_parser("history", help="Session persona history")

    # print-roster
    sub.add_parser("print-roster", help="Print full character roster")

    # print-weights
    sub.add_parser("print-weights", help="Print selection weights")

    # session-end
    sub.add_parser("session-end", help="Mark session as ended")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    dispatch = {
        "select": cmd_select,
        "deactivate": cmd_deactivate,
        "rate": cmd_rate,
        "survey": cmd_survey,
        "add": cmd_add,
        "stats": cmd_stats,
        "history": cmd_history,
        "print-roster": cmd_print_roster,
        "print-weights": cmd_print_weights,
        "session-end": cmd_session_end,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        parser.print_help()
        return 1
    return handler(args)


if __name__ == "__main__":
    sys.exit(main())
