/**
 * WebSocket hub for live tail + backfill (Phase 4 Task 3).
 *
 * Mount: `/ws`. Upgrades require a valid `obs_session` cookie or
 * `Authorization: Bearer <bootstrap_token>` — the hub piggybacks on
 * `AuthState.verifySession()` and `verifyBootstrapToken()` so a single
 * source of truth controls who can subscribe.
 *
 * Message contract:
 *
 *   client → server:
 *     { type: "subscribe", run_id?, subagent_id?, repo?, live?, from_seq?, event_types? }
 *     { type: "pong" }
 *
 *   server → client:
 *     { type: "event", sub_id, event }        - one JSONL record (backfill or live)
 *     { type: "ping" }                         - 25 s
 *     { type: "error", code: "retention_gap" } - missing spool file
 *     { type: "error", code }                  - other errors
 *     { type: "end" }                          - backfill complete (live=false)
 *
 * Backfill is sourced EXCLUSIVELY from `event_offsets` UNION
 * `synthetic_events` (RT3) — both ordered by seq. Live tail is driven
 * by the `EventBus.event` + `EventBus.truncation` channels.
 *
 * Per-connection limits:
 *   - 25 s server ping; 10 s pong deadline → close 4002 stale.
 *   - 4 concurrent connections per auth key.
 */

import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";

import type { EventBus, ParsedEvent, TruncationBroadcast } from "./event_bus.ts";
import {
  authenticateForUpgrade,
  checkUpgradeAllowed,
} from "./middleware.ts";
import type { AuthState } from "./auth.ts";

const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS_PER_KEY = 4;
const BACKFILL_BATCH_SIZE = 200;
const PREAD_BUFFER_BYTES = 256 * 1024;

interface SubscribeMessage {
  type: "subscribe";
  run_id?: string;
  subagent_id?: string;
  repo?: string;
  live?: boolean;
  from_seq?: number;
  event_types?: string[];
}

export interface Subscription {
  runId?: string;
  subagentId?: string;
  repo?: string;
  live: boolean;
  fromSeq: number;
  eventTypes?: Set<string>;
}

export interface WebSocketHubDeps {
  db: Database.Database;
  bus: EventBus;
  auth: AuthState;
  spoolRoot: string;
  /** Resolved `host:port` the server publishes on. Drives upgrade Host/Origin. */
  publishedHost: string;
  /** True iff bound on a non-loopback address. Drives wss-only enforcement. */
  isLan: boolean;
  /** True iff Caddy is fronting Node with TLS. */
  tlsTerminated: boolean;
}

interface ConnectionState {
  socket: WebSocket;
  authKey: string;
  subscription: Subscription | null;
  pingTimer: NodeJS.Timeout | null;
  pongDeadline: NodeJS.Timeout | null;
  onEvent: ((evt: ParsedEvent) => void) | null;
  onTruncation: ((t: TruncationBroadcast) => void) | null;
}

export class WebSocketHub {
  private readonly wss: WebSocketServer;
  private readonly deps: WebSocketHubDeps;
  private readonly conns = new Set<ConnectionState>();
  private readonly perKeyCounts = new Map<string, number>();

  constructor(deps: WebSocketHubDeps) {
    this.deps = deps;
    this.wss = new WebSocketServer({ noServer: true });
  }

  /** Total live subscribers. Surfaced by `/api/health`. */
  getStats(): { connections: number } {
    return { connections: this.conns.size };
  }

  attach(app: FastifyInstance): void {
    app.server.on("upgrade", (req, socket, head) => {
      // Only handle our `/ws` path; let other upgrades (e.g. fastify's
      // own future use) flow through unaffected.
      const url = req.url ?? "";
      if (!url.startsWith("/ws")) return;
      // Defense-in-depth Host/Origin + LAN-TLS check. `app.server`
      // `upgrade` fires BEFORE Fastify's `onRequest` guard, so without
      // this a cookie/Bearer pair from a disallowed Origin/Host (or a
      // plain ws:// off-loopback in LAN mode) would still subscribe.
      const rejection = checkUpgradeAllowed(
        req.headers as unknown as Record<string, unknown>,
        {
          publishedHost: this.deps.publishedHost,
          isLan: this.deps.isLan,
          tlsTerminated: this.deps.tlsTerminated,
          auth: this.deps.auth,
        },
      );
      if (rejection !== null) {
        socket.write(
          `HTTP/1.1 ${rejection.status} ${rejection.reason}\r\nContent-Length: 0\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      // Synthesize a FastifyRequest-shaped object that the auth helper
      // can read headers from. `authenticateForUpgrade` only needs the
      // `headers` field, so the cast is safe.
      const reqShim = {
        headers: req.headers,
        ip: req.socket.remoteAddress ?? "",
      } as unknown as FastifyRequest;
      const auth = authenticateForUpgrade(reqShim, this.deps.auth);
      if (auth === null) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      const authKey =
        auth.kind === "session" ? `sid:${auth.sid}` : "bearer:token";
      const existing = this.perKeyCounts.get(authKey) ?? 0;
      if (existing >= MAX_CONNECTIONS_PER_KEY) {
        socket.write(
          "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.onConnection(ws, authKey),
      );
    });
  }

  closeAll(reason = "shutdown"): void {
    for (const c of this.conns) {
      try {
        c.socket.close(1001, reason);
      } catch {
        // best-effort
      }
    }
  }

  private onConnection(socket: WebSocket, authKey: string): void {
    const state: ConnectionState = {
      socket,
      authKey,
      subscription: null,
      pingTimer: null,
      pongDeadline: null,
      onEvent: null,
      onTruncation: null,
    };
    this.conns.add(state);
    this.perKeyCounts.set(authKey, (this.perKeyCounts.get(authKey) ?? 0) + 1);

    socket.on("message", (raw) => this.onMessage(state, raw.toString("utf8")));
    socket.on("close", () => this.closeConn(state));
    socket.on("error", () => this.closeConn(state));

    state.pingTimer = setInterval(() => {
      if (state.socket.readyState !== state.socket.OPEN) return;
      try {
        state.socket.send(JSON.stringify({ type: "ping" }));
      } catch {
        return;
      }
      if (state.pongDeadline !== null) clearTimeout(state.pongDeadline);
      state.pongDeadline = setTimeout(() => {
        try {
          state.socket.close(4002, "stale");
        } catch {
          // best-effort
        }
      }, PONG_TIMEOUT_MS);
      if (typeof state.pongDeadline.unref === "function") {
        state.pongDeadline.unref();
      }
    }, PING_INTERVAL_MS);
    if (typeof state.pingTimer.unref === "function") {
      state.pingTimer.unref();
    }
  }

  private closeConn(state: ConnectionState): void {
    if (!this.conns.has(state)) return;
    this.conns.delete(state);
    const before = this.perKeyCounts.get(state.authKey) ?? 0;
    const after = before - 1;
    if (after <= 0) this.perKeyCounts.delete(state.authKey);
    else this.perKeyCounts.set(state.authKey, after);
    if (state.pingTimer !== null) clearInterval(state.pingTimer);
    if (state.pongDeadline !== null) clearTimeout(state.pongDeadline);
    if (state.onEvent !== null) this.deps.bus.off("event", state.onEvent);
    if (state.onTruncation !== null) {
      this.deps.bus.off("truncation", state.onTruncation);
    }
  }

  private onMessage(state: ConnectionState, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(state, "bad_json");
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      sendError(state, "bad_message");
      return;
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === "pong") {
      if (state.pongDeadline !== null) {
        clearTimeout(state.pongDeadline);
        state.pongDeadline = null;
      }
      return;
    }
    if (type !== "subscribe") {
      sendError(state, "bad_message");
      return;
    }
    const sub = parseSubscription(parsed as SubscribeMessage);
    if (sub === null) {
      sendError(state, "bad_subscribe");
      return;
    }
    if (state.subscription !== null) {
      sendError(state, "already_subscribed");
      return;
    }
    state.subscription = sub;
    this.runBackfill(state).catch((err) => {
      sendError(state, "backfill_failed", (err as Error).message);
    });
  }

  private async runBackfill(state: ConnectionState): Promise<void> {
    const sub = state.subscription!;
    let cursor = sub.fromSeq;
    let drained = false;
    while (!drained) {
      const rows = this.readBackfillBatch(sub, cursor);
      if (rows.length === 0) break;
      for (const row of rows) {
        if (state.socket.readyState !== state.socket.OPEN) return;
        if (sub.eventTypes !== undefined && !sub.eventTypes.has(row.type)) {
          cursor = row.seq;
          continue;
        }
        const evt = this.materializeEvent(row, sub.runId!);
        if (evt === null) {
          send(state, {
            type: "error",
            code: row.synthetic === 1 ? "synthesis_corrupt" : "retention_gap",
            seq: row.seq,
          });
          cursor = row.seq;
          continue;
        }
        send(state, {
          type: "event",
          sub_id: row.subagent_id ?? null,
          event: evt,
        });
        cursor = row.seq;
      }
      drained = rows.length < BACKFILL_BATCH_SIZE;
    }
    if (sub.live) {
      this.attachLive(state);
    } else {
      send(state, { type: "end" });
      try {
        state.socket.close(1000, "backfill-complete");
      } catch {
        // best-effort
      }
    }
  }

  private readBackfillBatch(
    sub: Subscription,
    fromSeq: number,
  ): BackfillRow[] {
    return readBackfillBatch(this.deps.db, sub, fromSeq);
  }

  private materializeEvent(
    row: BackfillRow,
    runId: string,
  ): Record<string, unknown> | null {
    if (row.synthetic === 1) {
      try {
        return JSON.parse(row.payload_json ?? "null") as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    const filePath = path.join(
      this.deps.spoolRoot,
      runId,
      spoolBasename(row.rotation_index),
    );
    let fd: number;
    try {
      fd = fs.openSync(filePath, "r");
    } catch {
      return null;
    }
    try {
      const range = row.byte_end - row.byte_start;
      if (range <= 0) return null;
      const buf = Buffer.allocUnsafe(Math.min(range, PREAD_BUFFER_BYTES));
      let remaining = range;
      let cursor = row.byte_start;
      let text = "";
      while (remaining > 0) {
        const chunkSize = Math.min(remaining, buf.length);
        const got = fs.readSync(fd, buf, 0, chunkSize, cursor);
        if (got === 0) break;
        text += buf.subarray(0, got).toString("utf8");
        cursor += got;
        remaining -= got;
      }
      const line = text.replace(/\n$/, "");
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }

  private attachLive(state: ConnectionState): void {
    const sub = state.subscription!;
    const onEvent = (evt: ParsedEvent): void => {
      if (sub.runId !== undefined && evt.runId !== sub.runId) return;
      const subId = (evt.record["subagent_id"] as string | undefined) ?? null;
      if (sub.subagentId !== undefined && subId !== sub.subagentId) return;
      const evtType = (evt.record["type"] as string | undefined) ?? "";
      if (sub.eventTypes !== undefined && !sub.eventTypes.has(evtType)) return;
      send(state, {
        type: "event",
        sub_id: subId,
        event: evt.record,
      });
    };
    const onTruncation = (t: TruncationBroadcast): void => {
      if (sub.runId !== undefined && t.runId !== sub.runId) return;
      if (sub.subagentId !== undefined && t.subagentId !== sub.subagentId) {
        return;
      }
      if (sub.eventTypes !== undefined && !sub.eventTypes.has("chunk_truncated")) {
        return;
      }
      send(state, {
        type: "event",
        sub_id: t.subagentId,
        event: {
          seq: t.seq,
          ts: t.ts,
          type: "chunk_truncated",
          subagent_id: t.subagentId,
          stream: t.stream,
          bytes_dropped: t.bytesDropped,
        },
      });
    };
    state.onEvent = onEvent;
    state.onTruncation = onTruncation;
    this.deps.bus.on("event", onEvent);
    this.deps.bus.on("truncation", onTruncation);
  }
}

/**
 * Reads up to `BACKFILL_BATCH_SIZE` rows from `event_offsets` UNION
 * `synthetic_events` for a given subscription window. Exported so the
 * RT3 synthetic-event subagent_id filter is unit-testable without
 * spinning up a WebSocket server.
 */
export function readBackfillBatch(
  db: Database.Database,
  sub: Subscription,
  fromSeq: number,
): BackfillRow[] {
  if (sub.runId === undefined) return [];
  const subFilter =
    sub.subagentId !== undefined ? " AND subagent_id = ?" : "";
  const params: unknown[] = [sub.runId, fromSeq];
  if (sub.subagentId !== undefined) params.push(sub.subagentId);
  params.push(BACKFILL_BATCH_SIZE);
  const realRows = db
    .prepare(
      `SELECT seq, ts, type, subagent_id, rotation_index, byte_start, byte_end, 0 AS synthetic, NULL AS payload_json
         FROM event_offsets
        WHERE run_id = ? AND seq > ?${subFilter}
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(...params) as BackfillRow[];
  // Extract subagent_id from payload_json so subagent-filtered
  // subscriptions don't leak synthetic subagent_end / run_end rows
  // that belong to a different subagent (RT3 contract).
  const synthRows = db
    .prepare(
      `SELECT seq, ts, type,
              json_extract(payload_json, '$.subagent_id') AS subagent_id,
              0 AS rotation_index, 0 AS byte_start, 0 AS byte_end,
              1 AS synthetic, payload_json
         FROM synthetic_events
        WHERE run_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?`,
    )
    .all(sub.runId, fromSeq, BACKFILL_BATCH_SIZE) as BackfillRow[];
  // Merge by seq ascending and re-cap at BACKFILL_BATCH_SIZE.
  const merged = mergeBySeq(realRows, synthRows).slice(0, BACKFILL_BATCH_SIZE);
  if (sub.subagentId !== undefined) {
    return merged.filter((r) => {
      if (r.subagent_id === sub.subagentId) return true;
      // run_end is run-scoped, has no subagent_id and is relevant
      // to every subagent subscriber on the run.
      if (r.subagent_id === null && r.type === "run_end") return true;
      return false;
    });
  }
  return merged;
}

export interface BackfillRow {
  seq: number;
  ts: string;
  type: string;
  subagent_id: string | null;
  rotation_index: number;
  byte_start: number;
  byte_end: number;
  synthetic: 0 | 1;
  payload_json: string | null;
  /** Synthesized join key — `event_offsets.run_id` from the WHERE. */
  run_id?: string;
}

function mergeBySeq(a: BackfillRow[], b: BackfillRow[]): BackfillRow[] {
  const out: BackfillRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (x && (!y || x.seq <= y.seq)) {
      out.push(x);
      i += 1;
    } else if (y) {
      out.push(y);
      j += 1;
    }
  }
  return out;
}

export function parseSubscription(msg: SubscribeMessage): Subscription | null {
  if (typeof msg !== "object" || msg === null) return null;
  const runId = typeof msg.run_id === "string" ? msg.run_id : undefined;
  const subagentId = typeof msg.subagent_id === "string" ? msg.subagent_id : undefined;
  const repo = typeof msg.repo === "string" ? msg.repo : undefined;
  const live = msg.live === undefined ? true : Boolean(msg.live);
  const fromSeq = typeof msg.from_seq === "number" && Number.isInteger(msg.from_seq)
    ? Math.max(0, msg.from_seq)
    : 0;
  const eventTypes = Array.isArray(msg.event_types) && msg.event_types.length > 0
    ? new Set(msg.event_types.filter((t) => typeof t === "string"))
    : undefined;
  // Repo-only subscriptions are not yet supported — backfill + live
  // filter would otherwise silently return nothing. Require run_id
  // until a multi-run aggregating selector is implemented.
  if (runId === undefined) return null;
  return { runId, subagentId, repo, live, fromSeq, eventTypes };
}

function send(state: ConnectionState, msg: unknown): void {
  if (state.socket.readyState !== state.socket.OPEN) return;
  try {
    state.socket.send(JSON.stringify(msg));
  } catch {
    // socket closed mid-write
  }
}

function sendError(state: ConnectionState, code: string, message?: string): void {
  const payload: Record<string, unknown> = { type: "error", code };
  if (message !== undefined) payload.message = message;
  send(state, payload);
}

function spoolBasename(rotationIndex: number): string {
  return `events-${String(rotationIndex).padStart(4, "0")}.jsonl`;
}
