// Tests for `tools/copilot_land.ts` — the CLI layer. `copilot_land_lib.test.ts` covers the
// pure decisions; nothing covered the argument surface, and that is where two defects lived:
// `--body` was documented required and never validated (so an unset shell variable opened a
// REAL PR with an empty description), and `--lead` defaulted to "claude" in the `--dry-run`
// plan even when unset, contradicting the header that calls the flag inert.
//
// Every case here is `--dry-run` or a pre-flight refusal, so no case reaches git or gh.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const CLI = path.join(import.meta.dirname, "copilot_land.ts");

function run(argv: string[]): { code: number; out: string; error: string } {
  const child = spawnSync(process.execPath, [CLI, ...argv], { encoding: "utf8" });
  return { code: child.status ?? -1, out: child.stdout, error: child.stderr };
}

const LAND = ["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--body", "B"];

test("copilot_land land: --body is required, like every other documented-required flag", () => {
  // Without this the run reached `gh pr create --body ""` and opened a real PR with an
  // empty description — a side effect no re-run undoes, since `land` then ADOPTS that PR
  // by head ref rather than opening a correct one.
  const missing = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--dry-run", "--json"]);
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.out), { ok: false, error: "--body is required" });

  // Present-but-empty is refused too: `--body "$UNSET"` is the shape that produced the bug.
  const empty = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--body", "", "--dry-run", "--json"]);
  assert.equal(empty.code, 2);
  assert.deepEqual(JSON.parse(empty.out), { ok: false, error: "--body is required" });

  // Non-JSON mode reports the same refusal on stderr and still exits non-zero.
  const plain = run(["land", "--repo", "o/r", "--branch", "copilot/x", "--title", "T", "--dry-run"]);
  assert.equal(plain.code, 2);
  assert.match(plain.error, /--body is required/);

  // And the refusal is ordered after the flags that were already validated, so supplying
  // every flag reaches the plan.
  const ok = run([...LAND, "--dry-run"]);
  assert.equal(ok.code, 0, ok.error);
});

test("copilot_land land: --dry-run echoes lead only when the caller supplied it", () => {
  const unset = JSON.parse(run([...LAND, "--dry-run"]).out);
  // The header calls --lead inert and selecting-nothing. A defaulted "claude" in the plan
  // reads as a selected agent, which is the one thing the flag promises it never does.
  assert.equal("lead" in unset, false, `unset --lead leaked into the plan: ${JSON.stringify(unset)}`);
  assert.equal(unset.dry_run, true);
  assert.equal(unset.base, "main");

  const supplied = JSON.parse(run([...LAND, "--lead", "codex", "--dry-run"]).out);
  assert.equal(supplied.lead, "codex");

  // `--lead "$UNSET_VAR"` is present-but-blank. A `present()` check treats that as
  // supplied and echoes `"lead": ""`, which reads as a selected-but-nameless agent —
  // the same wrong signal the old "claude" default gave, just harder to spot.
  const blank = JSON.parse(run([...LAND, "--lead", "", "--dry-run"]).out);
  assert.equal("lead" in blank, false, `blank --lead leaked into the plan: ${JSON.stringify(blank)}`);
});

test("copilot_land: the header and help name a live command, never the buried copilot skill", () => {
  // The retired-names rule in ~/Code/CLAUDE.md: a buried command must never be presented as
  // live. This text vendors into every bifrost bundle on both runtimes, so a stale name here
  // teaches the dead command to every installed plugin.
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.out, /\/stark-copilot/);
  assert.match(help.out, /\/stark-build/);
});
