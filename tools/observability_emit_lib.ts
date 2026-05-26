/**
 * Emit-lib client for the stark-review observability stack (Phase 2 Task 1,
 * Task 4, Task 6, Task 8, Task 9). The emit lib is a THIN client that
 * round-trips ops to the per-run writer daemon over a Unix domain socket.
 * The daemon (`observability_writer_daemon.ts`) is the single owner of the
 * writer queue, seq allocation, rotation, byte budgets, redaction, and the
 * run-heartbeat timer.
 *
 * Public surface (the exact set the dispatchers in Phase 6 wire to):
 *
 *   startRun({dispatcher, repo, branch, prNumber, trackedParentPid, byteBudgetBytes})
 *     Spawns the writer daemon, awaits the readiness handshake, returns a
 *     `RunCtx` wired to it.
 *   connectRun(runId)
 *     Connects to an existing daemon, awaits the readiness ping, returns a
 *     `RunCtx` wired to it.
 *   startSubAgent(ctx, opts)
 *   endSubAgent(ctx, sa, status, durationMs?, summary?)
 *   emitProgress(ctx, sa, kind, payload)
 *   attachChild(ctx, sa, child) → { drain }  // taps stdout/stderr without consume
 *   startHeartbeat(ctx, sa)                  // returns { stop }
 *   startRunHeartbeat(ctx)                   // returns { stop } — no-op on non-owned ctx
 *   endRun(ctx, status)
 *
 * The `{ stop }` returned by `startHeartbeat` / `startRunHeartbeat` is
 * strictly a timer cancel (Phase 2 Task 8). The dispatcher MUST call the
 * lifecycle (`endSubAgent` / `endRun`) BEFORE `.stop()` — `.stop()` does
 * NOT itself end anything.
 *
 * Disabled-state semantics (Phase 2 Task 9): on any startup failure (no
 * mkdir, daemon-spawn fail, ENOSPC, mode 000 dir, `OBSERVABILITY_DISABLED=1`
 * env), `startRun` returns a stub `RunCtx` whose every method is a silent
 * no-op. The dispatcher's call sites run unchanged.
 */

import { isUtf8 } from "node:buffer";
import { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

import {
  ensurePrivateDir,
  ensureRoot,
  runDir,
  runsDir,
  writerCapPath,
  writerSocketPath,
} from "./observability_paths_lib.ts";

const DAEMON_READY_TIMEOUT_MS = 5000;
const CONNECT_RUN_TIMEOUT_MS = 1000;
const DAEMON_READY_POLL_MS = 25;
const LOW_DISK_THRESHOLD_BYTES = 1024 * 1024 * 1024; // 1 GiB
const MAX_CHUNK_REQUEST_BYTES = 56 * 1024; // 56 KiB — leaves headroom under daemon's 64 KiB request cap
const SUBAGENT_HEARTBEAT_DEFAULT_S = 30;
const PER_RUN_BUDGET_DEFAULT_MB = 2048;

export interface RunOptions {
  dispatcher: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  /** Absolute path to the working checkout this run came from. Lets
   *  the UI tree separate runs out of a git worktree
   *  (`.worktrees/<name>`) from the primary checkout under the same
   *  repo+branch. dispatcher_helpers.initRunCtx() defaults this to
   *  `git rev-parse --show-toplevel` when unset. */
  worktreePath?: string;
  trackedParentPid?: number;
  byteBudgetBytes?: number;
  /** Test seam: override the writer daemon script path. */
  writerDaemonScript?: string;
  /** Test seam: when set, calls process.exit only if false. */
  noExit?: boolean;
  /** Optional extra meta fields written into meta.json. */
  meta?: Record<string, unknown>;
}

export interface SubAgent {
  id: string;
  agent: string;
  model: string;
  task: string;
  startedAtMs: number;
}

export interface RunCtx {
  /** Run id minted by `startRun` (UUID v4). */
  runId: string;
  /** True if this ctx OWNS the writer daemon (i.e., spawned it). False if
   * connected via connectRun — child dispatchers reuse the parent's
   * daemon. */
  _isOwned: boolean;
  /** True if observability is disabled for this ctx (silent no-op). */
  _disabled: boolean;
  /** Internal-only: handle to the WriterClient that holds the UDS connection.
   * Tests poke at this. Dispatchers must not. */
  _client: WriterClient | null;
  /** Cached run-heartbeat handle while one is active (defense against
   * accidentally double-starting on the same ctx). */
  _runHb?: { stop: () => void };
}

class AlreadyDisabledError extends Error {}

/**
 * Tiny stateful UDS client. Holds the socket, framing buffer, and a
 * single-request-at-a-time queue. Reconnection is the caller's job — the
 * emit lib paints a fail-fast `_disabled` flag onto the ctx if the daemon
 * disappears.
 */
export class WriterClient {
  private socket: net.Socket | null = null;
  private pendingResolvers: Array<(value: Record<string, unknown>) => void> = [];
  private pendingRejectors: Array<(err: Error) => void> = [];
  private buffer = "";
  private connected = false;
  private disconnected = false;
  private inflightLock: Promise<void> = Promise.resolve();
  readonly socketPath: string;
  readonly cap: string;

  constructor(socketPath: string, cap: string) {
    this.socketPath = socketPath;
    this.cap = cap;
  }

  isConnected(): boolean {
    return this.connected && !this.disconnected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.disconnected) throw new Error("client previously disconnected");
    const sock = net.createConnection(this.socketPath);
    sock.setEncoding("utf8");
    this.socket = sock;
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => {
        sock.off("error", reject);
        resolve();
      });
      sock.once("error", reject);
    });
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", (err) => this.onError(err));
    sock.on("close", () => this.onClose());
    this.connected = true;
    // Send the hello frame so subsequent ops authenticate.
    const helloResp = await this.send({ op: "hello", cap: this.cap });
    if (helloResp.ok !== true) {
      throw new Error(`hello rejected: ${JSON.stringify(helloResp)}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch (e) {
        const resolver = this.pendingRejectors.shift();
        this.pendingResolvers.shift();
        resolver?.(new Error(`malformed daemon reply: ${(e as Error).message}`));
        continue;
      }
      const resolver = this.pendingResolvers.shift();
      this.pendingRejectors.shift();
      resolver?.(parsed);
    }
  }

  private onError(err: Error): void {
    // Drain any pending resolvers with the error.
    const pendingRejs = this.pendingRejectors.splice(0);
    this.pendingResolvers.splice(0);
    for (const rej of pendingRejs) rej(err);
  }

  private onClose(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.connected = false;
    const pendingRejs = this.pendingRejectors.splice(0);
    this.pendingResolvers.splice(0);
    for (const rej of pendingRejs) rej(new Error("daemon socket closed"));
  }

  async send(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disconnected) throw new Error("client disconnected");
    if (!this.socket) throw new Error("client not connected");
    // Serialize sends so the response order matches the request order.
    const release = await this.acquire();
    try {
      const line = JSON.stringify(request) + "\n";
      if (Buffer.byteLength(line, "utf8") > MAX_CHUNK_REQUEST_BYTES + 8 * 1024) {
        throw new Error("request exceeds frame cap");
      }
      const p = new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pendingResolvers.push(resolve);
        this.pendingRejectors.push(reject);
      });
      this.socket.write(line);
      return await p;
    } finally {
      release();
    }
  }

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prev = this.inflightLock;
    this.inflightLock = prev.then(() => next);
    return prev.then(() => release);
  }

  close(): void {
    if (this.socket) {
      try {
        this.socket.end();
      } catch {
        // ignore
      }
      try {
        this.socket.destroy();
      } catch {
        // ignore
      }
    }
    this.disconnected = true;
    this.connected = false;
    this.socket = null;
  }
}

function isObservabilityDisabledByEnv(): boolean {
  return process.env.OBSERVABILITY_DISABLED === "1";
}

function makeDisabledCtx(runId: string, reason: string): RunCtx {
  // Log once per process via a sentinel on globalThis.
  const key = "__obs_disabled_logged__";
  const g = globalThis as Record<string, unknown>;
  if (!g[key]) {
    g[key] = true;
    try {
      process.stderr.write(
        `[observability] DISABLED — reason: ${reason}\n`,
      );
    } catch {
      // ignore
    }
  }
  return {
    runId,
    _isOwned: false,
    _disabled: true,
    _client: null,
  };
}

async function waitForReady(
  socketPath: string,
  runId: string,
  mode: "startup" | "existing" = "startup",
): Promise<{ cap: string }> {
  // "startup" (startRun): the daemon is still spawning; tolerate transient
  // ECONNREFUSED while the bind races completion, capped at 5 s.
  // "existing" (connectRun): the daemon SHOULD already be listening; a stale
  // socket with ECONNREFUSED means the daemon died, so fast-fail within ~1 s
  // instead of stalling the dispatcher for 5 s.
  const timeoutMs =
    mode === "existing" ? CONNECT_RUN_TIMEOUT_MS : DAEMON_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  // Poll until the socket exists, then probe ping until ready.
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) break;
    await sleep(DAEMON_READY_POLL_MS);
  }
  if (!fs.existsSync(socketPath)) {
    throw new Error("daemon socket never appeared");
  }
  return await pingUntilReady(socketPath, runId, deadline, mode);
}

async function pingUntilReady(
  socketPath: string,
  runId: string,
  deadline: number,
  mode: "startup" | "existing",
): Promise<{ cap: string }> {
  // Ping is unauthenticated per the protocol. Once the daemon reports
  // ready=true we mint a single-use ephemeral cap via the writer-owned
  // `caps_issue` op (RT1). Filesystem access to `writer.cap` (0600) is
  // what proves the caller belongs to the owning UID; the daemon hands
  // out a 60 s single-use token bound to this run that the WriterClient
  // then presents on its `hello` frame. A snooped ephemeral cap cannot
  // be replayed — the daemon removes it from `pendingCaps` on first use.
  while (Date.now() < deadline) {
    try {
      const resp = await probeRequest(socketPath, { op: "ping" });
      if (
        resp.ok === true &&
        resp.ready === true &&
        resp.run_start_committed === true &&
        resp.run_heartbeat_committed === true
      ) {
        const cap = await mintEphemeralCap(socketPath, runId);
        return { cap };
      }
    } catch (e) {
      // For an existing daemon (connectRun): ECONNREFUSED/ENOTCONN on a
      // socket file that still exists means the daemon is dead (stale
      // socket). Bail immediately rather than polling for 5 s.
      const code = (e as NodeJS.ErrnoException | undefined)?.code;
      if (
        mode === "existing" &&
        (code === "ECONNREFUSED" || code === "ENOTCONN")
      ) {
        throw new Error(`stale socket: daemon not listening (${code})`);
      }
      // not ready yet — continue polling
    }
    await sleep(DAEMON_READY_POLL_MS);
  }
  throw new Error("daemon readiness timeout");
}

function readWriterIssuerSecret(runId: string): string {
  const capPath = writerCapPath(runId);
  let raw: string;
  try {
    raw = fs.readFileSync(capPath, "utf8");
  } catch (e) {
    throw new Error(`writer.cap unreadable: ${(e as Error).message}`);
  }
  const issuer = raw.trim();
  if (issuer.length === 0) {
    throw new Error("writer.cap is empty");
  }
  return issuer;
}

/**
 * Mint a single-use ephemeral cap from the writer daemon's `caps_issue`
 * endpoint (RT1). Reads the per-run issuer secret from `writer.cap`
 * (0600 — same-UID-only) and presents it; the daemon returns a fresh
 * 32-byte cap bound to this run with a 60 s TTL. The WriterClient
 * presents the returned cap on the first `hello` frame of its data-
 * protocol connection, and the daemon consumes it (single-use).
 */
async function mintEphemeralCap(
  socketPath: string,
  runId: string,
): Promise<string> {
  const issuer = readWriterIssuerSecret(runId);
  const resp = await probeRequest(socketPath, { op: "caps_issue", issuer });
  if (resp.ok !== true || typeof resp.cap !== "string" || !resp.cap) {
    const code = typeof resp.code === "string" ? resp.code : "caps_issue_failed";
    const err = typeof resp.error === "string" ? resp.error : "";
    throw new Error(`caps_issue rejected: ${code}${err ? ` — ${err}` : ""}`);
  }
  return resp.cap;
}

function probeRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    sock.setEncoding("utf8");
    let acc = "";
    const settle = (val: Record<string, unknown> | Error) => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      if (val instanceof Error) reject(val);
      else resolve(val);
    };
    sock.once("connect", () => {
      sock.write(JSON.stringify(request) + "\n");
    });
    sock.on("data", (data: string) => {
      acc += data;
      const nl = acc.indexOf("\n");
      if (nl === -1) return;
      const line = acc.slice(0, nl);
      try {
        settle(JSON.parse(line) as Record<string, unknown>);
      } catch (e) {
        settle(e as Error);
      }
    });
    sock.once("error", (err) => settle(err));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function lowDiskPreflight(): boolean {
  try {
    const s = fs.statfsSync(runsDir());
    const free = Number(s.bavail) * Number(s.bsize);
    return free < LOW_DISK_THRESHOLD_BYTES;
  } catch {
    return false;
  }
}

/**
 * Start a brand-new run. Spawns the writer daemon as a detached child,
 * awaits the readiness handshake, returns a wired-up RunCtx.
 */
export async function startRun(opts: RunOptions): Promise<RunCtx> {
  const runId = crypto.randomUUID();
  if (isObservabilityDisabledByEnv()) {
    return makeDisabledCtx(runId, "OBSERVABILITY_DISABLED=1");
  }
  try {
    ensureRoot();
  } catch (e) {
    return makeDisabledCtx(runId, `ensureRoot: ${(e as Error).message}`);
  }
  if (lowDiskPreflight()) {
    return makeDisabledCtx(runId, "low_disk");
  }
  try {
    ensurePrivateDir(runDir(runId));
  } catch (e) {
    return makeDisabledCtx(runId, `ensurePrivateDir: ${(e as Error).message}`);
  }
  const trackedParentPid = opts.trackedParentPid ?? process.pid;
  const byteBudgetBytes =
    opts.byteBudgetBytes ??
    (Number.parseInt(process.env.OBSERVABILITY_PER_RUN_MAX_MB ?? "", 10) ||
      PER_RUN_BUDGET_DEFAULT_MB) *
      1024 *
      1024;
  const meta = {
    dispatcher: opts.dispatcher,
    repo: opts.repo ?? null,
    branch: opts.branch ?? null,
    pr_number: opts.prNumber ?? null,
    worktree_path: opts.worktreePath ?? null,
    ...(opts.meta ?? {}),
  };
  const daemonScript =
    opts.writerDaemonScript ??
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "observability_writer_daemon.ts",
    );
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        "--experimental-strip-types",
        daemonScript,
        "--run-id",
        runId,
        "--spool-dir",
        runDir(runId),
        "--tracked-parent-pid",
        String(trackedParentPid),
        "--meta",
        JSON.stringify(meta),
      ],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          OBSERVABILITY_PER_RUN_MAX_MB: String(
            Math.max(1, Math.floor(byteBudgetBytes / (1024 * 1024))),
          ),
        },
      },
    );
    child.unref();
  } catch (e) {
    return makeDisabledCtx(runId, `spawn: ${(e as Error).message}`);
  }
  try {
    const { cap } = await waitForReady(writerSocketPath(runId), runId);
    const client = new WriterClient(writerSocketPath(runId), cap);
    await client.connect();
    return {
      runId,
      _isOwned: true,
      _disabled: false,
      _client: client,
    };
  } catch (e) {
    // Half-started daemon — best-effort cleanup.
    try {
      if (child && !child.killed && child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      fs.unlinkSync(writerSocketPath(runId));
    } catch {
      // ignore
    }
    return makeDisabledCtx(runId, `readiness: ${(e as Error).message}`);
  }
}

/**
 * Connect to an existing daemon for the given runId. Used by child
 * dispatchers in Phase 6 where `STARK_OBS_PARENT_RUN_ID` is set.
 */
export async function connectRun(runId: string): Promise<RunCtx> {
  if (isObservabilityDisabledByEnv()) {
    return makeDisabledCtx(runId, "OBSERVABILITY_DISABLED=1");
  }
  try {
    const { cap } = await waitForReady(writerSocketPath(runId), runId, "existing");
    const client = new WriterClient(writerSocketPath(runId), cap);
    await client.connect();
    return {
      runId,
      _isOwned: false,
      _disabled: false,
      _client: client,
    };
  } catch (e) {
    return makeDisabledCtx(runId, `connect: ${(e as Error).message}`);
  }
}

async function clientCall(
  ctx: RunCtx,
  req: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (ctx._disabled || !ctx._client) return null;
  let resp: Record<string, unknown>;
  try {
    resp = await ctx._client.send(req);
  } catch (e) {
    // Daemon disappeared mid-run. Fail-fast: set _disabled, log once, and
    // re-throw so the dispatcher's surrounding try/catch sees a real error.
    ctx._disabled = true;
    try {
      process.stderr.write(
        `[observability] writer daemon for ${ctx.runId} is gone — emit fails closed; dispatcher exiting non-zero\n`,
      );
    } catch {
      // ignore
    }
    throw e;
  }
  if (resp.ok !== true) {
    // Daemon explicitly rejected the op (bad shape, unknown op, etc.).
    // Returning {ok:false} silently would make callers like endSubAgent /
    // emitProgress / endRun / attachChild.drain treat a rejection as a
    // committed event. Throw so the dispatcher sees the failure.
    const code = typeof resp.code === "string" ? resp.code : "daemon_error";
    const err = typeof resp.error === "string" ? resp.error : "";
    throw new Error(
      `daemon rejected ${String(req.op)}: ${code}${err ? ` — ${err}` : ""}`,
    );
  }
  return resp;
}

export async function startSubAgent(
  ctx: RunCtx,
  opts: { agent: string; model: string; task: string },
): Promise<SubAgent> {
  const now = Date.now();
  if (ctx._disabled) {
    return { id: "disabled:0", agent: opts.agent, model: opts.model, task: opts.task, startedAtMs: now };
  }
  const resp = await clientCall(ctx, {
    op: "start_subagent",
    agent: opts.agent,
    model: opts.model,
    task: opts.task,
  });
  if (!resp) {
    // ctx went disabled mid-call (race) — return stub
    return { id: "disabled:0", agent: opts.agent, model: opts.model, task: opts.task, startedAtMs: now };
  }
  return {
    id: String(resp.subagent_id),
    agent: opts.agent,
    model: opts.model,
    task: opts.task,
    startedAtMs: now,
  };
}

export async function endSubAgent(
  ctx: RunCtx,
  sa: SubAgent,
  status: "ok" | "error" | "timeout",
  durationMs?: number,
  summary?: unknown,
): Promise<void> {
  if (ctx._disabled) return;
  await clientCall(ctx, {
    op: "end_subagent",
    subagent_id: sa.id,
    status,
    duration_ms: durationMs ?? Date.now() - sa.startedAtMs,
    summary: summary ?? null,
  });
}

export async function emitProgress(
  ctx: RunCtx,
  sa: SubAgent | null,
  kind: string,
  payload: unknown,
): Promise<void> {
  if (ctx._disabled) return;
  await clientCall(ctx, {
    op: "emit_progress",
    subagent_id: sa?.id ?? null,
    kind,
    payload: payload ?? null,
  });
}

export async function endRun(ctx: RunCtx, status: "ok" | "error" | "timeout"): Promise<void> {
  if (ctx._disabled) return;
  if (!ctx._isOwned) {
    // Child ctx: do not actually end the parent run; just close our client.
    ctx._client?.close();
    ctx._client = null;
    return;
  }
  await clientCall(ctx, { op: "end_run", status });
  ctx._client?.close();
  ctx._client = null;
}

/**
 * Attach a non-consuming tap to a spawned child's stdout/stderr (Phase 2
 * Task 4). Returns `{ drain }` so callers can await every UDS-write
 * acknowledgement before declaring the sub-agent ended (E2).
 *
 * Chunk splitting is performed against the serialized request size, not
 * raw buffer length: each `emit_chunk` request is at most 56 KiB so the
 * daemon's 64 KiB frame cap is never breached.
 */
export function attachChild(
  ctx: RunCtx,
  sa: SubAgent,
  child: ChildProcess,
): { drain: () => Promise<void> } {
  if (ctx._disabled) {
    return { drain: async () => {} };
  }
  const inflight: Array<Promise<unknown>> = [];
  const onChunk = (stream: "stdout" | "stderr") => (buf: Buffer) => {
    if (ctx._disabled) return;
    let pos = 0;
    while (pos < buf.length) {
      const remaining = buf.length - pos;
      // Compute a safe raw slice ceiling. Worst-case base64 expansion is
      // 4/3; UTF-8 JSON escape worst-case (e.g. NUL bytes → ` `,
      // 6 chars per byte) is ~6x. Start with 40 KiB and halve until the
      // serialized request fits — see loop below.
      let sliceLen = Math.min(remaining, 40 * 1024);
      let req: Record<string, unknown>;
      let requestSize = 0;
      // Loop the halving (E2/finding-#2): a single halve is not enough
      // for a JSON-escape-heavy payload (e.g. 64 KiB of NUL → 384 KiB
      // serialized). Keep halving until under cap or sliceLen == 1.
      while (true) {
        const slice = buf.subarray(pos, pos + sliceLen);
        const slicedUtf8 = isUtf8(slice);
        const encoding: "utf8" | "base64" = slicedUtf8 ? "utf8" : "base64";
        const chunkStr = slicedUtf8
          ? slice.toString("utf8")
          : slice.toString("base64");
        req = {
          op: "emit_chunk",
          subagent_id: sa.id,
          stream,
          encoding,
          chunk: chunkStr,
        };
        requestSize = Buffer.byteLength(JSON.stringify(req), "utf8");
        if (requestSize <= MAX_CHUNK_REQUEST_BYTES) break;
        if (sliceLen <= 1) break; // can't split further; daemon will reject
        sliceLen = Math.max(1, Math.floor(sliceLen / 2));
      }
      pos += sliceLen;
      const p = clientCall(ctx, req);
      // E2: do NOT swallow rejection — drain() must reject when a UDS
      // write fails so the dispatcher sees the daemon-lost failure
      // BEFORE endSubAgent runs. We attach a no-op handler to silence
      // Node's unhandled-rejection warning (the original `p` still
      // settles with the rejection and Promise.all in drain() will
      // observe it).
      p.catch(() => {});
      inflight.push(p);
    }
  };
  child.stdout?.on("data", onChunk("stdout"));
  child.stderr?.on("data", onChunk("stderr"));
  return {
    drain: async () => {
      // Snapshot inflight at the moment drain is called. Any chunk handler
      // that fires AFTER drain returns will not be in the awaited set, but
      // the dispatcher contract (E2) is that runProcess awaits stream "end"
      // BEFORE drain — so by the time drain runs there are no new chunks.
      await Promise.all(inflight.splice(0));
    },
  };
}

/**
 * Sub-agent heartbeat timer. Lives in the CALLER's process; the daemon
 * gets a `emit_subagent_heartbeat` op per tick.
 *
 * `{stop}` is strictly a timer cancel — it does NOT call `endSubAgent`.
 * Dispatcher contract: call `endSubAgent(...)` first, then `.stop()`.
 */
export function startHeartbeat(ctx: RunCtx, sa: SubAgent): { stop: () => void } {
  if (ctx._disabled) return { stop: () => {} };
  const intervalMs =
    (Number.parseInt(process.env.OBSERVABILITY_SUBAGENT_HEARTBEAT_S ?? "", 10) ||
      SUBAGENT_HEARTBEAT_DEFAULT_S) * 1000;
  const t = setInterval(() => {
    if (ctx._disabled) return;
    clientCall(ctx, { op: "emit_subagent_heartbeat", subagent_id: sa.id }).catch(
      () => {},
    );
  }, intervalMs);
  if (t.unref) t.unref();
  return {
    stop: () => {
      clearInterval(t);
    },
  };
}

/**
 * Run-heartbeat handle. The daemon owns the actual timer for owned ctxs;
 * the returned `{stop}` is intentionally a no-op so the dispatcher's call
 * shape (`runHb.stop()` AFTER `endRun(...)`) stays uniform across owned
 * and connected ctxs.
 *
 * For NON-owned ctxs (connectRun), this is a no-op — the parent daemon
 * already runs the timer.
 */
export function startRunHeartbeat(_ctx: RunCtx): { stop: () => void } {
  // The {stop} is intentionally an idempotent no-op; the daemon's own
  // timer is started at boot and stopped when end_run arrives.
  return { stop: () => {} };
}

export const __test = {
  MAX_CHUNK_REQUEST_BYTES,
  SUBAGENT_HEARTBEAT_DEFAULT_S,
  PER_RUN_BUDGET_DEFAULT_MB,
  AlreadyDisabledError,
  isObservabilityDisabledByEnv,
  makeDisabledCtx,
};
