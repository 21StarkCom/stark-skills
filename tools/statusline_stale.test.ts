// CI wrapper for the statusline usage_windows_stale() gate regression test.
//
// The real assertions live in config/statusline-stale.test.sh, which extracts
// usage_windows_stale() straight out of config/statusline-command.sh and asserts
// its truth table (STARK-2652). The gate decides whether this process's payload
// 5H/7D windows belong to a rotated-away seat — if so the render shows "—" instead
// of a confident wrong number. This just runs that harness under `npm test` and
// fails the suite if the decision drifts, so a future edit is caught in CI, not on
// Aryeh's status line.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("statusline usage_windows_stale gate keeps its truth table", () => {
  const script = path.join(import.meta.dirname, "..", "config", "statusline-stale.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    `statusline-stale.test.sh failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /ALL PASS/);
});
