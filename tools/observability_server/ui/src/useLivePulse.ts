/**
 * Drives the left-rail tree's "currently emitting" pulse from a live
 * WebSocket subscription per visible/running run (plan Phase 5 Task 3:
 * "Pulse indicator on currently-emitting sub-agents (driven by
 * WebSocket subscription with `live: true`)").
 *
 * Subagent `status === "running"` is NOT used — a sub-agent can be
 * `running` but quiet for minutes, and the pulse must reflect actual
 * recent emission. The hook subscribes with `live: true` per running
 * run and tracks the last emission timestamp per `subagent_id`.
 * Anything that emitted within `LIVE_WINDOW_MS` is considered live.
 *
 * Cleanup: subscriptions for runs that drop out of the input list (no
 * longer running, or unmounted) close on the next effect tick.
 */
import { useEffect, useRef, useState } from "react";

import type { LogEvent } from "./types";
import { subscribeLog, type Subscription } from "./ws";

const LIVE_WINDOW_MS = 3_000;
const SWEEP_INTERVAL_MS = 1_000;

export function useLivePulse(runningRunIds: ReadonlyArray<string>): Set<string> {
  const [pulse, setPulse] = useState<Set<string>>(() => new Set());
  // Stable across renders so subscription handlers can mutate it without
  // re-creating the subscription on every commit.
  const lastEmitAtRef = useRef<Map<string, number>>(new Map());
  const subsRef = useRef<Map<string, Subscription>>(new Map());

  useEffect(() => {
    const seen = new Set(runningRunIds);

    // Open subs for new runs.
    for (const runId of runningRunIds) {
      if (subsRef.current.has(runId)) continue;
      const sub = subscribeLog({
        runId,
        onBatch: (events: LogEvent[]) => {
          let touched = false;
          const now = Date.now();
          for (const ev of events) {
            // Pulse is "currently emitting" → only chunk + gap events
            // count. Findings and lifecycle don't pulse a sub-agent.
            if (ev.kind !== "chunk" && ev.kind !== "gap") continue;
            const id = ev.subagent_id ?? null;
            if (id === null || id.length === 0) continue;
            lastEmitAtRef.current.set(id, now);
            touched = true;
          }
          if (touched) sweep(lastEmitAtRef.current, setPulse);
        },
      });
      subsRef.current.set(runId, sub);
    }

    // Close subs for runs that left the running set.
    for (const [runId, sub] of subsRef.current) {
      if (!seen.has(runId)) {
        sub.close();
        subsRef.current.delete(runId);
      }
    }

    // Periodic sweep so the pulse falls off after LIVE_WINDOW_MS even
    // when no new events arrive.
    const t = setInterval(() => {
      sweep(lastEmitAtRef.current, setPulse);
    }, SWEEP_INTERVAL_MS);

    return () => {
      clearInterval(t);
    };
    // Re-run only when the set of running run ids actually changes, not
    // when a new array identity comes through with the same membership.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningRunIds.slice().sort().join("")]);

  // Final cleanup on unmount.
  useEffect(() => {
    return () => {
      for (const [, sub] of subsRef.current) sub.close();
      subsRef.current.clear();
    };
  }, []);

  return pulse;
}

function sweep(
  map: Map<string, number>,
  setPulse: (s: Set<string>) => void,
): void {
  const now = Date.now();
  const next = new Set<string>();
  for (const [id, ts] of map) {
    if (now - ts <= LIVE_WINDOW_MS) {
      next.add(id);
    } else {
      map.delete(id);
    }
  }
  setPulse(next);
}
