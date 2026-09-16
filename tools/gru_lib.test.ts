import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { GruStore, parseEngagement, readyReason, verificationReady, type CompletionEvidence, type Engagement, type Run, type Worker } from "./gru_lib.ts";

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
