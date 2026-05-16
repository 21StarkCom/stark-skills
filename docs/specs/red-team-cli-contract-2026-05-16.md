# Red-team CLI contract snapshot

**Date:** 2026-05-16
**Phase:** 0 of the red-team TS migration plan (`docs/superpowers/plans/2026-05-16-red-team-ts-migration.md`)
**Status:** Frozen for Phase 1+

This document captures the **frozen surface** of the canonical Python audit CLI (`scripts/red_team_audit_cli.py`) plus the existing dispatcher entry points (`red_team_design_dispatch.py`, `red_team_plan_dispatch.py`) as of 2026-05-16. The Phase 2 `--help` parity gate compares the TS port byte-for-byte against this snapshot.

`--replay-transcript PATH` is **wired through the dispatcher CLIs (Phase 1a)** and **declared on every audit-CLI subcommand** so the Phase 1 TS lib can use the deterministic seam and the Phase 2 `--help` parity gate passes without conflict.

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
| `record-findings` | shipping (Phase 1a) | Bulk-insert finding rows. |
| `update-run-status` | shipping (Phase 1a) | Update `final_status` with allowed-transition + `--from` guard. |
| `read-run` | shipping (Phase 1a) | Read one run row by `--run-id`. |
| `get-findings` | shipping (Phase 1a) | Read all findings for `--run-id`. |

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

### 2.7 Phase-1a bodies — `record-run` / `record-findings` / `update-run-status` / `read-run` / `get-findings`

All five share the same base flag surface so the Phase 2 `--help` parity gate covers them uniformly:

```
usage: red_team_audit_cli <subcommand> [-h] [--db DB] [--run-key RUN_KEY] [--run-id RUN_ID]
                                       [--json] [--replay-transcript PATH]
                                       # update-run-status adds: --to STATUS [--from STATUS]
```

| Flag | Semantics |
|---|---|
| `--db` | Override the resolved DB path. |
| `--run-key` | Reserved for the future Phase 1c content-aware identity. Currently parsed, unused. |
| `--run-id` | UUID-shaped run id used by the current Python writers. Body subcommands take this. |
| `--json` | Accepted for symmetry; output is always JSON. |
| `--replay-transcript PATH` | Phase 1 deterministic seam — bypass live Codex/Responses-API dispatch and feed the recorded transcript through the parsing/aggregation/audit-write path. Declared on every subcommand so the Phase 2 `--help` parity gate passes. The flag is wired in the **dispatcher** CLIs (`red_team_design_dispatch.py`, `red_team_plan_dispatch.py`); the audit CLI subcommands accept the flag for parity but have no model-dispatch step to bypass. |
| `--to STATUS` | (`update-run-status` only) Target status. Valid: `in-progress`, `clean`, `halted`, `halted_human_review`, `error`. |
| `--from STATUS` | (`update-run-status` only) Optional guard: refuse transition if current ≠ `--from`. |

Every body runs the **plan-mandated preflight** before any read/write: canonical resolver → `ensure-schema --expected-version 1` → `assert-schema-version --expected-version 1`. A fresh install bootstraps cleanly via the first call.

#### Allowed status transitions (Phase 1a)

| From | To | Result |
|---|---|---|
| `in-progress` | any valid status | `transitioned` |
| `clean` / `halted` / `halted_human_review` / `error` | same | `no_op_already_at_target` |
| `clean` / `halted` / `halted_human_review` / `error` | `in-progress` | `forbidden_transition` (exit 2) |
| any valid status | another valid status | `transitioned` (subject to `--from` guard) |

The plan's fuller transition table (`blocked_*` / `failed_*` lineage rules) lands with a follow-up Phase 1c schema bump.

#### Stdout envelopes (success)

```json
record-run         → {"ok": true, "status": "created"|"existing", "run_id": "...", "run": {...}}
record-findings    → {"ok": true, "status": "inserted"|"no_change", "count": N}
update-run-status  → {"ok": true, "status": "transitioned"|"no_op_already_at_target", "run_id": "...",
                       "from": "...", "to": "...", "current": "..."}
read-run           → {"ok": true, "found": true|false, "run_id": "...", "run": {...} | null}
get-findings       → {"ok": true, "run_id": "...", "findings": [...], "count": N}
```

#### Stdout envelopes (failure)

```json
{"error": "bad_input_json", "detail": "..."}
{"error": "missing_payload", ...}
{"error": "missing_required_fields", "missing": ["stage", ...]}
{"error": "missing_run_id", ...}
{"error": "missing_to", ...}
{"error": "invalid_status", "valid_statuses": [...]}
{"error": "forbidden_transition", "from": "...", "to": "...", "detail": "..."}
{"error": "from_mismatch", "expected_from": "...", "actual_from": "..."}
{"error": "run_not_found", "run_id": "..."}
{"error": "record_failed", "detail": "..."}
{"error": "schema_version_mismatch", ...}
```

#### Exit-code matrix

| Code | Meaning |
|---|---|
| 0 | Success. |
| 1 | Internal failure (`record_failed`, etc.). |
| 2 | Bad input / forbidden transition / `from` mismatch / `update-run-status` invalid target. |
| 3 | `run_not_found` (`update-run-status` / future `read-run` strict modes) or DB-missing-after-preflight. |

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
                                [--replay-transcript PATH]
```

Stdout JSON receipt (when `--json`) keys: `status`, `model`, `run_id`, `sidecar_path` (optional), `error` (optional), `total_findings`, `blocking_count`, `human_review_count`, `cost_usd`, `duration_s`, `synthesis` (optional), `fix_plan_status`.

Exit codes: `0` success or `halted` (with a JSON receipt); `2` on `status="error"`.

#### `--replay-transcript PATH` (Phase 1a)

Bypasses live Codex / Responses-API dispatch and feeds the recorded transcript through the parsing → aggregation → sidecar → audit-write path. Documented as a deterministic seam used by tests; the Phase 2 TS port uses this to drive byte-level parity against the Python dispatcher.

Transcript schema (committed under `tools/fixtures/replays/`):

```json
{
  "schema_version": 1,
  "stage": "design" | "plan",
  "model": "gpt-5.5-pro",
  "round_num": 1,
  "synthesis": "...",
  "raw_output": "...",
  "findings": [
    {"id": "rt1", "persona": "data", "severity": "high",
     "concern": "...", "consequence": "...", "counter_proposal": "...",
     "trade_off": "...", "concern_hash": "..."}
  ],
  "duration_s": 0.0, "cost_usd": 0.0,
  "input_tokens": 0, "output_tokens": 0
}
```

Stage mismatch (transcript `stage` ≠ run `stage`) and unparseable `findings` arrays raise structured errors. The flag is **also accepted by every audit-CLI subcommand** for `--help` parity even though those subcommands don't have a model-dispatch step to bypass — the flag is a no-op there. See `scripts/test_red_team_replay_transcript.py` for the live end-to-end test.

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
