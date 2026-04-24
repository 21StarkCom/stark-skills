#!/usr/bin/env python3
"""stark-persona — session persona system.

Assigns a famous character voice to Claude for the session. Supports weighted
random selection, mashup combos, feedback learning, and date-aware picks.

Usage:
    stark_persona.py select [--name NAME] [--combo] [--auto]
    stark_persona.py deactivate
    stark_persona.py rate --rating {like,hate}
    stark_persona.py survey
    stark_persona.py survey-answer --question Q --answer A
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
import logging
import os
import random
import re
import sqlite3
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)


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
    category: Optional[str] = None
    domain: Optional[str] = None
    archetype: Optional[str] = None
    traits: list[str] = field(default_factory=list)
    catchphrase: Optional[str] = None
    signature_quotes: list[str] = field(default_factory=list)
    voice_profile: list[str] = field(default_factory=list)
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
    session_id  INTEGER NOT NULL UNIQUE REFERENCES sessions(id),
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
    combo       TEXT    NOT NULL UNIQUE,
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

    # Ensure UNIQUE index on ratings.session_id for upsert (INSERT OR REPLACE)
    _ensure_index(conn, "ratings", "idx_ratings_session_id", "session_id", unique=True)
    # Ensure UNIQUE index on favorite_combos.combo for upsert
    _ensure_index(conn, "favorite_combos", "idx_favorite_combos_combo", "combo", unique=True)
    conn.commit()


def _ensure_index(
    conn: sqlite3.Connection, table: str, index_name: str, column: str, *, unique: bool = False
) -> None:
    """Create an index if it doesn't already exist."""
    existing = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name=?",
        (table, index_name),
    ).fetchone()
    if not existing:
        uq = "UNIQUE" if unique else ""
        conn.execute(f"CREATE {uq} INDEX IF NOT EXISTS {index_name} ON {table}({column})")


# ---------------------------------------------------------------------------
# Roster parsing (#152)
# ---------------------------------------------------------------------------

def _parse_field_blocks(lines: list[str]) -> dict[str, dict[str, object]]:
    """Parse markdown field blocks into a structured mapping.

    Supports both legacy single-line values:
        - **Source:** Pulp Fiction (1994)

    And structured list values:
        - **Signature quote fragments:**
          - "Allow me to retort."
          - "Say what again."
    """

    field_re = re.compile(r"^-\s+\*\*(.+?):\*\*\s*(.*)$")
    fields: dict[str, dict[str, object]] = {}
    current_name: str | None = None
    current_value: str = ""
    current_items: list[str] = []

    def flush() -> None:
        if current_name is None:
            return
        fields[current_name] = {
            "value": current_value.strip() or None,
            "items": list(current_items),
        }

    for raw_line in lines:
        line = raw_line.rstrip()
        match = field_re.match(line)
        if match:
            flush()
            current_name = match.group(1).strip()
            current_value = match.group(2).strip()
            current_items = []
            continue

        if current_name is None:
            continue

        if line.startswith("  - "):
            current_items.append(line[4:].strip())
            continue

        if not line.strip():
            continue

        # Allow wrapped continuation lines for either scalar values or list items.
        if current_items:
            current_items[-1] = f"{current_items[-1]} {line.strip()}"
        else:
            current_value = f"{current_value} {line.strip()}".strip()

    flush()
    return fields


def _extract_field(fields: dict[str, dict[str, object]], field_name: str) -> str | None:
    """Extract the scalar value for a parsed field block."""
    block = fields.get(field_name)
    if not block:
        return None
    value = block.get("value")
    return value if isinstance(value, str) else None


def _extract_list_field(fields: dict[str, dict[str, object]], field_name: str) -> list[str]:
    """Extract a list field, accepting bullets or a fallback scalar value."""
    block = fields.get(field_name)
    if not block:
        return []
    items = block.get("items")
    if isinstance(items, list) and items:
        return [
            item.strip()
            for item in items
            if isinstance(item, str)
            and item.strip()
            and item.strip().lower() not in {"(none)", "none"}
        ]
    value = block.get("value")
    if isinstance(value, str) and value.strip() and value.strip().lower() not in {"(none)", "none"}:
        return [value.strip()]
    return []


def _parse_persona_section(name: str, lines: list[str], start_line: int) -> PersonaRecord:
    """Parse a single ## section into a PersonaRecord. Raises ValueError on issues."""
    fields = _parse_field_blocks(lines)

    slug = _extract_field(fields, "Slug")
    if not slug:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Slug'")

    source = _extract_field(fields, "Source")
    if not source:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Source'")

    ptype = _extract_field(fields, "Type")
    if not ptype:
        raise ValueError(f"Line ~{start_line}: persona '{name}' missing required field 'Type'")
    if ptype not in ("character", "person"):
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' has invalid type '{ptype}' "
            f"(must be 'character' or 'person')"
        )

    traits_raw = _extract_field(fields, "Traits")
    traits = [t.strip() for t in (traits_raw or "").split(",") if t.strip()]
    if len(traits) < 3 or len(traits) > 5:
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' has {len(traits)} traits "
            f"(must have 3-5)"
        )

    catchphrase_raw = _extract_field(fields, "Catchphrase")
    catchphrase = None
    if catchphrase_raw and catchphrase_raw not in ("(none)", "none", ""):
        # Strip surrounding quotes if present
        catchphrase = catchphrase_raw.strip('"').strip("'")

    speaking_style = _extract_field(fields, "Speaking style") or ""
    if not speaking_style:
        raise ValueError(
            f"Line ~{start_line}: persona '{name}' missing required field 'Speaking style'"
        )

    category = _extract_field(fields, "Category")
    domain = _extract_field(fields, "Domain")
    archetype = _extract_field(fields, "Archetype")
    signature_quotes = [
        quote.strip('"').strip("'")
        for quote in (
            _extract_list_field(fields, "Signature quote fragments")
            or _extract_list_field(fields, "Signature quotes")
        )
    ]
    voice_profile = _extract_list_field(fields, "Voice profile")

    # Parse date signals: "label: YYYY-MM-DD" patterns
    date_signals: dict[str, str] = {}
    ds_values = _extract_list_field(fields, "Date signals")
    ds_raw = _extract_field(fields, "Date signals")
    candidates = ds_values or ([ds_raw] if ds_raw else [])
    for candidate in candidates:
        # Format: "Label: YYYY-MM-DD" or "label1: date1, label2: date2"
        for match in re.finditer(r"([^:,]+?):\s*(\d{4}-\d{2}-\d{2})", candidate):
            date_signals[match.group(1).strip()] = match.group(2)

    return PersonaRecord(
        slug=slug,
        name=name,
        source=source,
        type=ptype,
        category=category,
        domain=domain,
        archetype=archetype,
        traits=traits,
        catchphrase=catchphrase,
        signature_quotes=signature_quotes,
        voice_profile=voice_profile,
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
                (record.slug, 1.5),  # discovery boost — matches compute_weight(0 selections)
            )
    conn.commit()


# ---------------------------------------------------------------------------
# Event emission (#162)
# ---------------------------------------------------------------------------

_INSIGHTS_TOKEN_PATH = Path.home() / ".stark-insights" / "api-token"
_INSIGHTS_ENDPOINT = "http://127.0.0.1:7420/events"


def emit_persona_event(subtype: str, payload: dict, dedupe_key: str) -> None:
    """POST a persona event to the local insights API. Fail-open: never raises."""
    try:
        token_path = _INSIGHTS_TOKEN_PATH
        if not token_path.exists():
            logger.warning("emit_persona_event: token file missing at %s", token_path)
            return

        token = token_path.read_text().strip()
        # subtype belongs INSIDE payload — EventEnvelope drops unknown
        # top-level fields, and the consumer's PAYLOAD_SCHEMAS["persona_event"]
        # treats subtype as a required payload key.
        merged_payload = {"subtype": subtype, **payload}
        envelope = {
            "type": "persona_event",
            "source": "skill",
            "cli": "claude",
            "dedupe_key": dedupe_key,
            "payload": merged_payload,
        }
        data = json.dumps(envelope).encode()
        req = urllib.request.Request(
            _INSIGHTS_ENDPOINT,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
    except Exception:
        logger.debug("emit_persona_event: failed to emit %s event", subtype, exc_info=True)


def _make_dedupe_key(subtype: str, session_id: int | str | None) -> str:
    """Generate dedupe key: persona:{subtype}:{session_id}:{timestamp}."""
    ts = int(time.time())
    return f"persona:{subtype}:{session_id}:{ts}"


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
    query = name.lower().strip()

    # Exact slug match first
    for p in roster:
        if p.slug == name or p.name.lower() == query:
            return p

    def score(candidate: str) -> float:
        candidate = candidate.lower()
        if query == candidate:
            return 1.0
        if query in candidate or candidate in query:
            return 0.95

        ratio = difflib.SequenceMatcher(None, query, candidate).ratio()
        tokens = [token for token in re.split(r"[^a-z0-9]+", candidate) if token]
        if any(token.startswith(query) or query.startswith(token) for token in tokens if len(token) >= 3):
            ratio = max(ratio, 0.85)
        return ratio

    best_match: PersonaRecord | None = None
    best_score = 0.0
    for persona in roster:
        candidate_score = max(score(persona.slug), score(persona.name))
        if candidate_score > best_score:
            best_score = candidate_score
            best_match = persona

    if best_match and best_score >= 0.72:
        return best_match
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

    # Emit selection event (#162)
    emit_persona_event(
        subtype="selection",
        payload={
            "persona": persona.slug,
            "is_combo": is_combo,
            "weight_at_selection": new_weight,
            "date_signal_matched": date_signal_matched,
            "session_id": session_id,
        },
        dedupe_key=_make_dedupe_key("selection", session_id),
    )

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

    # Emit selection event (#162)
    emit_persona_event(
        subtype="selection",
        payload={
            "persona": primary.slug,
            "is_combo": True,
            "weight_at_selection": compute_weight(_get_persona_stats(conn, primary.slug)),
            "date_signal_matched": False,
            "session_id": session_id,
        },
        dedupe_key=_make_dedupe_key("selection", session_id),
    )

    return result


# ---------------------------------------------------------------------------
# Feedback (#158)
# ---------------------------------------------------------------------------

_SURVEY_POOL = [
    {
        "question": "Which vibe do you prefer for code reviews?",
        "choices": ["Stern mentor", "Encouraging coach", "Sarcastic friend", "Zen master"],
    },
    {
        "question": "Pick a trait you'd want more of:",
        "choices": ["Wit", "Intensity", "Calmness", "Absurdity"],
    },
    {
        "question": "What tone works best for error messages?",
        "choices": ["Dramatic", "Deadpan", "Sympathetic", "Comedic"],
    },
    {
        "question": "How weird should combos get?",
        "choices": ["Keep it mild", "Surprise me sometimes", "Maximum chaos"],
    },
    {
        "question": "Catchphrases in responses — yay or nay?",
        "choices": ["Love them", "Occasionally", "Never"],
    },
    {
        "question": "Persona persistence across sessions?",
        "choices": ["New every time", "Keep a good one for a while", "Let me choose"],
    },
]


def recompute_weight(conn: sqlite3.Connection, slug: str) -> float:
    """Recompute and store weight for a persona based on current ratings."""
    stats = _get_persona_stats(conn, slug)
    new_weight = compute_weight(stats)
    conn.execute(
        """INSERT INTO weights (persona, weight, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')""",
        (slug, new_weight, new_weight),
    )
    conn.commit()
    return new_weight


def record_rating(
    conn: sqlite3.Connection,
    rating: str,
    active_path: Path | str | None = None,
    roster: list[PersonaRecord] | None = None,
) -> str:
    """Record a like/hate rating for the current session's persona.

    - Reads active.json to get current persona slug and session_id
    - Upserts into ratings (UNIQUE on session_id — last wins)
    - Recomputes weight for the persona
    - For combos: applies 0.5x diluted rating to each component character
    - If combo liked: inserts/updates favorite_combos table
    - Returns confirmation message
    """
    active = load_active(active_path)
    if active is None:
        return "No active persona session."

    session_id = active.get("session_id")
    if session_id is None:
        return "No session_id in active.json."

    # Determine the primary persona slug
    slug = active.get("persona")
    is_combo = active.get("is_combo", False)

    if not slug and is_combo:
        # For combos, primary slug is first component
        components = active.get("components", [])
        if components:
            slug = components[0].get("slug")

    if not slug:
        return "Cannot determine persona from active.json."

    # Upsert rating (INSERT OR REPLACE keyed on session_id UNIQUE)
    conn.execute(
        """INSERT OR REPLACE INTO ratings (session_id, persona, rating)
           VALUES (?, ?, ?)""",
        (session_id, slug, rating),
    )
    conn.commit()

    # Recompute weight for primary persona
    recompute_weight(conn, slug)

    # For combos: diluted rating to each component + favorite_combos
    if is_combo:
        components = active.get("components", active.get("combo_components", []))
        if isinstance(components, str):
            components = json.loads(components)

        for comp in components:
            comp_slug = comp.get("slug", "")
            if comp_slug and comp_slug != slug:
                # Apply 0.5x diluted weight adjustment directly (can't reuse
                # session_id in ratings due to UNIQUE constraint)
                stats = _get_persona_stats(conn, comp_slug)
                base_weight = compute_weight(stats)
                diluted = 1.0 + (base_weight - 1.0) * 0.5
                conn.execute(
                    """INSERT INTO weights (persona, weight, updated_at)
                       VALUES (?, ?, datetime('now'))
                       ON CONFLICT(persona) DO UPDATE SET weight = ?, updated_at = datetime('now')""",
                    (comp_slug, diluted, diluted),
                )

        # If combo liked, update favorite_combos
        if rating == "like":
            combo_name = active.get("combo_name", "")
            if combo_name:
                conn.execute(
                    """INSERT INTO favorite_combos (combo, rating, times_used)
                       VALUES (?, 1.0, 1)
                       ON CONFLICT(combo) DO UPDATE SET
                           rating = rating + 1.0,
                           times_used = times_used + 1""",
                    (combo_name,),
                )

    conn.commit()

    # Emit rating event (#162)
    emit_persona_event(
        subtype="rating",
        payload={
            "persona": slug,
            "rating": rating,
            "session_id": session_id,
        },
        dedupe_key=_make_dedupe_key("rating", session_id),
    )

    emoji = "\U0001f44d" if rating == "like" else "\U0001f44e"
    name = active.get("name", active.get("combo_name", slug))
    return f"{emoji} Rated {name} as {rating}."


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
    active = load_active()
    conn = init_db()
    # Mark the latest session as deactivated
    conn.execute(
        "UPDATE sessions SET deactivated = 1 WHERE id = (SELECT MAX(id) FROM sessions)"
    )
    conn.commit()

    # Emit deactivation event (#162)
    session_id = active.get("session_id") if active else None
    persona = active.get("persona", active.get("combo_name", "unknown")) if active else "unknown"
    emit_persona_event(
        subtype="deactivation",
        payload={
            "persona": persona,
            "session_id": session_id,
        },
        dedupe_key=_make_dedupe_key("deactivation", session_id),
    )

    delete_active()
    print("Persona deactivated. Back to standard.")
    conn.close()
    return 0


def cmd_rate(args: argparse.Namespace) -> int:
    """Rate the current persona."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()
    msg = record_rating(conn, args.rating, roster=roster)
    print(msg)
    conn.close()
    return 0


def record_survey_answer(
    conn: sqlite3.Connection,
    question: str,
    answer: str,
) -> None:
    """Store a survey answer and emit event (#162)."""
    conn.execute(
        "INSERT INTO survey_responses (question, answer) VALUES (?, ?)",
        (question, answer),
    )
    conn.commit()

    active = load_active()
    session_id = active.get("session_id") if active else None

    emit_persona_event(
        subtype="survey_response",
        payload={
            "question": question,
            "answer": answer,
            "session_id": session_id,
        },
        dedupe_key=_make_dedupe_key("survey_response", session_id),
    )


def cmd_survey(args: argparse.Namespace) -> int:
    """Run a quick preference survey — pick 1-3 questions, output for Claude to ask."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()

    count = random.randint(1, 3)
    questions = random.sample(_SURVEY_POOL, min(count, len(_SURVEY_POOL)))

    output = {"questions": []}
    for q in questions:
        output["questions"].append({
            "question": q["question"],
            "choices": q["choices"],
        })

    print(json.dumps(output, indent=2))
    conn.close()
    return 0


def cmd_survey_answer(args: argparse.Namespace) -> int:
    """Record a survey answer."""
    ensure_dirs()
    conn = init_db()
    record_survey_answer(conn, args.question, args.answer)
    print(f"Recorded answer for: {args.question}")
    conn.close()
    return 0


_SANITIZE_PATTERNS = [
    re.compile(r"`"),           # backticks (covers single and triple)
    re.compile(r"<[^>]+>"),    # HTML tags
]


def _sanitize_input(value: str, field_name: str) -> str:
    """Reject backticks, code blocks, and HTML tags in user input."""
    for pattern in _SANITIZE_PATTERNS:
        if pattern.search(value):
            raise ValueError(
                f"Invalid characters in {field_name}: backticks, code blocks, "
                f"and HTML tags are not allowed."
            )
    return value.strip()


def _detect_type(source: str) -> str:
    """Auto-detect type from source. 'comedian', 'actor' etc. → person, else → character."""
    person_keywords = {"comedian", "actor", "actress", "singer", "musician",
                       "host", "presenter", "anchor", "personality", "stand-up"}
    source_lower = source.lower()
    for kw in person_keywords:
        if kw in source_lower:
            return "person"
    return "character"


def cmd_add(args: argparse.Namespace) -> int:
    """Add a new character to the roster."""
    ensure_dirs()

    # Sanitize all inputs
    try:
        name = _sanitize_input(args.name, "name")
        source = _sanitize_input(args.source, "source")
        traits_raw = _sanitize_input(args.traits, "traits")
    except ValueError as e:
        print(f"Error: {e}")
        return 1

    traits = [t.strip() for t in traits_raw.split(",") if t.strip()]
    if len(traits) < 3 or len(traits) > 5:
        print(f"Error: need 3-5 traits, got {len(traits)}.")
        return 1

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    ptype = _detect_type(source)

    roster_path = ROSTER_PATH
    roster_path.parent.mkdir(parents=True, exist_ok=True)

    # Build markdown section
    section = f"""
## {name}
- **Slug:** {slug}
- **Category:** drama
- **Domain:** Custom
- **Source:** {source}
- **Type:** {ptype}
- **Archetype:** custom add
- **Traits:** {', '.join(traits)}
- **Catchphrase:** (none)
- **Signature quote fragments:**
  - (add short iconic lines)
- **Voice profile:**
  - Cadence: (to be filled in)
  - Humor: (to be filled in)
  - Tells: (to be filled in)
- **Speaking style:** (to be filled in)
- **Date signals:**
  - (none)
"""

    # Atomic append via temp file
    import tempfile

    existing = roster_path.read_text() if roster_path.exists() else "# Persona Roster\n"
    new_content = existing.rstrip() + "\n" + section

    fd, tmp_name = tempfile.mkstemp(dir=str(roster_path.parent), suffix=".md")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(new_content)
        Path(tmp_name).rename(roster_path)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise

    # Also store weight entry so the character appears in selections
    conn = init_db()
    conn.execute(
        "INSERT OR REPLACE INTO weights (persona, weight) VALUES (?, ?)",
        (slug, 1.5),
    )
    conn.commit()
    conn.close()

    print(f"Added {name} ({slug}) to roster as {ptype}.")
    return 0


def cmd_stats(args: argparse.Namespace) -> int:
    """Show persona usage statistics."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()

    total = conn.execute("SELECT COUNT(*) AS n FROM sessions").fetchone()["n"]
    combo_count = conn.execute(
        "SELECT COUNT(*) AS n FROM sessions WHERE is_combo = 1"
    ).fetchone()["n"]

    if args.format == "table":
        # Full table with all personas sorted by weight
        rows = conn.execute(
            """SELECT w.persona, w.weight,
                      COALESCE(s.cnt, 0) AS selections,
                      COALESCE(rl.cnt, 0) AS likes,
                      COALESCE(rh.cnt, 0) AS hates
               FROM weights w
               LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM sessions GROUP BY persona) s
                   ON w.persona = s.persona
               LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='like' GROUP BY persona) rl
                   ON w.persona = rl.persona
               LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='hate' GROUP BY persona) rh
                   ON w.persona = rh.persona
               ORDER BY w.weight DESC"""
        ).fetchall()
        print(f"{'Persona':<25} {'Weight':>7} {'Sel':>5} {'Like':>5} {'Hate':>5}")
        print(f"{'-'*25} {'-'*7} {'-'*5} {'-'*5} {'-'*5}")
        for r in rows:
            print(f"{r['persona']:<25} {r['weight']:>7.2f} {r['selections']:>5} {r['likes']:>5} {r['hates']:>5}")
        print(f"\nTotal sessions: {total} | Combos: {combo_count}")
    else:
        # Inline: top 3, bottom, total sessions, combo count
        top3 = conn.execute(
            "SELECT persona, weight FROM weights ORDER BY weight DESC LIMIT 3"
        ).fetchall()
        bottom = conn.execute(
            "SELECT persona, weight FROM weights ORDER BY weight ASC LIMIT 1"
        ).fetchone()

        top_list = [{"persona": r["persona"], "weight": r["weight"]} for r in top3]
        bottom_item = {"persona": bottom["persona"], "weight": bottom["weight"]} if bottom else None

        data = {
            "sessions": total,
            "combos": combo_count,
            "top_3": top_list,
            "bottom": bottom_item,
        }
        print(json.dumps(data))

    conn.close()
    return 0


def cmd_history(args: argparse.Namespace) -> int:
    """Show last 20 sessions with persona name, rating emoji, date, combo flag."""
    ensure_dirs()
    conn = init_db()
    rows = conn.execute(
        """SELECT s.id, s.started_at, s.persona, s.is_combo,
                  r.rating
           FROM sessions s
           LEFT JOIN ratings r ON r.session_id = s.id
           ORDER BY s.id DESC LIMIT 20"""
    ).fetchall()
    if not rows:
        print("No sessions recorded yet.")
        conn.close()
        return 0

    print(f"{'#':<4} {'Date':<20} {'Persona':<25} {'Rating':<8} {'Combo':<6}")
    print(f"{'-'*4} {'-'*20} {'-'*25} {'-'*8} {'-'*6}")
    for r in rows:
        rating_emoji = {"like": "\U0001f44d", "hate": "\U0001f44e"}.get(r["rating"] or "", " ")
        combo_flag = "\u2713" if r["is_combo"] else ""
        date_str = (r["started_at"] or "")[:16]
        print(f"{r['id']:<4} {date_str:<20} {r['persona']:<25} {rating_emoji:<8} {combo_flag:<6}")
    conn.close()
    return 0


def cmd_print_roster(args: argparse.Namespace) -> int:
    """Print the full character roster."""
    ensure_dirs()
    roster = load_roster()
    if not roster:
        print("(empty roster)")
        return 0
    print(f"{'Slug':<24} {'Category':<12} {'Name':<24} {'Source':<28} {'Type':<10} {'Traits'}")
    print(f"{'-'*24} {'-'*12} {'-'*24} {'-'*28} {'-'*10} {'-'*30}")
    for r in roster:
        print(
            f"{r.slug:<24} {(r.category or '-'):12.12} {r.name:<24} "
            f"{r.source:<28.28} {r.type:<10} {', '.join(r.traits)}"
        )
    return 0


def cmd_print_weights(args: argparse.Namespace) -> int:
    """Print all personas sorted by computed weight, showing like/hate/selection counts."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()
    sync_weights(roster, conn)

    rows = conn.execute(
        """SELECT w.persona, w.weight,
                  COALESCE(s.cnt, 0) AS selections,
                  COALESCE(rl.cnt, 0) AS likes,
                  COALESCE(rh.cnt, 0) AS hates
           FROM weights w
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM sessions GROUP BY persona) s
               ON w.persona = s.persona
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='like' GROUP BY persona) rl
               ON w.persona = rl.persona
           LEFT JOIN (SELECT persona, COUNT(*) AS cnt FROM ratings WHERE rating='hate' GROUP BY persona) rh
               ON w.persona = rh.persona
           ORDER BY w.weight DESC"""
    ).fetchall()

    print(f"{'Persona':<30} {'Weight':>8} {'Sel':>5} {'Like':>5} {'Hate':>5}")
    print(f"{'-'*30} {'-'*8} {'-'*5} {'-'*5} {'-'*5}")
    if not rows:
        print("(no weights recorded)")
    else:
        for r in rows:
            print(f"{r['persona']:<30} {r['weight']:>8.2f} {r['selections']:>5} {r['likes']:>5} {r['hates']:>5}")
    conn.close()
    return 0


def cmd_session_end(args: argparse.Namespace) -> int:
    """End session: 20% chance fun fact callout, delete active.json, confirm."""
    ensure_dirs()
    conn = init_db()
    roster = load_roster()

    # Mark session ended in DB
    conn.execute(
        "UPDATE sessions SET ended_at = datetime('now') WHERE id = (SELECT MAX(id) FROM sessions)"
    )
    conn.commit()

    active = load_active()

    # 20% chance: output a fun fact callout block for Claude to fill
    if random.random() < 0.20 and active:
        name = active.get("name", active.get("combo_name", active.get("persona", "this persona")))
        print(f"> **Fun fact about {name}:**")
        print(f"> [Claude: generate a fun, surprising fact about {name} here]")
        print()

    # Clean up active.json
    delete_active()
    print("Session ended. Persona deactivated.")
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

    # survey-answer
    p_sa = sub.add_parser("survey-answer", help="Record a survey answer")
    p_sa.add_argument("--question", required=True, help="The survey question")
    p_sa.add_argument("--answer", required=True, help="The user's answer")

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
        "survey-answer": cmd_survey_answer,
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
