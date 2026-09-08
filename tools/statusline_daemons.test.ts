// CI wrapper for the statusline daemon-health segment regression test.
//
// The real assertions live in config/statusline-daemons.test.sh, which drives the
// whole config/statusline-command.sh under a controlled $HOME and asserts the line-3
// G/Y/R circles for the fork-free daemon resolvers (idun's state-file lastPoll and
// alfred's alfredd.lock pid + kill -0). frigg-cache-sync reads system launchd state
// and is not asserted. This runs that harness under `npm test` so a mapping
// regression is caught in CI, not on Aryeh's status line.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("statusline daemon-health segment keeps its G/Y/R mapping", () => {
  const script = path.join(import.meta.dirname, "..", "config", "statusline-daemons.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(
    r.status,
    0,
    `statusline-daemons.test.sh failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /ALL PASS/);
});
