import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalRepository, checkLeadershipTransfer, checkRebrief, command, DEFAULT_CHECK_TIMEOUT_MS, discoverWorker, inspectAdoption, interruptWorker, observations, observeBase, observeOrphan, observeSweep, observeWorkers, packet, PACKET_TRANSFER_WINDOW, receive, retireWorker, verifyCompletion, workerFromPeer, type Command, type HermodPeer } from "./gru_runtime_lib.ts";
import { ADOPTION_CHECKS, BASE_CHECKS, type Assignment, type Engagement, type Run } from "./gru_lib.ts";

const peer = (): HermodPeer => ({ id: "codex:session", agent: "codex", threadId: "session",
  surfaceId: "surface", workspaceId: "workspace", cwd: "/worktree", liveness: "live",
  activity: "busy", evidence: ["live-process", "root-thread"], messaging: { available: true } });
const assignment = (): Assignment => ({ spec: { id: "task", ticket: "STARK-100", objective: "Implement the requested behavior",
  repo: "/repo", worktree: "/worktree", provider: "codex", dependsOn: [], files: ["feature.txt"],
  exclusiveResources: [], mergeResources: [], doneWhen: "The behavior works", checks: [["node", "verify.cjs"]] },
  token: "token", phase: "integrating", attempts: 1, recoveries: 0, integrationBase: "a".repeat(40),
  worker: workerFromPeer(peer()) });
const run = (): Run => ({ schema: 1, config: { id: "run", objective: "Objective", leader: "leader", maxWorkers: 2,
  maxAttempts: 2, maxRecoveries: 1, limits: ["No new tickets"], tasks: [assignment().spec] },
  revision: 1, epoch: 1, mode: "running", reconciled: true, received: [], tasks: [assignment()], events: [] });
const response = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
/** Hermod sees no peers, sessions, tabs or processes, and the OS probe reports the PID absent. */
const absentHermod: Command = async argv => argv[0] === "ps" ? { code: 1, stdout: "", stderr: "" } : response(
  argv[1] === "msg" ? { peers: [], observedAt: new Date().toISOString(), incomplete: false }
    : argv[1] === "sessions" ? { sessions: [], totalMatches: 0 } : []);

test("orphan takeover requires complete cross-provider absence, not merely missing hooks", async t => {
  const task = assignment(); task.worker!.pid = 42;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-orphan-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replacement = path.join(dir, "fresh");
  const snapshot = () => ({
    peers: { peers: [] as HermodPeer[], observedAt: new Date().toISOString(), incomplete: false },
    sessions: { sessions: [] as { sessionId: string; agent: string; alive?: boolean; cwd?: string; pid?: number; surfaceId?: string }[], totalMatches: 0 },
    tabs: [] as { id: string }[], processes: [] as { pid: number; cmuxSurfaceId?: string }[],
  });
  const calls: string[][] = [];
  const callFor = (data: ReturnType<typeof snapshot>): Command => async argv => {
    calls.push(argv);
    if (argv[0] === "ps") return { code: 1, stdout: "", stderr: "" };
    return response(argv[1] === "msg" ? data.peers : argv[1] === "sessions" ? data.sessions
      : argv[1] === "tabs" ? data.tabs : data.processes);
  };
  const proof = await observeOrphan(task, replacement, callFor(snapshot()));
  assert.equal(proof.worker.session, task.worker!.session);
  assert.equal(proof.replacementWorktree, replacement);
  assert.ok(calls.some(c => c[1] === "msg" && !c.includes("--agent")));
  assert.ok(calls.some(c => c[1] === "sessions" && c.includes("--all")));
  assert.ok(calls.some(c => c[1] === "tabs" && c.includes("--all")), "surface discovery must cover every workspace");
  assert.ok(calls.some(c => c[1] === "ps"));
  assert.ok(calls.some(c => c[0] === "ps" && c.includes(String(task.worker!.pid))));
  const cases: [string, (data: ReturnType<typeof snapshot>) => void][] = [
    ["incomplete peers", d => { d.peers.incomplete = true; }],
    ["stale peers", d => { d.peers.observedAt = new Date(Date.now() - 120_000).toISOString(); }],
    ["truncated sessions", d => { d.sessions.totalMatches = 1; }],
    ["live old peer", d => { d.peers.peers = [peer()]; }],
    ["other provider owns old path", d => { d.peers.peers = [{ ...peer(), id: "claude:other", agent: "claude", surfaceId: "other", threadId: "other" }]; }],
    ["other provider owns new path", d => { d.peers.peers = [{ ...peer(), id: "claude:other", agent: "claude", cwd: replacement, surfaceId: "other", threadId: "other" }]; }],
    ["unknown matching peer", d => { d.peers.peers = [{ ...peer(), liveness: "unknown" }]; }],
    ["live saved session", d => { d.sessions = { sessions: [{ sessionId: "session", agent: "codex", alive: true }], totalMatches: 1 }; }],
    ["unknown saved session", d => { d.sessions = { sessions: [{ sessionId: "session", agent: "codex" }], totalMatches: 1 }; }],
    ["surface exists", d => { d.tabs = [{ id: "surface" }]; }],
    ["PID still exists", d => { d.processes = [{ pid: 42 }]; }],
    ["surface has another process", d => { d.processes = [{ pid: 43, cmuxSurfaceId: "surface" }]; }],
  ];
  for (const [name, change] of cases) {
    const data = snapshot(); change(data);
    await assert.rejects(observeOrphan(task, replacement, callFor(data)), name);
  }
  await assert.rejects(observeOrphan(task, replacement, async () => ({ code: 1, stdout: "", stderr: "offline" })), /failed/);
  for (const unavailable of [ { code: 1, stdout: "", stderr: "permission denied" },
    { code: 124, stdout: "", stderr: "", timedOut: true }, { code: 0, stdout: "", stderr: "" } ]) {
    await assert.rejects(observeOrphan(task, replacement, argv => argv[0] === "ps"
      ? Promise.resolve(unavailable) : callFor(snapshot())(argv)), /OS absence probe/);
  }
  fs.mkdirSync(replacement);
  await assert.rejects(observeOrphan(task, replacement, callFor(snapshot())), /absent worktree/);
  fs.rmdirSync(replacement);
  const uncertain = structuredClone(task); uncertain.reconnect = { id: "r", startedAt: new Date().toISOString(), pending: true, phase: "working" };
  await assert.rejects(observeOrphan(uncertain, replacement, callFor(snapshot())), /settled attached/);
  const workerless = structuredClone(task); workerless.worker = undefined;
  await assert.rejects(observeOrphan(workerless, replacement, callFor(snapshot())), /settled attached/);
});

test("takeover rejects a live OS PID omitted by Hermod's terminal process list", async t => {
  const task = assignment(); task.worker!.pid = process.pid;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-orphan-pid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call: Command = async argv => argv[0] === "ps" ? command(argv) : absentHermod(argv);
  await assert.rejects(observeOrphan(task, path.join(dir, "fresh"), call), /PID/);
});

test("takeover refuses a signal-killed absence probe through the real command adapter", async t => {
  const killed = await command([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]);
  const task = assignment(); task.worker!.pid = process.pid;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-orphan-signal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const call: Command = async argv => argv[0] === "ps" ? killed : absentHermod(argv);
  await assert.rejects(observeOrphan(task, path.join(dir, "fresh"), call), /OS absence probe/);
  assert.equal(killed.code, null, "a signal exit must not become ps's normal absent-PID status");
});

test("takeover rejects a replacement checkout created during discovery", async t => {
  const task = assignment(); task.worker!.pid = 42;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-orphan-tree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replacement = path.join(dir, "fresh");
  const call: Command = async argv => {
    if (argv[1] === "tabs") fs.mkdirSync(replacement);
    return absentHermod(argv);
  };
  await assert.rejects(observeOrphan(task, replacement, call), /absent worktree/);
});

test("takeover refuses a dangling symlink at the replacement path", async t => {
  const task = assignment(); task.worker!.pid = 42;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-orphan-link-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replacement = path.join(dir, "fresh");
  fs.symlinkSync(path.join(dir, "missing"), replacement);
  await assert.rejects(observeOrphan(task, replacement, absentHermod), /absent worktree/);
});

test("worktree adoption requires a linked worktree root of the same repository that names the ticket", async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gru-adopt-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=gru", "-c", "user.email=gru@example.invalid",
    "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  const repoWithOrigin = (name: string, origin: string) => {
    const repo = path.join(dir, name); fs.mkdirSync(repo);
    git(repo, "init", "-q"); git(repo, "remote", "add", "origin", origin); git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    return repo;
  };
  const repo = repoWithOrigin("repo", "git@github.com:o/r.git");
  const linked = (base: string, relative: string, ...branch: string[]) => {
    const tree = path.join(base, relative); git(base, "worktree", "add", "-q", ...branch, tree); return tree;
  };
  const task = assignment();
  task.spec = { ...task.spec, repo, repositoryKey: "o/r", worktree: path.join(repo, ".worktrees", "STARK-100") };
  const at = (worktree: string) => inspectAdoption(task, { ...task.worker!, worktree });

  // The incident layout: Hermod's Claude placement against a declared `.worktrees/` path.
  const claude = linked(repo, ".claude/worktrees/STARK-100", "-b", "worktree-STARK-100");
  const proof = await at(claude);
  assert.deepEqual({ ...proof, observedAt: undefined }, { observedAt: undefined, declared: task.spec.worktree, observed: claude,
    toplevel: claude, gitDir: path.join(repo, ".git", "worktrees", "STARK-100"), commonDir: path.join(repo, ".git"),
    repositoryKey: "o/r", branch: "worktree-STARK-100", checks: ADOPTION_CHECKS });
  // Either name identifies the ticket; a detached HEAD leaves only the directory.
  const scratch = linked(repo, "scratch", "-b", "fix/STARK-100-adopt");
  assert.equal((await at(scratch)).branch, "fix/STARK-100-adopt");
  assert.equal((await at(linked(repo, "detached/STARK-100", "--detach"))).branch, undefined);

  const other = repoWithOrigin("other", "git@github.com:o/other.git");
  const primary = repoWithOrigin("STARK-100", "git@github.com:o/r.git");
  const plain = path.join(dir, "plain", "STARK-100"); fs.mkdirSync(plain, { recursive: true });
  const refusals: [string, RegExp][] = [
    [linked(other, ".claude/worktrees/STARK-100", "-b", "worktree-STARK-100"), /belongs to o\/other, not o\/r/],
    [linked(repo, "unrelated", "-b", "unrelated"), /names STARK-100 in neither/],
    [linked(repo, "STARK-1000", "-b", "STARK-1000"), /names STARK-100 in neither/],
    [path.join(claude, "sub"), /not a worktree root/],
    [primary, /primary checkout/],
    [plain, /not a git worktree/],
    [path.join(dir, "missing", "STARK-100"), /does not exist/],
  ];
  fs.mkdirSync(path.join(claude, "sub"));
  for (const [worktree, reason] of refusals) await assert.rejects(at(worktree), (error: Error) => {
    assert.match(error.message, /^worker worktree mismatch: /, worktree);
    assert.match(error.message, reason, worktree);
    return true;
  });
  // Git's own env outranks cwd discovery. An inherited GIT_DIR made a plain folder report the
  // linked worktree's facts and a real worktree report another's, so host commands drop it.
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(repo, ".git", "worktrees", "STARK-100");
  try {
    await assert.rejects(at(plain), /is not a git worktree/);
    assert.equal((await at(scratch)).toplevel, scratch);
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
  }
  // Nor is rev-parse trusted alone: a git that resolved a plain folder to that private dir is
  // refused by the on-disk pointers.
  const misresolved: Command = async (argv, cwd, timeoutMs) => argv[1] === "rev-parse"
    ? { code: 0, stdout: [plain, path.join(repo, ".git", "worktrees", "STARK-100"), path.join(repo, ".git")].join("\n"), stderr: "" }
    : command(argv, cwd, timeoutMs);
  await assert.rejects(inspectAdoption(task, { ...task.worker!, worktree: plain }, misresolved), /not a linked worktree/);
  // A copied `.git` file points at a real worktree whose back-pointer names a different checkout.
  const copy = path.join(dir, "copy", "STARK-100"); fs.mkdirSync(copy, { recursive: true });
  fs.copyFileSync(path.join(claude, ".git"), path.join(copy, ".git"));
  await assert.rejects(at(copy), /not a linked worktree/);
  // Relative pointers (worktree.useRelativePaths) are the same linkage.
  const relative = path.join(repo, "relative", "STARK-100");
  git(repo, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", "-b", "relative-STARK-100", relative);
  assert.match(fs.readFileSync(path.join(relative, ".git"), "utf8"), /gitdir: \.\./);
  assert.equal((await at(relative)).observed, relative);
  // A timed-out probe is a failed observation, never a verdict that the checkout is not a worktree.
  const timedOut: Command = async () => ({ code: 124, stdout: "", stderr: "timed out", timedOut: true });
  await assert.rejects(inspectAdoption(task, { ...task.worker!, worktree: claude }, timedOut), (error: Error) => {
    assert.match(error.message, /^git rev-parse failed \(124\): timed out$/);
    return true;
  });
});

test("native worker discovery does not depend on an unrelated provider outage", async () => {
  const calls: string[][] = [];
  const call: Command = async argv => {
    calls.push(argv);
    return response({ peers: [peer()], observedAt: new Date().toISOString(), incomplete: !argv.includes("--agent") });
  };
  const view = await discoverWorker(assignment().worker!, call);
  assert.equal(view.incomplete, false);
  assert.equal(workerFromPeer(view.peers[0]).session, "session");
  assert.deepEqual(calls[0], ["hermod", "msg", "peers", "--all", "--agent", "codex", "--json"]);
  await assert.rejects(discoverWorker(assignment().worker!, async () => response({
    peers: [{ ...peer(), agent: "claude" }], observedAt: new Date().toISOString(), incomplete: false,
  })), /provider mismatch/);
});

test("mixed-provider observations retain uncertainty only for the unavailable provider", async () => {
  const r = run();
  const other = assignment();
  other.spec = { ...other.spec, id: "other", provider: "claude", worktree: "/other" };
  const otherPeer = { ...peer(), id: "claude:other", agent: "claude", threadId: undefined, sessionId: "other", cwd: "/other" };
  other.worker = workerFromPeer(otherPeer);
  r.tasks.push(other);
  const call: Command = async argv => {
    if (argv[1] === "sessions") return response({ sessions: [
      { sessionId: "other", agent: "claude", surfaceId: "surface", pid: 42, alive: false },
    ], totalMatches: 1 });
    const provider = argv[argv.indexOf("--agent") + 1];
    return response({ peers: provider === "codex" ? [peer()] : [],
      observedAt: new Date().toISOString(), incomplete: provider !== "codex" });
  };
  const result = await observeWorkers(r, call);
  assert.equal(result.task.liveness, "live");
  assert.equal(result.other.liveness, "unknown");
  assert.deepEqual(result.other.evidence, []);
});

test("opaque recorded identities keep the complete discovery namespace", async () => {
  const r = run();
  r.tasks[0].worker!.id = "acp:owned-session";
  const calls: string[][] = [];
  const result = await observeWorkers(r, async argv => {
    calls.push(argv);
    return response(argv[1] === "sessions" ? { sessions: [], totalMatches: 0 }
      : { peers: [{ ...peer(), id: "acp:owned-session" }], observedAt: new Date().toISOString(), incomplete: false });
  });
  assert.equal(result.task.liveness, "live");
  assert.ok(calls.some(argv => argv[1] === "msg" && !argv.includes("--agent")));
});

test("non-native attachment selectors never narrow the discovery namespace", async () => {
  for (const id of ["acp:session", "claude:session", "CODEX:session"]) {
    const calls: string[][] = [];
    const view = await discoverWorker({ provider: "codex", id }, async argv => {
      calls.push(argv);
      return response({ peers: [], observedAt: new Date().toISOString(), incomplete: true });
    });
    assert.equal(view.incomplete, true);
    assert.ok(!calls[0].includes("--agent"), id);
  }
});

test("interruption requires a complete observation of the actual worker provider", async () => {
  const task = assignment(); task.phase = "stopping";
  const actions: string[][] = [];
  let incomplete = false;
  const call: Command = async argv => {
    actions.push(argv);
    return response({ peers: [peer()], observedAt: new Date().toISOString(), incomplete: incomplete || !argv.includes("--agent") });
  };
  await interruptWorker(task, call);
  assert.deepEqual(actions.at(-1), ["hermod", "send-key", "surface", "escape"]);
  actions.length = 0;
  incomplete = true;
  await assert.rejects(interruptWorker(task, call), /incomplete/);
  assert.equal(actions.length, 1);
});

test("same-session resume retains ownership while leadership transfers require full discovery", async () => {
  await checkLeadershipTransfer("leader", "leader", async () => { throw new Error("unrelated discovery unavailable"); });
  await assert.rejects(checkLeadershipTransfer("leader", "next", async () => response({
    peers: [], observedAt: new Date().toISOString(), incomplete: true,
  })), /incomplete/);
  await assert.rejects(checkLeadershipTransfer("leader", "next", async argv => {
    assert.ok(!argv.includes("--agent"));
    return response({ peers: [{ ...peer(), threadId: "leader" }], observedAt: new Date().toISOString(), incomplete: false });
  }), /previous leader is still live/);
  // A stale record listed first must not mask a live record for the same leader.
  await assert.rejects(checkLeadershipTransfer("leader", "next", async () => response({
    peers: [{ ...peer(), id: "acp:stale", threadId: "leader", liveness: "stale" }, { ...peer(), threadId: "leader" }],
    observedAt: new Date().toISOString(), incomplete: false,
  })), /previous leader is still live/);
});

test("Gru CLI initializes with each supported session environment and rejects relative paths", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-cli-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"]) delete env[key];
  const input: Engagement = { ...run().config, id: "help", tasks: [{ ...assignment().spec,
    repo: path.resolve(import.meta.dirname, ".."), worktree: path.join(dir, "worker") }] };
  const file = path.join(dir, "engagement.json");
  fs.writeFileSync(file, JSON.stringify(input));
  const cli = path.join(import.meta.dirname, "gru.ts");
  for (const key of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID"]) {
    const result = spawnSync(process.execPath, [cli, "init", "--file", file, "--state", path.join(dir, `${key}.sqlite`)],
      { env: { ...env, [key]: input.leader }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).config.leader, input.leader);
    const status = spawnSync(process.execPath, [cli, "status", "--run", "help", "--state", path.join(dir, `${key}.sqlite`)],
      { env: { ...env, [key]: input.leader }, encoding: "utf8", timeout: 10_000 });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).config.id, "help");
  }
  input.tasks[0].repo = ".";
  fs.writeFileSync(file, JSON.stringify(input));
  const invalid = spawnSync(process.execPath, [cli, "init", "--file", file, "--state", path.join(dir, "invalid.sqlite"), "--leader", input.leader],
    { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /absolute paths/);
});

test("Hermod discovery omissions and stale hooks never prove death", () => {
  const d = { peers: [peer()], observedAt: new Date().toISOString(), incomplete: false };
  assert.equal(observations(run(), d).task.liveness, "live");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), cwd: "/worktree/" }] }).task.liveness, "live");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), cwd: undefined }] }).task.liveness, "unknown");
  // A verified live peer is positive evidence even when Hermod could not inspect every process.
  assert.equal(observations(run(), { ...d, incomplete: true }).task.liveness, "live");
  assert.equal(observations(run(), { ...d, peers: [] }).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale" }] }).task.liveness, "unknown");
  const saved = [{ sessionId: "session", agent: "codex", surfaceId: "surface", pid: 42, alive: false }];
  assert.equal(observations(run(), { ...d, peers: [] }, saved).task.liveness, "dead");
  assert.equal(observations(run(), d, saved).task.liveness, "live");
  const unassigned = run(); delete unassigned.tasks[0].worker;
  const malformed = JSON.parse('[{"agent":"codex","alive":false,"pid":42}]');
  assert.equal(observations(unassigned, { ...d, peers: [] }, malformed).task.liveness, "unknown");
  // Hermod keeps a stale hook-record peer for the dead session; it is the same evidence, not life.
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale", pid: 42 }] }, saved).task.liveness, "dead");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale", pid: 7 }] }, saved).task.liveness, "unknown");
  // Missing PIDs cannot establish termination, including beside a stale peer.
  const gone = [{ sessionId: "session", agent: "codex", surfaceId: "surface" }];
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale", pid: undefined }] }, gone).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, peers: [] }, gone).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale", pid: 42 }] }, gone).task.liveness, "unknown");
  // Absence inside an incomplete namespace proves nothing.
  assert.equal(observations(run(), { ...d, peers: [], incomplete: true }, saved).task.liveness, "unknown");
  // Discovery is collected per provider namespace.
  assert.equal(observations(run(), { codex: d }).task.liveness, "live");
  assert.throws(() => observations(run(), { claude: d }), /no Hermod discovery for provider codex/);
});

test("retired surface absence releases capacity without turning unknown PIDs into death", () => {
  const r = run(); r.tasks[0].phase = "done";
  r.tasks[0].retired = { surface: "surface", at: new Date().toISOString() };
  const d = { peers: [], observedAt: new Date().toISOString(), incomplete: false };
  const saved = [{ sessionId: "session", agent: "codex", surfaceId: "surface" }];
  assert.equal(observations(r, d, saved).task.retired, true);
  assert.equal(observations(r, d, saved).task.liveness, "unknown");
  assert.equal(observations(r, { ...d, incomplete: true }, saved).task.retired, undefined);
  assert.equal(observations(r, { ...d, peers: [{ ...peer(), surfaceId: "resumed", activity: "busy" }] }, saved).task.retired, undefined);
  assert.equal(observations(r, d, [{ ...saved[0], alive: true }]).task.retired, undefined);
  r.tasks[0].retired = undefined;
  assert.equal(observations(r, d, saved).task.retired, undefined);
});

test("local PID absence cannot override incomplete Hermod identity evidence", async () => {
  const r = run(); r.tasks[0].worker!.pid = 999999999;
  const calls: string[][] = [];
  const result = await observeWorkers(r, async argv => { calls.push(argv); return response(argv[1] === "sessions"
    ? { sessions: [], totalMatches: 0 }
    : { peers: [], observedAt: new Date().toISOString(), incomplete: false }); });
  assert.equal(result.task.liveness, "unknown");
  // The peer query is scoped to the task's provider so one stray process elsewhere cannot taint it.
  assert.ok(calls.some(argv => argv[1] === "msg" && argv.includes("--agent") && argv.includes("codex")));
});

test("sweep evidence stays silent without held tasks and reads each ticket and namespace once", async () => {
  const calls: string[][] = [];
  const call: Command = async argv => {
    calls.push(argv);
    return argv[0] === "alfred" ? response({ item: { ref: { custom_id: argv[3] }, state: "Closed" }, comments: [], comments_read: true })
      : argv[1] === "sessions" ? response({ sessions: [], totalMatches: 0 })
      : response({ peers: [], observedAt: new Date().toISOString(), incomplete: false });
  };
  const verified = run(); verified.tasks[0].phase = "done";
  const unstarted = run(); unstarted.tasks[0].phase = "pending"; unstarted.tasks[0].attempts = 0;
  assert.equal((await observeSweep([verified, unstarted], call)).size, 0);
  assert.deepEqual(calls, [], "nothing held means no Alfred or Hermod traffic");
  const second = run(); second.config.id = "second";
  const evidence = await observeSweep([run(), second], call);
  assert.deepEqual([...evidence.keys()], ["run", "second"]);
  assert.deepEqual(calls.filter(c => c[0] === "alfred"), [["alfred", "task", "show", "STARK-100", "--json"]]);
  // The scoped namespace decides completeness; the unscoped one finds any occupant.
  assert.deepEqual(calls.filter(c => c[1] === "msg"), [["hermod", "msg", "peers", "--all", "--agent", "codex", "--json"],
    ["hermod", "msg", "peers", "--all", "--json"]]);
  assert.equal(evidence.get("second")!.revision, second.revision);
  assert.equal(calls.filter(c => c[1] === "sessions").length, 1);
  assert.equal(evidence.get("run")!.tickets["STARK-100"], "Closed");
  assert.deepEqual(evidence.get("run")!.peers, []);
  assert.deepEqual(evidence.get("run")!.tasks.task, { complete: true,
    observation: { observedAt: evidence.get("run")!.tasks.task.observation.observedAt, liveness: "unknown", activity: "unknown", evidence: [] } });
});

test("sweep reads STARK tickets from a recorded repository Alfred binds to them, never the wrong provider", async () => {
  // Alfred refuses work verbs outside a checkout (a machine-wide sweep runs from $HOME) and binds
  // its provider from the checkout's org: a Jira-bound repository reads a STARK handle as missing.
  const reads: [string, string | undefined, number][] = [];
  const world = (clickup: readonly (string | undefined)[]): Command => async (argv, cwd) => {
    if (argv[0] === "alfred") {
      const ok = clickup.includes(cwd);
      reads.push([argv[3], cwd, ok ? 0 : 1]);
      return ok ? response({ item: { ref: { custom_id: argv[3] }, state: "Closed" }, comments: [], comments_read: true })
        : { code: 1, stdout: "", stderr: cwd === undefined ? "alfred: not a git repo — work verbs refuse" : `alfred: ${argv[3]} not found` };
    }
    return argv[1] === "sessions" ? response({ sessions: [], totalMatches: 0 })
      : response({ peers: [], observedAt: new Date().toISOString(), incomplete: false });
  };
  const jira = run(); jira.config.id = "jira";
  jira.tasks[0].spec = { ...jira.tasks[0].spec, ticket: "STARK-200", repo: "/evinced-repo" };
  const evidence = await observeSweep([jira, run()], world(["/repo"]));
  assert.deepEqual(evidence.get("jira")!.tickets, { "STARK-200": "Closed", "STARK-100": "Closed" });
  // The Jira-bound checkout fails once; the context that yielded validated evidence reads the rest.
  assert.deepEqual(reads, [["STARK-200", "/evinced-repo", 1], ["STARK-200", "/repo", 0], ["STARK-100", "/repo", 0]]);
  // A Jira-only sweep (`--run`) borrows another recorded repository before the caller's directory.
  reads.length = 0;
  assert.equal((await observeSweep([jira], world(["/repo", undefined]), ["/evinced-repo", "/repo"])).get("jira")!.tickets["STARK-200"], "Closed");
  assert.deepEqual(reads, [["STARK-200", "/evinced-repo", 1], ["STARK-200", "/repo", 0]]);
  // The caller's directory is the last context, not a fallback that hides a failure.
  assert.equal((await observeSweep([jira], world([undefined]))).get("jira")!.tickets["STARK-200"], "Closed");
  // No context reads: every context's real error is reported and nothing is gathered.
  await assert.rejects(observeSweep([jira, run()], world([])),
    /no Alfred context read STARK-200: \/evinced-repo: alfred failed \(1\): alfred: STARK-200 not found; \/repo: .*not found; current directory: .*not a git repo/);
  // A context that reads the first ticket but fails a later one is a real error, not a cue to move on.
  let laterReads = 0;
  const partial: Command = async (argv, cwd) => argv[0] === "alfred" && argv[3] === "STARK-100"
    ? (laterReads++, { code: 1, stdout: "", stderr: "ClickUp unreachable" }) : world(["/evinced-repo", "/repo"])(argv, cwd);
  await assert.rejects(observeSweep([jira, run()], partial), /alfred failed \(1\): ClickUp unreachable/);
  assert.equal(laterReads, 1);
});

test("command terminates a real check at its declared timeout", async () => {
  const result = await command([process.execPath, "-e", "setInterval(() => {}, 1000)"], undefined, 100);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, 124);
});

test("dispatch packet uses the selected runtime and retains the full objective and limits", () => {
  const r = run();
  const brief = packet(r, r.tasks[0]);
  assert.ok(brief.startsWith("Run $minion"));
  assert.ok(brief.includes(r.tasks[0].spec.objective));
  assert.ok(brief.includes("No new tickets"));
  r.tasks[0].spec.provider = "claude";
  assert.ok(packet(r, r.tasks[0]).startsWith("Run /minion"));
  assert.throws(() => workerFromPeer({ ...peer(), threadId: undefined }), /identity/);
});

test("completed idle workers retire through Hermod without deleting session worktrees", async () => {
  const task = assignment(); task.phase = "done";
  let activity = "busy";
  const actions: string[][] = [];
  const call: Command = async argv => {
    actions.push(argv);
    return response({ peers: [{ ...peer(), cwd: "/worktree/", activity }], observedAt: new Date().toISOString(), incomplete: false });
  };
  await assert.rejects(retireWorker(task, call), /idle/);
  assert.equal(actions.length, 1);
  activity = "idle";
  await retireWorker(task, call);
  assert.deepEqual(actions.at(-1), ["hermod", "close", "surface", "--workspace", "workspace"]);
  assert.equal(await canonicalRepository("/repo", async () => ({ code: 0, stdout: "git@github.com:Owner/Repo.git\n", stderr: "" })), "owner/repo");
});

const briefMessage = "12345678-1234-1234-1234-123456789012";
const earlierMessage = "12345678-1234-1234-1234-123456789013";
const rebriefInput = () => ({ message: briefMessage, run: "run", task: "task", currentLeader: "leader", worker: "session" });
const rebriefRecord = (r = run()) => ({ id: briefMessage, state: "submitted", kind: "note", delivery: "unconfirmed",
  createdAt: new Date().toISOString(), sender: { sessionId: r.config.leader }, destination: { threadId: "session" }, body: packet(r, r.tasks[0]) });

test("rebrief screen reads the ledger body and refuses wrong identity, terminal records, and ambiguous packets", async () => {
  const record = rebriefRecord();
  const result = await checkRebrief(rebriefInput(), async argv => {
    assert.deepEqual(argv, ["hermod", "msg", "status", briefMessage, "--json"]);
    return response(record);
  });
  assert.equal(result.body, record.body);
  assert.equal(result.token, "token");
  assert.equal(result.transfer, "same-leader");
  for (const changed of [
    { ...record, id: earlierMessage }, { ...record, state: "failed" }, { ...record, cancelled: true },
    { ...record, expired: true }, { ...record, supersededBy: earlierMessage }, { ...record, kind: "request" },
    { ...record, destination: { threadId: "other" } }, { ...record, sender: undefined },
    { ...record, sender: { sessionId: "other" } }, { ...record, createdAt: "invalid" },
    { ...record, body: record.body.replace("Assignment: run/task", "Assignment: other/task") },
    { ...record, body: record.body.replace("Assignment: run/task", "Assignment: run/other") },
    { ...record, body: record.body + "\nLeader session: relayed. Provider: codex." },
    { ...record, body: record.body.replace('"token":"token"', '"token":"other"') },
    // A second metadata line is as ambiguous as a second header, and a malformed one refuses
    // with the contract's message rather than a raw JSON.parse error the worker would relay.
    { ...record, body: record.body + "\nGru rebrief: {\"version\":1}" },
    { ...record, body: record.body.replace(/^Gru rebrief: .*$/m, "Gru rebrief: {\"version\":1,") },
    { ...record, body: record.body.replace(/^Gru rebrief: .*$/m, "Gru rebrief: null") },
  ]) await assert.rejects(checkRebrief(rebriefInput(), async () => response(changed)));
  await assert.rejects(checkRebrief({ ...rebriefInput(), task: "other" }, async () => response(record)),
    /does not match the assignment/);
  await assert.rejects(checkRebrief({ ...rebriefInput(), run: "other" }, async () => response(record)),
    /does not match the assignment/);
  for (const code of [2, 4, null]) await assert.rejects(checkRebrief(rebriefInput(), async () => ({ ...response(record), code })));
  // Reading one's own addressed record is intake; native delivery need not already be confirmed.
  for (const code of [3, 5]) assert.equal((await checkRebrief(rebriefInput(), async () => ({ ...response(record), code }))).accepted, true);
});

test("rebrief ordering and rereading use the latest accepted ledger packet, including a legacy baseline", async () => {
  const current = { ...rebriefRecord(), id: earlierMessage, createdAt: "2026-09-17T10:00:00Z" };
  current.body = current.body.replace(/^Gru rebrief: .*\n/m, "");
  const record = { ...rebriefRecord(), createdAt: "2026-09-17T10:31:00Z" };
  const input = { ...rebriefInput(), currentMessage: earlierMessage };
  const call: Command = async argv => response(argv[3] === earlierMessage ? current : record);
  assert.equal((await checkRebrief(input, call)).accepted, true);
  record.createdAt = current.createdAt;
  await assert.rejects(checkRebrief(input, call), /not newer/);
  record.createdAt = "2026-09-17T09:59:59Z";
  await assert.rejects(checkRebrief(input, call), /not newer/);
  assert.equal((await checkRebrief({ ...input, currentMessage: briefMessage }, call)).accepted, true);
  // Hermod accepts a message id in any case and stores it lower-cased, so an upper-case id an
  // operator pasted must query the same record and still read as a reread, not as a second,
  // not-newer packet. (Hermod's own ids carry hex letters; this fixture's digits do not.)
  const mixedId = "abcdef12-1234-1234-1234-123456789012";
  const upper = await checkRebrief({ ...input, message: mixedId.toUpperCase(), currentMessage: mixedId },
    async argv => { assert.equal(argv[3], mixedId); return response({ ...record, id: mixedId }); });
  assert.equal(upper.ordering, "reread");
  assert.equal(upper.messageId, mixedId);
  await assert.rejects(checkRebrief({ ...input, currentLeader: "other" }, call), /current packet/);
  // The baseline is screened like the packet: another worker's or another sender's record
  // cannot serve as the ordering reference.
  for (const wrong of [{ ...current, destination: { threadId: "other" } }, { ...current, sender: { sessionId: "other" } },
    { ...current, body: current.body.replace("Assignment: run/task", "Assignment: other/task") },
    { ...current, body: current.body.replace("Assignment: run/task", "Assignment: run/other") }]) {
    await assert.rejects(checkRebrief(input, async argv => response(argv[3] === earlierMessage ? wrong : record)), /current packet/);
  }
  assert.equal((await checkRebrief(rebriefInput(), async () => response(record))).ordering, "unchecked");
  await assert.rejects(checkRebrief(input, async argv => argv[3] === earlierMessage
    ? { code: 2, stdout: "", stderr: "unknown message" } : response(record)),
  /accepted baseline .* is unreadable; retain it .* do not omit --current-message/);
});

test("a lower authority epoch never supersedes the accepted packet, whatever its send time", async () => {
  // `createdAt` is send time. A leader session revived from an old transcript can resend a
  // packet generated before a transfer; only `epoch` records which packet holds authority.
  const accepted = run(); accepted.config.leader = "next"; accepted.epoch = 4; accepted.tasks[0].token = "current";
  const current = { ...rebriefRecord(accepted), id: earlierMessage, createdAt: "2026-09-17T10:00:00Z" };
  const stale = { ...rebriefRecord(), createdAt: "2026-09-17T11:00:00Z" };
  const local = { observedAt: new Date().toISOString(), incomplete: false, peers: [] as HermodPeer[] };
  const call: Command = async argv => response(argv[2] === "status" ? (argv[3] === earlierMessage ? current : stale) : local);
  const input = { ...rebriefInput(), currentLeader: "next", currentMessage: earlierMessage };
  await assert.rejects(checkRebrief(input, call), /older leadership epoch/);
  const sameEpochOtherLeader = run(); sameEpochOtherLeader.epoch = 4;
  const equal = { ...rebriefRecord(sameEpochOtherLeader), createdAt: "2026-09-17T11:00:00Z" };
  await assert.rejects(checkRebrief(input, async argv => response(argv[2] === "status"
    ? (argv[3] === earlierMessage ? current : equal) : local)), /older leadership epoch/);
  // The same leader replacing a token inside one epoch stays legitimate.
  const sameEpoch = run(); sameEpoch.config.leader = "next"; sameEpoch.epoch = 4; sameEpoch.tasks[0].token = "adopted";
  const adopted = { ...rebriefRecord(sameEpoch), createdAt: "2026-09-17T11:00:00Z" };
  assert.equal((await checkRebrief(input, async argv => response(argv[3] === earlierMessage ? current : adopted))).token, "adopted");
});

test("sandboxed transfer uses resume evidence, including missed transfers, but never overrides a live old leader", async () => {
  const r = run(); r.config.leader = "next"; r.epoch = 3;
  const observedAt = "2026-09-17T10:00:00Z";
  const discovery = { observedAt, incomplete: false, peers: [{ sessionId: "leader", liveness: "stale" }] };
  r.transfers = [
    { previous: "leader", current: "middle", epoch: 2, at: observedAt, discovery },
    { previous: "middle", current: "next", epoch: 3, at: observedAt, discovery: { ...discovery, peers: [] } },
  ];
  let local = { observedAt: new Date().toISOString(), incomplete: true, peers: [] as HermodPeer[] };
  const call: Command = async argv => argv[2] === "status" ? response(rebriefRecord(r)) : response(local);
  assert.equal((await checkRebrief(rebriefInput(), call)).transfer, "resume-receipt");
  const denied: Command = async argv => argv[2] === "status" ? call(argv) : { code: 1, stdout: "", stderr: "ps denied" };
  assert.equal((await checkRebrief(rebriefInput(), denied)).transfer, "resume-receipt");
  local.peers = [{ ...peer(), threadId: "leader", liveness: "live" }];
  await assert.rejects(checkRebrief(rebriefInput(), call), /still live/);
  local.peers = [];
  const receipts = structuredClone(r.transfers);
  for (const mutate of [
    () => { r.transfers = []; },
    () => { r.transfers![0].discovery.incomplete = true; },
    () => { r.transfers![0].discovery.peers[0].liveness = "live"; },
    () => { r.transfers![0].discovery.observedAt = "2026-09-17T09:00:00Z"; },
    () => { r.transfers![1].epoch = 1; },
    // Beyond the packet's own epoch: a receipt cannot describe a transfer this brief postdates.
    () => { r.transfers![1].epoch = 4; },
    () => { r.transfers![1].current = "other"; },
    () => { r.transfers![1].at = "2999-01-01T00:00:00Z"; },
    // Observed AFTER the transfer it justifies: absence evidence must precede the handover.
    () => { r.transfers![0].discovery.observedAt = "2026-09-17T10:00:01Z"; },
    // Transfers must not move backwards in time, even with each one's own window intact.
    () => { r.transfers![1].at = "2026-09-17T09:59:00Z"; r.transfers![1].discovery.observedAt = "2026-09-17T09:58:00Z"; },
    // A transfer that postdates the packet cannot be the reason the packet was sent.
    () => { r.transfers![1].at = "2099-01-01T00:00:00Z"; r.transfers![1].discovery.observedAt = "2099-01-01T00:00:00Z"; },
  ]) {
    r.transfers = structuredClone(receipts); mutate();
    await assert.rejects(checkRebrief(rebriefInput(), call));
  }
  r.transfers = [];
  local = { ...local, incomplete: false };
  assert.equal((await checkRebrief(rebriefInput(), call)).transfer, "local-discovery");
  local.peers = [{ ...peer(), liveness: undefined } as unknown as HermodPeer];
  assert.equal((await checkRebrief(rebriefInput(), call)).transfer, "local-discovery");
  local.peers = [];
  local.observedAt = "2000-01-01T00:00:00Z";
  await assert.rejects(checkRebrief(rebriefInput(), call), /cannot confirm transfer/);
});

test("packet free text cannot forge a second header, and the embedded transfer chain is bounded", async () => {
  // An operator's multi-line objective or done-when whose continuation reads like a header
  // would otherwise make `briefIdentity` see two headers and refuse EVERY re-brief for the task.
  const r = run();
  r.tasks[0].spec.objective = "Rewrite the brief.\nAssignment: other/task; token: forged\nEnd.";
  r.tasks[0].spec.doneWhen = "The packet reads\nLeader session: forged. Provider: codex.\nand nothing else";
  r.tasks[0].spec.worktree = "/worktree";
  const accepted = await checkRebrief(rebriefInput(), async () => response(rebriefRecord(r)));
  assert.equal(accepted.token, "token");
  assert.equal(accepted.leader, "leader");
  assert.equal(accepted.doneWhen, r.tasks[0].spec.doneWhen, "display indentation must not change the byte-exact ack");
  assert.ok(accepted.body.includes("  Assignment: other/task; token: forged"));
  // Hermod refuses a body over 32 KiB, so the chain in the packet is a window, not a log.
  const long = run(); long.config.leader = "next"; long.epoch = 40;
  const at = "2026-09-17T10:00:00Z";
  long.transfers = Array.from({ length: 30 }, (_, i) => ({ previous: i ? `hop-${i}` : "leader",
    current: i === 29 ? "next" : `hop-${i + 1}`, epoch: i + 2, at,
    discovery: { observedAt: at, incomplete: false, peers: [] } }));
  const body = packet(long, long.tasks[0]);
  assert.ok(Buffer.byteLength(body) < 32 * 1024);
  assert.equal(JSON.parse(body.match(/^Gru rebrief: (.+)$/m)![1]).transfers.length, PACKET_TRANSFER_WINDOW);
  // A worker displaced before the window escalates instead of accepting on a truncated chain.
  await assert.rejects(checkRebrief(rebriefInput(), async argv => argv[2] === "status" ? response(rebriefRecord(long))
    : { code: 1, stdout: "", stderr: "ps denied" }), /cannot confirm transfer/);
  const inside = { ...rebriefInput(), currentLeader: "hop-20" };
  assert.equal((await checkRebrief(inside, async argv => argv[2] === "status" ? response(rebriefRecord(long))
    : { code: 1, stdout: "", stderr: "ps denied" })).transfer, "resume-receipt");
});

// Reusable review verification: run explicitly with GRU_REBRIEF_MUTATION_SWEEP=1.
// Mutations live only in a disposable copy; ordinary npm test does not pay for the sweep.
test("checker mutation sweep rejects deleted guards", { skip: process.env.GRU_REBRIEF_MUTATION_SWEEP !== "1" }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-mutations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, "tools");
  fs.cpSync(import.meta.dirname, copy, { recursive: true, filter: source => path.basename(source) !== "node_modules" });
  const source = path.join(copy, "gru_runtime_lib.ts");
  const original = fs.readFileSync(source, "utf8");
  const predicates = [
    "session(previous.destination) !== input.worker",
    "session(previous.sender) !== current.leader",
    "current.run !== input.run", "current.task !== input.task",
    "brief.task !== input.task", "brief.run !== input.run",
    "metadata.length > 1",
    "receipt.epoch > (brief.epoch ?? -1)",
    "observed > transferred", "transferred < at", "transferred > Date.parse(createdAt)",
    "session(record.destination) !== input.worker", "session(record.sender) !== brief.leader",
    'record.kind !== "note"', 'code === 4 || unusableMessage(record)',
    "created <= Date.parse(previous.createdAt!)",
    "brief.epoch < current.epoch", "brief.epoch === current.epoch",
    "peers?.peers.some(p => session(p) === input.currentLeader && p.liveness === \"live\")",
    "receipt.epoch <= epoch", "transferred - observed > 60_000",
  ];
  // Node marks test children; inheriting this marker makes a nested --test silently
  // skip every test with exit 0, which would invalidate the baseline and the sweep.
  const { NODE_TEST_CONTEXT: _testContext, ...childEnv } = process.env;
  const execute = () => spawnSync(process.execPath, ["--test", "--test-reporter=spec", "--test-name-pattern",
    "rebrief|sandboxed transfer|packet free text|authority epoch", path.join(copy, "gru_runtime_lib.test.ts")],
  { encoding: "utf8", timeout: 20_000, env: { ...childEnv, GRU_REBRIEF_MUTATION_SWEEP: "0" } });
  const baseline = execute();
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const predicate of predicates) {
    assert.equal(original.split(predicate).length, 2, `mutation must have one target: ${predicate}`);
    fs.writeFileSync(source, original.replace(predicate, "false"));
    const result = execute();
    assert.equal(result.status, 1, `survived or failed to execute: ${predicate}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /AssertionError/, `mutation must fail an assertion, not startup: ${predicate}\n${result.stdout}${result.stderr}`);
    t.diagnostic(`KILLED: ${predicate}`);
  }
  t.diagnostic(`${predicates.length}/${predicates.length} deleted guards rejected`);
});

test("a note acknowledged after 30 minutes and its late-imported progress ack pass without expiry exceptions", async () => {
  const record = { ...rebriefRecord(), createdAt: "2026-09-17T10:00:00Z", deadline: "2026-09-17T10:30:00Z" };
  assert.equal((await checkRebrief(rebriefInput(), async () => response(record))).accepted, true);
  // Hermod's submitted note/progress kinds are expiry-exempt. A fresh send has no replyTo
  // and no inherited request deadline; receive still requires the leader's confirmed receipt.
  const ack = { kind: "progress", state: "submitted", delivery: "confirmed", from: peer().id, sender: peer(),
    destination: { sessionId: "leader" }, createdAt: "2026-09-17T10:31:00Z", deadline: "2026-09-17T11:01:00Z",
    body: JSON.stringify({ run: "run", task: "task", token: "token", kind: "ack", message: assignment().spec.doneWhen }) };
  assert.equal((await receive(run(), earlierMessage, async () => response(ack))).kind, "ack");
  await assert.rejects(receive(run(), earlierMessage, async () => response({ ...ack, expired: true })), /not confirmed/);
});

test("only a delivered message from the assigned session reaches the leader", async () => {
  const messageId = "12345678-1234-1234-1234-123456789012";
  const record = { state: "submitted", delivery: "confirmed", from: peer().id, sender: peer(),
    destination: { threadId: "leader" }, body: JSON.stringify({ run: "run", task: "task", token: "token", kind: "complete", message: "Everything passed" }) };
  assert.equal((await receive(run(), messageId, async () => response(record))).kind, "complete");
  for (const changed of [
    { ...record, delivery: "unconfirmed" }, { ...record, cancelled: true },
    { ...record, from: "other-worker" }, { ...record, sender: { threadId: "other-session" } },
    { ...record, destination: { threadId: "other-leader" } },
  ]) await assert.rejects(receive(run(), messageId, async () => response(changed)));
  // A mismatched Minion's plain worktree note is named as such, not surfaced as a raw JSON parse error.
  for (const body of ["My actual checkout is /repo/.claude/worktrees/STARK-1", "null", "42"]) {
    await assert.rejects(receive(run(), messageId, async () => response({ ...record, body })), /not a JSON report/);
  }
  // Only a note addressed to this leader earns the plain-note hint; anyone else's prose is an identity mismatch.
  await assert.rejects(receive(run(), messageId, async () => response({ ...record, body: "prose", destination: { threadId: "other-leader" } })),
    /does not match the current assignment identity/);
  // Hermod exits 4/5 for failed/uncertain records while still printing them: a verdict, not a transport error.
  await assert.rejects(receive(run(), messageId, async () => ({ ...response({ ...record, state: "uncertain" }), code: 5 })), /not confirmed/);
  await assert.rejects(receive(run(), messageId, async () => ({ ...response({ ...record, delivery: "unconfirmed" }), code: 3 })), /not confirmed/);
  await assert.rejects(receive(run(), messageId, async () => ({ code: 2, stdout: "", stderr: "socket closed" })), /hermod failed \(2\)/);
});

test("completion reruns behavior on fetched main and refuses an inaccurate green claim", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-verify-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const repoDir = path.join(dir, "repo");
  const exec = (argv: string[], cwd?: string) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 10_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const must = (argv: string[], cwd?: string) => { const r = exec(argv, cwd); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); };
  must(["git", "init", "--bare", origin]);
  must(["git", "clone", origin, repoDir]);
  must(["git", "config", "user.name", "Gru Test"], repoDir);
  must(["git", "config", "user.email", "gru@example.invalid"], repoDir);
  must(["git", "checkout", "-b", "main"], repoDir);
  fs.writeFileSync(path.join(repoDir, "verify.cjs"), "process.exit(7);\n");
  must(["git", "add", "verify.cjs"], repoDir);
  must(["git", "commit", "-m", "Intentionally failing behavior"], repoDir);
  must(["git", "push", "origin", "main"], repoDir);
  const sha = must(["git", "rev-parse", "HEAD"], repoDir);
  must(["git", "push", "origin", "HEAD:refs/pull/1/head"], repoDir);
  const task = assignment(); task.spec.repo = repoDir; task.integrationBase = sha;
  const pr = { merged: true, merged_at: new Date().toISOString(), merge_commit_sha: sha,
    head: { sha, repo: { full_name: "Owner/Repo" } }, base: { ref: "main", repo: { full_name: "Owner/Repo" } }, html_url: "https://github.com/owner/repo/pull/1" };
  let reviewHead = sha;
  const call: Command = async (argv, cwd) => {
    if (argv[0] === "git" && argv[1] === "remote") return { code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" };
    if (argv[0] === "gh") return response(argv[2].includes("reviews") ? { commit_id: reviewHead, submitted_at: new Date().toISOString(), state: "COMMENTED", html_url: pr.html_url + "#pullrequestreview-1" } : pr);
    if (argv[0] === "alfred") return response({ item: { ref: { custom_id: "STARK-100" }, state: "done" }, comments: [], comments_read: true });
    const result = exec(argv, cwd);
    if (argv[0] === "git" && argv[1] === "fetch" && result.code === 0) {
      // Simulate an unrelated concurrent fetch replacing this shared scratch file.
      const fetchHead = must(["git", "rev-parse", "--git-path", "FETCH_HEAD"], cwd);
      fs.writeFileSync(path.resolve(cwd!, fetchHead), "b".repeat(40) + "\n");
    }
    return result;
  };
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "failed-check"), call), /independent check failed/);
  const failedLogs = fs.readdirSync(path.join(dir, "failed-check")).filter(f => f.endsWith(".log"));
  const observed = JSON.parse(fs.readFileSync(path.join(dir, "failed-check", failedLogs[0]), "utf8"));
  assert.equal(observed.code, 7);
  assert.notEqual(observed.cwd, task.spec.worktree);
  assert.equal(fs.existsSync(observed.cwd), false);
  assert.ok(!must(["git", "worktree", "list", "--porcelain"], repoDir).includes("worktree-token"));
  reviewHead = "b".repeat(40);
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "stale-review"), call), /does not cover/);
  assert.equal(fs.existsSync(path.join(dir, "stale-review")), false);
  fs.writeFileSync(path.join(repoDir, "verify.cjs"), "console.log('behavior verified');\n");
  must(["git", "add", "verify.cjs"], repoDir);
  must(["git", "commit", "-m", "Fix behavior"], repoDir);
  must(["git", "push", "origin", "main"], repoDir);
  const fixed = must(["git", "rev-parse", "HEAD"], repoDir);
  must(["git", "push", "origin", "HEAD:refs/pull/1/head"], repoDir);
  pr.head.sha = fixed; pr.merge_commit_sha = fixed; reviewHead = fixed;
  const proof = await verifyCompletion(task, 1, 1, path.join(dir, "passing-check"), call);
  assert.equal(proof.merge, fixed);
  assert.equal(proof.head, fixed);
  assert.equal(proof.checks[0].exitCode, 0);
  assert.match(fs.readFileSync(proof.checks[0].log, "utf8"), /behavior verified/);
  // The grant was checked against ONE base branch's tip, with a verified-merge floor scoped
  // to that branch. A PR merged into a different branch discharges a grant nothing on the
  // merged branch ever checked — `--base-ref` is operator-supplied, so without this a grant
  // taken at a quiet branch's tip settles a merge into `main` that skipped every other task.
  const granted = { observedAt: new Date().toISOString(), repositoryKey: "owner/repo", ref: "release",
    tip: fixed, base: fixed, contains: [], checks: [...BASE_CHECKS] };
  task.baseEvidence = granted;
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "wrong-base-branch"), call),
    /integration base was granted on release, but PR 1 merged into main/);
  assert.equal(fs.existsSync(path.join(dir, "wrong-base-branch")), false);
  granted.ref = "main";
  assert.equal((await verifyCompletion(task, 1, 1, path.join(dir, "matching-base-branch"), call)).merge, fixed);
  // A grant recorded before this evidence existed has no ref to compare and still verifies.
  task.baseEvidence = undefined;
  // A reserved replacement cannot settle the prior worker's merge; only the
  // window before replacement starts, or its own integration grant, can.
  task.phase = "intake";
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "replacement-intake"), call), /integration reservation required/);
  task.phase = "working";
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "replacement-working"), call), /integration reservation required/);
  // Cancelling a working replacement must not reopen the inherited grant.
  task.phase = "stopped"; task.stoppedFrom = "working";
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "replacement-stopped"), call), /integration reservation required/);
  // An unsettled reconnect blocks verification even at the integration phase.
  task.phase = "integrating"; task.stoppedFrom = undefined;
  task.reconnect = { id: "reconnect", startedAt: new Date().toISOString(), phase: "integrating", pending: true };
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "unsettled-reconnect"), call), /integration reservation required/);
  task.reconnect = undefined;
  // Cancelling an in-flight integration keeps the merge settleable.
  task.phase = "stopped"; task.stoppedFrom = "integrating";
  assert.equal((await verifyCompletion(task, 1, 1, path.join(dir, "stopped-integrating"), call)).merge, fixed);
  task.phase = "pending"; task.stoppedFrom = undefined;
  assert.equal((await verifyCompletion(task, 1, 1, path.join(dir, "before-replacement-check"), call)).merge, fixed);
  task.phase = "integrating";
  assert.equal(fs.existsSync(path.join(dir, "passing-check", "worktree-token")), false);

  // The same assignment can be verified twice after a leadership race. Finishing
  // one invocation must not delete refs the other still needs to inspect.
  let releaseFirst!: () => void;
  let firstFetched!: () => void;
  const firstWaiting = new Promise<void>(resolve => { firstFetched = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const delayed: Command = async (argv, cwd, timeoutMs) => {
    const result = await call(argv, cwd, timeoutMs);
    if (argv[0] === "git" && argv[1] === "fetch") { firstFetched(); await release; }
    return result;
  };
  const first = verifyCompletion(task, 1, 1, path.join(dir, "concurrent-first"), delayed);
  await Promise.race([firstWaiting, first]);
  try { await verifyCompletion(task, 1, 1, path.join(dir, "concurrent-second"), call); }
  finally { releaseFirst(); }
  assert.equal((await first).merge, fixed);
  assert.equal(must(["git", "for-each-ref", "--format=%(refname)", "refs/gru"], repoDir), "");

  // The verifier forwards the task's bound, and rejects a timed-out result even
  // if the process reported zero just as the timeout fired.
  const bounds: number[] = [];
  const timed: Command = async (argv, cwd, timeoutMs) => {
    if (argv[0] === "node") {
      bounds.push(timeoutMs!);
      return { code: 0, stdout: "partial output", stderr: "", timedOut: true };
    }
    return call(argv, cwd, timeoutMs);
  };
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "default-timeout"), timed), /check timed out/);
  task.spec.checkTimeoutMs = 600_000;
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "custom-timeout"), timed), /check timed out/);
  assert.deepEqual(bounds, [DEFAULT_CHECK_TIMEOUT_MS, 600_000]);

  // Cleanup continues after a transport exception and preserves the check error.
  const cleanupAttempts: string[][] = [];
  const cleanupFailure: Command = async (argv, cwd, timeoutMs) => {
    const result = await timed(argv, cwd, timeoutMs);
    if (argv[0] === "git" && argv[1] === "update-ref") {
      cleanupAttempts.push(argv);
      throw new Error("simulated cleanup transport failure");
    }
    return result;
  };
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "cleanup-failure"), cleanupFailure), /check timed out/);
  assert.equal(cleanupAttempts.length, 2);
  assert.equal(must(["git", "for-each-ref", "--format=%(refname)", "refs/gru"], repoDir), "");

  // The verification clone cannot see the reviewed head through the squash.
  must(["git", "checkout", "-b", "candidate"], repoDir);
  fs.writeFileSync(path.join(repoDir, "feature.txt"), "squashed feature");
  must(["git", "add", "feature.txt"], repoDir);
  must(["git", "commit", "-m", "Feature head"], repoDir);
  const candidate = must(["git", "rev-parse", "HEAD"], repoDir);
  must(["git", "push", "origin", "HEAD:refs/pull/1/head"], repoDir);
  must(["git", "checkout", "main"], repoDir);
  must(["git", "merge", "--squash", "candidate"], repoDir);
  must(["git", "commit", "-m", "Squash feature"], repoDir);
  must(["git", "push", "origin", "main"], repoDir);
  const merged = must(["git", "rev-parse", "HEAD"], repoDir);
  const verifier = path.join(dir, "separate-clone");
  must(["git", "clone", "--no-local", "--single-branch", "--branch", "main", origin, verifier]);
  assert.notEqual(exec(["git", "cat-file", "-e", candidate], verifier).code, 0);
  task.spec.repo = verifier; task.integrationBase = fixed;
  pr.head.sha = candidate; pr.merge_commit_sha = merged; reviewHead = candidate;
  // Task-owned commands may provision ignored dependencies before testing.
  task.spec.checks = [
    [process.execPath, "-e", "require('fs').writeFileSync('prepared-dependency', 'ready')"],
    [process.execPath, "-e", "require('assert').equal(require('fs').readFileSync('prepared-dependency','utf8'), 'ready')"],
    [process.execPath, "verify.cjs"],
  ];
  const squashProof = await verifyCompletion(task, 1, 1, path.join(dir, "squashed"), call);
  assert.equal(squashProof.head, candidate);
  assert.equal(squashProof.merge, merged);
  assert.equal(squashProof.checks.length, 3);
  assert.equal(fs.existsSync(path.join(dir, "squashed", "worktree-token")), false);
  assert.ok(!must(["git", "worktree", "list", "--porcelain"], verifier).includes("worktree-token"));
});

test("the integration base is read from the real base branch, and every gap fails closed", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-base-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const repoDir = path.join(dir, "repo");
  const exec = (argv: string[], cwd?: string) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", timeout: 10_000 });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const must = (argv: string[], cwd?: string) => { const r = exec(argv, cwd); assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); };
  must(["git", "init", "--bare", "--initial-branch=main", origin]);
  must(["git", "clone", origin, repoDir]);
  for (const [key, value] of [["user.name", "Gru Test"], ["user.email", "gru@example.invalid"]]) must(["git", "config", key, value], repoDir);
  const land = (message: string, cwd = repoDir) => {
    fs.writeFileSync(path.join(cwd, "feature.txt"), message + "\n");
    must(["git", "add", "feature.txt"], cwd); must(["git", "commit", "-m", message], cwd);
    must(["git", "push", "origin", "HEAD:main"], cwd);
    return must(["git", "rev-parse", "HEAD"], cwd);
  };
  // Only origin identity is mocked: the local clone's origin is a path, and Gru requires
  // an owner/repo remote. Every other git fact in this test is the real repository's.
  const call: Command = async (argv, cwd) => argv[0] === "git" && argv[1] === "remote"
    ? { code: 0, stdout: "git@github.com:Owner/Repo.git", stderr: "" } : exec(argv, cwd);
  const task = assignment(); task.spec.repo = repoDir; task.spec.repositoryKey = "owner/repo";

  // Origin has no commits yet, so it reports no default branch at all. Refuse and name the
  // repair rather than guessing one; the branch is resolved before the SHA is ever read.
  await assert.rejects(observeBase(task, "a".repeat(40), [], undefined, call), /origin reports no default branch.*--base-ref/s);
  const first = land("first task merged");

  // The local refs/remotes/origin/HEAD is written at clone and then only by an explicit
  // `git remote set-head`, so it can name a branch origin stopped defaulting to long ago.
  // Point it at a frozen branch: reading the name from ORIGIN must still yield `main`.
  // Reading it locally would compare every base against a branch nobody merges into, which
  // passes each one as "the current tip" — the guard off while every message reports it on.
  must(["git", "push", "origin", `${first}:refs/heads/stale-default`], repoDir);
  must(["git", "fetch", "-q", "origin"], repoDir);
  must(["git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/stale-default"], repoDir);
  const current = await observeBase(task, first, [], undefined, call);
  assert.deepEqual(current, { observedAt: current.observedAt, repositoryKey: "owner/repo", ref: "main",
    tip: first, base: first, contains: [], checks: [...BASE_CHECKS] });
  assert.ok(Date.now() - Date.parse(current.observedAt) < 60_000);

  // A SHA of the right shape that this repository does not hold — a foreign repo's tip, or a typo.
  await assert.rejects(observeBase(task, "f".repeat(40), [], undefined, call), /integration base f{40} is not a commit in owner\/repo/);
  await assert.rejects(observeBase(task, "not-a-sha", [], undefined, call), /integration requires an observed base SHA/);
  // A tree object has the right shape and IS in the repository; only a commit can be a base.
  const tree = must(["git", "rev-parse", "HEAD^{tree}"], repoDir);
  await assert.rejects(observeBase(task, tree, [], undefined, call), /is not a commit in owner\/repo/);
  const foreign = { ...task, spec: { ...task.spec, repositoryKey: "other/repo" } };
  await assert.rejects(observeBase(foreign, first, [], undefined, call), /repository mismatch: .* is owner\/repo, not other\/repo/);

  // Another task's merge lands on origin while this one is in review: the grant's base is now stale.
  const second = path.join(dir, "second-worker");
  must(["git", "clone", origin, second]);
  for (const [key, value] of [["user.name", "Gru Test"], ["user.email", "gru@example.invalid"]]) must(["git", "config", key, value], second);
  const landed = land("second task merged", second);
  const stale = await observeBase(task, first, [], undefined, call);
  assert.equal(stale.tip, landed);
  assert.equal(stale.base, first);
  assert.notEqual(stale.tip, stale.base);
  // The observation fetched the new tip without the worker's checkout ever fetching it.
  assert.equal(must(["git", "rev-parse", "HEAD"], repoDir), first);

  // Ancestry is reported per verified merge: present-and-contained, present-and-not, and absent.
  const refreshed = await observeBase(task, landed, [first, landed, "f".repeat(40)], undefined, call);
  assert.deepEqual(refreshed.contains, [first, landed]);
  assert.deepEqual((await observeBase(task, first, [landed], undefined, call)).contains, []);

  // An explicitly named branch is fetched instead of the default one.
  must(["git", "push", "origin", `${first}:refs/heads/release`], repoDir);
  const release = await observeBase(task, first, [], "release", call);
  assert.equal(release.ref, "release");
  assert.equal(release.tip, first);
  await assert.rejects(observeBase(task, landed, [], "no-such-branch", call), /cannot fetch refs\/heads\/no-such-branch from origin/);
  await assert.rejects(observeBase(task, landed, [], "bad branch", call), /invalid base branch name "bad branch"/);

  // Nothing above left an invocation-owned ref behind, including the refused fetches.
  assert.equal(must(["git", "for-each-ref", "--format=%(refname)", "refs/gru"], repoDir), "");

  // Cleanup that throws is noise, not a verdict: an unguarded `await` in the `finally` would
  // hand the operator the ref-deletion failure instead of the reason the base was refused.
  // Both paths through the `finally` are covered — the refusal, and the successful gather.
  const cleanupThrows: Command = async (argv, cwd) => {
    if (argv[0] === "git" && argv[1] === "update-ref") throw new Error("simulated cleanup transport failure");
    return call(argv, cwd);
  };
  await assert.rejects(observeBase(task, "f".repeat(40), [], undefined, cleanupThrows), /is not a commit in owner\/repo/);
  assert.equal((await observeBase(task, landed, [], undefined, cleanupThrows)).tip, landed);

  // A shallow clone cannot answer containment at all: fetch honours the existing depth, so a
  // merge outside it is either absent (`merge-base --is-ancestor` exits 128) or present with
  // the graft cutting the walk (exit 1, indistinguishable from an honest "not contained").
  // Either reading refuses forever with "fetch again and grant at the tip" — advice that
  // cannot work. One probe up front, before either reading exists; name the clone, not a merge.
  const shallowDir = path.join(dir, "shallow");
  must(["git", "clone", "--depth", "1", `file://${origin}`, shallowDir]);
  const shallowTask = { ...task, spec: { ...task.spec, repo: shallowDir } };
  const shallowTip = must(["git", "rev-parse", "HEAD"], shallowDir);
  assert.equal(must(["git", "rev-parse", "--is-shallow-repository"], shallowDir), "true");
  await assert.rejects(observeBase(shallowTask, shallowTip, [first], undefined, call),
    new RegExp(`cannot compare verified merge ${first} against ${shallowTip}: .*shallow clone.*--unshallow`));
  // The merge the shallow clone DOES hold is the case a per-comparison probe misses: it exits
  // 0, so the old reading recorded a clean containment in a repository whose remaining
  // comparisons it could not have answered. The probe is per repository, not per merge.
  await assert.rejects(observeBase(shallowTask, shallowTip, [shallowTip], undefined, call),
    new RegExp(`cannot compare verified merge ${shallowTip} against ${shallowTip}: .*shallow clone.*--unshallow`));
  // With no merges to compare there is nothing the depth can hide, so a shallow clone still grants.
  assert.equal((await observeBase(shallowTask, shallowTip, [], undefined, call)).tip, shallowTip);
  // A complete clone keeps the old reading: an object it does not hold cannot be in the base's
  // history either, so it is simply reported as not contained.
  assert.deepEqual((await observeBase(task, landed, ["f".repeat(40)], undefined, call)).contains, []);

  // Both round trips are bounded by half the freshness window, and BOTH say so. An unexplained
  // `git exited 124` from the symref read would send the operator hunting a git bug.
  const timedOutAt = (verb: string): Command => async (argv, cwd, timeoutMs) => argv[0] === "git" && argv[1] === verb
    ? { code: 124, stdout: "", stderr: "", timedOut: true } : call(argv, cwd, timeoutMs);
  await assert.rejects(observeBase(task, landed, [], undefined, timedOutAt("ls-remote")),
    /cannot read origin's default branch .*timed out after 30s, the freshness budget/s);
  await assert.rejects(observeBase(task, landed, [], "main", timedOutAt("fetch")),
    /cannot fetch refs\/heads\/main from origin .*timed out after 30s, the freshness budget/s);

  // Only the network calls carry that budget; the ancestry comparisons run on the default
  // command timeout. Evidence that outlived the store's window must fail as the slow
  // observation it was, not come back for the store to reject with "fetch the base branch
  // again" — the same loop the budget exists to prevent, blamed on the wrong command.
  const slow: Command = async (argv, cwd, timeoutMs) => {
    const result = await call(argv, cwd, timeoutMs);
    if (argv[0] === "git" && argv[1] === "merge-base") t.mock.timers.tick(61_000);
    return result;
  };
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    await assert.rejects(observeBase(task, landed, [first], undefined, slow), /past the 60s window the store accepts/);
  } finally { t.mock.timers.reset(); }

  // An unreachable origin refuses; it never falls back to a local ref that reads as current.
  // Both round trips are covered: resolving the default branch name, and fetching the tip.
  fs.renameSync(origin, path.join(dir, "origin-moved.git"));
  await assert.rejects(observeBase(task, landed, [], undefined, call), /cannot read origin's default branch/);
  await assert.rejects(observeBase(task, landed, [], "main", call), /cannot fetch refs\/heads\/main from origin/);
});
