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
import { GruStore } from "./gru_lib.ts";

const CLI = path.join(import.meta.dirname, "gru.ts");

/** Run the CLI as its own process.
 *
 * Calling `main()` in-process and swapping `process.stdout.write` to capture its JSON
 * ALSO captures node:test's reporter, which flushes asynchronously — two tests silently
 * vanished from the run that way, reported as neither pass nor fail. A subprocess keeps
 * the harness's stdout untouched, exercises the real entrypoint including its exit code,
 * and needs no global env mutation. `CODEX_THREAD_ID` is cleared because it outranks
 * `CLAUDE_CODE_SESSION_ID`; a stray one would pick the identity for every case here. */
async function run(argv: string[], leader: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; out: string; error: string }> {
  const { CODEX_THREAD_ID: _drop, ...env } = process.env;
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8", env: { ...env, ...extraEnv, CLAUDE_CODE_SESSION_ID: leader },
  });
  return { code: child.status ?? -1, out: child.stdout, error: child.stderr };
}

test("gru CLI: takeover consumes a pinned operator request and real observation command outputs", async t => {
  const { dir, state, file } = engagement(t);
  const config = JSON.parse(fs.readFileSync(file, "utf8")); config.maxAttempts = 2;
  const store = new GruStore(state); t.after(() => store.close());
  // Observe an exited local process instead of assuming an arbitrary PID is absent.
  const vanished = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
  assert.equal(vanished.status, 0);
  let current = store.create(config);
  current = store.reconcile("cli", "leader-one", current.revision, {});
  current = store.reserve("cli", "leader-one", current.revision, "t");
  current = store.attach("cli", "leader-one", current.revision, "t", current.tasks[0].token!, {
    id: "codex:old", session: "old", surface: "gone", workspace: "workspace", provider: "codex",
    worktree: current.tasks[0].spec.worktree, pid: Number(vanished.stdout.trim()),
  });
  current = store.reconcile("cli", "leader-one", current.revision, { t: {
    observedAt: new Date().toISOString(), liveness: "unknown", activity: "unknown", evidence: [],
  } });
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermod"), `#!/usr/bin/env node
const verb = process.argv[2];
console.log(JSON.stringify(verb === "msg" ? {peers: [], observedAt: new Date().toISOString(), incomplete: false} : verb === "sessions" ? {sessions: [], totalMatches: 0} : []));
`, { mode: 0o755 });
  const authorization = path.join(dir, "operator.json");
  const request = { run: "cli", task: "t", token: current.tasks[0].token, revision: current.revision,
    operatorRequest: "Use a fresh Claude Minion for this orphaned assignment", provider: "claude",
    worktree: path.join(dir, "fresh"), limits: ["Fresh Claude Minion; preserve scope and budget"] };
  fs.writeFileSync(authorization, JSON.stringify(request));
  const args = ["takeover", "--run", "cli", "--revision", String(current.revision), "--task", "t",
    "--token", current.tasks[0].token!, "--state", state, "--file", authorization];
  fs.writeFileSync(authorization, JSON.stringify({ ...request, worktree: path.join(dir, "missing-parent", "fresh") }));
  const missingParent = await run(args, "leader-one");
  assert.equal(missingParent.code, 2);
  assert.match(missingParent.error, /worktree parent must exist and be readable/);
  assert.equal(store.read("cli").revision, current.revision);
  fs.writeFileSync(authorization, JSON.stringify(request));
  const result = await run(args, "leader-one", { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.code, 0, result.error);
  const adopted = JSON.parse(result.out);
  assert.equal(adopted.tasks[0].phase, "pending");
  assert.equal(adopted.tasks[0].spec.provider, "claude");
  assert.equal(adopted.tasks[0].attempts, 1);
  assert.equal(adopted.tasks[0].takeovers[0].previousObservation.liveness, "unknown");
  assert.equal(adopted.tasks[0].takeovers[0].request.operatorRequest, request.operatorRequest);
  assert.equal(fs.existsSync(request.worktree), false);
  const replay = await run(args, "leader-one", { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(replay.code, 2);
  assert.match(replay.error, /stale revision/);
  assert.equal(store.read("cli").revision, adopted.revision);
});

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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=gru", "-c", "user.email=gru@example.invalid",
  "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
/** A GitHub-origin repository with one commit, so `git worktree add` has a HEAD to cut from. */
function originRepo(dir: string, origin: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q"); git(dir, "remote", "add", "origin", origin); git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return fs.realpathSync(dir);
}
/** A fake `hermod` on PATH whose only Claude peer is live in `cwd`. */
function hermodPeerAt(dir: string, cwd: string): Record<string, string> {
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin, { recursive: true });
  const peer = { id: "claude:minion", agent: "claude", sessionId: "7b0c1c9e-0000-4000-8000-000000000001", surfaceId: "surface-minion",
    workspaceId: "workspace", cwd, liveness: "live", activity: "busy", evidence: ["live-process"], messaging: { available: true } };
  fs.writeFileSync(path.join(bin, "hermod"), `#!/usr/bin/env node
console.log(JSON.stringify({ peers: [${JSON.stringify(peer)}], observedAt: new Date().toISOString(), incomplete: false }));
`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
/** The 2026-09-17 incident: the leader declared `.worktrees/<ticket>`; Hermod placed Claude in `.claude/worktrees/<ticket>`. */
async function strandedLaunch(t: TestContext, peerRepoOrigin: string) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gru-adopt-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state.sqlite");
  const repo = originRepo(path.join(dir, "repo"), "git@github.com:o/r.git");
  fs.mkdirSync(path.join(repo, ".worktrees"));
  const declared = path.join(repo, ".worktrees", "STARK-5030");
  // Same ticket name either way: only the repository differs between the two cases.
  const peerRepo = peerRepoOrigin === "git@github.com:o/r.git" ? repo : originRepo(path.join(dir, "elsewhere"), peerRepoOrigin);
  const observed = path.join(peerRepo, ".claude", "worktrees", "STARK-5030");
  git(peerRepo, "worktree", "add", "-q", "-b", "worktree-STARK-5030", observed);
  const file = path.join(dir, "engagement.json");
  fs.writeFileSync(file, JSON.stringify({
    id: "cli", objective: "o", leader: "leader-one", maxWorkers: 1, maxAttempts: 1, maxRecoveries: 0,
    limits: ["OPERATOR LIMIT: no publishing"],
    tasks: [{ id: "t", ticket: "STARK-5030", objective: "o", repo, worktree: declared, provider: "claude",
      dependsOn: [], files: ["a.ts"], exclusiveResources: [], mergeResources: ["m"], doneWhen: "d", checks: [["true"]] }],
  }));
  const init = await run(["init", "--file", file, "--state", state], "leader-one");
  assert.equal(init.code, 0, init.error);
  const store = new GruStore(state); t.after(() => store.close());
  let current = store.reconcile("cli", "leader-one", 0, {});
  current = store.reserve("cli", "leader-one", current.revision, "t");
  const attach = ["attach", "--run", "cli", "--revision", String(current.revision), "--task", "t",
    "--token", current.tasks[0].token!, "--peer", "claude:minion", "--state", state];
  return { store, current, attach, env: hermodPeerAt(dir, observed), declared, observed };
}

test("gru CLI: attach adopts Hermod's actual worktree for the same repository and ticket", async t => {
  const { store, current, attach, env, declared, observed } = await strandedLaunch(t, "git@github.com:o/r.git");
  const result = await run(attach, "leader-one", env);
  assert.equal(result.code, 0, result.error);
  const adopted = JSON.parse(result.out);
  assert.equal(adopted.tasks[0].phase, "intake");
  assert.equal(adopted.tasks[0].worker.worktree, observed);
  // The spec follows the worker, so `packet` and later observations name the real checkout.
  assert.equal(adopted.tasks[0].spec.worktree, observed);
  assert.equal(adopted.config.tasks[0].worktree, observed);
  const event = adopted.events.find((e: { kind: string }) => e.kind === "worktree-adopted");
  const audit = JSON.parse(event.detail);
  assert.equal(audit.declared, declared);
  assert.equal(audit.observed, observed);
  assert.equal(audit.repositoryKey, "o/r");
  assert.equal(audit.branch, "worktree-STARK-5030");
  assert.match(result.error, /adopted/);
  assert.equal(store.read("cli").revision, current.revision + 1);
});

test("gru CLI: attach still refuses a peer whose worktree belongs to another repository", async t => {
  const { store, current, attach, env } = await strandedLaunch(t, "git@github.com:o/other.git");
  const result = await run(attach, "leader-one", env);
  assert.equal(result.code, 2);
  assert.match(result.error, /worker worktree mismatch/);
  assert.match(result.error, /o\/other/);
  const after = store.read("cli");
  assert.equal(after.revision, current.revision);
  assert.equal(after.tasks[0].phase, "reserved");
  assert.equal(after.tasks[0].worker, undefined);
});

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

  // The SAME correction on the path a leader actually hits. A grant only reaches `review`
  // when `reserve` hands a replacement its predecessor's unsettled one, so the switch case
  // above is the rare path; a first attempt reports ready with no grant and is answered by
  // the `!integrationBase` guard, which said "integrate after its READY report" — naming a
  // prerequisite already behind the task, the very defect the `review` case removed.
  const ungranted = verifyBlocker({ spec, phase: "review", attempts: 1, recoveries: 0 } as never);
  assert.match(ungranted, /integrate/);
  assert.doesNotMatch(ungranted, /after its READY report/);

  // No `stopping` case: `verify` refuses unless run.mode === "running", and a `stopping`
  // task forces run.mode to `stopping`. gru_lib.test.ts pins that invariant; here we only
  // assert the branch is gone rather than re-asserting a message nothing can read.
  assert.doesNotMatch(at("stopping"), /observe termination/);
});
