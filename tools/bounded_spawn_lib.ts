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
 * The claim on a group is exported as ONE door, `makeGroupKiller` (STARK-6377,
 * STARK-6735): tracking, the ESRCH latch and the release travel together, keyed
 * per call. `jury_dispatch.ts::realRunner` detaches its seats too and takes the
 * same door, keeping only its own SIGTERM → grace → SIGKILL ladder. There used
 * to be a bare `trackGroup`/`releaseGroup` pair keyed by group id; an id is not
 * an identity once the kernel recycles it, so that pair is gone.
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

/**
 * One in-flight call's claim on a group id (== the detached child's pid).
 * `gone` is the ESRCH latch, and it lives HERE rather than in a closure so both
 * doors that signal a group — the call's own killer and `forward` — read and
 * set the same one.
 */
interface GroupHandle {
  readonly pgid: number;
  gone: boolean;
}

/**
 * Every call still in flight, keyed by CALL — object identity — never by id
 * (STARK-6735). An id-keyed set cannot tell two calls apart once the kernel
 * recycles an id: a call whose group emptied would, on settling, delete the
 * entry a CONCURRENT call had made for the same number, leaving a live agent
 * deaf to Ctrl-C. A handle can only ever drop itself.
 */
const liveGroups = new Set<GroupHandle>();

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

/**
 * Signal one call's group. Returns whether the kernel ACCEPTED the signal — for
 * `0`, that the group exists. ESRCH latches the handle and drops it from the
 * forwarding set: a group id is ours only while the group has members, so once
 * the kernel says it is gone nothing may follow, by either door. Any other
 * error (EPERM) is not a verdict on the group and latches nothing.
 */
function signalHandle(h: GroupHandle, signal: NodeJS.Signals | 0): boolean {
  if (h.gone) return false;
  try {
    process.kill(-h.pgid, signal);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") {
      h.gone = true;
      dropHandle(h);
    }
    return false;
  }
}

function forward(signal: NodeJS.Signals): void {
  // Through `signalHandle`, so forwarding has the latch the per-call killer has
  // (STARK-6735). It used to go through a bare id-keyed kill that swallowed
  // ESRCH and untracked nothing: a group an in-group descendant kept alive past
  // the exit probe, and that emptied later, was re-signalled on EVERY Ctrl-C an
  // embedding tool's own handler survived. Copied first — a latch that trips
  // mid-loop deletes from the set being walked.
  //
  // Read BEFORE the loop, never after it. A latch that trips on the LAST claim
  // untracks, which removes this very listener mid-delivery: counted afterwards,
  // an embedding tool's handler is the only one left, reads as "sole", and gets
  // the re-raise below — one Ctrl-C delivered twice, the exact failure this
  // guard exists to prevent, reintroduced by giving `forward` the latch.
  const others = process.listenerCount(signal) > 1;
  for (const h of [...liveGroups]) signalHandle(h, signal);
  // Another listener means the embedding tool handles this signal itself. It
  // has already received THIS delivery, and our listener displaced no default
  // disposition — so re-raising would hand it one Ctrl-C twice (measured: its
  // handler fired 2x), and uninstalling would leave a still-live group deaf to
  // the next one.
  if (others) return;
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
 * Forward the operator's SIGINT/SIGTERM/SIGHUP to this call's detached group
 * until its handle is dropped. Private: the only way in is `makeGroupKiller`,
 * which pairs the claim with the release that ends it.
 *
 * Handlers live only while a child does: a listener on SIGINT replaces Node's
 * default exit, so one left installed would make an idle tool ignore Ctrl-C.
 */
function addHandle(pgid: number): GroupHandle {
  // Keyed on the flag, not on an empty set: `forward` uninstalls with groups
  // still live, so a process that somehow outlives its re-raise must be able
  // to re-arm on the next spawn.
  if (!installed) {
    installed = true;
    for (const s of FORWARDED) process.on(s, forward);
  }
  const h: GroupHandle = { pgid, gone: false };
  liveGroups.add(h);
  return h;
}

/** Idempotent BY IDENTITY: a handle can drop only itself, and only once. */
function dropHandle(h: GroupHandle): void {
  if (!liveGroups.delete(h)) return;
  if (liveGroups.size === 0) untrack();
}

/**
 * The ONE door to a detached group (STARK-6377, STARK-6735): it CLAIMS the
 * group for Ctrl-C forwarding, returns the latched signaller, and carries the
 * release that ends the claim. Every detached spawn path takes it from here —
 * `spawnBounded` below, `agent_dispatch_lib.ts::run`, that file's Codex mirror,
 * and `jury_dispatch.ts::realRunner` — for the reason `isSignallableGroup` is
 * exported: a safety rule kept in several copies drifts, and this one did.
 * STARK-6245 taught the `spawnBounded` copy to release the group on ESRCH while
 * both `run()` copies kept a bare latch, so a Ctrl-C could still reach a
 * recycled id through `forward` on the path that spawns agents.
 *
 * Call it synchronously, right after `spawn()` returns: forwarding is armed
 * from this call on, and a Ctrl-C landing before it kills the tool by default
 * disposition and orphans the child (the window STARK-6135's tests wait out).
 *
 * A group id is ours only while the group has members: once it empties the
 * kernel is free to reuse it, and `process.kill(-pgid)` signals whoever holds it
 * NOW. A call can outlive its own child — `close` needs the stdio pipes closed,
 * so a descendant that inherited them AND left the group (`setsid`) keeps the
 * call open with the group already empty. So ESRCH latches: nothing follows the
 * kernel saying the group is gone.
 *
 * The forwarding set learns it in the same breath, because killer and `forward`
 * share one handle and one latch (`signalHandle`): whichever door hears ESRCH
 * first closes both. Untracking is also the honest state — with the group gone
 * there is nothing left to forward to, so Node's default exit is the right
 * disposition again.
 *
 * Signal `0` delivers nothing, which makes it the probe: call it from the
 * leader's `exit`, the first moment the group can have emptied with the call
 * still open and the last at which the id cannot yet have been reused.
 *
 * Jury keeps its own SIGTERM → grace → SIGKILL ladder (`killProcessGroup`,
 * which reports survivors and takes an injected `kill`), so it uses the claim,
 * the exit probe, `gone` and the release — and skips its ladder when `gone`
 * says the group emptied before the timeout.
 *
 * An unusable id (`undefined`, or one `isSignallableGroup` refuses) yields an
 * inert killer: nothing tracked, nothing signalled, `gone` false.
 */
export function makeGroupKiller(pgid: number | undefined): GroupKiller {
  const h = pgid !== undefined && isSignallableGroup(pgid) ? addHandle(pgid) : null;
  const kill = (signal: NodeJS.Signals | 0): boolean => h !== null && signalHandle(h, signal);
  return Object.defineProperties(kill, {
    release: { value: (): void => { if (h !== null) dropHandle(h); } },
    gone: { get: (): boolean => h !== null && h.gone },
  }) as GroupKiller;
}

/** What `makeGroupKiller` returns: the latched signaller plus THIS CALL's claim. */
export interface GroupKiller {
  /**
   * Signal the group. `true` only when the kernel ACCEPTED it — so a caller
   * reporting what it sent can tell a delivered SIGKILL from one the latch
   * swallowed (STARK-6735: `run()` used to report a SIGKILL it never sent).
   */
  (signal: NodeJS.Signals | 0): boolean;
  /**
   * End this call's claim on the forwarding set. By identity, so idempotent per
   * CALL: once the latch has let an id go the kernel may hand it to a
   * concurrent call's child, and a release keyed by id would then delete THAT
   * call's claim and leave a live agent deaf to Ctrl-C — the recycled-id hazard
   * this factory exists for, turned on our own bookkeeping. Every settle path
   * MUST call it.
   */
  release(): void;
  /** The kernel has reported this group gone; nothing more may be sent to its id. */
  readonly gone: boolean;
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
    // Without the latch `terminate`'s SIGKILL can land at the timeout on a
    // stranger holding a recycled id — see `makeGroupKiller`.
    const killOwnGroup = makeGroupKiller(pgid);
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
      // The claim ends here, by identity — never by id: if the latch has already
      // let the id go, that number may be another call's by now.
      killOwnGroup.release();
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
      // Whether the kernel ACCEPTED it (STARK-6735). Over a group the latch
      // already holds gone — a leader that exited by itself, an escaped
      // descendant holding stdout so `close` never came — this sends nothing.
      const sent = pgid !== undefined ? killOwnGroup("SIGKILL") : child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      const done = () => settle({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: null,
        // Never an invented SIGKILL, the defect `run()` lost in the same change:
        // one we delivered, else however the leader really ended (read here, at
        // settle, since it may exit between the kill and its reaping). `status:
        // null` and `error` are what say the bound fired — callers name the
        // cause from `error`, so this field only has to be TRUE.
        signal: sent ? "SIGKILL" : child.signalCode,
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
