import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalRepository, checkLeadershipTransfer, command, DEFAULT_CHECK_TIMEOUT_MS, discoverWorker, interruptWorker, observations, observeWorkers, packet, receive, retireWorker, verifyCompletion, workerFromPeer, type Command, type HermodPeer } from "./gru_runtime_lib.ts";
import type { Assignment, Engagement, Run } from "./gru_lib.ts";

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
  // Hermod exits 4/5 for failed/uncertain records while still printing them: a verdict, not a transport error.
  await assert.rejects(receive(run(), messageId, async () => ({ ...response({ ...record, state: "uncertain" }), code: 5 })), /not confirmed/);
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
