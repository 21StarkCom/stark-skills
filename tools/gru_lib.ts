/** Durable coordination for Gru. Alfred owns tickets; Hermod owns workers. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Provider = "claude" | "codex";
export type Phase = "pending" | "reserved" | "intake" | "working" | "blocked" |
  "review" | "integrating" | "verifying" | "done" | "stopping" | "stopped" | "failed";
export interface TaskSpec {
  id: string;
  ticket: string;
  objective: string;
  repo: string;
  repositoryKey?: string;
  worktree: string;
  provider: Provider;
  model?: string;
  effort?: string;
  dependsOn: string[];
  files: string[];
  exclusiveResources: string[];
  mergeResources: string[];
  doneWhen: string;
  checks: string[][];
}
export interface Engagement {
  id: string;
  objective: string;
  leader: string;
  maxWorkers: number;
  maxAttempts: number;
  maxRecoveries: number;
  tasks: TaskSpec[];
  limits: string[];
}
export interface Worker {
  id: string;
  session: string;
  surface: string;
  workspace: string;
  provider: Provider;
  worktree: string;
  pid?: number;
}
export interface Observation {
  pid?: number;
  observedAt: string;
  liveness: "live" | "dead" | "unknown";
  activity: "busy" | "idle" | "unknown";
  evidence: string[];
}
export interface CompletionEvidence {
  head: string;
  base: string;
  merge: string;
  pr: string;
  review: string;
  checks: { argv: string[]; exitCode: number; log: string }[];
  verifiedAt: string;
  ticketState: string;
}
export interface Assignment {
  spec: TaskSpec;
  phase: Phase;
  attempts: number;
  recoveries: number;
  token?: string;
  worker?: Worker;
  observation?: Observation;
  acknowledged?: string;
  report?: { kind: string; message: string; at: string };
  integrationBase?: string;
  stoppedFrom?: Phase;
  reconnect?: { id: string; startedAt: string; phase: Phase; pending: boolean };
  evidence?: CompletionEvidence;
}
export interface Run {
  schema: 1;
  config: Engagement;
  revision: number;
  epoch: number;
  mode: "running" | "stopping" | "stopped" | "complete";
  reconciled: boolean;
  received: string[];
  tasks: Assignment[];
  events: { at: string; task?: string; kind: string; detail: string }[];
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isProvider(value: unknown): value is Provider {
  return value === "codex" || value === "claude";
}
const active = (t: Assignment) => !["pending", "done", "stopped", "failed"].includes(t.phase);
const ownsFiles = (t: Assignment) => active(t) || t.phase === "stopped";
const occupiesSlot = (t: Assignment) => active(t) || Boolean(t.worker && t.observation?.liveness !== "dead");
const overlap = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const repositoryKey = (t: TaskSpec) => t.repositoryKey ?? t.repo;
const fresh = (o?: Observation) => Boolean(o && Date.now() - Date.parse(o.observedAt) <= 60_000 && Date.parse(o.observedAt) <= Date.now() + 5_000);

/** Reject a malformed DAG or unspecified authority before creating any state. */
export function parseEngagement(value: unknown): Engagement {
  requireValue(isRecord(value), "engagement must be an object");
  for (const key of ["id", "objective", "leader"]) requireValue(nonempty(value[key]), `${key} is required`);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.id as string), "invalid engagement id");
  for (const key of ["maxWorkers", "maxAttempts", "maxRecoveries"]) {
    requireValue(Number.isSafeInteger(value[key]) && Number(value[key]) >= (key === "maxRecoveries" ? 0 : 1), `${key} must be an explicit bounded integer`);
  }
  requireValue(stringList(value.limits) && value.limits.length > 0, "explicit operating limits are required");
  requireValue(Array.isArray(value.tasks) && value.tasks.length > 0, "tasks are required");
  const ids = new Set<string>();
  const tickets = new Set<string>();
  const trees = new Set<string>();
  for (const t of value.tasks) {
    requireValue(isRecord(t), "task must be an object");
    for (const key of ["id", "ticket", "objective", "repo", "worktree", "doneWhen"]) requireValue(nonempty(t[key]), `task ${key} is required`);
    requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(t.id as string), "invalid task id");
    requireValue(/^STARK-\d+$/.test(t.ticket as string), "task must reference an existing STARK ticket");
    requireValue(isProvider(t.provider), "provider must be explicitly claude or codex");
    requireValue(t.repositoryKey === undefined || nonempty(t.repositoryKey), "invalid repository identity");
    for (const key of ["model", "effort"]) requireValue(t[key] === undefined || nonempty(t[key]), `${key} must be nonempty when selected`);
    requireValue(path.isAbsolute(t.repo as string) && path.isAbsolute(t.worktree as string), "repo and worktree must be absolute paths");
    requireValue(t.repo !== t.worktree, "worker needs an isolated worktree");
    for (const key of ["dependsOn", "files", "exclusiveResources", "mergeResources"]) requireValue(stringList(t[key]), `${key} must be a string array`);
    requireValue((t.files as string[]).length > 0, "declare task files");
    for (const file of t.files as string[]) requireValue(!path.isAbsolute(file) && !file.split("/").some(p => !p || p === "." || p === "..") && !/[?*\\]/.test(file), "files must be normalized relative paths or directories, without globs");
    requireValue(Array.isArray(t.checks) && t.checks.length > 0 && t.checks.every(c => stringList(c) && c.length > 0), "checks must contain explicit command argument arrays");
    requireValue(!ids.has(t.id as string), "duplicate task id");
    requireValue(!tickets.has(t.ticket as string), "duplicate ticket ownership");
    requireValue(!trees.has(path.resolve(t.worktree as string)), "duplicate worktree ownership");
    ids.add(t.id as string); tickets.add(t.ticket as string); trees.add(path.resolve(t.worktree as string));
  }
  const config = structuredClone(value) as unknown as Engagement;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    requireValue(ids.has(id), `unknown dependency ${id}`);
    requireValue(!visiting.has(id), `dependency cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    config.tasks.find(t => t.id === id)!.dependsOn.forEach(visit);
    visiting.delete(id); visited.add(id);
  }
  config.tasks.forEach(t => visit(t.id));
  return config;
}

export function readyReason(run: Run, task: Assignment): string | null {
  if (run.mode !== "running") return `engagement is ${run.mode}`;
  if (!run.reconciled) return "reconcile existing workers first";
  if (task.phase !== "pending") return `task is ${task.phase}`;
  if (task.attempts >= run.config.maxAttempts) return "attempt budget exhausted";
  if (run.tasks.filter(occupiesSlot).length >= run.config.maxWorkers) return "worker limit reached";
  for (const id of task.spec.dependsOn) {
    if (run.tasks.find(t => t.spec.id === id)?.phase !== "done") return `prerequisite ${id} is unverified`;
  }
  for (const other of run.tasks.filter(ownsFiles)) {
    if (repositoryKey(task.spec) === repositoryKey(other.spec) && task.spec.files.some(a => other.spec.files.some(b => overlap(a, b)))) {
      return `file ownership conflicts with ${other.spec.id}`;
    }
    if (task.spec.exclusiveResources.some(r => other.spec.exclusiveResources.includes(r))) return `resource owned by ${other.spec.id}`;
  }
  return null;
}

/** One SQLite transaction serializes state and ownership, across leader processes. */
export class GruStore {
  private db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owners (resource TEXT PRIMARY KEY, run TEXT NOT NULL, task TEXT NOT NULL);`);
  }
  close(): void { this.db.close(); }
  read(id: string): Run {
    const row = this.db.prepare("SELECT body FROM runs WHERE id=?").get(id) as { body: string } | undefined;
    requireValue(row, `unknown engagement ${id}`);
    return JSON.parse(row.body) as Run;
  }
  create(input: unknown): Run {
    const config = parseEngagement(input);
    const run: Run = { schema: 1, config, revision: 0, epoch: 1, mode: "running", reconciled: false, received: [],
      tasks: config.tasks.map(spec => ({ spec, phase: "pending", attempts: 0, recoveries: 0 })), events: [] };
    this.db.prepare("INSERT INTO runs (id,body) VALUES (?,?)").run(config.id, JSON.stringify(run));
    return run;
  }
  private transaction(id: string, leader: string, revision: number, fn: (run: Run) => void): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.read(id);
      requireValue(run.config.leader === leader, "stale leader; resume and reconcile before writing");
      requireValue(run.revision === revision, `stale revision; expected ${run.revision}`);
      fn(run); run.revision++;
      this.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(run), id);
      this.db.exec("COMMIT");
      return run;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private event(run: Run, kind: string, detail: string, task?: string): void {
    run.events.push({ at: new Date().toISOString(), kind, detail, ...(task ? { task } : {}) });
  }
  private task(run: Run, id: string, token?: string): Assignment {
    const task = run.tasks.find(t => t.spec.id === id);
    requireValue(task, `unknown task ${id}`);
    if (token !== undefined) requireValue(task.token === token, "stale assignment token");
    return task;
  }
  private own(run: Run, task: Assignment, resources: string[]): void {
    for (const resource of resources) {
      const owner = this.db.prepare("SELECT run,task FROM owners WHERE resource=?").get(resource) as { run: string; task: string } | undefined;
      requireValue(!owner || (owner.run === run.config.id && owner.task === task.spec.id), `resource already owned: ${resource}`);
      this.db.prepare("INSERT OR IGNORE INTO owners(resource,run,task) VALUES (?,?,?)").run(resource, run.config.id, task.spec.id);
    }
  }
  reserve(id: string, leader: string, revision: number, taskId: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId);
      const reason = readyReason(run, task); requireValue(reason === null, reason ?? "not ready");
      // Directory overlap matters across engagements too, not just within this DAG.
      const otherRuns = this.db.prepare("SELECT body FROM runs WHERE id<>?").all(id) as { body: string }[];
      for (const row of otherRuns) for (const other of (JSON.parse(row.body) as Run).tasks.filter(ownsFiles)) {
        requireValue(repositoryKey(task.spec) !== repositoryKey(other.spec) || !task.spec.files.some(a => other.spec.files.some(b => overlap(a, b))), `file ownership conflicts with ${other.spec.ticket}`);
      }
      this.own(run, task, [`ticket:${task.spec.ticket}`, `tree:${path.resolve(task.spec.worktree)}`,
        ...task.spec.exclusiveResources.map(r => `exclusive:${r}`)]);
      task.token = randomUUID(); task.attempts++; task.phase = "reserved";
      task.worker = undefined; task.observation = undefined; task.acknowledged = undefined;
      task.report = undefined; task.evidence = undefined; task.integrationBase = undefined;
      task.reconnect = undefined; task.stoppedFrom = undefined;
      this.event(run, "reserved", task.token, taskId);
    });
  }
  attach(id: string, leader: string, revision: number, taskId: string, token: string, worker: Worker): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && task.phase === "reserved", "no pending launch to attach");
      for (const key of ["id", "session", "surface", "workspace", "worktree"] as const) requireValue(nonempty(worker[key]), `worker ${key} is required`);
      requireValue(worker.provider === task.spec.provider, "provider substitution refused");
      requireValue(path.resolve(worker.worktree) === path.resolve(task.spec.worktree), "worker worktree mismatch");
      this.own(run, task, [`worker:${worker.id}`, `session:${worker.provider}:${worker.session}`, `surface:${worker.surface}`]);
      task.worker = structuredClone(worker); task.phase = "intake";
      this.event(run, "attached", worker.id, taskId);
    });
  }
  report(id: string, leader: string, revision: number, taskId: string, token: string,
    session: string, kind: "ack" | "progress" | "blocked" | "ready" | "complete", message: string, messageId?: string): Run {
    return this.transaction(id, leader, revision, run => {
      if (messageId && run.received.includes(messageId)) return;
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && active(task) && task.phase !== "stopping", "task cannot accept work reports");
      requireValue(task.worker?.session === session, "report session does not own assignment");
      requireValue(nonempty(message), "report message is required");
      requireValue(["ack", "progress", "blocked", "ready", "complete"].includes(kind), "invalid report kind");
      if (kind === "ack") {
        requireValue(task.phase === "intake", "intake already acknowledged or not started");
        requireValue(message === task.spec.doneWhen, "intake must acknowledge the exact done-when");
        task.acknowledged = new Date().toISOString(); task.phase = "working";
      } else {
        requireValue(task.acknowledged, "intake acknowledgment required");
        if (kind === "blocked" && task.phase !== "integrating") task.phase = "blocked";
        if (kind === "ready") {
          requireValue(["working", "blocked", "review"].includes(task.phase), "an in-flight integration cannot be superseded by a report");
          task.phase = "review";
        }
        // A completion message changes no verification or dependency state.
      }
      task.report = { kind, message, at: new Date().toISOString() };
      if (messageId) run.received.push(messageId);
      this.event(run, `report:${kind}`, message, taskId);
    });
  }
  reconcile(id: string, leader: string, revision: number, observations: Record<string, Observation>): Run {
    return this.transaction(id, leader, revision, run => {
      for (const task of run.tasks.filter(t => active(t) || t.worker)) {
        const observation = observations[task.spec.id];
        requireValue(observation && ["live", "dead", "unknown"].includes(observation.liveness), `missing observation for ${task.spec.id}`);
        requireValue(nonempty(observation.observedAt) && Number.isFinite(Date.parse(observation.observedAt)), "observation timestamp is required");
        requireValue(fresh(observation), "observation is stale; reconcile again");
        requireValue(["busy", "idle", "unknown"].includes(observation.activity), "invalid worker activity");
        requireValue(stringList(observation.evidence), "observation evidence is required");
        requireValue(observation.liveness === "unknown" || observation.evidence.length > 0, "liveness requires evidence");
        task.observation = structuredClone(observation);
        if (task.worker && observation.liveness === "live" && Number.isSafeInteger(observation.pid) && observation.pid! > 1) task.worker.pid = observation.pid;
      }
      run.reconciled = true;
      this.event(run, "reconciled", "observations refreshed; reservations retained");
    });
  }
  resume(id: string, oldLeader: string, revision: number, newLeader: string): Run {
    return this.transaction(id, oldLeader, revision, run => {
      requireValue(nonempty(newLeader), "leader identity is required");
      requireValue(run.mode !== "complete", "engagement already complete");
      run.config.leader = newLeader; run.epoch++; run.reconciled = false;
      if (run.mode === "stopped") run.mode = "running";
      for (const task of run.tasks) task.observation = undefined;
      this.event(run, "resumed", `leader ${newLeader}; reconnect before dispatch`);
    });
  }
  recover(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled, "resume and reconcile first");
      requireValue(active(task) || task.phase === "stopped", "task is not recoverable");
      requireValue(task.observation?.liveness === "dead", "replacement requires observed termination; unknown is not dead");
      requireValue(task.recoveries < run.config.maxRecoveries && task.attempts < run.config.maxAttempts, "recovery budget exhausted");
      requireValue(task.reconnect && !task.reconnect.pending, "reconnect the existing session before replacement");
      requireValue(fresh(task.observation), "termination evidence is stale; reconcile again");
      requireValue(task.phase !== "integrating" && task.stoppedFrom !== "integrating", "reconcile pending merge before recovery");
      task.recoveries++; task.phase = "pending";
      this.db.prepare("DELETE FROM owners WHERE run=? AND task=? AND resource LIKE 'exclusive:%'").run(id, taskId);
      this.event(run, "recovery", "old worker observed terminal; existing worktree must be preserved", taskId);
    });
  }
  beginReconnect(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled && task.worker, "reconcile the existing worker first");
      requireValue(active(task) || task.phase === "stopped", "task is not reconnectable");
      requireValue(task.observation?.liveness === "dead", "reconnect requires observed termination; live workers should receive a follow-up");
      requireValue(fresh(task.observation), "termination evidence is stale; reconcile again");
      requireValue(!task.reconnect?.pending, "reconnect outcome is uncertain; observe it before another action");
      requireValue(task.recoveries < run.config.maxRecoveries, "recovery budget exhausted");
      task.recoveries++;
      task.reconnect = { id: randomUUID(), startedAt: new Date().toISOString(), phase: task.stoppedFrom ?? task.phase, pending: true };
      task.observation = undefined;
      this.event(run, "reconnect-reserved", task.reconnect.id, taskId);
    });
  }
  finishReconnect(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(task.reconnect?.pending, "no reconnect operation pending");
      requireValue(run.mode === "running" && fresh(task.observation) && task.observation?.liveness === "live" && Date.parse(task.observation.observedAt) >= Date.parse(task.reconnect.startedAt), "fresh live reconnect outcome required; old process death does not settle startup");
      task.reconnect.pending = false;
      if (task.observation.liveness === "live") {
        task.phase = task.reconnect.phase; task.stoppedFrom = undefined;
      }
      this.event(run, "reconnect-observed", task.observation.liveness, taskId);
    });
  }
  continueWorker(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled && task.phase === "stopped" && task.stoppedFrom, "resume leadership and reconcile the stopped assignment first");
      requireValue(task.observation?.liveness === "live" && task.observation.activity === "idle", "existing worker must be observed idle");
      requireValue(fresh(task.observation), "worker evidence is stale; reconcile again");
      task.phase = task.stoppedFrom; task.stoppedFrom = undefined;
      this.event(run, "continued", "existing worker and token retained; send continuation through Hermod", taskId);
    });
  }
  integrate(id: string, leader: string, revision: number, taskId: string, token: string, base: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled && task.phase === "review", "task is not ready for integration");
      requireValue(/^[0-9a-f]{40,64}$/.test(base), "integration requires an observed base SHA");
      // Repository-wide serialization also covers undeclared release-file seams.
      this.own(run, task, [`merge:${repositoryKey(task.spec)}`, ...task.spec.mergeResources.map(r => `merge-resource:${r}`)]);
      task.integrationBase = base; task.phase = "integrating";
      this.event(run, "integration", base, taskId);
    });
  }
  complete(id: string, leader: string, revision: number, taskId: string, token: string, evidence: CompletionEvidence): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled && task.phase === "integrating", "integration and independent verification required");
      requireValue(evidence.base === task.integrationBase, "integration base changed; rebase and reverify");
      for (const sha of [evidence.head, evidence.base, evidence.merge]) requireValue(/^[0-9a-f]{40,64}$/.test(sha), "invalid evidence revision");
      requireValue(nonempty(evidence.pr) && nonempty(evidence.review) && nonempty(evidence.verifiedAt), "PR, review, and verification evidence required");
      requireValue(evidence.ticketState === "done" || evidence.ticketState === "Closed", "repository completion milestone not recorded in Alfred");
      requireValue(evidence.checks.length === task.spec.checks.length, "missing completion checks");
      task.spec.checks.forEach((argv, i) => requireValue(JSON.stringify(evidence.checks[i].argv) === JSON.stringify(argv) && evidence.checks[i].exitCode === 0 && nonempty(evidence.checks[i].log), "check failed, changed, or missing output"));
      task.evidence = structuredClone(evidence); task.phase = "done";
      // Completion releases integration gates, but a saved session still owns its tree.
      this.db.prepare("DELETE FROM owners WHERE run=? AND task=? AND (resource LIKE 'merge:%' OR resource LIKE 'merge-resource:%' OR resource LIKE 'exclusive:%')").run(id, taskId);
      if (run.tasks.every(t => t.phase === "done")) run.mode = "complete";
      this.event(run, "verified", evidence.merge, taskId);
    });
  }
  stop(id: string, leader: string, revision: number): Run {
    return this.transaction(id, leader, revision, run => {
      requireValue(run.mode !== "complete", "engagement already complete");
      run.mode = "stopping";
      for (const task of run.tasks.filter(active)) {
        if (task.phase !== "stopping") task.stoppedFrom = task.phase;
        task.phase = "stopping";
        task.observation = undefined;
      }
      this.event(run, "stop-requested", "dispatch frozen; Hermod interruption still required");
      if (!run.tasks.some(active)) run.mode = "stopped";
    });
  }
  stopped(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(task.phase === "stopping" && (task.observation?.liveness === "dead" ||
        (task.observation?.liveness === "live" && task.observation.activity === "idle")), "termination or an idle interrupted worker must be observed before stopping completes");
      requireValue(fresh(task.observation), "worker evidence is stale; reconcile again");
      task.phase = "stopped";
      // Worktree and ticket stay reserved for this resumable engagement.
      if (!run.tasks.some(active)) run.mode = "stopped";
      this.event(run, "stopped", "worker terminal; worktree retained", taskId);
    });
  }
}
