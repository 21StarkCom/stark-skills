/**
 * Phase 6 Task 2 — shared dispatcher integration helpers.
 *
 * Centralizes the lifecycle boilerplate every `/stark-*` TS dispatcher
 * follows: resolve `STARK_OBS_PARENT_RUN_ID`, call `startRun` / `connectRun`,
 * emit the `child-run-link` progress event when joining a parent, start the
 * run-heartbeat handle, expose a `withSubAgent` wrapper that brackets each
 * sub-agent with `startSubAgent` + `startHeartbeat` (caller-process timer)
 * and tears them down in the right order: lifecycle (`endSubAgent`) FIRST,
 * then `.stop()` (timer cancel only — Phase 2 Task 8).
 *
 * The single-ownership rule (dispatcher owns lifecycle; `run` only attaches
 * taps) is preserved: the actual `attachChild` happens inside the
 * subprocess helpers via the `observability` parameter (Phase 6 Task 1).
 * This module performs NO `attachChild` itself.
 *
 * Disabled-state semantics are inherited from `observability_emit_lib`:
 * a stub `RunCtx` is returned, every method silently no-ops, and `withSubAgent`
 * still drives the inner callback so dispatchers keep working with
 * observability off.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  connectRun,
  emitProgress,
  endRun,
  endSubAgent,
  startHeartbeat,
  startRun,
  startRunHeartbeat,
  startSubAgent,
  type RunCtx,
  type RunOptions as EmitRunOptions,
  type SubAgent,
} from "./observability_emit_lib.ts";
import { writerPidPath } from "./observability_paths_lib.ts";

export interface DispatcherLifecycle {
  ctx: RunCtx;
  /** Whether this process owns (spawned) the writer daemon for `ctx`. */
  ownsRun: boolean;
  /** Run-heartbeat handle. `.stop()` is a timer cancel only — Phase 2 Task 8.
   * Dispatcher MUST call `await finishRun(...)` BEFORE `.stop()`. */
  runHb: { stop: () => void };
}

export interface InitRunCtxOptions extends Omit<EmitRunOptions, "trackedParentPid"> {
  /** Optional override; defaults to `process.env.STARK_OBS_PARENT_RUN_ID`. */
  parentRunIdEnv?: string | undefined;
}

/**
 * Acquire a RunCtx for a dispatcher main(). When STARK_OBS_PARENT_RUN_ID is
 * set, this connects to the existing parent writer daemon and emits a
 * `child-run-link` progress event so the parent's JSONL shows the child
 * joining. Otherwise it starts a brand-new run with this process as the
 * tracked-parent (daemon's liveness poll target).
 *
 * The returned `runHb` is a no-op for non-owned ctxs (Phase 2 Task 8) so
 * the dispatcher's call-shape stays uniform.
 */
export async function initRunCtx(opts: InitRunCtxOptions): Promise<DispatcherLifecycle> {
  const parentRunId =
    opts.parentRunIdEnv !== undefined
      ? opts.parentRunIdEnv
      : process.env.STARK_OBS_PARENT_RUN_ID;
  const ownsRun = !parentRunId;

  const ctx = ownsRun
    ? await startRun({
        dispatcher: opts.dispatcher,
        repo: opts.repo,
        branch: opts.branch,
        prNumber: opts.prNumber,
        trackedParentPid: process.pid,
        byteBudgetBytes: opts.byteBudgetBytes,
        meta: opts.meta,
      })
    : await connectRun(parentRunId!);

  if (!ownsRun) {
    // Best-effort: announce the join. emitProgress is a silent no-op on
    // disabled ctxs and a thrown daemon-rejected error is swallowed so a
    // dead parent doesn't break the child's actual work.
    try {
      await emitProgress(ctx, null, "child-run-link", {
        child_dispatcher: opts.dispatcher,
        child_pid: process.pid,
      });
    } catch {
      // ignore
    }
  }

  // Phase 8 Task 4 — when the operator opts in via
  // STARK_OBS_WRITE_LIVE_RUN_METADATA=1, record the run's identifying
  // pids to ~/.claude/code-review/observability/test/live-run.json so the
  // destructive live-test scripts (dispatcher_*sigkill.sh,
  // pressure_retention.sh, host_boot_id_change.ts) can resolve
  // dispatcher_pid / writer_pid / run_id from harness bookkeeping rather
  // than from `pgrep`/`tail`. Owned ctxs only — connectRun children share
  // their parent's daemon and would overwrite the parent's metadata.
  if (
    ownsRun &&
    !ctx._disabled &&
    process.env.STARK_OBS_WRITE_LIVE_RUN_METADATA === "1"
  ) {
    try {
      maybeWriteLiveRunMetadata(ctx.runId);
    } catch (err) {
      process.stderr.write(
        `[obs] live-run.json write failed: ${(err as Error).message}\n`,
      );
    }
  }

  const runHb = startRunHeartbeat(ctx);
  return { ctx, ownsRun, runHb };
}

/**
 * Atomically write the live-run metadata. Used only when the operator
 * explicitly enables the live-test harness via the
 * `STARK_OBS_WRITE_LIVE_RUN_METADATA` env var on a real
 * `/stark-review` / `/stark-copilot` / etc. invocation. Schema matches
 * `tools/observability_server/test/live/live_run_metadata.ts` verbatim
 * so the destructive shell scripts can `jq -r` the same keys regardless
 * of which writer produced the file.
 *
 * The writer-daemon pid is read out of the per-run `writer.pid` file
 * that `startRun()` fsynced before returning. If the file can't be read
 * yet (rare race), `writer_pid` is recorded as `null` and the harness
 * scripts fall back to their own resolution.
 */
function maybeWriteLiveRunMetadata(runId: string): void {
  const outDir = path.join(
    os.homedir(),
    ".claude",
    "code-review",
    "observability",
    "test",
  );
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let writerPid: number | null = null;
  try {
    const raw = fs.readFileSync(writerPidPath(runId), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) writerPid = n;
  } catch {
    // writer.pid not yet readable — record null
  }
  const outPath = path.join(outDir, "live-run.json");
  const tmp = outPath + ".tmp";
  const payload = {
    harness_started_at: new Date().toISOString(),
    run_id: runId,
    dispatcher_pid: process.pid,
    writer_pid: writerPid,
    sentinel_pid: null,
  };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, outPath);
}

/**
 * Finish a run. For owned ctxs, calls `endRun(status)`; for non-owned
 * (connected) ctxs, closes the UDS client without touching the parent
 * daemon. Always returns even if the daemon is unreachable — disabled
 * state is handled inside the emit lib.
 *
 * Call BEFORE `runHb.stop()` so the daemon flush completes before the
 * timer is cancelled.
 */
export async function finishRun(
  lifecycle: DispatcherLifecycle,
  status: "ok" | "error" | "timeout",
): Promise<void> {
  if (!lifecycle.ownsRun) {
    // connectRun ctxs share the parent's daemon; just close our client.
    await endRun(lifecycle.ctx, status);
    return;
  }
  await endRun(lifecycle.ctx, status);
}

export interface SubAgentScope {
  sa: SubAgent;
  ctx: RunCtx;
}

export type SubAgentStatus = "ok" | "error" | "timeout";

export interface SubAgentOutcome<T> {
  value: T;
  status: SubAgentStatus;
  summary?: unknown;
}

/**
 * Run an async sub-agent task while owning its lifecycle ops. Calls
 * `startSubAgent` and `startHeartbeat` before invoking `fn`. After `fn`
 * resolves (or throws), `endSubAgent` runs FIRST, then the heartbeat
 * timer is cancelled (`.stop()` — Phase 2 Task 8).
 *
 * The inner `fn` receives `{ ctx, sa }` so it can construct the
 * `observability` parameter for `run()` / `runProcess()` invocations.
 *
 * On thrown errors, the sub-agent is closed with status "error" and a
 * summary `{ error: <message> }`, then the error is re-thrown so the
 * caller's existing try/catch sees it.
 */
export async function withSubAgent<T>(
  ctx: RunCtx,
  opts: { agent: string; model: string; task: string },
  fn: (scope: SubAgentScope) => Promise<SubAgentOutcome<T>>,
): Promise<T> {
  const sa = await startSubAgent(ctx, opts);
  const hb = startHeartbeat(ctx, sa);
  try {
    const outcome = await fn({ sa, ctx });
    await endSubAgent(
      ctx,
      sa,
      outcome.status,
      Date.now() - sa.startedAtMs,
      outcome.summary,
    );
    return outcome.value;
  } catch (e) {
    await endSubAgent(ctx, sa, "error", Date.now() - sa.startedAtMs, {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    hb.stop();
  }
}
