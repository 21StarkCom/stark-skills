"""Phase-0 live tests for ``red_team_audit_cli``.

Covers the four ``ensure-schema`` branches against real SQLite files (no
mocks), migrate rerun-safety, ``assert-schema-version`` envelopes, stub
exit envelopes, stdout discipline (exactly one JSON envelope per call;
stderr silenceable), the resolver precedence matrix, and the
``preflight_credentials_smoke`` non-blocking hook.

Parity with the TS shell-out side of the resolver matrix lives in
``tools/red_team_audit_cli_resolver_parity.test.ts``; both halves consume
the same fixture matrix defined in :data:`RESOLVER_FIXTURES`.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

import red_team_audit
import red_team_audit_cli as cli


# ── Helpers ──────────────────────────────────────────────────────────────


def _cli(*args: str, env: dict | None = None) -> subprocess.CompletedProcess:
    """Run the audit CLI as a subprocess so stdout/stderr are byte-faithful."""
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(Path(__file__).parent / "red_team_audit_cli.py"), *args],
        capture_output=True,
        text=True,
        env=full_env,
    )


def _create_pre_marker_db(db_path: Path) -> None:
    """Build a DB in the exact pre-marker shape (no schema_meta, user_version=0)."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    import red_team_human_review
    red_team_audit.init_red_team_tables(db_path)
    red_team_human_review.init_table(db_path)
    # Belt + suspenders: confirm no schema_meta and user_version=0.
    conn = sqlite3.connect(str(db_path))
    try:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
        ).fetchone()
        assert row is None, "pre-marker fixture must not have schema_meta"
    finally:
        conn.close()


# ── ensure-schema: four-branch live tests ────────────────────────────────


def test_ensure_schema_branch_create_atomic(tmp_path):
    """Branch 1: target absent → atomic temp-then-rename + stamp."""
    target = tmp_path / "fresh.db"
    result = cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert result.branch == "create"
    assert target.exists()
    conn = sqlite3.connect(str(target))
    try:
        row = conn.execute(
            "SELECT id, version FROM schema_meta"
        ).fetchone()
        assert row == (1, cli.SCHEMA_VERSION)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == cli.SCHEMA_VERSION
    finally:
        conn.close()
    # No orphan temp siblings left behind.
    assert not any(p.name.startswith("fresh.db.creating-") for p in tmp_path.iterdir())


def test_ensure_schema_branch_recovery_from_empty_file(tmp_path):
    """Branch 2: empty existing file (no tables, user_version=0) → wipe + create."""
    target = tmp_path / "empty.db"
    target.touch()
    assert target.stat().st_size == 0
    result = cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert result.branch == "recovery"
    conn = sqlite3.connect(str(target))
    try:
        marker = conn.execute("SELECT id, version FROM schema_meta").fetchone()
        assert marker == (1, cli.SCHEMA_VERSION)
    finally:
        conn.close()


def test_ensure_schema_branch_bootstrap_pre_marker_db(tmp_path):
    """Branch 3: pre-marker DB (app tables, no schema_meta) → stamp marker."""
    target = tmp_path / "pre.db"
    _create_pre_marker_db(target)
    result = cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert result.branch == "bootstrap"
    conn = sqlite3.connect(str(target))
    try:
        marker = conn.execute(
            "SELECT id, version FROM schema_meta"
        ).fetchone()
        assert marker == (1, cli.SCHEMA_VERSION)
        assert conn.execute("PRAGMA user_version").fetchone()[0] == cli.SCHEMA_VERSION
        # Application data is untouched: app tables still exist.
        tables = {
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert {"red_team_runs", "red_team_findings"}.issubset(tables)
    finally:
        conn.close()


def test_ensure_schema_branch_verify_refresh_idempotent(tmp_path):
    """Branch 4: rerun after success → single row, refreshed applied_at, no drift."""
    target = tmp_path / "rerun.db"
    cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    # Snapshot row count + version, sleep enough to ensure a different
    # applied_at, then rerun.
    conn = sqlite3.connect(str(target))
    try:
        count_before = conn.execute("SELECT COUNT(*) FROM schema_meta").fetchone()[0]
        applied_before = conn.execute(
            "SELECT applied_at FROM schema_meta WHERE id = 1"
        ).fetchone()[0]
    finally:
        conn.close()
    assert count_before == 1
    time.sleep(1.05)  # second-resolution timestamps
    result = cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert result.branch == "verify_refresh"
    conn = sqlite3.connect(str(target))
    try:
        count_after = conn.execute("SELECT COUNT(*) FROM schema_meta").fetchone()[0]
        applied_after = conn.execute(
            "SELECT applied_at FROM schema_meta WHERE id = 1"
        ).fetchone()[0]
    finally:
        conn.close()
    assert count_after == 1, "singleton CHECK + ON CONFLICT should keep exactly one row"
    assert applied_after >= applied_before


def test_ensure_schema_cleans_orphan_creating_siblings(tmp_path):
    """Interrupted-create fixture: orphan ``.creating-*`` older than TTL is reaped."""
    target = tmp_path / "orphan.db"
    orphan = target.with_name(f"{target.name}.creating-{uuid.uuid4().hex}")
    orphan.write_bytes(b"")
    # Backdate the mtime well past the TTL so the cleanup actually triggers.
    old = time.time() - (cli.ORPHAN_CREATE_TTL_S + 60)
    os.utime(orphan, (old, old))
    result = cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert result.branch == "create"
    assert str(orphan) in result.orphans_cleaned
    assert not orphan.exists()
    assert target.exists()


def test_ensure_schema_refuses_pre_marker_drift(tmp_path):
    """Branch 3 refuses when app tables have unexpected hand-edited columns."""
    target = tmp_path / "drifted.db"
    _create_pre_marker_db(target)
    conn = sqlite3.connect(str(target))
    try:
        conn.execute("ALTER TABLE red_team_runs ADD COLUMN operator_edit TEXT")
        conn.commit()
    finally:
        conn.close()
    with pytest.raises(cli.SchemaDriftError) as exc:
        cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    assert exc.value.code == "bootstrap_refused_pre_marker_drift"


# ── assert-schema-version envelopes ─────────────────────────────────────


def test_assert_schema_version_success(tmp_path):
    target = tmp_path / "ok.db"
    cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    version, applied_at = cli.assert_schema_version(target, cli.SCHEMA_VERSION)
    assert version == cli.SCHEMA_VERSION
    assert applied_at  # non-empty


def test_assert_schema_version_db_missing(tmp_path):
    target = tmp_path / "nope.db"
    with pytest.raises(cli.SchemaDriftError) as exc:
        cli.assert_schema_version(target, cli.SCHEMA_VERSION)
    assert exc.value.code == "db_missing"


def test_assert_schema_version_marker_missing(tmp_path):
    target = tmp_path / "pre.db"
    _create_pre_marker_db(target)
    with pytest.raises(cli.SchemaDriftError) as exc:
        cli.assert_schema_version(target, cli.SCHEMA_VERSION)
    assert exc.value.code == "schema_meta_missing"


def test_assert_schema_version_mismatch_envelope(tmp_path):
    target = tmp_path / "v.db"
    cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    with pytest.raises(cli.SchemaVersionMismatch) as exc:
        cli.assert_schema_version(target, cli.SCHEMA_VERSION + 99)
    assert exc.value.expected == cli.SCHEMA_VERSION + 99
    assert exc.value.actual == cli.SCHEMA_VERSION


# ── migrate --stamp-current rerun-safety ────────────────────────────────


def test_migrate_stamp_current_idempotent_under_rerun(tmp_path):
    target = tmp_path / "m.db"
    r1 = cli.migrate_stamp_current(str(target))
    r2 = cli.migrate_stamp_current(str(target))
    assert r1[0]["branch"] == "create"
    assert r2[0]["branch"] == "verify_refresh"
    conn = sqlite3.connect(str(target))
    try:
        assert conn.execute("SELECT COUNT(*) FROM schema_meta").fetchone()[0] == 1
    finally:
        conn.close()


# ── Stubs ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "sub",
    ["record-run", "record-findings", "update-run-status", "read-run", "get-findings"],
)
def test_stubs_emit_not_implemented_envelope_with_phase0_exit_code(tmp_path, sub):
    proc = _cli(sub)
    assert proc.returncode == cli.STUB_EXIT_CODE
    payload = json.loads(proc.stdout)
    assert payload["error"] == "not_implemented_in_phase_0"
    assert payload["subcommand"] == sub
    assert payload["phase"] == 0
    assert payload["next_phase"] == 1
    assert "stdin_schema" in payload
    assert "stdout_schema" in payload


@pytest.mark.parametrize(
    "sub",
    ["record-run", "record-findings", "update-run-status", "read-run", "get-findings"],
)
def test_stubs_declare_replay_transcript_flag_for_phase_2_parity(sub):
    """``--replay-transcript`` must be in each stub's --help for the Phase 2 gate."""
    proc = _cli(sub, "--help")
    assert proc.returncode == 0
    assert "--replay-transcript PATH" in proc.stdout
    assert "Phase 1 deterministic replay seam" in proc.stdout


# ── Stdout discipline ───────────────────────────────────────────────────


def test_stdout_discipline_resolve_db_single_envelope(tmp_path):
    proc = _cli("resolve-db", "--db", str(tmp_path / "x.db"))
    assert proc.returncode == 0
    # Exactly one JSON value, parses cleanly. No leading or trailing text.
    payload = json.loads(proc.stdout)
    assert payload["source"] == "cli"
    # Stripping the JSON envelope leaves only whitespace.
    after = proc.stdout.replace(json.dumps(payload, separators=(",", ":"),
                                          sort_keys=True), "", 1)
    assert after.strip() == ""


def test_stdout_discipline_ensure_schema_stderr_silenceable(tmp_path):
    target = tmp_path / "s.db"
    proc = subprocess.run(
        [
            sys.executable, str(Path(__file__).parent / "red_team_audit_cli.py"),
            "ensure-schema", "--expected-version", str(cli.SCHEMA_VERSION),
            "--db", str(target),
        ],
        capture_output=True,
        text=True,
    )
    # ensure-schema emits an "ensure-schema: branch=..." log to stderr; that
    # log must NEVER leak to stdout. We validate stdout is parseable JSON
    # both with stderr live AND with stderr redirected to /dev/null.
    payload_with_stderr = json.loads(proc.stdout)
    proc_silenced = subprocess.run(
        [
            sys.executable, str(Path(__file__).parent / "red_team_audit_cli.py"),
            "ensure-schema", "--expected-version", str(cli.SCHEMA_VERSION),
            "--db", str(tmp_path / "s2.db"),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    payload_silenced = json.loads(proc_silenced.stdout)
    assert payload_with_stderr["ok"] is True
    assert payload_silenced["ok"] is True


def test_stdout_discipline_migrate_single_envelope(tmp_path):
    proc = _cli("migrate", "--stamp-current", "--db", str(tmp_path / "mig.db"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["ok"] is True
    assert len(payload["results"]) == 1


# ── Resolver precedence + Python↔TS parity matrix ───────────────────────


# Each fixture: (description, env, cli_db, config_value, expected_source)
RESOLVER_FIXTURES = [
    ("default", {}, None, None, "default"),
    ("cli_override", {}, "/tmp/fixture-cli.db", None, "cli"),
    ("env_override", {cli.ENV_DB_OVERRIDE: "/tmp/fixture-env.db"}, None, None, "env"),
    (
        "cli_beats_env",
        {cli.ENV_DB_OVERRIDE: "/tmp/fixture-env.db"},
        "/tmp/fixture-cli.db",
        None,
        "cli",
    ),
    ("config_override", {}, None, "/tmp/fixture-config.db", "config"),
    (
        "env_beats_config",
        {cli.ENV_DB_OVERRIDE: "/tmp/fixture-env.db"},
        None,
        "/tmp/fixture-config.db",
        "env",
    ),
]


def _write_config_with_db(tmp_path: Path, db_value: str | None) -> Path:
    cfg = {"red_team": {"audit": {}}}
    if db_value is not None:
        cfg["red_team"]["audit"]["db_path"] = db_value
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps(cfg))
    return cfg_path


@pytest.mark.parametrize("desc,env,cli_db,config_value,expected_source", RESOLVER_FIXTURES)
def test_resolver_precedence_python_in_process(
    monkeypatch, tmp_path, desc, env, cli_db, config_value, expected_source
):
    """In-process resolver: every documented input combo lands at the right source."""
    # Isolate the env first.
    for var in (cli.ENV_DB_OVERRIDE,):
        monkeypatch.delenv(var, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)

    # Stub the config loader to return our fixture config.
    import config_loader
    cfg_path = _write_config_with_db(tmp_path, config_value)
    monkeypatch.setattr(config_loader, "CONFIG_PATH", cfg_path)
    config_loader.load_config.cache_clear()

    resolved = cli.resolve_db(cli_db)
    assert resolved.source == expected_source, (
        f"fixture={desc}: expected source={expected_source}, got {resolved.source}"
    )
    # Paths are always canonicalized; the value matches expectations.
    if cli_db is not None:
        assert resolved.db_path == Path(cli_db).resolve()
    elif env.get(cli.ENV_DB_OVERRIDE):
        assert resolved.db_path == Path(env[cli.ENV_DB_OVERRIDE]).resolve()
    elif config_value is not None:
        assert resolved.db_path == Path(config_value).resolve()
    else:
        assert resolved.db_path == cli.DEFAULT_DB_PATH.expanduser().resolve()


@pytest.mark.parametrize("desc,env,cli_db,config_value,expected_source", RESOLVER_FIXTURES)
def test_resolver_parity_subprocess_matches_in_process(
    monkeypatch, tmp_path, desc, env, cli_db, config_value, expected_source
):
    """Phase-0 parity gate (Python in-process vs. CLI shell-out).

    The TS half of this matrix (``tools/red_team_audit_cli_resolver_parity.test.ts``)
    shells out to the same CLI and asserts the same envelope shape; this test
    proves the seam is byte-stable from Python so the TS parity test can
    rely on the same fixture matrix.
    """
    # Isolate env for the in-process call.
    for var in (cli.ENV_DB_OVERRIDE,):
        monkeypatch.delenv(var, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)

    import config_loader
    cfg_path = _write_config_with_db(tmp_path, config_value)
    monkeypatch.setattr(config_loader, "CONFIG_PATH", cfg_path)
    config_loader.load_config.cache_clear()

    in_proc = cli.resolve_db(cli_db)

    # Subprocess: we have to plumb the test config via CONFIG_PATH env or via
    # symlinking, but config_loader reads a hard path. Phase 0 parity covers
    # cli + env + default (not config-via-subprocess); config-source parity
    # is exercised in-process only because the production config-path is
    # process-global. The TS parity test mirrors this scoping.
    if expected_source == "config":
        pytest.skip("config-source parity exercised in-process only (CONFIG_PATH is host-global)")

    sub_args = ["resolve-db"]
    if cli_db is not None:
        sub_args.extend(["--db", cli_db])
    sub_env = {**env}
    proc = _cli(*sub_args, env=sub_env)
    assert proc.returncode == 0, f"subprocess failed: {proc.stderr}"
    payload = json.loads(proc.stdout)
    assert payload["db_path"] == str(in_proc.db_path)
    assert payload["source"] == expected_source
    assert payload["expected_version"] == cli.SCHEMA_VERSION


# ── Subprocess CLI exit-code matrix ─────────────────────────────────────


def test_cli_ensure_schema_exit_code_create(tmp_path):
    proc = _cli("ensure-schema", "--expected-version", str(cli.SCHEMA_VERSION),
                "--db", str(tmp_path / "ec.db"))
    assert proc.returncode == 0
    payload = json.loads(proc.stdout)
    assert payload["branch"] == "create"
    assert payload["version"] == cli.SCHEMA_VERSION


def test_cli_assert_schema_version_mismatch_exit_code_2(tmp_path):
    target = tmp_path / "asv.db"
    cli.ensure_schema(target, expected_version=cli.SCHEMA_VERSION)
    proc = _cli("assert-schema-version", "--expected-version", "999",
                "--db", str(target))
    assert proc.returncode == 2
    payload = json.loads(proc.stdout)
    assert payload["error"] == "schema_version_mismatch"
    assert payload["expected"] == 999
    assert payload["actual"] == cli.SCHEMA_VERSION


def test_cli_assert_schema_version_db_missing_exit_code_3(tmp_path):
    proc = _cli("assert-schema-version", "--expected-version", str(cli.SCHEMA_VERSION),
                "--db", str(tmp_path / "missing.db"))
    assert proc.returncode == 3
    payload = json.loads(proc.stdout)
    assert payload["error"] == "db_missing"


# ── preflight_credentials smoke (non-blocking) ──────────────────────────


def test_preflight_credentials_smoke_never_raises(monkeypatch, capsys):
    """The smoke hook is non-blocking: even with all Keychain checks failing
    it must return cleanly and only write to stderr."""
    def fail_read(_service):
        return False, "test stub: keychain unavailable"
    monkeypatch.setattr(cli, "_keychain_read", fail_read)

    cli.preflight_credentials_smoke()  # must not raise

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "preflight-credentials smoke" in captured.err


# ── resolve_db_path re-export wiring (no parallel resolution) ───────────


def test_red_team_audit_default_db_path_is_re_exported_from_cli():
    """The constant comes from a single source — no parallel definition."""
    assert red_team_audit.DEFAULT_DB_PATH is cli.DEFAULT_DB_PATH


def test_resolve_db_path_wrapper_returns_canonical_path(tmp_path, monkeypatch):
    monkeypatch.delenv(cli.ENV_DB_OVERRIDE, raising=False)
    monkeypatch.setenv(cli.ENV_DB_OVERRIDE, str(tmp_path / "via-wrapper.db"))
    assert red_team_audit.resolve_db_path() == (tmp_path / "via-wrapper.db").resolve()
