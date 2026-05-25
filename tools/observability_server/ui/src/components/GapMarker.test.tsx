import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { GapMarker } from "./GapMarker";
import type { GapEvent } from "../types";

function make(gap: GapEvent): string {
  return renderToStaticMarkup(<GapMarker gap={gap} />);
}

describe("GapMarker", () => {
  it("renders role=separator with the bytes-dropped count in aria-label", () => {
    const html = make({
      kind: "gap",
      seq: 12,
      reason: "retention_gap",
      bytes_dropped: 4096,
      stream: "stdout",
    });
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-label="4,096 bytes dropped by retention"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-seq="12"');
  });

  it("supports the synthesis_corrupt reason", () => {
    const html = make({ kind: "gap", seq: 1, reason: "synthesis_corrupt" });
    expect(html).toContain("synthesis corruption");
  });
});
