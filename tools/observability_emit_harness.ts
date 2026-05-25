#!/usr/bin/env -S node --experimental-strip-types
/**
 * Synthetic emit-lib harness — Phase 2 verification entry point.
 *
 * Modes:
 *   default       — start a run, spawn 5 sub-agents that each `attachChild`
 *                   a `sh -c "echo ..."` child emitting random output for
 *                   the duration, then end normally. Plants a `ghp_*` token
 *                   in one chunk to verify redaction lands.
 *   --multi-process  — start a run in this process, then `spawn` a second
 *                      node process that runs the SAME harness with
 *                      `--connect <runId>` and emits one sub-agent into the
 *                      same daemon. The parent keeps emitting while the
 *                      child runs. Used to verify cross-process UDS dispatch
 *                      and strictly monotonic seq.
 *   --connect <runId>  — internal: runs the child-side of --multi-process.
 *   --duration-s N — total emit duration (default 60 s).
 *   --emit-rate-bps N — per-subagent rate cap (default 10000).
 *
 * The harness prints a final JSON summary to stdout for the integration
 * tests to assert against.
 */

import { spawn } from "node:child_process";
import path from "node:path";

import {
  attachChild,
  connectRun,
  emitProgress,
  endRun,
  endSubAgent,
  startHeartbeat,
  startRun,
  startRunHeartbeat,
  startSubAgent,
} from "./observability_emit_lib.ts";

interface HarnessOpts {
  multiProcess: boolean;
  connectRunId: string | null;
  durationS: number;
  emitRateBps: number;
  subagentCount: number;
  /** When > 0: after this many seconds, inject a synthetic
   *  `chunk_truncated` JSONL record on subagent-0's stdout by sending
   *  the daemon an undecodable-base64 emit_chunk request > 1 MiB
   *  (which the daemon's existing E6 path converts to a chunk_truncated
   *  sentinel — see observability_writer_daemon.ts handler near the
   *  UNDECODABLE_BUDGET check). Used by the Phase 5 Playwright E2E
   *  fixture to deterministically seed a retention gap. */
  truncateAfterS: number;
  /** When set: print `RUN_ID=<id>` to stdout immediately after
   *  `startRun` returns. Lets a parent process (the Playwright fixture)
   *  attach to the live run while it's still emitting. */
  printRunId: boolean;
}

function parseArgv(argv: string[]): HarnessOpts {
  const opts: HarnessOpts = {
    multiProcess: false,
    connectRunId: null,
    durationS: 60,
    emitRateBps: 10_000,
    subagentCount: 5,
    truncateAfterS: 0,
    printRunId: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--multi-process") opts.multiProcess = true;
    else if (a === "--connect") opts.connectRunId = argv[++i] ?? null;
    else if (a === "--duration-s") opts.durationS = Number.parseInt(argv[++i] ?? "60", 10);
    else if (a === "--emit-rate-bps") opts.emitRateBps = Number.parseInt(argv[++i] ?? "10000", 10);
    else if (a === "--subagents") opts.subagentCount = Number.parseInt(argv[++i] ?? "5", 10);
    else if (a === "--truncate-after-s") opts.truncateAfterS = Number.parseFloat(argv[++i] ?? "0");
    else if (a === "--print-run-id") opts.printRunId = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: observability_emit_harness.ts [--multi-process] [--connect runId] [--duration-s N] [--emit-rate-bps N] [--subagents N] [--truncate-after-s N] [--print-run-id]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown arg: ${a}`);
  }
  return opts;
}

function planted(): string {
  return "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1234567";
}

async function runOneSubagent(
  ctx: Awaited<ReturnType<typeof startRun>>,
  agentName: string,
  durationS: number,
  rateBps: number,
  plantToken: boolean,
  onStarted?: (sa: Awaited<ReturnType<typeof startSubAgent>>) => void,
): Promise<void> {
  const sa = await startSubAgent(ctx, {
    agent: agentName,
    model: "synthetic",
    task: "harness",
  });
  if (onStarted) onStarted(sa);
  const hb = startHeartbeat(ctx, sa);
  try {
    const cmd = "sh";
    const bytesPerTick = Math.max(64, Math.floor(rateBps / 10));
    const ticks = Math.max(1, durationS * 10);
    const lit = plantToken ? planted() : "";
    // A small awk script that prints `bytes` bytes worth of garbage per
    // iteration, sleeps 0.1s. We do this in a single shell process so the
    // 'data' tap sees real bursts.
    const inline = `i=0; while [ $i -lt ${ticks} ]; do head -c ${bytesPerTick} /dev/urandom | base64 | tr -d '\\n'; echo "${lit}"; i=$((i+1)); sleep 0.1; done`;
    const child = spawn(cmd, ["-c", inline], { stdio: ["ignore", "pipe", "pipe"] });
    const tap = attachChild(ctx, sa, child);
    await emitProgress(ctx, sa, "round", { round_num: 1, phase: "synthetic" });
    await new Promise<void>((resolve, reject) => {
      child.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`child exited ${code}`));
        } else {
          resolve();
        }
      });
      child.on("error", reject);
    });
    // E2: await drain BEFORE endSubAgent so the last hundreds of ms of
    // output land before the subagent_end event.
    await tap.drain();
    await endSubAgent(ctx, sa, "ok", undefined, { ticks });
  } finally {
    hb.stop();
  }
}

interface HarnessSummary {
  run_id: string;
  disabled: boolean;
  duration_ms: number;
  subagents: number;
  mode: "owned" | "child";
  status: "ok" | "error";
  error?: string;
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  const startMs = Date.now();
  let summary: HarnessSummary;
  if (opts.connectRunId) {
    // Child mode of --multi-process: connect to parent's daemon, run one
    // sub-agent end-to-end.
    const ctx = await connectRun(opts.connectRunId);
    try {
      await runOneSubagent(ctx, "child-codex", Math.min(5, opts.durationS), opts.emitRateBps, false);
      summary = {
        run_id: ctx.runId,
        disabled: ctx._disabled,
        duration_ms: Date.now() - startMs,
        subagents: 1,
        mode: "child",
        status: "ok",
      };
    } catch (e) {
      summary = {
        run_id: ctx.runId,
        disabled: ctx._disabled,
        duration_ms: Date.now() - startMs,
        subagents: 0,
        mode: "child",
        status: "error",
        error: (e as Error).message,
      };
    } finally {
      await endRun(ctx, "ok");
    }
    process.stdout.write(JSON.stringify(summary) + "\n");
    return;
  }

  // Owned mode.
  const ctx = await startRun({
    dispatcher: "emit-harness",
    repo: "synthetic/harness",
    branch: "main",
  });
  if (opts.printRunId) {
    // Flush so a parent reading stdout (the Playwright fixture)
    // observes the runId without buffering delay.
    process.stdout.write(`RUN_ID=${ctx.runId}\n`);
  }
  if (ctx._disabled) {
    summary = {
      run_id: ctx.runId,
      disabled: true,
      duration_ms: Date.now() - startMs,
      subagents: 0,
      mode: "owned",
      status: "ok",
    };
    process.stdout.write(JSON.stringify(summary) + "\n");
    return;
  }
  const runHb = startRunHeartbeat(ctx);
  let count = 0;
  let firstSa: Awaited<ReturnType<typeof startSubAgent>> | null = null;
  let truncateTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < opts.subagentCount; i++) {
      const plant = i === 0;
      const isFirst = i === 0;
      tasks.push(
        runOneSubagent(
          ctx,
          `subagent-${i}`,
          opts.durationS,
          opts.emitRateBps,
          plant,
          isFirst
            ? (sa) => {
                firstSa = sa;
              }
            : undefined,
        ).then(() => {
          count++;
        }),
      );
    }
    if (opts.truncateAfterS > 0) {
      truncateTimer = setTimeout(() => {
        void triggerSyntheticTruncation(ctx, firstSa);
      }, Math.floor(opts.truncateAfterS * 1000));
    }
    let childProc: ReturnType<typeof spawn> | null = null;
    if (opts.multiProcess) {
      const harnessPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "observability_emit_harness.ts",
      );
      childProc = spawn(
        process.execPath,
        [
          "--experimental-strip-types",
          harnessPath,
          "--connect",
          ctx.runId,
          "--duration-s",
          "3",
          "--emit-rate-bps",
          String(opts.emitRateBps),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      tasks.push(
        new Promise<void>((resolve) => {
          childProc!.on("exit", () => resolve());
          childProc!.on("error", () => resolve());
        }),
      );
    }
    await Promise.all(tasks);
    summary = {
      run_id: ctx.runId,
      disabled: false,
      duration_ms: Date.now() - startMs,
      subagents: count,
      mode: "owned",
      status: "ok",
    };
  } catch (e) {
    summary = {
      run_id: ctx.runId,
      disabled: ctx._disabled,
      duration_ms: Date.now() - startMs,
      subagents: count,
      mode: "owned",
      status: "error",
      error: (e as Error).message,
    };
  } finally {
    if (truncateTimer !== null) clearTimeout(truncateTimer);
    await endRun(ctx, "ok");
    runHb.stop();
  }
  process.stdout.write(JSON.stringify(summary) + "\n");
}

/**
 * Send the writer daemon an `emit_chunk_truncated` request, which writes
 * a `chunk_truncated` JSONL record directly. Used by `--truncate-after-s`
 * for the Playwright E2E fixture to deterministically seed a retention
 * gap.
 *
 * The earlier design routed a 1.25 MiB base64 payload through the
 * daemon's `emit_chunk` undecodable-budget path, but the WriterClient
 * rejects any UDS frame larger than ~64 KiB (MAX_FRAME_BYTES). The
 * dedicated op keeps the frame tiny while producing the same JSONL
 * shape (`type: "chunk_truncated"` with `bytes_dropped` + `reason`),
 * which the tailer + UI gap-marker renderer pick up unchanged.
 */
async function triggerSyntheticTruncation(
  ctx: Awaited<ReturnType<typeof startRun>>,
  sa: Awaited<ReturnType<typeof startSubAgent>> | null,
): Promise<void> {
  if (ctx._disabled || ctx._client === null || sa === null) return;
  try {
    await ctx._client.send({
      op: "emit_chunk_truncated",
      subagent_id: sa.id,
      stream: "stdout",
      bytes_dropped: 1_310_720,
      reason: "synthetic_harness_seed",
    });
  } catch (e) {
    process.stderr.write(
      `[observability_emit_harness] truncation trigger failed: ${
        (e as Error).message
      }\n`,
    );
  }
}

const isEntry =
  import.meta.url ===
  (process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(
      `[observability_emit_harness] fatal: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
}
