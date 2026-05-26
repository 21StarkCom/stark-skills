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

  const runHb = startRunHeartbeat(ctx);
  return { ctx, ownsRun, runHb };
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
