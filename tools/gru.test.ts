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
import { BASE_CHECKS, GruStore } from "./gru_lib.ts";

const CLI = path.join(import.meta.dirname, "gru.ts");

test("rebrief-check is a worker command and succeeds without creating or opening Gru state", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-rebrief-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  const message = "12345678-1234-1234-1234-123456789012";
  const body = "Assignment: demo/task; token: new-token\nLeader session: leader. Provider: codex.";
  const record = { id: message, kind: "note", state: "submitted", createdAt: new Date().toISOString(),
    sender: { sessionId: "leader" }, destination: { threadId: "worker" }, body };
  fs.writeFileSync(path.join(bin, "hermod"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(record))});\n`, { mode: 0o755 });
  // A file where the state's parent directory would be makes any DB initialization fail.
  fs.writeFileSync(path.join(dir, ".stark"), "no database access");
  const env = { HOME: dir, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CODEX_THREAD_ID: "worker" };
  const args = ["rebrief-check", "--message", message, "--run", "demo", "--task", "task", "--current-leader", "leader"];
  const result = await run(args, undefined, env);
  assert.equal(result.code, 0, result.error);
  assert.equal(JSON.parse(result.out).body, body);
  assert.equal(fs.readFileSync(path.join(dir, ".stark"), "utf8"), "no database access");
  const reread = await run([...args, "--current-message", message], undefined, env);
  assert.equal(reread.code, 0, reread.error);
  const wrong = await run([...args, "--state", path.join(dir, "state.sqlite")], undefined, env);
  assert.equal(wrong.code, 2);
  assert.match(wrong.error, /does not apply to rebrief-check/);
  const absent = await run(args, undefined, { HOME: dir });
  assert.equal(absent.code, 2);
  assert.match(absent.error, /worker runtime session identity unavailable/);
});

test("both skill runtimes route re-brief decisions to the command and avoid reply expiry", () => {
  const root = path.dirname(import.meta.dirname);
  for (const prefix of ["", "runtime-overrides/codex/"]) {
    for (const skill of ["minion", "gru"]) {
      const text = fs.readFileSync(path.join(root, prefix, "skill", skill, "SKILL.md"), "utf8");
      assert.match(text, /rebrief-check/);
      assert.match(text, /--kind progress/);
      assert.doesNotMatch(text, /ignore `expired`|must show all of:/);
      if (skill === "gru") {
        assert.match(text, /--kind note/);
        const resume = text.slice(text.indexOf("Resume from the saved run"));
        assert.match(resume, /Escalate rather than resend/);
      }
    }
  }
  const codex = fs.readFileSync(path.join(root, "runtime-overrides/codex/skill/gru/SKILL.md"), "utf8");
  assert.match(codex, /CODEX_THREAD_ID/);
  assert.match(codex, /fail outright/);
  assert.doesNotMatch(codex, /Claude sender only from its cmux surface/);
});

test("gru receive CLI imports a fresh progress-kind intake ack after the rebrief deadline", async t => {
  const { dir, state, file } = engagement(t);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = new GruStore(state); t.after(() => store.close());
  let current = store.create(config);
  current = store.reconcile("cli", "leader-one", current.revision, {});
  current = store.reserve("cli", "leader-one", current.revision, "t");
  current = store.attach("cli", "leader-one", current.revision, "t", current.tasks[0].token!, {
    id: "codex:worker", session: "worker", surface: "surface", workspace: "workspace", provider: "codex",
    worktree: current.tasks[0].spec.worktree,
  });
  const rebriefCreated = Date.now() - 31 * 60_000;
  const message = "abcdef12-1234-1234-1234-123456789012";
  const ack = { id: message, kind: "progress", state: "submitted", delivery: "confirmed",
    from: "codex:worker", sender: { threadId: "worker" }, destination: { sessionId: "leader-one" },
    createdAt: new Date().toISOString(), deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    body: JSON.stringify({ run: "cli", task: "t", token: current.tasks[0].token, kind: "ack", message: current.tasks[0].spec.doneWhen }) };
  assert.ok(Date.parse(ack.createdAt) > rebriefCreated + 30 * 60_000);
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermod"), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(ack))});\n`, { mode: 0o755 });
  const result = await run(["receive", "--run", "cli", "--revision", String(current.revision), "--message", message, "--state", state],
    "leader-one", { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.code, 0, result.error);
  const received = store.read("cli");
  assert.equal(received.tasks[0].phase, "working");
  assert.equal(received.tasks[0].report?.kind, "ack");
  assert.deepEqual(received.received, [message]);
});

/** Run the CLI as its own process.
 *
 * Calling `main()` in-process and swapping `process.stdout.write` to capture its JSON
 * ALSO captures node:test's reporter, which flushes asynchronously — two tests silently
 * vanished from the run that way, reported as neither pass nor fail. A subprocess keeps
 * the harness's stdout untouched, exercises the real entrypoint including its exit code,
 * and needs no global env mutation. Every ambient session identity is cleared: `CODEX_THREAD_ID`
 * outranks `CLAUDE_CODE_SESSION_ID`, so a stray one would pick the identity for every case here.
 * An undefined `leader` runs the CLI the way a plain operator shell would, with no session. */
async function run(argv: string[], leader: string | undefined, extraEnv: Record<string, string> = {}, cwd?: string): Promise<{ code: number; out: string; error: string }> {
  const { CODEX_THREAD_ID: _codex, CLAUDE_CODE_SESSION_ID: _claude, CLAUDE_SESSION_ID: _legacy, ...env } = process.env;
  const child = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8", cwd, env: { ...env, ...extraEnv, ...(leader === undefined ? {} : { CLAUDE_CODE_SESSION_ID: leader }) },
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

test("gru CLI: sweep dry-runs by default, applies from a leaderless shell, and releases nothing when Alfred fails", async t => {
  const { dir, state, file } = engagement(t);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const store = new GruStore(state); t.after(() => store.close());
  // The incident shape: reserved, never attached, then stopped.
  let current = store.create(config);
  current = store.reconcile("cli", "leader-one", current.revision, {});
  current = store.reserve("cli", "leader-one", current.revision, "t");
  current = store.reconcile("cli", "leader-one", current.revision, { t: { observedAt: new Date().toISOString(),
    liveness: "unknown", activity: "unknown", evidence: [] } });
  current = store.stop("cli", "leader-one", current.revision);
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermod"), `#!/usr/bin/env node
console.log(JSON.stringify(process.argv[2] === "sessions" ? {sessions: [], totalMatches: 0} : {peers: [], observedAt: new Date().toISOString(), incomplete: false}));
`, { mode: 0o755 });
  // Like the real Alfred, work verbs refuse outside a git checkout: the recorded repo here.
  const alfred = (ticketState: string | null) => fs.writeFileSync(path.join(bin, "alfred"), `#!/usr/bin/env node
if (process.cwd() !== ${JSON.stringify(fs.realpathSync(config.tasks[0].repo))}) { console.error("alfred: not a git repo — work verbs refuse"); process.exit(2); }
${ticketState === null ? 'console.error("ClickUp unreachable"); process.exit(1);'
    : `console.log(JSON.stringify({item: {ref: {custom_id: process.argv[4]}, state: ${JSON.stringify(ticketState)}}, comments: [], comments_read: true}));`}
`, { mode: 0o755 });
  // Invoked from a directory that is not a repository, as a machine-wide clean would be.
  const sweep = (...extra: string[]) => run(["sweep", "--state", state, ...extra], undefined, { PATH: `${bin}${path.delimiter}${process.env.PATH}` }, dir);
  const held = ["ticket:STARK-1", `tree:${config.tasks[0].worktree}`];
  // A writable open would chmod the store to 0600; a preview must leave it exactly as found.
  fs.chmodSync(state, 0o640);

  alfred("in progress");
  const open = await sweep();
  assert.equal(open.code, 0, open.error);
  assert.equal(JSON.parse(open.out).runs[0].tasks[0].action, "held");
  assert.match(JSON.parse(open.out).runs[0].tasks[0].reason, /STARK-1 is in progress/);

  alfred("Closed");
  const dry = await sweep();
  assert.equal(dry.code, 0, dry.error);
  const planned = JSON.parse(dry.out);
  assert.equal(planned.apply, false);
  assert.deepEqual(planned.runs[0].tasks.map((v: { action: string; resources: string[] }) => [v.action, v.resources]), [["release", held]]);
  // The verdict reports released owner rows only; declared files stopped being ownership in STARK-5049.
  assert.equal("files" in planned.runs[0].tasks[0], false);
  assert.equal(store.read("cli").revision, current.revision, "a dry run mutates nothing");
  assert.equal(fs.statSync(state).mode & 0o777, 0o640, "a dry run opens the store read-only");
  // No store yet means nothing to release, and neither mode creates one.
  const absent = path.join(dir, "absent", "state.sqlite");
  for (const mode of [[], ["--apply"]]) {
    const empty = await run(["sweep", "--state", absent, ...mode], undefined, {}, dir);
    assert.equal(empty.code, 0, empty.error);
    assert.deepEqual(JSON.parse(empty.out).runs, []);
  }
  const named = await run(["sweep", "--state", absent, "--run", "cli"], undefined, {}, dir);
  assert.equal(named.code, 2);
  assert.match(named.error, /unknown engagement cli/);
  assert.equal(fs.existsSync(path.dirname(absent)), false);

  alfred(null);
  const down = await sweep("--apply");
  assert.equal(down.code, 2);
  assert.match(down.error, /alfred failed \(1\): ClickUp unreachable/);
  assert.equal(store.read("cli").revision, current.revision);
  assert.deepEqual(store.owned("cli", "t"), held);

  alfred("Closed");
  const applied = await sweep("--apply", "--run", "cli");
  assert.equal(applied.code, 0, applied.error);
  const result = JSON.parse(applied.out).runs[0];
  assert.deepEqual([result.applied, result.modeAfter, result.revisionAfter], [true, "swept", current.revision + 1]);
  const after = store.read("cli");
  assert.equal(after.tasks[0].phase, "swept");
  assert.equal(after.tasks[0].swept!.invokedBy, null);
  assert.deepEqual(after.tasks[0].swept!.released, held);
  assert.deepEqual(store.owned("cli", "t"), []);
  const status = await run(["status", "--run", "cli", "--state", state], "leader-one");
  assert.equal(status.code, 0, status.error);
  assert.deepEqual(JSON.parse(status.out).waiting, [], "a swept task is terminal, not outstanding work");
  // Nothing left to release: the store-wide sweep lists no run, a named one lists no task.
  assert.deepEqual(JSON.parse((await sweep("--apply")).out).runs, []);
  assert.deepEqual(JSON.parse((await sweep("--run", "cli")).out).runs[0].tasks, []);
  assert.equal(store.read("cli").revision, after.revision);
  // A `--run` sweep of an engagement whose only repository Alfred cannot read from still
  // reads its ticket through another repository the store records.
  const foreign = path.join(dir, "foreign-repo"); fs.mkdirSync(path.join(foreign, "wt"), { recursive: true });
  let other = store.create({ ...config, id: "foreign", tasks: [{ ...config.tasks[0], ticket: "STARK-2", repo: foreign,
    worktree: path.join(foreign, "wt"), files: ["b.ts"] }] });
  other = store.reconcile("foreign", "leader-one", other.revision, {});
  other = store.reserve("foreign", "leader-one", other.revision, "t");
  store.stop("foreign", "leader-one", other.revision);
  const borrowed = await sweep("--run", "foreign");
  assert.equal(borrowed.code, 0, borrowed.error);
  assert.deepEqual(JSON.parse(borrowed.out).runs[0].tasks.map((v: { action: string }) => v.action), ["release"]);
});

test("gru CLI: sweep flags are refused where they would be silently ignored", async t => {
  const { state } = engagement(t);
  const wrongVerb = await run(["status", "--run", "cli", "--state", state, "--apply"], "leader-one");
  assert.equal(wrongVerb.code, 2);
  assert.match(wrongVerb.error, /--apply applies to sweep, not status/);
  for (const flag of ["--task", "--revision"]) {
    const narrowed = await run(["sweep", "--state", state, flag, "t"], undefined);
    assert.equal(narrowed.code, 2);
    assert.match(narrowed.error, new RegExp(`${flag} does not apply to sweep`));
  }
  const unidentified = await run(["status", "--run", "cli", "--state", state], undefined);
  assert.equal(unidentified.code, 2);
  assert.match(unidentified.error, /current session identity unavailable/, "only sweep runs without a session");
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
function hermodPeerAt(dir: string, cwd: string, sessionId = "7b0c1c9e-0000-4000-8000-000000000001"): Record<string, string> {
  const bin = path.join(dir, "bin"); fs.mkdirSync(bin, { recursive: true });
  const peer = { id: "claude:minion", agent: "claude", sessionId, surfaceId: "surface-minion",
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
  assert.equal(audit.toplevel, observed);
  assert.notEqual(audit.gitDir, audit.commonDir);
  // The launch brief carried the reserved token; adoption replaces it so only a fresh packet reports.
  assert.notEqual(adopted.tasks[0].token, current.tasks[0].token);
  assert.equal(audit.token, adopted.tasks[0].token);
  assert.match(result.error, /adopted .*token changed; send the worker a fresh packet/);
  assert.equal(store.read("cli").revision, current.revision + 1);
});

test("gru CLI: attach names a refused launch state before inspecting a mismatched worktree", async t => {
  const { store, current, attach, declared } = await strandedLaunch(t, "git@github.com:o/r.git");
  // Bind a worker at the declared path first, so the task is no longer a launch awaiting attach.
  fs.mkdirSync(declared);
  const dir = path.dirname(path.dirname(declared));
  const bound = await run(attach, "leader-one", hermodPeerAt(path.dirname(dir), declared));
  assert.equal(bound.code, 0, bound.error);
  const after = store.read("cli");
  const again = attach.map(a => a === String(current.revision) ? String(after.revision) : a);
  const late = await run(again, "leader-one", hermodPeerAt(path.dirname(dir), path.join(dir, "missing", "STARK-5030")));
  assert.equal(late.code, 2);
  assert.match(late.error, /no pending launch to attach/);
  assert.equal(store.read("cli").revision, after.revision);
});

test("gru CLI: attach names identity refusals before inspecting a mismatched worktree", async t => {
  const { store, current, attach, declared } = await strandedLaunch(t, "git@github.com:o/r.git");
  const dir = path.dirname(path.dirname(path.dirname(declared)));
  // The leader's own peer, in a checkout that would also fail adoption.
  const self = await run(attach, "leader-one", hermodPeerAt(dir, path.join(dir, "nowhere"), "leader-one"));
  assert.equal(self.code, 2);
  assert.match(self.error, /leader cannot attach as its own worker/);
  assert.equal(store.read("cli").revision, current.revision);
});

test("gru CLI: adopting a late launch during stop points at interruption, not a fresh packet", async t => {
  const { store, current, attach, env } = await strandedLaunch(t, "git@github.com:o/r.git");
  const stopped = store.stop("cli", "leader-one", current.revision);
  const late = await run(attach.map(a => a === String(current.revision) ? String(stopped.revision) : a), "leader-one", env);
  assert.equal(late.code, 0, late.error);
  const bound = JSON.parse(late.out).tasks[0];
  assert.equal(bound.phase, "stopping");
  assert.equal(bound.stoppedFrom, "intake");
  assert.match(late.error, /token changed; interrupt the worker/);
  assert.doesNotMatch(late.error, /fresh packet/);
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

test("gru CLI: --base and --base-ref are refused on every verb except integrate", async t => {
  const { state, file } = engagement(t);
  assert.equal((await run(["init", "--file", file, "--state", state], "leader-one")).code, 0);
  // Same trap as --limits-file: parseArgs registers one option set for all verbs, so a
  // --base-ref the verb never reads exits 0 having done nothing. On `verify` that reads as a
  // grant checked against the named branch while the recorded one came from origin's default.
  for (const flag of ["--base", "--base-ref"]) {
    for (const verb of ["status", "reconcile", "reserve", "verify", "stop"]) {
      const value = flag === "--base" ? "a".repeat(40) : "release";
      const r = await run([verb, "--run", "cli", "--state", state, "--revision", "0", "--task", "t",
        "--token", "t", "--pr", "1", "--review", "1", flag, value], "leader-one");
      assert.equal(r.code, 2, `${verb} accepted ${flag}`);
      assert.match(r.error, new RegExp(`\\${flag} applies to integrate, not ${verb}`));
    }
  }
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
  // Checked before any grant branch: a swept task has no repair, only an explanation.
  assert.match(at("swept"), /released by a proof-based sweep; it cannot be verified/);

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

  // Every hint that names a base names the ONE achievable one. "under the merge lock" was not:
  // `integrate` takes `merge:<repo>` in the same transaction that records the base and refuses a
  // second call from `integrating`, so no leader can observe a tip while already holding the lock.
  for (const hint of [ungranted, review, at("stopped")]) {
    assert.match(hint, /at the base branch tip fetched immediately before the grant/);
    assert.doesNotMatch(hint, /merge lock|previous merge/);
  }

  // No `stopping` case: `verify` refuses unless run.mode === "running", and a `stopping`
  // task forces run.mode to `stopping`. gru_lib.test.ts pins that invariant; here we only
  // assert the branch is gone rather than re-asserting a message nothing can read.
  assert.doesNotMatch(at("stopping"), /observe termination/);
});

test("gru CLI: integrate fetches the base branch and refuses anything but its current tip", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-cli-base-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, "state.sqlite");
  const repo = fs.mkdtempSync(path.join(dir, "checkout-"));
  // A RELATIVE origin URL makes this a real remote git can fetch from while still
  // normalizing to the `owner/repo` identity Gru requires: `git remote get-url` reports
  // it verbatim, and git resolves it against the checkout it runs in.
  const origin = path.join(repo, "o", "r.git");
  git(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "remote", "add", "origin", "o/r.git");
  const land = (message: string, cwd = repo) => {
    git(cwd, "commit", "-q", "--allow-empty", "-m", message);
    git(cwd, "push", "-q", "origin", "HEAD:main");
    return git(cwd, "rev-parse", "HEAD").trim();
  };
  // No `git remote set-head`: the default branch is read from origin, so this checkout has
  // no local refs/remotes/origin/HEAD at all and the CLI still resolves `main`.
  const first = land("first task merged");
  for (const name of ["wt-one", "wt-two"]) fs.mkdirSync(path.join(dir, name));
  const file = path.join(dir, "engagement.json");
  fs.writeFileSync(file, JSON.stringify({
    id: "cli", objective: "o", leader: "leader-one", maxWorkers: 2, maxAttempts: 1, maxRecoveries: 0,
    limits: ["OPERATOR LIMIT: no publishing"],
    tasks: ["one", "two"].map((id, i) => ({ id, ticket: `STARK-${1 + i}`, objective: "o", repo,
      worktree: path.join(dir, i === 0 ? "wt-one" : "wt-two"), provider: "codex", dependsOn: [],
      files: [`${id}.ts`], exclusiveResources: [], mergeResources: [], doneWhen: "d", checks: [["true"]] })),
  }));
  const initialized = await run(["init", "--file", file, "--state", state], "leader-one");
  assert.equal(initialized.code, 0, initialized.error);
  assert.equal(JSON.parse(initialized.out).config.tasks[0].repositoryKey, "o/r");

  const store = new GruStore(state); t.after(() => store.close());
  /** Drive `id` to phase `review` the way reconcile/attach/receive would, without Hermod. */
  const ready = (id: string, index: number) => {
    let current = store.read("cli");
    // reconcile requires an observation for every bound worker, including a verified one.
    current = store.reconcile("cli", "leader-one", current.revision, Object.fromEntries(current.tasks
      .filter(task => task.worker).map(task => [task.spec.id, { observedAt: new Date().toISOString(),
        liveness: "live" as const, activity: "idle" as const, evidence: ["Hermod observation"] }])));
    current = store.reserve("cli", "leader-one", current.revision, id);
    const worker = { id: `codex:${id}`, session: `session-${id}`, surface: `surface-${id}`,
      workspace: "workspace", provider: "codex" as const, worktree: current.tasks[index].spec.worktree };
    current = store.attach("cli", "leader-one", current.revision, id, current.tasks[index].token!, worker);
    for (const kind of ["ack", "ready"] as const) {
      current = store.report("cli", "leader-one", current.revision, id, current.tasks[index].token!,
        worker.session, kind, "d");
    }
    return current;
  };
  ready("one", 0);
  const integrate = (id: string, index: number, base: string, ...extra: string[]) =>
    run(["integrate", "--run", "cli", "--revision", String(store.read("cli").revision), "--task", id,
      "--token", store.read("cli").tasks[index].token!, "--base", base, "--state", state, ...extra], "leader-one");

  // A SHA of the right shape that this repository does not hold — the shape check alone passed it.
  const foreign = await integrate("one", 0, "f".repeat(40));
  assert.equal(foreign.code, 2);
  assert.match(foreign.error, /integration base f{40} is not a commit in o\/r/);
  // Another task's merge lands on origin while this one is in review: the leader's base is stale.
  const second = fs.mkdtempSync(path.join(dir, "other-worker-"));
  git(dir, "clone", "-q", origin, second);
  const landed = land("second task merged", second);
  const stale = await integrate("one", 0, first);
  assert.equal(stale.code, 2);
  assert.match(stale.error, new RegExp(`integration base ${first} is not the current main tip ${landed}`));
  // The branch must exist on origin; an unfetchable one refuses instead of reading a local ref.
  const missing = await integrate("one", 0, landed, "--base-ref", "no-such-branch");
  assert.equal(missing.code, 2);
  assert.match(missing.error, /cannot fetch refs\/heads\/no-such-branch from origin/);

  const granted = await integrate("one", 0, landed);
  assert.equal(granted.code, 0, granted.error);
  const evidence = JSON.parse(granted.out).tasks[0].baseEvidence;
  // Every field but the timestamp is asserted against a literal. `checks: evidence.checks`
  // would compare the field with itself and accept anything the CLI happened to record.
  assert.deepEqual({ ...evidence, observedAt: undefined },
    { observedAt: undefined, repositoryKey: "o/r", ref: "main", tip: landed, base: landed, contains: [], checks: [...BASE_CHECKS] });
  assert.ok(Date.now() - Date.parse(evidence.observedAt) < 60_000);

  // Phase is checked before the fetch. With origin unreachable, a task already integrating
  // refuses for its phase — proof the CLI never spent a network round trip, and never wrote
  // objects into the leader's checkout, for a grant the store was always going to refuse.
  const moved = path.join(dir, "origin-moved.git");
  fs.renameSync(origin, moved);
  const reentrant = await integrate("one", 0, landed);
  fs.renameSync(moved, origin);
  assert.equal(reentrant.code, 2);
  assert.match(reentrant.error, /task is not ready for integration/);

  // Verify task one, then land a descendant: task two's grant must be checked against the
  // merge this engagement verified, which only reaches the observation through the CLI.
  const current = store.read("cli");
  store.complete("cli", "leader-one", current.revision, "one", current.tasks[0].token!,
    { head: landed, base: landed, merge: landed, pr: "https://github.com/o/r/pull/1",
      review: "https://github.com/o/r/pull/1#pullrequestreview-1", verifiedAt: new Date().toISOString(),
      ticketState: "done", checks: [{ argv: ["true"], exitCode: 0, log: "/evidence/check.log" }] });
  const third = land("later publisher push", second);
  ready("two", 1);
  const dependent = await integrate("two", 1, third);
  assert.equal(dependent.code, 0, dependent.error);
  assert.deepEqual(JSON.parse(dependent.out).tasks[1].baseEvidence.contains, [landed]);

  // Nothing above left an invocation-owned ref in the leader's checkout.
  assert.equal(git(repo, "for-each-ref", "--format=%(refname)", "refs/gru").trim(), "");
});
