#!/usr/bin/env -S node --experimental-strip-types
/**
 * Per-run writer daemon for the stark-review observability stack (Phase 2
 * Task 2 + 3). One process per active run. Owns:
 *
 *   - The single JSONL writer queue (Promise-chain FIFO). All seq numbers
 *     are assigned here, monotonically; clients never trust a client-supplied
 *     seq.
 *   - Rotation of `events-NNNN.jsonl` once a file exceeds
 *     `OBSERVABILITY_MAX_FILE_BYTES` (default 100 MB).
 *   - Byte-budget accounting (`OBSERVABILITY_PER_RUN_MAX_MB`, default 2 GiB).
 *     Once exceeded, lifecycle/progress/heartbeat events still flow but
 *     stdout/stderr chunks are dropped after a single
 *     `subagent_progress { kind: "chunk-budget-exceeded" }` marker.
 *   - The run-heartbeat timer (10 s) — owned by the daemon, NOT the
 *     dispatcher.
 *   - The tracked-parent-pid poll (30 s). On ESRCH the daemon writes a
 *     final heartbeat + `run_end { status:"crashed", crashed_reason:"parent_exit" }`,
 *     rewrites `meta.json`, removes the sock/pid files, exits 0.
 *   - Per-(subagent_id, stream) `StreamRedactor` instances. The flush
 *     remainder on `end_subagent` is emitted as a final stdout/stderr event
 *     with a daemon-assigned seq ordered BEFORE the `subagent_end`.
 *   - Two durability tiers (RT5): tier-immediate (fsync per write) for
 *     lifecycle/findings/redacted events, tier-batched (group-commit every
 *     50 events or 100 ms) for chunks/heartbeats/non-finding progress.
 *
 * Wire protocol (newline-delimited JSON over UDS, request/response):
 *
 *   client → daemon
 *     {"op":"hello","cap":"..."}
 *     {"op":"start_subagent","agent":"...","model":"...","task":"..."}
 *     {"op":"end_subagent","subagent_id":"<id>","status":"ok",...}
 *     {"op":"emit_progress","subagent_id":"<id>|null","kind":"finding","payload":{...}}
 *     {"op":"emit_chunk","subagent_id":"<id>","stream":"stdout","encoding":"utf8","chunk":"..."}
 *     {"op":"emit_subagent_heartbeat","subagent_id":"<id>"}
 *     {"op":"end_run","status":"ok"|"error"|"timeout"}
 *     {"op":"ping"}
 *
 *   daemon → client
 *     {"ok":true,"subagent_id":"<id>"}            // start_subagent
 *     {"ok":true,"seq":N}                          // every write op
 *     {"ok":true,"ready":bool,"run_start_committed":bool,"run_heartbeat_committed":bool}
 *                                                  // ping
 *     {"ok":false,"error":"...","code":"..."}      // any failure
 *
 * Client framing: one request per line, one response per line, newline
 * delimited. The daemon enforces a 64 KiB request size cap (matches the
 * emit lib's 56 KiB chunk-pre-split ceiling).
 */

import { isUtf8 } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  currentSpoolFile,
  ensurePrivateDir,
  ensureRoot,
  metaPath,
  openPrivate,
  runDir,
  writerCapPath,
  writerPidPath,
  writerSocketPath,
} from "./observability_paths_lib.ts";
import {
  createStreamRedactor,
  redactJson,
  type StreamRedactor,
} from "./observability_redact_lib.ts";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const RUN_HEARTBEAT_DEFAULT_S = 10;
const PARENT_PROBE_INTERVAL_MS = 30_000;
const ROTATION_DEFAULT_BYTES = 100 * 1024 * 1024;
const PER_RUN_BUDGET_DEFAULT_MB = 2048;
const BATCHED_FSYNC_INTERVAL_MS = 100;
const BATCHED_FSYNC_COUNT = 50;
/** TTL on a single-use ephemeral cap minted by `caps_issue`. The
 * dispatcher MUST consume the cap on its very next UDS connect; any
 * longer wait points to a hostile interloper trying to replay a snooped
 * value. */
const EPHEMERAL_CAP_TTL_MS = 60_000;

interface DaemonOptions {
  runId: string;
  spoolDir: string;
  trackedParentPid: number;
  metaInit: Record<string, unknown>;
  rotationBytes: number;
  byteBudgetBytes: number;
  runHeartbeatMs: number;
  parentProbeMs: number;
  /** Test-only: prevent the daemon from `process.exit`-ing so the harness
   * can inspect post-shutdown state. */
  noExit?: boolean;
  /** Test-only: override `Date.now()` for deterministic timestamps. */
  now?: () => number;
}

interface CapHolder {
  /**
   * RT1: per-run **issuer secret**. At daemon boot we mint a single
   * 32-byte random token and write it 0600 to `writer.cap` in the per-run
   * dir. A same-UID dispatcher proves it has filesystem access to the
   * per-run dir by reading this file and presenting its contents on a
   * `caps_issue` UDS op. The daemon validates the issuer secret in
   * constant time and, on success, mints a fresh **single-use ephemeral
   * cap** (also 32 bytes b64url) bound to this run, with a short TTL.
   * The dispatcher then opens its data-protocol UDS connection and sends
   * the ephemeral cap on the first `hello` frame. The daemon validates
   * the ephemeral cap against {@link RunState.pendingCaps}, removes it on
   * success (single-use), and binds the connection to it for the rest of
   * the run.
   *
   * The 0600 file mode is the filesystem gate; the ephemeral cap is the
   * over-the-wire credential. A same-UID attacker that can read
   * `writer.cap` can still mint ephemeral caps, but every connection's
   * cap is single-use and short-lived so a leaked/snooped cap from one
   * connection cannot be replayed.
   */
  issuerSecret: string;
}

interface PendingCap {
  /** Wall-clock expiry (ms). Capped at {@link EPHEMERAL_CAP_TTL_MS}
   * from issuance. */
  expiresAt: number;
}

interface RunState {
  runId: string;
  parentPid: number;
  bootId: string | null;
  daemonPid: number;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "ok" | "error" | "timeout" | "crashed";
  crashedReason: string | null;
  /** Total bytes ever appended to the spool by this daemon (all JSONL
   * lines combined). Diagnostic — NOT subject to the byte budget, NOT
   * reported in heartbeats. Rotation uses {@link bytesInCurrentFile}. */
  spoolBytesWritten: number;
  /** Chunk-output bytes (stdout + stderr). This is the counter the byte
   * budget polices, and what `bytes_written` reports in heartbeats and
   * meta.json — see Phase 2 Task 6 ("Each chunk write inside the daemon
   * increments `ctx.bytesWritten`"). Initial readiness heartbeat reports
   * 0 because no chunks have been written yet (Phase 2 Task 3). */
  chunkBytesWritten: number;
  byteBudgetBytes: number;
  byteBudgetExceeded: boolean;
  currentRotationIndex: number;
  currentFd: number | null;
  currentFilePath: string | null;
  bytesInCurrentFile: number;
  nextSeq: number;
  nextSubagentSeq: number;
  runStartCommitted: boolean;
  runHeartbeatCommitted: boolean;
  meta: Record<string, unknown>;
  // Per-(subagent_id, stream) stream-redactor instances. Each `emit_chunk`
  // op feeds its chunk to the matching redactor before write; `end_subagent`
  // flushes the residual tail.
  redactors: Map<string, StreamRedactor>;
  // Subagents that have been started but not ended. Used to flush residuals
  // when the daemon shuts down without an explicit end_subagent.
  activeSubagents: Map<string, { agent: string; model: string; task: string }>;
  /**
   * RT1: ephemeral caps minted by `caps_issue` but not yet consumed by a
   * `hello`. Keyed by cap value. On a successful `hello`, the entry is
   * removed (single-use). Entries past their TTL are reaped lazily by
   * {@link validateAndConsumeCap}.
   */
  pendingCaps: Map<string, PendingCap>;
}

/** A single piece of work the writer queue serially drains. */
type QueueItem = () => Promise<void>;

interface DaemonRuntime {
  options: DaemonOptions;
  state: RunState;
  caps: CapHolder;
  server: net.Server | null;
  queue: { push: (work: QueueItem) => Promise<void>; drain: () => Promise<void> };
  heartbeatTimer: NodeJS.Timeout | null;
  parentProbeTimer: NodeJS.Timeout | null;
  batchedFsyncTimer: NodeJS.Timeout | null;
  batchedSinceFsync: number;
  shuttingDown: boolean;
}

const TIER_IMMEDIATE: ReadonlySet<string> = new Set([
  "run_start",
  "run_end",
  "subagent_start",
  "subagent_end",
  "run_heartbeat",
]);

function nowIso(rt: DaemonRuntime): string {
  const n = rt.options.now ? rt.options.now() : Date.now();
  return new Date(n).toISOString();
}

function readHostBootId(): string | null {
  // Prefer the host ticker's snapshot — it has both sec.usec format and is
  // already on disk. Fall back to a single sysctl call.
  try {
    const hostPath = path.join(
      runHostInfoDir(),
      "host.json",
    );
    const raw = fs.readFileSync(hostPath, "utf8");
    const parsed = JSON.parse(raw) as { host_boot_id?: string };
    if (typeof parsed.host_boot_id === "string" && parsed.host_boot_id) {
      return parsed.host_boot_id;
    }
  } catch {
    // fall through
  }
  if (process.platform !== "darwin") return null;
  try {
    const r = spawnSync("sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status !== 0) return null;
    const m = (r.stdout ?? "").match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
    if (!m) return null;
    return `${m[1]}.${m[2]}`;
  } catch {
    return null;
  }
}

function runHostInfoDir(): string {
  // We don't want a circular import on paths lib's hostinfoDir; we resolve
  // it via OBSERVABILITY_ROOT inferred from spool. Cheap: use
  // observability_paths_lib via its exported helper.
  // We avoid pulling another symbol simply by re-implementing the join.
  return path.join(
    path.dirname(path.dirname(path.dirname(metaPath("dummy")))),
    "hostinfo",
  );
}

function openSpoolFile(filePath: string): number {
  return openPrivate(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
}

/** Open the next rotation file, closing the previous fd if present. */
function rotateToNextFile(rt: DaemonRuntime): void {
  if (rt.state.currentFd !== null) {
    try {
      fs.fsyncSync(rt.state.currentFd);
    } catch {
      // best-effort
    }
    try {
      fs.closeSync(rt.state.currentFd);
    } catch {
      // best-effort
    }
  }
  rt.state.currentRotationIndex += 1;
  rt.state.currentFilePath = currentSpoolFile(
    rt.state.runId,
    rt.state.currentRotationIndex,
  );
  rt.state.currentFd = openSpoolFile(rt.state.currentFilePath);
  rt.state.bytesInCurrentFile = 0;
}

function writeMetaJsonAtomic(rt: DaemonRuntime): void {
  const target = metaPath(rt.state.runId);
  const tmp = target + ".tmp";
  const payload =
    JSON.stringify(
      {
        ...rt.state.meta,
        run_id: rt.state.runId,
        parent_pid: rt.state.parentPid,
        host_boot_id: rt.state.bootId,
        writer_daemon_pid: rt.state.daemonPid,
        started_at: rt.state.startedAt,
        ended_at: rt.state.endedAt,
        status: rt.state.status,
        crashed_reason: rt.state.crashedReason,
        bytes_written: rt.state.chunkBytesWritten,
        byte_budget_bytes: rt.state.byteBudgetBytes,
        byte_budget_exceeded: rt.state.byteBudgetExceeded,
        rotation_index: rt.state.currentRotationIndex,
        protocol_version: PROTOCOL_VERSION,
      },
      null,
      2,
    ) + "\n";
  const fd = openPrivate(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  );
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

function ensureRotationCapacity(rt: DaemonRuntime, lineByteLen: number): void {
  if (rt.state.currentFd === null) {
    rt.state.currentFilePath = currentSpoolFile(rt.state.runId, rt.state.currentRotationIndex);
    rt.state.currentFd = openSpoolFile(rt.state.currentFilePath);
    rt.state.bytesInCurrentFile = 0;
    return;
  }
  if (
    rt.state.bytesInCurrentFile + lineByteLen >
    rt.options.rotationBytes
  ) {
    rotateToNextFile(rt);
  }
}

/** Write a single JSONL line to the current rotation file. fsync per tier. */
function rawWriteLine(
  rt: DaemonRuntime,
  type: string,
  line: string,
  immediate: boolean,
): void {
  if (!line.endsWith("\n")) line = line + "\n";
  const buf = Buffer.from(line, "utf8");
  ensureRotationCapacity(rt, buf.byteLength);
  if (rt.state.currentFd === null) throw new Error("writer fd not open");
  fs.writeSync(rt.state.currentFd, buf, 0, buf.byteLength);
  rt.state.bytesInCurrentFile += buf.byteLength;
  rt.state.spoolBytesWritten += buf.byteLength;
  // Tier-immediate (RT5): lifecycle, findings, any event carrying
  // redacted=true. Everything else batches.
  if (
    immediate ||
    TIER_IMMEDIATE.has(type) ||
    type === "subagent_progress.finding"
  ) {
    fs.fsyncSync(rt.state.currentFd);
    rt.batchedSinceFsync = 0;
    if (rt.batchedFsyncTimer !== null) {
      clearTimeout(rt.batchedFsyncTimer);
      rt.batchedFsyncTimer = null;
    }
    return;
  }
  rt.batchedSinceFsync += 1;
  if (rt.batchedSinceFsync >= BATCHED_FSYNC_COUNT) {
    if (rt.state.currentFd !== null) fs.fsyncSync(rt.state.currentFd);
    rt.batchedSinceFsync = 0;
    if (rt.batchedFsyncTimer !== null) {
      clearTimeout(rt.batchedFsyncTimer);
      rt.batchedFsyncTimer = null;
    }
    return;
  }
  if (rt.batchedFsyncTimer === null) {
    rt.batchedFsyncTimer = setTimeout(() => {
      rt.batchedFsyncTimer = null;
      rt.queue
        .push(async () => {
          if (rt.state.currentFd !== null && rt.batchedSinceFsync > 0) {
            try {
              fs.fsyncSync(rt.state.currentFd);
            } catch {
              // best-effort
            }
            rt.batchedSinceFsync = 0;
          }
        })
        .catch(() => {});
    }, BATCHED_FSYNC_INTERVAL_MS);
    if (typeof (rt.batchedFsyncTimer as NodeJS.Timeout).unref === "function") {
      (rt.batchedFsyncTimer as NodeJS.Timeout).unref();
    }
  }
}

/** Compose + write a JSONL event. Returns the assigned seq. */
function writeEvent(
  rt: DaemonRuntime,
  type: string,
  fields: Record<string, unknown>,
  options: { redacted?: boolean; tierOverride?: string } = {},
): number {
  const seq = rt.state.nextSeq++;
  const event = {
    run_id: rt.state.runId,
    seq,
    ts: nowIso(rt),
    type,
    ...fields,
  } as Record<string, unknown>;
  if (options.redacted) event.redacted = true;
  const line = JSON.stringify(event);
  // RT5 tier rule: redacted=true forces immediate fsync regardless of type.
  rawWriteLine(rt, options.tierOverride ?? type, line, options.redacted === true);
  return seq;
}

function makeWriterQueue(): DaemonRuntime["queue"] {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(work) {
      const next = tail.then(work);
      // Swallow the tail's rejection so a single failure doesn't poison the chain.
      tail = next.catch(() => {});
      return next;
    },
    drain() {
      return tail.catch(() => {});
    },
  };
}

function startHeartbeatTimer(rt: DaemonRuntime): void {
  const tick = () => {
    if (rt.shuttingDown) return;
    rt.queue
      .push(async () => {
        if (rt.shuttingDown) return;
        writeEvent(rt, "run_heartbeat", {
          parent_pid: rt.state.parentPid,
          host_boot_id: rt.state.bootId,
          writer_daemon_pid: rt.state.daemonPid,
          bytes_written: rt.state.chunkBytesWritten,
        });
      })
      .catch(() => {});
  };
  rt.heartbeatTimer = setInterval(tick, rt.options.runHeartbeatMs);
  if (typeof rt.heartbeatTimer.unref === "function") rt.heartbeatTimer.unref();
}

/**
 * Validate an `issuer` value (presented by `caps_issue`) against the
 * on-disk per-run issuer secret. Constant-time compare. Returns false
 * for any shape mismatch or length mismatch (timing-safe rejection of
 * truncated/lengthened inputs).
 */
function validateIssuerSecret(rt: DaemonRuntime, issuer: unknown): boolean {
  if (typeof issuer !== "string" || issuer.length === 0) return false;
  const expected = Buffer.from(rt.caps.issuerSecret, "utf8");
  const got = Buffer.from(issuer, "utf8");
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

/**
 * Validate an ephemeral `cap` (presented on the first `hello` frame of
 * a data-protocol UDS connection) against {@link RunState.pendingCaps}.
 * On success, the cap is removed (single-use). Expired entries are
 * reaped lazily on every call. Returns true iff the cap was found,
 * not expired, and successfully consumed.
 */
function validateAndConsumeCap(rt: DaemonRuntime, cap: unknown): boolean {
  if (typeof cap !== "string" || cap.length === 0) return false;
  const now = rt.options.now ? rt.options.now() : Date.now();
  // Reap any expired entries first so a stale cap can't be replayed.
  for (const [k, v] of rt.state.pendingCaps) {
    if (v.expiresAt <= now) rt.state.pendingCaps.delete(k);
  }
  const entry = rt.state.pendingCaps.get(cap);
  if (!entry) return false;
  // Defense-in-depth: still a constant-time compare on the lookup key.
  const lookupKeys = Array.from(rt.state.pendingCaps.keys());
  let match = false;
  for (const k of lookupKeys) {
    const a = Buffer.from(k, "utf8");
    const b = Buffer.from(cap, "utf8");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      match = true;
      break;
    }
  }
  if (!match) return false;
  rt.state.pendingCaps.delete(cap);
  return true;
}

/** Mint a fresh single-use ephemeral cap. Stored under
 * {@link RunState.pendingCaps} until consumed by a `hello`. */
function issueEphemeralCap(rt: DaemonRuntime): string {
  const cap = crypto.randomBytes(32).toString("base64url");
  const now = rt.options.now ? rt.options.now() : Date.now();
  rt.state.pendingCaps.set(cap, { expiresAt: now + EPHEMERAL_CAP_TTL_MS });
  return cap;
}

function startParentProbe(rt: DaemonRuntime): void {
  const tick = () => {
    if (rt.shuttingDown) return;
    let alive = true;
    try {
      process.kill(rt.state.parentPid, 0);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") alive = false;
    }
    if (!alive) {
      void shutdownCrashed(rt, "parent_exit");
    }
  };
  rt.parentProbeTimer = setInterval(tick, rt.options.parentProbeMs);
  if (typeof rt.parentProbeTimer.unref === "function") {
    rt.parentProbeTimer.unref();
  }
}

async function shutdownCrashed(rt: DaemonRuntime, reason: string): Promise<void> {
  if (rt.shuttingDown) return;
  rt.shuttingDown = true;
  if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
  if (rt.parentProbeTimer) clearInterval(rt.parentProbeTimer);
  if (rt.batchedFsyncTimer) clearTimeout(rt.batchedFsyncTimer);
  rt.heartbeatTimer = null;
  rt.parentProbeTimer = null;
  rt.batchedFsyncTimer = null;
  await rt.queue.push(async () => {
    writeEvent(rt, "run_heartbeat", {
      parent_pid: rt.state.parentPid,
      host_boot_id: rt.state.bootId,
      writer_daemon_pid: rt.state.daemonPid,
      bytes_written: rt.state.chunkBytesWritten,
    });
    flushPendingRedactors(rt);
    rt.state.status = "crashed";
    rt.state.crashedReason = reason;
    rt.state.endedAt = nowIso(rt);
    writeEvent(rt, "run_end", {
      status: rt.state.status,
      crashed_reason: reason,
    });
    if (rt.state.currentFd !== null) {
      try {
        fs.fsyncSync(rt.state.currentFd);
      } catch {
        // best-effort
      }
      try {
        fs.closeSync(rt.state.currentFd);
      } catch {
        // best-effort
      }
      rt.state.currentFd = null;
    }
    writeMetaJsonAtomic(rt);
  });
  await rt.queue.drain();
  closeServerAndCleanup(rt);
  if (!rt.options.noExit) process.exit(0);
}

async function shutdownGraceful(
  rt: DaemonRuntime,
  status: "ok" | "error" | "timeout",
): Promise<void> {
  if (rt.shuttingDown) return;
  rt.shuttingDown = true;
  if (rt.heartbeatTimer) clearInterval(rt.heartbeatTimer);
  if (rt.parentProbeTimer) clearInterval(rt.parentProbeTimer);
  if (rt.batchedFsyncTimer) clearTimeout(rt.batchedFsyncTimer);
  rt.heartbeatTimer = null;
  rt.parentProbeTimer = null;
  rt.batchedFsyncTimer = null;
  await rt.queue.push(async () => {
    flushPendingRedactors(rt);
    rt.state.status = status;
    rt.state.endedAt = nowIso(rt);
    writeEvent(rt, "run_end", { status });
    if (rt.state.currentFd !== null) {
      try {
        fs.fsyncSync(rt.state.currentFd);
      } catch {
        // best-effort
      }
      try {
        fs.closeSync(rt.state.currentFd);
      } catch {
        // best-effort
      }
      rt.state.currentFd = null;
    }
    writeMetaJsonAtomic(rt);
  });
  await rt.queue.drain();
  closeServerAndCleanup(rt);
}

/**
 * Write a stdout/stderr chunk through the byte-budget gate. Returns the
 * assigned seq if written, or null if the chunk was dropped because the
 * budget was already exceeded.
 *
 * This is the SINGLE write path for chunk-output bytes — both the normal
 * `emit_chunk` op AND the redactor flush sites (end_subagent + shutdown)
 * route through here so the budget counter, the one-shot
 * `chunk-budget-exceeded` marker, and the `meta.json.byte_budget_exceeded`
 * field stay coherent with what actually landed in the JSONL.
 */
function writeChunkWithBudget(
  rt: DaemonRuntime,
  subId: string,
  stream: string,
  encoding: string,
  outChunk: string,
  redacted: boolean,
): number | null {
  const chunkByteCost = Buffer.byteLength(outChunk, "utf8");
  if (
    rt.state.chunkBytesWritten + chunkByteCost >
    rt.state.byteBudgetBytes
  ) {
    if (!rt.state.byteBudgetExceeded) {
      rt.state.byteBudgetExceeded = true;
      rt.state.meta.byte_budget_exceeded = true;
      writeEvent(rt, "subagent_progress", {
        subagent_id: subId,
        kind: "chunk-budget-exceeded",
        payload: { bytes_written: rt.state.chunkBytesWritten },
      });
      try {
        writeMetaJsonAtomic(rt);
      } catch {
        // best-effort
      }
    }
    return null;
  }
  const type = stream === "stderr" ? "subagent_stderr" : "subagent_stdout";
  const seq = writeEvent(
    rt,
    type,
    { subagent_id: subId, stream, encoding, chunk: outChunk },
    { redacted },
  );
  rt.state.chunkBytesWritten += chunkByteCost;
  return seq;
}

function flushPendingRedactors(rt: DaemonRuntime): void {
  // For each per-(subagent_id, stream, encoding) redactor, drain its
  // residual tail and emit one final chunk event before any
  // subagent_end / run_end. The flushed text is UTF-8 (the redactor
  // internal state); base64-keyed redactors get their remainder
  // re-encoded back to base64 so the tailer sees the same wire shape
  // it would have seen for any pre-flush chunk on that stream.
  //
  // Routed through writeChunkWithBudget so the flushed bytes participate
  // in the chunk-budget accounting + chunk-budget-exceeded path, matching
  // the normal `emit_chunk` semantics.
  for (const [key, red] of rt.state.redactors.entries()) {
    const remainder = red.flush();
    if (remainder.length === 0) continue;
    const [subagentId, stream, encoding] = parseRedactorKey(key);
    const isRedacted = red.hasRedacted();
    const outChunk =
      encoding === "base64"
        ? Buffer.from(remainder, "utf8").toString("base64")
        : remainder;
    writeChunkWithBudget(rt, subagentId, stream, encoding, outChunk, isRedacted);
  }
  rt.state.redactors.clear();
}

const REDACTOR_KEY_SEP = " ";
function redactorKey(
  subagentId: string,
  stream: string,
  encoding: string,
): string {
  return `${subagentId}${REDACTOR_KEY_SEP}${stream}${REDACTOR_KEY_SEP}${encoding}`;
}
function parseRedactorKey(key: string): [string, string, string] {
  const parts = key.split(REDACTOR_KEY_SEP);
  return [parts[0] ?? "", parts[1] ?? "stdout", parts[2] ?? "utf8"];
}

function closeServerAndCleanup(rt: DaemonRuntime): void {
  try {
    rt.server?.close();
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(writerSocketPath(rt.state.runId));
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(writerPidPath(rt.state.runId));
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(writerCapPath(rt.state.runId));
  } catch {
    // ignore
  }
}

interface ConnectionState {
  authenticated: boolean;
  buffer: string;
}

function handleConnection(rt: DaemonRuntime, socket: net.Socket): void {
  const cs: ConnectionState = { authenticated: false, buffer: "" };
  let helloTimer: NodeJS.Timeout | null = setTimeout(() => {
    try {
      socket.write(
        JSON.stringify({ ok: false, error: "hello timeout", code: "no_hello" }) + "\n",
      );
    } catch {
      // ignore
    }
    socket.destroy();
  }, 5000);
  if (helloTimer.unref) helloTimer.unref();

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    cs.buffer += chunk;
    if (cs.buffer.length > MAX_FRAME_BYTES * 4) {
      // Pathological input — kill the connection.
      try {
        socket.write(
          JSON.stringify({ ok: false, error: "frame too large", code: "frame_too_large" }) + "\n",
        );
      } catch {
        // ignore
      }
      socket.destroy();
      return;
    }
    let nl: number;
    while ((nl = cs.buffer.indexOf("\n")) !== -1) {
      const line = cs.buffer.slice(0, nl);
      cs.buffer = cs.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
        try {
          socket.write(
            JSON.stringify({
              ok: false,
              error: "frame too large",
              code: "frame_too_large",
            }) + "\n",
          );
        } catch {
          // ignore
        }
        socket.destroy();
        return;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        try {
          socket.write(
            JSON.stringify({ ok: false, error: "invalid json", code: "bad_json" }) + "\n",
          );
        } catch {
          // ignore
        }
        continue;
      }
      const op = typeof parsed.op === "string" ? parsed.op : "";
      if (op === "ping") {
        try {
          socket.write(
            JSON.stringify({
              ok: true,
              ready: rt.state.runStartCommitted && rt.state.runHeartbeatCommitted,
              run_start_committed: rt.state.runStartCommitted,
              run_heartbeat_committed: rt.state.runHeartbeatCommitted,
            }) + "\n",
          );
        } catch {
          // ignore
        }
        continue;
      }
      if (op === "caps_issue") {
        // RT1: caps_issue is the writer-owned auth endpoint. Caller proves
        // filesystem access to the per-run dir by presenting the contents
        // of `writer.cap` (0600). On success, the daemon mints a single-
        // use ephemeral cap bound to this run with a 60 s TTL. The caller
        // immediately uses that cap on `hello` of a fresh data-protocol
        // connection. Same-UID attackers that snoop one ephemeral cap
        // cannot replay it because the daemon removes it on first use.
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        if (!validateIssuerSecret(rt, parsed.issuer)) {
          try {
            socket.write(
              JSON.stringify({ ok: false, error: "bad issuer", code: "bad_issuer" }) + "\n",
            );
          } catch {
            // ignore
          }
          socket.destroy();
          return;
        }
        const minted = issueEphemeralCap(rt);
        try {
          socket.write(
            JSON.stringify({
              ok: true,
              cap: minted,
              expires_in_s: Math.floor(EPHEMERAL_CAP_TTL_MS / 1000),
            }) + "\n",
          );
        } catch {
          // ignore
        }
        // caps_issue is a one-shot probe — close the connection so the
        // caller opens a fresh socket for the data-protocol `hello`.
        socket.end();
        return;
      }
      if (op === "hello") {
        if (helloTimer) {
          clearTimeout(helloTimer);
          helloTimer = null;
        }
        // RT1: validate the single-use ephemeral cap minted by
        // `caps_issue`. The cap is removed on success (single-use); a
        // replay attempt by any same-UID interloper that snooped this
        // value fails because the cap is no longer in pendingCaps.
        if (!validateAndConsumeCap(rt, parsed.cap)) {
          try {
            socket.write(
              JSON.stringify({ ok: false, error: "bad capability", code: "bad_cap" }) + "\n",
            );
          } catch {
            // ignore
          }
          socket.destroy();
          return;
        }
        cs.authenticated = true;
        try {
          socket.write(JSON.stringify({ ok: true }) + "\n");
        } catch {
          // ignore
        }
        continue;
      }
      if (!cs.authenticated) {
        try {
          socket.write(
            JSON.stringify({ ok: false, error: "not authenticated", code: "no_hello" }) + "\n",
          );
        } catch {
          // ignore
        }
        continue;
      }
      void dispatchOp(rt, socket, op, parsed);
    }
  });
  socket.on("error", () => {
    // Other side closed mid-write; nothing to do.
  });
  socket.on("close", () => {
    if (helloTimer) {
      clearTimeout(helloTimer);
      helloTimer = null;
    }
  });
}

async function dispatchOp(
  rt: DaemonRuntime,
  socket: net.Socket,
  op: string,
  req: Record<string, unknown>,
): Promise<void> {
  if (rt.shuttingDown && op !== "ping") {
    try {
      socket.write(
        JSON.stringify({ ok: false, error: "shutting down", code: "shutdown" }) + "\n",
      );
    } catch {
      // ignore
    }
    return;
  }
  switch (op) {
    case "start_subagent": {
      await rt.queue.push(async () => {
        const subId = `${rt.state.runId}:${++rt.state.nextSubagentSeq}`;
        const agent = String(req.agent ?? "");
        const model = String(req.model ?? "");
        const task = String(req.task ?? "");
        const seq = writeEvent(rt, "subagent_start", {
          subagent_id: subId,
          agent,
          model,
          task,
        });
        rt.state.activeSubagents.set(subId, { agent, model, task });
        try {
          socket.write(
            JSON.stringify({ ok: true, subagent_id: subId, seq }) + "\n",
          );
        } catch {
          // ignore
        }
      });
      return;
    }
    case "end_subagent": {
      await rt.queue.push(async () => {
        const subId = String(req.subagent_id ?? "");
        const status = String(req.status ?? "ok");
        const durationMs =
          typeof req.duration_ms === "number" ? req.duration_ms : null;
        const rawSummary = req.summary;
        const sanitized = redactJson(rawSummary ?? null);
        // Flush any pending (stream, encoding) stream-redactor remainders
        // for this subagent BEFORE writing the subagent_end so seq order is
        // correct. Each (stream, encoding) pair has its own redactor so the
        // base64 carry-over tail is re-encoded back to base64 on emit and
        // the utf8 tail stays as-is.
        for (const stream of ["stdout", "stderr"]) {
          for (const encoding of ["utf8", "base64"]) {
            const key = redactorKey(subId, stream, encoding);
            const red = rt.state.redactors.get(key);
            if (!red) continue;
            const remainder = red.flush();
            rt.state.redactors.delete(key);
            if (remainder.length === 0) continue;
            const isRedacted = red.hasRedacted();
            const outChunk =
              encoding === "base64"
                ? Buffer.from(remainder, "utf8").toString("base64")
                : remainder;
            // Routed through writeChunkWithBudget so the flushed residual
            // counts against the byte budget and triggers the one-shot
            // chunk-budget-exceeded marker if it would push us past the
            // limit — same accounting as a regular emit_chunk arrival.
            writeChunkWithBudget(
              rt,
              subId,
              stream,
              encoding,
              outChunk,
              isRedacted,
            );
          }
        }
        const seq = writeEvent(
          rt,
          "subagent_end",
          {
            subagent_id: subId,
            status,
            duration_ms: durationMs,
            summary: sanitized.value,
          },
          { redacted: sanitized.redacted },
        );
        rt.state.activeSubagents.delete(subId);
        try {
          socket.write(JSON.stringify({ ok: true, seq }) + "\n");
        } catch {
          // ignore
        }
      });
      return;
    }
    case "emit_progress": {
      await rt.queue.push(async () => {
        const subId =
          req.subagent_id === null || req.subagent_id === undefined
            ? null
            : String(req.subagent_id);
        const kind = String(req.kind ?? "");
        const payload = req.payload ?? null;
        const sanitized = redactJson(payload);
        const tierOverride =
          kind === "finding" ? "subagent_progress.finding" : undefined;
        const seq = writeEvent(
          rt,
          "subagent_progress",
          {
            subagent_id: subId,
            kind,
            payload: sanitized.value,
          },
          { redacted: sanitized.redacted, tierOverride },
        );
        try {
          socket.write(JSON.stringify({ ok: true, seq }) + "\n");
        } catch {
          // ignore
        }
      });
      return;
    }
    case "emit_chunk": {
      await rt.queue.push(async () => {
        const subId = String(req.subagent_id ?? "");
        const stream = String(req.stream ?? "stdout");
        const encoding = String(req.encoding ?? "utf8");
        const chunkVal = req.chunk;
        if (typeof chunkVal !== "string") {
          try {
            socket.write(
              JSON.stringify({ ok: false, error: "chunk must be a string", code: "bad_chunk" }) + "\n",
            );
          } catch {
            // ignore
          }
          return;
        }
        // Decode-if-base64 → feed through stream redactor → re-encode if
        // base64; preserves wire shape so the tailer sees the same encoding
        // as the producer intended. The stream redactor's per-(subagent,
        // stream, encoding) overlap buffer is what catches a secret split
        // across two emit_chunk requests — using one-shot `redact(text)`
        // here would miss a secret that straddles two consecutive base64
        // frames (E6/Phase 2 Task 5 boundary-split contract).
        let redacted = false;
        let outChunk = "";
        let safeUtf8: string | null = null;
        let undecodableSmallBase64 = false;
        if (encoding === "base64") {
          // E6: validate decoded UTF-8 before redaction. Blindly calling
          // `.toString("utf8")` on arbitrary binary replaces invalid bytes
          // with U+FFFD, corrupting the payload. If the decoded bytes are
          // not valid UTF-8 AND larger than 1 MiB, emit a `chunk_truncated`
          // sentinel instead of either leaking bytes or rewriting them.
          // Smaller undecodable chunks pass through verbatim (the daemon
          // cannot pattern-match what it cannot decode, and re-encoding the
          // original base64 string is identity).
          const decoded = Buffer.from(chunkVal, "base64");
          const UNDECODABLE_BUDGET = 1024 * 1024;
          if (isUtf8(decoded)) {
            safeUtf8 = decoded.toString("utf8");
          } else if (decoded.byteLength > UNDECODABLE_BUDGET) {
            // E6: undecodable + over the budget. Emit a `chunk_truncated`
            // sentinel; do NOT write the raw bytes.
            const truncatedSeq = writeEvent(rt, "chunk_truncated", {
              subagent_id: subId,
              stream,
              bytes_dropped: decoded.byteLength,
              reason: "undecodable_base64_over_budget",
            });
            try {
              socket.write(
                JSON.stringify({ ok: true, seq: truncatedSeq, dropped: true }) +
                  "\n",
              );
            } catch {
              // ignore
            }
            return;
          } else {
            // Undecodable but small — pass the original base64 string
            // through verbatim. We cannot pattern-match binary, but we
            // also cannot afford to rewrite arbitrary bytes. Bypasses the
            // stream redactor: there is no carry-over state for opaque
            // binary content.
            outChunk = chunkVal;
            redacted = false;
            undecodableSmallBase64 = true;
          }
        } else {
          safeUtf8 = chunkVal;
        }
        if (!undecodableSmallBase64) {
          // Feed the decoded-or-raw UTF-8 text through the stream redactor
          // keyed by (subId, stream, encoding). The encoding dimension keeps
          // the overlap buffer for utf8 and base64 chunks from blending byte
          // positions when both encodings are present on the same stream.
          const key = redactorKey(subId, stream, encoding);
          let red = rt.state.redactors.get(key);
          if (!red) {
            red = createStreamRedactor();
            rt.state.redactors.set(key, red);
          }
          const safe = red.feed(safeUtf8 as string);
          if (safe.length === 0) {
            // Entire chunk is buffered (carry-over); nothing to emit yet.
            try {
              socket.write(JSON.stringify({ ok: true, seq: rt.state.nextSeq - 1 }) + "\n");
            } catch {
              // ignore
            }
            return;
          }
          redacted = red.hasRedacted();
          outChunk =
            encoding === "base64"
              ? Buffer.from(safe, "utf8").toString("base64")
              : safe;
        }
        // Budget enforcement on chunk-output bytes only (Phase 2 Task 6).
        // Lifecycle/heartbeat/progress lines do NOT count against the
        // budget — that counter is separate from spoolBytesWritten. Both
        // this path AND the redactor-flush sites (end_subagent + shutdown)
        // route through writeChunkWithBudget so the budget counter, the
        // chunk-budget-exceeded marker, and meta.json stay coherent.
        const seq = writeChunkWithBudget(
          rt,
          subId,
          stream,
          encoding,
          outChunk,
          redacted,
        );
        if (seq === null) {
          try {
            socket.write(
              JSON.stringify({ ok: true, seq: rt.state.nextSeq - 1, dropped: true }) + "\n",
            );
          } catch {
            // ignore
          }
          return;
        }
        try {
          socket.write(JSON.stringify({ ok: true, seq }) + "\n");
        } catch {
          // ignore
        }
      });
      return;
    }
    case "emit_subagent_heartbeat": {
      await rt.queue.push(async () => {
        const subId = String(req.subagent_id ?? "");
        const seq = writeEvent(rt, "subagent_heartbeat", {
          subagent_id: subId,
        });
        try {
          socket.write(JSON.stringify({ ok: true, seq }) + "\n");
        } catch {
          // ignore
        }
      });
      return;
    }
    case "end_run": {
      const status = String(req.status ?? "ok");
      const okStatus =
        status === "ok" || status === "error" || status === "timeout"
          ? (status as "ok" | "error" | "timeout")
          : "ok";
      await shutdownGraceful(rt, okStatus);
      // Send the final ack and wait for the OS to flush both the write and
      // the FIN before we exit. Without this barrier, process.exit(0) can
      // tear the socket down before the ack reaches the client, so
      // `endRun(ctx)` rejects with ECONNRESET even though the daemon has
      // already fsynced run_end + rewritten meta.json + removed sock/pid.
      const ackLine = JSON.stringify({ ok: true }) + "\n";
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        try {
          socket.end(ackLine, () => finish());
        } catch {
          finish();
          return;
        }
        // Belt-and-suspenders: if `close` arrives before the end callback
        // (or the platform doesn't fire it), resolve anyway. We never want
        // shutdown to hang on a broken peer.
        socket.once("close", () => finish());
        // Hard ceiling so a stuck flush can't block process exit forever.
        const t = setTimeout(finish, 5000);
        if (typeof t.unref === "function") t.unref();
      });
      if (!rt.options.noExit) process.exit(0);
      return;
    }
    default: {
      try {
        socket.write(
          JSON.stringify({ ok: false, error: "unknown op", code: "unknown_op" }) + "\n",
        );
      } catch {
        // ignore
      }
    }
  }
}

/** Top-level setup: bind socket, write pid, write initial events, start
 * timers. Returns the runtime so tests can drive it without spawning a
 * subprocess. */
export async function bootDaemon(opts: DaemonOptions): Promise<DaemonRuntime> {
  ensureRoot();
  ensurePrivateDir(runDir(opts.runId));
  const startedAt = new Date(opts.now ? opts.now() : Date.now()).toISOString();
  const bootId = readHostBootId();
  const state: RunState = {
    runId: opts.runId,
    parentPid: opts.trackedParentPid,
    bootId,
    daemonPid: process.pid,
    startedAt,
    endedAt: null,
    status: "running",
    crashedReason: null,
    spoolBytesWritten: 0,
    chunkBytesWritten: 0,
    byteBudgetBytes: opts.byteBudgetBytes,
    byteBudgetExceeded: false,
    currentRotationIndex: 0,
    currentFd: null,
    currentFilePath: null,
    bytesInCurrentFile: 0,
    nextSeq: 1,
    nextSubagentSeq: 0,
    runStartCommitted: false,
    runHeartbeatCommitted: false,
    meta: {
      ...opts.metaInit,
      protocol_version: PROTOCOL_VERSION,
    },
    redactors: new Map(),
    activeSubagents: new Map(),
    pendingCaps: new Map(),
  };
  // RT1: mint a random 32-byte b64url issuer secret and write it 0600 to
  // writer.cap. Same-UID dispatchers read the file and present its
  // contents on a `caps_issue` UDS op to mint a single-use ephemeral cap
  // (60 s TTL), which they then present on the `hello` frame of the
  // data-protocol UDS connection. The on-disk file is the filesystem
  // gate; the ephemeral cap is the over-the-wire credential.
  const caps: CapHolder = {
    issuerSecret: crypto.randomBytes(32).toString("base64url"),
  };
  const rt: DaemonRuntime = {
    options: opts,
    state,
    caps,
    server: null,
    queue: makeWriterQueue(),
    heartbeatTimer: null,
    parentProbeTimer: null,
    batchedFsyncTimer: null,
    batchedSinceFsync: 0,
    shuttingDown: false,
  };

  // Pre-open the spool file so the initial run_start lands without a stat.
  ensureRotationCapacity(rt, 0);

  // Write writer.pid (diagnostic only) and writer.cap (auth surface). The
  // cap is written BEFORE the socket binds so a dispatcher that successfully
  // connects can always find a valid cap on disk.
  fs.writeFileSync(writerPidPath(opts.runId), String(process.pid), { mode: 0o600 });
  fs.writeFileSync(writerCapPath(opts.runId), caps.issuerSecret, { mode: 0o600 });
  try {
    fs.chmodSync(writerCapPath(opts.runId), 0o600);
  } catch {
    // best-effort
  }

  // Bind the UDS. Remove a stale sock first; harmless if absent.
  try {
    fs.unlinkSync(writerSocketPath(opts.runId));
  } catch {
    // ignore
  }
  const server = net.createServer((socket) => handleConnection(rt, socket));
  rt.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(writerSocketPath(opts.runId), () => {
      try {
        fs.chmodSync(writerSocketPath(opts.runId), 0o600);
      } catch {
        // best-effort
      }
      resolve();
    });
  });

  // Write initial run_start
  await rt.queue.push(async () => {
    writeEvent(rt, "run_start", {
      tracked_parent_pid: opts.trackedParentPid,
      writer_daemon_pid: process.pid,
      host_boot_id: bootId,
      meta: opts.metaInit,
      byte_budget_bytes: opts.byteBudgetBytes,
      protocol_version: PROTOCOL_VERSION,
    });
    rt.state.runStartCommitted = true;
  });

  // Write meta.json (initial)
  writeMetaJsonAtomic(rt);

  // Write initial run_heartbeat — bound by the readiness contract (Phase 2
  // Task 3) so the sweeper has a non-null parent_pid the moment startRun
  // returns. Reports `bytes_written: 0` because no chunks have flowed yet
  // (chunkBytesWritten is initialized to 0 and stays at 0 until the first
  // successful emit_chunk).
  await rt.queue.push(async () => {
    writeEvent(rt, "run_heartbeat", {
      parent_pid: opts.trackedParentPid,
      host_boot_id: bootId,
      writer_daemon_pid: process.pid,
      bytes_written: rt.state.chunkBytesWritten,
    });
    rt.state.runHeartbeatCommitted = true;
  });

  // Start timers AFTER the readiness handshake so we don't race the initial
  // heartbeat with the periodic one.
  startHeartbeatTimer(rt);
  startParentProbe(rt);

  // Cooperative shutdown signals: matches Phase 2 Task 3 "SIGTERM/SIGHUP" path.
  const handleSig = (status: "error") => () => {
    void shutdownGraceful(rt, status).then(() => {
      if (!rt.options.noExit) process.exit(0);
    });
  };
  process.on("SIGTERM", handleSig("error"));
  process.on("SIGHUP", handleSig("error"));

  return rt;
}

function parseArgv(argv: string[]): DaemonOptions {
  let runId: string | null = null;
  let spoolDir: string | null = null;
  let trackedParentPid: number | null = null;
  let metaJson = "{}";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") runId = argv[++i] ?? null;
    else if (a === "--spool-dir") spoolDir = argv[++i] ?? null;
    else if (a === "--tracked-parent-pid")
      trackedParentPid = Number.parseInt(argv[++i] ?? "", 10);
    else if (a === "--meta") metaJson = argv[++i] ?? "{}";
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: observability_writer_daemon.ts --run-id <id> --spool-dir <dir> --tracked-parent-pid <pid> --meta <json>\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!runId) throw new Error("--run-id required");
  if (!spoolDir) throw new Error("--spool-dir required");
  if (trackedParentPid === null || !Number.isFinite(trackedParentPid))
    throw new Error("--tracked-parent-pid required");
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metaJson) as Record<string, unknown>;
    if (!meta || typeof meta !== "object") meta = {};
  } catch {
    meta = {};
  }
  return {
    runId,
    spoolDir,
    trackedParentPid,
    metaInit: meta,
    rotationBytes: Number.parseInt(
      process.env.OBSERVABILITY_MAX_FILE_BYTES ?? "",
      10,
    ) || ROTATION_DEFAULT_BYTES,
    byteBudgetBytes:
      (Number.parseInt(
        process.env.OBSERVABILITY_PER_RUN_MAX_MB ?? "",
        10,
      ) || PER_RUN_BUDGET_DEFAULT_MB) *
      1024 *
      1024,
    runHeartbeatMs:
      (Number.parseInt(
        process.env.OBSERVABILITY_RUN_HEARTBEAT_S ?? "",
        10,
      ) || RUN_HEARTBEAT_DEFAULT_S) * 1000,
    parentProbeMs: PARENT_PROBE_INTERVAL_MS,
  };
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  await bootDaemon(opts);
  // Keep alive — timers + UDS server hold the event loop open. The daemon
  // exits via shutdownGraceful() / shutdownCrashed().
}

const isEntry =
  import.meta.url ===
  (process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(
      `[observability_writer_daemon] fatal: ${(err as Error).message}\n`,
    );
    process.exit(1);
  });
}

export const __test = {
  bootDaemon,
  parseArgv,
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  shutdownGraceful,
  shutdownCrashed,
  writerCapPath,
};
