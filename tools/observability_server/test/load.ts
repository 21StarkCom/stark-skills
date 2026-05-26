#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 8 Task 1 — load harness.
 *
 * Builds an in-process observability server pointed at a tmpdir spool root,
 * spawns a synthetic dispatcher (`observability_emit_harness.ts`) that emits
 * N fake sub-agents, attaches M WebSocket subscribers + a periodic history
 * query loop, then asserts the Phase 8 percentile targets:
 *
 *   - WS end-to-end p95 < 2 s
 *   - UI sub-agent select → first-byte p95 < 2 s
 *   - SQLite commit p95 < 50 ms
 *   - memory growth < 50 MB/h
 *   - chunk delivery count == emitted count
 *   - daemon UDS round-trip p95 < 5 ms even under load
 *
 * The plan-spec profile is N=27, duration=600s, emit-rate=10 KB/s, M=2 WS
 * subscribers. The defaults below are the lighter CI profile (N=5, 60s);
 * pass `--spec` to run the plan profile end-to-end, or override individual
 * knobs via `--subagents`, `--duration-s`, etc.
 *
 * The harness writes a JSON report to `--report` (defaults to
 * `tools/observability_server/test/load-report.json`) and exits non-zero
 * if any assertion misses. `load_report.ts` renders a human-readable
 * summary from that JSON.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

import WebSocket from "ws";

import { runMigrations } from "../server/db.ts";
import { buildServer, type BuiltServer } from "../server/index.ts";
import { renderReport } from "./load_report.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const EMIT_HARNESS = path.join(
  REPO_ROOT,
  "tools",
  "observability_emit_harness.ts",
);

interface Opts {
  subagents: number;
  durationS: number;
  emitRateBps: number;
  wsSubscribers: number;
  rotationBytes: number;
  reportPath: string;
  mainPort: number;
  retentionPort: number;
  silent: boolean;
  live: boolean;
}

function parseArgv(argv: string[]): Opts {
  const opts: Opts = {
    subagents: 5,
    durationS: 60,
    emitRateBps: 10_000,
    wsSubscribers: 2,
    rotationBytes: 1024 * 1024,
    reportPath: path.join(import.meta.dirname, "load-report.json"),
    mainPort: 0,
    retentionPort: 0,
    silent: false,
    live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--spec") {
      opts.subagents = 27;
      opts.durationS = 600;
      opts.emitRateBps = 10_000;
      opts.wsSubscribers = 2;
    } else if (a === "--subagents") opts.subagents = Number.parseInt(argv[++i] ?? "5", 10);
    else if (a === "--duration-s") opts.durationS = Number.parseInt(argv[++i] ?? "60", 10);
    else if (a === "--emit-rate-bps") opts.emitRateBps = Number.parseInt(argv[++i] ?? "10000", 10);
    else if (a === "--ws-subscribers") opts.wsSubscribers = Number.parseInt(argv[++i] ?? "2", 10);
    else if (a === "--rotation-bytes") opts.rotationBytes = Number.parseInt(argv[++i] ?? "1048576", 10);
    else if (a === "--report") opts.reportPath = argv[++i] ?? opts.reportPath;
    else if (a === "--main-port") opts.mainPort = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a === "--retention-port") opts.retentionPort = Number.parseInt(argv[++i] ?? "0", 10);
    else if (a === "--silent") opts.silent = true;
    else if (a === "--live") opts.live = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

const USAGE = `Usage: load.ts [--spec] [--subagents N] [--duration-s N] [--emit-rate-bps N]
                [--ws-subscribers N] [--rotation-bytes N] [--report PATH]
                [--main-port N] [--retention-port N] [--silent] [--live]

Defaults: N=5, duration=60s, rate=10 KB/s, ws=2, rotation=1 MB.
--spec sets N=27, duration=600s (plan-spec profile).
--live writes live-run.json to the real operator observability root
  (\`~/.claude/code-review/observability/test/live-run.json\`) so the
  destructive shell scripts (test/live/dispatcher_*sigkill.sh,
  pressure_retention.sh) can resolve dispatcher_pid / writer_pid / run_id
  from harness bookkeeping. Off by default — tmpdir-rebased load runs
  do NOT touch the operator's real live-run.json.
`;

interface Latencies {
  ws_e2e_ms: number[];
  ssfb_ms: number[];
  uds_rtt_ms: number[];
  commit_ms: number[];
}

interface MemorySample {
  ts_ms: number;
  rss_bytes: number;
  heap_used_bytes: number;
}

interface LoadReport {
  spec: {
    subagents: number;
    duration_s: number;
    emit_rate_bps: number;
    ws_subscribers: number;
    rotation_bytes: number;
  };
  run_id: string;
  duration_ms: number;
  ws_events_received_per_subscriber: number[];
  chunks_emitted_by_writer: number;
  chunks_indexed: number;
  rotations_observed: number;
  ssfb_samples: number;
  uds_probes: number;
  history_query_count: number;
  memory_samples: MemorySample[];
  memory_growth_bytes_per_hour: number;
  percentiles: {
    ws_e2e_ms_p50: number | null;
    ws_e2e_ms_p95: number | null;
    ssfb_ms_p50: number | null;
    ssfb_ms_p95: number | null;
    uds_rtt_ms_p50: number | null;
    uds_rtt_ms_p95: number | null;
    commit_ms_p50: number | null;
    commit_ms_p95: number | null;
  };
  assertions: Array<{
    name: string;
    target: string;
    observed: string;
    ok: boolean;
  }>;
  status: "pass" | "fail";
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stark-obs-load-"));
  const home = path.join(tmpRoot, "home");
  const dataDir = path.join(tmpRoot, "data");
  const auditDir = path.join(tmpRoot, "audit");
  const spoolRoot = path.join(home, ".claude", "code-review", "observability", "runs");
  const hostInfoPath = path.join(
    home,
    ".claude",
    "code-review",
    "observability",
    "hostinfo",
    "host.json",
  );
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(spoolRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(hostInfoPath), { recursive: true, mode: 0o700 });

  // Track which pids should appear in host.json#live_pids. The sweeper joins
  // runs.parent_pid (= dispatcher pid, populated from run_start) against
  // this set. The dispatcher pid is only known after spawn, so seed with
  // process.pid for now and append the harness pid after `spawn`.
  const livePids = new Set<number>([process.pid]);
  const bootTimeSeconds = Math.floor(Date.now() / 1000) - 60;
  function writeHostInfo(): void {
    // Match `tools/observability_hostinfo.ts`'s canonical schema verbatim.
    // The sweeper's `loadHostInfo()` enforces freshness via the
    // `wall_clock` field; older field names (`written_at`) are ignored
    // by the sweeper and would render this harness's liveness setup inert.
    fs.writeFileSync(
      hostInfoPath,
      JSON.stringify({
        host_boot_id: "load-host-boot-id",
        boot_time_seconds: bootTimeSeconds,
        uptime_seconds: Math.max(0, Math.floor(Date.now() / 1000) - bootTimeSeconds),
        free_disk_bytes: 100 * 1024 * 1024 * 1024,
        wall_clock: new Date().toISOString(),
        live_pids: Array.from(livePids),
      }) + "\n",
      { mode: 0o600 },
    );
  }
  writeHostInfo();

  const auditFilePath = path.join(auditDir, "audit.jsonl");
  const dbPath = path.join(dataDir, "index.db");
  const migrationsDir = path.join(import.meta.dirname, "..", "migrations");
  await runMigrations(dbPath, migrationsDir);

  // Seed the bootstrap + prune tokens that auth.ts expects on disk.
  const bootstrapTokenPath = path.join(dataDir, "bootstrap_token");
  const pruneTokenPath = path.join(dataDir, "prune_token");
  const bootstrapMarkerPath = path.join(dataDir, "last_bootstrap_at");
  fs.writeFileSync(bootstrapTokenPath, crypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
  });
  fs.writeFileSync(pruneTokenPath, crypto.randomBytes(32).toString("hex"), {
    mode: 0o600,
  });

  const mainPort = opts.mainPort || (await freePort());
  const retentionPort = opts.retentionPort || (await freePort());

  const built: BuiltServer = await buildServer({
    dbPath,
    spoolRoot,
    hostInfoPath,
    auditPath: auditFilePath,
    publishedHost: `127.0.0.1:${mainPort}`,
    isLan: false,
    tlsTerminated: false,
    bootstrapTokenPath,
    bootstrapMarkerPath,
    pruneTokenPath,
    uiDir: path.join(tmpRoot, "ui-dist-unused"),
  });

  built.indexWriter.start();
  built.tailer.start();
  built.liveness.start();
  built.retentionSweep.start();

  await built.app.listen({ host: "127.0.0.1", port: mainPort });
  await built.retentionApp.listen({ host: "127.0.0.1", port: retentionPort });

  // Mint a session directly so the WS subscribers + history loop can
  // present a valid `obs_session` cookie without running the bootstrap
  // exchange. Generation tagging is internal — bypass via `as any`.
  const minted = (built.auth as unknown as {
    mintSession: (gen: number) => { sid: string };
  }).mintSession(0);
  const cookie = `obs_session=${minted.sid}`;

  // Start memory sampling.
  const memorySamples: MemorySample[] = [];
  const memoryTimer = setInterval(() => {
    const m = process.memoryUsage();
    memorySamples.push({
      ts_ms: Date.now(),
      rss_bytes: m.rss,
      heap_used_bytes: m.heapUsed,
    });
  }, 5_000);
  memoryTimer.unref();
  memorySamples.push({
    ts_ms: Date.now(),
    rss_bytes: process.memoryUsage().rss,
    heap_used_bytes: process.memoryUsage().heapUsed,
  });

  // Spawn the emit harness with HOME redirected to our tmpdir.
  const harnessProc = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      EMIT_HARNESS,
      "--subagents",
      String(opts.subagents),
      "--duration-s",
      String(opts.durationS),
      "--emit-rate-bps",
      String(opts.emitRateBps),
      "--print-run-id",
    ],
    {
      env: {
        ...process.env,
        HOME: home,
        OBSERVABILITY_MAX_FILE_BYTES: String(opts.rotationBytes),
        OBSERVABILITY_PER_RUN_MAX_MB: "4096",
        OBSERVABILITY_DISABLED: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!opts.silent) {
    harnessProc.stderr.on("data", (b) => process.stderr.write(`[harness] ${b}`));
  }

  // Wing-finding fix: register the harness pid in host.live_pids[] BEFORE
  // the index writer reads run_start. The writer daemon stamps
  // tracked_parent_pid = harness.pid into runs.parent_pid (E10); the
  // liveness sweeper joins parent_pid against live_pids and would mark
  // this long synthetic run crashed mid-run otherwise.
  if (harnessProc.pid !== undefined) livePids.add(harnessProc.pid);
  writeHostInfo();
  // Refresh the host.json ticker every 5 s so `written_at` stays inside
  // the sweeper's 60 s freshness window.
  const hostInfoTimer = setInterval(writeHostInfo, 5_000);
  hostInfoTimer.unref();
  harnessProc.on("exit", () => {
    if (harnessProc.pid !== undefined) livePids.delete(harnessProc.pid);
    writeHostInfo();
  });

  const runId = await readRunId(harnessProc);
  if (!opts.silent) {
    process.stderr.write(`[load] run_id=${runId} main=:${mainPort}\n`);
  }

  // Wing round-4 fix: the destructive shell scripts
  // (dispatcher_sigkill.sh, dispatcher_and_daemon_sigkill.sh,
  // pressure_retention.sh) read `$HOME/.claude/code-review/observability/test/live-run.json`
  // from the OPERATOR's real HOME — not the tmpdir HOME we redirected
  // the harness child into. Writing under the tmpdir HOME satisfies
  // nothing. Only write live-run.json when `--live` is set, and write
  // it to the real `os.homedir()` so the .sh scripts find it. Default
  // mode skips the write so concurrent tmpdir load runs never clobber
  // the operator's real live-run.json.
  const writerPid = await resolveWriterPid(home, runId, harnessProc);
  if (opts.live) {
    const liveRoot = os.homedir();
    await writeLiveRunMetadata(liveRoot, {
      run_id: runId,
      dispatcher_pid: harnessProc.pid ?? 0,
      writer_pid: writerPid,
    });
    if (!opts.silent) {
      process.stderr.write(
        `[load] --live: wrote live-run.json under ${liveRoot}/.claude/code-review/observability/test/\n`,
      );
    }
  }

  // Latency collectors.
  const lat: Latencies = {
    ws_e2e_ms: [],
    ssfb_ms: [],
    uds_rtt_ms: [],
    commit_ms: [],
  };
  const wsReceiveCounts = new Array(opts.wsSubscribers).fill(0) as number[];
  const chunkEventsBySub = new Array(opts.wsSubscribers).fill(0) as number[];
  let chunkEventsReceived = 0;

  // Attach WS subscribers.
  const wsSockets: WebSocket[] = [];
  for (let i = 0; i < opts.wsSubscribers; i++) {
    const ws = new WebSocket(`ws://127.0.0.1:${mainPort}/ws`, {
      headers: {
        cookie,
        host: `127.0.0.1:${mainPort}`,
        origin: `http://127.0.0.1:${mainPort}`,
      },
    });
    await waitOpen(ws);
    ws.send(
      JSON.stringify({
        type: "subscribe",
        run_id: runId,
        live: true,
        from_seq: 0,
      }),
    );
    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type !== "event") return;
      wsReceiveCounts[i] = (wsReceiveCounts[i] ?? 0) + 1;
      const evt = msg.event as Record<string, unknown> | undefined;
      if (evt === undefined) return;
      const evtType = String(evt.type ?? "");
      if (evtType === "subagent_stdout" || evtType === "subagent_stderr") {
        chunkEventsReceived++;
        chunkEventsBySub[i] = (chunkEventsBySub[i] ?? 0) + 1;
      }
      const ts = String(evt.ts ?? "");
      const emittedAtMs = Date.parse(ts);
      if (Number.isFinite(emittedAtMs)) {
        lat.ws_e2e_ms.push(Date.now() - emittedAtMs);
      }
    });
    wsSockets.push(ws);
  }

  // History query + SSE first-byte loop.
  let historyCount = 0;
  let ssfbCount = 0;
  const historyTimer = setInterval(() => {
    void runHistoryProbe(mainPort, runId, cookie, lat).then(({ ok, ssfbDid }) => {
      if (ok) historyCount++;
      if (ssfbDid) ssfbCount++;
    });
  }, 5_000);
  historyTimer.unref();

  // UDS RTT probe loop — talks directly to the writer daemon's `ping` op,
  // which is unauthenticated per the daemon's protocol.
  const udsAbort = startUdsProbe(home, runId, lat, opts.silent);

  // Wait for the harness to finish.
  const harnessExit = await new Promise<{ code: number | null; summary: string }>(
    (resolve) => {
      let stdoutBuf = "";
      harnessProc.stdout.on("data", (b: Buffer) => {
        stdoutBuf += b.toString("utf8");
      });
      harnessProc.on("exit", (code) => {
        resolve({ code, summary: stdoutBuf.trim() });
      });
    },
  );

  clearInterval(historyTimer);
  clearInterval(memoryTimer);
  clearInterval(hostInfoTimer);
  await udsAbort();

  // Give the tailer + index writer 5 s to drain.
  const drainDeadline = Date.now() + 5_000;
  while (Date.now() < drainDeadline) {
    await sleep(200);
    if (drainComplete(built, runId)) break;
  }
  built.indexWriter.flush();

  // Snapshot final stats.
  lat.commit_ms = built.indexWriter.getCommitLatencies();
  const stats = built.indexWriter.getStats();
  const indexedCounts = built.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM event_offsets WHERE run_id = ?) AS total_events,
         (SELECT COUNT(*) FROM event_offsets WHERE run_id = ? AND type IN ('subagent_stdout','subagent_stderr')) AS chunk_events,
         (SELECT COUNT(DISTINCT rotation_index) FROM spool_files WHERE run_id = ?) AS rotations`,
    )
    .get(runId, runId, runId) as {
      total_events: number;
      chunk_events: number;
      rotations: number;
    };

  // Wing-finding fix: count chunk events directly out of the JSONL spool
  // files the writer daemon emitted. This is the authoritative
  // "emitted by writer" number — the prior code aliased
  // indexedCounts.chunk_events into both sides and made the parity
  // assertion tautological.
  const chunksEmittedByWriter = countSpoolChunkEvents(spoolRoot, runId);

  // Tear down WS.
  for (const ws of wsSockets) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  built.liveness.stop();
  built.retentionSweep.stop();
  built.wsHub.closeAll();
  await built.tailer.stop();
  await built.app.close();
  await built.retentionApp.close();
  built.db.close();

  // Compute growth.
  let memoryGrowthBytesPerHour = 0;
  if (memorySamples.length >= 2) {
    const first = memorySamples[0]!;
    const last = memorySamples[memorySamples.length - 1]!;
    const dtMs = last.ts_ms - first.ts_ms;
    if (dtMs > 0) {
      const dRss = last.rss_bytes - first.rss_bytes;
      memoryGrowthBytesPerHour = Math.round((dRss * 3_600_000) / dtMs);
    }
  }

  const report: LoadReport = {
    spec: {
      subagents: opts.subagents,
      duration_s: opts.durationS,
      emit_rate_bps: opts.emitRateBps,
      ws_subscribers: opts.wsSubscribers,
      rotation_bytes: opts.rotationBytes,
    },
    run_id: runId,
    duration_ms: opts.durationS * 1000,
    ws_events_received_per_subscriber: wsReceiveCounts,
    chunks_emitted_by_writer: chunksEmittedByWriter,
    chunks_indexed: indexedCounts.chunk_events,
    rotations_observed: indexedCounts.rotations,
    ssfb_samples: ssfbCount,
    uds_probes: lat.uds_rtt_ms.length,
    history_query_count: historyCount,
    memory_samples: memorySamples,
    memory_growth_bytes_per_hour: memoryGrowthBytesPerHour,
    percentiles: {
      ws_e2e_ms_p50: percentile(lat.ws_e2e_ms, 50),
      ws_e2e_ms_p95: percentile(lat.ws_e2e_ms, 95),
      ssfb_ms_p50: percentile(lat.ssfb_ms, 50),
      ssfb_ms_p95: percentile(lat.ssfb_ms, 95),
      uds_rtt_ms_p50: percentile(lat.uds_rtt_ms, 50),
      uds_rtt_ms_p95: percentile(lat.uds_rtt_ms, 95),
      commit_ms_p50: percentile(lat.commit_ms, 50),
      commit_ms_p95: percentile(lat.commit_ms, 95),
    },
    assertions: [],
    status: "pass",
  };
  void stats; // reserved for future surfacing

  const minWsEvents = Math.max(1, Math.floor(opts.subagents * 0.5));
  report.assertions = [
    {
      name: "ws_e2e_p95_under_2s",
      target: "<2000 ms",
      observed: fmtMs(report.percentiles.ws_e2e_ms_p95),
      ok: pctOk(report.percentiles.ws_e2e_ms_p95, 2000),
    },
    {
      name: "ssfb_p95_under_2s",
      target: "<2000 ms",
      observed: fmtMs(report.percentiles.ssfb_ms_p95),
      ok: pctOk(report.percentiles.ssfb_ms_p95, 2000),
    },
    {
      name: "uds_rtt_p95_under_5ms",
      target: "<5 ms",
      observed: fmtMs(report.percentiles.uds_rtt_ms_p95),
      ok: pctOk(report.percentiles.uds_rtt_ms_p95, 5),
    },
    {
      name: "commit_p95_under_50ms",
      target: "<50 ms",
      observed: fmtMs(report.percentiles.commit_ms_p95),
      ok: pctOk(report.percentiles.commit_ms_p95, 50),
    },
    {
      name: "memory_growth_under_50mb_per_h",
      target: "<50 MB/h",
      observed: `${(memoryGrowthBytesPerHour / (1024 * 1024)).toFixed(2)} MB/h`,
      ok: memoryGrowthBytesPerHour < 50 * 1024 * 1024,
    },
    {
      name: "ws_received_at_least_one_per_subscriber",
      target: `>=${minWsEvents}`,
      observed: wsReceiveCounts.join(","),
      ok: wsReceiveCounts.every((n) => n >= minWsEvents),
    },
    {
      name: "rotation_observed",
      target: ">=1",
      observed: String(indexedCounts.rotations),
      ok: indexedCounts.rotations >= 1,
    },
    {
      name: "chunks_indexed_eq_emitted",
      target: "==chunks_emitted_by_writer",
      observed: `indexed=${indexedCounts.chunk_events} emitted=${chunksEmittedByWriter}`,
      ok:
        chunksEmittedByWriter > 0 &&
        indexedCounts.chunk_events === chunksEmittedByWriter,
    },
    {
      name: "chunks_ws_delivery_eq_emitted",
      target: "every subscriber == chunks_emitted_by_writer",
      observed: `subs=${chunkEventsBySub.join(",")} emitted=${chunksEmittedByWriter}`,
      ok:
        chunksEmittedByWriter > 0 &&
        chunkEventsBySub.length === opts.wsSubscribers &&
        chunkEventsBySub.every((n) => n === chunksEmittedByWriter),
    },
    {
      name: "harness_exit_zero",
      target: "==0",
      observed: String(harnessExit.code),
      ok: harnessExit.code === 0,
    },
  ];
  if (report.assertions.some((a) => !a.ok)) report.status = "fail";

  fs.writeFileSync(opts.reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!opts.silent) {
    process.stdout.write(renderReport(report) + "\n");
    process.stdout.write(`Report: ${opts.reportPath}\n`);
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(report.status === "pass" ? 0 : 1);
}

function pctOk(observed: number | null, target: number): boolean {
  if (observed === null) return false;
  return observed < target;
}

function fmtMs(v: number | null): string {
  if (v === null) return "n/a";
  return `${v.toFixed(2)} ms`;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr !== null) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) {
      resolve();
      return;
    }
    const onOpen = () => {
      ws.off("error", onErr);
      resolve();
    };
    const onErr = (err: Error) => {
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onErr);
  });
}

async function readRunId(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let resolved = false;
    const onData = (b: Buffer) => {
      buf += b.toString("utf8");
      const m = buf.match(/RUN_ID=([0-9a-f-]+)/);
      if (m && !resolved) {
        resolved = true;
        child.stdout?.off("data", onData);
        resolve(m[1]!);
      }
    };
    child.stdout?.on("data", onData);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`harness exited ${code} before RUN_ID`));
    });
  });
}

async function runHistoryProbe(
  port: number,
  runId: string,
  cookie: string,
  lat: Latencies,
): Promise<{ ok: boolean; ssfbDid: boolean }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}`, {
      headers: { cookie },
    });
    if (!res.ok) return { ok: false, ssfbDid: false };
    const body = (await res.json()) as { subagents?: Array<{ subagent_id: string }> };
    const subagents = body.subagents ?? [];
    if (subagents.length === 0) return { ok: true, ssfbDid: false };
    const sa = subagents[Math.floor(Math.random() * subagents.length)]!;
    const startedAtMs = performance.now();
    const sseRes = await fetch(
      `http://127.0.0.1:${port}/api/runs/${runId}/subagents/${sa.subagent_id}/chunks`,
      {
        headers: { cookie, accept: "text/event-stream" },
      },
    );
    if (!sseRes.ok || sseRes.body === null) {
      return { ok: true, ssfbDid: false };
    }
    const reader = sseRes.body.getReader();
    try {
      const { done } = await reader.read();
      const elapsed = performance.now() - startedAtMs;
      if (!done) lat.ssfb_ms.push(elapsed);
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    return { ok: true, ssfbDid: true };
  } catch {
    return { ok: false, ssfbDid: false };
  }
}

/**
 * UDS RTT probe — exercises the **real** authenticated data-protocol
 * path (RT1 hello + cap consumption), not the unauthenticated `ping`
 * shortcut. Steps:
 *
 *   1. Wait for the writer daemon's socket file to appear.
 *   2. One-shot `ping` until the daemon reports `run_start_committed`
 *      + `run_heartbeat_committed`. (Pre-handshake; this still races
 *      the daemon's readiness — measurement starts after.)
 *   3. Read `writer.cap` (0600, per-run dir) and mint a single-use
 *      ephemeral cap via the writer-owned `caps_issue` op.
 *   4. Open a fresh socket, present `hello { cap }`, then loop:
 *      send `ping`, await reply, record the RTT. The cap binds to the
 *      connection for its lifetime, so subsequent pings re-use the
 *      same authenticated socket — i.e. we measure the same path
 *      production dispatchers use for emit ops.
 *   5. On socket close / write error, mint a new cap and reconnect.
 *
 * The returned aborter is async and resolves once the persistent
 * socket has been closed cleanly.
 */
function startUdsProbe(
  home: string,
  runId: string,
  lat: Latencies,
  silent: boolean,
): () => Promise<void> {
  let stopped = false;
  let activeSock: net.Socket | null = null;
  const tick = async () => {
    let authedSock: AuthedSocket | null = null;
    while (!stopped) {
      try {
        const sockPath = resolveSocketPath(home, runId);
        if (!fs.existsSync(sockPath)) {
          await sleep(500);
          continue;
        }
        if (authedSock === null || authedSock.dead) {
          if (!(await readyOnce(sockPath))) {
            await sleep(500);
            continue;
          }
          const cap = await mintCap(sockPath, home, runId);
          authedSock = await openAuthenticatedSocket(sockPath, cap);
          activeSock = authedSock.socket;
        }
        const t0 = performance.now();
        await authedSock.sendPing();
        lat.uds_rtt_ms.push(performance.now() - t0);
      } catch (e) {
        if (!silent) process.stderr.write(`[uds-probe] ${(e as Error).message}\n`);
        if (authedSock !== null) {
          try {
            authedSock.socket.destroy();
          } catch {
            // ignore
          }
          authedSock = null;
        }
        activeSock = null;
      }
      await sleep(500);
    }
    if (authedSock !== null) {
      try {
        authedSock.socket.destroy();
      } catch {
        // ignore
      }
    }
  };
  const promise = tick();
  return async () => {
    stopped = true;
    if (activeSock !== null) {
      try {
        activeSock.destroy();
      } catch {
        // ignore
      }
    }
    await promise;
  };
}

function resolveSocketPath(_home: string, runId: string): string {
  // Mirror tools/observability_paths_lib.ts::writerSocketPath without
  // importing the path lib (which captures os.homedir() at import time
  // and ignores HOME overrides post-import on some Node builds).
  let h = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  const hash = h.toString(16).padStart(8, "0");
  return path.join(os.tmpdir(), "stark-obs", `${hash}.sock`);
}

function writerCapPathFor(home: string, runId: string): string {
  return path.join(
    home,
    ".claude",
    "code-review",
    "observability",
    "runs",
    runId,
    "writer.cap",
  );
}

/** Single-shot request/response over a fresh UDS connection. */
function probeRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let acc = "";
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      sock.write(JSON.stringify(request) + "\n");
    });
    sock.on("data", (d: string) => {
      acc += d;
      const nl = acc.indexOf("\n");
      if (nl === -1) return;
      const line = acc.slice(0, nl);
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        sock.destroy();
        resolve(parsed);
      } catch (e) {
        sock.destroy();
        reject(e as Error);
      }
    });
    sock.once("error", (err) => reject(err));
  });
}

/** Confirm the daemon reports ready=true via a single unauth ping
 *  probe. Returns true once committed; false on a transient error. */
async function readyOnce(socketPath: string): Promise<boolean> {
  try {
    const resp = await probeRequest(socketPath, { op: "ping" });
    return (
      resp.ok === true &&
      resp.ready === true &&
      resp.run_start_committed === true &&
      resp.run_heartbeat_committed === true
    );
  } catch {
    return false;
  }
}

async function mintCap(
  socketPath: string,
  home: string,
  runId: string,
): Promise<string> {
  const capPath = writerCapPathFor(home, runId);
  const issuer = fs.readFileSync(capPath, "utf8").trim();
  if (issuer.length === 0) throw new Error("writer.cap empty");
  const resp = await probeRequest(socketPath, { op: "caps_issue", issuer });
  if (resp.ok !== true || typeof resp.cap !== "string" || resp.cap.length === 0) {
    throw new Error(`caps_issue rejected: ${JSON.stringify(resp)}`);
  }
  return resp.cap;
}

interface AuthedSocket {
  socket: net.Socket;
  sendPing(): Promise<void>;
  dead: boolean;
}

/** Open a fresh data-protocol socket, present `hello { cap }`, return
 *  a helper that pings against the same authenticated connection. */
async function openAuthenticatedSocket(
  socketPath: string,
  cap: string,
): Promise<AuthedSocket> {
  const sock = net.createConnection(socketPath);
  sock.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => {
      sock.off("error", reject);
      resolve();
    });
    sock.once("error", reject);
  });
  const state: {
    buffer: string;
    pending: Array<{
      resolve: (v: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }>;
    dead: boolean;
  } = { buffer: "", pending: [], dead: false };
  sock.on("data", (chunk: string) => {
    state.buffer += chunk;
    let nl: number;
    while ((nl = state.buffer.indexOf("\n")) !== -1) {
      const line = state.buffer.slice(0, nl);
      state.buffer = state.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      const waiter = state.pending.shift();
      if (waiter === undefined) continue;
      try {
        waiter.resolve(JSON.parse(line) as Record<string, unknown>);
      } catch (e) {
        waiter.reject(e as Error);
      }
    }
  });
  const onDeath = (err?: Error) => {
    state.dead = true;
    const waiters = state.pending.splice(0);
    for (const w of waiters) w.reject(err ?? new Error("socket closed"));
  };
  sock.on("error", (err) => onDeath(err));
  sock.on("close", () => onDeath());
  const sendRaw = (req: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (state.dead) return Promise.reject(new Error("socket dead"));
    return new Promise((resolve, reject) => {
      state.pending.push({ resolve, reject });
      try {
        sock.write(JSON.stringify(req) + "\n");
      } catch (e) {
        const last = state.pending.pop();
        if (last) last.reject(e as Error);
      }
    });
  };
  const helloResp = await sendRaw({ op: "hello", cap });
  if (helloResp.ok !== true) {
    sock.destroy();
    throw new Error(`hello rejected: ${JSON.stringify(helloResp)}`);
  }
  return {
    socket: sock,
    get dead() {
      return state.dead;
    },
    async sendPing() {
      const resp = await sendRaw({ op: "ping" });
      if (resp.ok !== true) throw new Error(`ping !ok: ${JSON.stringify(resp)}`);
    },
  };
}

/**
 * Walk the per-run spool directory and count `subagent_stdout` /
 * `subagent_stderr` JSONL records. Authoritative "emitted by the writer
 * daemon" — independent of what landed in SQLite or got delivered over
 * WS. The parity assertions in `report.assertions` lean on this being
 * an independent count.
 */
function countSpoolChunkEvents(spoolRoot: string, runId: string): number {
  const runDir = path.join(spoolRoot, runId);
  let entries: string[];
  try {
    entries = fs.readdirSync(runDir);
  } catch {
    return 0;
  }
  let count = 0;
  for (const name of entries) {
    if (!/^events-\d+\.jsonl$/.test(name)) continue;
    const filePath = path.join(runDir, name);
    let buf: string;
    try {
      buf = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let cursor = 0;
    while (cursor < buf.length) {
      const nl = buf.indexOf("\n", cursor);
      const end = nl === -1 ? buf.length : nl;
      const line = buf.slice(cursor, end);
      cursor = nl === -1 ? buf.length : nl + 1;
      if (line.length === 0) continue;
      try {
        const obj = JSON.parse(line) as { type?: unknown };
        if (obj.type === "subagent_stdout" || obj.type === "subagent_stderr") {
          count++;
        }
      } catch {
        // malformed line — skip
      }
    }
  }
  return count;
}

/**
 * Resolve the writer daemon pid for a freshly-started run. The emit-lib
 * handshake guarantees `writer.pid` is fsynced before `startRun()`
 * returns to the dispatcher, but the load harness's `readRunId` races
 * against the harness child's stdout — the pid file write and the
 * `RUN_ID=…` line are emitted from two different processes. Poll for a
 * short window before giving up. Returns `null` if the pid file never
 * materializes (the live-run.json file is still written; downstream
 * tests handle a null `writer_pid` by failing the sweeper test).
 */
async function resolveWriterPid(
  home: string,
  runId: string,
  child: ReturnType<typeof spawn>,
): Promise<number | null> {
  const pidPath = path.join(
    home,
    ".claude",
    "code-review",
    "observability",
    "runs",
    runId,
    "writer.pid",
  );
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(pidPath, "utf8").trim();
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) return pid;
    } catch {
      // pid file not yet written — retry
    }
    if (child.exitCode !== null) return null;
    await sleep(100);
  }
  return null;
}

/**
 * Atomic write of `<homeRoot>/.claude/code-review/observability/test/live-run.json`
 * matching `live_run_metadata.ts`'s on-disk schema verbatim so the
 * dispatcher live-test bash scripts can `jq -r` the same keys whether
 * the metadata came from the standalone helper or from the harness
 * itself. The caller decides the root — pass `os.homedir()` for live
 * mode so the destructive .sh scripts find it under the operator's
 * real HOME.
 */
async function writeLiveRunMetadata(
  homeRoot: string,
  body: { run_id: string; dispatcher_pid: number; writer_pid: number | null },
): Promise<void> {
  const outDir = path.join(homeRoot, ".claude", "code-review", "observability", "test");
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const outPath = path.join(outDir, "live-run.json");
  const tmp = outPath + ".tmp";
  const payload = {
    harness_started_at: new Date().toISOString(),
    run_id: body.run_id,
    dispatcher_pid: body.dispatcher_pid,
    writer_pid: body.writer_pid,
    sentinel_pid: null,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, outPath);
}

function drainComplete(built: BuiltServer, runId: string): boolean {
  try {
    const row = built.db
      .prepare(`SELECT status FROM runs WHERE run_id = ?`)
      .get(runId) as { status: string | null } | undefined;
    if (row === undefined) return false;
    return row.status !== null && row.status !== "running";
  } catch {
    return false;
  }
}

const isEntry =
  import.meta.url ===
  (process.argv[1] ? new URL(`file://${path.resolve(process.argv[1])}`).href : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[load] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
