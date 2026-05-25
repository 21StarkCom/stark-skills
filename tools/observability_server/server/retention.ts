/**
 * Hourly state-only retention sweep (Phase 4 Task 5).
 *
 * Reads `<spoolRoot>/` and removes SQLite rows for any `runs.run_id`
 * whose spool directory has disappeared. The host-side prune CLI is
 * the only writer that deletes spool dirs (via the `.trash/{run_id}`
 * grace-period move from Phase 7); this sweep is the corresponding
 * database-only cleanup so the index doesn't keep referencing rows
 * the prune CLI took out from under it.
 *
 * `runs.run_id` is the SQL primary key for the whole row tree
 * (subagents, progress_events, event_offsets, chunk_offsets,
 * chunk_truncations, spool_files, synthetic_events). The migration
 * declares every child FK with `ON DELETE CASCADE`, so deleting from
 * `runs` deletes the entire transitive tree atomically.
 */

import fs from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

const DEFAULT_TICK_MS = 60 * 60 * 1000;

export interface RetentionSweepStats {
  ticks: number;
  files_deleted_total: number;
}

export interface RetentionSweepOptions {
  db: Database.Database;
  spoolRoot: string;
  /** Override tick interval (tests). */
  tickMs?: number;
}

export class RetentionSweeper {
  private readonly db: Database.Database;
  private readonly spoolRoot: string;
  private readonly tickMs: number;
  private timer: NodeJS.Timeout | null = null;
  private readonly stats: RetentionSweepStats = {
    ticks: 0,
    files_deleted_total: 0,
  };

  constructor(opts: RetentionSweepOptions) {
    this.db = opts.db;
    this.spoolRoot = opts.spoolRoot;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.runTick();
      } catch (err) {
        process.stderr.write(
          `[retention] tick failed: ${(err as Error).message}\n`,
        );
      }
    }, this.tickMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getStats(): Readonly<RetentionSweepStats> {
    return { ...this.stats };
  }

  runTick(): void {
    this.stats.ticks += 1;
    let onDisk: Set<string>;
    try {
      onDisk = new Set(fs.readdirSync(this.spoolRoot));
    } catch {
      return;
    }
    const rows = this.db
      .prepare(`SELECT run_id FROM runs`)
      .all() as Array<{ run_id: string }>;
    const orphaned: string[] = [];
    for (const r of rows) {
      if (!onDisk.has(r.run_id)) orphaned.push(r.run_id);
    }
    if (orphaned.length === 0) return;
    const del = this.db.prepare(`DELETE FROM runs WHERE run_id = ?`);
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) del.run(id);
    });
    tx(orphaned);
    this.stats.files_deleted_total += orphaned.length;
  }

  /** Test helper — confirm the spool root resolves. */
  spoolPath(): string {
    return path.resolve(this.spoolRoot);
  }
}
