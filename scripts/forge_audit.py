"""Forge audit and metrics module.

Provides JSONL-based call auditing and SQLite-backed run metrics
for the stark-forge pipeline.

Low-level SQLite plumbing (connect, init, WAL pragmas) lives in
`audit_base`. This module owns the forge-specific schema and public API,
which remains stable for backward compatibility with existing callers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import audit_base


@dataclass
class AuditCall:
    """Structured record for a single forge dispatch call."""

    agent: str
    domain: str
    round_num: int
    duration_s: float
    finding_count: int
    severity_counts: dict[str, int] = field(default_factory=dict)
    error: str | None = None
    timestamp: float = field(default_factory=audit_base.now_ts)


_CREATE_TABLES = """\
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    doc_path TEXT NOT NULL,
    total_rounds INTEGER NOT NULL,
    total_findings INTEGER NOT NULL,
    total_duration_s REAL NOT NULL,
    outcome TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS domain_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    agent TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    finding_count INTEGER NOT NULL,
    signal_count INTEGER NOT NULL DEFAULT 0,
    noise_count INTEGER NOT NULL DEFAULT 0,
    duration_s REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""


def init_metrics_db(db_path: str | Path) -> None:
    """Create the forge_metrics tables if they don't exist."""
    audit_base.init_db(db_path, _CREATE_TABLES)


def record_call(audit_path: str | Path, call_data: AuditCall) -> None:
    """Append a call record as a JSONL line to the audit file."""
    audit_base.append_jsonl(audit_path, call_data)


def record_run(db_path: str | Path, run_data: dict[str, Any]) -> None:
    """Insert a run record and its domain stats into the database.

    Expected run_data keys:
        run_id, doc_path, total_rounds, total_findings, total_duration_s,
        outcome, domain_stats (list of dicts with domain, agent, round_num,
        finding_count, signal_count, noise_count, duration_s)
    """
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO runs (run_id, doc_path, total_rounds, total_findings, "
            "total_duration_s, outcome) VALUES (?, ?, ?, ?, ?, ?)",
            (
                run_data["run_id"],
                run_data["doc_path"],
                run_data["total_rounds"],
                run_data["total_findings"],
                run_data["total_duration_s"],
                run_data["outcome"],
            ),
        )
        for ds in run_data.get("domain_stats", []):
            conn.execute(
                "INSERT INTO domain_stats (run_id, domain, agent, round_num, "
                "finding_count, signal_count, noise_count, duration_s) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"],
                    ds["domain"],
                    ds["agent"],
                    ds["round_num"],
                    ds["finding_count"],
                    ds.get("signal_count", 0),
                    ds.get("noise_count", 0),
                    ds["duration_s"],
                ),
            )
        conn.commit()
    finally:
        conn.close()


def get_domain_snr(db_path: str | Path, domain: str, last_n: int = 10) -> float:
    """Compute rolling signal-to-noise ratio for a domain.

    Returns signal_count / (signal_count + noise_count) over the last N
    domain_stats rows for the given domain.  Returns 1.0 if no data exists
    (assume clean until proven noisy).
    """
    conn = audit_base.connect(db_path)
    try:
        row = conn.execute(
            "SELECT COALESCE(SUM(signal_count), 0), COALESCE(SUM(noise_count), 0) "
            "FROM (SELECT signal_count, noise_count FROM domain_stats "
            "WHERE domain = ? ORDER BY id DESC LIMIT ?)",
            (domain, last_n),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return 1.0
    signal, noise = row
    total = signal + noise
    if total == 0:
        return 1.0
    return signal / total


def prune_metrics(db_path: str | Path, retention_days: int = 90) -> int:
    """Delete rows older than retention_days. Returns total rows deleted."""
    conn = audit_base.connect(db_path)
    try:
        cutoff = f"-{retention_days} days"
        r1 = conn.execute(
            "DELETE FROM runs WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        r2 = conn.execute(
            "DELETE FROM domain_stats WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    return r1 + r2
