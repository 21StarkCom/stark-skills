"""SQLite audit module for the stark-red-team pipeline.

Tables:
- red_team_runs: one row per full red-team cycle (caller-agnostic)
- red_team_persona_stats: per-persona per-round aggregate counts
- red_team_findings: raw finding text (rt3 — enables persona tuning)

Uses audit_base for low-level plumbing. DB shares forged_review_metrics.db
so cross-skill dashboards have a single source of truth.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import audit_base

# Single source of truth — the canonical CLI owns the constant and the
# resolver. Importing from there (rather than redefining a parallel copy
# here) is the "no parallel resolution allowed" Phase 0 contract.
from red_team_audit_cli import (  # noqa: E402  (intentional re-export)
    DEFAULT_DB_PATH,
    resolve_db as _resolve_db_envelope,
)


def resolve_db_path(cli_db: str | Path | None = None) -> Path:
    """Return the canonical audit DB path with full resolver precedence.

    Thin wrapper over ``red_team_audit_cli.resolve_db`` that returns just
    the :class:`Path` — callers that need the source provenance should hit
    the CLI directly. Dispatchers use this to honor env / config overrides
    in the same way the TS Phase 1 dispatcher will via shell-out.
    """
    return _resolve_db_envelope(cli_db).db_path


_CREATE_TABLES = """\
CREATE TABLE IF NOT EXISTS red_team_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    rounds_used INTEGER NOT NULL,
    final_status TEXT NOT NULL,
    total_findings INTEGER NOT NULL,
    critical_count INTEGER NOT NULL,
    high_count INTEGER NOT NULL,
    medium_count INTEGER NOT NULL,
    human_review_count INTEGER NOT NULL,
    duration_s REAL NOT NULL,
    cost_usd REAL NOT NULL,
    model TEXT NOT NULL,
    caller TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    repo TEXT,
    artifact_relative_path TEXT,
    pr_number INTEGER,
    fix_plan_status TEXT,
    fix_plan_md TEXT,
    fix_plan_json TEXT,
    fix_plan_cost_usd REAL
);

CREATE TABLE IF NOT EXISTS red_team_persona_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    findings_raised INTEGER NOT NULL,
    findings_at_critical INTEGER NOT NULL,
    findings_at_high INTEGER NOT NULL,
    findings_at_medium INTEGER NOT NULL,
    human_review_requests INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS red_team_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    finding_id TEXT NOT NULL,
    persona TEXT NOT NULL,
    severity TEXT NOT NULL,
    concern TEXT NOT NULL,
    consequence TEXT NOT NULL,
    counter_proposal TEXT NOT NULL,
    trade_off TEXT,
    reason_for_uncertainty TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    -- v1.3 (FU-rt5 / FU-rt7): structured identity + stable key columns. New
    -- rows always populate these; legacy rows have NULL.
    stable_key TEXT,
    concern_hash TEXT,
    risk_key TEXT,
    affected_component TEXT,
    failure_mode TEXT
);

CREATE INDEX IF NOT EXISTS idx_red_team_findings_run
    ON red_team_findings(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_red_team_findings_persona
    ON red_team_findings(persona, severity);
-- The stable_key index is created by ``_migrate_red_team_findings_v13`` AFTER
-- the column-add migration runs, so legacy v1 tables (no ``stable_key``
-- column yet) don't fail this script with "no such column" on the very
-- first init pass (PR #430 review finding #14).
"""

_RED_TEAM_RUNS_V12_COLUMNS = (
    ("repo", "TEXT"),
    ("artifact_relative_path", "TEXT"),
    ("pr_number", "INTEGER"),
    ("fix_plan_status", "TEXT"),
    ("fix_plan_md", "TEXT"),
    ("fix_plan_json", "TEXT"),
    ("fix_plan_cost_usd", "REAL"),
)

_RED_TEAM_FINDINGS_V13_COLUMNS = (
    ("stable_key", "TEXT"),
    ("concern_hash", "TEXT"),
    ("risk_key", "TEXT"),
    ("affected_component", "TEXT"),
    ("failure_mode", "TEXT"),
    # v1.3 (FU-rt6): hashed/excerpt mode of raw text retention. When the
    # caller passes ``retain_full_text=False`` (default), concern/consequence/
    # counter_proposal/trade_off/reason_for_uncertainty rows hold redacted
    # excerpts and the SHA-256 of the original lives in *_hash columns.
    ("concern_excerpt_hash", "TEXT"),
    ("consequence_excerpt_hash", "TEXT"),
    ("counter_proposal_excerpt_hash", "TEXT"),
    ("trade_off_excerpt_hash", "TEXT"),
    ("reason_for_uncertainty_excerpt_hash", "TEXT"),
    ("retention_mode", "TEXT"),  # "full" | "excerpt"
)


def init_red_team_tables(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create and migrate the red_team tables if they don't exist."""
    audit_base.init_db(db_path, _CREATE_TABLES)
    _migrate_red_team_runs_v12(db_path)
    _migrate_red_team_findings_v13(db_path)


def _migrate_red_team_runs_v12(db_path: str | Path) -> None:
    """Add v1.2 red_team_runs columns one-by-one for idempotent recovery."""
    conn = audit_base.connect(db_path)
    try:
        existing = {
            row[1] for row in conn.execute("PRAGMA table_info(red_team_runs)").fetchall()
        }
        for name, decl in _RED_TEAM_RUNS_V12_COLUMNS:
            if name not in existing:
                conn.execute(f"ALTER TABLE red_team_runs ADD COLUMN {name} {decl}")
                existing.add(name)
        conn.commit()
    finally:
        conn.close()


def _migrate_red_team_findings_v13(db_path: str | Path) -> None:
    """Add v1.3 red_team_findings columns one-by-one for idempotent recovery.

    Covers the FU-rt5 structured-identity columns, the FU-rt7 stable_key, and
    the FU-rt6 retention-mode + per-field excerpt-hash columns.
    """
    conn = audit_base.connect(db_path)
    try:
        existing = {
            row[1] for row in conn.execute("PRAGMA table_info(red_team_findings)").fetchall()
        }
        for name, decl in _RED_TEAM_FINDINGS_V13_COLUMNS:
            if name not in existing:
                conn.execute(f"ALTER TABLE red_team_findings ADD COLUMN {name} {decl}")
                existing.add(name)
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_red_team_findings_stable_key "
                "ON red_team_findings(stable_key)"
            )
        except Exception:
            # ALTER TABLE ... ADD COLUMN doesn't bring the original CREATE
            # INDEX with it on legacy DBs; ignore if it already exists.
            pass
        conn.commit()
    finally:
        conn.close()


def record_red_team_run(
    run_data: dict[str, Any],
    db_path: str | Path = DEFAULT_DB_PATH,
    *,
    repo: str | None = None,
    artifact_relative_path: str | None = None,
    pr_number: int | None = None,
    fix_plan_status: str | None = "pending",
    fix_plan_md: str | None = None,
    fix_plan_json: str | None = None,
    fix_plan_cost_usd: float | None = None,
) -> None:
    """Insert one red_team_runs row."""
    repo = run_data.get("repo", repo)
    artifact_relative_path = run_data.get(
        "artifact_relative_path", artifact_relative_path
    )
    pr_number = run_data.get("pr_number", pr_number)
    fix_plan_status = run_data.get("fix_plan_status", fix_plan_status)
    fix_plan_md = run_data.get("fix_plan_md", fix_plan_md)
    fix_plan_json = _sanitize_fix_plan_json(
        run_data.get("fix_plan_json", fix_plan_json)
    )
    fix_plan_cost_usd = run_data.get("fix_plan_cost_usd", fix_plan_cost_usd)

    # Pass created_at explicitly when the caller has an authoritative
    # ISO-8601 string (e.g. RedTeamRunContext.started_at_iso). Otherwise
    # let SQLite's default fire. This keeps backfill timestamps
    # byte-identical to forward-emission timestamps for the same run.
    created_at = run_data.get("created_at")

    conn = audit_base.connect(db_path)
    try:
        if created_at is None:
            conn.execute(
                "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
                "total_findings, critical_count, high_count, medium_count, "
                "human_review_count, duration_s, cost_usd, model, caller, repo, "
                "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, "
                "fix_plan_json, fix_plan_cost_usd) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"], run_data["stage"], run_data["rounds_used"],
                    run_data["final_status"], run_data["total_findings"],
                    run_data["critical_count"], run_data["high_count"],
                    run_data["medium_count"], run_data["human_review_count"],
                    run_data["duration_s"], run_data["cost_usd"], run_data["model"],
                    run_data["caller"], repo, artifact_relative_path, pr_number,
                    fix_plan_status, fix_plan_md, fix_plan_json, fix_plan_cost_usd,
                ),
            )
        else:
            conn.execute(
                "INSERT INTO red_team_runs (run_id, stage, rounds_used, final_status, "
                "total_findings, critical_count, high_count, medium_count, "
                "human_review_count, duration_s, cost_usd, model, caller, repo, "
                "artifact_relative_path, pr_number, fix_plan_status, fix_plan_md, "
                "fix_plan_json, fix_plan_cost_usd, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_data["run_id"], run_data["stage"], run_data["rounds_used"],
                    run_data["final_status"], run_data["total_findings"],
                    run_data["critical_count"], run_data["high_count"],
                    run_data["medium_count"], run_data["human_review_count"],
                    run_data["duration_s"], run_data["cost_usd"], run_data["model"],
                    run_data["caller"], repo, artifact_relative_path, pr_number,
                    fix_plan_status, fix_plan_md, fix_plan_json, fix_plan_cost_usd,
                    created_at,
                ),
            )
        conn.commit()
    finally:
        conn.close()


_FINDING_INSERT_SQL = (
    "INSERT INTO red_team_findings ("
    "run_id, stage, round_num, finding_id, "
    "persona, severity, concern, consequence, counter_proposal, "
    "trade_off, reason_for_uncertainty, "
    "stable_key, concern_hash, risk_key, affected_component, failure_mode, "
    "concern_excerpt_hash, consequence_excerpt_hash, "
    "counter_proposal_excerpt_hash, trade_off_excerpt_hash, "
    "reason_for_uncertainty_excerpt_hash, retention_mode"
    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def _resolve_audit_policy(policy: Any) -> Any:
    """Lazy-resolve a retention policy without forcing module-load order.

    Tests construct a policy directly; production callers pass ``None`` and
    let the helper resolve via ``config_loader`` + ``red_team_audit_text``.
    Importing those at module top would create an audit_base ↔ config_loader
    cycle.
    """
    if policy is not None:
        return policy
    from config_loader import get_red_team_config
    from red_team_audit_text import policy_from_config

    return policy_from_config(get_red_team_config().get("audit"))


def _finding_insert_row(f: dict[str, Any], policy: Any) -> tuple[Any, ...]:
    """Apply retention policy + assemble one INSERT row tuple.

    Free-text fields (``concern``, ``consequence``, ``counter_proposal``,
    ``trade_off``, ``reason_for_uncertainty``) flow through the FU-rt6
    policy: ``stored`` lands in the original text column; ``hash`` lands in
    the paired ``*_excerpt_hash`` column. The structured FU-rt5 columns and
    FU-rt7 ``stable_key`` are passed through unchanged.
    """
    from red_team_audit_text import apply_to_field

    concern = apply_to_field(f.get("concern"), policy)
    consequence = apply_to_field(f.get("consequence"), policy)
    counter_proposal = apply_to_field(f.get("counter_proposal"), policy)
    trade_off = apply_to_field(f.get("trade_off"), policy)
    reason = apply_to_field(f.get("reason_for_uncertainty"), policy)

    return (
        f["run_id"],
        f["stage"],
        f["round_num"],
        f["finding_id"],
        f["persona"],
        f["severity"],
        concern.stored,
        consequence.stored,
        counter_proposal.stored,
        trade_off.stored,
        reason.stored,
        f.get("stable_key"),
        f.get("concern_hash"),
        f.get("risk_key"),
        f.get("affected_component"),
        f.get("failure_mode"),
        concern.hash,
        consequence.hash,
        counter_proposal.hash,
        trade_off.hash,
        reason.hash,
        policy.mode,
    )


def record_finding(
    *,
    run_id: str,
    stage: str,
    round_num: int,
    finding_id: str,
    persona: str,
    severity: str,
    concern: str,
    consequence: str,
    counter_proposal: str,
    trade_off: str | None,
    reason_for_uncertainty: str | None,
    stable_key: str | None = None,
    concern_hash: str | None = None,
    risk_key: str | None = None,
    affected_component: str | None = None,
    failure_mode: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
    policy: Any = None,
) -> None:
    """Insert one durable red_team_findings row.

    Free-text fields are passed through the FU-rt6 retention policy. The
    structured FU-rt5 fields and FU-rt7 ``stable_key`` are stored verbatim.
    """
    resolved = _resolve_audit_policy(policy)
    row = _finding_insert_row(
        {
            "run_id": run_id,
            "stage": stage,
            "round_num": round_num,
            "finding_id": finding_id,
            "persona": persona,
            "severity": severity,
            "concern": concern,
            "consequence": consequence,
            "counter_proposal": counter_proposal,
            "trade_off": trade_off,
            "reason_for_uncertainty": reason_for_uncertainty,
            "stable_key": stable_key,
            "concern_hash": concern_hash,
            "risk_key": risk_key,
            "affected_component": affected_component,
            "failure_mode": failure_mode,
        },
        resolved,
    )
    conn = audit_base.connect(db_path)
    try:
        conn.execute(_FINDING_INSERT_SQL, row)
        conn.commit()
    finally:
        conn.close()


def record_findings(
    findings: list[dict[str, Any]],
    db_path: str | Path = DEFAULT_DB_PATH,
    policy: Any = None,
) -> None:
    """Insert raw finding rows under the FU-rt6 retention policy."""
    resolved = _resolve_audit_policy(policy)
    conn = audit_base.connect(db_path)
    try:
        for f in findings:
            conn.execute(_FINDING_INSERT_SQL, _finding_insert_row(f, resolved))
        conn.commit()
    finally:
        conn.close()


def record_persona_stats(
    stats: list[dict[str, Any]],
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Insert per-persona stat rows."""
    conn = audit_base.connect(db_path)
    try:
        for s in stats:
            conn.execute(
                "INSERT INTO red_team_persona_stats (run_id, stage, round_num, persona, "
                "findings_raised, findings_at_critical, findings_at_high, "
                "findings_at_medium, human_review_requests) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    s["run_id"],
                    s["stage"],
                    s["round_num"],
                    s["persona"],
                    s["findings_raised"],
                    s["findings_at_critical"],
                    s["findings_at_high"],
                    s["findings_at_medium"],
                    s["human_review_requests"],
                ),
            )
        conn.commit()
    finally:
        conn.close()


def record_fix_plan(
    run_id: str,
    *,
    fix_plan_md: str | None,
    fix_plan_json: str | None,
    fix_plan_cost_usd: float | None,
    fix_plan_status: str,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Update the persisted fix-plan state for an existing red-team run."""
    sanitized_json = _sanitize_fix_plan_json(fix_plan_json)
    conn = audit_base.connect(db_path)
    try:
        cur = conn.execute(
            "UPDATE red_team_runs "
            "SET fix_plan_md = ?, fix_plan_json = ?, fix_plan_cost_usd = ?, "
            "fix_plan_status = ? "
            "WHERE run_id = ?",
            (
                fix_plan_md,
                sanitized_json,
                fix_plan_cost_usd,
                fix_plan_status,
                run_id,
            ),
        )
        if cur.rowcount != 1:
            raise RuntimeError(f"red_team_runs row not found for run_id={run_id!r}")
        conn.commit()
    finally:
        conn.close()


def _sanitize_fix_plan_json(fix_plan_json: str | None) -> str | None:
    """Remove raw_output from serialized fix-plan JSON before audit storage."""
    if fix_plan_json is None:
        return None
    parsed = json.loads(fix_plan_json)
    if isinstance(parsed, dict):
        parsed.pop("raw_output", None)
        return json.dumps(parsed, separators=(",", ":"), sort_keys=True)
    return fix_plan_json


def prune_red_team_metrics(
    retention_days: int = 180,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> int:
    """Delete rows older than retention_days. Returns total rows deleted."""
    conn = audit_base.connect(db_path)
    try:
        cutoff = f"-{retention_days} days"
        r1 = conn.execute(
            "DELETE FROM red_team_runs WHERE created_at < "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        r2 = conn.execute(
            "DELETE FROM red_team_findings WHERE created_at < "
            "strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)",
            (cutoff,),
        ).rowcount
        conn.commit()
    finally:
        conn.close()
    return r1 + r2
