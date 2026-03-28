"""Tests for stark_persona.py — roster parsing (#152) + state layer (#153)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from stark_persona import (
    PersonaRecord,
    delete_active,
    init_db,
    load_active,
    load_roster,
    main,
    parse_roster,
    sync_weights,
    write_active,
)


EXPECTED_TABLES = {"sessions", "ratings", "survey_responses", "weights", "favorite_combos"}

SEED_ROSTER = Path(__file__).resolve().parent.parent / "data" / "persona" / "roster.md"


# ---------------------------------------------------------------------------
# Database tests (from #151)
# ---------------------------------------------------------------------------


class TestInitDb:
    """Database initialization tests."""

    def test_creates_all_tables(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persona.db"
        conn = init_db(db_path)
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        assert tables == EXPECTED_TABLES
        conn.close()

    def test_idempotent(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persona.db"
        conn1 = init_db(db_path)
        conn1.close()
        conn2 = init_db(db_path)
        tables = {
            row[0]
            for row in conn2.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            ).fetchall()
        }
        assert tables == EXPECTED_TABLES
        conn2.close()


class TestPersonaRecord:
    """PersonaRecord dataclass tests."""

    def test_required_fields(self) -> None:
        p = PersonaRecord(
            slug="gandalf",
            name="Gandalf",
            source="Lord of the Rings",
            type="character",
        )
        assert p.slug == "gandalf"
        assert p.traits == []
        assert p.catchphrase is None
        assert p.speaking_style == ""
        assert p.date_signals == {}

    def test_all_fields(self) -> None:
        p = PersonaRecord(
            slug="yoda",
            name="Yoda",
            source="Star Wars",
            type="character",
            traits=["wise", "cryptic"],
            catchphrase="Do or do not, there is no try",
            speaking_style="Inverted sentence structure, speaks in riddles",
            date_signals={"Star Wars Day": "2026-05-04"},
        )
        assert p.traits == ["wise", "cryptic"]
        assert p.date_signals["Star Wars Day"] == "2026-05-04"


# ---------------------------------------------------------------------------
# Roster parsing tests (#152)
# ---------------------------------------------------------------------------


class TestLoadRoster:
    """Roster loading and parsing tests."""

    def test_parses_seed_roster(self) -> None:
        """The shipped roster.md should parse into exactly 5 personas."""
        roster = load_roster(SEED_ROSTER)
        assert len(roster) == 5
        slugs = {r.slug for r in roster}
        assert slugs == {
            "jules-winnfield",
            "the-dude",
            "guri-alfi",
            "deadpool",
            "walter-white",
        }

    def test_parses_all_fields(self) -> None:
        roster = load_roster(SEED_ROSTER)
        jules = next(r for r in roster if r.slug == "jules-winnfield")
        assert jules.name == "Jules Winnfield"
        assert jules.source == "Pulp Fiction (1994)"
        assert jules.type == "character"
        assert len(jules.traits) == 5
        assert "intense" in jules.traits
        assert jules.catchphrase == "Allow me to retort."
        assert "Biblical" in jules.speaking_style
        assert jules.date_signals.get("Samuel L. Jackson birthday") == "1948-12-21"

    def test_none_catchphrase(self) -> None:
        roster = load_roster(SEED_ROSTER)
        guri = next(r for r in roster if r.slug == "guri-alfi")
        assert guri.catchphrase is None
        assert guri.type == "person"

    def test_missing_file_creates_seed(self, tmp_path: Path) -> None:
        """When roster file is missing, load_roster creates a minimal seed."""
        missing = tmp_path / "nonexistent" / "roster.md"
        roster = load_roster(missing)
        assert len(roster) == 2
        assert missing.exists()

    def test_rejects_missing_slug(self) -> None:
        bad_md = """\
# Persona Roster

## No Slug Guy
- **Source:** Somewhere
- **Type:** character
- **Traits:** a, b, c
- **Speaking style:** Talks.
"""
        with pytest.raises(ValueError, match="missing required field 'Slug'"):
            parse_roster(bad_md)

    def test_rejects_bad_type(self) -> None:
        bad_md = """\
# Persona Roster

## Bad Type
- **Slug:** bad-type
- **Source:** Somewhere
- **Type:** robot
- **Traits:** a, b, c
- **Speaking style:** Beeps.
"""
        with pytest.raises(ValueError, match="invalid type 'robot'"):
            parse_roster(bad_md)

    def test_rejects_too_few_traits(self) -> None:
        bad_md = """\
# Persona Roster

## Few Traits
- **Slug:** few-traits
- **Source:** Somewhere
- **Type:** character
- **Traits:** a, b
- **Speaking style:** Talks.
"""
        with pytest.raises(ValueError, match="2 traits"):
            parse_roster(bad_md)

    def test_rejects_too_many_traits(self) -> None:
        bad_md = """\
# Persona Roster

## Many Traits
- **Slug:** many-traits
- **Source:** Somewhere
- **Type:** character
- **Traits:** a, b, c, d, e, f
- **Speaking style:** Talks.
"""
        with pytest.raises(ValueError, match="6 traits"):
            parse_roster(bad_md)


# ---------------------------------------------------------------------------
# Active state layer tests (#153)
# ---------------------------------------------------------------------------


class TestActiveState:
    """active.json read/write/delete tests."""

    def test_load_active_missing(self, tmp_path: Path) -> None:
        result = load_active(tmp_path / "active.json")
        assert result is None

    def test_write_and_load_roundtrip(self, tmp_path: Path) -> None:
        path = tmp_path / "active.json"
        data = {"persona": "jules-winnfield", "session_id": 42}
        write_active(data, path)
        loaded = load_active(path)
        assert loaded == data

    def test_write_active_atomic(self, tmp_path: Path) -> None:
        """No .tmp file should remain after write."""
        path = tmp_path / "active.json"
        write_active({"test": True}, path)
        assert path.exists()
        assert not path.with_suffix(".tmp").exists()

    def test_delete_active_removes_file(self, tmp_path: Path) -> None:
        path = tmp_path / "active.json"
        write_active({"persona": "the-dude"}, path)
        assert path.exists()
        delete_active(path)
        assert not path.exists()

    def test_delete_active_noop_when_missing(self, tmp_path: Path) -> None:
        """delete_active should not raise when file doesn't exist."""
        path = tmp_path / "active.json"
        delete_active(path)  # should not raise


class TestSyncWeights:
    """sync_weights creates weight entries for all roster personas."""

    def test_creates_entries_for_all(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persona.db"
        conn = init_db(db_path)
        roster = load_roster(SEED_ROSTER)

        sync_weights(roster, conn)

        rows = conn.execute("SELECT persona, weight FROM weights ORDER BY persona").fetchall()
        slugs = {r["persona"] for r in rows}
        assert slugs == {r.slug for r in roster}
        # All default weight 1.0
        for r in rows:
            assert r["weight"] == 1.0
        conn.close()

    def test_idempotent(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persona.db"
        conn = init_db(db_path)
        roster = load_roster(SEED_ROSTER)

        sync_weights(roster, conn)
        # Modify one weight
        conn.execute("UPDATE weights SET weight = 2.0 WHERE persona = 'the-dude'")
        conn.commit()
        # Sync again — should not overwrite existing
        sync_weights(roster, conn)

        dude = conn.execute(
            "SELECT weight FROM weights WHERE persona = 'the-dude'"
        ).fetchone()
        assert dude["weight"] == 2.0
        conn.close()

    def test_adds_new_personas_only(self, tmp_path: Path) -> None:
        db_path = tmp_path / "persona.db"
        conn = init_db(db_path)

        # Start with just 2
        small_roster = load_roster(SEED_ROSTER)[:2]
        sync_weights(small_roster, conn)
        assert conn.execute("SELECT COUNT(*) AS n FROM weights").fetchone()["n"] == 2

        # Now sync full roster — should add 3 more
        full_roster = load_roster(SEED_ROSTER)
        sync_weights(full_roster, conn)
        assert conn.execute("SELECT COUNT(*) AS n FROM weights").fetchone()["n"] == 5
        conn.close()


# ---------------------------------------------------------------------------
# CLI subcommand tests
# ---------------------------------------------------------------------------


class TestPrintRoster:
    """print-roster subcommand tests."""

    def test_prints_roster(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        assert main(["print-roster"]) == 0


class TestPrintWeights:
    """print-weights subcommand tests."""

    def test_empty_weights_returns_zero(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        assert main(["print-weights"]) == 0
