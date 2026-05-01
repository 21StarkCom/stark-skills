"""Human-review halt recovery (FU-rt8).

The red-team gate halts when a finding's ``counter_proposal`` is
``REQUEST_HUMAN_REVIEW``. Until this module landed, that halt was
unconditional: an operator stopped by such a finding had no supported way
to acknowledge it short of disabling the feature globally or hand-editing
state files. This module implements the acknowledged-halt path.

The match identity is the FU-rt8 ``accept_key`` —
``{stage}:{persona}:{concern_hash}`` — which is stable across reruns. The
audit row also stores the original FU-rt7 ``stable_key`` so an operator
inspecting the table sees which run/round/finding-id the acceptance came
from. Lookup is keyed by ``accept_key``: a fresh dispatcher run computes
the same accept_key for the same concern (different run_id, possibly
different round/finding-id) and finds the prior accept row.

A NEW concern (different ``risk_key`` / ``affected_component`` /
materially different wording) produces a different ``concern_hash``, a
different ``accept_key``, and the halt gate re-engages — exactly what
FU-rt8's "accept this concern, but don't auto-pass future ones" demands.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import audit_base
from red_team_audit import DEFAULT_DB_PATH

_CREATE_TABLE = """\
CREATE TABLE IF NOT EXISTS red_team_human_review_accepts (
    accept_key TEXT PRIMARY KEY,
    stable_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    round_num INTEGER NOT NULL,
    persona TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    concern_hash TEXT NOT NULL,
    concern_excerpt TEXT,
    accepted_by TEXT NOT NULL,
    accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    note TEXT,
    version INTEGER NOT NULL DEFAULT 2
);

CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_run
    ON red_team_human_review_accepts(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_stable
    ON red_team_human_review_accepts(stable_key);
"""

_ACCEPTS_V2_COLUMNS = (
    ("accept_key", "TEXT"),
)


def init_table(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Create the acceptance table if it doesn't exist; migrate v1 → v2.

    v1 rows had ``stable_key`` as the primary key, which embeds the per-run
    audit identity and therefore never matched a fresh dispatcher run —
    the bug fixed by PR #430 review. v2 adds an ``accept_key`` column
    holding the cross-run identity. Existing v1 rows keep their data but
    have ``accept_key`` set to NULL until an explicit re-accept; safest
    default since auto-promoting an old stable_key to a new accept_key
    would require recomputing concern_hashes against rows we no longer
    have full context for.
    """
    audit_base.init_db(db_path, _CREATE_TABLE)
    _migrate_accepts_v2(db_path)


def _migrate_accepts_v2(db_path: str | Path) -> None:
    """Add the v2 ``accept_key`` column when upgrading from a v1 schema."""
    conn = audit_base.connect(db_path)
    try:
        existing = {
            row[1]
            for row in conn.execute(
                "PRAGMA table_info(red_team_human_review_accepts)"
            ).fetchall()
        }
        for name, decl in _ACCEPTS_V2_COLUMNS:
            if name not in existing:
                conn.execute(
                    f"ALTER TABLE red_team_human_review_accepts ADD COLUMN {name} {decl}"
                )
                existing.add(name)
        try:
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_stable "
                "ON red_team_human_review_accepts(stable_key)"
            )
        except Exception:
            pass
        conn.commit()
    finally:
        conn.close()


def _resolve_accepted_by(value: str | None) -> str:
    if value:
        return value
    # Pick the operator's identity from $USER (set by login shells); fall back
    # to ``manual`` so the column never holds an empty string in practice.
    return os.environ.get("USER") or "manual"


@dataclass(frozen=True)
class PendingHalt:
    """One unaccepted human-review finding awaiting operator acknowledgement."""

    stable_key: str
    run_id: str
    stage: str
    round_num: int
    persona: str
    finding_id: str
    concern_hash: str
    concern_excerpt: str | None
    repo: str | None
    pr_number: int | None
    artifact_relative_path: str | None
    created_at: str | None


def accept_finding(
    stable_key: str,
    *,
    run_id: str,
    stage: str,
    round_num: int,
    persona: str,
    finding_id: str,
    concern_hash: str,
    concern_excerpt: str | None,
    repo: str | None = None,
    accepted_by: str | None = None,
    note: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> None:
    """Record an operator acceptance for one human-review finding.

    Persists by ``accept_key`` (cross-run, repo-scoped identity) —
    re-accepting the same concern from a different run is a no-op
    (INSERT OR IGNORE keeps the original timestamp). The original
    ``stable_key`` is stored alongside so an auditor can see which
    run/round/finding-id slot the operator acknowledged.

    PR-#430 review fix #10: ``repo`` is now part of the accept key so an
    accept in repo A cannot suppress a halt in repo B (the audit DB is
    shared across the operator's workspace).
    """
    import stark_red_team as rt

    accept_key = rt.compute_accept_key(
        stage=stage, persona=persona, concern_hash=concern_hash, repo=repo
    )
    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        conn.execute(
            "INSERT OR IGNORE INTO red_team_human_review_accepts ("
            "accept_key, stable_key, run_id, stage, round_num, persona, finding_id, "
            "concern_hash, concern_excerpt, accepted_by, note"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                accept_key,
                stable_key,
                run_id,
                stage,
                round_num,
                persona,
                finding_id,
                concern_hash,
                concern_excerpt,
                _resolve_accepted_by(accepted_by),
                note,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def is_accepted(
    accept_key: str | None = None,
    *,
    stable_key: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> bool:
    """Return True if the operator has accepted this concern.

    Pass ``accept_key`` (cross-run identity) for the canonical lookup, or
    ``stable_key`` for one-shot per-occurrence checks (mostly used by tests
    and audit-trail tooling). Exactly one of the two must be provided.
    """
    if (accept_key is None) == (stable_key is None):
        raise ValueError("provide exactly one of accept_key or stable_key")
    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        if accept_key is not None:
            row = conn.execute(
                "SELECT 1 FROM red_team_human_review_accepts WHERE accept_key = ?",
                (accept_key,),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT 1 FROM red_team_human_review_accepts WHERE stable_key = ?",
                (stable_key,),
            ).fetchone()
    finally:
        conn.close()
    return row is not None


def filter_human_review_findings(
    findings: list[Any],
    *,
    stage: str,
    repo: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
    run_id: str | None = None,
    round_num: int | None = None,
) -> tuple[list[Any], list[str]]:
    """Split findings into ``(unaccepted, accepted_keys)`` using cross-run lookup.

    Matches accepted findings by ``accept_key`` (``repo:stage:persona:concern_hash``)
    so a key persisted from a prior run still matches the same concern in
    a fresh dispatcher invocation, while an accept in a different repo
    cannot suppress this repo's halt (PR-#430 review fix #10).

    ``run_id`` / ``round_num`` are accepted for backward compatibility but
    are no longer part of the match — they only flow through to the audit
    row when this gets called from a live dispatch.
    """
    import stark_red_team as rt

    del run_id, round_num  # accepted for back-compat; not part of the match

    init_table(db_path)
    conn = audit_base.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT accept_key FROM red_team_human_review_accepts "
            "WHERE stage = ? AND accept_key IS NOT NULL",
            (stage,),
        ).fetchall()
        all_accepted: set[str] = {r[0] for r in rows}
    finally:
        conn.close()

    unaccepted: list[Any] = []
    matched_keys: list[str] = []
    for f in findings:
        if not rt.is_human_review(f):
            continue
        accept_key = rt.compute_accept_key(
            stage=stage,
            persona=f.persona,
            concern_hash=f.concern_hash,
            repo=repo,
        )
        if accept_key in all_accepted:
            matched_keys.append(accept_key)
        else:
            unaccepted.append(f)
    return unaccepted, matched_keys


def list_pending_halts(
    *,
    repo: str | None = None,
    stage: str | None = None,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> list[PendingHalt]:
    """Return every unaccepted human-review finding in the audit DB.

    Drives the ``red-team status`` display so an operator can see all
    pending halts before deciding which to accept. Optional ``repo`` /
    ``stage`` filters keep the output scoped to the surface the operator
    is actually working on.
    """
    init_table(db_path)
    init_red_team_findings_dependency(db_path)
    where: list[str] = ["f.counter_proposal = 'REQUEST_HUMAN_REVIEW'"]
    params: list[Any] = []
    if repo is not None:
        where.append("r.repo = ?")
        params.append(repo)
    if stage is not None:
        where.append("f.stage = ?")
        params.append(stage)
    # FU-rt8: exclude already-accepted concerns by reconstructing the same
    # accept_key the dispatcher would compute for each finding row, then
    # NOT-IN-filtering against the persisted accepts table. PR-#430 review
    # fix #10 added the repo prefix; finding rows that don't carry a repo
    # (legacy) fall back to the literal "unknown" prefix to mirror
    # ``compute_accept_key(repo=None)``.
    accept_key_expr = (
        "(COALESCE(r.repo, 'unknown') || ':' || f.stage || ':' || f.persona "
        "|| ':' || COALESCE(f.concern_hash, ''))"
    )
    sql = (
        "SELECT f.stable_key, f.run_id, f.stage, f.round_num, f.persona, "
        "f.finding_id, f.concern_hash, "
        "COALESCE(f.concern, ''), r.repo, r.pr_number, r.artifact_relative_path, "
        "r.created_at "
        "FROM red_team_findings f "
        "LEFT JOIN red_team_runs r ON r.run_id = f.run_id "
        "WHERE " + " AND ".join(where) + " "
        "AND f.stable_key IS NOT NULL "
        "AND f.concern_hash IS NOT NULL "
        f"AND {accept_key_expr} NOT IN ("
        "SELECT accept_key FROM red_team_human_review_accepts WHERE accept_key IS NOT NULL"
        ") "
        "ORDER BY r.created_at DESC"
    )
    conn = audit_base.connect(db_path)
    try:
        rows = conn.execute(sql, params).fetchall()
    finally:
        conn.close()
    return [
        PendingHalt(
            stable_key=r[0],
            run_id=r[1],
            stage=r[2],
            round_num=r[3],
            persona=r[4],
            finding_id=r[5],
            concern_hash=r[6],
            concern_excerpt=r[7] or None,
            repo=r[8],
            pr_number=r[9],
            artifact_relative_path=r[10],
            created_at=r[11],
        )
        for r in rows
    ]


def init_red_team_findings_dependency(db_path: str | Path = DEFAULT_DB_PATH) -> None:
    """Best-effort init of the upstream tables used by ``list_pending_halts``.

    The SELECT join requires ``red_team_findings`` and ``red_team_runs`` to
    exist. ``red_team_audit.init_red_team_tables`` creates both. Importing
    that module from inside ``list_pending_halts`` avoids a hard
    audit_base ↔ red_team_audit ↔ red_team_human_review cycle at module
    load time.
    """
    import red_team_audit

    red_team_audit.init_red_team_tables(db_path)


def lookup_finding_metadata(
    stable_key: str,
    *,
    db_path: str | Path = DEFAULT_DB_PATH,
) -> dict[str, Any] | None:
    """Look up a stable key's full row so the CLI can show what's being accepted.

    The FU-rt7 invariant — "display the matched concern text BEFORE
    accepting it" — relies on this. The CLI accept flow reads the
    concern excerpt and operator-side metadata, prints them, and only
    then asks the operator to confirm.
    """
    init_red_team_findings_dependency(db_path)
    conn = audit_base.connect(db_path)
    try:
        row = conn.execute(
            "SELECT f.stable_key, f.run_id, f.stage, f.round_num, f.persona, "
            "f.finding_id, f.concern_hash, f.concern, f.severity, "
            "f.counter_proposal, r.repo "
            "FROM red_team_findings f "
            "LEFT JOIN red_team_runs r ON r.run_id = f.run_id "
            "WHERE f.stable_key = ? "
            "ORDER BY f.id DESC LIMIT 1",
            (stable_key,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    return {
        "stable_key": row[0],
        "run_id": row[1],
        "stage": row[2],
        "round_num": row[3],
        "persona": row[4],
        "finding_id": row[5],
        "concern_hash": row[6],
        "concern_excerpt": row[7],
        "repo": row[10],
        "severity": row[8],
        "counter_proposal": row[9],
    }
