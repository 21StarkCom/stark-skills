/**
 * Liveness sweeper (Phase 4 Task 4).
 *
 * 30-second tick. Source of truth for host facts is
 * `/hostinfo/host.json` — no `/proc` mount inside the container.
 * Every UPDATE that writes `ended_at` binds a TypeScript-computed
 * ISO-8601 millisecond timestamp via parameter; never any SQLite-
 * native clock function. WHERE-clause cutoffs are also TS-bound so the
 * lexicographic compare lines up with the canonical
 * `YYYY-MM-DDTHH:MM:SS.sssZ` stored shape.
 *
 * Transitions are idempotent: `WHERE status NOT IN
 * ('crashed','ok','error','timeout')` guarantees one writer per row
 * per failure mode. The daemon's own parent-loss path (Phase 2 Task 3)
 * uses the same filter from the other side — whichever writer gets
 * there first wins.
 *
 * RT3: each crashed transition INSERTs a synthetic `run_end` + per-
 * subagent `subagent_end` row into `synthetic_events`, with `seq =
 * MAX(seq across event_offsets AND synthetic_events) + 1` so the
 * per-run monotonic series stays gap-free for WS backfill.
 */

import fs from "node:fs";

import type Database from "better-sqlite3";

import type { AuditWriter } from "./audit.ts";
import type { EventBus, ParsedEvent } from "./event_bus.ts";

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_ORPHAN_TICK_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = ["crashed", "ok", "error", "timeout"] as const;
const HEARTBEAT_STALE_MS = 60_000;
const ORPHAN_STALE_MS = 30 * 60_000;
const HOSTINFO_STALE_MS = 60_000;
const SLEEP_GUARD_MS = 60_000;
// Daemon readiness grace per plan §1.5.1 E10: a freshly indexed run
// that has not yet emitted its first run_heartbeat must not be flagged
// crashed until it is older than this window. Otherwise a tick whose
// hostinfo is stale w.r.t. live_pids[] would mark legitimately-starting
// runs crashed on their very first poll.
const READINESS_GRACE_MS = 30_000;

export type CrashedReason =
  | "host_boot_changed"
  | "parent_exit"
  | "orphan_timeout"
  | "daemon_lost"
  | "crashed_before_heartbeat";

export interface LivenessOptions {
  db: Database.Database;
  hostInfoPath: string;
  /** Audit writer (Phase 4 Task 7). */
  audit?: AuditWriter;
  /** Optional event bus for live WS broadcasts of synthetic events. */
  bus?: EventBus;
  /** Test seam — let tests inject a deterministic clock. */
  now?: () => number;
  /** Override the 30 s tick (tests). */
  tickMs?: number;
  /** Override the 5 min orphan tick (tests). */
  orphanTickMs?: number;
}

export interface HostInfo {
  host_boot_id: string;
  boot_time_seconds: number;
  uptime_seconds: number;
  /** Set of live PIDs at last ticker write. */
  live_pids: number[];
  free_disk_bytes: number;
  /**
   * Canonical ms-precision ISO string from `tools/observability_hostinfo.ts`.
   * Production ticker emits this field. Older test fixtures may emit `ts`
   * or `ts_ms` instead; `loadHostInfo()` accepts any of the three.
   */
  wall_clock?: string;
  /** Legacy ms-precision ISO string (test-only). */
  ts?: string;
  /** Optional Unix-epoch milliseconds (test-only). */
  ts_ms?: number;
}

export interface SweepStats {
  ticks: number;
  crashed_host_boot_changed: number;
  crashed_parent_exit: number;
  crashed_orphan_timeout: number;
  crashed_daemon_lost: number;
  crashed_before_heartbeat: number;
  hostinfo_stale_ticks: number;
  skipped_sleep_ticks: number;
}

interface RunPidRow {
  run_id: string;
  parent_pid: number | null;
  writer_daemon_pid: number | null;
  host_boot_id: string | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
}

export class LivenessSweeper {
  private readonly db: Database.Database;
  private readonly hostInfoPath: string;
  private readonly audit?: AuditWriter;
  private readonly bus?: EventBus;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly orphanTickMs: number;
  private mainTimer: NodeJS.Timeout | null = null;
  private orphanTimer: NodeJS.Timeout | null = null;
  private lastHostInfo: HostInfo | null = null;
  private lastHostInfoReadAtMs: number = 0;
  private readonly stats: SweepStats = {
    ticks: 0,
    crashed_host_boot_changed: 0,
    crashed_parent_exit: 0,
    crashed_orphan_timeout: 0,
    crashed_daemon_lost: 0,
    crashed_before_heartbeat: 0,
    hostinfo_stale_ticks: 0,
    skipped_sleep_ticks: 0,
  };

  constructor(opts: LivenessOptions) {
    this.db = opts.db;
    this.hostInfoPath = opts.hostInfoPath;
    this.audit = opts.audit;
    this.bus = opts.bus;
    this.now = opts.now ?? Date.now;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.orphanTickMs = opts.orphanTickMs ?? DEFAULT_ORPHAN_TICK_MS;
  }

  start(): void {
    if (this.mainTimer !== null) return;
    this.mainTimer = setInterval(() => {
      try {
        this.runMainTick();
      } catch (err) {
        process.stderr.write(
          `[liveness] main tick failed: ${(err as Error).message}\n`,
        );
      }
    }, this.tickMs);
    if (typeof this.mainTimer.unref === "function") this.mainTimer.unref();

    this.orphanTimer = setInterval(() => {
      try {
        this.runOrphanTick();
      } catch (err) {
        process.stderr.write(
          `[liveness] orphan tick failed: ${(err as Error).message}\n`,
        );
      }
    }, this.orphanTickMs);
    if (typeof this.orphanTimer.unref === "function") this.orphanTimer.unref();
  }

  stop(): void {
    if (this.mainTimer !== null) {
      clearInterval(this.mainTimer);
      this.mainTimer = null;
    }
    if (this.orphanTimer !== null) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = null;
    }
  }

  getStats(): Readonly<SweepStats> {
    return { ...this.stats };
  }

  /** Read the latest hostinfo snapshot. Exposed for `/api/health`. */
  readHostInfo(): HostInfo | null {
    return this.lastHostInfo;
  }

  /** Public entry for tests — runs the main 30 s tick once. */
  runMainTick(): void {
    this.stats.ticks += 1;
    const hi = this.loadHostInfo();
    if (hi === null) {
      this.stats.hostinfo_stale_ticks += 1;
      return;
    }
    // Laptop-sleep guard: if host uptime advanced less than wall-clock,
    // the process was suspended; skip transitions this tick to avoid
    // false-positive crashed marks against parents that genuinely
    // outlived the sleep.
    const prev = this.lastHostInfo;
    if (prev !== null) {
      const wallDelta = (this.now() - this.lastHostInfoReadAtMs) / 1000;
      const uptimeDelta = hi.uptime_seconds - prev.uptime_seconds;
      if (
        wallDelta >= SLEEP_GUARD_MS / 1000 &&
        uptimeDelta < wallDelta - SLEEP_GUARD_MS / 1000
      ) {
        this.stats.skipped_sleep_ticks += 1;
        this.lastHostInfo = hi;
        this.lastHostInfoReadAtMs = this.now();
        return;
      }
    }
    this.lastHostInfo = hi;
    this.lastHostInfoReadAtMs = this.now();

    // Step 2: host_boot_id mismatch across server-restart-safe.
    this.transitionHostBootChanged(hi);

    // Step 4 + 6: parent_pid loss + daemon-loss in one read of runs.
    this.transitionParentLost(hi);
  }

  runOrphanTick(): void {
    const cutoff = new Date(this.now() - ORPHAN_STALE_MS).toISOString();
    const rows = this.db
      .prepare(
        `SELECT run_id, parent_pid, writer_daemon_pid, host_boot_id,
                last_heartbeat_at, started_at
           FROM runs
          WHERE status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
            AND (
              (last_heartbeat_at IS NULL AND started_at < ?)
              OR last_heartbeat_at < ?
            )`,
      )
      .all(...TERMINAL_STATUSES, cutoff, cutoff) as RunPidRow[];
    for (const row of rows) {
      this.crashRun(row.run_id, "orphan_timeout");
      this.stats.crashed_orphan_timeout += 1;
    }
  }

  private transitionHostBootChanged(hi: HostInfo): void {
    const rows = this.db
      .prepare(
        `SELECT run_id, parent_pid, writer_daemon_pid, host_boot_id,
                last_heartbeat_at, started_at
           FROM runs
          WHERE status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
            AND host_boot_id IS NOT NULL
            AND host_boot_id != ?`,
      )
      .all(...TERMINAL_STATUSES, hi.host_boot_id) as RunPidRow[];
    for (const row of rows) {
      this.crashRun(row.run_id, "host_boot_changed");
      this.stats.crashed_host_boot_changed += 1;
    }
  }

  private transitionParentLost(hi: HostInfo): void {
    const heartbeatCutoff = new Date(
      this.now() - HEARTBEAT_STALE_MS,
    ).toISOString();
    const readinessCutoff = new Date(
      this.now() - READINESS_GRACE_MS,
    ).toISOString();
    const livePids = new Set(hi.live_pids);
    // Per plan §1.5.1 E10: NULL last_heartbeat_at must not be treated
    // as stale until the run is older than the 30 s readiness grace.
    // The query gates the IS NULL branch on `started_at < readiness
    // cutoff`; the stale-heartbeat branch keeps its 60 s window.
    const rows = this.db
      .prepare(
        `SELECT run_id, parent_pid, writer_daemon_pid, host_boot_id,
                last_heartbeat_at, started_at
           FROM runs
          WHERE status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
            AND (
              (last_heartbeat_at IS NULL AND started_at < ?)
              OR last_heartbeat_at < ?
            )`,
      )
      .all(
        ...TERMINAL_STATUSES,
        readinessCutoff,
        heartbeatCutoff,
      ) as RunPidRow[];
    for (const row of rows) {
      const parentAlive =
        row.parent_pid !== null && livePids.has(row.parent_pid);
      const daemonAlive =
        row.writer_daemon_pid !== null && livePids.has(row.writer_daemon_pid);
      // A run that is past the 30 s readiness grace with no heartbeat
      // yet is a crashed-before-heartbeat case. By plan §1.5.1 E10 the
      // daemon's readiness handshake fsyncs an initial run_heartbeat
      // before startRun returns; if SQLite still sees NULL past the
      // grace, the daemon never reached that fsync.
      if (row.last_heartbeat_at === null) {
        this.crashRun(row.run_id, "crashed_before_heartbeat");
        this.stats.crashed_before_heartbeat += 1;
        continue;
      }
      if (!parentAlive && row.parent_pid !== null) {
        this.crashRun(row.run_id, "parent_exit");
        this.stats.crashed_parent_exit += 1;
        continue;
      }
      if (
        !daemonAlive &&
        row.writer_daemon_pid !== null &&
        row.parent_pid !== null
      ) {
        this.crashRun(row.run_id, "daemon_lost");
        this.stats.crashed_daemon_lost += 1;
      }
    }
  }

  private crashRun(runId: string, reason: CrashedReason): void {
    const endedAt = new Date(this.now()).toISOString();
    const placeholders = TERMINAL_STATUSES.map(() => "?").join(",");
    const updRuns = this.db.prepare(
      `UPDATE runs
          SET status = 'crashed',
              crashed_reason = ?,
              ended_at = ?
        WHERE run_id = ?
          AND status NOT IN (${placeholders})`,
    );
    const updSubs = this.db.prepare(
      `UPDATE subagents
          SET status = 'crashed',
              ended_at = ?
        WHERE run_id = ?
          AND status NOT IN (${placeholders})`,
    );
    const selectOpenSubs = this.db.prepare(
      `SELECT subagent_id FROM subagents
        WHERE run_id = ?
          AND status NOT IN (${placeholders})`,
    );
    const selectMaxSeq = this.db.prepare(
      `SELECT MAX(seq) AS m FROM (
         SELECT seq FROM event_offsets WHERE run_id = ?
         UNION ALL
         SELECT seq FROM synthetic_events WHERE run_id = ?
       )`,
    );
    const insertSynth = this.db.prepare(
      `INSERT INTO synthetic_events (run_id, seq, ts, type, payload_json)
       VALUES (?, ?, ?, ?, ?)`,
    );

    const txn = this.db.transaction(() => {
      const openSubs = selectOpenSubs.all(runId, ...TERMINAL_STATUSES) as Array<{
        subagent_id: string;
      }>;
      const r = updRuns.run(reason, endedAt, runId, ...TERMINAL_STATUSES);
      if ((r.changes as number) === 0) {
        // Another writer (the daemon) beat us to it — fully idempotent
        // no-op. Skip synthetic emission so we don't double-write the
        // lifecycle close.
        return { applied: false, synthesized: [] as ParsedEvent[] };
      }
      updSubs.run(endedAt, runId, ...TERMINAL_STATUSES);
      let nextSeq = ((selectMaxSeq.get(runId, runId) as { m: number | null })
        .m ?? 0) + 1;
      const synthesized: ParsedEvent[] = [];
      for (const s of openSubs) {
        const payload = {
          seq: nextSeq,
          ts: endedAt,
          type: "subagent_end",
          run_id: runId,
          subagent_id: s.subagent_id,
          status: "crashed",
          synthetic: true,
        };
        insertSynth.run(
          runId,
          nextSeq,
          endedAt,
          "subagent_end",
          JSON.stringify(payload),
        );
        synthesized.push(buildSynthEvent(runId, payload, nextSeq, endedAt));
        nextSeq += 1;
      }
      const runEndPayload = {
        seq: nextSeq,
        ts: endedAt,
        type: "run_end",
        run_id: runId,
        status: "crashed",
        crashed_reason: reason,
        synthetic: true,
      };
      insertSynth.run(
        runId,
        nextSeq,
        endedAt,
        "run_end",
        JSON.stringify(runEndPayload),
      );
      synthesized.push(buildSynthEvent(runId, runEndPayload, nextSeq, endedAt));
      return { applied: true, synthesized };
    });
    const result = txn();
    if (result.applied) {
      if (this.bus !== undefined) {
        for (const evt of result.synthesized) this.bus.emit("event", evt);
      }
      if (this.audit !== undefined) {
        this.audit.record("liveness.crashed", "success", {
          run_id: runId,
          reason_code: reason,
        });
      }
    }
  }

  private loadHostInfo(): HostInfo | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.hostInfoPath, "utf8");
    } catch {
      return null;
    }
    let parsed: HostInfo;
    try {
      parsed = JSON.parse(raw) as HostInfo;
    } catch {
      return null;
    }
    // Reject stale snapshots: the ticker promises 5 s freshness, and
    // the sweeper requires < 60 s old per plan §Phase 4 Task 4.
    // Accept the canonical `wall_clock` field emitted by
    // `tools/observability_hostinfo.ts`, plus the older `ts`/`ts_ms`
    // shapes still used by some unit-test fixtures.
    if (parsed.ts_ms !== undefined) {
      if (this.now() - parsed.ts_ms > HOSTINFO_STALE_MS) return null;
    } else {
      const isoStr = parsed.wall_clock ?? parsed.ts;
      if (typeof isoStr !== "string" || isoStr.length === 0) return null;
      const t = Date.parse(isoStr);
      if (!Number.isFinite(t) || this.now() - t > HOSTINFO_STALE_MS) {
        return null;
      }
    }
    return parsed;
  }
}

function buildSynthEvent(
  runId: string,
  payload: Record<string, unknown>,
  seq: number,
  ts: string,
): ParsedEvent {
  return {
    runId,
    rotationIndex: 0,
    filePath: `<synthetic>:${runId}:${seq}`,
    byteStart: 0,
    byteEnd: 0,
    mtimeNs: 0,
    record: { ...payload, seq, ts },
  };
}
