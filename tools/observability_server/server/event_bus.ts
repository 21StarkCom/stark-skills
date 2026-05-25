/**
 * Typed event bus used by the tailer → index writer → WebSocket hub
 * (Phase 4) pipeline.
 *
 * The bus is intentionally tiny — a thin `EventEmitter` wrapper that
 * narrows the listener signatures so a missed event subscription is a
 * compile-time error rather than a silent runtime drop.
 *
 * Events:
 *
 *   - `event`     a parsed JSONL record from a spool file, with its
 *                 byte range (used by the index writer to upsert
 *                 `event_offsets`, and by the WS hub to backfill).
 *   - `parse_error` a malformed JSONL line (counter + health surface).
 *   - `file_deleted` a spool file disappeared from disk (chokidar
 *                    `unlink`). Index writer marks `spool_files.deleted_at`.
 *
 * The bus does NOT enforce ordering across files — the tailer feeds
 * events in spool order per file, and the index writer relies on
 * `(run_id, seq)` to serialize.
 */

import { EventEmitter } from "node:events";

export interface ParsedEvent {
  runId: string;
  /** rotation index of the source file (`events-NNNN.jsonl` → N). */
  rotationIndex: number;
  /** Absolute container-side path of the source file. */
  filePath: string;
  /** Byte offset of the first byte of the JSON record in the file. */
  byteStart: number;
  /** Byte offset of the trailing newline + 1 (= next read offset). */
  byteEnd: number;
  /** mtime_ns of the source file at the time of read. */
  mtimeNs: number;
  /** The parsed JSON object — never mutated by consumers. */
  record: Record<string, unknown>;
}

export interface ParseError {
  filePath: string;
  /** 0-indexed line offset within the file's current read window. */
  line: number;
  message: string;
  /**
   * Absolute file offset just past the trailing newline of the
   * malformed line. The index writer uses this to advance
   * `tail_offsets.offset` so a bad complete line is not re-read on
   * every subsequent pass / restart (parse-storm prevention).
   */
  byteEnd: number;
  /** mtime_ns at the time the line was read. */
  mtimeNs: number;
}

export interface FileDeleted {
  runId: string;
  rotationIndex: number;
  filePath: string;
}

/**
 * Broadcast fired by the index writer the FIRST time a `chunk_truncated`
 * record at `(run_id, seq)` is durably committed (initial application or
 * the in-place stdout/stderr → truncated state transition). Phase 4's
 * WebSocket hub subscribes to this so live subscribers see retention
 * gaps in real time without re-reading the JSONL from disk.
 *
 * No-op replays (the row was already `chunk_truncated`) do NOT fire
 * this event — the broadcast is at-most-once per logical seq.
 */
export interface TruncationBroadcast {
  runId: string;
  subagentId: string;
  seq: number;
  ts: string;
  stream: "stdout" | "stderr";
  bytesDropped: number;
  rotationIndex: number;
  byteStart: number;
  byteEnd: number;
}

type EventMap = {
  event: [ParsedEvent];
  parse_error: [ParseError];
  file_deleted: [FileDeleted];
  truncation: [TruncationBroadcast];
};

export class EventBus extends EventEmitter<EventMap> {
  constructor() {
    super({ captureRejections: true });
    this.setMaxListeners(32);
  }
}
