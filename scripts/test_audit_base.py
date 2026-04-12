"""Tests for audit_base.py — shared SQLite + JSONL audit primitives."""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field

import audit_base


@dataclass
class _Sample:
    a: int
    b: str
    c: dict = field(default_factory=dict)


def test_connect_enables_wal_and_busy_timeout(tmp_path):
    db = tmp_path / "x.db"
    audit_base.init_db(db, "CREATE TABLE t (x INT);")
    conn = audit_base.connect(db)
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    finally:
        conn.close()
    assert mode.lower() == "wal"
    assert timeout == 5000


def test_init_db_creates_tables_and_parent_dirs(tmp_path):
    nested = tmp_path / "a" / "b" / "c" / "db.sqlite"
    schema = "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);"
    audit_base.init_db(nested, schema)
    assert nested.exists()
    conn = sqlite3.connect(str(nested))
    try:
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        ]
    finally:
        conn.close()
    assert "items" in tables


def test_init_db_is_idempotent(tmp_path):
    db = tmp_path / "idem.db"
    schema = "CREATE TABLE IF NOT EXISTS t (id INTEGER);"
    audit_base.init_db(db, schema)
    audit_base.init_db(db, schema)  # no error


def test_append_jsonl_with_dataclass(tmp_path):
    path = tmp_path / "calls.jsonl"
    audit_base.append_jsonl(path, _Sample(a=1, b="hi", c={"x": 2}))
    audit_base.append_jsonl(path, _Sample(a=2, b="there"))
    lines = path.read_text().splitlines()
    assert len(lines) == 2
    assert json.loads(lines[0]) == {"a": 1, "b": "hi", "c": {"x": 2}}
    assert json.loads(lines[1])["a"] == 2


def test_append_jsonl_with_dict(tmp_path):
    path = tmp_path / "calls.jsonl"
    audit_base.append_jsonl(path, {"k": "v"})
    assert json.loads(path.read_text()) == {"k": "v"}


def test_append_jsonl_creates_parent_dirs(tmp_path):
    path = tmp_path / "deeply" / "nested" / "dir" / "file.jsonl"
    audit_base.append_jsonl(path, {"ok": True})
    assert path.exists()


def test_now_ts_returns_float():
    ts = audit_base.now_ts()
    assert isinstance(ts, float)
    assert ts > 0


def test_cost_accumulator_add_call_updates_total():
    acc = audit_base.CostAccumulator()
    acc.add_call("red_team", input_tokens=1000, output_tokens=500, rates={"input_per_1m_usd": 15.0, "output_per_1m_usd": 60.0})
    # (1000 * 15 + 500 * 60) / 1_000_000 = 0.015 + 0.03 = 0.045
    assert abs(acc.total_usd - 0.045) < 1e-9


def test_cost_accumulator_tracks_subsystem_breakdown():
    acc = audit_base.CostAccumulator()
    acc.add_call("red_team", input_tokens=1000, output_tokens=500,
                 rates={"input_per_1m_usd": 15.0, "output_per_1m_usd": 60.0})
    acc.add_call("regen", input_tokens=2000, output_tokens=1000,
                 rates={"input_per_1m_usd": 15.0, "output_per_1m_usd": 75.0})
    assert set(acc.breakdown.keys()) == {"red_team", "regen"}
    assert abs(acc.breakdown["red_team"] - 0.045) < 1e-9
    assert abs(acc.breakdown["regen"] - 0.105) < 1e-9  # (2k*15 + 1k*75) / 1m
    assert abs(acc.total_usd - 0.15) < 1e-9


def test_cost_accumulator_would_exceed_returns_bool():
    acc = audit_base.CostAccumulator()
    acc.add_call("red_team", input_tokens=500_000, output_tokens=100_000,
                 rates={"input_per_1m_usd": 15.0, "output_per_1m_usd": 60.0})
    # total = (500k*15 + 100k*60)/1m = 7.5 + 6.0 = 13.5
    assert acc.would_exceed(budget_usd=15.0, next_estimate_usd=1.0) is False
    assert acc.would_exceed(budget_usd=15.0, next_estimate_usd=2.0) is True


def test_cost_accumulator_initial_state():
    acc = audit_base.CostAccumulator()
    assert acc.total_usd == 0.0
    assert acc.breakdown == {}
    assert acc.would_exceed(budget_usd=10.0, next_estimate_usd=0.01) is False
