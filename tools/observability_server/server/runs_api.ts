/**
 * Read-side HTTP routes that back the UI + scripted CLI clients
 * (Phase 4 Task 2).
 *
 * Shapes match plan §7. All timestamps the server emits are stored as
 * ISO-8601 millisecond strings (server-bound via `new Date().toISOString()`
 * on every writer); no row coming out of these handlers carries a
 * SQLite-native clock-function value.
 */

import { Buffer } from "node:buffer";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";

import type { IndexWriterStats } from "./index_writer.ts";
import type { EventBus, ParsedEvent, TruncationBroadcast } from "./event_bus.ts";

const RATE_LIMIT_API = { max: 240, timeWindow: "1 minute" } as const;
const RATE_LIMIT_SSE = { max: 60, timeWindow: "1 minute" } as const;
const SSE_MAX_CONCURRENT_PER_KEY = 4;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_PREAD_BUFFER_BYTES = 256 * 1024;
const TERMINAL_SUBAGENT_STATUSES = new Set([
  "ok",
  "error",
  "timeout",
  "crashed",
]);
const TERMINAL_RUN_STATUSES = new Set(["ok", "error", "timeout", "crashed"]);

/**
 * RT5 durability block. Sourced from the writer daemon / emit layer
 * (Phase 2). The server itself does not measure fsync latency — it
 * only surfaces what the daemon reports. A stub provider returning
 * zeros / null is acceptable when the daemon hasn't reported yet.
 */
export interface DurabilityStats {
  batched_queue_depth: number;
  fsync_p50_ms: number | null;
  fsync_p99_ms: number | null;
  last_fsync_at: string | null;
}

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    dispatcher: z.string().min(1).optional(),
  })
  .strict();

const chunksQuerySchema = z
  .object({
    from_seq: z.coerce.number().int().nonnegative().optional(),
    to_seq: z.coerce.number().int().nonnegative().optional(),
  })
  .strict();

export interface RunsApiDeps {
  db: Database.Database;
  spoolRoot: string;
  indexWriterStats: () => IndexWriterStats;
  getTailerParseErrors: () => number;
  /**
   * Optional accessor for the recent batch-commit latency samples
   * tracked by the index writer. When present, `/api/health.index_writer`
   * surfaces p50/p95 so the Phase 8 load harness can run against a
   * remote server without poking internals.
   */
  getCommitLatencies?: () => number[];
  /**
   * Optional live-event source. When provided, chunk SSE handlers
   * with `to_seq` omitted switch to live tail; otherwise they
   * deliver the current bounded range and emit `event: end`.
   */
  bus?: EventBus;
  /**
   * Optional RT5 durability stats provider. When absent, `/api/health`
   * still emits the `durability` block populated with zeros / nulls
   * so the contract is stable for clients.
   */
  getDurabilityStats?: () => DurabilityStats;
  now?: () => number;
}

export function registerRunsApi(
  app: FastifyInstance,
  deps: RunsApiDeps,
): void {
  const now = deps.now ?? Date.now;
  app.get(
    "/api/runs",
    { config: { rateLimit: RATE_LIMIT_API } },
    async (req, reply) => handleRunsList(deps, req, reply),
  );
  app.get(
    "/api/runs/:run_id",
    { config: { rateLimit: RATE_LIMIT_API } },
    async (req, reply) => handleRunGet(deps, req, reply),
  );
  app.get(
    "/api/runs/:run_id/subagents/:subagent_id",
    { config: { rateLimit: RATE_LIMIT_API } },
    async (req, reply) => handleSubagentGet(deps, req, reply),
  );
  app.get(
    "/api/runs/:run_id/subagents/:subagent_id/chunks",
    { config: { rateLimit: RATE_LIMIT_SSE } },
    async (req, reply) => handleChunksSse(deps, req, reply),
  );
  app.get(
    "/api/health",
    { config: { rateLimit: RATE_LIMIT_API } },
    async () => buildHealthBody(deps, now),
  );
}

function handleRunsList(
  deps: RunsApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const parsed = listQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    return reply
      .code(400)
      .send({ ok: false, code: "bad_query", error: parsed.error.message });
  }
  const limit = parsed.data.limit ?? 50;
  const cursor = parsed.data.cursor !== undefined
    ? decodeCursor(parsed.data.cursor)
    : null;
  if (parsed.data.cursor !== undefined && cursor === null) {
    return reply.code(400).send({ ok: false, code: "bad_cursor" });
  }

  const whereParts: string[] = [];
  const args: unknown[] = [];
  if (parsed.data.repo !== undefined) {
    whereParts.push("repo = ?");
    args.push(parsed.data.repo);
  }
  if (parsed.data.status !== undefined) {
    whereParts.push("status = ?");
    args.push(parsed.data.status);
  }
  if (parsed.data.dispatcher !== undefined) {
    whereParts.push("dispatcher = ?");
    args.push(parsed.data.dispatcher);
  }
  if (cursor !== null) {
    whereParts.push("(started_at < ? OR (started_at = ? AND run_id < ?))");
    args.push(cursor.startedAt, cursor.startedAt, cursor.runId);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const rows = deps.db
    .prepare(
      `SELECT run_id, dispatcher, repo, branch, pr_number, started_at,
              ended_at, status, last_heartbeat_at, total_subagents,
              total_findings, crashed_reason, parent_pid, writer_daemon_pid,
              host_boot_id, last_seq, bytes_written
         FROM runs
         ${whereSql}
        ORDER BY started_at DESC, run_id DESC
        LIMIT ?`,
    )
    .all(...args, limit + 1) as RunRow[];

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const nextCursor = hasMore && page.length > 0
    ? encodeCursor({
        startedAt: page[page.length - 1]!.started_at,
        runId: page[page.length - 1]!.run_id,
      })
    : null;
  return reply.send({
    items: page.map(renderRun),
    next_cursor: nextCursor,
  });
}

function handleRunGet(
  deps: RunsApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const params = req.params as { run_id?: string };
  const runId = params.run_id;
  if (typeof runId !== "string" || runId.length === 0) {
    return reply.code(400).send({ ok: false, code: "bad_run_id" });
  }
  const row = deps.db
    .prepare(
      `SELECT run_id, dispatcher, repo, branch, pr_number, started_at,
              ended_at, status, last_heartbeat_at, total_subagents,
              total_findings, crashed_reason, parent_pid, writer_daemon_pid,
              host_boot_id, last_seq, bytes_written
         FROM runs
        WHERE run_id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!row) return reply.code(404).send({ ok: false, code: "run_not_found" });
  const subagents = deps.db
    .prepare(
      `SELECT subagent_id, agent, model, task, started_at, ended_at,
              status, duration_ms, stdout_bytes, stderr_bytes, last_output_at,
              finding_count
         FROM subagents
        WHERE run_id = ?
        ORDER BY started_at ASC, subagent_id ASC`,
    )
    .all(runId) as SubagentRow[];
  return reply.send({
    run: renderRun(row),
    subagents: subagents.map(renderSubagent),
  });
}

function handleSubagentGet(
  deps: RunsApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const params = req.params as { run_id?: string; subagent_id?: string };
  const runId = params.run_id;
  const subId = params.subagent_id;
  if (typeof runId !== "string" || typeof subId !== "string") {
    return reply.code(400).send({ ok: false, code: "bad_params" });
  }
  const row = deps.db
    .prepare(
      `SELECT subagent_id, agent, model, task, started_at, ended_at,
              status, duration_ms, stdout_bytes, stderr_bytes,
              last_output_at, finding_count, summary_json
         FROM subagents
        WHERE run_id = ? AND subagent_id = ?`,
    )
    .get(runId, subId) as
    | (SubagentRow & { summary_json: string | null })
    | undefined;
  if (!row) {
    return reply.code(404).send({ ok: false, code: "subagent_not_found" });
  }
  const truncations = deps.db
    .prepare(
      `SELECT seq, ts, bytes_dropped, stream
         FROM chunk_truncations
        WHERE run_id = ? AND subagent_id = ?
        ORDER BY seq ASC`,
    )
    .all(runId, subId);
  return reply.send({
    subagent: renderSubagent(row),
    summary: parseJsonOrNull(row.summary_json),
    truncations,
  });
}

interface SseTracker {
  open: Map<string, number>;
}
const sseTracker: SseTracker = { open: new Map() };

function bumpSse(key: string, delta: number): number {
  const cur = sseTracker.open.get(key) ?? 0;
  const next = Math.max(0, cur + delta);
  if (next === 0) sseTracker.open.delete(key);
  else sseTracker.open.set(key, next);
  return next;
}

function handleChunksSse(
  deps: RunsApiDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const params = req.params as { run_id?: string; subagent_id?: string };
  const runId = params.run_id;
  const subId = params.subagent_id;
  if (typeof runId !== "string" || typeof subId !== "string") {
    return reply.code(400).send({ ok: false, code: "bad_params" });
  }
  const parsed = chunksQuerySchema.safeParse(req.query ?? {});
  if (!parsed.success) {
    return reply
      .code(400)
      .send({ ok: false, code: "bad_query", error: parsed.error.message });
  }
  const fromSeq = parsed.data.from_seq ?? 0;
  const toSeq = parsed.data.to_seq;

  const key = sseAuthKey(req);
  const after = bumpSse(key, +1);
  if (after > SSE_MAX_CONCURRENT_PER_KEY) {
    bumpSse(key, -1);
    return reply
      .code(429)
      .send({ ok: false, code: "too_many_sse_streams" });
  }

  reply.raw.statusCode = 200;
  reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders?.();

  const send = (event: string, data: unknown): boolean => {
    try {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      return false;
    }
  };

  const hb = setInterval(() => {
    try {
      reply.raw.write(`: hb\n\n`);
    } catch {
      // closed
    }
  }, SSE_HEARTBEAT_MS);

  const cleanups: Array<() => void> = [];
  const finalize = (): void => {
    clearInterval(hb);
    bumpSse(key, -1);
    while (cleanups.length > 0) {
      const c = cleanups.pop();
      if (c) {
        try {
          c();
        } catch {
          // best-effort
        }
      }
    }
  };
  reply.raw.on("close", finalize);
  reply.raw.on("error", finalize);

  const endAndClose = (): void => {
    send("end", { ok: true });
    try {
      reply.raw.end();
    } catch {
      // best-effort
    }
    finalize();
  };

  const liveTail = toSeq === undefined;
  void streamChunks(deps, runId, subId, fromSeq, toSeq, send, () => {
    if (!liveTail) {
      endAndClose();
      return;
    }
    if (isSubagentTerminal(deps, runId, subId)) {
      endAndClose();
      return;
    }
    if (deps.bus === undefined) {
      // No live source wired — degrade to bounded behavior so the
      // client doesn't hang forever waiting on a tail nobody feeds.
      endAndClose();
      return;
    }
    attachLiveChunkTail(deps, runId, subId, send, endAndClose, cleanups);
  });

  return reply;
}

function isSubagentTerminal(
  deps: RunsApiDeps,
  runId: string,
  subId: string,
): boolean {
  const sa = deps.db
    .prepare(
      `SELECT status FROM subagents WHERE run_id = ? AND subagent_id = ?`,
    )
    .get(runId, subId) as { status: string | null } | undefined;
  if (sa && sa.status !== null && TERMINAL_SUBAGENT_STATUSES.has(sa.status)) {
    return true;
  }
  const run = deps.db
    .prepare(`SELECT status FROM runs WHERE run_id = ?`)
    .get(runId) as { status: string | null } | undefined;
  if (run && run.status !== null && TERMINAL_RUN_STATUSES.has(run.status)) {
    return true;
  }
  return false;
}

function attachLiveChunkTail(
  deps: RunsApiDeps,
  runId: string,
  subId: string,
  send: (event: string, data: unknown) => boolean,
  endAndClose: () => void,
  cleanups: Array<() => void>,
): void {
  const bus = deps.bus;
  if (bus === undefined) {
    endAndClose();
    return;
  }
  const onEvent = (evt: ParsedEvent): void => {
    if (evt.runId !== runId) return;
    const rec = evt.record;
    const type = typeof rec.type === "string" ? rec.type : "";
    const recSub =
      typeof rec.subagent_id === "string" ? rec.subagent_id : null;
    if (type === "run_end") {
      endAndClose();
      return;
    }
    if (recSub !== subId) return;
    if (type === "subagent_end") {
      endAndClose();
      return;
    }
    if (type === "subagent_stdout" || type === "subagent_stderr") {
      const ok = send("chunk", {
        seq: rec.seq,
        ts: rec.ts,
        stream: type === "subagent_stdout" ? "stdout" : "stderr",
        encoding: typeof rec.encoding === "string" ? rec.encoding : "utf8",
        chunk: rec.chunk,
      });
      if (!ok) endAndClose();
      return;
    }
    if (type === "chunk_truncated") {
      const ok = send("gap", {
        reason: "retention_gap",
        seq: rec.seq,
        bytes_dropped:
          typeof rec.bytes_dropped === "number" ? rec.bytes_dropped : 0,
        stream:
          rec.stream === "stderr"
            ? "stderr"
            : "stdout",
      });
      if (!ok) endAndClose();
    }
  };
  const onTrunc = (t: TruncationBroadcast): void => {
    if (t.runId !== runId || t.subagentId !== subId) return;
    const ok = send("gap", {
      reason: "retention_gap",
      seq: t.seq,
      bytes_dropped: t.bytesDropped,
      stream: t.stream,
    });
    if (!ok) endAndClose();
  };
  bus.on("event", onEvent);
  bus.on("truncation", onTrunc);
  cleanups.push(() => bus.off("event", onEvent));
  cleanups.push(() => bus.off("truncation", onTrunc));
}

async function streamChunks(
  deps: RunsApiDeps,
  runId: string,
  subId: string,
  fromSeq: number,
  toSeq: number | undefined,
  send: (event: string, data: unknown) => boolean,
  onDone: () => void,
): Promise<void> {
  try {
    const chunkRows = deps.db
      .prepare(
        toSeq !== undefined
          ? `SELECT seq, stream, rotation_index, byte_start, byte_end, ts, encoding
               FROM chunk_offsets
              WHERE run_id = ? AND subagent_id = ? AND seq >= ? AND seq <= ?
              ORDER BY seq ASC`
          : `SELECT seq, stream, rotation_index, byte_start, byte_end, ts, encoding
               FROM chunk_offsets
              WHERE run_id = ? AND subagent_id = ? AND seq >= ?
              ORDER BY seq ASC`,
      )
      .all(
        runId,
        subId,
        fromSeq,
        ...(toSeq !== undefined ? [toSeq] : []),
      ) as ChunkRow[];
    const truncRows = deps.db
      .prepare(
        toSeq !== undefined
          ? `SELECT seq, ts, bytes_dropped, stream
               FROM chunk_truncations
              WHERE run_id = ? AND subagent_id = ? AND seq >= ? AND seq <= ?
              ORDER BY seq ASC`
          : `SELECT seq, ts, bytes_dropped, stream
               FROM chunk_truncations
              WHERE run_id = ? AND subagent_id = ? AND seq >= ?
              ORDER BY seq ASC`,
      )
      .all(
        runId,
        subId,
        fromSeq,
        ...(toSeq !== undefined ? [toSeq] : []),
      ) as TruncRow[];

    const ordered = mergeBySeq(chunkRows, truncRows);
    const fs = await import("node:fs");
    const path = await import("node:path");
    for (const item of ordered) {
      if (item.kind === "trunc") {
        const ok = send("gap", {
          reason: "retention_gap",
          seq: item.row.seq,
          bytes_dropped: item.row.bytes_dropped,
          stream: item.row.stream,
        });
        if (!ok) return;
        continue;
      }
      const filePath = path.join(
        deps.spoolRoot,
        runId,
        spoolBasename(item.row.rotation_index),
      );
      let fd: number;
      try {
        fd = fs.openSync(filePath, "r");
      } catch {
        send("gap", {
          reason: "file_missing",
          seq: item.row.seq,
          stream: item.row.stream,
        });
        continue;
      }
      try {
        const range = item.row.byte_end - item.row.byte_start;
        const buf = Buffer.allocUnsafe(Math.min(range, SSE_PREAD_BUFFER_BYTES));
        let remaining = range;
        let cursor = item.row.byte_start;
        let lineBuf = "";
        while (remaining > 0) {
          const chunkSize = Math.min(remaining, buf.length);
          const got = fs.readSync(fd, buf, 0, chunkSize, cursor);
          if (got === 0) break;
          lineBuf += buf.subarray(0, got).toString("utf8");
          cursor += got;
          remaining -= got;
        }
        const line = lineBuf.replace(/\n$/, "");
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        if (parsed === null) {
          send("gap", {
            reason: "parse_error",
            seq: item.row.seq,
            stream: item.row.stream,
          });
          continue;
        }
        const ok = send("chunk", {
          seq: item.row.seq,
          ts: item.row.ts,
          stream: item.row.stream,
          encoding: item.row.encoding,
          chunk: parsed.chunk,
        });
        if (!ok) return;
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  } catch (err) {
    send("error", { code: "internal", message: (err as Error).message });
  } finally {
    onDone();
  }
}

function buildHealthBody(
  deps: RunsApiDeps,
  now: () => number,
): Record<string, unknown> {
  const iw = deps.indexWriterStats();
  const counts = deps.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM runs WHERE status = 'running') AS running_runs,
         (SELECT COUNT(*) FROM runs WHERE status = 'crashed') AS crashed_runs,
         (SELECT COUNT(*) FROM runs WHERE status IN ('ok','error','timeout')) AS terminal_runs,
         (SELECT COUNT(*) FROM subagents WHERE status = 'running') AS running_subagents,
         (SELECT COUNT(*) FROM chunk_truncations) AS total_truncations
        `,
    )
    .get() as {
      running_runs: number;
      crashed_runs: number;
      terminal_runs: number;
      running_subagents: number;
      total_truncations: number;
    };
  const durability: DurabilityStats = deps.getDurabilityStats
    ? deps.getDurabilityStats()
    : {
        batched_queue_depth: 0,
        fsync_p50_ms: null,
        fsync_p99_ms: null,
        last_fsync_at: null,
      };
  const commitLatencies = deps.getCommitLatencies?.() ?? [];
  return {
    ok: true,
    ts: new Date(now()).toISOString(),
    runs: counts,
    index_writer: {
      ...iw,
      commit_ms_p50: percentile(commitLatencies, 50),
      commit_ms_p95: percentile(commitLatencies, 95),
      commit_samples: commitLatencies.length,
    },
    tailer: {
      parse_errors_total: deps.getTailerParseErrors(),
    },
    durability,
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

interface RunRow {
  run_id: string;
  dispatcher: string;
  repo: string | null;
  branch: string | null;
  pr_number: number | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  last_heartbeat_at: string | null;
  total_subagents: number;
  total_findings: number;
  crashed_reason: string | null;
  parent_pid: number | null;
  writer_daemon_pid: number | null;
  host_boot_id: string | null;
  last_seq: number;
  bytes_written: number;
}

interface SubagentRow {
  subagent_id: string;
  agent: string;
  model: string | null;
  task: string;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  duration_ms: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  last_output_at: string | null;
  finding_count: number;
  summary_json?: string | null;
}

interface ChunkRow {
  seq: number;
  stream: "stdout" | "stderr";
  rotation_index: number;
  byte_start: number;
  byte_end: number;
  ts: string;
  encoding: string;
}

interface TruncRow {
  seq: number;
  ts: string;
  bytes_dropped: number;
  stream: "stdout" | "stderr";
}

type OrderedItem =
  | { kind: "chunk"; row: ChunkRow }
  | { kind: "trunc"; row: TruncRow };

function mergeBySeq(chunks: ChunkRow[], truncs: TruncRow[]): OrderedItem[] {
  const out: OrderedItem[] = [];
  let i = 0;
  let j = 0;
  while (i < chunks.length || j < truncs.length) {
    const c = chunks[i];
    const t = truncs[j];
    if (c && (!t || c.seq <= t.seq)) {
      out.push({ kind: "chunk", row: c });
      i += 1;
    } else if (t) {
      out.push({ kind: "trunc", row: t });
      j += 1;
    }
  }
  return out;
}

function renderRun(row: RunRow): Record<string, unknown> {
  return {
    run_id: row.run_id,
    dispatcher: row.dispatcher,
    repo: row.repo,
    branch: row.branch,
    pr_number: row.pr_number,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    last_heartbeat_at: row.last_heartbeat_at,
    total_subagents: row.total_subagents,
    total_findings: row.total_findings,
    crashed_reason: row.crashed_reason,
    parent_pid: row.parent_pid,
    writer_daemon_pid: row.writer_daemon_pid,
    host_boot_id: row.host_boot_id,
    last_seq: row.last_seq,
    bytes_written: row.bytes_written,
  };
}

function renderSubagent(row: SubagentRow): Record<string, unknown> {
  return {
    subagent_id: row.subagent_id,
    agent: row.agent,
    model: row.model,
    task: row.task,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    duration_ms: row.duration_ms,
    stdout_bytes: row.stdout_bytes,
    stderr_bytes: row.stderr_bytes,
    last_output_at: row.last_output_at,
    finding_count: row.finding_count,
  };
}

interface DecodedCursor {
  startedAt: string;
  runId: string;
}

function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(`${c.startedAt} ${c.runId}`, "utf8").toString("base64url");
}

function decodeCursor(s: string): DecodedCursor | null {
  try {
    const raw = Buffer.from(s, "base64url").toString("utf8");
    const i = raw.indexOf(" ");
    if (i < 0) return null;
    return { startedAt: raw.slice(0, i), runId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

function spoolBasename(rotationIndex: number): string {
  return `events-${String(rotationIndex).padStart(4, "0")}.jsonl`;
}

function parseJsonOrNull(s: string | null): unknown {
  if (typeof s !== "string" || s.length === 0) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function sseAuthKey(req: FastifyRequest): string {
  const sid = readSessionFromHeaders(req);
  if (sid !== null) return `sid:${sid}`;
  const bearer = readBearerFromHeaders(req);
  if (bearer !== null) {
    return "bearer:" + Buffer.from(bearer).toString("base64url").slice(0, 16);
  }
  return `anon:${req.ip}`;
}

function readSessionFromHeaders(req: FastifyRequest): string | null {
  const raw = req.headers.cookie;
  if (typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("obs_session=")) continue;
    const v = trimmed.slice("obs_session=".length);
    return v.length > 0 ? v : null;
  }
  return null;
}

function readBearerFromHeaders(req: FastifyRequest): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^Bearer\s+(\S+)$/);
  return m ? (m[1] ?? null) : null;
}
