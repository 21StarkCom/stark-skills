/**
 * Bootstrap-code capture. This module is imported FIRST by `main.tsx`
 * so it runs before any React code; that satisfies the plan's
 * "strip the fragment from the address bar before any other code runs"
 * requirement (Phase 5 Task 2).
 *
 * It does not perform the network call — `main.tsx` does that after
 * checking `framed` (window.top !== window). Separating capture from
 * the network call keeps the address-bar strip strictly synchronous.
 */
const FRAGMENT_RE = /(?:^|[#&])b=([^&]+)/;

function captureBootstrap(): {
  code: string | null;
  framed: boolean;
} {
  const framed = window.top !== window;
  if (framed) {
    return { code: null, framed: true };
  }
  let code: string | null = null;
  const hash = window.location.hash;
  if (hash.length > 1) {
    const m = FRAGMENT_RE.exec(hash);
    if (m && m[1] !== undefined) {
      try {
        code = decodeURIComponent(m[1]);
      } catch {
        code = null;
      }
    }
    try {
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, "", clean);
    } catch {
      // best-effort
    }
  }
  return { code, framed: false };
}

export const bootstrap = captureBootstrap();
