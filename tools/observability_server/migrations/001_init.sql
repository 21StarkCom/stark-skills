-- 001_init.sql — initial SQLite schema for the observability index.
--
-- Schema is the design §6 schema + the universal `event_offsets` and
-- `chunk_truncations` tables, + Phase 1.5 amendments:
--   E10: runs.parent_pid + runs.writer_daemon_pid (populated from
--        run_start / run_heartbeat).
--   E7 / E5: spool_files.rewrite_pending + .rewrite_pending_size_bytes
--        + .rewrite_pending_truncated_json (host-side rewrite gate; see
--        plan §1.5.1 E7).
--   RT2: spool_files.rewrite_txn_id + .rewrite_state + .target_size_bytes
--        + .target_mtime_ns (SQLite-authoritative rewrite txn log; see
--        plan §1.5.2 RT2). The host-side journal proposed in E5 is
--        superseded by these columns + a startup-time recovery sweep.
--   RT3: synthetic_events (sweeper-injected lifecycle close events for
--        runs/subagents that crashed without a JSONL writer).
--
-- Pragmas live OUTSIDE the migration body — the runner sets them on the
-- connection before applying any migration. That keeps this file safe to
-- replay against any connection, and matches `db.ts`'s use of
-- BEGIN/COMMIT to wrap the body.

CREATE TABLE IF NOT EXISTS runs (
  run_id               TEXT PRIMARY KEY,
  dispatcher           TEXT NOT NULL,
  repo                 TEXT,
  branch               TEXT,
  pr_number            INTEGER,
  started_at           TEXT NOT NULL,
  ended_at             TEXT,
  status               TEXT,
  emit_status          TEXT,
  parent_pid           INTEGER,
  writer_daemon_pid    INTEGER,
  host_boot_id         TEXT,
  last_heartbeat_at    TEXT,
  bytes_written        INTEGER NOT NULL DEFAULT 0,
  byte_budget_exceeded INTEGER NOT NULL DEFAULT 0,
  total_subagents      INTEGER NOT NULL DEFAULT 0,
  total_findings       INTEGER NOT NULL DEFAULT 0,
  last_seq             INTEGER NOT NULL DEFAULT 0,
  crashed_reason       TEXT
);

CREATE TABLE IF NOT EXISTS subagents (
  subagent_id     TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  agent           TEXT NOT NULL,
  model           TEXT,
  task            TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT,
  duration_ms     INTEGER,
  stdout_bytes    INTEGER NOT NULL DEFAULT 0,
  stderr_bytes    INTEGER NOT NULL DEFAULT 0,
  last_output_at  TEXT,
  finding_count   INTEGER NOT NULL DEFAULT 0,
  summary_json    TEXT
);

CREATE TABLE IF NOT EXISTS progress_events (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  subagent_id    TEXT REFERENCES subagents(subagent_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS spool_files (
  run_id                         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  rotation_index                 INTEGER NOT NULL,
  file_path                      TEXT NOT NULL,
  first_seq                      INTEGER,
  last_seq                       INTEGER,
  size_bytes                     INTEGER NOT NULL DEFAULT 0,
  mtime_ns                       INTEGER NOT NULL DEFAULT 0,
  last_offset                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                     TEXT,
  -- E7 / E5 host-side rewrite gate:
  rewrite_pending                INTEGER NOT NULL DEFAULT 0,
  rewrite_pending_size_bytes     INTEGER,
  rewrite_pending_truncated_json TEXT,
  -- RT2 SQLite-authoritative rewrite txn log:
  rewrite_txn_id                 TEXT,
  rewrite_state                  TEXT CHECK (
    rewrite_state IS NULL OR
    rewrite_state IN ('idle','pending','renamed','aborted','committed')
  ),
  target_size_bytes              INTEGER,
  target_mtime_ns                INTEGER,
  PRIMARY KEY (run_id, rotation_index)
);

CREATE TABLE IF NOT EXISTS tail_offsets (
  file_path TEXT PRIMARY KEY,
  offset    INTEGER NOT NULL,
  mtime_ns  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_offsets (
  run_id          TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  subagent_id     TEXT NOT NULL REFERENCES subagents(subagent_id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  stream          TEXT NOT NULL,
  rotation_index  INTEGER NOT NULL,
  byte_start      INTEGER NOT NULL,
  byte_end        INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  encoding        TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

-- Universal seek index for WS backfill across every event type.
CREATE TABLE IF NOT EXISTS event_offsets (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  type           TEXT NOT NULL,
  subagent_id    TEXT,
  rotation_index INTEGER NOT NULL,
  byte_start     INTEGER NOT NULL,
  byte_end       INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_event_offsets_subagent
  ON event_offsets (subagent_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_offsets_type
  ON event_offsets (run_id, type, seq);

-- Chunk-truncation audit trail (separate from the surviving chunk index).
CREATE TABLE IF NOT EXISTS chunk_truncations (
  run_id         TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  subagent_id    TEXT NOT NULL REFERENCES subagents(subagent_id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL,
  bytes_dropped  INTEGER NOT NULL,
  stream         TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_chunk_trunc_subagent
  ON chunk_truncations (subagent_id, seq);

-- RT3 synthetic lifecycle events injected by the liveness sweeper. The
-- WS backfill, chunk-replay endpoint, and CSV export all UNION JSONL
-- event_offsets with this table ordered by seq.
CREATE TABLE IF NOT EXISTS synthetic_events (
  run_id        TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  ts            TEXT NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_runs_repo_started ON runs (repo, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status       ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started      ON runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_subagents_run     ON subagents (run_id);
CREATE INDEX IF NOT EXISTS idx_subagents_status  ON subagents (status);
CREATE INDEX IF NOT EXISTS idx_progress_run      ON progress_events (run_id, ts);
CREATE INDEX IF NOT EXISTS idx_progress_subagent ON progress_events (subagent_id, ts);
CREATE INDEX IF NOT EXISTS idx_spool_run         ON spool_files (run_id, rotation_index);
CREATE INDEX IF NOT EXISTS idx_chunk_subagent    ON chunk_offsets (subagent_id, seq);
CREATE INDEX IF NOT EXISTS idx_runs_heartbeat    ON runs (last_heartbeat_at);
-- Speeds up the Phase 1.5 RT2 startup-time recovery sweep:
--   SELECT … FROM spool_files WHERE rewrite_state IN ('pending','renamed');
CREATE INDEX IF NOT EXISTS idx_spool_rewrite_state
  ON spool_files (rewrite_state) WHERE rewrite_state IS NOT NULL;
