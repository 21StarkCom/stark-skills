"""Tests for stark_persona.py — roster parsing (#152) + state layer (#153) + selection (#154-#156)."""

from __future__ import annotations

import datetime
import json
import random
import sqlite3
from pathlib import Path

import pytest

from stark_persona import (
    PersonaRecord,
    compute_weight,
    delete_active,
    fuzzy_match_persona,
    get_date_matches,
    init_db,
    load_active,
    load_roster,
    main,
    parse_roster,
    select_combo,
    select_single_persona,
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


# ---------------------------------------------------------------------------
# Selection engine tests (#154, #155, #156)
# ---------------------------------------------------------------------------


class TestComputeWeight:
    """compute_weight for each category."""

    def test_untested_persona(self) -> None:
        """selection_count == 0 gives discovery boost of 1.5."""
        assert compute_weight({"selection_count": 0, "like_count": 0, "hate_count": 0}) == 1.5

    def test_liked_persona(self) -> None:
        """Positive net likes increase weight, capped at 3.0."""
        # net=2 -> 1.0 + 0.8 = 1.8
        assert compute_weight({"selection_count": 5, "like_count": 3, "hate_count": 1}) == 1.8
        # net=5 -> 1.0 + 2.0 = 3.0 (max)
        assert compute_weight({"selection_count": 10, "like_count": 6, "hate_count": 1}) == 3.0
        # net=10 -> capped at 5 -> 1.0 + 2.0 = 3.0
        assert compute_weight({"selection_count": 10, "like_count": 10, "hate_count": 0}) == 3.0

    def test_hated_persona(self) -> None:
        """Negative net reduces weight, floored at 0.2."""
        # net=-1 -> 1.0 + (-0.4) = 0.6
        assert compute_weight({"selection_count": 3, "like_count": 0, "hate_count": 1}) == 0.6
        # net=-2 -> 1.0 + (-0.8) = 0.2
        assert compute_weight({"selection_count": 3, "like_count": 0, "hate_count": 2}) == 0.2
        # net=-5 -> 1.0 + (-2.0) = -1.0 -> floored to 0.2
        assert compute_weight({"selection_count": 5, "like_count": 0, "hate_count": 5}) == 0.2

    def test_neutral_persona(self) -> None:
        """Equal likes and hates gives 1.0."""
        assert compute_weight({"selection_count": 4, "like_count": 2, "hate_count": 2}) == 1.0
        assert compute_weight({"selection_count": 1, "like_count": 0, "hate_count": 0}) == 1.0


class TestWeightedSelection:
    """Weighted selection produces valid output."""

    def test_produces_valid_result(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        result = select_single_persona(
            roster, conn, active_path=tmp_path / "active.json", rng=random.Random(42)
        )

        assert "error" not in result
        assert "session_id" in result
        assert "persona" in result
        assert "name" in result
        assert "speaking_style" in result
        assert result["persona"] in {r.slug for r in roster}
        conn.close()

    def test_weighted_selection_respects_weights(self, tmp_path: Path) -> None:
        """Heavily liked persona should be picked more often."""
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        # Give jules many likes
        conn.execute(
            "INSERT INTO sessions (persona) VALUES (?)", ("jules-winnfield",)
        )
        for _ in range(5):
            conn.execute(
                "INSERT INTO ratings (session_id, persona, rating) VALUES (1, ?, 'like')",
                ("jules-winnfield",),
            )
        conn.commit()

        picks: dict[str, int] = {}
        for i in range(100):
            result = select_single_persona(
                roster, conn,
                active_path=tmp_path / "active.json",
                rng=random.Random(i),
            )
            slug = result["persona"]
            picks[slug] = picks.get(slug, 0) + 1

        # jules should appear more than average (>20% of 100 picks for 5 personas)
        assert picks.get("jules-winnfield", 0) > 10
        conn.close()


class TestDateMatching:
    """Date-aware selection (#155)."""

    def test_finds_matching_persona(self) -> None:
        roster = load_roster(SEED_ROSTER)
        # Samuel L. Jackson birthday: 1948-12-21
        matches = get_date_matches(roster, today=datetime.date(2026, 12, 21))
        slugs = [p.slug for p in matches]
        assert "jules-winnfield" in slugs

    def test_no_match_on_random_date(self) -> None:
        roster = load_roster(SEED_ROSTER)
        matches = get_date_matches(roster, today=datetime.date(2026, 1, 15))
        assert len(matches) == 0

    def test_date_gate_25_percent(self, tmp_path: Path) -> None:
        """With deterministic seed, date match fires ~25% of the time."""
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        # Use Dec 21 (Jules birthday)
        today = datetime.date(2026, 12, 21)
        date_hits = 0
        trials = 200
        for i in range(trials):
            result = select_single_persona(
                roster, conn,
                active_path=tmp_path / "active.json",
                rng=random.Random(i),
                today=today,
            )
            if result.get("date_signal_matched"):
                date_hits += 1

        # Should be roughly 25% (allow 10-45% range for statistical safety)
        ratio = date_hits / trials
        assert 0.10 < ratio < 0.45, f"Date match ratio {ratio:.2%} outside expected range"
        conn.close()

    def test_date_signal_in_session(self, tmp_path: Path) -> None:
        """When date match fires, result includes date_signal fields."""
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        today = datetime.date(2026, 12, 21)
        # Find a seed that triggers the date match
        for seed in range(1000):
            result = select_single_persona(
                roster, conn,
                active_path=tmp_path / "active.json",
                rng=random.Random(seed),
                today=today,
            )
            if result.get("date_signal_matched"):
                assert result["date_signal_reason"] is not None
                assert "birthday" in result["date_signal_reason"].lower() or "Birthday" in result["date_signal_reason"]
                break
        else:
            pytest.fail("Could not trigger date match in 1000 seeds")
        conn.close()


class TestFuzzyNameMatching:
    """Fuzzy name matching (#155)."""

    def test_exact_slug(self) -> None:
        roster = load_roster(SEED_ROSTER)
        result = fuzzy_match_persona(roster, "jules-winnfield")
        assert result is not None
        assert result.slug == "jules-winnfield"

    def test_exact_name_case_insensitive(self) -> None:
        roster = load_roster(SEED_ROSTER)
        result = fuzzy_match_persona(roster, "the dude")
        assert result is not None
        assert result.slug == "the-dude"

    def test_fuzzy_close_match(self) -> None:
        roster = load_roster(SEED_ROSTER)
        # Typo in name
        result = fuzzy_match_persona(roster, "deadpol")
        assert result is not None
        assert result.slug == "deadpool"

    def test_no_match_returns_none(self) -> None:
        roster = load_roster(SEED_ROSTER)
        result = fuzzy_match_persona(roster, "nonexistent-character-xyz")
        assert result is None

    def test_name_selection_via_select(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        result = select_single_persona(
            roster, conn, name="jules", active_path=tmp_path / "active.json"
        )
        assert result["persona"] == "jules-winnfield"
        conn.close()

    def test_bad_name_returns_error(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)

        result = select_single_persona(
            roster, conn, name="zzz-nobody", active_path=tmp_path / "active.json"
        )
        assert "error" in result
        conn.close()


class TestComboGeneration:
    """Combo selection (#156)."""

    def test_generates_valid_combo(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        result = select_combo(
            roster, conn,
            active_path=tmp_path / "active.json",
            rng=random.Random(42),
        )

        assert "error" not in result
        assert result["is_combo"] is True
        assert "combo_name" in result
        assert "components" in result
        assert 2 <= len(result["components"]) <= 3
        assert "all_traits" in result
        assert "speaking_style" in result
        assert "recipe_hash" in result
        conn.close()

    def test_combo_has_2_or_3_components(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        sizes = set()
        for i in range(50):
            result = select_combo(
                roster, conn,
                active_path=tmp_path / "active.json",
                rng=random.Random(i),
            )
            sizes.add(len(result["components"]))

        assert sizes <= {2, 3}
        conn.close()

    def test_combo_components_have_traits(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        result = select_combo(
            roster, conn,
            active_path=tmp_path / "active.json",
            rng=random.Random(42),
        )

        for comp in result["components"]:
            assert "slug" in comp
            assert "name" in comp
            assert "traits" in comp
            assert 1 <= len(comp["traits"]) <= 2
        conn.close()

    def test_recipe_hash_deterministic(self, tmp_path: Path) -> None:
        """Same personas (in any order) produce the same recipe hash."""
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        # Use same seed twice
        r1 = select_combo(
            roster, conn, active_path=tmp_path / "active.json", rng=random.Random(42)
        )
        r2 = select_combo(
            roster, conn, active_path=tmp_path / "active.json", rng=random.Random(42)
        )
        assert r1["recipe_hash"] == r2["recipe_hash"]
        conn.close()

    def test_combo_stored_in_db(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        result = select_combo(
            roster, conn,
            active_path=tmp_path / "active.json",
            rng=random.Random(42),
        )

        row = conn.execute(
            "SELECT is_combo, combo_components, combo FROM sessions WHERE id = ?",
            (result["session_id"],),
        ).fetchone()
        assert row["is_combo"] == 1
        assert row["combo_components"] is not None
        components = json.loads(row["combo_components"])
        assert len(components) >= 2
        conn.close()


class TestActiveJsonWritten:
    """active.json is written after selection."""

    def test_single_selection_writes_active(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"

        select_single_persona(
            roster, conn, active_path=active_path, rng=random.Random(42)
        )

        assert active_path.exists()
        data = json.loads(active_path.read_text())
        assert "persona" in data
        assert "session_id" in data
        conn.close()

    def test_combo_writes_active(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"

        select_combo(roster, conn, active_path=active_path, rng=random.Random(42))

        assert active_path.exists()
        data = json.loads(active_path.read_text())
        assert data["is_combo"] is True
        conn.close()


class TestAutoJson:
    """--auto returns JSON output."""

    def test_auto_select_returns_json(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", tmp_path / "active.json")

        result = main(["select", "--auto"])
        assert result == 0

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "persona" in data
        assert "session_id" in data

    def test_auto_combo_returns_json(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", tmp_path / "active.json")

        result = main(["select", "--combo", "--auto"])
        assert result == 0

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert data["is_combo"] is True
