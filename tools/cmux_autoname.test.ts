// CI wrapper for the cmux-autoname SessionStart hook regression test.
//
// The real assertions live in config/cmux-autoname.test.sh, which drives
// config/cmux-autoname.sh against a fake `cmux` and a fixture repo: tab and
// workspace naming, Codex/Claude env precedence, idempotency, and the
// compact/clear re-fire leaving a role-retitled tab alone (STARK-7509). Unlike
// the three statusline harnesses it had no wrapper, so `npm test` and CI never
// ran it and a regression in the hook shipped green. Stdin is closed
// explicitly: the harness's first invocations inherit it, and the hook reads a
// non-tty stdin for the SessionStart payload.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

test("cmux-autoname hook: naming, precedence, idempotency, compact/clear keep the title", () => {
  const script = path.join(import.meta.dirname, "..", "config", "cmux-autoname.test.sh");
  const r = spawnSync("bash", [script], { encoding: "utf8", input: "", timeout: 60_000 });
  assert.equal(
    r.status,
    0,
    `cmux-autoname.test.sh failed (exit ${r.status}, signal ${r.signal}):\n${r.stdout}\n${r.stderr}`,
  );
  assert.match(r.stdout, /^PASS cmux autoname:/m);
});
