/**
 * Live log viewer.
 *
 *   - Subscribes via WebSocket with `from_seq = lastSeenSeq` on every
 *     reconnect (the ws helper carries that state).
 *   - Renders chunks as plain React text — never via the unsafe HTML
 *     prop. ANSI tokens map to `<span className=...>`.
 *   - Virtualizes via `@tanstack/react-virtual` so 27 sub-agents at
 *     10 KB/s don't melt the browser.
 *   - Collapsible stderr block via `<details>` for each stderr line.
 *   - Inline `chunk_truncated` gap markers via <GapMarker />.
 */
import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { LogEvent } from "../types";
import { ansiToTokens } from "../ansi";
import { GapMarker } from "./GapMarker";

interface Props {
  events: LogEvent[];
  liveStatus: "connecting" | "live" | "disconnected" | "ended";
}

const ROW_HEIGHT_PX = 22;

export function LogViewer({ events, liveStatus }: Props): JSX.Element {
  const parentRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => events, [events]);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 30,
  });

  // Auto-scroll-to-bottom when new rows arrive AND the user is already
  // near the bottom (within 100 px). Otherwise leave the scroll alone
  // so a user inspecting earlier output isn't yanked away.
  useEffect(() => {
    const el = parentRef.current;
    if (el === null) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (fromBottom < 100) {
      el.scrollTop = el.scrollHeight;
    }
  }, [rows.length]);

  return (
    <section
      className="log-viewer"
      aria-label="Live log output"
      aria-busy={liveStatus === "connecting" ? true : undefined}
    >
      <div className="log-viewer__status" role="status" aria-live="off">
        {liveStatus === "connecting"
          ? "Connecting…"
          : liveStatus === "disconnected"
            ? "Disconnected — reconnecting"
            : liveStatus === "ended"
              ? "Ended"
              : "Live"}
      </div>
      <div ref={parentRef} className="log-viewer__scroll" tabIndex={0}>
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: "relative",
            width: "100%",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vi) => {
            const event = rows[vi.index];
            if (event === undefined) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={rowVirtualizer.measureElement}
                className="log-viewer__row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                  width: "100%",
                }}
              >
                <Row event={event} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Row({ event }: { event: LogEvent }): JSX.Element {
  switch (event.kind) {
    case "chunk":
      return event.stream === "stderr" ? (
        <StderrLine text={chunkText(event.chunk, event.encoding)} seq={event.seq} ts={event.ts} />
      ) : (
        <StdoutLine text={chunkText(event.chunk, event.encoding)} seq={event.seq} ts={event.ts} />
      );
    case "gap":
      return <GapMarker gap={event} />;
    case "finding":
      return <Finding seq={event.seq} ts={event.ts} payload={event.payload} />;
    case "lifecycle":
      return <Lifecycle seq={event.seq} ts={event.ts} type={event.type} />;
  }
}

function chunkText(chunk: string, encoding: string): string {
  if (encoding === "base64") {
    try {
      return atob(chunk);
    } catch {
      return "";
    }
  }
  return chunk;
}

function StdoutLine({ text, seq, ts }: { text: string; seq: number; ts: string }): JSX.Element {
  const tokens = useMemo(() => ansiToTokens(text), [text]);
  return (
    <span className="log-line log-line--stdout" data-seq={seq}>
      <span className="log-line__ts" aria-hidden="true">
        {ts.slice(11, 23)}
      </span>
      {tokens.map((tok, i) => (
        <span key={i} className={tok.classes.join(" ")}>
          {tok.text}
        </span>
      ))}
    </span>
  );
}

function StderrLine({ text, seq, ts }: { text: string; seq: number; ts: string }): JSX.Element {
  const tokens = useMemo(() => ansiToTokens(text), [text]);
  return (
    <details className="log-line log-line--stderr" data-seq={seq}>
      <summary>
        <span className="log-line__ts" aria-hidden="true">
          {ts.slice(11, 23)}
        </span>
        <span className="log-line__label">stderr</span>
        <span className="log-line__preview">{firstLine(text)}</span>
      </summary>
      <pre className="log-line__full">
        {tokens.map((tok, i) => (
          <span key={i} className={tok.classes.join(" ")}>
            {tok.text}
          </span>
        ))}
      </pre>
    </details>
  );
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl < 0 ? s.slice(0, 120) : s.slice(0, Math.min(nl, 120));
}

function Finding({
  seq,
  ts,
  payload,
}: {
  seq: number;
  ts: string;
  payload: Record<string, unknown>;
}): JSX.Element {
  const sev = typeof payload.severity === "string" ? payload.severity : "info";
  const dom = typeof payload.domain === "string" ? payload.domain : "general";
  const msg = typeof payload.message === "string" ? payload.message : JSON.stringify(payload);
  return (
    <article
      className={`log-finding log-finding--${sev}`}
      data-seq={seq}
      aria-label={`Finding: ${sev} ${dom}`}
    >
      <span className="log-line__ts" aria-hidden="true">
        {ts.slice(11, 23)}
      </span>
      <span className="log-finding__sev">{sev}</span>
      <span className="log-finding__dom">{dom}</span>
      <span className="log-finding__msg">{msg}</span>
    </article>
  );
}

function Lifecycle({
  seq,
  ts,
  type,
}: {
  seq: number;
  ts: string;
  type: string;
}): JSX.Element {
  return (
    <span className="log-lifecycle" data-seq={seq}>
      <span className="log-line__ts" aria-hidden="true">
        {ts.slice(11, 23)}
      </span>
      <em>{type}</em>
    </span>
  );
}
