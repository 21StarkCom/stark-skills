# Red-team audit SQLite schema snapshot

**Date:** 2026-05-16
**Phase:** 0 of the red-team TS migration plan (`docs/superpowers/plans/2026-05-16-red-team-ts-migration.md`)
**Status:** Frozen contract — Phase 1+ depends on the post-marker DDL being byte-stable

This document captures two side-by-side DDL snapshots:

- **Pre-marker** — the schema as it stood immediately before Phase 0 introduced `schema_meta`. Existing installs (developer machines, CI fixtures) all have this exact shape after running `red_team_audit.init_red_team_tables()` and `red_team_human_review.init_table()`.
- **Post-marker** — the same schema plus the Phase 0 singleton marker table and `PRAGMA user_version = 1`.

The `ensure-schema` CLI uses these two snapshots as the source of truth for:

1. Bootstrapping a pre-marker DB into the post-marker shape (one-time, via `INSERT INTO schema_meta(...) ON CONFLICT(id) DO UPDATE`).
2. Verifying a marker-present DB still matches the post-marker DDL (refuses on drift).
3. Creating a fresh DB into a temp sibling then atomically renaming it over the final path.

**Frozen schema version: 1.** Phase 1+ writers MUST `assert-schema-version --expected-version 1` before the first write.

---

## Canonical DB path

Default location:

```
~/.claude/code-review/history/forged-review/forged_review_metrics.db
```

Single source of truth: `scripts/red_team_audit_cli.py resolve-db --json [--db PATH]`. See the [CLI contract](red-team-cli-contract-2026-05-16.md) for the full resolver precedence (defaults → env vars → config → `--db` override).

---

## Pre-marker schema (the "current state" snapshot)

Reflects what `red_team_audit.init_red_team_tables()` plus `red_team_human_review.init_table()` produces against an empty SQLite file as of 2026-05-16. The pre-marker shape has **no** `schema_meta` table and **no** `PRAGMA user_version` (i.e. `user_version = 0`).

### Tables

```sql
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
```

### Indexes

```sql
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
```

### Notes on the pre-marker shape

- `red_team_human_review_accepts` is the v2-migrated form: the PK is gone from the `accept_key` column (legacy v1 had `accept_key` as `PRIMARY KEY`, but the live migration adds it via `ALTER TABLE ADD COLUMN` which can't set PK, so the in-the-wild shape has `accept_key TEXT` without `PRIMARY KEY`). The bootstrap step accepts both the freshly-created v2 shape and the migrated v2 shape as "pre-marker valid" because the only practical difference is the PK constraint on a nullable column.
- `red_team_findings` has the post-FU-rt5/rt6/rt7 column set (`stable_key`, `concern_hash`, `risk_key`, `affected_component`, `failure_mode`, the five `*_excerpt_hash` columns, and `retention_mode`).
- `red_team_runs` has the post-v1.2 column set (`repo`, `artifact_relative_path`, `pr_number`, `fix_plan_*` columns).

The bootstrap branch of `ensure-schema` accepts the pre-marker DDL **plus any subset of legacy column orderings** produced by the migration history above. It refuses outright on:

- Application tables present with **extra unknown columns** (operator hand-edits, third-party tools).
- Missing required tables.
- `user_version != 0` without a corresponding `schema_meta` row.

---

## Post-marker schema (Phase 0 frozen DDL)

Adds the singleton marker. Rerunning `migrate --stamp-current` or `ensure-schema` against a post-marker DB is idempotent.

### New table

```sql
CREATE TABLE IF NOT EXISTS schema_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
);
```

### Marker upsert

```sql
INSERT INTO schema_meta (id, version, applied_at)
VALUES (1, ?, ?)
ON CONFLICT(id) DO UPDATE SET
    version = excluded.version,
    applied_at = excluded.applied_at;
```

The `CHECK (id = 1)` enforces the singleton invariant. The upsert is rerun-safe under interruption: a second `migrate --stamp-current` after a crash mid-stamp converges to a single row with the latest `applied_at` timestamp.

### PRAGMA

```sql
PRAGMA user_version = 1;
```

Set in the same transaction as the marker insert. Provides a fast non-table version probe for callers that don't want to query `schema_meta`.

### Post-marker full DDL

The pre-marker DDL above, plus the `schema_meta` table, plus `PRAGMA user_version = 1`. All application tables, columns, and indexes are byte-identical to the pre-marker snapshot — the schema version bump is purely additive.

---

## `ensure-schema` decision table (Phase 0 spec)

| DB file | `user_version` | `schema_meta` row | App tables | Branch | Action |
|---|---|---|---|---|---|
| Absent | n/a | n/a | n/a | 1: missing | Atomic temp-then-rename: create `<db>.creating-<uuid>`, apply post-marker DDL, stamp marker + PRAGMA in one transaction, `fsync`, `os.replace()` to final path. Auto-clean orphan `.creating-*` siblings older than 60s on entry. |
| Present | 0 | absent | none (and no `.creating-*` orphan we just owned) | 2: recovery | Treat as equivalent to "missing": delete and re-run branch 1. Logged to stderr as `recovery_from_empty_db`. |
| Present | 0 | absent | matches pre-marker shape | 3: bootstrap | One-time: compare live DDL against the pre-marker snapshot; on match, create `schema_meta`, `INSERT` the marker, set `PRAGMA user_version = 1`, all in a single transaction. Then re-verify against the post-marker snapshot. Refuse on DDL drift outside the bootstrap-accepted shape. |
| Present | ≥1 | present | matches post-marker shape | 4: verify+refresh | Verify full post-marker DDL match; refresh the singleton via `ON CONFLICT(id) DO UPDATE`. Idempotent. |

### Failure modes (Branch 4 / verify)

- `schema_meta.version != expected_version`: exit non-zero with `{"error":"schema_version_mismatch","expected":N,"actual":M}`.
- Live DDL diverges from the post-marker snapshot: exit non-zero with `{"error":"schema_drift","missing":[...],"unexpected":[...]}`.
- More than one row in `schema_meta` (CHECK constraint violation): exit non-zero with `{"error":"schema_meta_corrupt"}`.

---

## Schema version history

| Version | Date | Change |
|---|---|---|
| 0 (implicit) | pre-2026-05-16 | Pre-marker; legacy `init_*` migration ladder applied implicitly on every open. |
| 1 | 2026-05-16 | Post-marker; `schema_meta` singleton added, `PRAGMA user_version = 1`. No application-table changes vs. v0. |
