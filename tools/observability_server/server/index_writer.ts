/**
 * Subscribes to the event bus and upserts every JSONL event type into
 * SQLite. Implements the two-statement idempotency pattern from plan
 * Phase 3 Task 2:
 *
 *   1. `event_offsets` is upserted on EVERY parse (replay or first
 *      apply) so byte ranges always point at the current physical
 *      location.
 *   2. Aggregate-counter mutations + downstream row upserts run ONLY
 *      when the seq was not previously indexed (`wasIndexed === false`).
 *
 * Special-case `chunk_truncated`: when the indexed row at `(run_id,
 * seq)` is currently `subagent_stdout`/`subagent_stderr`, the writer
 * runs the destructive state transition (insert into
 * `chunk_truncations`, delete from `chunk_offsets`, decrement byte
 * counters). If the indexed row is already `chunk_truncated`, only
 * the offset upsert runs.
 *
 * Writes are batched: up to 50 events or 100 ms per `BEGIN/COMMIT`.
 */

import { EventEmitter } from "node:events";

import type Database from "better-sqlite3";

import type {
  EventBus,
  FileDeleted,
  ParsedEvent,
  ParseError,
  TruncationBroadcast,
} from "./event_bus.ts";

type DbHandle = Database.Database;
type DbStatement = Database.Statement<any[], any>;

const BATCH_MAX_EVENTS = 50;
const BATCH_MAX_MS = 100;

interface BatchedEvent {
  evt: ParsedEvent;
}

interface BatchedDelete {
  del: FileDeleted;
}

interface BatchedParseError {
  perr: ParseError;
}

type BatchedItem = BatchedEvent | BatchedDelete | BatchedParseError;

export interface IndexWriterOptions {
  db: DbHandle;
  bus: EventBus;
  /** Test seam — let tests inject a deterministic clock. */
  now?: () => number;
}

export interface IndexWriterStats {
  events_indexed_total: number;
  events_skipped_replay_total: number;
  chunk_truncated_transitions_total: number;
  batches_flushed_total: number;
}

export class IndexWriter extends EventEmitter {
  private readonly db: DbHandle;
  private readonly bus: EventBus;
  private readonly now: () => number;
  private buffer: BatchedItem[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly stmts: IndexStatements;
  private readonly stats: IndexWriterStats = {
    events_indexed_total: 0,
    events_skipped_replay_total: 0,
    chunk_truncated_transitions_total: 0,
    batches_flushed_total: 0,
  };
  private subscribed = false;

  constructor(opts: IndexWriterOptions) {
    super();
    this.db = opts.db;
    this.bus = opts.bus;
    this.now = opts.now ?? Date.now;
    this.stmts = prepareStatements(this.db);
  }

  start(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    this.bus.on("event", (evt) => this.enqueue({ evt }));
    this.bus.on("file_deleted", (del) => this.enqueue({ del }));
    this.bus.on("parse_error", (perr) => this.enqueue({ perr }));
  }

  /** Force-drain the buffer. Used on shutdown + load tests. */
  flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const items = this.buffer;
    this.buffer = [];
    this.commit(items);
  }

  getStats(): Readonly<IndexWriterStats> {
    return { ...this.stats };
  }

  private enqueue(item: BatchedItem): void {
    this.buffer.push(item);
    if (this.buffer.length >= BATCH_MAX_EVENTS) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, BATCH_MAX_MS);
      if (typeof this.flushTimer.unref === "function") {
        this.flushTimer.unref();
      }
    }
  }

  private commit(items: BatchedItem[]): void {
    // Truncation broadcasts are accumulated inside the SQLite txn and
    // emitted only after a successful COMMIT — emitting mid-txn would
    // let a WS subscriber observe a `chunk_truncated` row that gets
    // rolled back if a later statement in the same batch throws.
    const truncationsToEmit: TruncationBroadcast[] = [];
    const txn = this.db.transaction((batch: BatchedItem[]) => {
      truncationsToEmit.length = 0;
      for (const it of batch) {
        if ("evt" in it) {
          const t = this.applyEvent(it.evt);
          if (t !== null) truncationsToEmit.push(t);
        } else if ("del" in it) {
          this.applyFileDelete(it.del);
        } else {
          this.applyParseError(it.perr);
        }
      }
    });
    try {
      txn(items);
      this.stats.batches_flushed_total += 1;
      for (const t of truncationsToEmit) {
        this.bus.emit("truncation", t);
      }
    } catch (err) {
      // Surface to caller IFF a listener is attached; otherwise log
      // to stderr. Node's EventEmitter crashes the process when an
      // unhandled `error` event fires, which is worse than dropping
      // a single batch.
      if (this.listenerCount("error") > 0) {
        this.emit("error", err);
      } else {
        process.stderr.write(
          `[index_writer] batch commit failed: ${(err as Error).message}\n`,
        );
      }
    }
  }

  private applyFileDelete(del: FileDeleted): void {
    this.stmts.markSpoolDeleted.run(
      new Date(this.now()).toISOString(),
      del.runId,
      del.rotationIndex,
    );
  }

  /**
   * Tail-offset bookkeeping for malformed JSONL lines. The tailer skips
   * the line content but the persisted offset MUST advance past it so a
   * restart/re-read does not re-encounter the same bad line in a loop.
   * Authored here (not in the tailer) so `tail_offsets` keeps a single
   * writer.
   */
  private applyParseError(perr: ParseError): void {
    if (
      typeof perr.byteEnd !== "number" ||
      !Number.isFinite(perr.byteEnd) ||
      perr.byteEnd < 0
    ) {
      return;
    }
    const mtime =
      typeof perr.mtimeNs === "number" && Number.isFinite(perr.mtimeNs)
        ? perr.mtimeNs
        : 0;
    this.stmts.upsertTailOffset.run(perr.filePath, perr.byteEnd, mtime);
  }

  private applyEvent(evt: ParsedEvent): TruncationBroadcast | null {
    const rec = evt.record;
    const seq = numField(rec, "seq");
    const ts = strField(rec, "ts");
    const type = strField(rec, "type");
    if (seq === null || ts === null || type === null) {
      // Schema-invalid but completely consumed by the tailer. Advance
      // tail_offsets past the bad line so a restart does not re-read it
      // forever (mirrors the parse_error path; here the line PARSED as
      // a JSON object but is missing required envelope fields).
      this.applyParseError({
        filePath: evt.filePath,
        line: 0,
        message:
          "JSON object missing required envelope field (seq | ts | type)",
        byteEnd: evt.byteEnd,
        mtimeNs: evt.mtimeNs,
      });
      return null;
    }
    const runId = evt.runId;
    const subId = strField(rec, "subagent_id") ?? null;

    const prevRow = this.stmts.selectEventOffsetByKey.get(runId, seq) as
      | { type: string }
      | undefined;
    const wasIndexed = prevRow !== undefined;
    const prevType = prevRow?.type ?? null;

    if (type === "chunk_truncated") {
      return this.applyChunkTruncated(evt, runId, seq, ts, subId, prevType);
    }

    // FK ordering: `event_offsets.run_id` references `runs(run_id)`
    // (ON DELETE CASCADE). The first event in any run is `run_start`,
    // so its `runs` row MUST be created BEFORE the `event_offsets`
    // upsert under `PRAGMA foreign_keys = ON`. On a replay, the row
    // already exists and `INSERT OR IGNORE` is a no-op.
    if (type === "run_start" && !wasIndexed) {
      this.applyRunStart(evt, runId, ts);
    }

    this.stmts.upsertEventOffset.run(
      runId,
      seq,
      ts,
      type,
      subId,
      evt.rotationIndex,
      evt.byteStart,
      evt.byteEnd,
    );

    // Advance `runs.last_seq` for EVERY valid event (idempotent — the
    // UPDATE clamps with MAX(last_seq, ?)). Restart verification per
    // plan §Phase 3 Task 5 requires `runs.last_seq` to match the final
    // emitted event's seq regardless of type (run_heartbeat, run_end,
    // subagent_progress, subagent_end can each be the last event).
    this.stmts.updateRunLastSeq.run(seq, runId);

    if (wasIndexed) {
      this.stats.events_skipped_replay_total += 1;
    } else {
      this.stats.events_indexed_total += 1;
      switch (type) {
        case "run_start":
          // Applied above to satisfy FK ordering.
          break;
        case "run_heartbeat":
          this.applyRunHeartbeat(evt, runId, ts);
          break;
        case "run_end":
          this.applyRunEnd(evt, runId, ts);
          break;
        case "subagent_start":
          this.applySubagentStart(evt, runId, ts, subId);
          break;
        case "subagent_stdout":
        case "subagent_stderr":
          this.applySubagentChunk(evt, runId, seq, ts, type, subId);
          break;
        case "subagent_progress":
          this.applySubagentProgress(evt, runId, seq, ts, subId);
          break;
        case "subagent_heartbeat":
          this.applySubagentHeartbeat(ts, subId);
          break;
        case "subagent_end":
          this.applySubagentEnd(evt, runId, ts, subId);
          break;
        default:
          break;
      }
    }

    // ALWAYS update tail/spool bookkeeping — even on replay. The
    // persisted offset must reflect the current physical file position
    // so the tailer does not re-read already-indexed lines after a
    // restart or an in-place rewrite (when earlier lines shrank).
    this.upsertSpoolBookkeeping(evt, runId, seq);
    this.stmts.upsertTailOffset.run(evt.filePath, evt.byteEnd, evt.mtimeNs);
    return null;
  }

  private applyChunkTruncated(
    evt: ParsedEvent,
    runId: string,
    seq: number,
    ts: string,
    subId: string | null,
    prevType: string | null,
  ): TruncationBroadcast | null {
    const stream: "stdout" | "stderr" =
      strField(evt.record, "stream") === "stderr" ? "stderr" : "stdout";
    const bytesDropped = numField(evt.record, "bytes_dropped") ?? 0;
    this.stmts.upsertEventOffset.run(
      runId,
      seq,
      ts,
      "chunk_truncated",
      subId,
      evt.rotationIndex,
      evt.byteStart,
      evt.byteEnd,
    );
    // Same rule as the common applyEvent path: advance runs.last_seq
    // for every valid event (MAX-clamped, so idempotent on replay).
    this.stmts.updateRunLastSeq.run(seq, runId);

    const isFirstApply = prevType === null;
    const isReplaceChunk =
      prevType === "subagent_stdout" || prevType === "subagent_stderr";
    const isNoOpReplay = !isFirstApply && !isReplaceChunk;

    let broadcast: TruncationBroadcast | null = null;

    if (isNoOpReplay) {
      this.stats.events_skipped_replay_total += 1;
    } else if (subId !== null) {
      // First-apply-without-prior-chunk = synthetic gap (writer daemon's
      // `emit_chunk_truncated` test-seed op, or any future "standalone
      // gap" producer). The chunk_offsets row never existed at this seq,
      // so the byte-counter decrement that the replace-chunk path runs
      // would push subagents.{stdout|stderr}_bytes below the true
      // emitted total. Detect that case by checking chunk_offsets BEFORE
      // the delete (the delete is then idempotent — no rows match), and
      // skip the decrement when no row existed.
      const hadExistingChunk =
        isReplaceChunk ||
        (isFirstApply &&
          (this.stmts.selectChunkOffsetExists.get(runId, seq) as
            | { one: number }
            | undefined) !== undefined);
      this.stmts.upsertChunkTruncation.run(
        runId,
        subId,
        seq,
        ts,
        bytesDropped,
        stream,
      );
      this.stmts.deleteChunkOffset.run(runId, seq);
      if (hadExistingChunk) {
        const byteCol = stream === "stderr" ? "stderr_bytes" : "stdout_bytes";
        this.stmts.decSubagentBytes[byteCol].run(bytesDropped, subId);
      }
      this.stats.chunk_truncated_transitions_total += 1;
      if (isFirstApply) this.stats.events_indexed_total += 1;
      // Live-stream notify — Phase 4 WS subscribers get the gap in
      // real time without re-reading the JSONL. Only fires on a
      // genuine first-time transition (skipped on no-op replay), so
      // each logical truncation is broadcast at most once.
      broadcast = {
        runId,
        subagentId: subId,
        seq,
        ts,
        stream,
        bytesDropped,
        rotationIndex: evt.rotationIndex,
        byteStart: evt.byteStart,
        byteEnd: evt.byteEnd,
      };
    } else if (isFirstApply) {
      // No subagent_id — record only the offset (defensive). Still
      // counts as an indexed event so bookkeeping advances.
      this.stats.events_indexed_total += 1;
    }

    // ALWAYS update tail/spool bookkeeping — even when the
    // chunk_truncated state-transition is a no-op replay. Otherwise
    // tail_offsets would silently fall behind the file's actual EOF
    // and the tailer would re-read the same line every pass.
    this.upsertSpoolBookkeeping(evt, runId, seq);
    this.stmts.upsertTailOffset.run(evt.filePath, evt.byteEnd, evt.mtimeNs);
    return broadcast;
  }

  private applyRunStart(evt: ParsedEvent, runId: string, ts: string): void {
    const rec = evt.record;
    const meta = metaField(rec) ?? {};
    const dispatcher =
      strField(meta, "dispatcher") ??
      strField(rec, "dispatcher") ??
      "unknown";
    const repo = strField(meta, "repo") ?? null;
    const branch = strField(meta, "branch") ?? null;
    const prNumber = numField(meta, "pr_number") ?? null;
    const trackedParentPid = numField(rec, "tracked_parent_pid") ?? null;
    const writerDaemonPid = numField(rec, "writer_daemon_pid") ?? null;
    const hostBootId = strField(rec, "host_boot_id") ?? null;
    this.stmts.insertRun.run(
      runId,
      dispatcher,
      repo,
      branch,
      prNumber,
      ts,
      trackedParentPid,
      writerDaemonPid,
      hostBootId,
    );
  }

  private applyRunHeartbeat(
    evt: ParsedEvent,
    runId: string,
    ts: string,
  ): void {
    const rec = evt.record;
    const bytesWritten = numField(rec, "bytes_written") ?? 0;
    const parentPid = numField(rec, "parent_pid") ?? null;
    const writerDaemonPid = numField(rec, "writer_daemon_pid") ?? null;
    const hostBootId = strField(rec, "host_boot_id") ?? null;
    this.stmts.updateRunHeartbeat.run(
      ts,
      bytesWritten,
      parentPid,
      writerDaemonPid,
      hostBootId,
      runId,
    );
  }

  private applyRunEnd(evt: ParsedEvent, runId: string, ts: string): void {
    const rec = evt.record;
    const status = strField(rec, "status") ?? "ok";
    const crashedReason = strField(rec, "crashed_reason") ?? null;
    this.stmts.updateRunEnd.run(ts, status, crashedReason, runId);
  }

  private applySubagentStart(
    evt: ParsedEvent,
    runId: string,
    ts: string,
    subId: string | null,
  ): void {
    if (subId === null) return;
    const rec = evt.record;
    const agent = strField(rec, "agent") ?? "unknown";
    const model = strField(rec, "model") ?? null;
    const task = strField(rec, "task") ?? "";
    this.stmts.insertSubagent.run(subId, runId, agent, model, task, ts);
    this.stmts.incRunTotalSubagents.run(runId);
  }

  private applySubagentChunk(
    evt: ParsedEvent,
    runId: string,
    seq: number,
    ts: string,
    type: "subagent_stdout" | "subagent_stderr",
    subId: string | null,
  ): void {
    if (subId === null) return;
    const stream = type === "subagent_stderr" ? "stderr" : "stdout";
    const encoding = strField(evt.record, "encoding") ?? "utf8";
    const chunkVal = evt.record.chunk;
    const chunkBytes =
      typeof chunkVal === "string"
        ? encoding === "base64"
          ? base64DecodedByteLen(chunkVal)
          : Buffer.byteLength(chunkVal, "utf8")
        : 0;
    this.stmts.upsertChunkOffset.run(
      runId,
      subId,
      seq,
      stream,
      evt.rotationIndex,
      evt.byteStart,
      evt.byteEnd,
      ts,
      encoding,
    );
    const byteCol = stream === "stderr" ? "stderr_bytes" : "stdout_bytes";
    this.stmts.incSubagentBytes[byteCol].run(chunkBytes, ts, subId);
    // `runs.last_seq` is advanced by the common applyEvent path on
    // every valid event; no per-type update needed here.
  }

  private applySubagentProgress(
    evt: ParsedEvent,
    runId: string,
    seq: number,
    ts: string,
    subId: string | null,
  ): void {
    const rec = evt.record;
    const kind = strField(rec, "kind") ?? "";
    const payload = rec.payload ?? null;
    const payloadJson = JSON.stringify(payload ?? null);
    this.stmts.insertProgress.run(runId, subId, seq, ts, kind, payloadJson);
    if (kind === "finding" && subId !== null) {
      this.stmts.incSubagentFindings.run(subId);
      this.stmts.incRunFindings.run(runId);
    }
  }

  private applySubagentHeartbeat(ts: string, subId: string | null): void {
    if (subId === null) return;
    this.stmts.updateSubagentHeartbeat.run(ts, subId);
  }

  private applySubagentEnd(
    evt: ParsedEvent,
    _runId: string,
    ts: string,
    subId: string | null,
  ): void {
    if (subId === null) return;
    const rec = evt.record;
    const status = strField(rec, "status") ?? "ok";
    const durationMs = numField(rec, "duration_ms") ?? null;
    const summary = rec.summary ?? null;
    const summaryJson = JSON.stringify(summary ?? null);
    this.stmts.updateSubagentEnd.run(
      status,
      durationMs,
      summaryJson,
      ts,
      subId,
    );
  }

  private upsertSpoolBookkeeping(
    evt: ParsedEvent,
    runId: string,
    seq: number,
  ): void {
    this.stmts.upsertSpoolFile.run(
      runId,
      evt.rotationIndex,
      evt.filePath,
      seq,
      seq,
      evt.byteEnd,
      evt.mtimeNs,
      evt.byteEnd,
    );
  }
}

// --- prepared-statement bundle -------------------------------------

interface IndexStatements {
  selectEventOffsetByKey: DbStatement;
  upsertEventOffset: DbStatement;
  upsertChunkOffset: DbStatement;
  upsertChunkTruncation: DbStatement;
  deleteChunkOffset: DbStatement;
  selectChunkOffsetExists: DbStatement;
  insertRun: DbStatement;
  updateRunHeartbeat: DbStatement;
  updateRunEnd: DbStatement;
  updateRunLastSeq: DbStatement;
  incRunTotalSubagents: DbStatement;
  incRunFindings: DbStatement;
  insertSubagent: DbStatement;
  updateSubagentHeartbeat: DbStatement;
  updateSubagentEnd: DbStatement;
  incSubagentBytes: {
    stdout_bytes: DbStatement;
    stderr_bytes: DbStatement;
  };
  decSubagentBytes: {
    stdout_bytes: DbStatement;
    stderr_bytes: DbStatement;
  };
  incSubagentFindings: DbStatement;
  insertProgress: DbStatement;
  upsertSpoolFile: DbStatement;
  markSpoolDeleted: DbStatement;
  upsertTailOffset: DbStatement;
}

function prepareStatements(db: DbHandle): IndexStatements {
  return {
    selectEventOffsetByKey: db.prepare(
      `SELECT type FROM event_offsets WHERE run_id = ? AND seq = ?`,
    ),
    upsertEventOffset: db.prepare(
      `INSERT INTO event_offsets
         (run_id, seq, ts, type, subagent_id, rotation_index, byte_start, byte_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, seq) DO UPDATE SET
         ts = excluded.ts,
         type = excluded.type,
         subagent_id = excluded.subagent_id,
         rotation_index = excluded.rotation_index,
         byte_start = excluded.byte_start,
         byte_end = excluded.byte_end`,
    ),
    upsertChunkOffset: db.prepare(
      `INSERT OR REPLACE INTO chunk_offsets
         (run_id, subagent_id, seq, stream, rotation_index, byte_start, byte_end, ts, encoding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    upsertChunkTruncation: db.prepare(
      `INSERT OR REPLACE INTO chunk_truncations
         (run_id, subagent_id, seq, ts, bytes_dropped, stream)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    deleteChunkOffset: db.prepare(
      `DELETE FROM chunk_offsets WHERE run_id = ? AND seq = ?`,
    ),
    selectChunkOffsetExists: db.prepare(
      `SELECT 1 AS one FROM chunk_offsets WHERE run_id = ? AND seq = ? LIMIT 1`,
    ),
    insertRun: db.prepare(
      `INSERT OR IGNORE INTO runs
         (run_id, dispatcher, repo, branch, pr_number, started_at, status,
          parent_pid, writer_daemon_pid, host_boot_id, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, NULL)`,
    ),
    updateRunHeartbeat: db.prepare(
      `UPDATE runs
          SET last_heartbeat_at = ?,
              bytes_written = ?,
              parent_pid = COALESCE(?, parent_pid),
              writer_daemon_pid = COALESCE(?, writer_daemon_pid),
              host_boot_id = COALESCE(?, host_boot_id)
        WHERE run_id = ?`,
    ),
    updateRunEnd: db.prepare(
      `UPDATE runs
          SET ended_at = ?,
              status = ?,
              crashed_reason = COALESCE(?, crashed_reason)
        WHERE run_id = ?`,
    ),
    updateRunLastSeq: db.prepare(
      `UPDATE runs SET last_seq = MAX(last_seq, ?) WHERE run_id = ?`,
    ),
    incRunTotalSubagents: db.prepare(
      `UPDATE runs SET total_subagents = total_subagents + 1 WHERE run_id = ?`,
    ),
    incRunFindings: db.prepare(
      `UPDATE runs SET total_findings = total_findings + 1 WHERE run_id = ?`,
    ),
    insertSubagent: db.prepare(
      `INSERT OR IGNORE INTO subagents
         (subagent_id, run_id, agent, model, task, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'running')`,
    ),
    updateSubagentHeartbeat: db.prepare(
      `UPDATE subagents SET last_output_at = ? WHERE subagent_id = ?`,
    ),
    updateSubagentEnd: db.prepare(
      `UPDATE subagents
          SET status = ?,
              duration_ms = ?,
              summary_json = ?,
              ended_at = ?
        WHERE subagent_id = ?`,
    ),
    incSubagentBytes: {
      stdout_bytes: db.prepare(
        `UPDATE subagents
            SET stdout_bytes = stdout_bytes + ?,
                last_output_at = ?
          WHERE subagent_id = ?`,
      ),
      stderr_bytes: db.prepare(
        `UPDATE subagents
            SET stderr_bytes = stderr_bytes + ?,
                last_output_at = ?
          WHERE subagent_id = ?`,
      ),
    },
    decSubagentBytes: {
      stdout_bytes: db.prepare(
        `UPDATE subagents
            SET stdout_bytes = MAX(0, stdout_bytes - ?)
          WHERE subagent_id = ?`,
      ),
      stderr_bytes: db.prepare(
        `UPDATE subagents
            SET stderr_bytes = MAX(0, stderr_bytes - ?)
          WHERE subagent_id = ?`,
      ),
    },
    incSubagentFindings: db.prepare(
      `UPDATE subagents SET finding_count = finding_count + 1 WHERE subagent_id = ?`,
    ),
    insertProgress: db.prepare(
      `INSERT OR IGNORE INTO progress_events
         (run_id, subagent_id, seq, ts, kind, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    upsertSpoolFile: db.prepare(
      `INSERT INTO spool_files
         (run_id, rotation_index, file_path, first_seq, last_seq,
          size_bytes, mtime_ns, last_offset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, rotation_index) DO UPDATE SET
         file_path  = excluded.file_path,
         last_seq   = MAX(spool_files.last_seq, excluded.last_seq),
         first_seq  = MIN(COALESCE(spool_files.first_seq, excluded.first_seq), excluded.first_seq),
         size_bytes = MAX(spool_files.size_bytes, excluded.size_bytes),
         mtime_ns   = excluded.mtime_ns,
         last_offset = MAX(spool_files.last_offset, excluded.last_offset),
         deleted_at = NULL`,
    ),
    markSpoolDeleted: db.prepare(
      `UPDATE spool_files SET deleted_at = ?
         WHERE run_id = ? AND rotation_index = ?`,
    ),
    upsertTailOffset: db.prepare(
      // No MAX() on offset: the persisted offset must mirror the
      // tailer's current physical position, which can move BACKWARD
      // when a Phase 7 in-place rewrite shrinks the file (the
      // update-mtime handler resets it to 0; subsequent events advance
      // it from the rewritten file's actual byte ranges).
      `INSERT INTO tail_offsets (file_path, offset, mtime_ns)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         offset = excluded.offset,
         mtime_ns = excluded.mtime_ns`,
    ),
  };
}

// --- record-field helpers ------------------------------------------

function strField(rec: Record<string, unknown>, key: string): string | null {
  const v = rec[key];
  return typeof v === "string" ? v : null;
}

function numField(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function metaField(rec: Record<string, unknown>): Record<string, unknown> | null {
  const v = rec.meta;
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * Estimate the decoded byte length of a base64 string without
 * actually decoding it. The decoded length is `floor(len * 3 / 4)`
 * minus the number of `=` padding chars at the end. Cheap, exact for
 * well-formed base64.
 */
function base64DecodedByteLen(s: string): number {
  let pad = 0;
  if (s.endsWith("==")) pad = 2;
  else if (s.endsWith("=")) pad = 1;
  return Math.floor((s.length * 3) / 4) - pad;
}
