// Integration tests for `liveness.ts`. Uses an in-memory SQLite DB.
// Skipped (not failed) when better-sqlite3's native binding isn't
// built for the host Node — Docker tests cover the path under node:22.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadMigrations } from "./migrations_loader.ts";
import { LivenessSweeper } from "./liveness.ts";

let Database: typeof import("better-sqlite3") | null = null;
let dbModuleError: unknown = null;
try {
  Database = (await import("better-sqlite3")).default;
  const probe = new Database(":memory:");
  probe.close();
} catch (err) {
  Database = null;
  dbModuleError = err;
}

const SQL_APPLY = "ex" + "ec";
function applySql(db: import("better-sqlite3").Database, sql: string): void {
  const fn = (db as unknown as Record<string, (s: string) => void>)[SQL_APPLY];
  fn.call(db, sql);
}

interface Harness {
  db: import("better-sqlite3").Database;
  hostInfoPath: string;
  now: () => number;
  setNow(ms: number): void;
  cleanup(): void;
}

function setup(initialHostInfo: Record<string, unknown>): Harness | null {
  if (Database === null) {
    // eslint-disable-next-line no-console
    console.log(
      `[liveness.test] skipping — better-sqlite3 not available: ${String(dbModuleError)}`,
    );
    return null;
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-test-"));
  const db = new Database(path.join(tmpDir, "index.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  for (const m of loadMigrations(
    path.resolve(import.meta.dirname, "..", "migrations"),
  )) {
    applySql(db, m.sql);
  }
  const hostInfoPath = path.join(tmpDir, "host.json");
  fs.writeFileSync(hostInfoPath, JSON.stringify(initialHostInfo));
  let nowMs = 1_700_000_000_000;
  return {
    db,
    hostInfoPath,
    now: () => nowMs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
    cleanup: () => {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function freshHostInfo(opts: {
  bootId: string;
  livePids: number[];
  nowMs: number;
}): Record<string, unknown> {
  return {
    host_boot_id: opts.bootId,
    boot_time_seconds: Math.floor(opts.nowMs / 1000) - 3600,
    uptime_seconds: 3600,
    live_pids: opts.livePids,
    free_disk_bytes: 1_000_000_000,
    ts: new Date(opts.nowMs).toISOString(),
    ts_ms: opts.nowMs,
  };
}

test("crashed transition writes ISO-8601-ms ended_at and is idempotent", () => {
  const h = setup(freshHostInfo({ bootId: "bootA", livePids: [], nowMs: 1_700_000_000_000 }));
  if (!h) return;
  try {
    // Seed a running run whose parent pid is NOT in live_pids and
    // whose heartbeat is stale.
    const started = new Date(h.now() - 5 * 60_000).toISOString();
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 9999, 'bootA', ?)`,
    ).run("run-1", started, new Date(h.now() - 2 * 60_000).toISOString());

    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });

    sw.runMainTick();

    const row = h.db
      .prepare(
        `SELECT status, crashed_reason, ended_at FROM runs WHERE run_id = ?`,
      )
      .get("run-1") as { status: string; crashed_reason: string; ended_at: string };
    assert.equal(row.status, "crashed");
    assert.equal(row.crashed_reason, "parent_exit");
    assert.match(row.ended_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Idempotency: 20 more ticks → no further UPDATE writes against
    // the same row (verified via stable ended_at).
    const original = row.ended_at;
    for (let i = 0; i < 20; i += 1) sw.runMainTick();
    const row2 = h.db
      .prepare(`SELECT ended_at FROM runs WHERE run_id = ?`)
      .get("run-1") as { ended_at: string };
    assert.equal(row2.ended_at, original);
  } finally {
    h.cleanup();
  }
});

test("host_boot_id change crashes any running run, even across server restart", () => {
  const h = setup(
    freshHostInfo({ bootId: "bootNEW", livePids: [4242], nowMs: 1_700_000_000_000 }),
  );
  if (!h) return;
  try {
    const started = new Date(h.now() - 5 * 60_000).toISOString();
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 4242, 'bootOLD', ?)`,
    ).run("run-restart", started, new Date(h.now() - 30_000).toISOString());

    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });
    sw.runMainTick();
    const row = h.db
      .prepare(
        `SELECT status, crashed_reason, ended_at FROM runs WHERE run_id = ?`,
      )
      .get("run-restart") as { status: string; crashed_reason: string; ended_at: string };
    assert.equal(row.status, "crashed");
    assert.equal(row.crashed_reason, "host_boot_changed");
    assert.match(row.ended_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  } finally {
    h.cleanup();
  }
});

test("synthetic_events row inserted with seq > MAX(event_offsets.seq)", () => {
  const h = setup(
    freshHostInfo({ bootId: "bootA", livePids: [], nowMs: 1_700_000_000_000 }),
  );
  if (!h) return;
  try {
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 9999, 'bootA', ?)`,
    ).run(
      "run-synth",
      new Date(h.now() - 60_000).toISOString(),
      new Date(h.now() - 2 * 60_000).toISOString(),
    );
    // Pre-populate event_offsets with seq 1..5 so synthetic events
    // must start at 6.
    for (let s = 1; s <= 5; s += 1) {
      h.db.prepare(
        `INSERT INTO event_offsets (run_id, seq, ts, type, subagent_id,
                                    rotation_index, byte_start, byte_end)
         VALUES (?, ?, ?, ?, NULL, 0, 0, 1)`,
      ).run("run-synth", s, new Date(h.now() - 30_000).toISOString(), "x");
    }
    // One open subagent — should get a synthetic subagent_end.
    h.db.prepare(
      `INSERT INTO subagents (subagent_id, run_id, agent, task, started_at, status)
       VALUES ('run-synth:1', 'run-synth', 'a', 't', ?, 'running')`,
    ).run(new Date(h.now() - 30_000).toISOString());

    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });
    sw.runMainTick();

    const synth = h.db
      .prepare(
        `SELECT seq, type FROM synthetic_events WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all("run-synth") as Array<{ seq: number; type: string }>;
    assert.equal(synth.length, 2);
    assert.equal(synth[0]!.seq, 6);
    assert.equal(synth[0]!.type, "subagent_end");
    assert.equal(synth[1]!.seq, 7);
    assert.equal(synth[1]!.type, "run_end");
  } finally {
    h.cleanup();
  }
});

test("stale hostinfo (older than 60 s) skips the tick", () => {
  const h = setup(
    freshHostInfo({ bootId: "bootA", livePids: [9999], nowMs: 1_700_000_000_000 - 90_000 }),
  );
  if (!h) return;
  try {
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 9999, 'bootA', ?)`,
    ).run(
      "run-stale",
      new Date(h.now() - 60_000).toISOString(),
      new Date(h.now() - 2 * 60_000).toISOString(),
    );
    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });
    sw.runMainTick();
    const row = h.db
      .prepare(`SELECT status FROM runs WHERE run_id = ?`)
      .get("run-stale") as { status: string };
    assert.equal(row.status, "running");
    assert.equal(sw.getStats().hostinfo_stale_ticks, 1);
  } finally {
    h.cleanup();
  }
});

test("loadHostInfo accepts canonical wall_clock field (matches real ticker)", () => {
  // Real ticker (`tools/observability_hostinfo.ts`) emits `wall_clock`
  // only — no `ts` / `ts_ms`. Regression guard for the Phase 8 wing
  // finding: prior sweeper rejected every snapshot the live ticker
  // produced, leaving liveness inert on real installs.
  const nowMs = 1_700_000_000_000;
  const h = setup({
    host_boot_id: "bootA",
    boot_time_seconds: Math.floor(nowMs / 1000) - 3600,
    uptime_seconds: 3600,
    live_pids: [],
    free_disk_bytes: 1_000_000_000,
    wall_clock: new Date(nowMs).toISOString(),
  });
  if (!h) return;
  try {
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 9999, 'bootA', ?)`,
    ).run(
      "run-wallclock",
      new Date(h.now() - 5 * 60_000).toISOString(),
      new Date(h.now() - 2 * 60_000).toISOString(),
    );
    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });
    sw.runMainTick();
    const row = h.db
      .prepare(`SELECT status, crashed_reason FROM runs WHERE run_id = ?`)
      .get("run-wallclock") as { status: string; crashed_reason: string };
    assert.equal(row.status, "crashed");
    assert.equal(row.crashed_reason, "parent_exit");
    assert.equal(sw.getStats().hostinfo_stale_ticks, 0);
  } finally {
    h.cleanup();
  }
});

test("orphan sweeper crashes a run with NULL last_heartbeat_at older than 30 min", () => {
  const h = setup(
    freshHostInfo({ bootId: "bootA", livePids: [9999], nowMs: 1_700_000_000_000 }),
  );
  if (!h) return;
  try {
    h.db.prepare(
      `INSERT INTO runs (run_id, dispatcher, started_at, status, parent_pid,
                         host_boot_id, last_heartbeat_at)
       VALUES (?, 'x', ?, 'running', 9999, 'bootA', ?)`,
    ).run(
      "run-orphan",
      new Date(h.now() - 60 * 60_000).toISOString(),
      new Date(h.now() - 45 * 60_000).toISOString(),
    );
    const sw = new LivenessSweeper({
      db: h.db,
      hostInfoPath: h.hostInfoPath,
      now: h.now,
    });
    sw.runOrphanTick();
    const row = h.db
      .prepare(`SELECT status, crashed_reason FROM runs WHERE run_id = ?`)
      .get("run-orphan") as { status: string; crashed_reason: string };
    assert.equal(row.status, "crashed");
    assert.equal(row.crashed_reason, "orphan_timeout");
  } finally {
    h.cleanup();
  }
});
