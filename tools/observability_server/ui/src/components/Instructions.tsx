/**
 * Fallback page rendered when the bootstrap flow fails.
 *
 * Two reasons:
 *   - `framed`: the page is loaded in an iframe; we refuse to perform
 *     the bootstrap exchange and tell the operator to open in a top-
 *     level window.
 *   - `unauthorized`: no valid session cookie and the bootstrap code is
 *     either missing or rejected. Direct the operator to the helper
 *     CLI.
 */
import type { JSX } from "react";

interface Props {
  reason: "framed" | "unauthorized";
}

export function Instructions({ reason }: Props): JSX.Element {
  return (
    <main aria-labelledby="instructions-heading" className="instructions">
      <h1 id="instructions-heading">stark-observability</h1>
      {reason === "framed" ? (
        <p>
          This page refused to bootstrap because it is loaded in an
          iframe. Open it in a top-level browser window instead.
        </p>
      ) : (
        <>
          <p>
            No active session. Run the helper to get a fresh bootstrap
            link and open it in this window:
          </p>
          <pre>
            <code>
              node --experimental-strip-types tools/observability_open.ts
            </code>
          </pre>
          <p>
            The helper reads the bootstrap token from the macOS Keychain
            (service <code>stark-observability-bootstrap-token</code>),
            requests a single-use code from{" "}
            <code>POST /api/auth/bootstrap</code>, and opens this UI at{" "}
            <code>http://127.0.0.1:7700/#b=&lt;code&gt;</code>.
          </p>
        </>
      )}
    </main>
  );
}
