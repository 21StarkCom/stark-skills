// Tests for `tools/gru.ts` — the CLI layer, which had no test file at all while
// `gru_lib` and `gru_runtime_lib` did. The gap mattered: a flag registered globally in
// parseArgs is accepted by every verb, so `--limits-file` on the wrong verb exited 0
// and silently changed nothing. Only driving the real entrypoint shows that.

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { verifyBlocker } from "./gru.ts";

const CLI = path.join(import.meta.dirname, "gru.ts");

/** Run the CLI as its own process.
 *
 * Calling `main()` in-process and swapping `process.stdout.write` to capture its JSON
 * ALSO captures node:test's reporter, which flushes asynchronously — two tests silently
 * vanished from the run that way, reported as neither pass nor fail. A subprocess keeps
 * the harness's stdout untouched, exercises the real entrypoint including its exit code,
 * and needs no global env mutation. `CODEX_THREAD_ID` is cleared because it outranks
 * `CLAUDE_CODE_SESSION_ID`; a stray one would pick the identity for every case here. */
async function run(argv: string[], leader: string): Promise<{ code: number; out: string; error: string }> {
  const { CODEX_THREAD_ID: _drop, ...env } = process.env;
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8", env: { ...env, CLAUDE_CODE_SESSION_ID: leader },
  });
  return { code: child.status ?? -1, out: child.stdout, error: child.stderr };
}

function engagement(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state.sqlite");
  const repo = path.join(dir, "repo");
  fs.mkdirSync(path.join(repo, "wt"), { recursive: true });
  // `init` derives repository identity from origin, so the fixture needs a real repo.
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: repo });
  const file = path.join(dir, "engagement.json");
  fs.writeFileSync(file, JSON.stringify({
    id: "cli", objective: "o", leader: "leader-one", maxWorkers: 1, maxAttempts: 1, maxRecoveries: 0,
    limits: ["OPERATOR LIMIT: no publishing"],
    tasks: [{ id: "t", ticket: "STARK-1", objective: "o", repo, worktree: path.join(repo, "wt"),
      provider: "codex", dependsOn: [], files: ["a.ts"], exclusiveResources: [],
      mergeResources: ["m"], doneWhen: "d", checks: [["true"]] }],
  }));
  return { dir, state, file };
}

test("gru CLI: --limits-file is refused on every verb except resume", async t => {
  const { dir, state, file } = engagement(t);
  assert.equal((await run(["init", "--file", file, "--state", state], "leader-one")).code, 0);
  const limits = path.join(dir, "limits.json");
  fs.writeFileSync(limits, JSON.stringify(["replacement"]));
  // parseArgs registers one option set for all verbs, so these used to exit 0 having
  // done nothing — an operator would believe the stale limits were replaced.
  for (const verb of ["status", "reconcile", "reserve", "stop"]) {
    const r = await run([verb, "--run", "cli", "--state", state, "--revision", "0", "--task", "t", "--limits-file", limits], "leader-one");
    assert.equal(r.code, 2, `${verb} accepted --limits-file`);
    assert.match(r.error, new RegExp(`--limits-file applies to resume, not ${verb}`));
  }
  // And the limits are genuinely untouched by any of it.
  const after = await run(["status", "--run", "cli", "--state", state], "leader-one");
  assert.deepEqual(JSON.parse(after.out).config.limits, ["OPERATOR LIMIT: no publishing"]);
});

test("gru CLI: resume rejects a missing, malformed, or empty --limits-file path", async t => {
  const { dir, state, file } = engagement(t);
  const init = await run(["init", "--file", file, "--state", state], "leader-one");
  assert.equal(init.code, 0, init.error);
  const base = ["resume", "--run", "cli", "--state", state, "--revision", "0"];
  // An empty value reuses the shared flag() helper's message rather than a second phrasing.
  const empty = await run([...base, "--limits-file", ""], "leader-two");
  assert.equal(empty.code, 2);
  assert.match(empty.error, /--limits-file is required/);
  const missing = await run([...base, "--limits-file", path.join(dir, "nope.json")], "leader-two");
  assert.equal(missing.code, 2);
  assert.match(missing.error, /ENOENT|no such file/);
  const malformed = path.join(dir, "bad.json");
  fs.writeFileSync(malformed, "{not json");
  const broken = await run([...base, "--limits-file", malformed], "leader-two");
  assert.equal(broken.code, 2);
  assert.match(broken.error, /JSON/i);
  // The whole point of reading the file BEFORE the slow Hermod transfer check is to
  // attribute a typo to the typo. A bare JSON.parse said only "Unexpected token ... at
  // position N" — an offset into an unnamed buffer, naming neither the flag nor the path,
  // while the operator has several files and several flags in play.
  assert.match(broken.error, /--limits-file/);
  assert.ok(broken.error.includes(malformed), `error did not name the path: ${broken.error}`);
  assert.match(missing.error, /--limits-file/);
  assert.ok(missing.error.includes(path.join(dir, "nope.json")), `error did not name the path: ${missing.error}`);
  // Every refusal above left the engagement alone.
  const after = await run(["status", "--run", "cli", "--state", state], "leader-one");
  assert.deepEqual(JSON.parse(after.out).config.limits, ["OPERATOR LIMIT: no publishing"]);
  assert.equal(JSON.parse(after.out).config.leader, "leader-one");
});

test("gru CLI: a sitting leader cannot replace its own limits, an incoming one can", async t => {
  const { dir, state, file } = engagement(t);
  const init = await run(["init", "--file", file, "--state", state], "leader-one");
  assert.equal(init.code, 0, init.error);
  const limits = path.join(dir, "limits.json");
  fs.writeFileSync(limits, JSON.stringify(["NEW: leader-two is current"]));
  const base = ["resume", "--run", "cli", "--state", state, "--revision", "0", "--limits-file", limits];
  // Reproduces the defect this test exists for: checkLeadershipTransfer returns
  // immediately when the leader is unchanged, so the CLI reached the store unguarded.
  const self = await run(base, "leader-one");
  assert.equal(self.code, 2);
  assert.match(self.error, /a leader cannot rewrite the limits binding itself/);
  const still = await run(["status", "--run", "cli", "--state", state], "leader-one");
  assert.deepEqual(JSON.parse(still.out).config.limits, ["OPERATOR LIMIT: no publishing"]);
});

test("verifyBlocker names the command that actually repairs each phase", () => {
  const spec = { id: "t" } as never;
  const at = (phase: string, extra: Record<string, unknown> = {}) =>
    verifyBlocker({ spec, phase, attempts: 1, recoveries: 0, integrationBase: "a".repeat(40), ...extra } as never);
  assert.match(at("integrating", { reconnect: { pending: true } }), /reconnect outcome is uncertain/);
  assert.match(verifyBlocker({ spec, phase: "working", attempts: 1, recoveries: 0 } as never), /no integration grant/);
  assert.match(at("done"), /already verified/);
  // `integrate` only accepts phase `review`, so a stopped task must hear `continue`.
  assert.match(at("stopped"), /continue it/);
  assert.match(at("working"), /report ready and receive integration/);

  // Reaching `review` IS the READY report, so the generic default told a task to take a
  // step it had already taken and never named `integrate` — the one command that applies.
  // (A `review` task CAN hold an integrationBase: `reserve` hands a replacement the
  // predecessor's unsettled grant, and the replacement then works its way back to `review`.)
  const review = at("review");
  assert.match(review, /integrate/);
  assert.doesNotMatch(review, /must report ready/);

  // No `stopping` case: `verify` refuses unless run.mode === "running", and a `stopping`
  // task forces run.mode to `stopping`. gru_lib.test.ts pins that invariant; here we only
  // assert the branch is gone rather than re-asserting a message nothing can read.
  assert.doesNotMatch(at("stopping"), /observe termination/);
});
