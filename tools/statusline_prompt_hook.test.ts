// CI wrapper for the statusline UserPromptSubmit hook idle-gap guard (STARK-662).
//
// The real assertions live in config/statusline-prompt-hook.test.sh, which runs
// config/statusline-prompt-hook.sh in an isolated HOME and checks that a prompt
// re-stamps prompt_ts only when the last Stop was >= IDLE_GAP seconds ago — so a
// machine re-prompt (/loop, cron) firing right after turn-end can't reset the
// 👤 "since enter" clock. This runs that harness under `npm test`.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("statusline prompt hook holds the clock on machine re-prompts (idle-gap guard)", () => {
  const script = path.join(import.meta.dirname, "..", "config", "statusline-prompt-hook.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8" });
  // The harness self-skips (exit 0, "SKIP: jq not installed") when jq is absent.
  assert.equal(
    r.status,
    0,
    `statusline-prompt-hook.test.sh failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /ALL PASS|SKIP:/);
});
