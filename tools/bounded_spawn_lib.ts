/**
 * bounded_spawn_lib.ts — the ONE spawn primitive behind every `gh` subprocess
 * on the posting path (STARK-6131). `review_post_lib.ts::ghJsonOnce` and
 * `findings_review_post.ts::runCapturing` both wrap it.
 *
 * STARK-6113 bounded those children but killed only the DIRECT child: anything
 * `gh` had spawned was reparented to init and kept running — orphaned, not
 * bounded. The child therefore runs `detached`, i.e. as the leader of its OWN
 * process group, and every kill this file sends goes to the group (`-pid`).
 *
 * The price of `detached` is that the child leaves the terminal's foreground
 * process group, so an operator's Ctrl-C no longer reaches it. That is paid back
 * here, not left to callers: while any child is in flight SIGINT/SIGTERM/SIGHUP
 * are forwarded to every live group, then re-raised so this process still dies
 * by the signal exactly as it did before. An embedding tool that handles the
 * signal ITSELF is left to it: no re-raise (it would receive one Ctrl-C twice),
 * and the forwarding stays armed for the next one.
 *
 * What forwarding cannot pay back: Node's `detached` is `setsid()` — a new
 * SESSION, not only a new group — so a supervisor that SIGKILLs this tool's
 * process group no longer reaches `gh`, and nobody can forward a SIGKILL. A
 * `gh` hung at that moment outlives its bound, which died with this process.
 *
 * The forwarding half is exported on its own (`trackGroup`/`releaseGroup`,
 * STARK-6135): `jury_dispatch.ts::realRunner` detaches its seats too, and keeps
 * its own SIGTERM → grace → SIGKILL ladder, so it shares the tracking only.
 *
 * It is async-only on purpose. `spawnSync` blocks the event loop, so it can
 * neither group-kill (its `killSignal` goes to one pid) nor run a forwarding
 * handler — a `detached` `spawnSync` child is simply abandoned on Ctrl-C.
 */
import { spawn } from "node:child_process";

import { assertGhTimeoutMs } from "./child_termination_lib.ts";

export interface BoundedSpawnOpts {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Group-kill the child and settle after this long. Held to
   * `assertGhTimeoutMs` HERE as well as in both callers: this function is
   * exported, and `setTimeout` fires 0 / NaN / anything past 2^31-1 ms after
   * ~1 ms, so an unvalidated door kills every call it bounds.
   */
  timeoutMs?: number;
  /** Group-kill the child once stdout or stderr exceeds this many bytes. */
  maxBuffer?: number;
}

/** Same shape as `spawnSync`'s result, so `explainTermination` reads it directly. */
export interface BoundedSpawnResult {
  stdout: string;
  stderr: string;
  /** Exit code, or `null` when the child was terminated — a killed process has
   * no exit code, and inventing one (-1) throws the cause away. */
  status: number | null;
  signal: NodeJS.Signals | null;
  /**
   * Why `status` is null. Our own kills carry a code, as `spawnSync` does:
   * `ETIMEDOUT` or `ENOBUFS`. A read pipe that failed mid-stream carries only a
   * message — it is a termination we did not cause, and borrowing either code
   * would report a bound this file never enforced.
   */
  error?: Error;
}

/**
 * How long a kill waits for the direct child to be reaped before settling
 * anyway. SIGKILL cannot be ignored, so this only ever elapses for a child
 * stuck in uninterruptible I/O — the bound must still hold for that one.
 */
export const KILL_REAP_GRACE_MS = 2_000;

const FORWARDED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** Group ids (== the detached child's pid) of every child still in flight. */
const liveGroups = new Set<number>();

/**
 * A group id this file may signal. `process.kill(-pgid)` with 0 is THIS
 * process's own group and with 1 is `kill(-1)` — every process the user owns —
 * so neither may ever be tracked or signalled. Born as jury's
 * `killProcessGroup` guard and carried here by STARK-6135; exported so jury
 * imports this ONE predicate instead of keeping a second copy that could drift.
 */
export function isSignallableGroup(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1;
}

/** Signal a whole group; one that is already gone (ESRCH) is not an error. */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
  if (!isSignallableGroup(pgid)) return;
  try {
    process.kill(-pgid, signal);
  } catch {
    /* already gone, or not ours */
  }
}

function forward(signal: NodeJS.Signals): void {
  for (const pgid of liveGroups) killGroup(pgid, signal);
  // Another listener means the embedding tool handles this signal itself. It
  // has already received THIS delivery, and our listener displaced no default
  // disposition — so re-raising would hand it one Ctrl-C twice (measured: its
  // handler fired 2x), and uninstalling would leave a still-live group deaf to
  // the next one.
  if (process.listenerCount(signal) > 1) return;
  // We alone stood between the signal and Node's default exit: re-raise with
  // our handlers gone, so this process dies BY the signal as it did when the
  // terminal delivered it to parent and child alike.
  untrack();
  process.kill(process.pid, signal);
}

let installed = false;

function untrack(): void {
  if (!installed) return;
  installed = false;
  for (const s of FORWARDED) process.removeListener(s, forward);
}

/**
 * Forward the operator's SIGINT/SIGTERM/SIGHUP to this detached group until
 * `releaseGroup`. Exported as the forwarding HALF on its own (STARK-6135):
 * `jury_dispatch.ts::realRunner` spawns detached seats too but keeps its own
 * SIGTERM → grace → SIGKILL kill ladder, so it shares the tracking and nothing
 * else. Every caller MUST pair it with `releaseGroup` on every settle path.
 *
 * Handlers live only while a child does: a listener on SIGINT replaces Node's
 * default exit, so one left installed would make an idle tool ignore Ctrl-C.
 */
export function trackGroup(pgid: number): void {
  if (!isSignallableGroup(pgid)) return;
  // Keyed on the flag, not on an empty set: `forward` uninstalls with groups
  // still live, so a process that somehow outlives its re-raise must be able
  // to re-arm on the next spawn.
  if (!installed) {
    installed = true;
    for (const s of FORWARDED) process.on(s, forward);
  }
  liveGroups.add(pgid);
}

/** Idempotent: a second release of the same group is a no-op. */
export function releaseGroup(pgid: number): void {
  if (!liveGroups.delete(pgid)) return;
  if (liveGroups.size === 0) untrack();
}

export async function spawnBounded(
  cmd: string,
  args: string[],
  opts: BoundedSpawnOpts = {},
): Promise<BoundedSpawnResult> {
  // Refused BEFORE the spawn, like every other door the bound arrives by.
  if (opts.timeoutMs !== undefined) assertGhTimeoutMs(opts.timeoutMs, "spawnBounded timeoutMs");
  return await new Promise<BoundedSpawnResult>((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
      detached: true,
    });
    const pgid = child.pid;
    if (pgid !== undefined) trackGroup(pgid);
    /**
     * A group id is ours only while the group has members: once it empties the
     * kernel is free to reuse it, and `process.kill(-pgid)` signals whoever
     * holds it NOW. That matters here precisely because this call can outlive
     * its own child — `close` needs the stdio pipes closed, so a descendant
     * that inherited them AND left the group (`setsid`) keeps the call open
     * with the group already empty, and `terminate`'s SIGKILL then lands at the
     * timeout on a stranger. So ESRCH latches: nothing follows the kernel
     * saying the group is gone. Same guard `agent_dispatch_lib.ts::run` carries
     * (STARK-6147); it belongs in the shared primitive too.
     */
    let groupGone = false;
    const killOwnGroup = (signal: NodeJS.Signals | 0): void => {
      if (groupGone || pgid === undefined || !isSignallableGroup(pgid)) return;
      try {
        process.kill(-pgid, signal);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") return;
        groupGone = true;
        // The forwarding set has to learn it too, or the latch protects only
        // half the file: `forward` signals every id in `liveGroups` through the
        // module-level `killGroup`, which knows nothing about this latch and
        // does not settle with the call. A Ctrl-C arriving after the group
        // emptied — the window this whole guard exists for, a `setsid`
        // descendant holding the pipes open — would then deliver the recycled-id
        // signal by the other door. Untracking is also the honest state: with
        // the group gone there is nothing left to forward to, so Node's default
        // exit is the right disposition again.
        releaseGroup(pgid);
      }
    };
    // The leader's exit is the first moment the group can have emptied with
    // this call still open. Probe with signal 0 — which delivers nothing —
    // while the id cannot yet have been reused.
    child.once("exit", () => killOwnGroup(0));
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed: BoundedSpawnResult | null = null;
    let settled = false;
    let killing = false;
    let timer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    /** Claim the one settlement; false when an earlier outcome already won. */
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      // Cleared on EVERY settle, resolve and reject alike: a live 120 s timer
      // would hold the process open long after the `gh` call it bounded returned.
      clearTimeout(timer);
      clearTimeout(reapTimer);
      if (pgid !== undefined) releaseGroup(pgid);
      return true;
    };
    const settle = (r: BoundedSpawnResult) => { if (claim()) resolve(r); };
    const tryFinish = () => {
      if (closed === null || killing) return;
      if (!stdoutEnded || !stderrEnded) return;
      settle(closed);
    };
    /**
     * OUR termination: SIGKILL the whole group, then settle once the direct
     * child is reaped. SIGKILL, not SIGTERM — a bound the child can ignore is
     * not a bound. Never settle on `close`: it waits for the stdio pipes, and a
     * descendant that inherited them and somehow outlives the kill would turn
     * the bound into one that holds only for well-behaved children. Whatever
     * arrives later is discarded; partial output is never a result.
     */
    const terminate = (error: Error) => {
      if (settled || killing) return;
      killing = true;
      clearTimeout(timer);
      if (pgid !== undefined) killOwnGroup("SIGKILL");
      else child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      const done = () => settle({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: null,
        signal: "SIGKILL",
        error,
      });
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once("exit", done);
      reapTimer = setTimeout(done, KILL_REAP_GRACE_MS);
    };
    const overflow = () => terminate(
      Object.assign(new Error(`${cmd} output exceeded maxBuffer`), { code: "ENOBUFS" }),
    );
    child.stdout.on("data", (b: Buffer) => {
      if (killing) return;
      out.push(b);
      outBytes += b.length;
      if (opts.maxBuffer !== undefined && outBytes > opts.maxBuffer) overflow();
    });
    child.stderr.on("data", (b: Buffer) => {
      if (killing) return;
      err.push(b);
      errBytes += b.length;
      if (opts.maxBuffer !== undefined && errBytes > opts.maxBuffer) overflow();
    });
    child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    /**
     * An unlistened stream 'error' is an uncaught exception — the same class the
     * `child.stdin` listener below exists for, and on the same object graph. It
     * is worse on a READ pipe: a stream that errors never emits 'end', so the
     * settle gate would be held shut anyway. So release that stream's gate —
     * but NOT silently. A failed read pipe means bytes were lost, and `close`
     * still carries the child's own exit code: settling on it alone hands the
     * caller a truncated stdout wearing a clean `status: 0`. That is exactly the
     * shape every caller here is built to refuse — `ghJsonOnce` checks
     * `status === null` BEFORE parsing precisely because a `gh api --paginate`
     * cut short leaves complete HTTP blocks that parse as a 200 silently missing
     * every later page. So the first failure is remembered and reported as a
     * termination (`status: null` + a cause `explainTermination` can name);
     * whatever was read is still returned, as partial output always is.
     */
    let pipeError: Error | null = null;
    const onPipeError = (which: "stdout" | "stderr") => (e: Error) => {
      // No `code` is copied onto it: ENOBUFS and ETIMEDOUT are how
      // `explainTermination` recognises OUR OWN kills, and a pipe failure
      // borrowing one would be reported as a bound this file never enforced.
      pipeError ??= new Error(
        `${cmd} ${which} pipe failed before the stream ended ` +
          `(${(e as NodeJS.ErrnoException).code ?? e.message}); its output is incomplete`,
      );
      if (which === "stdout") stdoutEnded = true;
      else stderrEnded = true;
      tryFinish();
    };
    child.stdout.on("error", onPipeError("stdout"));
    child.stderr.on("error", onPipeError("stderr"));
    child.on("error", (e) => { if (claim()) reject(e); });
    if (opts.timeoutMs !== undefined) {
      const ms = opts.timeoutMs;
      timer = setTimeout(() => terminate(
        Object.assign(new Error(`${cmd} timed out after ${ms} ms`), { code: "ETIMEDOUT" }),
      ), ms);
    }
    child.on("close", (code, signal) => {
      closed = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        // A read pipe that failed lost bytes, so the child's exit code is not
        // the outcome: `status: null` is the one signal every caller reads as
        // "this output is a terminated child's, never a result".
        status: pipeError === null ? code : null,
        signal: signal ?? null,
        ...(pipeError === null ? {} : { error: pipeError }),
      };
      tryFinish();
    });
    // A child that dies before draining its stdin fails the queued write with
    // EPIPE on `child.stdin`, and an unlistened stream 'error' is an uncaught
    // exception: it kills the whole tool before `close` can say WHY the child
    // died. Only a body larger than the pipe buffer is still queued at that
    // point — i.e. exactly the large review POSTs. `close` is the authoritative
    // outcome, so the write error itself is dropped.
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
