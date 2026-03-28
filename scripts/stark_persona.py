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
import datetime
import difflib
import hashlib
import json
import os
import random
import re
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
ACTIVE_PATH = DATA_DIR / "active.json"

# Roster file: relative to this script's repo root
_SCRIPT_DIR = Path(__file__).resolve().parent
ROSTER_PATH = _SCRIPT_DIR.parent / "data" / "persona" / "roster.md"

_MINIMAL_SEED = """\
# Persona Roster

## Jules Winnfield
- **Slug:** jules-winnfield
- **Source:** Pulp Fiction (1994)
- **Type:** character
- **Traits:** intense, philosophical, dramatic, righteous, intimidating
- **Catchphrase:** "Allow me to retort."
- **Speaking style:** Biblical references, rhetorical questions, sudden intensity shifts.
- **Date signals:** Samuel L. Jackson birthday: 1948-12-21

## The Dude
- **Slug:** the-dude
- **Source:** The Big Lebowski (1998)
- **Type:** character
- **Traits:** zen, lazy, confused, stubborn, philosophical
- **Catchphrase:** "That's just, like, your opinion, man."
- **Speaking style:** Rambling, non-sequiturs, bowling metaphors, perpetual bewilderment.
- **Date signals:** Jeff Bridges birthday: 1949-12-04
"""


def ensure_dirs() -> None:
    """Create ~/.stark-persona/ if missing."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at            TEXT    NOT NULL DEFAULT (datetime('now')),
    ended_at              TEXT,
    persona               TEXT    NOT NULL,
    combo                 TEXT,
    deactivated           INTEGER NOT NULL DEFAULT 0,
    is_combo              INTEGER NOT NULL DEFAULT 0,
    combo_components      TEXT,
    date_signal_matched   INTEGER NOT NULL DEFAULT 0,
    date_signal_reason    TEXT
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
    # Migrate: add columns that may be missing on older databases
    _migrate_sessions(conn)
    return conn


def _migrate_sessions(conn: sqlite3.Connection) -> None:
    """Add new columns to sessions table if they don't exist yet."""
    existing = {
        row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
    }
    migrations = [
        ("is_combo", "INTEGER NOT NULL DEFAULT 0"),
        ("combo_components", "TEXT"),
        ("date_signal_matched", "INTEGER NOT NULL DEFAULT 0"),
        ("date_signal_reason", "TEXT"),
    ]
    for col, typedef in migrations:
        if col not in existing:
            conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {typedef}")
    conn.commit()


# ---------------------------------------------------------------------------
# Roster parsing (#152)
# ---------------------------------------------------------------------------

def _extract_field(lines: list[str], field_name: str) -> str | None:
    """Extract a **Field:** value from a list of markdown lines."""
    pattern = re.compile(rf"^-\s+\*\*{re.escape(field_name)}:\*\*\s*(.+)$")
    for line in lines:
        m = pattern.match(line.strip())
        if m:
            return m.group(1).strip()
    return None


def _parse_persona_section(name: str, lines: list[str], start_line: int) -> PersonaRecord:
    """Parse a single ## section into a PersonaRecord. Raises ValueError on issues."""
    slug = _extract_field(lines, "Slug")
    if not slug:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Slug'")

    source = _extract_field(lines, "Source")
    if not source:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Source'")

    ptype = _extract_field(lines, "Type")
    if not ptype:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Type'")
    if ptype not in ("character", "person"):
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' has invalid type '{ptype}' "
            f"(must be 'character' or 'person')"
        )

    traits_raw = _extract_field(lines, "Traits")
    traits = [t.strip() for t in (traits_raw or "").split(",") if t.strip()]
    if len(traits) < 3 or len(traits) > 5:
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' has {len(traits)} traits "
            f"(must have 3-5)"
        )

    catchphrase_raw = _extract_field(lines, "Catchphrase")
    catchphrase = None
    if catchphrase_raw and catchphrase_raw not in ("(none)", "none", ""):
        # Strip surrounding quotes if present
        catchphrase = catchphrase_raw.strip('"').strip("'")

    speaking_style = _extract_field(lines, "Speaking style") or ""
    if not speaking_style:
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' missing required field 'Speaking style'"
        )

    # Parse date signals: "label: YYYY-MM-DD" patterns
    date_signals: dict[str, str] = {}
    ds_raw = _extract_field(lines, "Date signals")
    if ds_raw:
        # Format: "Label: YYYY-MM-DD" or "label1: date1, label2: date2"
        # But typically one per persona. Split on pattern.
        for match in re.finditer(r"([^:,]+?):\s*(\d{4}-\d{2}-\d{2})", ds_raw):
            date_signals[match.group(1).strip()] = match.group(2)

    return PersonaRecord(
        slug=slug,
        name=name,
        source=source,
        type=ptype,
        traits=traits,
        catchphrase=catchphrase,
        speaking_style=speaking_style,
        date_signals=date_signals,
    )


def load_roster(roster_path: Path | str | None = None) -> list[PersonaRecord]:
    """Load the character roster from the markdown file.

    If the roster file is missing, creates a minimal seed (Jules + The Dude)
    and parses that instead.
    """
    if roster_path is None:
        roster_path = ROSTER_PATH
    roster_path = Path(roster_path)

    if not roster_path.exists():
        roster_path.parent.mkdir(parents=True, exist_ok=True)
        roster_path.write_text(_MINIMAL_SEED)

    text = roster_path.read_text()
    return parse_roster(text)


def parse_roster(text: str) -> list[PersonaRecord]:
    """Parse roster markdown text into PersonaRecord list."""
    lines = text.splitlines()
    sections: list[tuple[str, int, list[str]]] = []  # (name, line_num, body_lines)

    current_name: str | None = None
    current_start = 0
    current_lines: list[str] = []

    for i, line in enumerate(lines, start=1):
        if line.startswith("## "):
            # Save previous section
            if current_name is not None:
                sections.append((current_name, current_start, current_lines))
            current_name = line[3:].strip()
            current_start = i
            current_lines = []
        elif current_name is not None:
            current_lines.append(line)

    # Don't forget the last section
    if current_name is not None:
        sections.append((current_name, current_start, current_lines))

    roster: list[PersonaRecord] = []
    for name, start_line, body in sections:
        roster.append(_parse_persona_section(name, body, start_line))

    return roster


# ---------------------------------------------------------------------------
# Active state layer (#153)
# ---------------------------------------------------------------------------

def load_active(active_path: Path | str | None = None) -> dict | None:
    """Read ~/.stark-persona/active.json. Returns None if missing."""
    if active_path is None:
        active_path = ACTIVE_PATH
    active_path = Path(active_path)
    if not active_path.exists():
        return None
    return json.loads(active_path.read_text())


def write_active(data: dict, active_path: Path | str | None = None) -> None:
    """Write active.json atomically (write to .tmp, rename)."""
    if active_path is None:
        active_path = ACTIVE_PATH
    active_path = Path(active_path)
    active_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = active_path.with_suffix(f".tmp")
    tmp_path.write_text(json.dumps(data, indent=2) + "\n")
    tmp_path.rename(active_path)


def delete_active(active_path: Path | str | None = None) -> None:
    """Delete active.json if it exists."""
    if active_path is None:
        active_path = ACTIVE_PATH
    active_path = Path(active_path)
    if active_path.exists():
        active_path.unlink()


def sync_weights(roster: list[PersonaRecord], conn: sqlite3.Connection) -> None:
    """Ensure every roster persona has a weights row (insert missing with defaults)."""
    existing = {
        row["persona"]
        for row in conn.execute("SELECT persona FROM weights").fetchall()
    }
    for record in roster:
        if record.slug not in existing:
            conn.execute(
                "INSERT INTO weights (persona, weight) VALUES (?, ?)",
                (record.slug, 1.0),
            )
    conn.commit()


# ---------------------------------------------------------------------------
# Selection engine (#154, #155, #156)
# ---------------------------------------------------------------------------


def _get_persona_stats(conn: sqlite3.Connection, slug: str) -> dict:
    """Get selection_count, like_count, hate_count for a persona."""
    sel = conn.execute(
        "SELECT COUNT(*) AS n FROM sessions WHERE persona = ?", (slug,)
    ).fetchone()["n"]
    likes = conn.execute(
        "SELECT COUNT(*) AS n FROM ratings WHERE persona = ? AND rating = 'like'",
        (slug,),
    ).fetchone()["n"]
    hates = conn.execute(
        "SELECT COUNT(*) AS n FROM ratings WHERE persona = ? AND rating = 'hate'",
        (slug,),
    ).fetchone()["n"]
    return {"selection_count": sel, "like_count": likes, "hate_count": hates}


def compute_weight(weights_row: dict) -> float:
    """Compute selection weight from persona stats.

    Args:
        weights_row: dict with selection_count, like_count, hate_count
    """
    selection_count = weights_row.get("selection_count", 0)
    like_count = weights_row.get("like_count", 0)
    hate_count = weights_row.get("hate_count", 0)

    if selection_count == 0:
        return 1.5  # discovery boost

    net = like_count - hate_count
    if net > 0:
        return 1.0 + (min(net, 5) * 0.4)  # max 3.0
    elif net < 0:
        return max(0.2, 1.0 + (net * 0.4))  # floor 0.2
    else:
        return 1.0


def get_date_matches(
    roster: list[PersonaRecord], today: datetime.date | None = None
) -> list[PersonaRecord]:
    """Return personas whose date signals match today's month-day."""
    if today is None:
        today = datetime.date.today()
    matches = []
    for persona in roster:
        for _label, date_str in persona.date_signals.items():
            try:
                d = datetime.date.fromisoformat(date_str)
                if d.month == today.month and d.day == today.day:
                    matches.append(persona)
                    break  # one match per persona is enough
            except ValueError:
                continue
    return matches


def fuzzy_match_persona(
    roster: list[PersonaRecord], name: str
) -> PersonaRecord | None:
    """Fuzzy-match a name against roster slugs and display names."""
    # Exact slug match first
    for p in roster:
        if p.slug == name or p.name.lower() == name.lower():
            return p

    # Fuzzy match on slugs
    slugs = [p.slug for p in roster]
    slug_matches = difflib.get_close_matches(name.lower(), slugs, n=1, cutoff=0.5)
    if slug_matches:
        return next(p for p in roster if p.slug == slug_matches[0])

    # Fuzzy match on display names
    names = [p.name.lower() for p in roster]
    name_matches = difflib.get_close_matches(name.lower(), names, n=1, cutoff=0.5)
    if name_matches:
        return next(p for p in roster if p.name.lower() == name_matches[0])

    return None


def _weighted_random_pick(
    roster: list[PersonaRecord], conn: sqlite3.Connection, rng: random.Random | None = None
) -> PersonaRecord:
    """Pick a persona using weighted random selection."""
    if rng is None:
        rng = random.Random()
    weights = []
    for p in roster:
        stats = _get_persona_stats(conn, p.slug)
        weights.append(compute_weight(stats))
    chosen = rng.choices(roster, weights=weights, k=1)[0]
    return chosen


def _persist_selection(
    persona: PersonaRecord,
    conn: sqlite3.Connection,
    active_path: Path | str | None = None,
    is_combo: bool = False,
    combo_components: str | None = None,
    date_signal_matched: bool = False,
    date_signal_reason: str | None = None,
) -> dict:
    """Insert session row, update weight, write active.json, return result dict."""
    # Compute new weight from stats
    stats = _get_persona_stats(conn, persona.slug)
    stats["selection_count"] += 1  # count this selection
    new_weight = compute_weight(stats)

    # Insert session
    cur = conn.execute(
        """INSERT INTO sessions
           (persona, is_combo, combo_components, date_signal_matched, date_signal_reason)
           VALUES (?, ?, ?, ?, ?)""",
        (
            persona.slug,
            int(is_combo),
            combo_components,
            int(date_signal_matched),
            date_signal_reason,
        ),
    )
    session_id = cur.lastrowid

    # Update weight
    conn.execute(
        """INSERT INTO weights (persona, weight, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')""",
        (persona.slug, new_weight, new_weight),
    )
    conn.commit()

    result = {
        "session_id": session_id,
        "persona": persona.slug,
        "name": persona.name,
        "source": persona.source,
        "traits": persona.traits,
        "speaking_style": persona.speaking_style,
        "weight": new_weight,
    }
    if persona.catchphrase:
        result["catchphrase"] = persona.catchphrase
    if date_signal_matched:
        result["date_signal_matched"] = True
        result["date_signal_reason"] = date_signal_reason
    if is_combo:
        result["is_combo"] = True
        result["combo_components"] = json.loads(combo_components) if combo_components else []

    # Write active.json
    write_active(result, active_path)

    return result


def select_single_persona(
    roster: list[PersonaRecord],
    conn: sqlite3.Connection,
    name: str | None = None,
    auto: bool = False,
    active_path: Path | str | None = None,
    rng: random.Random | None = None,
    today: datetime.date | None = None,
) -> dict:
    """Select a single persona — by name, date signal, or weighted random.

    Returns a dict with persona info.
    """
    if rng is None:
        rng = random.Random()

    date_signal_matched = False
    date_signal_reason: str | None = None

    if name:
        # Fuzzy name match
        persona = fuzzy_match_persona(roster, name)
        if persona is None:
            return {"error": f"No persona matching '{name}' found in roster"}
    else:
        # Check date matches first (#155)
        date_matches = get_date_matches(roster, today)
        if date_matches and rng.random() < 0.25:
            persona = rng.choice(date_matches)
            date_signal_matched = True
            # Find which signal matched
            check_date = today or datetime.date.today()
            for label, date_str in persona.date_signals.items():
                try:
                    d = datetime.date.fromisoformat(date_str)
                    if d.month == check_date.month and d.day == check_date.day:
                        date_signal_reason = label
                        break
                except ValueError:
                    continue
        else:
            # Weighted random
            persona = _weighted_random_pick(roster, conn, rng)

    return _persist_selection(
        persona,
        conn,
        active_path=active_path,
        date_signal_matched=date_signal_matched,
        date_signal_reason=date_signal_reason,
    )


def select_combo(
    roster: list[PersonaRecord],
    conn: sqlite3.Connection,
    active_path: Path | str | None = None,
    rng: random.Random | None = None,
) -> dict:
    """Select a combo of 2-3 personas, pick 1-2 traits from each, synthesize."""
    if rng is None:
        rng = random.Random()
    if len(roster) < 2:
        return {"error": "Need at least 2 personas in roster for a combo"}

    count = rng.choice([2, 3]) if len(roster) >= 3 else 2

    # Weighted selection of distinct personas
    chosen: list[PersonaRecord] = []
    remaining = list(roster)
    for _ in range(count):
        pick = _weighted_random_pick(remaining, conn, rng)
        chosen.append(pick)
        remaining = [p for p in remaining if p.slug != pick.slug]

    # Pick 1-2 traits from each
    components = []
    all_traits = []
    for p in chosen:
        trait_count = rng.randint(1, min(2, len(p.traits)))
        selected_traits = rng.sample(p.traits, trait_count)
        components.append({
            "slug": p.slug,
            "name": p.name,
            "traits": selected_traits,
        })
        all_traits.extend(selected_traits)

    # Generate combo name
    names = [p.name for p in chosen]
    if len(names) == 2:
        combo_name = f"{names[0]} meets {names[1]}"
    else:
        combo_name = " \u00d7 ".join(names)

    # Speaking style synthesis
    styles = [p.speaking_style for p in chosen if p.speaking_style]
    speaking_style = " Blended with: ".join(styles) if styles else ""

    # Recipe hash: deterministic from sorted slugs
    sorted_slugs = sorted(p.slug for p in chosen)
    recipe_hash = hashlib.sha256("|".join(sorted_slugs).encode()).hexdigest()[:12]

    combo_components_json = json.dumps(components)

    # Use first persona as the "primary" for the session row
    primary = chosen[0]

    # Insert session
    cur = conn.execute(
        """INSERT INTO sessions
           (persona, combo, is_combo, combo_components)
           VALUES (?, ?, 1, ?)""",
        (primary.slug, combo_name, combo_components_json),
    )
    session_id = cur.lastrowid

    # Update weights for all chosen
    for p in chosen:
        stats = _get_persona_stats(conn, p.slug)
        stats["selection_count"] += 1
        w = compute_weight(stats)
        conn.execute(
            """INSERT INTO weights (persona, weight, updated_at)
               VALUES (?, ?, datetime('now'))
               ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')""",
            (p.slug, w, w),
        )
    conn.commit()

    result = {
        "session_id": session_id,
        "combo_name": combo_name,
        "is_combo": True,
        "components": components,
        "all_traits": all_traits,
        "speaking_style": speaking_style,
        "recipe_hash": recipe_hash,
    }

    write_active(result, active_path)
    return result


# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

def cmd_select(args: argparse.Namespace) -> int:
    """Select a persona for the session."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()
    if not roster:
        print(json.dumps({"error": "roster is empty — populate with 'add' or seed roster.md"}))
        conn.close()
        return 1

    sync_weights(roster, conn)

    if args.combo:
        result = select_combo(roster, conn)
    else:
        result = select_single_persona(
            roster, conn, name=args.name, auto=args.auto,
        )

    if "error" in result:
        print(json.dumps(result))
        conn.close()
        return 1

    if args.auto:
        print(json.dumps(result))
    else:
        # Human-friendly output
        if result.get("is_combo"):
            print(f"Combo: {result['combo_name']}")
            print(f"Traits: {', '.join(result['all_traits'])}")
            print(f"Style: {result['speaking_style']}")
            print(f"Recipe: {result['recipe_hash']}")
        else:
            print(f"Persona: {result['name']} ({result['persona']})")
            print(f"Source: {result['source']}")
            print(f"Traits: {', '.join(result['traits'])}")
            print(f"Style: {result['speaking_style']}")
            if result.get("catchphrase"):
                print(f"Catchphrase: {result['catchphrase']}")
            if result.get("date_signal_matched"):
                print(f"Date match: {result['date_signal_reason']}")

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
    # Survey questions will be populated later
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
        print("(empty roster)")
        return 0
    print(f"{'Slug':<25} {'Name':<25} {'Source':<30} {'Type':<10} {'Traits'}")
    print(f"{'-'*25} {'-'*25} {'-'*30} {'-'*10} {'-'*30}")
    for r in roster:
        print(f"{r.slug:<25} {r.name:<25} {r.source:<30} {r.type:<10} {', '.join(r.traits)}")
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
