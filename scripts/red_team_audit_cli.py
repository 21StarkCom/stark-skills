#!/usr/bin/env python3
"""Canonical red-team audit CLI — the cross-language seam for Phase 0+.

Every red-team component that touches the audit SQLite (Python entry points,
the Phase 1 TS dispatcher) goes through this CLI. No parallel surface.

Subcommands shipped in Phase 0:

  resolve-db                 Canonical DB-path resolver. JSON-on-stdout.
  ensure-schema              Atomic create-or-verify against frozen DDL.
  assert-schema-version      Singleton-marker gate for writers.
  migrate --stamp-current    Enumerate-and-stamp every known DB.
  preflight-credentials      stark-* GitHub App keychain + mint smoke.

Stubbed in Phase 0 (parser + JSON schema + exit envelope only):

  record-run                 (Phase 1 body)
  record-findings            (Phase 1 body)
  update-run-status          (Phase 1 body)
  read-run                   (Phase 1 body)
  get-findings               (Phase 1 body)

Stdout discipline: every subcommand emits exactly one parseable JSON value on
stdout. Resolved DB paths, progress logs, drift diagnostics, and credential
preflight messages all go to stderr. Tests assert this contract.

Frozen schema version for Phase 0: ``SCHEMA_VERSION = 1``. Bumping it is a
both-sides change (Python + TS in the same PR per the migration plan).
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Ensure scripts/ is on the path when invoked as a file (e.g. from a TS test
# harness shelling out to ``python3 scripts/red_team_audit_cli.py ...``).
sys.path.insert(0, str(Path(__file__).resolve().parent))

import audit_base  # noqa: E402  (path manipulation above)


# ── Frozen constants ─────────────────────────────────────────────────────

SCHEMA_VERSION = 1
"""Phase 0 frozen schema version. See docs/specs/red-team-audit-schema-2026-05-16.md."""

DEFAULT_DB_PATH = (
    Path.home()
    / ".claude"
    / "code-review"
    / "history"
    / "forged-review"
    / "forged_review_metrics.db"
)
"""Hard-coded default. Mirrored in ``red_team_audit.DEFAULT_DB_PATH``."""

ENV_DB_OVERRIDE = "STARK_RED_TEAM_DB"
"""Operator + test escape hatch. Highest precedence after explicit ``--db``."""

CONFIG_KEY_PATH = ("red_team", "audit", "db_path")
"""Optional override in ``global/config.json`` (org/repo overlays inherit)."""

REQUIRED_APP_TABLES = (
    "red_team_runs",
    "red_team_persona_stats",
    "red_team_findings",
    "red_team_human_review_accepts",
)

ORPHAN_CREATE_TTL_S = 60.0
"""Orphan ``.creating-<uuid>`` siblings older than this are auto-cleaned."""

STUB_EXIT_CODE = 64
"""``not_implemented_in_phase_0`` exit code for the five Phase 1 stub commands."""

# ── Frozen DDL (post-marker) ─────────────────────────────────────────────

POST_MARKER_DDL: str = """\
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
    stable_key TEXT,
    concern_hash TEXT,
    risk_key TEXT,
    affected_component TEXT,
    failure_mode TEXT,
    concern_excerpt_hash TEXT,
    consequence_excerpt_hash TEXT,
    counter_proposal_excerpt_hash TEXT,
    trade_off_excerpt_hash TEXT,
    reason_for_uncertainty_excerpt_hash TEXT,
    retention_mode TEXT
);

CREATE TABLE IF NOT EXISTS red_team_human_review_accepts (
    accept_key TEXT,
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

CREATE INDEX IF NOT EXISTS idx_red_team_findings_run
    ON red_team_findings(run_id, round_num);
CREATE INDEX IF NOT EXISTS idx_red_team_findings_persona
    ON red_team_findings(persona, severity);
CREATE INDEX IF NOT EXISTS idx_red_team_findings_stable_key
    ON red_team_findings(stable_key);
CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_run
    ON red_team_human_review_accepts(run_id, stage);
CREATE INDEX IF NOT EXISTS idx_rt_human_review_accepts_stable
    ON red_team_human_review_accepts(stable_key);

CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
);
"""

# Required column sets per application table. Bootstrap (Branch 3) accepts any
# DB that has at least these columns — extra columns are refused (the operator
# may have hand-edited the table), missing columns are refused (the DB
# pre-dates a known migration). Defining "shape" by required columns rather
# than by full DDL bytes is what lets the migration ladder's many legacy
# column orderings all converge here.
PRE_MARKER_REQUIRED_COLUMNS: dict[str, frozenset[str]] = {
    "red_team_runs": frozenset({
        "id", "run_id", "stage", "rounds_used", "final_status",
        "total_findings", "critical_count", "high_count", "medium_count",
        "human_review_count", "duration_s", "cost_usd", "model", "caller",
        "version", "created_at",
        "repo", "artifact_relative_path", "pr_number",
        "fix_plan_status", "fix_plan_md", "fix_plan_json", "fix_plan_cost_usd",
    }),
    "red_team_persona_stats": frozenset({
        "id", "run_id", "stage", "round_num", "persona",
        "findings_raised", "findings_at_critical", "findings_at_high",
        "findings_at_medium", "human_review_requests", "version",
    }),
    "red_team_findings": frozenset({
        "id", "run_id", "stage", "round_num", "finding_id", "persona",
        "severity", "concern", "consequence", "counter_proposal",
        "trade_off", "reason_for_uncertainty", "version", "created_at",
        "stable_key", "concern_hash", "risk_key", "affected_component",
        "failure_mode",
        "concern_excerpt_hash", "consequence_excerpt_hash",
        "counter_proposal_excerpt_hash", "trade_off_excerpt_hash",
        "reason_for_uncertainty_excerpt_hash", "retention_mode",
    }),
    "red_team_human_review_accepts": frozenset({
        "accept_key", "stable_key", "run_id", "stage", "round_num",
        "persona", "finding_id", "concern_hash", "concern_excerpt",
        "accepted_by", "accepted_at", "note", "version",
    }),
}

POST_MARKER_REQUIRED_COLUMNS: dict[str, frozenset[str]] = {
    **PRE_MARKER_REQUIRED_COLUMNS,
    "schema_meta": frozenset({"id", "version", "applied_at"}),
}


# ── Stdout / stderr discipline helpers ───────────────────────────────────


def _emit(envelope: dict[str, Any]) -> None:
    """Write exactly one JSON value to stdout, no trailing newline games.

    All subcommands route their terminal output through this function so the
    "exactly one JSON envelope on stdout" contract is mechanically enforced.
    Tests assert ``json.loads(stdout) == envelope``.
    """
    json.dump(envelope, sys.stdout, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    """Send progress / diagnostic output to stderr (silenceable)."""
    print(msg, file=sys.stderr, flush=True)


# ── Canonical DB-path resolver ───────────────────────────────────────────


@dataclass(frozen=True)
class ResolvedDb:
    """Resolver result — canonicalized DB path + provenance.

    Provenance lets callers reason about precedence: an operator setting
    ``STARK_RED_TEAM_DB=/tmp/test.db`` should see ``source="env"`` so they
    know which knob took effect.
    """

    db_path: Path
    source: str  # "cli" | "env" | "config" | "default"
    expected_version: int = SCHEMA_VERSION


def _load_config_db_override() -> str | None:
    """Read ``red_team.audit.db_path`` from the merged config, if present.

    Imported lazily to avoid a hard dep on the global config when callers
    only want the env/cli/default path. Falls back to ``None`` on any error
    (the resolver continues to the next source); that keeps a malformed
    config from blocking ``resolve-db`` entirely.
    """
    try:
        from config_loader import load_config  # type: ignore[import]
    except Exception:
        return None
    try:
        cfg = load_config()
    except Exception:
        return None
    cursor: Any = cfg
    for key in CONFIG_KEY_PATH:
        if not isinstance(cursor, dict):
            return None
        cursor = cursor.get(key)
        if cursor is None:
            return None
    return cursor if isinstance(cursor, str) and cursor else None


def resolve_db(cli_db: str | os.PathLike[str] | None = None) -> ResolvedDb:
    """Resolve the canonical audit DB path with deterministic precedence.

    Precedence (highest wins):

    1. ``cli_db`` (the ``--db PATH`` argument the caller passed).
    2. ``STARK_RED_TEAM_DB`` environment variable.
    3. ``red_team.audit.db_path`` in the merged config.
    4. Hard-coded ``DEFAULT_DB_PATH``.

    Every result is canonicalized through ``Path.resolve()`` so symlinks and
    relative paths produce byte-equal outputs across language bindings
    (Python in-process vs. TS shell-out). The Phase 0 parity test matrix
    asserts this byte equality for every input combination.
    """
    if cli_db is not None:
        return ResolvedDb(Path(cli_db).expanduser().resolve(), "cli")
    env_value = os.environ.get(ENV_DB_OVERRIDE)
    if env_value:
        return ResolvedDb(Path(env_value).expanduser().resolve(), "env")
    config_value = _load_config_db_override()
    if config_value:
        return ResolvedDb(Path(config_value).expanduser().resolve(), "config")
    return ResolvedDb(DEFAULT_DB_PATH.expanduser().resolve(), "default")


# ── Schema-marker primitives ─────────────────────────────────────────────


def _read_user_version(conn: sqlite3.Connection) -> int:
    return int(conn.execute("PRAGMA user_version").fetchone()[0])


def _read_schema_meta_row(conn: sqlite3.Connection) -> tuple[int, str] | None:
    try:
        row = conn.execute(
            "SELECT version, applied_at FROM schema_meta WHERE id = 1"
        ).fetchone()
    except sqlite3.OperationalError:
        return None
    if row is None:
        return None
    return int(row[0]), str(row[1])


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (name,),
    ).fetchone()
    return row is not None


def _table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    return {
        str(r[1])
        for r in conn.execute(f"PRAGMA table_info({name})").fetchall()
    }


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _stamp_marker(conn: sqlite3.Connection, version: int) -> None:
    """Singleton upsert + PRAGMA. Idempotent under rerun (Phase 0 contract)."""
    conn.execute(
        "INSERT INTO schema_meta (id, version, applied_at) VALUES (1, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "version = excluded.version, applied_at = excluded.applied_at",
        (version, _now_iso()),
    )
    conn.execute(f"PRAGMA user_version = {int(version)}")


def _shape_drift(
    conn: sqlite3.Connection,
    required: dict[str, frozenset[str]],
) -> dict[str, dict[str, list[str]]]:
    """Return ``{table: {missing: [...], unexpected: [...]}}`` for any drift.

    ``unexpected`` is intentionally non-empty when the live table contains
    columns the snapshot doesn't require — we treat operator hand-edits as
    drift so the bootstrap branch refuses to stamp a DB it doesn't fully
    understand.
    """
    drift: dict[str, dict[str, list[str]]] = {}
    for table, expected_cols in required.items():
        if not _table_exists(conn, table):
            drift[table] = {"missing_table": ["yes"], "missing": [], "unexpected": []}
            continue
        live = _table_columns(conn, table)
        missing = sorted(expected_cols - live)
        unexpected = sorted(live - expected_cols)
        if missing or unexpected:
            drift[table] = {"missing": missing, "unexpected": unexpected}
    return drift


# ── ensure-schema: the four-branch dance ─────────────────────────────────


def _cleanup_orphan_creates(target: Path) -> list[str]:
    """Sweep stale ``<db>.creating-<uuid>`` siblings before branch 1.

    A clean operator never sees these. An interrupted ``ensure-schema``
    invocation can leave one behind; subsequent runs reap it after the TTL
    so the temp filesystem doesn't grow unboundedly. We refuse to touch
    siblings younger than ``ORPHAN_CREATE_TTL_S`` to avoid racing with a
    parallel ``ensure-schema`` on the same target.
    """
    parent = target.parent
    cleaned: list[str] = []
    if not parent.exists():
        return cleaned
    prefix = target.name + ".creating-"
    now = time.time()
    for entry in parent.iterdir():
        if not entry.name.startswith(prefix):
            continue
        try:
            age = now - entry.stat().st_mtime
        except OSError:
            continue
        if age < ORPHAN_CREATE_TTL_S:
            continue
        try:
            entry.unlink()
            cleaned.append(str(entry))
        except OSError:
            # Best-effort. A real failure surfaces on the create attempt.
            pass
    return cleaned


def _branch1_create_atomic(target: Path, expected_version: int) -> None:
    """Atomic create: temp-then-rename so the final path is never half-built."""
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(f"{target.name}.creating-{uuid.uuid4().hex}")
    conn = sqlite3.connect(str(temp))
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.executescript(POST_MARKER_DDL)
        _stamp_marker(conn, expected_version)
        conn.commit()
    finally:
        conn.close()
    # WAL sidecars (-wal, -shm) are tied to the DB path. If they exist for
    # the temp DB after close they would be orphaned; flush via fsync of the
    # parent dir so the rename + flush sequence is durable.
    fd = os.open(str(temp), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(temp), str(target))
    # Clean any stale WAL siblings tied to the *temp* name (the WAL pragma
    # creates them on first write).
    for suffix in ("-wal", "-shm"):
        sib = temp.with_name(temp.name + suffix)
        if sib.exists():
            try:
                sib.unlink()
            except OSError:
                pass


def _branch3_bootstrap(target: Path, expected_version: int) -> None:
    """Bootstrap a pre-marker DB: stamp marker if DDL matches the snapshot."""
    conn = audit_base.connect(target)
    try:
        drift = _shape_drift(conn, PRE_MARKER_REQUIRED_COLUMNS)
        if drift:
            raise SchemaDriftError(
                "bootstrap_refused_pre_marker_drift",
                detail={"drift": drift},
            )
        conn.execute("BEGIN")
        try:
            conn.executescript(
                "CREATE TABLE IF NOT EXISTS schema_meta ("
                "id INTEGER PRIMARY KEY CHECK (id = 1), "
                "version INTEGER NOT NULL, "
                "applied_at TEXT NOT NULL)"
            )
            _stamp_marker(conn, expected_version)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        # Re-verify against the post-marker snapshot.
        post_drift = _shape_drift(conn, POST_MARKER_REQUIRED_COLUMNS)
        if post_drift:
            raise SchemaDriftError(
                "bootstrap_post_verify_failed",
                detail={"drift": post_drift},
            )
    finally:
        conn.close()


def _branch4_verify_refresh(
    target: Path, expected_version: int
) -> tuple[int, str]:
    """Verify post-marker DDL + refresh the singleton. Returns (version, applied_at)."""
    conn = audit_base.connect(target)
    try:
        drift = _shape_drift(conn, POST_MARKER_REQUIRED_COLUMNS)
        if drift:
            raise SchemaDriftError("schema_drift", detail={"drift": drift})
        marker = _read_schema_meta_row(conn)
        if marker is None:
            raise SchemaDriftError("schema_meta_missing_after_branch_dispatch")
        version, _ = marker
        if version != expected_version:
            raise SchemaVersionMismatch(expected_version, version)
        # Refresh applied_at via the ON CONFLICT path so reruns are auditable
        # and any divergence between PRAGMA user_version and the row gets
        # converged here.
        conn.execute("BEGIN")
        try:
            _stamp_marker(conn, expected_version)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        refreshed = _read_schema_meta_row(conn)
        assert refreshed is not None
        return refreshed
    finally:
        conn.close()


class SchemaDriftError(RuntimeError):
    def __init__(self, code: str, detail: dict[str, Any] | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.detail = detail or {}


class SchemaVersionMismatch(RuntimeError):
    def __init__(self, expected: int, actual: int) -> None:
        super().__init__(
            f"schema version mismatch (expected {expected}, got {actual})"
        )
        self.expected = expected
        self.actual = actual


@dataclass(frozen=True)
class EnsureResult:
    branch: str  # "create" | "recovery" | "bootstrap" | "verify_refresh"
    db_path: Path
    version: int
    applied_at: str
    orphans_cleaned: list[str]


def ensure_schema(target: Path, expected_version: int) -> EnsureResult:
    """Atomic create-or-verify implementing the four-branch spec.

    Branch dispatch is the only place we read state without holding a
    transaction; the actual mutations (create, bootstrap, refresh) all run
    inside their own transactions so a crash mid-mutation either fully
    succeeds or fully fails.
    """
    orphans = _cleanup_orphan_creates(target)

    if not target.exists():
        _log(f"ensure-schema: branch=create target={target}")
        _branch1_create_atomic(target, expected_version)
        with audit_base.connect(target) as conn:
            marker = _read_schema_meta_row(conn)
        assert marker is not None
        return EnsureResult("create", target, marker[0], marker[1], orphans)

    # File exists. Probe for branch 2/3/4.
    conn = audit_base.connect(target)
    try:
        user_version = _read_user_version(conn)
        marker = _read_schema_meta_row(conn)
        has_app_tables = any(_table_exists(conn, t) for t in REQUIRED_APP_TABLES)
    finally:
        conn.close()

    if marker is None and user_version == 0 and not has_app_tables:
        _log(
            f"ensure-schema: branch=recovery target={target} "
            f"reason=empty_db_or_interrupted_create"
        )
        target.unlink()
        # Also remove any WAL sidecars from the empty DB.
        for suffix in ("-wal", "-shm"):
            sib = target.with_name(target.name + suffix)
            if sib.exists():
                try:
                    sib.unlink()
                except OSError:
                    pass
        _branch1_create_atomic(target, expected_version)
        with audit_base.connect(target) as conn:
            marker = _read_schema_meta_row(conn)
        assert marker is not None
        return EnsureResult("recovery", target, marker[0], marker[1], orphans)

    if marker is None and user_version == 0 and has_app_tables:
        _log(f"ensure-schema: branch=bootstrap target={target}")
        _branch3_bootstrap(target, expected_version)
        with audit_base.connect(target) as conn:
            marker = _read_schema_meta_row(conn)
        assert marker is not None
        return EnsureResult("bootstrap", target, marker[0], marker[1], orphans)

    if marker is None:
        # user_version != 0 and no marker — corrupt state from a partial
        # external migration. Refuse to touch it.
        raise SchemaDriftError(
            "schema_meta_missing_with_user_version_set",
            detail={"user_version": user_version},
        )

    _log(f"ensure-schema: branch=verify_refresh target={target} version={marker[0]}")
    version, applied_at = _branch4_verify_refresh(target, expected_version)
    return EnsureResult("verify_refresh", target, version, applied_at, orphans)


# ── assert-schema-version: writer-side gate ──────────────────────────────


def assert_schema_version(target: Path, expected_version: int) -> tuple[int, str]:
    """Read singleton marker. Raise on mismatch. Caller catches + JSON-envelopes."""
    if not target.exists():
        raise SchemaDriftError("db_missing", detail={"db_path": str(target)})
    conn = audit_base.connect(target)
    try:
        marker = _read_schema_meta_row(conn)
    finally:
        conn.close()
    if marker is None:
        raise SchemaDriftError("schema_meta_missing", detail={"db_path": str(target)})
    version, applied_at = marker
    if version != expected_version:
        raise SchemaVersionMismatch(expected_version, version)
    return version, applied_at


# ── migrate --stamp-current: enumerate + stamp ───────────────────────────


def _candidate_dbs(cli_db: str | None) -> list[Path]:
    """Enumerate every DB ``migrate`` should consider.

    With ``--db`` set, the explicit target is the only candidate. Without
    ``--db``, we yield the canonical resolver's choice; future Phase 1+
    work can expand this to include sibling worktree DBs once that becomes
    a documented surface.
    """
    if cli_db is not None:
        return [Path(cli_db).expanduser().resolve()]
    return [resolve_db().db_path]


def migrate_stamp_current(cli_db: str | None) -> list[dict[str, Any]]:
    """Stamp every enumerated DB. Rerun-safe under interruption (ON CONFLICT)."""
    results: list[dict[str, Any]] = []
    for db_path in _candidate_dbs(cli_db):
        _log(f"migrate: considering {db_path}")
        result = ensure_schema(db_path, SCHEMA_VERSION)
        results.append({
            "db_path": str(result.db_path),
            "branch": result.branch,
            "version": result.version,
            "applied_at": result.applied_at,
            "orphans_cleaned": result.orphans_cleaned,
        })
    return results


# ── preflight-credentials: stark-* GitHub App smoke ──────────────────────


def _keychain_read(service: str) -> tuple[bool, str]:
    """Read a base64-encoded private key from macOS Keychain.

    Tracks the existing ``scripts/preflight.py`` shape so the gate behaves
    identically; we don't re-spec the keychain layout here.
    """
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        return False, "security CLI not found (non-macOS host?)"
    except subprocess.TimeoutExpired:
        return False, "security CLI timed out"
    except Exception as exc:
        return False, f"security CLI error: {exc}"
    if result.returncode != 0:
        return False, (result.stderr.strip() or "keychain lookup failed").splitlines()[0]
    try:
        base64.b64decode(result.stdout.strip())
    except Exception as exc:
        return False, f"base64 decode failed: {exc}"
    return True, "key present"


def preflight_credentials() -> dict[str, Any]:
    """Verify the three stark-* GitHub App identities Phase 1 will depend on.

    Cites the existing keychain + minting flow in ``scripts/github_app.py``
    (App IDs + Installation IDs + ``STARK_*_PRIVATE_KEY`` services already
    documented in root ``CLAUDE.md``). Per-app result shape:

      ``{app, app_id, installation_id, keychain_ok, mint_ok, token_expires_at,
         error}``

    ``ok`` is true iff every app's keychain entry resolves AND a fresh
    installation token mints successfully.
    """
    try:
        import github_app  # type: ignore[import]
    except Exception as exc:
        return {
            "ok": False,
            "apps": [],
            "error": f"failed to import github_app: {exc}",
        }

    results: list[dict[str, Any]] = []
    overall_ok = True
    for app_name, cfg in github_app.APPS.items():
        # The "default" alias points at stark-claude; skip it so we don't
        # double-count and confuse the operator.
        if app_name == "default":
            continue
        entry: dict[str, Any] = {
            "app": app_name,
            "app_id": cfg.get("app_id"),
            "installation_id": cfg.get("installation_id"),
            "keychain_ok": False,
            "mint_ok": False,
            "token_expires_at": None,
            "error": None,
        }
        ok, msg = _keychain_read(cfg["keychain_service"])
        entry["keychain_ok"] = ok
        if not ok:
            entry["error"] = f"keychain: {msg}"
            overall_ok = False
            results.append(entry)
            continue
        try:
            token = github_app.get_token(app_name)
            if not token:
                raise RuntimeError("get_token returned empty string")
            # Probe the cache for expiry. Best-effort; missing cache file
            # doesn't fail the preflight because the token itself minted.
            entry["mint_ok"] = True
            cache_dir = Path.home() / ".cache" / "github-app-tokens"
            for f in cache_dir.glob(f"{app_name}-*.json"):
                try:
                    data = json.loads(f.read_text())
                    entry["token_expires_at"] = data.get("expires_at")
                    break
                except Exception:
                    continue
        except Exception as exc:
            entry["error"] = f"mint: {exc}"
            overall_ok = False
        results.append(entry)
    return {"ok": overall_ok, "apps": results, "error": None}


def preflight_credentials_smoke() -> None:
    """Non-blocking smoke for existing Python entry points.

    Logs the preflight result to stderr; never raises, never exits. The
    Phase 1 cutover will replace this with a hard gate.
    """
    try:
        result = preflight_credentials()
    except Exception as exc:
        _log(f"preflight-credentials smoke: errored ({exc})")
        return
    if result.get("ok"):
        _log("preflight-credentials smoke: ok")
        return
    failed = [a["app"] for a in result.get("apps", []) if a.get("error")]
    _log(
        "preflight-credentials smoke: degraded — "
        f"failed apps={failed} (non-blocking; see "
        "`red_team_audit_cli.py preflight-credentials --json` for detail)"
    )


# ── Stubbed Phase-1 subcommands ──────────────────────────────────────────

STUB_SUBCOMMANDS: dict[str, dict[str, Any]] = {
    "record-run": {
        "description": "Insert a new red-team run row keyed on the run_key. "
                       "Phase 1 deliverable.",
        "stdin_schema": {
            "type": "object",
            "required": ["run_key", "payload"],
            "properties": {
                "run_key": {"type": "string"},
                "payload": {"type": "object"},
                "fingerprint": {"type": "string"},
            },
        },
        "stdout_schema": {
            "type": "object",
            "required": ["status", "run_key"],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": [
                        "created", "existing_in_progress", "existing_complete",
                        "transitioned_from_blocked", "fingerprint_divergence",
                    ],
                },
                "run_key": {"type": "string"},
                "payload": {"type": "object"},
            },
        },
    },
    "record-findings": {
        "description": "Stage-compare-replace persisted findings inside one "
                       "transaction. Phase 1 deliverable.",
        "stdin_schema": {
            "type": "object",
            "required": ["run_key", "findings"],
            "properties": {
                "run_key": {"type": "string"},
                "findings": {"type": "array"},
            },
        },
        "stdout_schema": {
            "type": "object",
            "required": ["status", "run_key", "count"],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["replaced", "no_change", "divergent_content"],
                },
                "run_key": {"type": "string"},
                "count": {"type": "integer"},
            },
        },
    },
    "update-run-status": {
        "description": "Apply a status transition per the allowed-transition "
                       "table. Phase 1 deliverable.",
        "stdin_schema": {
            "type": "object",
            "required": ["run_key", "to"],
            "properties": {
                "run_key": {"type": "string"},
                "to": {"type": "string"},
                "from": {"type": "string"},
                "reason_code": {"type": "string"},
            },
        },
        "stdout_schema": {
            "type": "object",
            "required": ["status", "run_key", "current"],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["transitioned", "no_op_already_terminal", "forbidden"],
                },
                "run_key": {"type": "string"},
                "current": {"type": "string"},
            },
        },
    },
    "read-run": {
        "description": "Read the run row for a given run_key. Phase 1 deliverable.",
        "stdin_schema": {
            "type": "object",
            "required": ["run_key"],
            "properties": {"run_key": {"type": "string"}},
        },
        "stdout_schema": {
            "type": "object",
            "required": ["found"],
            "properties": {
                "found": {"type": "boolean"},
                "run": {"type": ["object", "null"]},
            },
        },
    },
    "get-findings": {
        "description": "Read persisted findings for a run_key (replay-from-"
                       "persistence). Phase 1 deliverable.",
        "stdin_schema": {
            "type": "object",
            "required": ["run_key"],
            "properties": {"run_key": {"type": "string"}},
        },
        "stdout_schema": {
            "type": "object",
            "required": ["run_key", "findings"],
            "properties": {
                "run_key": {"type": "string"},
                "findings": {"type": "array"},
            },
        },
    },
}


def _emit_stub_not_implemented(subcommand: str) -> int:
    schema = STUB_SUBCOMMANDS[subcommand]
    _emit({
        "error": "not_implemented_in_phase_0",
        "subcommand": subcommand,
        "phase": 0,
        "next_phase": 1,
        "description": schema["description"],
        "stdin_schema": schema["stdin_schema"],
        "stdout_schema": schema["stdout_schema"],
    })
    return STUB_EXIT_CODE


# ── argparse wiring ──────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="red_team_audit_cli",
        description=(
            "Canonical red-team audit CLI. Schema marker, atomic create, "
            "DB resolver, credential preflight, and Phase 1 stubs."
        ),
    )
    sub = p.add_subparsers(dest="subcommand", required=True)

    rd = sub.add_parser("resolve-db", help="Resolve the canonical audit DB path.")
    rd.add_argument("--db", default=None, help="Explicit DB path override.")
    rd.add_argument("--json", action="store_true",
                    help="Accepted for symmetry; output is always JSON.")

    es = sub.add_parser("ensure-schema", help="Atomic create-or-verify.")
    es.add_argument("--expected-version", type=int, required=True,
                    help="Expected schema_meta.version (Phase 0 = 1).")
    es.add_argument("--db", default=None, help="DB path override.")

    asv = sub.add_parser("assert-schema-version",
                         help="Singleton-marker gate for writers.")
    asv.add_argument("--expected-version", type=int, required=True)
    asv.add_argument("--db", default=None)

    mig = sub.add_parser("migrate",
                         help="Stamp the singleton marker on every known DB.")
    mig.add_argument("--stamp-current", action="store_true", required=True,
                     help="Required: stamp every DB to SCHEMA_VERSION.")
    mig.add_argument("--db", default=None,
                     help="Limit migration to a single explicit DB.")

    pc = sub.add_parser("preflight-credentials",
                        help="Verify stark-* GitHub App keychain + minting.")
    pc.add_argument("--json", action="store_true",
                    help="Accepted for symmetry; output is always JSON.")

    # Stubbed Phase-1 subcommands. Each carries ``--replay-transcript PATH``
    # so the Phase 0 CLI contract snapshot includes the flag — the Phase 2
    # ``--help`` parity gate then passes without conflict when Phase 1 lands
    # the bodies.
    for name in STUB_SUBCOMMANDS:
        sp = sub.add_parser(
            name,
            help=f"{STUB_SUBCOMMANDS[name]['description']} (Phase 0 stub)",
        )
        sp.add_argument("--db", default=None)
        sp.add_argument("--run-key", default=None)
        sp.add_argument("--json", action="store_true")
        sp.add_argument(
            "--replay-transcript",
            metavar="PATH",
            default=None,
            help=(
                "Phase 1 deterministic replay seam — bypass live model "
                "dispatch and feed the recorded transcript through the "
                "parsing / aggregation / audit-write path. Declared in "
                "Phase 0 so the Phase 2 --help parity gate passes."
            ),
        )
    return p


def _cmd_resolve_db(args: argparse.Namespace) -> int:
    resolved = resolve_db(args.db)
    _emit({
        "db_path": str(resolved.db_path),
        "source": resolved.source,
        "expected_version": resolved.expected_version,
    })
    return 0


def _cmd_ensure_schema(args: argparse.Namespace) -> int:
    resolved = resolve_db(args.db)
    try:
        result = ensure_schema(resolved.db_path, args.expected_version)
    except SchemaVersionMismatch as exc:
        _emit({
            "error": "schema_version_mismatch",
            "db_path": str(resolved.db_path),
            "expected": exc.expected,
            "actual": exc.actual,
        })
        return 2
    except SchemaDriftError as exc:
        _emit({
            "error": exc.code,
            "db_path": str(resolved.db_path),
            "detail": exc.detail,
        })
        return 3
    _emit({
        "ok": True,
        "branch": result.branch,
        "db_path": str(result.db_path),
        "version": result.version,
        "applied_at": result.applied_at,
        "orphans_cleaned": result.orphans_cleaned,
    })
    return 0


def _cmd_assert_schema_version(args: argparse.Namespace) -> int:
    resolved = resolve_db(args.db)
    try:
        version, applied_at = assert_schema_version(
            resolved.db_path, args.expected_version
        )
    except SchemaVersionMismatch as exc:
        _emit({
            "error": "schema_version_mismatch",
            "db_path": str(resolved.db_path),
            "expected": exc.expected,
            "actual": exc.actual,
        })
        return 2
    except SchemaDriftError as exc:
        _emit({
            "error": exc.code,
            "db_path": str(resolved.db_path),
            "detail": exc.detail,
        })
        return 3
    _emit({
        "ok": True,
        "db_path": str(resolved.db_path),
        "version": version,
        "applied_at": applied_at,
    })
    return 0


def _cmd_migrate(args: argparse.Namespace) -> int:
    try:
        results = migrate_stamp_current(args.db)
    except SchemaVersionMismatch as exc:
        _emit({
            "error": "schema_version_mismatch",
            "expected": exc.expected,
            "actual": exc.actual,
        })
        return 2
    except SchemaDriftError as exc:
        _emit({
            "error": exc.code,
            "detail": exc.detail,
        })
        return 3
    _emit({"ok": True, "results": results})
    return 0


def _cmd_preflight_credentials(_args: argparse.Namespace) -> int:
    result = preflight_credentials()
    _emit(result)
    return 0 if result.get("ok") else 4


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    handler = {
        "resolve-db": _cmd_resolve_db,
        "ensure-schema": _cmd_ensure_schema,
        "assert-schema-version": _cmd_assert_schema_version,
        "migrate": _cmd_migrate,
        "preflight-credentials": _cmd_preflight_credentials,
    }.get(args.subcommand)
    if handler is not None:
        return handler(args)
    if args.subcommand in STUB_SUBCOMMANDS:
        return _emit_stub_not_implemented(args.subcommand)
    # Unreachable: argparse refuses unknown subcommands first.
    _emit({"error": "unknown_subcommand", "subcommand": args.subcommand})
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
