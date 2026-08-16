// CI wrapper for the statusline pure-bash payload parser regression test.
//
// The real assertions live in config/statusline-parse.test.sh, which extracts
// parse_payload() straight out of config/statusline-command.sh and diffs its
// output against the jq filter that parser replaced (STARK-660). This just runs
// that harness under `npm test` and fails the suite if any payload diverges —
// so a future edit to parse_payload that breaks jq-parity is caught in CI, not
// on Aryeh's status line.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("statusline parse_payload stays byte-identical to the old jq", () => {
  const script = path.join(import.meta.dirname, "..", "config", "statusline-parse.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  // The harness self-skips (exit 0, "SKIP: jq not installed") when jq is absent.
  assert.equal(
    r.status,
    0,
    `statusline-parse.test.sh failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /ALL PASS|SKIP:/);
});
