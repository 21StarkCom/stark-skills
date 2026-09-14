import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalRepository, observations, observeWorkers, packet, receive, retireWorker, verifyCompletion, workerFromPeer, type Command, type HermodPeer } from "./gru_runtime_lib.ts";
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
    return response({ peers: [{ ...peer(), activity }], observedAt: new Date().toISOString(), incomplete: false });
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
  const task = assignment(); task.spec.repo = repoDir; task.integrationBase = sha;
  const pr = { merged: true, merged_at: new Date().toISOString(), merge_commit_sha: sha,
    head: { sha, repo: { full_name: "owner/repo" } }, base: { ref: "main", repo: { full_name: "owner/repo" } }, html_url: "https://github.com/owner/repo/pull/1" };
  let reviewHead = sha;
  const call: Command = async (argv, cwd) => {
    if (argv[0] === "git" && argv[1] === "remote") return { code: 0, stdout: "git@github.com:owner/repo.git", stderr: "" };
    if (argv[0] === "gh") return response(argv[2].includes("reviews") ? { commit_id: reviewHead, submitted_at: new Date().toISOString(), state: "COMMENTED", html_url: pr.html_url + "#pullrequestreview-1" } : pr);
    if (argv[0] === "alfred") return response({ item: { ref: { custom_id: "STARK-100" }, state: "done" }, comments: [], comments_read: true });
    return exec(argv, cwd);
  };
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "failed-check"), call), /independent check failed/);
  const failedLogs = fs.readdirSync(path.join(dir, "failed-check")).filter(f => f.endsWith(".log"));
  const observed = JSON.parse(fs.readFileSync(path.join(dir, "failed-check", failedLogs[0]), "utf8"));
  assert.equal(observed.code, 7);
  assert.notEqual(observed.cwd, task.spec.worktree);
  reviewHead = "b".repeat(40);
  await assert.rejects(verifyCompletion(task, 1, 1, path.join(dir, "stale-review"), call), /does not cover/);
  assert.equal(fs.existsSync(path.join(dir, "stale-review")), false);
  fs.writeFileSync(path.join(repoDir, "verify.cjs"), "console.log('behavior verified');\n");
  must(["git", "add", "verify.cjs"], repoDir);
  must(["git", "commit", "-m", "Fix behavior"], repoDir);
  must(["git", "push", "origin", "main"], repoDir);
  const fixed = must(["git", "rev-parse", "HEAD"], repoDir);
  pr.head.sha = fixed; pr.merge_commit_sha = fixed; reviewHead = fixed;
  const proof = await verifyCompletion(task, 1, 1, path.join(dir, "passing-check"), call);
  assert.equal(proof.merge, fixed);
  assert.equal(proof.head, fixed);
  assert.equal(proof.checks[0].exitCode, 0);
  assert.match(fs.readFileSync(proof.checks[0].log, "utf8"), /behavior verified/);
});
