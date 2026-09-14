import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { GruStore, parseEngagement, readyReason, type Engagement, type Run, type Worker } from "./gru_lib.ts";

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

test("DAG and authority validation reject missing limits, cycles, duplicated ownership, and provider fallback", () => {
  for (const change of [
    (c: any) => { delete c.maxWorkers; },
    (c: any) => { c.tasks[0].provider = "gemini"; },
    (c: any) => { c.tasks[0].dependsOn = ["dependent"]; },
    (c: any) => { c.tasks[0].dependsOn = ["missing"]; },
    (c: any) => { c.tasks[1].ticket = c.tasks[0].ticket; },
    (c: any) => { c.tasks[1].worktree = c.tasks[0].worktree; },
  ]) { const c = config(); change(c); assert.throws(() => parseEngagement(c)); }
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
