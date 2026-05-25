/**
 * Polite ARIA live region with 2 s announcement batching and a quiet
 * toggle. Pushes are buffered; the buffer flushes to the region every
 * 2 s, or sooner if a high-priority message is enqueued. Plan §9.
 *
 * Quiet mode mutes the announcer entirely without re-rendering the
 * region (so the region stays in the DOM for ATs that rely on its
 * presence).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

interface LiveCtx {
  announce(message: string, priority?: "low" | "high"): void;
  quiet: boolean;
  setQuiet(q: boolean): void;
}

const Ctx = createContext<LiveCtx | null>(null);

const BATCH_MS = 2_000;

interface ProviderProps {
  children: ReactNode;
}

export function LiveRegionProvider({ children }: ProviderProps): JSX.Element {
  const [text, setText] = useState("");
  const [quiet, setQuiet] = useState(false);
  const buffer = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (buffer.current.length === 0) return;
    const joined = buffer.current.join(". ");
    buffer.current = [];
    setText(joined);
  }, []);

  const announce = useCallback(
    (message: string, priority: "low" | "high" = "low") => {
      if (quiet) return;
      buffer.current.push(message);
      if (priority === "high") {
        if (timer.current !== null) clearTimeout(timer.current);
        flush();
        return;
      }
      if (timer.current !== null) return;
      timer.current = setTimeout(flush, BATCH_MS);
    },
    [flush, quiet],
  );

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const value = useMemo<LiveCtx>(
    () => ({ announce, quiet, setQuiet }),
    [announce, quiet, setQuiet],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        role="status"
        className="sr-only"
      >
        {text}
      </div>
    </Ctx.Provider>
  );
}

export function useLiveRegion(): LiveCtx {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error("useLiveRegion must be used inside <LiveRegionProvider>");
  }
  return v;
}
