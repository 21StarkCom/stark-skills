import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalRepository, checkLeadershipTransfer, discoverWorker, interruptWorker, observations, observeWorkers, packet, receive, retireWorker, verifyCompletion, workerFromPeer, type Command, type HermodPeer } from "./gru_runtime_lib.ts";
import type { Assignment, Run } from "./gru_lib.ts";

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

test("Hermod discovery omissions and stale hooks never prove death", () => {
  const d = { peers: [peer()], observedAt: new Date().toISOString(), incomplete: false };
  assert.equal(observations(run(), d).task.liveness, "live");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), cwd: "/worktree/" }] }).task.liveness, "live");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), cwd: undefined }] }).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, incomplete: true }).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, peers: [] }).task.liveness, "unknown");
  assert.equal(observations(run(), { ...d, peers: [{ ...peer(), liveness: "stale" }] }).task.liveness, "unknown");
  const saved = [{ sessionId: "session", agent: "codex", surfaceId: "surface", pid: 42, alive: false }];
  assert.equal(observations(run(), { ...d, peers: [] }, saved).task.liveness, "dead");
  assert.equal(observations(run(), d, saved).task.liveness, "live");
  const unassigned = run(); delete unassigned.tasks[0].worker;
  const malformed = JSON.parse('[{"agent":"codex","alive":false,"pid":42}]');
  assert.equal(observations(unassigned, { ...d, peers: [] }, malformed).task.liveness, "unknown");
});

test("local PID absence cannot override incomplete Hermod identity evidence", async () => {
  const r = run(); r.tasks[0].worker!.pid = 999999999;
  const result = await observeWorkers(r, async argv => response(argv[1] === "sessions"
    ? { sessions: [], totalMatches: 0 }
    : { peers: [], observedAt: new Date().toISOString(), incomplete: false }));
  assert.equal(result.task.liveness, "unknown");
});

test("dispatch packet uses the selected runtime and retains the full objective and limits", () => {
  const r = run();
  const brief = packet(r, r.tasks[0]);
  assert.ok(brief.startsWith("Run $team-minion-agent"));
  assert.ok(brief.includes(r.tasks[0].spec.objective));
  assert.ok(brief.includes("No new tickets"));
  r.tasks[0].spec.provider = "claude";
  assert.ok(packet(r, r.tasks[0]).startsWith("Run /team-minion-agent"));
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
  assert.equal(fs.existsSync(path.join(dir, "passing-check", "worktree-token")), false);

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
