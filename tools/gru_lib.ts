/** Durable coordination for Gru. Alfred owns tickets; Hermod owns workers. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function canonicalWorktree(value: string): string {
  return fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value);
}
/** A dangling symlink is an occupied directory entry too. Fail closed on read errors. */
export function assertAbsentWorktree(value: string): void {
  if (fs.lstatSync(value, { throwIfNoEntry: false })) throw new Error("takeover requires a new, absent worktree; preserve existing checkouts");
}

export type Provider = "claude" | "codex";
export type Phase = "pending" | "reserved" | "intake" | "working" | "blocked" |
  "review" | "integrating" | "done" | "stopping" | "stopped";
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
  /** Wall-clock bound per verification check; defaults to DEFAULT_CHECK_TIMEOUT_MS. */
  checkTimeoutMs?: number;
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
  retired?: boolean;
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
/** An operator attestation, not independently authenticated proof of human identity. */
export interface TakeoverRequest {
  run: string;
  task: string;
  token: string;
  revision: number;
  operatorRequest: string;
  provider: Provider;
  worktree: string;
  model?: string;
  effort?: string;
  limits?: string[];
}
export interface OrphanEvidence {
  observedAt: string;
  worker: Worker;
  replacementWorktree: string;
  checks: string[];
}
export const ORPHAN_CHECKS = ["complete peer discovery", "complete saved-session discovery",
  "no matching live peer or saved session", "recorded surface absent", "recorded PID absent",
  "replacement worktree unoccupied"];
export interface TakeoverRecord {
  request: TakeoverRequest;
  evidence: OrphanEvidence;
  previousSpec: TaskSpec;
  previousLimits: string[];
  previousObservation?: Observation;
  previousReport?: Assignment["report"];
}
export interface Assignment {
  spec: TaskSpec;
  phase: Phase;
  attempts: number;
  recoveries: number;
  token?: string;
  worker?: Worker;
  observation?: Observation;
  retired?: { surface: string; at: string };
  acknowledged?: string;
  report?: { kind: string; message: string; at: string };
  integrationBase?: string;
  stoppedFrom?: Phase;
  reconnect?: { id: string; startedAt: string; phase: Phase; pending: boolean };
  evidence?: CompletionEvidence;
  takeovers?: TakeoverRecord[];
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
/** The single limits rule, shared by `init` and by a transfer that replaces them.
 * `resume` promises limits are "revalidated like `init`"; two copies of the predicate
 * would let a future tightening reach one path and quietly break that promise on the
 * other, with no test to notice. */
function requireLimits(value: unknown, message: string): asserts value is string[] {
  requireValue(stringList(value) && value.length > 0, message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isProvider(value: unknown): value is Provider {
  return value === "codex" || value === "claude";
}
export function parseTakeover(value: unknown): TakeoverRequest {
  requireValue(isRecord(value), "takeover request must be an object");
  const keys = ["run", "task", "token", "revision", "operatorRequest", "provider", "worktree", "model", "effort", "limits"];
  requireValue(Object.keys(value).every(k => keys.includes(k)), "unknown takeover request field");
  for (const key of ["run", "task", "token", "operatorRequest", "worktree"]) requireValue(nonempty(value[key]), `takeover ${key} is required`);
  requireValue(Number.isSafeInteger(value.revision) && Number(value.revision) >= 0, "takeover revision is required");
  requireValue(isProvider(value.provider), "takeover provider must be explicitly claude or codex");
  requireValue(path.isAbsolute(value.worktree as string), "takeover worktree must be absolute");
  for (const key of ["model", "effort"]) requireValue(value[key] === undefined || nonempty(value[key]), `takeover ${key} must be nonempty`);
  if (value.limits !== undefined) requireLimits(value.limits, "takeover limits must be a non-empty list of strings");
  return structuredClone(value) as unknown as TakeoverRequest;
}
const active = (t: Assignment) => !["pending", "done", "stopped"].includes(t.phase);
const ownsFiles = (t: Assignment) => active(t) || t.phase === "stopped" ||
  // Takeover retains the orphan's scope until its replacement reserves or the
  // retained merge settles. Normal recover() keeps its worker and is unchanged.
  (t.phase === "pending" && !t.worker && Boolean(t.takeovers?.length));
// Completed workers release slots with fresh idle/dead or confirmed-retirement
// evidence. Unconfirmed or still-busy workers count toward the concurrency limit.
const occupiesSlot = (t: Assignment) => active(t) || Boolean(t.worker &&
  !(fresh(t.observation) && (t.observation?.liveness === "dead" ||
    (t.phase === "done" && (t.observation?.retired ||
      (t.observation?.liveness === "live" && t.observation.activity === "idle"))))));
const overlap = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
const repositoryKey = (t: TaskSpec) => t.repositoryKey ?? t.repo;
const reservationResources = (task: Assignment) => [`ticket:${task.spec.ticket}`, `tree:${path.resolve(task.spec.worktree)}`,
  ...task.spec.exclusiveResources.map(r => `exclusive:${r}`)];
const fresh = (o?: Observation) => Boolean(o && Date.now() - Date.parse(o.observedAt) <= 60_000 && Date.parse(o.observedAt) <= Date.now() + 5_000);

/** A retained merge is settleable only while no replacement owns the work, or while
 * this task's own integration is live or frozen. `attach` is the ownership line:
 * before it the replacement has implemented nothing (`pending` after `recover`,
 * `reserved` after `reserve`), so settling the landed merge costs nothing. After it
 * the replacement must report ready and receive its own grant — cancelling an intake
 * or working replacement must not reopen the inherited one, because that worker stays
 * resumable through `continueWorker`. `reserved` is load-bearing, not cosmetic: a
 * launch that never produces a discoverable peer leaves the task unattachable, and
 * with the attempt budget spent `recover` also refuses — without it, a merge that
 * actually landed could never be settled and the engagement could never complete. */
export function verificationReady(task: Assignment): task is Assignment & { integrationBase: string } {
  return Boolean(task.integrationBase && !task.reconnect?.pending &&
    (task.phase === "integrating" || task.phase === "pending" || task.phase === "reserved" ||
      (task.phase === "stopped" && task.stoppedFrom === "integrating")));
}

/** Reject a malformed DAG or unspecified authority before creating any state. */
export function parseEngagement(value: unknown): Engagement {
  requireValue(isRecord(value), "engagement must be an object");
  for (const key of ["id", "objective", "leader"]) requireValue(nonempty(value[key]), `${key} is required`);
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value.id as string), "invalid engagement id");
  for (const key of ["maxWorkers", "maxAttempts", "maxRecoveries"]) {
    requireValue(Number.isSafeInteger(value[key]) && Number(value[key]) >= (key === "maxRecoveries" ? 0 : 1), `${key} must be an explicit bounded integer`);
  }
  requireLimits(value.limits, "explicit operating limits are required");
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
    requireValue(path.resolve(t.repo as string) !== path.resolve(t.worktree as string), "worker needs an isolated worktree");
    for (const key of ["dependsOn", "files", "exclusiveResources", "mergeResources"]) requireValue(stringList(t[key]), `${key} must be a string array`);
    requireValue((t.files as string[]).length > 0, "declare task files");
    for (const file of t.files as string[]) requireValue(!path.isAbsolute(file) && !file.split("/").some(p => !p || p === "." || p === "..") && !/[?*\\]/.test(file), "files must be normalized relative paths or directories, without globs");
    requireValue(Array.isArray(t.checks) && t.checks.length > 0 && t.checks.every(c => stringList(c) && c.length > 0), "checks must contain explicit command argument arrays");
    requireValue(t.checkTimeoutMs === undefined || (Number.isSafeInteger(t.checkTimeoutMs) && (t.checkTimeoutMs as number) > 0 && (t.checkTimeoutMs as number) <= 2_147_483_647), "checkTimeoutMs must be an integer from 1 to 2147483647 when set");
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

/** Dependency, capacity, and file-ownership checks; GruStore also checks reserved resources. */
export function readyReason(run: Run, task: Assignment, otherRuns: readonly Run[] = []): string | null {
  if (run.mode !== "running") return `engagement is ${run.mode}`;
  if (!run.reconciled) return "reconcile existing workers first";
  if (task.phase !== "pending") return `task is ${task.phase}`;
  if (task.attempts >= run.config.maxAttempts) return "attempt budget exhausted";
  if (run.tasks.filter(occupiesSlot).length >= run.config.maxWorkers) return "worker limit reached";
  for (const id of task.spec.dependsOn) {
    if (run.tasks.find(t => t.spec.id === id)?.phase !== "done") return `prerequisite ${id} is unverified`;
  }
  for (const other of run.tasks.filter(ownsFiles)) {
    if (other === task) continue;
    if (repositoryKey(task.spec) === repositoryKey(other.spec) && task.spec.files.some(a => other.spec.files.some(b => overlap(a, b)))) {
      return `file ownership conflicts with ${other.spec.id}`;
    }
    if (task.spec.exclusiveResources.some(r => other.spec.exclusiveResources.includes(r))) return `resource owned by ${other.spec.id}`;
  }
  // Directory overlap matters across engagements too, not just within this DAG.
  for (const otherRun of otherRuns) for (const other of otherRun.tasks.filter(ownsFiles)) {
    if (repositoryKey(task.spec) === repositoryKey(other.spec) && task.spec.files.some(a => other.spec.files.some(b => overlap(a, b)))) {
      return `file ownership conflicts with ${other.spec.ticket}`;
    }
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
  /** Every other engagement in this store, for cross-run ownership checks. */
  private others(id: string): Run[] {
    return (this.db.prepare("SELECT body FROM runs WHERE id<>?").all(id) as { body: string }[]).map(row => JSON.parse(row.body) as Run);
  }
  readyReason(run: Run, task: Assignment): string | null {
    return this.reasonFor(run, task, this.others(run.config.id));
  }
  /** Every task's reason at once; the cross-run snapshot is read and parsed once, not per task. */
  readyReasons(run: Run): Map<string, string | null> {
    const others = this.others(run.config.id);
    return new Map(run.tasks.map(task => [task.spec.id, this.reasonFor(run, task, others)]));
  }
  private reasonFor(run: Run, task: Assignment, others: readonly Run[]): string | null {
    const reason = readyReason(run, task, others);
    if (reason) return reason;
    for (const resource of reservationResources(task)) {
      const owner = this.db.prepare("SELECT run,task FROM owners WHERE resource=?").get(resource) as { run: string; task: string } | undefined;
      if (owner && (owner.run !== run.config.id || owner.task !== task.spec.id)) return `resource already owned: ${resource}`;
    }
    return null;
  }
  create(input: unknown): Run {
    const config = parseEngagement(input);
    const run: Run = { schema: 1, config, revision: 0, epoch: 1, mode: "running", reconciled: false, received: [],
      tasks: config.tasks.map(spec => ({ spec, phase: "pending", attempts: 0, recoveries: 0 })), events: [] };
    this.db.prepare("INSERT INTO runs (id,body) VALUES (?,?)").run(config.id, JSON.stringify(run));
    return run;
  }
  private transaction(id: string, leader: string, revision: number, fn: (run: Run) => void | boolean): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.read(id);
      requireValue(run.config.leader === leader, "stale leader; resume and reconcile before writing");
      requireValue(run.revision === revision, `stale revision; expected ${run.revision}`);
      // A no-op transition (fn returns false) must not bump the revision or rewrite
      // state: an idempotent replay would otherwise invalidate the leader's held
      // revision. Every real mutation returns void and persists.
      if (fn(run) !== false) {
        run.revision++;
        this.db.prepare("UPDATE runs SET body=? WHERE id=?").run(JSON.stringify(run), id);
      }
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
      const reason = this.readyReason(run, task); requireValue(reason === null, reason ?? "not ready");
      this.own(run, task, reservationResources(task));
      task.token = randomUUID(); task.attempts++; task.phase = "reserved";
      task.worker = undefined; task.observation = undefined; task.acknowledged = undefined;
      // A replacement inherits any unsettled merge grant and its last report.
      // Keep the original base so an already-merged PR can still be verified.
      if (!task.integrationBase && !task.takeovers?.length) task.report = undefined;
      task.evidence = undefined; task.retired = undefined;
      task.reconnect = undefined; task.stoppedFrom = undefined;
      this.event(run, "reserved", task.token, taskId);
    });
  }
  attach(id: string, leader: string, revision: number, taskId: string, token: string, worker: Worker): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      const stoppingLaunch = run.mode === "stopping" && task.phase === "stopping" &&
        task.stoppedFrom === "reserved" && !task.worker;
      requireValue((run.mode === "running" && task.phase === "reserved") || stoppingLaunch, "no pending launch to attach");
      for (const key of ["id", "session", "surface", "workspace", "worktree"] as const) requireValue(nonempty(worker[key]), `worker ${key} is required`);
      requireValue(worker.provider === task.spec.provider, "provider substitution refused");
      requireValue(canonicalWorktree(worker.worktree) === canonicalWorktree(task.spec.worktree), "worker worktree mismatch");
      requireValue(!task.takeovers?.some(t => t.evidence.worker.id === worker.id ||
        t.evidence.worker.session === worker.session || t.evidence.worker.surface === worker.surface), "fenced worker cannot reattach after takeover");
      this.own(run, task, [`worker:${worker.id}`, `session:${worker.provider}:${worker.session}`, `surface:${worker.surface}`]);
      task.worker = { ...structuredClone(worker), worktree: canonicalWorktree(worker.worktree) };
      if (stoppingLaunch) task.stoppedFrom = "intake";
      else task.phase = "intake";
      this.event(run, "attached", worker.id, taskId);
    });
  }
  report(id: string, leader: string, revision: number, taskId: string, token: string,
    session: string, kind: "ack" | "progress" | "blocked" | "ready" | "complete", message: string, messageId?: string): Run {
    return this.transaction(id, leader, revision, run => {
      if (messageId && run.received.includes(messageId)) return false;
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && active(task) && task.phase !== "stopping", "task cannot accept work reports");
      requireValue(task.worker?.session === session, "report session does not own assignment");
      requireValue(nonempty(message), "report message is required");
      requireValue(["ack", "progress", "blocked", "ready", "complete"].includes(kind), "invalid report kind");
      if (kind === "ack") {
        requireValue(!task.acknowledged && (task.phase === "intake" || task.phase === "blocked"), "intake already acknowledged or not started");
        requireValue(message === task.spec.doneWhen, "intake must acknowledge the exact done-when");
        task.acknowledged = new Date().toISOString(); task.phase = "working";
      } else {
        // An intake blocker (ambiguous done-when, missing limit) is reportable before any ack.
        requireValue(task.acknowledged || kind === "blocked", "intake acknowledgment required");
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
        requireValue(!observation.retired || (task.phase === "done" && task.retired &&
          observation.liveness !== "live" && observation.evidence.length > 0), "retirement requires confirmed surface closure");
        task.observation = structuredClone(observation);
        if (task.worker && observation.liveness === "live" && Number.isSafeInteger(observation.pid) && observation.pid! > 1) task.worker.pid = observation.pid;
      }
      run.reconciled = true;
      this.event(run, "reconciled", "observations refreshed; reservations retained");
    });
  }
  /** `limits` is frozen at `init`, but `packet` copies it into every brief verbatim while
   * substituting only the leader header. Across a leadership transfer the two disagree: an
   * entry naming the *previous* leader, its surface, or its workspace as "current" sends the
   * worker to an identity that no longer exists, and a phase-scoped entry (an intake hold for
   * an already-finished task) parks its successor indefinitely. Both read as authority, so a
   * leader cannot ignore them and must not rewrite state to escape them. Replacing them is
   * therefore allowed at exactly this boundary — leadership transfer is already the
   * authority-changing operation, and it re-validates like `init` and is recorded as an event.
   * Omitting `limits` keeps the existing array, so an ordinary resume is unchanged. */
  resume(id: string, oldLeader: string, revision: number, newLeader: string, limits?: unknown): Run {
    return this.transaction(id, oldLeader, revision, run => {
      requireValue(nonempty(newLeader), "leader identity is required");
      requireValue(run.mode !== "complete", "engagement already complete");
      let replaced: string[] | undefined;
      if (limits !== undefined) {
        // A same-session resume is a legal no-op transfer, so without this the sitting
        // leader could rewrite the limits binding IT — the exact "rewrite state to escape
        // a limit" the doc above forbids. Only an incoming leader may replace them, and
        // `checkLeadershipTransfer` has already required the outgoing one to be not-live.
        requireValue(newLeader !== run.config.leader,
          "limits can only be replaced by an incoming leader; a leader cannot rewrite the limits binding itself");
        requireLimits(limits, "replacement limits must be a non-empty list of strings");
        replaced = run.config.limits;
        run.config.limits = structuredClone(limits);
      }
      run.config.leader = newLeader; run.epoch++; run.reconciled = false;
      if (run.mode === "stopped") run.mode = "running";
      for (const task of run.tasks) task.observation = undefined;
      // Record BOTH arrays. An operator auditing `status` later must be able to see which
      // authority line was dropped and what replaced it; "limits replaced" alone is unauditable.
      this.event(run, "resumed", `leader ${newLeader}; reconnect before dispatch${replaced === undefined ? ""
        : `; limits replaced from ${JSON.stringify(replaced)} to ${JSON.stringify(run.config.limits)}`}`);
    });
  }
  recover(id: string, leader: string, revision: number, taskId: string, token: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled, "resume and reconcile first");
      requireValue(active(task) || task.phase === "stopped", "task is not recoverable");
      requireValue(task.observation?.liveness === "dead", "replacement requires observed termination; unknown is not dead");
      // Reconnects spend maxRecoveries; a replacement launch spends maxAttempts (reserve increments it).
      requireValue(task.attempts < run.config.maxAttempts, "attempt budget exhausted");
      requireValue(!task.reconnect?.pending, "reconnect outcome is uncertain; observe it before replacement");
      requireValue(task.reconnect || task.recoveries >= run.config.maxRecoveries, "reconnect the existing session before replacement");
      requireValue(fresh(task.observation), "termination evidence is stale; reconcile again");
      // Replacement does not release the merge owner or erase integrationBase.
      // The leader can verify a merge that landed, or resume this task's PR.
      task.phase = "pending";
      this.db.prepare("DELETE FROM owners WHERE run=? AND task=? AND resource LIKE 'exclusive:%'").run(id, taskId);
      this.event(run, "recovery", "old worker observed terminal; existing worktree must be preserved", taskId);
    });
  }
  /** Explicit operator disposition of missing runtime records; never a claim of death.
   * The request is bound to this exact assignment revision and audited verbatim. */
  takeover(id: string, leader: string, revision: number, taskId: string, token: string,
    input: unknown, evidence: OrphanEvidence): Run {
    const request = parseTakeover(input);
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(request.run === id && request.task === taskId && request.token === token && request.revision === revision,
        "takeover request does not match the current assignment revision");
      requireValue(run.mode === "running" && run.reconciled, "resume and reconcile before takeover");
      requireValue(task.worker && (active(task) || task.phase === "stopped") && !["reserved", "stopping"].includes(task.phase), "takeover requires an attached assignment");
      requireValue(!task.reconnect?.pending, "unsettled reconnect prevents takeover");
      requireValue(task.attempts < run.config.maxAttempts, "attempt budget exhausted");
      requireValue(task.observation?.liveness === "unknown", "takeover is for an unknown worker; use normal lifecycle for live or dead workers");
      requireValue(fresh(task.observation) && fresh({ ...task.observation, observedAt: evidence.observedAt }), "takeover evidence is stale; reconcile again");
      requireValue(JSON.stringify(evidence.worker) === JSON.stringify(task.worker), "takeover evidence worker mismatch");
      requireValue(evidence.checks.length === ORPHAN_CHECKS.length && ORPHAN_CHECKS.every(c => evidence.checks.includes(c)), "incomplete orphan evidence");
      // Discovery awaits external commands; recheck occupancy inside the transaction.
      assertAbsentWorktree(request.worktree);
      const worktree = canonicalWorktree(request.worktree);
      requireValue(evidence.replacementWorktree === worktree, "takeover evidence worktree mismatch");
      requireValue(worktree !== canonicalWorktree(task.spec.worktree) && worktree !== canonicalWorktree(task.spec.repo), "takeover requires a fresh isolated worktree");
      requireValue(!run.tasks.some(t => t !== task && canonicalWorktree(t.spec.worktree) === worktree), "duplicate worktree ownership");
      // Limits apply to the whole run: do not rewrite unrelated tasks' authority here.
      requireValue(request.limits === undefined || run.tasks.length === 1, "takeover limits replacement requires a single-task engagement");
      this.own(run, task, [`tree:${worktree}`]);
      const record: TakeoverRecord = { request, evidence: structuredClone(evidence),
        previousSpec: structuredClone(task.spec), previousLimits: [...run.config.limits],
        previousObservation: structuredClone(task.observation), previousReport: structuredClone(task.report) };
      task.takeovers = [...(task.takeovers ?? []), record];
      task.spec = { ...task.spec, provider: request.provider, worktree, model: request.model, effort: request.effort };
      run.config.tasks = run.config.tasks.map(t => t.id === taskId ? structuredClone(task.spec) : t);
      if (request.limits) run.config.limits = [...request.limits];
      // Keep all owner rows, PR reports, merge bases, budgets and saved identities.
      // Only reserve() spends a new launch. The old token is invalid immediately.
      // A fresh fence token also lets Gru settle an already-landed retained merge
      // before reserving a replacement; there is no worker or launch attached to it.
      task.token = randomUUID(); task.worker = undefined; task.observation = undefined;
      task.acknowledged = undefined; task.reconnect = undefined; task.stoppedFrom = undefined;
      task.phase = "pending";
      this.event(run, "operator-takeover", JSON.stringify(record), taskId);
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
      task.phase = task.reconnect.phase; task.stoppedFrom = undefined;
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
      requireValue(run.mode === "running" && run.reconciled && verificationReady(task), "integration and independent verification required");
      requireValue(evidence.base === task.integrationBase, "integration base changed; rebase and reverify");
      for (const sha of [evidence.head, evidence.base, evidence.merge]) requireValue(/^[0-9a-f]{40,64}$/.test(sha), "invalid evidence revision");
      requireValue(nonempty(evidence.pr) && nonempty(evidence.review) && nonempty(evidence.verifiedAt), "PR, review, and verification evidence required");
      requireValue(evidence.ticketState === "done" || evidence.ticketState === "Closed", "repository completion milestone not recorded in Alfred");
      requireValue(evidence.checks.length === task.spec.checks.length, "missing completion checks");
      task.spec.checks.forEach((argv, i) => requireValue(JSON.stringify(evidence.checks[i].argv) === JSON.stringify(argv) && evidence.checks[i].exitCode === 0 && nonempty(evidence.checks[i].log), "check failed, changed, or missing output"));
      // Clear `stoppedFrom` with the phase, as `reserve` and `finishReconnect` already do.
      // `verificationReady` admits `stopped` + `stoppedFrom: "integrating"` (a stop that froze
      // an in-flight integration), so settling that merge leaves a verified task reporting
      // `phase: "done", stoppedFrom: "integrating"` in `gru status` — a done task that still
      // claims it was cancelled mid-integration, which is the state a leader reads to decide
      // whether work is outstanding.
      task.evidence = structuredClone(evidence); task.phase = "done"; task.stoppedFrom = undefined;
      // Completion releases integration gates, but a saved session still owns its tree.
      this.db.prepare("DELETE FROM owners WHERE run=? AND task=? AND (resource LIKE 'merge:%' OR resource LIKE 'merge-resource:%' OR resource LIKE 'exclusive:%')").run(id, taskId);
      if (run.tasks.every(t => t.phase === "done")) run.mode = "complete";
      this.event(run, "verified", evidence.merge, taskId);
    });
  }
  retire(id: string, leader: string, revision: number, taskId: string, token: string, surface: string): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(task.phase === "done" && task.worker?.surface === surface, "retirement must match the verified worker");
      task.retired = { surface, at: new Date().toISOString() };
      task.observation = undefined;
      this.event(run, "retired", `Hermod closed surface ${surface}; saved-session ownership retained`, taskId);
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
      requireValue(!task.reconnect?.pending || task.observation?.liveness === "live", "unsettled startup cannot be stopped using old process death");
      requireValue(fresh(task.observation), "worker evidence is stale; reconcile again");
      task.phase = "stopped";
      // Worktree and ticket stay reserved for this resumable engagement.
      if (!run.tasks.some(active)) run.mode = "stopped";
      this.event(run, "stopped", "worker terminal; worktree retained", taskId);
    });
  }
}
