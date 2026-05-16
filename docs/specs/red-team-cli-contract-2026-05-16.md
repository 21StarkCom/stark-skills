# Red-team CLI contract snapshot

**Date:** 2026-05-16
**Phase:** 0 of the red-team TS migration plan (`docs/superpowers/plans/2026-05-16-red-team-ts-migration.md`)
**Status:** Frozen for Phase 1+

This document captures the **frozen surface** of the canonical Python audit CLI (`scripts/red_team_audit_cli.py`) plus the existing dispatcher entry points (`red_team_design_dispatch.py`, `red_team_plan_dispatch.py`) as of 2026-05-16. The Phase 2 `--help` parity gate compares the TS port byte-for-byte against this snapshot.

`--replay-transcript PATH` is **declared on every Phase-0 stubbed subcommand** so the Phase 1 implementation in both Python and TS can land without conflicting with the Phase 2 parity gate.

---

## 1. Stdout discipline (invariant across every subcommand)

- Every JSON-emitting CLI mode writes **exactly one** parseable JSON value to stdout.
- Logs, resolved DB paths, branch-dispatch announcements, drift diagnostics, and credential preflight messages all go to **stderr** only.
- Tests assert: `json.loads(stdout) == envelope` (no leading/trailing text) and that stderr can be redirected to `/dev/null` without changing the stdout envelope. See `scripts/test_red_team_audit_cli.py::test_stdout_discipline_*`.

---

## 2. `scripts/red_team_audit_cli.py` — frozen surface

### 2.1 Top-level

```
usage: red_team_audit_cli [-h]
                          {resolve-db,ensure-schema,assert-schema-version,migrate,preflight-credentials,record-run,record-findings,update-run-status,read-run,get-findings} ...
```

| Subcommand | Phase 0 status | Description |
|---|---|---|
| `resolve-db` | shipping | Canonical DB-path resolver. |
| `ensure-schema` | shipping | Atomic create-or-verify against the frozen DDL. |
| `assert-schema-version` | shipping | Singleton-marker gate for writers. |
| `migrate --stamp-current` | shipping | Stamp every known DB. Rerun-safe. |
| `preflight-credentials` | shipping | stark-* GitHub App keychain + minting smoke. |
| `record-run` | **stub** | Phase 1 deliverable. Parser + schema + exit envelope only. |
| `record-findings` | **stub** | Phase 1 deliverable. Parser + schema + exit envelope only. |
| `update-run-status` | **stub** | Phase 1 deliverable. Parser + schema + exit envelope only. |
| `read-run` | **stub** | Phase 1 deliverable. Parser + schema + exit envelope only. |
| `get-findings` | **stub** | Phase 1 deliverable. Parser + schema + exit envelope only. |

### 2.2 `resolve-db`

```
usage: red_team_audit_cli resolve-db [-h] [--db DB] [--json]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--db` | no | (precedence order below) | Explicit DB path override. |
| `--json` | no | — | Accepted for symmetry; output is always JSON. |

#### Resolver precedence (highest wins)

1. `--db PATH` (CLI argument).
2. `STARK_RED_TEAM_DB` environment variable.
3. `red_team.audit.db_path` in the merged `global/config.json` (org/repo overlays inherit).
4. Hard-coded default: `~/.claude/code-review/history/forged-review/forged_review_metrics.db`.

Every result is canonicalized via `Path.resolve()` so symlinks and relative paths produce byte-equal outputs across Python (in-process) and TS (shell-out). The Phase 0 resolver parity matrix asserts this byte equality for every input combination.

#### Stdout envelope

```json
{
  "db_path": "/abs/canonical/path",
  "source": "default" | "env" | "config" | "cli",
  "expected_version": 1
}
```

#### Exit codes

| Code | Meaning |
|---|---|
| 0 | Resolved successfully. |
| 2 | argparse usage error (invalid flag). |

### 2.3 `ensure-schema`

```
usage: red_team_audit_cli ensure-schema [-h]
                                        --expected-version EXPECTED_VERSION
                                        [--db DB]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--expected-version` | yes | — | Frozen schema version (Phase 0 = 1). |
| `--db` | no | resolver | Override the resolved DB path. |

#### Stdout envelope (success)

```json
{
  "ok": true,
  "branch": "create" | "recovery" | "bootstrap" | "verify_refresh",
  "db_path": "/abs/canonical/path",
  "version": 1,
  "applied_at": "2026-05-16T12:34:56Z",
  "orphans_cleaned": ["..."]
}
```

#### Stdout envelope (failure)

```json
{ "error": "schema_version_mismatch", "db_path": "...", "expected": 1, "actual": N }
{ "error": "schema_drift", "db_path": "...", "detail": { "drift": {...} } }
{ "error": "bootstrap_refused_pre_marker_drift", "db_path": "...", "detail": {...} }
```

#### Exit codes

| Code | Meaning |
|---|---|
| 0 | Schema is at the expected version (create, recovery, bootstrap, or verify_refresh). |
| 2 | `schema_version_mismatch` (version on disk ≠ expected). |
| 3 | `schema_drift` or `bootstrap_refused_pre_marker_drift` (live DDL diverges from snapshot). |

See [`red-team-audit-schema-2026-05-16.md`](red-team-audit-schema-2026-05-16.md) for the four-branch decision table.

### 2.4 `assert-schema-version`

```
usage: red_team_audit_cli assert-schema-version [-h]
                                                --expected-version EXPECTED_VERSION
                                                [--db DB]
```

Writer-side gate. Reads `schema_meta` singleton + raises on any mismatch.

#### Stdout envelope (success)

```json
{ "ok": true, "db_path": "...", "version": 1, "applied_at": "..." }
```

#### Stdout envelope (failure)

```json
{ "error": "db_missing", "db_path": "...", "detail": {...} }
{ "error": "schema_meta_missing", "db_path": "...", "detail": {...} }
{ "error": "schema_version_mismatch", "db_path": "...", "expected": 1, "actual": N }
```

#### Exit codes

| Code | Meaning |
|---|---|
| 0 | Marker present + version matches. |
| 2 | `schema_version_mismatch`. |
| 3 | `db_missing` or `schema_meta_missing`. |

### 2.5 `migrate --stamp-current`

```
usage: red_team_audit_cli migrate [-h] --stamp-current [--db DB]
```

| Flag | Required | Default | Description |
|---|---|---|---|
| `--stamp-current` | yes | — | Enumerate-and-stamp mode (the only mode in Phase 0). |
| `--db` | no | resolver | Limit migration to a single explicit DB. |

Iterates every DB the resolver knows about, applies `ensure-schema` to each via the `ON CONFLICT(id) DO UPDATE` upsert path. Rerun-safe under interruption.

#### Stdout envelope

```json
{
  "ok": true,
  "results": [
    {
      "db_path": "...",
      "branch": "create" | "recovery" | "bootstrap" | "verify_refresh",
      "version": 1,
      "applied_at": "...",
      "orphans_cleaned": []
    }
  ]
}
```

#### Exit codes

| Code | Meaning |
|---|---|
| 0 | Every DB stamped (or already at the expected version). |
| 2 | Schema-version mismatch on any DB. |
| 3 | DDL drift on any DB (will not stamp). |

### 2.6 `preflight-credentials`

```
usage: red_team_audit_cli preflight-credentials [-h] [--json]
```

Cites the existing `stark-gh` flow (`scripts/github_app.py`) — does **not** re-spec keychain layout, App / Installation ID assignments, or token caching. Per-app probes:

1. macOS Keychain has the `STARK_*_PRIVATE_KEY` entry.
2. The corresponding base64-encoded private key decodes cleanly.
3. `github_app.get_token(app_name)` mints a fresh installation token.

#### Stdout envelope

```json
{
  "ok": true | false,
  "apps": [
    {
      "app": "stark-claude" | "stark-codex" | "stark-gemini",
      "app_id": "3066738",
      "installation_id": "115648521",
      "keychain_ok": true,
      "mint_ok": true,
      "token_expires_at": 1234567890.0,
      "error": null | "keychain: ..." | "mint: ..."
    }
  ],
  "error": null | "..."
}
```

#### Exit codes

| Code | Meaning |
|---|---|
| 0 | All three apps have a valid keychain entry and minted a token. |
| 4 | One or more apps failed the keychain or mint check. |

### 2.7 Phase-1 stubs — `record-run` / `record-findings` / `update-run-status` / `read-run` / `get-findings`

All five share the same flag surface so the Phase 2 `--help` parity gate covers them uniformly:

```
usage: red_team_audit_cli <subcommand> [-h] [--db DB] [--run-key RUN_KEY]
                                       [--json] [--replay-transcript PATH]
```

| Flag | Phase 0 behavior | Phase 1 semantics |
|---|---|---|
| `--db` | parsed, unused | Override the resolved DB path. |
| `--run-key` | parsed, unused | Content-aware run identity (the Phase 1 spec defines its inputs). |
| `--json` | parsed, unused (output is always JSON) | Accepted for symmetry. |
| `--replay-transcript PATH` | **declared, unused in Phase 0** | Phase 1 deterministic replay seam — bypass live model dispatch and feed the recorded transcript through the parsing / aggregation / audit-write path. **Declared in Phase 0 so the Phase 2 --help parity gate passes without conflict.** |

#### Stdout envelope (Phase 0)

Every stub emits a structured "not implemented" envelope that includes the eventual stdin / stdout JSON schemas so callers can pre-write client code:

```json
{
  "error": "not_implemented_in_phase_0",
  "subcommand": "record-run",
  "phase": 0,
  "next_phase": 1,
  "description": "...",
  "stdin_schema": { ... },
  "stdout_schema": { ... }
}
```

#### Exit codes (Phase 0)

| Code | Meaning |
|---|---|
| 64 | `not_implemented_in_phase_0` (every stub returns this). |

Phase 1 fills in the bodies; exit codes will then follow each subcommand's own table per the migration plan's recovery order.

---

## 3. Dispatcher entry points (Python, snapshotted)

These dispatchers run today via `/stark-red-team-design` and `/stark-red-team-plan`. Phase 0 added a single non-blocking change: each dispatcher calls `red_team_audit_cli.preflight_credentials_smoke()` at the top of `main()`. The smoke logs degraded credentials to stderr and never raises. Phase 1 promotes it to a hard gate.

### 3.1 `red_team_design_dispatch.py`

```
usage: red_team_design_dispatch [-h] --design DESIGN [--source-spec SOURCE_SPEC]
                                [--model MODEL] [--no-sidecar] [--no-audit]
                                [--json]
                                [--enable-fix-plan-for-calibration]
                                [--accept-red-team-human-review STABLE_KEY]
                                [--no-confirm]
```

Stdout JSON receipt (when `--json`) keys: `status`, `model`, `run_id`, `sidecar_path` (optional), `error` (optional), `total_findings`, `blocking_count`, `human_review_count`, `cost_usd`, `duration_s`, `synthesis` (optional), `fix_plan_status`.

Exit codes: `0` success or `halted` (with a JSON receipt); `2` on `status="error"`.

### 3.2 `red_team_plan_dispatch.py`

Same surface as the design dispatcher with `--plan` replacing `--design`.

### 3.3 Resolver wiring summary

Every dispatcher write site now goes through `red_team_audit.resolve_db_path()` (a thin wrapper over `red_team_audit_cli.resolve_db()`). No parallel resolution remains; `red_team_audit.DEFAULT_DB_PATH` is a re-export of `red_team_audit_cli.DEFAULT_DB_PATH`.

Operator CLIs (`red_team_status.py`, `red_team_accept.py`) gained an explicit `--db` flag that defaults to the resolver so `STARK_RED_TEAM_DB=...` overrides take effect on read-side tools too. `red_team_backfill.py` already accepted `--db`.

---

## 4. Parity-test contract

For every documented input combination the Phase 0 resolver parity matrix asserts:

```
python -m red_team_audit_cli resolve-db [--db PATH]    (in-process via the resolver module)
node tools/red_team_audit_cli_proxy.test.ts            (shell-out to the same CLI)
```

byte-equal `db_path` field. The fixture matrix is committed under `scripts/test_red_team_audit_cli.py::test_resolver_parity_*`. Phase 1 inherits this matrix — adding a new resolver input source there means adding a row here in the same PR.

---

## 5. Schema-version freeze

Phase 0 ships `SCHEMA_VERSION = 1`. Bumping it is a **both-sides change** (Python + TS migration in the same PR) per the migration plan's risk table. See [`red-team-audit-schema-2026-05-16.md`](red-team-audit-schema-2026-05-16.md) for the four-branch `ensure-schema` decision table the bump would have to flow through.
