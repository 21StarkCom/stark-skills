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
  /** Set when WE killed it: code `ETIMEDOUT` or `ENOBUFS`, as `spawnSync` does. */
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

/** Signal a whole group; one that is already gone (ESRCH) is not an error. */
function killGroup(pgid: number, signal: NodeJS.Signals): void {
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
 * Handlers live only while a child does: a listener on SIGINT replaces Node's
 * default exit, so one left installed would make an idle tool ignore Ctrl-C.
 */
function trackGroup(pgid: number): void {
  // Keyed on the flag, not on an empty set: `forward` uninstalls with groups
  // still live, so a process that somehow outlives its re-raise must be able
  // to re-arm on the next spawn.
  if (!installed) {
    installed = true;
    for (const s of FORWARDED) process.on(s, forward);
  }
  liveGroups.add(pgid);
}

function releaseGroup(pgid: number): void {
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
      if (pgid !== undefined) killGroup(pgid, "SIGKILL");
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
        status: code,
        signal: signal ?? null,
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
