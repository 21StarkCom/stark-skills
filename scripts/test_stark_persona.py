"""Tests for stark_persona.py scaffold."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from stark_persona import PersonaRecord, init_db, main


EXPECTED_TABLES = {"sessions", "ratings", "survey_responses", "weights", "favorite_combos"}


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
        # Second call should not raise
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
        assert p.name == "Gandalf"
        assert p.source == "Lord of the Rings"
        assert p.type == "character"
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
        assert p.catchphrase == "Do or do not, there is no try"
        assert p.date_signals["Star Wars Day"] == "2026-05-04"


class TestPrintRoster:
    """print-roster subcommand tests."""

    def test_empty_roster_returns_zero(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        assert main(["print-roster"]) == 0


class TestPrintWeights:
    """print-weights subcommand tests."""

    def test_empty_weights_returns_zero(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        assert main(["print-weights"]) == 0
