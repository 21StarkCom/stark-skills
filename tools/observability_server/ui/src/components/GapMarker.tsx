/**
 * Inline gap marker rendered when the WebSocket or chunk SSE delivers a
 * `chunk_truncated` (or `event: gap`) record. The marker:
 *
 *   - is a `<div role="separator">` with an `aria-label` carrying the
 *     bytes-dropped count, per plan Phase 5 Task 4.
 *   - is keyboard-focusable (`tabIndex=0`) so screen-reader users can
 *     land on it while walking the log viewer.
 */
import type { GapEvent } from "../types";

interface Props {
  gap: GapEvent;
}

export function GapMarker({ gap }: Props): JSX.Element {
  const bytes = gap.bytes_dropped ?? 0;
  const reasonText = describeReason(gap.reason);
  const label = `${bytes.toLocaleString()} bytes dropped by ${reasonText}`;
  return (
    <div
      role="separator"
      aria-label={label}
      tabIndex={0}
      className={`gap-marker gap-marker--${gap.reason}`}
      data-seq={gap.seq}
    >
      <span aria-hidden="true" className="gap-marker__icon">
        ⚠
      </span>
      <span className="gap-marker__text">{label}</span>
    </div>
  );
}

function describeReason(reason: GapEvent["reason"]): string {
  switch (reason) {
    case "retention_gap":
      return "retention";
    case "file_missing":
      return "spool file missing";
    case "parse_error":
      return "parse error";
    case "synthesis_corrupt":
      return "synthesis corruption";
  }
}
