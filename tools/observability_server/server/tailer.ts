/**
 * chokidar-driven JSONL spool tailer (plan Phase 3 Task 1).
 *
 * Watches `/spool/runs` (depth 2; matches `<runId>/events-<NNNN>.jsonl`).
 * For each `add` and `change`:
 *
 *   - Honors the `spool_files.rewrite_pending = 1` gate set by the
 *     server's pre-rename handler; skips the file for this pass and
 *     reschedules.
 *   - Detects in-place rewrites via mtime regression or size shrink
 *     against the previously-observed `spool_files` row; on hit, resets
 *     the line buffer + `tail_offsets.offset = 0` and re-reads from
 *     the start. Otherwise seeks to the persisted offset.
 *   - Reads forward in 256-KB chunks, parses every complete line, and
 *     emits a `ParsedEvent` on the bus (with the file's pre-read
 *     mtime_ns so the index writer can detect rewrites coming in
 *     via the same event).
 *   - Persists the new offset via the index writer's `tail_offsets`
 *     upsert (driven by the `byte_end` of every emitted event).
 *
 * A backup 10-second sweeper walks the spool tree directly to catch
 * anything chokidar missed on macOS (FSEvent flake under high churn).
 */

import path from "node:path";
import fs from "node:fs";

import chokidar, { type FSWatcher } from "chokidar";

import type Database from "better-sqlite3";

import type { EventBus } from "./event_bus.ts";
import {
  LineBuffer,
  parseLine,
  rotationIndexFromBasename,
} from "./jsonl_parser.ts";

const READ_BUFFER_BYTES = 256 * 1024;
const BACKUP_SWEEP_MS = 10_000;

type DbHandle = Database.Database;
type DbStatement = Database.Statement<any[], any>;

export interface TailerOptions {
  /** `/spool/runs` inside the container. */
  spoolRoot: string;
  bus: EventBus;
  db: DbHandle;
  /** Test seam — let tests run without spawning the real chokidar. */
  watcherFactory?: (spoolRoot: string) => FSWatcher;
  /** Test seam — disable the backup sweeper for deterministic runs. */
  disableBackupSweep?: boolean;
  /**
   * Test seam — override `fs.readdirSync` for the startup scan + the
   * backup sweeper + `scanNow`. Used by the per-run-ordering test to
   * simulate the OS returning `events-0002.jsonl` before
   * `events-0001.jsonl`, which is the worst-case input that the
   * sorted scan + per-run queue must defend against.
   */
  readdirSync?: (dirPath: string) => string[];
}

interface FileState {
  runId: string;
  rotationIndex: number;
  filePath: string;
  /** mtime_ns from the last seen state on disk; primes rewrite detection. */
  lastMtimeNs: number;
  /** size in bytes from the last seen state on disk; primes rewrite detection. */
  lastSize: number;
  /** Reusable line buffer keyed to the persisted offset. Reset on rewrite. */
  buffer: LineBuffer;
  /** Persisted tail offset (synced from / to `tail_offsets`). */
  persistedOffset: number;
  /** True while a read pass is mid-flight; used to coalesce burst
   * `change` events into a single pass. */
  reading: boolean;
}

export class Tailer {
  private readonly opts: TailerOptions;
  private readonly bus: EventBus;
  private readonly db: DbHandle;
  private watcher: FSWatcher | null = null;
  private files = new Map<string, FileState>();
  private parseErrorsTotal = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * Per-run promise chain. Every chokidar `add`/`change`, every backup
   * sweep dispatch, every `scanNow` invocation, and the startup scan
   * itself enqueue through `enqueueForRun`, which appends onto this
   * map keyed by `runId`. The chain serializes per-run file ingestion
   * in submission order — combined with the sorted enumeration in
   * `walkSpoolSorted`, this guarantees `events-0001.jsonl` lands its
   * `run_start`/`subagent_start` rows BEFORE `events-0002.jsonl`'s
   * `subagent_stdout`/`subagent_progress` rows try to reference them
   * under `PRAGMA foreign_keys = ON`.
   */
  private runQueues = new Map<string, Promise<void>>();
  private readonly stmts: {
    selectSpoolFile: DbStatement;
    selectTailOffset: DbStatement;
  };

  constructor(opts: TailerOptions) {
    this.opts = opts;
    this.bus = opts.bus;
    this.db = opts.db;
    this.stmts = {
      selectSpoolFile: this.db.prepare(
        `SELECT rewrite_pending, size_bytes, mtime_ns
           FROM spool_files
          WHERE run_id = ? AND rotation_index = ?`,
      ),
      selectTailOffset: this.db.prepare(
        `SELECT offset, mtime_ns FROM tail_offsets WHERE file_path = ?`,
      ),
    };
  }

  /** Total malformed JSON lines observed since boot. Surfaced via
   * `/api/health.tailer_parse_errors_total` in Phase 4. */
  getParseErrorsTotal(): number {
    return this.parseErrorsTotal;
  }

  /** Currently-tracked files keyed by absolute file path. Used by the
   * Phase 8 load test + restart-correctness asserts. */
  trackedFiles(): ReadonlyMap<string, Readonly<FileState>> {
    return this.files;
  }

  start(): void {
    if (this.watcher !== null) return;
    const factory =
      this.opts.watcherFactory ??
      ((root: string) =>
        chokidar.watch(root, {
          depth: 2,
          awaitWriteFinish: false,
          persistent: true,
          // Initial enumeration is owned by `runStartupScan` below so we
          // can sort by rotation_index per run. With `ignoreInitial`
          // false, chokidar emitted `add` events for pre-existing files
          // in undefined order, and the resulting interleaving could
          // ingest `events-0002.jsonl` (chunks/progress) before
          // `events-0001.jsonl` (run_start/subagent_start) — under FK
          // enforcement that fails outright, and even with FKs off it
          // silently drops the aggregate-counter increments that the
          // index writer gates on `wasIndexed === false`.
          ignoreInitial: true,
        }));
    this.watcher = factory(this.opts.spoolRoot);
    this.watcher.on("add", (p) => void this.enqueueForRun(p));
    this.watcher.on("change", (p) => void this.enqueueForRun(p));
    this.watcher.on("unlink", (p) => this.handleUnlink(p));
    // Sorted startup scan: walks the spool tree once at boot and feeds
    // every pre-existing spool file into the per-run queue in
    // rotation_index order. Runs synchronously here so any post-start
    // chokidar `add` events for files that arrive AFTER the readdir
    // pass land behind the queued startup items rather than racing
    // them.
    this.runStartupScan();
    if (!this.opts.disableBackupSweep) {
      this.sweepTimer = setInterval(() => this.runBackupSweep(), BACKUP_SWEEP_MS);
      if (typeof this.sweepTimer.unref === "function") {
        this.sweepTimer.unref();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.watcher !== null) {
      try {
        await this.watcher.close();
      } catch {
        // best-effort
      }
      this.watcher = null;
    }
  }

  /**
   * Drive a synchronous filesystem scan on demand. Used by the
   * retention listener's `POST /api/internal/retention/scan-now` route
   * (plan §1.5.1 E7): when a prune CLI's `pre-rename` POST hits a
   * 409 `scan_pending` because the tailer has not yet seen the
   * terminal run's file, the CLI can call scan-now to force ingestion
   * BEFORE retrying pre-rename.
   *
   * Scope:
   *   - `{run_id, rotation_index}` → poke the named spool file only.
   *   - `{run_id}` (no rotation) → walk the run's directory and poke
   *     every spool file inside.
   *   - `{}` → run the full backup-sweep pass (cheap; readdir + stat).
   */
  async scanNow(target?: {
    runId?: string;
    rotationIndex?: number;
  }): Promise<void> {
    if (target?.runId !== undefined) {
      const runDir = path.join(this.opts.spoolRoot, target.runId);
      if (target.rotationIndex !== undefined) {
        const basename = `events-${String(target.rotationIndex).padStart(4, "0")}.jsonl`;
        await this.enqueueForRun(path.join(runDir, basename));
        return;
      }
      const readdir = this.opts.readdirSync ?? fs.readdirSync;
      let entries: string[];
      try {
        entries = readdir(runDir);
      } catch {
        return;
      }
      const sorted = sortedRotations(entries);
      for (const { ent } of sorted) {
        void this.enqueueForRun(path.join(runDir, ent));
      }
      // Wait on the per-run chain tail so the caller observes a
      // settled state. The retention listener's `scan-now` route
      // depends on this so a subsequent `pre-rename` POST sees the
      // freshly-ingested `spool_files` row.
      const tail = this.runQueues.get(target.runId);
      if (tail) await tail;
      return;
    }
    this.runBackupSweep();
    await this.drainQueues();
  }

  /**
   * Wait until every currently-queued per-run task has settled. Used
   * by `scanNow()` and by tests that need a determinstic post-scan
   * checkpoint.
   */
  async drainQueues(): Promise<void> {
    if (this.runQueues.size === 0) return;
    await Promise.all(Array.from(this.runQueues.values()));
  }

  /**
   * Append `filePath` onto its run's serialization chain. Chain entries
   * run strictly in submission order, so combined with the
   * rotation-sorted enumeration in `walkSpoolSorted` (and in the
   * `runId`-scoped `scanNow` arm above), `events-NNNN.jsonl` files for
   * the same run are ingested in NNNN-ascending order — preventing
   * the foreign-key failures + dropped aggregates that came from
   * chokidar's undefined-order initial `add` events and the sweeper's
   * unsorted `readdirSync`-order dispatch.
   *
   * Errors are caught and logged here so a single bad file never
   * poisons the entire chain for that run.
   */
  private enqueueForRun(filePath: string): Promise<void> {
    const parsed = parseSpoolPath(this.opts.spoolRoot, filePath);
    if (!parsed) return Promise.resolve();
    const prev = this.runQueues.get(parsed.runId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.handleAddOrChange(filePath))
      .catch((err) => {
        process.stderr.write(
          `[tailer] handleAddOrChange failed for ${filePath}: ${(err as Error).message}\n`,
        );
      });
    this.runQueues.set(parsed.runId, next);
    return next;
  }

  private runStartupScan(): void {
    this.walkSpoolSorted((filePath) => {
      void this.enqueueForRun(filePath);
    });
  }

  /**
   * Public test seam — exercise a file path directly without going
   * through chokidar. Returns the number of events emitted on the
   * bus for this pass (zero if the file is rewrite-gated or unchanged).
   */
  async pokeForTesting(filePath: string): Promise<number> {
    const before = this.parseErrorsTotal;
    let emittedCount = 0;
    const listener = (): void => {
      emittedCount += 1;
    };
    this.bus.on("event", listener);
    try {
      await this.handleAddOrChange(filePath);
    } finally {
      this.bus.off("event", listener);
    }
    // Lift parse-error increments so callers can verify malformed-line
    // detection by diffing parseErrorsTotal across calls.
    void before;
    return emittedCount;
  }

  private handleUnlink(filePath: string): void {
    const parsed = parseSpoolPath(this.opts.spoolRoot, filePath);
    if (!parsed) return;
    const state = this.files.get(filePath);
    if (state) this.files.delete(filePath);
    this.bus.emit("file_deleted", {
      runId: parsed.runId,
      rotationIndex: parsed.rotationIndex,
      filePath,
    });
  }

  private async handleAddOrChange(filePath: string): Promise<void> {
    const parsed = parseSpoolPath(this.opts.spoolRoot, filePath);
    if (!parsed) return;

    // Rewrite gate (plan §3 Task 4 → tailer enforcement).
    const spoolRow = this.stmts.selectSpoolFile.get(
      parsed.runId,
      parsed.rotationIndex,
    ) as
      | { rewrite_pending: number; size_bytes: number; mtime_ns: number }
      | undefined;
    if (spoolRow?.rewrite_pending === 1) {
      // Gate set by the server's pre-rename handler — skip until
      // update-mtime / abort-rewrite clears the flag.
      return;
    }

    let st: fs.Stats;
    try {
      st = fs.statSync(filePath);
    } catch {
      return;
    }
    if (!st.isFile()) return;

    let state = this.files.get(filePath);
    if (state) {
      if (state.reading) return; // coalesce burst events
    } else {
      state = this.initFileState(parsed.runId, parsed.rotationIndex, filePath);
      this.files.set(filePath, state);
    }
    state.reading = true;
    try {
      const mtimeNs = st.mtimeMs * 1_000_000;
      const size = st.size;

      // First touch — seed offset + last-observed size/mtime from the
      // persisted spool_files / tail_offsets rows BEFORE running the
      // rewrite-detection check. Without this seed `state.lastSize`
      // and `state.lastMtimeNs` are 0 after a server restart and a
      // legitimate in-place rewrite (file shrank / mtime regressed
      // relative to the pre-restart state in spool_files) would be
      // missed — the tailer would resume from the persisted offset
      // and skip the rewritten head of the file.
      if (state.lastMtimeNs === 0) {
        const tail = this.stmts.selectTailOffset.get(filePath) as
          | { offset: number; mtime_ns: number }
          | undefined;
        if (tail && Number.isInteger(tail.offset) && tail.offset > 0) {
          state.persistedOffset = tail.offset;
          state.buffer.reset(state.persistedOffset);
        }
        if (spoolRow) {
          if (
            Number.isFinite(spoolRow.size_bytes) &&
            spoolRow.size_bytes > 0
          ) {
            state.lastSize = spoolRow.size_bytes;
          }
          if (
            Number.isFinite(spoolRow.mtime_ns) &&
            spoolRow.mtime_ns > 0
          ) {
            state.lastMtimeNs = spoolRow.mtime_ns;
          }
        }
      }

      // In-place rewrite detection: mtime regression OR size shrink
      // against the previously-observed state (seeded from spool_files
      // on first touch above, so this fires correctly across server
      // restart, not only across live ticks).
      const isShrink = size < state.lastSize;
      const isMtimeRegression =
        state.lastMtimeNs !== 0 && mtimeNs < state.lastMtimeNs;
      if (isShrink || isMtimeRegression) {
        state.buffer.reset(0);
        state.persistedOffset = 0;
      }

      state.lastMtimeNs = mtimeNs;
      state.lastSize = size;

      if (state.buffer.nextReadOffset >= size) {
        // Nothing new — possible duplicate change event from chokidar.
        // Compare against `nextReadOffset` (not `persistedOffset`) so a
        // mid-line carry that has already consumed all current bytes
        // short-circuits cleanly instead of re-entering readForward.
        return;
      }

      await this.readForward(state, mtimeNs);
    } finally {
      state.reading = false;
    }
  }

  private initFileState(
    runId: string,
    rotationIndex: number,
    filePath: string,
  ): FileState {
    return {
      runId,
      rotationIndex,
      filePath,
      lastMtimeNs: 0,
      lastSize: 0,
      buffer: new LineBuffer(0),
      persistedOffset: 0,
      reading: false,
    };
  }

  private async readForward(state: FileState, mtimeNs: number): Promise<void> {
    let fd: number;
    try {
      fd = fs.openSync(state.filePath, "r");
    } catch {
      return;
    }
    try {
      const buf = Buffer.allocUnsafe(READ_BUFFER_BYTES);
      // Read from the in-memory next-read position, which accounts for
      // any partial trailing line still in the LineBuffer's carry. Using
      // `state.persistedOffset` here would re-read carry bytes from disk
      // and concatenate them with the existing carry, corrupting the
      // next JSONL record. `persistedOffset` is only the restart-safe
      // checkpoint (last complete-line `byteEnd`); the live read cursor
      // belongs to the buffer.
      let pos = state.buffer.nextReadOffset;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, READ_BUFFER_BYTES, pos);
        if (bytesRead === 0) break;
        const text = buf.subarray(0, bytesRead).toString("utf8");
        const lines = state.buffer.push(text);
        for (const raw of lines) {
          const rec = parseLine(raw.line);
          // Advance the in-memory offset on EVERY complete line —
          // good or bad — so a malformed line is not re-read on the
          // next tailer pass / restart. The parse_error event also
          // carries `byteEnd` + `mtimeNs` so the index writer can
          // persist the new tail offset for the file.
          state.persistedOffset = raw.byteEnd;
          if (rec === null) {
            this.parseErrorsTotal += 1;
            this.bus.emit("parse_error", {
              filePath: state.filePath,
              line: 0,
              message: "JSON parse failure or non-object record",
              byteEnd: raw.byteEnd,
              mtimeNs,
            });
            continue;
          }
          this.bus.emit("event", {
            runId: state.runId,
            rotationIndex: state.rotationIndex,
            filePath: state.filePath,
            byteStart: raw.byteStart,
            byteEnd: raw.byteEnd,
            mtimeNs,
            record: rec,
          });
        }
        pos += bytesRead;
        if (bytesRead < READ_BUFFER_BYTES) break;
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }

  private runBackupSweep(): void {
    this.walkSpoolSorted((filePath) => {
      if (!this.files.has(filePath)) {
        void this.enqueueForRun(filePath);
        return;
      }
      // Tracked file — re-stat and dispatch through the change path
      // if size/mtime advanced (chokidar can miss FSEvent updates
      // under burst load on macOS).
      let st: fs.Stats;
      try {
        st = fs.statSync(filePath);
      } catch {
        return;
      }
      const state = this.files.get(filePath)!;
      const mtimeNs = st.mtimeMs * 1_000_000;
      if (st.size > state.lastSize || mtimeNs !== state.lastMtimeNs) {
        void this.enqueueForRun(filePath);
      }
    });
  }

  /**
   * Walk `<spoolRoot>/<runId>/events-NNNN.jsonl` in deterministic
   * order — run dirs sorted lexicographically, files within each run
   * sorted by rotation_index — invoking `cb(filePath)` for every
   * candidate. Both the startup scan and the backup sweeper share this
   * helper so any code path that enumerates the spool tree produces
   * the same ingestion order regardless of the underlying filesystem's
   * `readdir` order. Test-injectable via `opts.readdirSync`.
   */
  private walkSpoolSorted(cb: (filePath: string) => void): void {
    const readdir = this.opts.readdirSync ?? fs.readdirSync;
    let runDirs: string[];
    try {
      runDirs = readdir(this.opts.spoolRoot);
    } catch {
      return;
    }
    runDirs = [...runDirs].sort();
    for (const runId of runDirs) {
      const runDir = path.join(this.opts.spoolRoot, runId);
      let entries: string[];
      try {
        entries = readdir(runDir);
      } catch {
        continue;
      }
      const sorted = sortedRotations(entries);
      for (const { ent } of sorted) {
        cb(path.join(runDir, ent));
      }
    }
  }
}

/**
 * Filter `entries` to spool-file basenames (`events-NNNN.jsonl`) and
 * return them sorted by rotation_index ascending. Non-spool entries
 * (`meta.json`, `.tmp` files from an in-flight prune rewrite, etc.)
 * are dropped — they have no rotation_index and the tailer has nothing
 * to do with them.
 */
function sortedRotations(entries: string[]): Array<{ ent: string; rot: number }> {
  const out: Array<{ ent: string; rot: number }> = [];
  for (const ent of entries) {
    const rot = rotationIndexFromBasename(ent);
    if (rot === null) continue;
    out.push({ ent, rot });
  }
  out.sort((a, b) => a.rot - b.rot);
  return out;
}

/**
 * Pull `<runId, rotationIndex>` out of a path that lives under the
 * spool root. Returns null on anything that doesn't look like a spool
 * file.
 */
export function parseSpoolPath(
  spoolRoot: string,
  filePath: string,
): { runId: string; rotationIndex: number } | null {
  const rel = path.relative(spoolRoot, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return null;
  const runId = parts[0];
  const rotationIndex = rotationIndexFromBasename(parts[1]!);
  if (runId === undefined || runId.length === 0 || rotationIndex === null) {
    return null;
  }
  return { runId, rotationIndex };
}
