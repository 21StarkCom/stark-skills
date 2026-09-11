// CI wrapper for the statusline 5H/7D usage-bar render regression test.
//
// The real assertions live in config/statusline-render.test.sh, which drives the
// whole config/statusline-command.sh under a controlled $HOME with a seeded idun
// daemon-state file and asserts the rendered percent per window (STARK-2807): each
// window is a usage bar filled from the daemon's live poll of the current seat when
// present+fresh, falling back to the frozen payload otherwise. The load-bearing
// invariant is the seat-key guard: the daemon figure must come from the current
// seat's own object, and a seat absent from the state falls back to the payload
// rather than leaking a neighbouring seat's number. This runs that harness under
// `npm test` so a future edit is caught in CI, not on Aryeh's status line.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("statusline 5H/7D dual-source render keeps its behavior", () => {
  const script = path.join(import.meta.dirname, "..", "config", "statusline-render.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    `statusline-render.test.sh failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /ALL PASS/);
});
