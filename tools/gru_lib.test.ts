import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { observations, observeOrphan, observeWorkers, packet, type Command, type HermodPeer } from "./gru_runtime_lib.ts";
import { ADOPTION_CHECKS, GruStore, parseEngagement, parseTakeover, readyReason, verificationReady, type CompletionEvidence, type Engagement, type Run, type Worker, type WorktreeAdoption } from "./gru_lib.ts";

// Compose the production observation builders with the store: a handwritten "dead"
// observation would miss the orphaned-record failure that prompted STARK-5021.
const absentHermod: Command = async argv => argv[0] === "ps" ? { code: 1, stdout: "", stderr: "" } : ({ code: 0, stderr: "", stdout: JSON.stringify(
  argv[1] === "msg" ? { peers: [], observedAt: new Date().toISOString(), incomplete: false }
    : argv[1] === "sessions" ? { sessions: [], totalMatches: 0 } : []) });
const takeoverRequest = (r: Run) => ({ run: r.config.id, task: "one", token: r.tasks[0].token!, revision: r.revision,
  operatorRequest: "Replace the orphaned worker with a fresh Claude Minion; retain the launch budget.",
  provider: "claude" as const, worktree: "/worktrees/fresh-takeover", limits: ["Fresh Claude Minion; preserve the existing scope and budgets"] });
async function orphanedRun(t: TestContext, integrating = false) {
  const { store, file } = fixture(t);
  const c = config(); c.tasks = c.tasks.slice(0, 1);
  let r = observe(store, store.create(c));
  r = store.reserve(c.id, c.leader, r.revision, "one");
  r = store.attach(c.id, c.leader, r.revision, "one", r.tasks[0].token!, { ...worker("one"), pid: 42 });
  r = report(store, r, "one", "ack");
  r = report(store, r, "one", "ready", "Existing draft PR 1075; inspect before editing");
  if (integrating) r = store.integrate(c.id, c.leader, r.revision, "one", r.tasks[0].token!, "a".repeat(40));
  r = store.reconcile(c.id, c.leader, r.revision, await observeWorkers(r, absentHermod));
  return { store, file, r };
}

test("explicit orphan takeover preserves unknown evidence, PR, budget and merge ownership, and fences old reports", async t => {
  const { store, file, r } = await orphanedRun(t, true);
  assert.equal(r.tasks[0].observation!.liveness, "unknown");
  assert.throws(() => store.recover("demo", "leader-one", r.revision, "one", r.tasks[0].token!), /unknown is not dead/);
  const request = takeoverRequest(r);
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  let next = store.takeover("demo", "leader-one", r.revision, "one", request.token, request, evidence);
  assert.equal(next.tasks[0].phase, "pending");
  assert.equal(next.tasks[0].attempts, 1);
  assert.equal(next.tasks[0].recoveries, 0);
  assert.ok(next.tasks[0].token && next.tasks[0].token !== request.token);
  assert.equal(next.tasks[0].worker, undefined);
  assert.equal(next.tasks[0].integrationBase, "a".repeat(40));
  assert.equal(next.tasks[0].report?.message, r.tasks[0].report?.message);
  assert.deepEqual(next.tasks[0].takeovers![0].previousObservation, r.tasks[0].observation);
  assert.equal(next.config.tasks[0].provider, "claude");
  assert.equal(next.tasks[0].spec.provider, "claude");
  assert.deepEqual(next.config.limits, request.limits);
  assert.match(next.events.at(-1)!.detail, /Replace the orphaned worker/);
  assert.throws(() => store.report("demo", "leader-one", next.revision, "one", request.token,
    worker("one").session, "ready", "old report"), /stale assignment token/);
  const reopened = new GruStore(file); t.after(() => reopened.close());
  assert.deepEqual(reopened.read("demo").tasks[0].takeovers, next.tasks[0].takeovers);
  next = store.reserve("demo", "leader-one", next.revision, "one");
  assert.equal(next.tasks[0].attempts, 2);
  assert.match(packet(next, next.tasks[0]), /Existing draft PR 1075/);
  const freshWorker = { ...worker("new"), provider: "claude" as const, id: "claude:new", worktree: request.worktree };
  assert.throws(() => store.attach("demo", "leader-one", next.revision, "one", next.tasks[0].token!,
    { ...freshWorker, session: worker("one").session }), /fenced worker/);
  next = store.attach("demo", "leader-one", next.revision, "one", next.tasks[0].token!, freshWorker);
  assert.equal(next.tasks[0].phase, "intake");
  assert.equal(verificationReady(next.tasks[0]), false);
  assert.throws(() => store.complete("demo", "leader-one", next.revision, "one", next.tasks[0].token!, landedProof(next)), /integration/);
  // A second run still cannot appropriate either the old tree or the merge lock.
  const other = config(); other.id = "other"; other.tasks = [other.tasks[1]];
  other.tasks[0].worktree = worker("one").worktree;
  let second = observe(store, store.create(other));
  assert.throws(() => store.reserve("other", "leader-one", second.revision, "two"), /resource already owned/);
});

test("takeover refuses stale or mismatched authority and evidence without changing state", async t => {
  const { store, r } = await orphanedRun(t);
  const request = takeoverRequest(r);
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  const binding = /does not match the current assignment revision/;
  const requests: [Record<string, unknown>, RegExp][] = [
    [{ ...request, run: "another" }, binding], [{ ...request, task: "two" }, binding],
    [{ ...request, token: "old" }, binding], [{ ...request, revision: r.revision - 1 }, binding],
    [{ ...request, operatorRequest: " " }, /operatorRequest is required/],
    [{ ...request, maxAttempts: 99 }, /unknown takeover request field/],
    [{ ...request, worktree: r.tasks[0].spec.worktree }, /evidence worktree mismatch/],
  ];
  for (const [changed, reason] of requests) {
    assert.throws(() => store.takeover("demo", "leader-one", r.revision, "one", request.token, changed, evidence), reason);
    assert.equal(store.read("demo").revision, r.revision);
  }
  // Evidence gathered for the old checkout or the repo itself passes the mismatch guard
  // above; the isolation guard must still refuse it.
  for (const reused of [r.tasks[0].spec.worktree, r.tasks[0].spec.repo]) {
    const reusedEvidence = await observeOrphan(r.tasks[0], reused, absentHermod);
    assert.throws(() => store.takeover("demo", "leader-one", r.revision, "one", request.token,
      { ...request, worktree: reused }, reusedEvidence), /fresh isolated worktree/);
    assert.equal(store.read("demo").revision, r.revision);
  }
  assert.throws(() => store.takeover("demo", "not-leader", r.revision, "one", request.token, request, evidence), /stale leader/);
  assert.throws(() => store.takeover("demo", "leader-one", r.revision - 1, "one", request.token, request, evidence), /stale revision/);
  const proofs: [typeof evidence, RegExp][] = [
    [{ ...evidence, checks: [] }, /incomplete orphan evidence/],
    [{ ...evidence, worker: { ...evidence.worker, session: "other" } }, /evidence worker mismatch/],
    [{ ...evidence, observedAt: new Date(Date.now() - 120_000).toISOString() }, /stale/],
    [{ ...evidence, replacementWorktree: "/elsewhere" }, /evidence worktree mismatch/],
  ];
  for (const [bad, reason] of proofs) {
    assert.throws(() => store.takeover("demo", "leader-one", r.revision, "one", request.token, request, bad), reason);
    assert.equal(store.read("demo").revision, r.revision);
  }
  assert.throws(() => parseTakeover({ ...request, worktree: "relative" }), /absolute/);
});

test("pending takeover retains file ownership across engagements without blocking its own reserve", async t => {
  const { store, r } = await orphanedRun(t);
  const request = takeoverRequest(r);
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  const pending = store.takeover("demo", "leader-one", r.revision, "one", request.token, request, evidence);
  const c = config(); c.id = "competitor"; c.tasks = [c.tasks[1]];
  c.tasks[0].files = [...r.tasks[0].spec.files];
  const other = observe(store, store.create(c));
  assert.match(store.readyReason(other, other.tasks[0]) ?? "", /file ownership conflicts/);
  assert.throws(() => store.reserve(c.id, c.leader, other.revision, "two"), /file ownership conflicts/);
  assert.equal(store.readyReason(pending, pending.tasks[0]), null);
  assert.equal(store.reserve("demo", "leader-one", pending.revision, "one").tasks[0].phase, "reserved");
});

test("pending takeover retains same-run scope until its inherited merge is verified", async t => {
  const { store } = fixture(t);
  const c = config(); c.tasks = c.tasks.slice(0, 2);
  c.tasks[1].files = [...c.tasks[0].files];
  let r = observe(store, store.create(c));
  r = store.reserve(c.id, c.leader, r.revision, "one");
  r = store.attach(c.id, c.leader, r.revision, "one", r.tasks[0].token!, { ...worker("one"), pid: 42 });
  r = report(store, r, "one", "ack"); r = report(store, r, "one", "ready");
  r = store.integrate(c.id, c.leader, r.revision, "one", r.tasks[0].token!, BASE);
  r = store.reconcile(c.id, c.leader, r.revision, await observeWorkers(r, absentHermod));
  const { limits: _limits, ...request } = takeoverRequest(r);
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  let next = store.takeover(c.id, c.leader, r.revision, "one", request.token, request, evidence);
  assert.match(store.readyReason(next, next.tasks[1]) ?? "", /file ownership conflicts with one/);
  assert.equal(store.readyReason(next, next.tasks[0]), null);
  next = store.complete(c.id, c.leader, next.revision, "one", next.tasks[0].token!, landedProof(next));
  assert.equal(store.readyReason(next, next.tasks[1]), null);
  assert.equal(store.reserve(c.id, c.leader, next.revision, "two").tasks[1].phase, "reserved");
});

test("takeover transaction refuses a path occupied after the absence observation", async t => {
  const { store, file, r } = await orphanedRun(t);
  const request = { ...takeoverRequest(r), worktree: path.join(path.dirname(file), "replacement") };
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  fs.mkdirSync(request.worktree);
  assert.throws(() => store.takeover("demo", "leader-one", r.revision, "one", request.token, request, evidence), /absent worktree/);
  assert.deepEqual(store.read("demo"), r);
});

test("a previously stopped orphan can be taken over after resume and fresh reconciliation", async t => {
  const { store, r } = await orphanedRun(t);
  let next = store.stop("demo", "leader-one", r.revision);
  next = observe(store, next, "live");
  next = store.stopped("demo", "leader-one", next.revision, "one", next.tasks[0].token!);
  next = store.resume("demo", "leader-one", next.revision, "leader-one");
  next = store.reconcile("demo", "leader-one", next.revision, await observeWorkers(next, absentHermod));
  const request = takeoverRequest(next);
  const evidence = await observeOrphan(next.tasks[0], request.worktree, absentHermod);
  const pending = store.takeover("demo", "leader-one", next.revision, "one", request.token, request, evidence);
  assert.equal(pending.tasks[0].phase, "pending");
  assert.equal(pending.tasks[0].takeovers![0].previousObservation!.liveness, "unknown");
  assert.equal(pending.tasks[0].attempts, next.tasks[0].attempts);
});

test("takeover is not a budget reset, a retry of uncertain startup, or a limits rewrite for unrelated tasks", async t => {
  const { store, r } = await orphanedRun(t);
  const request = takeoverRequest(r);
  const evidence = await observeOrphan(r.tasks[0], request.worktree, absentHermod);
  let next = store.takeover("demo", "leader-one", r.revision, "one", request.token, request, evidence);
  next = store.reserve("demo", "leader-one", next.revision, "one");
  assert.throws(() => store.takeover("demo", "leader-one", next.revision, "one", next.tasks[0].token!,
    takeoverRequest(next), evidence), /attached assignment/);
  next = store.attach("demo", "leader-one", next.revision, "one", next.tasks[0].token!,
    { ...worker("new"), id: "claude:new", provider: "claude", worktree: request.worktree, pid: 43 });
  next = store.reconcile("demo", "leader-one", next.revision, await observeWorkers(next, absentHermod));
  assert.throws(() => store.takeover("demo", "leader-one", next.revision, "one", next.tasks[0].token!,
    { ...takeoverRequest(next), worktree: "/yet-another" }, evidence), /budget exhausted/);
  const { store: another, r: old } = await orphanedRun(t);
  let dead = observe(another, old, "dead");
  dead = another.beginReconnect("demo", "leader-one", dead.revision, "one", dead.tasks[0].token!);
  dead = another.reconcile("demo", "leader-one", dead.revision, await observeWorkers(dead, absentHermod));
  assert.throws(() => another.takeover("demo", "leader-one", dead.revision, "one", dead.tasks[0].token!,
    takeoverRequest(dead), evidence), /unsettled reconnect/);
  const c = config(); c.id = "multi";
  let multi = start(another, observe(another, another.create(c)), "two");
  multi = observe(another, multi, "unknown");
  const multiRequest = { ...takeoverRequest(multi), task: "two", token: multi.tasks[1].token! };
  assert.throws(() => another.takeover("multi", "leader-one", multi.revision, "two", multiRequest.token,
    multiRequest, { ...evidence, worker: multi.tasks[1].worker! }), /single-task/);
});

const config = (): Engagement => ({ id: "demo", objective: "Implement independent tasks, then integrate",
  leader: "leader-one", maxWorkers: 2, maxAttempts: 2, maxRecoveries: 2,
  limits: ["No publishing, authentication, infrastructure changes, or extra tickets"],
  tasks: ["one", "two", "dependent"].map((id, i) => ({ id, ticket: `STARK-${100 + i}`,
    objective: `Implement ${id}`, repo: "/repo", worktree: `/worktrees/${id}`, provider: "codex",
    dependsOn: i === 2 ? ["one"] : [], files: [`src/${id}.ts`], exclusiveResources: [],
    mergeResources: ["release-index"], doneWhen: `${id} behaves as specified`, checks: [["node", "--test", `${id}.test.ts`]] })) });
const worker = (id: string): Worker => ({ id: `codex:${id}`, session: `session-${id}`,
  surface: `surface-${id}`, workspace: "workspace", provider: "codex", worktree: `/worktrees/${id}` });
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gru-test-"));
  const file = path.join(dir, "state.sqlite");
  const store = new GruStore(file);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, file };
}
function observe(store: GruStore, run: Run, live: "live" | "dead" | "unknown" = "live") {
  return store.reconcile(run.config.id, run.config.leader, run.revision, Object.fromEntries(run.tasks.map(t => [t.spec.id,
    { observedAt: new Date().toISOString(), liveness: live, activity: "idle", evidence: live === "unknown" ? [] : ["Hermod observation"] }])));
}
function start(store: GruStore, run: Run, id: string): Run {
  run = store.reserve(run.config.id, run.config.leader, run.revision, id);
  const token = run.tasks.find(t => t.spec.id === id)!.token!;
  return store.attach(run.config.id, run.config.leader, run.revision, id, token, worker(id));
}
function report(store: GruStore, run: Run, id: string, kind: "ack" | "ready" | "complete" | "blocked", message?: string): Run {
  const task = run.tasks.find(t => t.spec.id === id)!;
  return store.report(run.config.id, run.config.leader, run.revision, id, task.token!, worker(id).session, kind, message ?? task.spec.doneWhen);
}
/** Drive an attached task through ack, ready, integrate, and verified completion. */
function finish(store: GruStore, run: Run, id: string): Run {
  run = report(store, run, id, "ack"); run = report(store, run, id, "ready");
  const base = "a".repeat(40);
  run = store.integrate(run.config.id, run.config.leader, run.revision, id, run.tasks.find(t => t.spec.id === id)!.token!, base);
  const task = run.tasks.find(t => t.spec.id === id)!;
  const evidence: CompletionEvidence = { head: "b".repeat(40), base, merge: "c".repeat(40), pr: "https://github.com/o/r/pull/1",
    review: "https://github.com/o/r/pull/1#pullrequestreview-1", verifiedAt: new Date().toISOString(), ticketState: "done",
    checks: task.spec.checks.map((argv, i) => ({ argv, exitCode: 0, log: `/evidence/check-${i}.log` })) };
  return store.complete(run.config.id, run.config.leader, run.revision, id, task.token!, evidence);
}
const BASE = "a".repeat(40);
/** Drive task `one` to an integration grant, then lose its worker to a replacement. */
function grantThenLoseWorker(store: GruStore): Run {
  const c = config(); c.maxRecoveries = 0;
  let run = start(store, observe(store, store.create(c)), "one");
  run = report(store, run, "one", "ack"); run = report(store, run, "one", "ready");
  run = store.integrate("demo", "leader-one", run.revision, "one", run.tasks[0].token!, BASE);
  run = observe(store, run, "dead");
  return store.recover("demo", "leader-one", run.revision, "one", run.tasks[0].token!);
}
const landedProof = (run: Run): CompletionEvidence => ({ base: BASE, head: "b".repeat(40), merge: "c".repeat(40),
  pr: "https://github.com/o/r/pull/1", review: "https://github.com/o/r/pull/1#pullrequestreview-1",
  verifiedAt: new Date().toISOString(), ticketState: "done",
  checks: run.tasks[0].spec.checks.map(argv => ({ argv, exitCode: 0, log: "/evidence/check.log" })) });

/** Runtime evidence for a linked worktree of /repo, as `inspectAdoption` would record it. */
const adoptionProof = (observed: string, declared: string, repositoryKey: string): WorktreeAdoption => ({
  observedAt: new Date().toISOString(), declared, observed, toplevel: observed,
  gitDir: `/repo/.git/worktrees/${path.basename(observed)}`, commonDir: "/repo/.git",
  repositoryKey, branch: "worktree-STARK-100", checks: [...ADOPTION_CHECKS] });

test("attachment recognizes a symlink alias of the reserved worktree", t => {
  const { store, file } = fixture(t);
  const target = path.join(path.dirname(file), "worktree");
  const alias = path.join(path.dirname(file), "alias");
  fs.mkdirSync(target); fs.symlinkSync(target, alias);
  const c = config(); c.tasks[0].worktree = fs.realpathSync(target);
  let run = observe(store, store.create(c));
  run = store.reserve(c.id, c.leader, run.revision, "one");
  run = store.attach(c.id, c.leader, run.revision, "one", run.tasks[0].token!, { ...worker("one"), worktree: alias });
  assert.equal(run.tasks[0].worker!.worktree, c.tasks[0].worktree);
});

test("attach adopts only fresh, complete evidence for an undeclared, unowned same-repository worktree", t => {
  const { store } = fixture(t);
  const observed = "/repo/.claude/worktrees/STARK-100";
  const c = config(); c.tasks.forEach(task => { task.repositoryKey = "o/r"; });
  let run = observe(store, store.create(c));
  run = store.reserve("demo", "leader-one", run.revision, "one");
  const token = run.tasks[0].token!;
  const moved = { ...worker("one"), worktree: observed };
  const proof = (at = observed) => adoptionProof(at, "/worktrees/one", "o/r");
  const refusals: [Worker, WorktreeAdoption | undefined, RegExp][] = [
    [moved, undefined, /worker worktree mismatch$/],
    [moved, { ...proof(), checks: ADOPTION_CHECKS.slice(1) }, /incomplete/],
    [moved, { ...proof(), observedAt: new Date(Date.now() - 120_000).toISOString() }, /stale/],
    [moved, { ...proof(), observed: "/repo/.claude/worktrees/other" }, /evidence mismatch/],
    [moved, { ...proof(), declared: "/worktrees/two" }, /evidence mismatch/],
    [moved, { ...proof(), toplevel: "/repo/.claude" }, /not a worktree root/],
    [moved, { ...proof(), gitDir: "/repo/.git" }, /not a linked worktree/],
    [moved, { ...proof(), repositoryKey: "o/other" }, /belongs to o\/other/],
    [{ ...moved, worktree: "/repo/.claude/worktrees/STARK-1000" }, { ...proof("/repo/.claude/worktrees/STARK-1000"), branch: "STARK-1000" }, /does not name STARK-100/],
    [{ ...moved, worktree: "/repo" }, proof("/repo"), /isolated worktree/],
    [{ ...moved, worktree: "/worktrees/two" }, { ...proof("/worktrees/two"), branch: "STARK-100" }, /declared by STARK-101/],
  ];
  for (const [candidate, evidence, reason] of refusals) {
    assert.throws(() => store.attach("demo", "leader-one", run.revision, "one", token, candidate, evidence), reason);
  }
  // Another engagement declaring the path blocks adoption even before it reserves anything.
  const other = config(); other.id = "other"; other.tasks = [{ ...other.tasks[1], worktree: observed }];
  store.create(other);
  assert.throws(() => store.attach("demo", "leader-one", run.revision, "one", token, moved, proof()), /declared by STARK-101/);
  assert.equal(store.read("demo").revision, run.revision);
  assert.equal(store.read("demo").tasks[0].phase, "reserved");
});

test("an adopted worktree replaces the declared one in the spec and is owned against later engagements", t => {
  const { store } = fixture(t);
  const observed = "/repo/.claude/worktrees/STARK-100";
  const c = config(); c.tasks.forEach(task => { task.repositoryKey = "o/r"; });
  let run = observe(store, store.create(c));
  run = store.reserve("demo", "leader-one", run.revision, "one");
  const evidence = adoptionProof(observed, "/worktrees/one", "o/r");
  const launched = run.tasks[0].token!;
  run = store.attach("demo", "leader-one", run.revision, "one", launched, { ...worker("one"), worktree: observed }, evidence);
  assert.equal(run.tasks[0].phase, "intake");
  assert.equal(run.tasks[0].worker!.worktree, observed);
  assert.equal(run.tasks[0].spec.worktree, observed);
  assert.equal(run.config.tasks[0].worktree, observed);
  // The launch brief named the declared path under the old token; only the fresh packet works.
  assert.ok(run.tasks[0].token && run.tasks[0].token !== launched);
  assert.throws(() => store.report("demo", "leader-one", run.revision, "one", launched, worker("one").session, "ack", "one behaves as specified"), /stale assignment token/);
  const brief = packet(run, run.tasks[0]);
  assert.match(brief, new RegExp(`Work only in ${observed}\\.`));
  assert.ok(brief.includes(`token: ${run.tasks[0].token}`));
  const audit = run.events.find(e => e.kind === "worktree-adopted")!;
  assert.deepEqual(JSON.parse(audit.detail), { ...evidence, token: run.tasks[0].token });
  // The adopted path is now reserved: a later engagement cannot claim it.
  const later = config(); later.id = "later"; later.tasks = [{ ...later.tasks[1], worktree: observed }];
  const next = observe(store, store.create(later));
  assert.throws(() => store.reserve("later", "leader-one", next.revision, "two"), new RegExp(`resource already owned: tree:${observed}`));
});

test("adoption never rebinds a takeover replacement into the fenced orphan's worktree, nor the leader as its own worker", async t => {
  const { store, r } = await orphanedRun(t);
  const request = takeoverRequest(r);
  let next = store.takeover("demo", "leader-one", r.revision, "one", request.token, request,
    await observeOrphan(r.tasks[0], request.worktree, absentHermod));
  next = store.reserve("demo", "leader-one", next.revision, "one");
  const token = next.tasks[0].token!;
  // Claude's `--worktree=<ticket>` re-attaches to the orphan's existing checkout; its tree is
  // still owned by this very task, so ownership alone would let the replacement bind there.
  const orphanTree = worker("one").worktree;
  const replacement: Worker = { ...worker("new"), provider: "claude", id: "claude:new", worktree: orphanTree };
  const proof = (observed: string) => adoptionProof(observed, request.worktree, "/repo");
  assert.throws(() => store.attach("demo", "leader-one", next.revision, "one", token, replacement, proof(orphanTree)), /fenced worker/);
  const leaderTree = "/repo/.claude/worktrees/STARK-100";
  assert.throws(() => store.attach("demo", "leader-one", next.revision, "one", token,
    { ...replacement, session: "leader-one", worktree: leaderTree }, proof(leaderTree)), /leader cannot attach as its own worker/);
  assert.equal(store.read("demo").revision, next.revision);
  const adopted = store.attach("demo", "leader-one", next.revision, "one", token, { ...replacement, worktree: leaderTree }, proof(leaderTree));
  assert.equal(adopted.tasks[0].spec.worktree, leaderTree);
});

test("DAG and authority validation reject missing limits, cycles, duplicated ownership, and provider fallback", () => {
  for (const change of [
    (c: any) => { delete c.maxWorkers; },
    (c: any) => { c.tasks[0].provider = "gemini"; },
    (c: any) => { c.tasks[0].dependsOn = ["dependent"]; },
    (c: any) => { c.tasks[0].dependsOn = ["missing"]; },
    (c: any) => { c.tasks[1].ticket = c.tasks[0].ticket; },
    (c: any) => { c.tasks[1].worktree = c.tasks[0].worktree; },
    (c: any) => { c.tasks[0].checkTimeoutMs = 0; },
    (c: any) => { c.tasks[0].worktree = c.tasks[0].repo + "/"; },
    (c: any) => { c.tasks[0].checkTimeoutMs = "600000"; },
    (c: any) => { c.tasks[0].checkTimeoutMs = 2_147_483_648; },
  ]) { const c = config(); change(c); assert.throws(() => parseEngagement(c)); }
  const bounded = config(); bounded.tasks[0].checkTimeoutMs = 600_000;
  assert.equal(parseEngagement(bounded).tasks[0].checkTimeoutMs, 600_000);
});

test("SQLite database and WAL sidecars stay private under a permissive umask", t => {
  const saved = process.umask(0);
  try {
    const { store, file } = fixture(t);
    store.create(config());
    for (const suffix of ["", "-wal", "-shm"]) {
      const mode = fs.statSync(file + suffix).mode & 0o777;
      t.diagnostic(`state.sqlite${suffix}: ${mode.toString(8)}`);
      assert.equal(mode, 0o600);
    }
  } finally {
    process.umask(saved);
  }
});

test("a launch reservation survives reopening and cannot be duplicated", t => {
  const { store, file } = fixture(t);
  let run = observe(store, store.create(config()));
  run = store.reserve("demo", "leader-one", run.revision, "one");
  const second = new GruStore(file); t.after(() => second.close());
  const reopened = second.read("demo");
  assert.equal(reopened.tasks[0].token, run.tasks[0].token);
  assert.throws(() => second.reserve("demo", "leader-one", reopened.revision, "one"), /reserved/);
  assert.throws(() => store.reserve("demo", "leader-one", reopened.revision - 1, "two"), /stale revision/);
  assert.equal(second.read("demo").tasks[0].attempts, 1);
});

test("intake, worker identities, and dependency completion cannot be inferred from a claim", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  assert.throws(() => report(store, run, "one", "complete", "Everything merged"), /intake acknowledgment/);
  assert.throws(() => report(store, run, "one", "ack", "I am ready"), /exact done-when/);
  // An intake blocker is durable before any ack; the ack still follows once resolved.
  run = report(store, run, "one", "blocked", "The done-when is ambiguous");
  assert.equal(run.tasks[0].phase, "blocked");
  assert.throws(() => report(store, run, "one", "ready", "Not yet"), /intake acknowledgment/);
  assert.throws(() => store.report("demo", "leader-one", run.revision, "one", run.tasks[0].token!, "imposter", "ack", run.tasks[0].spec.doneWhen), /session/);
  run = report(store, run, "one", "ack");
  run = report(store, run, "one", "complete", "All checks green, PR merged, ticket done");
  assert.equal(run.tasks[0].phase, "working");
  assert.match(readyReason(run, run.tasks[2])!, /prerequisite/);
  assert.throws(() => store.reserve("demo", "leader-one", run.revision, "dependent"), /prerequisite/);
});

test("provider mismatch preserves reservation and worker concurrency includes uncertain launches", t => {
  const { store } = fixture(t);
  let run = observe(store, store.create(config()));
  run = store.reserve("demo", "leader-one", run.revision, "one");
  assert.throws(() => store.attach("demo", "leader-one", run.revision, "one", run.tasks[0].token!, { ...worker("one"), provider: "claude" }), /substitution/);
  run = store.reserve("demo", "leader-one", run.revision, "two");
  assert.equal(run.tasks.filter(t => t.phase === "reserved").length, 2);
  assert.throws(() => store.reserve("demo", "leader-one", run.revision, "dependent"), /worker limit/);
});

test("only an incoming leader can replace limits, and never the sitting one", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  const original = run.config.limits;
  const replacement = ["Leader is leader-three; the previous leader is gone", "No new tickets"];
  // THE hazard: a same-session resume is a legal no-op transfer, so without a gate the
  // sitting leader rewrites the limits binding itself — the act operations.md forbids.
  assert.throws(() => store.resume("demo", "leader-one", run.revision, "leader-one", replacement),
    /a leader cannot rewrite the limits binding itself/);
  assert.deepEqual(store.read("demo").config.limits, original);
  // A same-session resume WITHOUT limits stays legal, and keeps the frozen array.
  run = store.resume("demo", "leader-one", run.revision, "leader-one");
  assert.deepEqual(run.config.limits, original);
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  assert.deepEqual(run.config.limits, original);
  // Validated exactly like `init`, so a transfer cannot install junk either.
  for (const bad of [[], "not a list", [""], ["ok", 7], null]) {
    assert.throws(() => store.resume("demo", "leader-two", run.revision, "leader-three", bad),
      /replacement limits must be a non-empty list of strings/, `accepted ${JSON.stringify(bad)}`);
  }
  // The refusals above are thrown inside the transaction, so nothing advanced.
  assert.deepEqual(store.read("demo").config.limits, original);
  assert.equal(store.read("demo").config.leader, "leader-two");
  run = store.resume("demo", "leader-two", run.revision, "leader-three", replacement);
  assert.deepEqual(run.config.limits, replacement);
  assert.equal(run.config.leader, "leader-three");
  // The event records BOTH arrays; "limits replaced" alone leaves no auditable trail of
  // which authority line was dropped.
  const detail = run.events.at(-1)!.detail;
  assert.match(detail, /limits replaced from/);
  assert.match(detail, /No publishing, authentication, infrastructure changes, or extra tickets/);
  assert.match(detail, /the previous leader is gone/);
  // Stored by value: mutating the caller's array cannot reach through into the run.
  replacement[0] = "tampered";
  assert.equal(store.read("demo").config.limits[0], "Leader is leader-three; the previous leader is gone");
  // The new limits reach the worker, which is the entire point.
  assert.match(packet(store.read("demo"), store.read("demo").tasks[0]), /the previous leader is gone/);
});

test("resume fences stale leaders and uncertain workers cannot consume another retry", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  assert.equal(run.tasks[0].token, token);
  assert.throws(() => store.reserve("demo", "leader-two", run.revision, "two"), /reconcile/);
  assert.throws(() => store.reconcile("demo", "leader-one", run.revision, {}), /stale leader/);
  run = observe(store, run, "unknown");
  assert.throws(() => store.recover("demo", "leader-two", run.revision, "one", token), /unknown is not dead/);
  run = observe(store, run, "dead");
  run = store.beginReconnect("demo", "leader-two", run.revision, "one", token);
  assert.throws(() => store.beginReconnect("demo", "leader-two", run.revision, "one", token), /observed termination|uncertain/);
  run = observe(store, run, "dead");
  assert.throws(() => store.finishReconnect("demo", "leader-two", run.revision, "one", token), /fresh live/);
  run = observe(store, run, "live");
  run = store.finishReconnect("demo", "leader-two", run.revision, "one", token);
  run = observe(store, run, "dead");
  run = store.recover("demo", "leader-two", run.revision, "one", token);
  run = start(store, run, "one");
  assert.equal(run.tasks[0].attempts, 2);
  assert.notEqual(run.tasks[0].token, token);
  run = observe(store, run, "dead");
  assert.throws(() => store.recover("demo", "leader-two", run.revision, "one", run.tasks[0].token!), /budget exhausted/);
});

test("replacement stays reachable when the reconnect budget is small or spent", t => {
  const { store } = fixture(t);
  const tight = config(); tight.maxRecoveries = 1;
  let run = start(store, observe(store, store.create(tight)), "one");
  const token = run.tasks[0].token!;
  run = observe(store, run, "dead");
  run = store.beginReconnect("demo", "leader-one", run.revision, "one", token);
  run = observe(store, run, "live");
  run = store.finishReconnect("demo", "leader-one", run.revision, "one", token);
  run = observe(store, run, "dead");
  assert.throws(() => store.beginReconnect("demo", "leader-one", run.revision, "one", token), /budget exhausted/);
  run = store.recover("demo", "leader-one", run.revision, "one", token);
  assert.equal(run.tasks[0].phase, "pending");
  assert.equal(run.tasks[0].recoveries, 1);
  // With no reconnect budget at all, a dead worker is replaced directly.
  const none = config(); none.id = "no-reconnects"; none.maxRecoveries = 0;
  let other = start(store, observe(store, store.create(none)), "two");
  other = observe(store, other, "dead");
  other = store.recover("no-reconnects", "leader-one", other.revision, "two", other.tasks[1].token!);
  assert.equal(other.tasks[1].phase, "pending");
});

test("replacement retains the pending merge grant but must re-earn integration to verify", t => {
  const { store } = fixture(t);
  const c = config(); c.maxRecoveries = 0;
  let run = start(store, observe(store, store.create(c)), "one");
  run = start(store, run, "two");
  for (const id of ["one", "two"]) { run = report(store, run, id, "ack"); run = report(store, run, id, "ready"); }
  run = store.integrate("demo", "leader-one", run.revision, "one", run.tasks[0].token!, "a".repeat(40));
  run = store.reconcile("demo", "leader-one", run.revision, Object.fromEntries(run.tasks.map(t => [t.spec.id,
    { observedAt: new Date().toISOString(), liveness: t.spec.id === "one" ? "dead" : "live", activity: "idle", evidence: ["Hermod observation"] }])));
  run = store.recover("demo", "leader-one", run.revision, "one", run.tasks[0].token!);
  run = start(store, run, "one");
  assert.equal(run.tasks[0].integrationBase, "a".repeat(40));
  assert.equal(run.tasks[0].report?.kind, "ready");
  assert.throws(() => store.integrate("demo", "leader-one", run.revision, "two", run.tasks[1].token!, "a".repeat(40)), /already owned/);
  const proof: CompletionEvidence = { base: "a".repeat(40), head: "b".repeat(40), merge: "c".repeat(40),
    pr: "https://github.com/o/r/pull/1", review: "https://github.com/o/r/pull/1#pullrequestreview-1",
    verifiedAt: new Date().toISOString(), ticketState: "done",
    checks: run.tasks[0].spec.checks.map(argv => ({ argv, exitCode: 0, log: "/evidence/check.log" })) };
  assert.throws(() => store.complete("demo", "leader-one", run.revision, "one", run.tasks[0].token!, proof), /integration and independent verification required/);
  run = report(store, run, "one", "ack");
  assert.throws(() => store.complete("demo", "leader-one", run.revision, "one", run.tasks[0].token!, proof), /integration and independent verification required/);
  run = report(store, run, "one", "ready");
  run = store.integrate("demo", "leader-one", run.revision, "one", run.tasks[0].token!, "a".repeat(40));
  run = store.complete("demo", "leader-one", run.revision, "one", run.tasks[0].token!, proof);
  run = store.integrate("demo", "leader-one", run.revision, "two", run.tasks[1].token!, "c".repeat(40));
  assert.equal(run.tasks[1].phase, "integrating");
});

test("the inherited grant settles a landed merge before the replacement launches", t => {
  const { store } = fixture(t);
  const run = grantThenLoseWorker(store);
  assert.equal(run.tasks[0].phase, "pending");
  const done = store.complete("demo", "leader-one", run.revision, "one", run.tasks[0].token!, landedProof(run));
  assert.equal(done.tasks[0].phase, "done");
});

test("cancelling a working replacement leaves it resumable, not verifiable", t => {
  const { store } = fixture(t);
  let run = grantThenLoseWorker(store);
  const proof = landedProof(run);
  run = start(store, run, "one");
  run = report(store, run, "one", "ack");
  const replacement = run.tasks[0].token!;
  run = store.stop("demo", "leader-one", run.revision);
  run = observe(store, run, "live");
  run = store.stopped("demo", "leader-one", run.revision, "one", replacement);
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  run = observe(store, run, "live");
  assert.equal(run.tasks[0].phase, "stopped");
  assert.equal(run.tasks[0].integrationBase, BASE);
  assert.throws(() => store.complete("demo", "leader-two", run.revision, "one", replacement, proof),
    /integration and independent verification required/);
  // The interrupted worker resumes its own implementation instead.
  run = store.continueWorker("demo", "leader-two", run.revision, "one", replacement);
  assert.equal(run.tasks[0].phase, "working");
});

test("a landed merge stays settleable when the replacement launch never attaches", t => {
  const { store } = fixture(t);
  let run = grantThenLoseWorker(store);
  const proof = landedProof(run);
  // maxAttempts is 2 and worker #1 spent one; this reservation spends the last.
  run = store.reserve("demo", "leader-one", run.revision, "one");
  assert.equal(run.tasks[0].phase, "reserved");
  // The launch produces no discoverable peer, so `attach` can never run. `recover`
  // is refused twice over — the attempt budget is spent and there is no observation.
  assert.throws(() => store.recover("demo", "leader-one", run.revision, "one", run.tasks[0].token!),
    /replacement requires observed termination|attempt budget exhausted/);
  // Without `reserved` in verificationReady this merge could never be settled and
  // the engagement could never reach `complete`.
  const done = store.complete("demo", "leader-one", run.revision, "one", run.tasks[0].token!, proof);
  assert.equal(done.tasks[0].phase, "done");
});

test("verificationReady admits only the pre-attach and own-integration windows", () => {
  const base = { spec: config().tasks[0], attempts: 1, recoveries: 0 };
  const at = (phase: string, extra: Record<string, unknown> = {}) =>
    verificationReady({ ...base, phase, integrationBase: BASE, ...extra } as never);
  // Pre-attach: no replacement owns the work, so the landed merge is free to settle.
  for (const phase of ["pending", "reserved"]) assert.equal(at(phase), true, `${phase} must verify`);
  // This task's own integration, live or frozen by cancellation.
  assert.equal(at("integrating"), true, "integrating must verify");
  assert.equal(at("stopped", { stoppedFrom: "integrating" }), true, "stopped-from-integrating must verify");
  // A replacement holds the work: it must report ready and earn its own grant.
  for (const phase of ["intake", "working", "blocked", "review", "stopping", "done"]) {
    assert.equal(at(phase), false, `${phase} must not verify`);
  }
  // Cancelling before integration leaves the worker resumable, not verifiable.
  for (const from of ["reserved", "intake", "working", "review"]) {
    assert.equal(at("stopped", { stoppedFrom: from }), false, `stopped-from-${from} must not verify`);
  }
  // No grant at all, and an unsettled reconnect, each refuse on their own.
  assert.equal(verificationReady({ ...base, phase: "pending" } as never), false, "no base must not verify");
  assert.equal(at("integrating", { reconnect: { id: "r", startedAt: "", phase: "integrating", pending: true } }),
    false, "unsettled reconnect must not verify");
});

test("confirmed retirement frees capacity while uncertain or resumed workers count", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  run = start(store, run, "two");
  run = finish(store, run, "one"); run = finish(store, run, "two");
  run = store.retire("demo", "leader-one", run.revision, "one", run.tasks[0].token!, "surface-one");
  run = store.retire("demo", "leader-one", run.revision, "two", run.tasks[1].token!, "surface-two");
  run = store.reconcile("demo", "leader-one", run.revision, Object.fromEntries(run.tasks.map(task => [task.spec.id,
    { observedAt: new Date().toISOString(), liveness: "unknown", activity: "unknown", retired: true, evidence: ["confirmed surface closure"] }])));
  assert.equal(store.readyReason(run, run.tasks[2]), null);
  run = observe(store, run, "unknown");
  assert.equal(store.readyReason(run, run.tasks[2]), "worker limit reached");
  run = observe(store, run);
  for (const task of run.tasks.slice(0, 2)) task.observation!.activity = "busy";
  assert.equal(readyReason(run, run.tasks[2]), "worker limit reached");
});

test("verified idle workers free dispatch slots while saved-session ownership remains", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  run = start(store, run, "two");
  run = finish(store, run, "one");
  run = finish(store, run, "two");
  assert.equal(readyReason(run, run.tasks[2]), "worker limit reached");
  run = observe(store, run);
  assert.equal(readyReason(run, run.tasks[2]), null);
  run = observe(store, run, "unknown");
  assert.equal(readyReason(run, run.tasks[2]), "worker limit reached");
  run = observe(store, run);
  run.tasks[0].observation!.activity = "busy";
  run.tasks[1].observation!.activity = "busy";
  assert.equal(readyReason(run, run.tasks[2]), "worker limit reached");
  run = observe(store, run);
  for (const task of run.tasks) if (task.observation) task.observation.observedAt = "2020-01-01T00:00:00Z";
  assert.equal(readyReason(run, run.tasks[2]), "worker limit reached");
  run = observe(store, run, "dead");
  assert.equal(readyReason(run, run.tasks[2]), null);
  run = start(store, run, "dependent");
  run = finish(store, run, "dependent");
  assert.equal(run.mode, "complete");
  // The engagement is complete, but its worker sessions can still resume independently.
  const next = config(); next.id = "follow-up";
  let other = observe(store, store.create(next));
  assert.match(store.readyReason(other, other.tasks[0])!, /already owned/);
  assert.throws(() => store.reserve("follow-up", "leader-one", other.revision, "one"), /already owned/);
});

test("status sees exclusive resources held by another engagement", t => {
  const { store } = fixture(t);
  const first = config(); first.tasks[0].exclusiveResources = ["port:4310"];
  start(store, observe(store, store.create(first)), "one");
  const second = config(); second.id = "second"; second.tasks[1].exclusiveResources = ["port:4310"];
  const run = observe(store, store.create(second));
  assert.match(store.readyReason(run, run.tasks[1])!, /exclusive:port:4310/);
  assert.throws(() => store.reserve("second", "leader-one", run.revision, "two"), /exclusive:port:4310/);
});

test("shared integration resources serialize independently implemented tasks", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  run = start(store, run, "two");
  for (const id of ["one", "two"]) { run = report(store, run, id, "ack"); run = report(store, run, id, "ready"); }
  run = store.integrate("demo", "leader-one", run.revision, "one", run.tasks[0].token!, "a".repeat(40));
  assert.throws(() => store.integrate("demo", "leader-one", run.revision, "two", run.tasks[1].token!, "a".repeat(40)), /already owned/);
  assert.equal(store.read("demo").tasks[1].phase, "review");
});

/** Hermod's live view of `worker(id)`, in the shape `observations()` actually parses. */
const livePeer = (id: string): HermodPeer => ({ id: `codex:${id}`, agent: "codex", threadId: `session-${id}`,
  surfaceId: `surface-${id}`, workspaceId: "workspace", cwd: `/worktrees/${id}`, liveness: "live",
  activity: "idle", evidence: ["live-process", "root-thread"], messaging: { available: true } });

/** Reconcile through the PRODUCTION observation builder instead of hand-written rows.
 * The `observe()` helper above writes Observation objects straight into `reconcile`, so a
 * state it reaches may be one `observations()` can never produce — that blind spot is how a
 * green suite sat over an unreachable path in the closed #966. Tests that assert a phase
 * transition is reachable compose the real builder. */
function reconcileLive(store: GruStore, run: Run, leader = run.config.leader): Run {
  const peers = run.tasks.filter(t => t.worker).map(t => livePeer(t.spec.id));
  return store.reconcile(run.config.id, leader, run.revision,
    observations(run, { peers, observedAt: new Date().toISOString(), incomplete: false }));
}

test("verified completion clears stoppedFrom when it settles a frozen integration", t => {
  const { store } = fixture(t);
  let run = start(store, reconcileLive(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  run = report(store, run, "one", "ack"); run = report(store, run, "one", "ready");
  run = store.integrate("demo", "leader-one", run.revision, "one", token, BASE);
  // Cancellation freezes the in-flight integration; `verificationReady` still admits it,
  // because the merge may already have landed on the other side of the stop.
  run = store.stop("demo", "leader-one", run.revision);
  assert.equal(run.tasks[0].stoppedFrom, "integrating");
  run = reconcileLive(store, run);
  run = store.stopped("demo", "leader-one", run.revision, "one", token);
  assert.equal(run.mode, "stopped");
  run = store.resume("demo", "leader-one", run.revision, "leader-one");
  run = reconcileLive(store, run);
  const done = store.complete("demo", "leader-one", run.revision, "one", token, landedProof(run));
  assert.equal(done.tasks[0].phase, "done");
  // `reserve` (line ~312) and `finishReconnect` (line ~452) both clear this; `complete` did
  // not, so `gru status` reported a verified task still claiming it was cancelled mid-
  // integration — the exact field a leader reads to decide whether work is outstanding.
  assert.equal(done.tasks[0].stoppedFrom, undefined,
    `verified task still claims stoppedFrom: ${done.tasks[0].stoppedFrom}`);
  assert.equal(store.read("demo").tasks[0].stoppedFrom, undefined, "and it must not come back on reopen");
});

test("a stopping task always forces the run out of running mode", t => {
  // This is the premise `verifyBlocker` relies on to omit a `stopping` branch: `verify`
  // refuses unless run.mode === "running", so a `stopping` task can never reach it. Pinned
  // here rather than asserted in a comment, because the branch it justifies deleting is
  // invisible once deleted.
  const { store } = fixture(t);
  let run = start(store, reconcileLive(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  run = report(store, run, "one", "ack");
  run = store.stop("demo", "leader-one", run.revision);
  assert.equal(run.tasks[0].phase, "stopping");
  assert.equal(run.mode, "stopping");
  // `resume` only maps `stopped` back to `running`, and `stopped` needs no active task —
  // which `stopping` is. So no transfer can restore `running` over a stopping task.
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  assert.equal(run.mode, "stopping");
  assert.equal(run.tasks[0].phase, "stopping");
  run = reconcileLive(store, run, "leader-two");
  // Therefore every caller that would consult verifyBlocker is refused by the mode gate.
  assert.throws(() => store.complete("demo", "leader-two", run.revision, "one", token, landedProof(run)),
    /integration and independent verification required/);
});

test("stopping freezes dispatch, requires terminal evidence, and retains resumable ownership", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  run = store.stop("demo", "leader-one", run.revision);
  assert.equal(run.mode, "stopping");
  assert.throws(() => store.stopped("demo", "leader-one", run.revision, "one", run.tasks[0].token!), /termination/);
  run = observe(store, run, "dead");
  run = store.stopped("demo", "leader-one", run.revision, "one", run.tasks[0].token!);
  assert.equal(run.mode, "stopped");
  const otherConfig = config(); otherConfig.id = "competing-run";
  let other = observe(store, store.create(otherConfig));
  // status and reserve share one readiness verdict, across engagements too.
  assert.match(store.readyReason(other, other.tasks[0])!, /file ownership conflicts with STARK-100/);
  assert.equal(readyReason(other, other.tasks[0]), null);
  assert.throws(() => store.reserve("competing-run", "leader-one", other.revision, "one"), /ownership|owned/);
});

test("an interrupted idle worker resumes without a new launch or assignment", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  run = report(store, run, "one", "ack");
  const token = run.tasks[0].token!;
  run = store.stop("demo", "leader-one", run.revision);
  run = observe(store, run, "live");
  run = store.stopped("demo", "leader-one", run.revision, "one", token);
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  run = observe(store, run, "live");
  run = store.continueWorker("demo", "leader-two", run.revision, "one", token);
  assert.equal(run.tasks[0].phase, "working");
  assert.equal(run.tasks[0].attempts, 1);
  assert.equal(run.tasks[0].worker?.session, "session-one");
  assert.equal(run.tasks[0].token, token);
});

test("a late launch can attach during cancellation without restarting dispatch", t => {
  const { store } = fixture(t);
  let run = observe(store, store.create(config()));
  run = store.reserve("demo", "leader-one", run.revision, "one");
  const token = run.tasks[0].token!;
  run = store.stop("demo", "leader-one", run.revision);
  assert.throws(() => store.stopped("demo", "leader-one", run.revision, "one", token), /termination/);
  run = store.attach("demo", "leader-one", run.revision, "one", token, worker("one"));
  assert.equal(run.mode, "stopping");
  assert.equal(run.tasks[0].phase, "stopping");
  assert.throws(() => store.attach("demo", "leader-one", run.revision, "one", token, worker("one")), /no pending/);
  run = observe(store, run, "live");
  run = store.stopped("demo", "leader-one", run.revision, "one", token);
  assert.equal(run.mode, "stopped");
  run = store.resume("demo", "leader-one", run.revision, "leader-two");
  run = observe(store, run, "live");
  run = store.continueWorker("demo", "leader-two", run.revision, "one", token);
  assert.equal(run.tasks[0].phase, "intake");
  assert.equal(run.tasks[0].attempts, 1);
});

test("duplicate intake is idempotent and late ready reports cannot revoke integration ownership", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  const ack = () => store.report("demo", "leader-one", run.revision, "one", token,
    "session-one", "ack", run.tasks[0].spec.doneWhen, "message-one");
  run = ack();
  const acknowledgedRevision = run.revision;
  run = ack();
  assert.equal(run.revision, acknowledgedRevision);
  assert.equal(run.received.length, 1);
  run = report(store, run, "one", "ready");
  run = store.integrate("demo", "leader-one", run.revision, "one", token, "a".repeat(40));
  assert.throws(() => report(store, run, "one", "ready"), /in-flight integration/);
  run = report(store, run, "one", "blocked", "Merge outcome is uncertain");
  assert.equal(run.tasks[0].phase, "integrating");
});

test("repository aliases and non-normalized paths cannot hide competing ownership", t => {
  const { store } = fixture(t);
  const c = config();
  c.tasks[0].repositoryKey = "owner/repo";
  c.tasks[1].repositoryKey = "owner/repo";
  c.tasks[1].repo = "/other-clone";
  c.tasks[1].files = c.tasks[0].files;
  const run = start(store, observe(store, store.create(c)), "one");
  assert.match(readyReason(run, run.tasks[1])!, /file ownership/);
  for (const file of ["src/", "src/./one.ts", "src//one.ts", "./src"]) {
    const malformed = config(); malformed.tasks[0].files = [file];
    assert.throws(() => parseEngagement(malformed), /normalized relative/);
  }
});

test("old liveness cannot authorize recovery and stopping cannot be undone by reconnect receipts", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  assert.throws(() => store.reconcile("demo", "leader-one", run.revision, { one: {
    observedAt: "2000-01-01T00:00:00Z", liveness: "dead", activity: "unknown", evidence: ["Old process"] } }), /stale/);
  run = observe(store, run, "dead");
  run = store.beginReconnect("demo", "leader-one", run.revision, "one", token);
  run = store.stop("demo", "leader-one", run.revision);
  run = observe(store, run, "dead");
  assert.throws(() => store.stopped("demo", "leader-one", run.revision, "one", token), /unsettled startup/);
  run = observe(store, run, "live");
  assert.throws(() => store.finishReconnect("demo", "leader-one", run.revision, "one", token), /fresh live/);
  assert.equal(store.read("demo").mode, "stopping");
});

test("recovery retains the former session identity for its resumable assignment", t => {
  const { store } = fixture(t);
  let run = start(store, observe(store, store.create(config())), "one");
  const token = run.tasks[0].token!;
  run = observe(store, run, "dead");
  run = store.beginReconnect("demo", "leader-one", run.revision, "one", token);
  run = observe(store, run, "live");
  run = store.finishReconnect("demo", "leader-one", run.revision, "one", token);
  run = observe(store, run, "dead");
  run = store.recover("demo", "leader-one", run.revision, "one", token);
  run = store.reserve("demo", "leader-one", run.revision, "one");
  run = store.reserve("demo", "leader-one", run.revision, "two");
  assert.throws(() => store.attach("demo", "leader-one", run.revision, "two", run.tasks[1].token!,
    { ...worker("two"), surface: worker("one").surface }), /already owned/);
});
