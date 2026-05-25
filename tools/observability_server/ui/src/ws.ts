/**
 * WebSocket subscription helper. Wraps the `/ws` endpoint from
 * `server/websocket_hub.ts`.
 *
 * Frame coalescing: events that arrive within 50 ms are batched and
 * delivered to the consumer as one array — that becomes one React
 * state commit, which matches the plan's "WebSocket frame coalescing"
 * mitigation for live-tail render thrash (Phase 5 Risks).
 *
 * Reconnect strategy: exponential backoff capped at 30 s. On
 * re-subscribe we send `from_seq = lastSeenSeq + 1` so we replay only
 * the bytes lost across the gap.
 */
import type { LogEvent, ChunkEvent, GapEvent, FindingEvent, LifecycleEvent } from "./types";

export interface SubscribeOptions {
  runId: string;
  subagentId?: string;
  fromSeq?: number;
  onBatch: (events: LogEvent[]) => void;
  onError?: (code: string, message?: string) => void;
  onOpen?: () => void;
}

export interface Subscription {
  close(): void;
  /** Current last-seen seq; written every time an event is delivered. */
  lastSeenSeq(): number;
}

const COALESCE_MS = 50;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 500;

export function subscribeLog(opts: SubscribeOptions): Subscription {
  let socket: WebSocket | null = null;
  let closed = false;
  let backoff = INITIAL_BACKOFF_MS;
  let lastSeq = opts.fromSeq ?? 0;
  let pending: LogEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    flushTimer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      opts.onBatch(batch);
    } catch {
      // consumer-side error; don't break the socket
    }
  }

  function schedule(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flush, COALESCE_MS);
  }

  function push(event: LogEvent): void {
    pending.push(event);
    if (typeof event.seq === "number" && event.seq > lastSeq) {
      lastSeq = event.seq;
    }
    schedule();
  }

  function connect(): void {
    if (closed) return;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${window.location.host}/ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      opts.onError?.("ws_construct_failed", (e as Error).message);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      backoff = INITIAL_BACKOFF_MS;
      const msg: Record<string, unknown> = {
        type: "subscribe",
        run_id: opts.runId,
        live: true,
        from_seq: lastSeq,
      };
      if (opts.subagentId !== undefined) msg.subagent_id = opts.subagentId;
      try {
        ws.send(JSON.stringify(msg));
        opts.onOpen?.();
      } catch {
        // socket may already be closing; let onclose drive reconnect
      }
    });
    ws.addEventListener("message", (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (parsed === null || typeof parsed !== "object") return;
      const msg = parsed as Record<string, unknown>;
      const type = typeof msg.type === "string" ? msg.type : "";
      if (type === "ping") {
        try {
          ws.send(JSON.stringify({ type: "pong" }));
        } catch {
          // ignore
        }
        return;
      }
      if (type === "error") {
        const code = typeof msg.code === "string" ? msg.code : "unknown";
        const message = typeof msg.message === "string" ? msg.message : undefined;
        if (code === "retention_gap") {
          const seq = typeof msg.seq === "number" ? msg.seq : lastSeq;
          const sid =
            typeof msg.subagent_id === "string" ? msg.subagent_id : null;
          push({ kind: "gap", reason: "retention_gap", seq, subagent_id: sid });
          return;
        }
        opts.onError?.(code, message);
        return;
      }
      if (type === "end") return;
      if (type !== "event") return;
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return;
      const evType = typeof event.type === "string" ? event.type : "";
      const seq = typeof event.seq === "number" ? event.seq : 0;
      const ts = typeof event.ts === "string" ? event.ts : "";
      const subId = typeof event.subagent_id === "string" ? event.subagent_id : null;
      if (evType === "subagent_stdout" || evType === "subagent_stderr") {
        const e: ChunkEvent = {
          kind: "chunk",
          seq,
          ts,
          stream: evType === "subagent_stdout" ? "stdout" : "stderr",
          encoding: typeof event.encoding === "string" ? event.encoding : "utf8",
          chunk: typeof event.chunk === "string" ? event.chunk : "",
          subagent_id: subId,
        };
        push(e);
        return;
      }
      if (evType === "chunk_truncated") {
        const e: GapEvent = {
          kind: "gap",
          seq,
          reason: "retention_gap",
          bytes_dropped:
            typeof event.bytes_dropped === "number" ? event.bytes_dropped : 0,
          stream:
            event.stream === "stderr" ? "stderr" : "stdout",
          subagent_id: subId,
        };
        push(e);
        return;
      }
      if (evType === "subagent_progress") {
        // Server contract: `kind` is a top-level field on the event;
        // the finding object lives under `payload`. Reading
        // `payload.kind` here would always classify findings as
        // lifecycle and drop them from the findings list.
        const progressKind = typeof event.kind === "string" ? event.kind : "";
        const payload =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        if (progressKind === "finding") {
          const f: FindingEvent = {
            kind: "finding",
            seq,
            ts,
            subagent_id: subId,
            payload,
          };
          push(f);
          return;
        }
      }
      const lc: LifecycleEvent = {
        kind: "lifecycle",
        seq,
        ts,
        subagent_id: subId,
        type: evType,
        payload: event as Record<string, unknown>,
      };
      push(lc);
    });
    ws.addEventListener("close", () => {
      socket = null;
      scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close handler does the reconnect; just record the error
      opts.onError?.("ws_error");
    });
  }

  function scheduleReconnect(): void {
    if (closed) return;
    const delay = Math.min(backoff, MAX_BACKOFF_MS);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    setTimeout(connect, delay);
  }

  connect();

  return {
    close(): void {
      closed = true;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (socket !== null) {
        try {
          socket.close(1000, "client-close");
        } catch {
          // best-effort
        }
        socket = null;
      }
    },
    lastSeenSeq(): number {
      return lastSeq;
    },
  };
}
