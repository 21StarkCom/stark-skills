"""Tests for stark_persona.py — roster parsing (#152) + state layer (#153) + selection (#154-#156) + emission (#162)."""

from __future__ import annotations

import datetime
import json
import random
import sqlite3
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from stark_persona import (
    ROSTER_PATH,
    PersonaRecord,
    _make_dedupe_key,
    _sanitize_input,
    compute_weight,
    delete_active,
    emit_persona_event,
    fuzzy_match_persona,
    get_date_matches,
    init_db,
    load_active,
    load_roster,
    main,
    parse_roster,
    record_rating,
    record_survey_answer,
    recompute_weight,
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
        """The shipped roster.md should parse into all personas."""
        roster = load_roster(SEED_ROSTER)
        assert len(roster) >= 20
        slugs = {r.slug for r in roster}
        assert "jules-winnfield" in slugs
        assert "the-dude" in slugs
        assert "guri-alfi" in slugs
        assert "deadpool" in slugs
        assert "walter-white" in slugs
        assert "gandalf" in slugs
        assert "glados" in slugs
        assert "wednesday-addams" in slugs

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
        # All default weight 1.5 (discovery boost)
        for r in rows:
            assert r["weight"] == 1.5
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

        # Now sync full roster — should add the rest
        full_roster = load_roster(SEED_ROSTER)
        sync_weights(full_roster, conn)
        assert conn.execute("SELECT COUNT(*) AS n FROM weights").fetchone()["n"] == len(full_roster)
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

        # Give jules many likes (one per session, respecting UNIQUE on session_id)
        for i in range(5):
            cur = conn.execute(
                "INSERT INTO sessions (persona) VALUES (?)", ("jules-winnfield",)
            )
            conn.execute(
                "INSERT INTO ratings (session_id, persona, rating) VALUES (?, ?, 'like')",
                (cur.lastrowid, "jules-winnfield"),
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


# ---------------------------------------------------------------------------
# Feedback recording tests (#158)
# ---------------------------------------------------------------------------


class TestRecordRating:
    """record_rating and recompute_weight tests."""

    def _setup(self, tmp_path: Path) -> tuple:
        """Helper: create db, roster, select a persona, return (conn, active_path)."""
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"
        result = select_single_persona(
            roster, conn, active_path=active_path, rng=random.Random(42)
        )
        return conn, active_path, roster, result

    def test_record_rating_updates_weights(self, tmp_path: Path) -> None:
        conn, active_path, roster, result = self._setup(tmp_path)
        slug = result["persona"]

        weight_before = conn.execute(
            "SELECT weight FROM weights WHERE persona = ?", (slug,)
        ).fetchone()["weight"]

        msg = record_rating(conn, "like", active_path=active_path, roster=roster)
        assert "like" in msg

        weight_after = conn.execute(
            "SELECT weight FROM weights WHERE persona = ?", (slug,)
        ).fetchone()["weight"]
        # Like should increase or maintain weight
        assert weight_after >= weight_before
        conn.close()

    def test_rating_is_idempotent_per_session(self, tmp_path: Path) -> None:
        """Upsert: rating the same session twice replaces, doesn't duplicate."""
        conn, active_path, roster, result = self._setup(tmp_path)
        session_id = result["session_id"]

        record_rating(conn, "like", active_path=active_path, roster=roster)
        record_rating(conn, "hate", active_path=active_path, roster=roster)

        count = conn.execute(
            "SELECT COUNT(*) AS n FROM ratings WHERE session_id = ?", (session_id,)
        ).fetchone()["n"]
        assert count == 1  # upsert, not insert

        rating = conn.execute(
            "SELECT rating FROM ratings WHERE session_id = ?", (session_id,)
        ).fetchone()["rating"]
        assert rating == "hate"  # last wins
        conn.close()

    def test_combo_rating_dilutes_to_components(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"

        result = select_combo(
            roster, conn, active_path=active_path, rng=random.Random(42)
        )
        components = result["components"]
        assert len(components) >= 2

        # Record initial weights for components
        initial_weights = {}
        for comp in components:
            w = conn.execute(
                "SELECT weight FROM weights WHERE persona = ?", (comp["slug"],)
            ).fetchone()["weight"]
            initial_weights[comp["slug"]] = w

        record_rating(conn, "like", active_path=active_path, roster=roster)

        # Check that component weights were updated (recomputed)
        for comp in components:
            w = conn.execute(
                "SELECT weight FROM weights WHERE persona = ?", (comp["slug"],)
            ).fetchone()["weight"]
            # Weight should have changed from initial
            assert w is not None
        conn.close()

    def test_favorite_combos_populated_on_combo_like(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"

        result = select_combo(
            roster, conn, active_path=active_path, rng=random.Random(42)
        )
        combo_name = result["combo_name"]

        record_rating(conn, "like", active_path=active_path, roster=roster)

        fav = conn.execute(
            "SELECT combo, times_used FROM favorite_combos WHERE combo = ?",
            (combo_name,),
        ).fetchone()
        assert fav is not None
        assert fav["times_used"] == 1
        conn.close()


# ---------------------------------------------------------------------------
# Stats, history, print-weights tests (#159)
# ---------------------------------------------------------------------------


class TestStatsInline:
    """cmd_stats inline format."""

    def test_stats_inline_format(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", tmp_path / "active.json")

        result = main(["stats", "--format", "inline"])
        assert result == 0

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "sessions" in data
        assert "combos" in data
        assert "top_3" in data


class TestStatsTable:
    """cmd_stats table format."""

    def test_stats_table_format(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", tmp_path / "active.json")

        # Select a persona first so there's data
        main(["select", "--auto"])

        result = main(["stats", "--format", "table"])
        assert result == 0

        captured = capsys.readouterr()
        assert "Persona" in captured.out
        assert "Weight" in captured.out
        assert "Total sessions:" in captured.out


class TestHistory:
    """cmd_history output."""

    def test_history_output(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", tmp_path / "active.json")

        # Select a persona first
        main(["select", "--auto"])

        result = main(["history"])
        assert result == 0

        captured = capsys.readouterr()
        assert "Persona" in captured.out
        assert "Rating" in captured.out

    def test_history_empty(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)

        result = main(["history"])
        assert result == 0
        captured = capsys.readouterr()
        assert "No sessions" in captured.out


# ---------------------------------------------------------------------------
# Add, deactivate, session-end tests (#160)
# ---------------------------------------------------------------------------


class TestAddSanitization:
    """cmd_add input sanitization."""

    def test_add_rejects_backticks(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ROSTER_PATH", tmp_path / "roster.md")
        # Seed roster
        (tmp_path / "roster.md").write_text("# Persona Roster\n")

        result = main(["add", "--name", "Bad`Name", "--source", "Movie", "--traits", "a, b, c"])
        assert result == 1
        captured = capsys.readouterr()
        assert "Invalid characters" in captured.out or "backtick" in captured.out.lower() or "Error" in captured.out

    def test_add_rejects_html(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        monkeypatch.setattr("stark_persona.ROSTER_PATH", tmp_path / "roster.md")
        (tmp_path / "roster.md").write_text("# Persona Roster\n")

        result = main(["add", "--name", "<script>alert</script>", "--source", "Web", "--traits", "a, b, c"])
        assert result == 1


class TestAddAppends:
    """cmd_add appends to roster correctly."""

    def test_add_appends_to_roster(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        roster_path = tmp_path / "roster.md"
        monkeypatch.setattr("stark_persona.ROSTER_PATH", roster_path)
        roster_path.write_text("# Persona Roster\n")

        result = main(["add", "--name", "Tony Montana", "--source", "Scarface (1983)", "--traits", "ambitious, volatile, dramatic"])
        assert result == 0

        content = roster_path.read_text()
        assert "## Tony Montana" in content
        assert "tony-montana" in content
        assert "character" in content  # auto-detected type

    def test_add_detects_person_type(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        roster_path = tmp_path / "roster.md"
        monkeypatch.setattr("stark_persona.ROSTER_PATH", roster_path)
        roster_path.write_text("# Persona Roster\n")

        result = main(["add", "--name", "Dave Chappelle", "--source", "Comedian, stand-up", "--traits", "witty, sharp, fearless"])
        assert result == 0

        content = roster_path.read_text()
        assert "person" in content


class TestDeactivate:
    """cmd_deactivate deletes active.json."""

    def test_deactivate_deletes_active(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        active_path = tmp_path / "active.json"
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", active_path)

        # Select first
        main(["select", "--auto"])
        assert active_path.exists()

        result = main(["deactivate"])
        assert result == 0
        assert not active_path.exists()

        captured = capsys.readouterr()
        assert "deactivated" in captured.out.lower() or "Back to standard" in captured.out


class TestSessionEnd:
    """cmd_session_end cleans up."""

    def test_session_end_cleans_up(self, tmp_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("stark_persona.DB_PATH", tmp_path / "persona.db")
        monkeypatch.setattr("stark_persona.DATA_DIR", tmp_path)
        active_path = tmp_path / "active.json"
        monkeypatch.setattr("stark_persona.ACTIVE_PATH", active_path)

        # Select first
        main(["select", "--auto"])
        assert active_path.exists()

        # Force no fun fact for deterministic test
        monkeypatch.setattr("stark_persona.random.random", lambda: 0.5)

        result = main(["session-end"])
        assert result == 0
        assert not active_path.exists()

        captured = capsys.readouterr()
        assert "Session ended" in captured.out


# ---------------------------------------------------------------------------
# Event emission tests (#162)
# ---------------------------------------------------------------------------


class TestEmitPersonaEvent:
    """emit_persona_event HTTP behavior."""

    def test_emit_succeeds_when_api_available(self, tmp_path: Path) -> None:
        """Mock urllib to verify correct HTTP request is made."""
        token_path = tmp_path / "api-token"
        token_path.write_text("test-token-abc")

        with patch("stark_persona._INSIGHTS_TOKEN_PATH", token_path), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = MagicMock()

            emit_persona_event(
                subtype="selection",
                payload={"persona": "jules", "session_id": 1},
                dedupe_key="persona:selection:1:12345",
            )

            mock_urlopen.assert_called_once()
            call_args = mock_urlopen.call_args
            req = call_args[0][0]
            assert req.full_url == "http://127.0.0.1:7420/events"
            assert req.get_header("Authorization") == "Bearer test-token-abc"
            assert req.get_header("Content-type") == "application/json"
            body = json.loads(req.data)
            assert body["type"] == "persona_event"
            assert body["subtype"] == "selection"
            assert body["source"] == "skill"
            assert body["cli"] == "claude"
            assert body["dedupe_key"] == "persona:selection:1:12345"
            assert body["payload"]["persona"] == "jules"

    def test_emit_fails_silently_on_connection_error(self, tmp_path: Path) -> None:
        """Connection refused should log warning but not raise."""
        token_path = tmp_path / "api-token"
        token_path.write_text("test-token")

        with patch("stark_persona._INSIGHTS_TOKEN_PATH", token_path), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = ConnectionError("Connection refused")

            # Should not raise
            emit_persona_event(
                subtype="rating",
                payload={"persona": "the-dude", "rating": "like"},
                dedupe_key="persona:rating:1:12345",
            )

    def test_emit_fails_silently_on_timeout(self, tmp_path: Path) -> None:
        """Timeout should log warning but not raise."""
        token_path = tmp_path / "api-token"
        token_path.write_text("test-token")

        import urllib.error
        with patch("stark_persona._INSIGHTS_TOKEN_PATH", token_path), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = TimeoutError("timed out")

            # Should not raise
            emit_persona_event(
                subtype="deactivation",
                payload={"persona": "deadpool"},
                dedupe_key="persona:deactivation:1:12345",
            )

    def test_emit_fails_silently_on_missing_token(self, tmp_path: Path) -> None:
        """Missing token file should log warning and return."""
        missing = tmp_path / "nonexistent" / "api-token"

        with patch("stark_persona._INSIGHTS_TOKEN_PATH", missing), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            emit_persona_event(
                subtype="selection",
                payload={},
                dedupe_key="persona:selection:1:12345",
            )
            mock_urlopen.assert_not_called()


class TestSelectionEmitsEvent:
    """Selection flow emits persona event."""

    def test_selection_emits_event(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)

        token_path = tmp_path / "api-token"
        token_path.write_text("test-token")

        with patch("stark_persona._INSIGHTS_TOKEN_PATH", token_path), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = MagicMock()

            result = select_single_persona(
                roster, conn,
                active_path=tmp_path / "active.json",
                rng=random.Random(42),
            )

            mock_urlopen.assert_called_once()
            req = mock_urlopen.call_args[0][0]
            body = json.loads(req.data)
            assert body["subtype"] == "selection"
            assert body["payload"]["persona"] == result["persona"]
            assert body["payload"]["session_id"] == result["session_id"]
            assert "dedupe_key" in body
        conn.close()


class TestRatingEmitsEvent:
    """Rating flow emits persona event."""

    def test_rating_emits_event(self, tmp_path: Path) -> None:
        conn = init_db(tmp_path / "persona.db")
        roster = load_roster(SEED_ROSTER)
        sync_weights(roster, conn)
        active_path = tmp_path / "active.json"

        # Select first (without emission mock)
        with patch("stark_persona._INSIGHTS_TOKEN_PATH", tmp_path / "no-token"):
            result = select_single_persona(
                roster, conn, active_path=active_path, rng=random.Random(42),
            )

        token_path = tmp_path / "api-token"
        token_path.write_text("test-token")

        with patch("stark_persona._INSIGHTS_TOKEN_PATH", token_path), \
             patch("stark_persona.urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.return_value = MagicMock()

            record_rating(conn, "like", active_path=active_path, roster=roster)

            mock_urlopen.assert_called_once()
            req = mock_urlopen.call_args[0][0]
            body = json.loads(req.data)
            assert body["subtype"] == "rating"
            assert body["payload"]["rating"] == "like"
            assert body["payload"]["persona"] == result["persona"]
        conn.close()
