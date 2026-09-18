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
  "review" | "integrating" | "done" | "stopping" | "stopped" | "swept";
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
/** Git facts behind binding a worker Hermod placed outside the declared worktree. */
export interface WorktreeAdoption {
  observedAt: string;
  declared: string;
  observed: string;
  /** `git rev-parse --show-toplevel`, `--git-dir`, `--git-common-dir`, run in the observed path. */
  toplevel: string;
  gitDir: string;
  commonDir: string;
  repositoryKey: string;
  branch?: string;
  checks: string[];
}
export const ADOPTION_CHECKS = ["observed path is a worktree root", "linked worktree, not a primary checkout",
  "same repository identity", "directory or branch names the ticket"];
/** Git facts behind an integration grant's base, gathered against the task's own repository.
 * The store validates the SHA's shape; only this evidence can say the SHA is a commit that
 * repository holds and is the tip the base branch actually has right now. */
export interface BaseEvidence {
  observedAt: string;
  /** `canonicalRepository` of the task's repo, so a foreign checkout's tip cannot stand in. */
  repositoryKey: string;
  /** The base branch the tip was read from, without the `refs/heads/` prefix. */
  ref: string;
  /** `origin/<ref>` as this observation fetched it. */
  tip: string;
  /** The SHA the leader supplied, resolved to a commit in that repository. */
  base: string;
  /** Verified merges confirmed as ancestors of `base`; the store names the ones missing. */
  contains: string[];
  checks: string[];
}
export const BASE_CHECKS = ["base branch fetched from origin", "base resolves to a commit in the task repository",
  "verified merges compared against the base"];
/** The ticket as a whole name segment, so STARK-50 never matches STARK-501 or a longer word. */
export function namesTicket(ticket: string, ...names: (string | undefined)[]): boolean {
  const literal = ticket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${literal}($|[^A-Za-z0-9])`);
  return names.some(name => name !== undefined && pattern.test(name));
}
export interface TakeoverRecord {
  request: TakeoverRequest;
  evidence: OrphanEvidence;
  previousSpec: TaskSpec;
  previousLimits: string[];
  previousObservation?: Observation;
  previousReport?: Assignment["report"];
}
/** What one sweep observed for one task, under `reconcile`'s own observation rules. */
export interface SweepTaskEvidence {
  /** The bound worker's observation; `unknown` when no worker is bound. */
  observation: Observation;
  /** Both the task's discovery namespace and the unscoped one occupancy is read from
   * reported themselves complete; absence inside either incomplete view proves nothing. */
  complete: boolean;
}
/** A live or uncertain Hermod peer of any provider, or a saved session whose pid probes alive,
 * with its working directory canonicalized. */
export interface SweepPeer {
  /** The peer id, or `session:<id>` for a live saved session the peer view does not list. */
  id: string;
  agent: string;
  /** Undefined when Hermod could not resolve it. */
  cwd?: string;
}
export interface SweepEvidence {
  /** Stamped before Alfred and Hermod were queried, so slow commands cannot look fresh. */
  observedAt: string;
  /** The engagement the evidence was gathered for. Task ids and tickets repeat across engagements
   * (a corrected run reuses both), so a revision alone cannot tell one run's evidence from another's. */
  run: string;
  /** The engagement revision the evidence was gathered against; `sweep` refuses any other. */
  revision: number;
  tickets: Record<string, string>;
  tasks: Record<string, SweepTaskEvidence>;
  /** Every live or uncertain peer in the unscoped view, plus every live saved session it omits;
   * the store checks them against the worktrees a task actually owns, which is exactly what a
   * release deletes. */
  peers: SweepPeer[];
}
export interface SweepVerdict {
  task: string;
  ticket: string;
  phase: Phase;
  ticketState: string;
  action: "release" | "held";
  reason: string;
}
export const SWEEP_AUTHORITY = "proof-based sweep, not a leader action";
/** The audit trail of one release: who invoked it, which leader it bypassed, and the proof. */
export interface SweepRecord {
  authority: typeof SWEEP_AUTHORITY;
  invokedBy: string | null;
  leaderOfRecord: string;
  revision: number;
  epoch: number;
  verdict: SweepVerdict;
  stoppedFrom?: Phase;
  worker?: Worker;
  evidence: SweepTaskEvidence & { observedAt: string; peers: SweepPeer[] };
  released: string[];
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
  /** The git evidence `integrate` accepted for `integrationBase`; retained for audit, and
   * read by the next grant in this repository to scope its verified-merge floor to one branch. */
  baseEvidence?: BaseEvidence;
  stoppedFrom?: Phase;
  reconnect?: { id: string; startedAt: string; phase: Phase; pending: boolean };
  evidence?: CompletionEvidence;
  takeovers?: TakeoverRecord[];
  swept?: SweepRecord;
}
export interface LeadershipEvidence {
  observedAt: string;
  incomplete: boolean;
  peers: { sessionId?: string; threadId?: string; liveness: string }[];
}
export interface LeadershipTransfer {
  previous: string;
  current: string;
  epoch: number;
  at: string;
  discovery: LeadershipEvidence;
}
/** Shared by resume and the worker's portable transfer receipt check. */
export function assertLeadershipTransfer(previous: string, evidence: LeadershipEvidence): void {
  requireValue(evidence?.incomplete === false && Array.isArray(evidence.peers),
    "Hermod discovery incomplete; cannot transfer leadership");
  requireValue(Number.isFinite(Date.parse(evidence.observedAt)), "invalid leadership observation time");
  requireValue(evidence.peers.every(p => p && typeof p.liveness === "string"), "invalid leadership peer evidence");
  requireValue(!evidence.peers.some(p => (p.threadId || p.sessionId) === previous && p.liveness === "live"),
    "previous leader is still live; interrupt it before transferring leadership");
}
export interface Run {
  schema: 1;
  config: Engagement;
  revision: number;
  epoch: number;
  mode: "running" | "stopping" | "stopped" | "complete" | "swept";
  reconciled: boolean;
  received: string[];
  transfers?: LeadershipTransfer[];
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
const active = (t: Assignment) => !["pending", "done", "stopped", "swept"].includes(t.phase);
// Completed workers release slots with fresh idle/dead or confirmed-retirement
// evidence. Unconfirmed or still-busy workers count toward the concurrency limit.
const occupiesSlot = (t: Assignment) => active(t) || Boolean(t.worker &&
  !(fresh(t.observation) && (t.observation?.liveness === "dead" ||
    (t.phase === "done" && (t.observation?.retired ||
      (t.observation?.liveness === "live" && t.observation.activity === "idle"))))));
export const repositoryKey = (t: TaskSpec) => t.repositoryKey ?? t.repo;
/** Evidence is complete only when it names exactly the required checks. */
const completeChecks = (checks: string[], required: readonly string[]) =>
  checks.length === required.length && required.every(c => checks.includes(c));
const reservationResources = (task: Assignment) => [`ticket:${task.spec.ticket}`, `tree:${path.resolve(task.spec.worktree)}`,
  ...task.spec.exclusiveResources.map(r => `exclusive:${r}`)];
const workerResources = (worker: Worker) => [`worker:${worker.id}`, `session:${worker.provider}:${worker.session}`, `surface:${worker.surface}`];
export const fresh = (o?: Pick<Observation, "observedAt">) => Boolean(o && Date.now() - Date.parse(o.observedAt) <= 60_000 && Date.parse(o.observedAt) <= Date.now() + 5_000);

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

/** Alfred's completion states: the one predicate `complete` and `sweep` both apply. */
export const ticketClosed = (state: string) => state === "done" || state === "Closed";

/** Tasks a sweep evaluates. A `pending` task no reservation ever touched holds nothing:
 * `reserve` writes the first owner rows and spends the first attempt. `done` stays out on
 * purpose — completion retains ticket, worktree, and saved-session ownership by design. */
export function sweepCandidates(run: Run): Assignment[] {
  return run.tasks.filter(t => t.phase !== "done" && t.phase !== "swept" && (t.phase !== "pending" || t.attempts > 0));
}

/** The release rule. Alfred must report the ticket closed AND no live Hermod peer may be
 * bound to the task; anything uncertain is held. Elapsed time is never evidence.
 * `owned` lists a task's owner rows: a release deletes every `tree:` row, however it was
 * acquired (reserve, takeover, adoption), so occupancy is checked against all of them, and
 * against any directory naming the ticket, where Hermod may have placed an unattached launch. */
export function sweepVerdicts(run: Run, evidence: SweepEvidence, owned: (taskId: string) => readonly string[]): SweepVerdict[] {
  // Another engagement's evidence can carry the same revision, task ids, and tickets, and its
  // terminated worker would then release this run's live one.
  requireValue(evidence.run === run.config.id, `sweep evidence was gathered for engagement ${evidence.run}, not ${run.config.id}; sweep again`);
  return sweepCandidates(run).map(task => {
    const { id, ticket } = task.spec;
    const ticketState = evidence.tickets[ticket];
    const found = evidence.tasks[id];
    requireValue(nonempty(ticketState) && found, `sweep evidence is missing ${id}; sweep again`);
    const verdict = (action: SweepVerdict["action"], reason: string): SweepVerdict =>
      ({ task: id, ticket, phase: task.phase, ticketState, action, reason });
    if (!ticketClosed(ticketState)) return verdict("held", `ticket ${ticket} is ${ticketState}; an open ticket is never released`);
    // A worker closes its ticket at merge, before Gru verifies, and `verify` settles a
    // retained merge. Releasing that grant would strand the verification and its dependents.
    // `verify` needs a merged PR, so a grant whose PR never merged stays held here too.
    if (task.integrationBase) return verdict("held", `holds an integration grant at ${task.integrationBase}; settle it with verify once its PR merges`);
    if (task.reconnect?.pending) return verdict("held", "reconnect outcome is uncertain; old process death does not settle startup");
    // `reserve` records intent, not startup. A running engagement's leader may still be
    // launching into this reservation, and Hermod cannot show a launch before it registers.
    if (!task.worker && task.phase === "reserved" && run.mode === "running") {
      return verdict("held", "launch reserved in a running engagement may still be starting; stop the engagement before sweeping");
    }
    if (task.worker && found.observation.liveness !== "dead") {
      return verdict("held", `worker ${task.worker.id} observed ${found.observation.liveness}; only observed termination releases it`);
    }
    // An unattached launch is uncertain, not absent: it may be running in its reserved worktree.
    if (!found.complete) return verdict("held", "Hermod discovery incomplete; absence proves nothing");
    const trees = owned(id).filter(r => r.startsWith("tree:")).map(r => canonicalWorktree(r.slice("tree:".length)));
    // A same-provider peer whose cwd Hermod could not resolve may be this task's launch. An empty or
    // relative cwd is unresolved too: it names no place, and resolving it would use the sweeper's own.
    const placed = (p: SweepPeer) => typeof p.cwd === "string" && path.isAbsolute(p.cwd) ? p.cwd : undefined;
    const occupants = evidence.peers.filter(p => {
      const cwd = placed(p);
      return cwd === undefined ? p.agent === task.spec.provider : trees.some(tree => (cwd + "/").startsWith(tree + "/"));
    }).map(p => p.id);
    if (occupants.length > 0) return verdict("held", `Hermod peer ${occupants.join(", ")} occupies a worktree this task owns (${trees.join(", ")})`);
    // Hermod places a launch at its own path, not the declared one (see `adopt`), and a launch that
    // never attached owns no `tree:` row there. A live peer in a directory naming the ticket may be it.
    const named = evidence.peers.filter(p => { const cwd = placed(p); return cwd !== undefined && namesTicket(ticket, cwd); });
    if (named.length > 0) {
      return verdict("held", `Hermod peer ${named.map(p => `${p.id} (${p.cwd})`).join(", ")} works in a directory naming ${ticket}; it may be this task's launch outside the worktrees it owns`);
    }
    return verdict("release", task.worker
      ? `ticket ${ticketState}; worker ${task.worker.id} observed terminal (${found.observation.evidence.join("; ")})`
      : `ticket ${ticketState}; no worker attached`);
  });
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

/** Why `worker` cannot bind to `task` regardless of its worktree, or null. `GruStore.attachRefusal`
 * adds identity ownership; the CLI asks that before inspecting git, so an ineligible peer hears
 * its identity refusal, not an adoption verdict. */
function attachRefusal(run: Run, task: Assignment, worker: Worker): string | null {
  // A reservation whose launch is not yet bound, including one that surfaced after `stop`.
  const awaiting = (run.mode === "running" && task.phase === "reserved") ||
    (run.mode === "stopping" && task.phase === "stopping" && task.stoppedFrom === "reserved" && !task.worker);
  if (!awaiting) return "no pending launch to attach";
  for (const key of ["id", "session", "surface", "workspace", "worktree"] as const) if (!nonempty(worker[key])) return `worker ${key} is required`;
  if (worker.provider !== task.spec.provider) return "provider substitution refused";
  if (worker.session === run.config.leader) return "the leader cannot attach as its own worker";
  if (task.takeovers?.some(t => t.evidence.worker.id === worker.id ||
    t.evidence.worker.session === worker.session || t.evidence.worker.surface === worker.surface)) return "fenced worker cannot reattach after takeover";
  return null;
}

/** Every merge this engagement has verified into `task`'s repository, in task order. The CLI
 * passes these to the observation so it can test each one's ancestry; the store then decides
 * which of them this grant's base must contain. Ancestry is checked against the whole
 * repository's verified merges rather than the ref-scoped subset below, because the observation
 * resolves the base ref itself and a merge it cannot place is simply reported as not contained. */
export function verifiedMerges(run: Run, task: Assignment): string[] {
  return run.tasks.filter(t => t !== task && t.phase === "done" && t.evidence &&
    repositoryKey(t.spec) === repositoryKey(task.spec)).map(t => t.evidence!.merge);
}
/** Why `evidence` cannot authorize a grant of `base` for `task`, or null. Pure: the observation
 * gathers git facts, this decides. The tip comparison is what closes the stale-base window —
 * `verify` only requires the base in the merged head's ancestry, so a base that predates another
 * task's merge lets a diff built without those changes squash cleanly whenever git sees no
 * textual conflict. The verified-merge floor is the second, offline check: it holds even if the
 * fetched tip is itself wrong (a force-pushed or mirrored base branch). */
function baseRefusal(run: Run, task: Assignment, base: string, evidence: BaseEvidence): string | null {
  if (!completeChecks(evidence.checks, BASE_CHECKS)) return "incomplete integration base evidence";
  if (!fresh(evidence)) return "integration base evidence is stale; fetch the base branch again";
  const expected = repositoryKey(task.spec);
  if (evidence.repositoryKey !== expected) return `integration base observed in ${evidence.repositoryKey}, not ${expected}`;
  if (evidence.base !== base) return "integration base evidence does not cover the supplied SHA";
  if (!nonempty(evidence.ref)) return "integration base evidence names no base branch";
  if (evidence.tip !== base) return `integration base ${base} is not the current ${evidence.ref} tip ${evidence.tip}; fetch again and grant at the tip`;
  // Scope the floor to one base branch: a repository that also takes merges on a release
  // branch must not refuse a perfectly current `main` tip for lacking them. A grant recorded
  // before this evidence existed has no ref to compare, so it counts — fail closed.
  const missing = run.tasks.filter(t => t !== task && t.phase === "done" && t.evidence &&
    repositoryKey(t.spec) === expected && (t.baseEvidence === undefined || t.baseEvidence.ref === evidence.ref))
    .map(t => t.evidence!.merge).filter(sha => !evidence.contains.includes(sha));
  if (missing.length > 0) return `integration base ${base} does not contain verified merge ${missing[0]}; fetch again and grant at the tip`;
  return null;
}

/** Mode, phase, budget, capacity, and dependency checks. Ownership lives only in the store's
 * owner rows (ticket, worktree, `exclusive:`), which `GruStore.readyReason` adds: `reserve`
 * inserts them, and only `recover`, `complete`, and `sweep` delete `exclusive:` rows, so a
 * stopped or taken-over task keeps its exclusive resources without a second in-memory copy.
 * Declared `files` are never ownership: parallel workers edit separate worktrees, and overlap
 * reconciles at the rebase before merge, serialized by the repository merge lock. */
export function readyReason(run: Run, task: Assignment): string | null {
  if (run.mode !== "running") return `engagement is ${run.mode}`;
  if (!run.reconciled) return "reconcile existing workers first";
  if (task.phase !== "pending") return `task is ${task.phase}`;
  if (task.attempts >= run.config.maxAttempts) return "attempt budget exhausted";
  if (run.tasks.filter(occupiesSlot).length >= run.config.maxWorkers) return "worker limit reached";
  for (const id of task.spec.dependsOn) {
    if (run.tasks.find(t => t.spec.id === id)?.phase !== "done") return `prerequisite ${id} is unverified`;
  }
  return null;
}

/** One SQLite transaction serializes state and ownership, across leader processes. */
export class GruStore {
  private db: DatabaseSync;
  /** `readOnly` inspects an existing store without changing it: no directory creation, permission
   * change, journal-mode switch, or schema DDL, and every write is refused. SQLite still creates the
   * WAL store's `-wal`/`-shm` sidecars beside it when absent, with the store file's own permissions. */
  constructor(file: string, options: { readOnly?: boolean } = {}) {
    if (options.readOnly) {
      this.db = new DatabaseSync(file, { readOnly: true });
      this.db.exec("PRAGMA busy_timeout=5000;");
      return;
    }
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
  /** Every engagement in this store. */
  list(): Run[] {
    return (this.db.prepare("SELECT body FROM runs ORDER BY id").all() as { body: string }[]).map(row => JSON.parse(row.body) as Run);
  }
  /** Resources this task currently owns, in a stable order. */
  owned(id: string, taskId: string): string[] {
    return (this.db.prepare("SELECT resource FROM owners WHERE run=? AND task=? ORDER BY resource").all(id, taskId) as { resource: string }[]).map(row => row.resource);
  }
  /** The release rule against this store's owner rows; `sweep` applies the same verdicts. */
  sweepVerdicts(run: Run, evidence: SweepEvidence): SweepVerdict[] {
    return sweepVerdicts(run, evidence, taskId => this.owned(run.config.id, taskId));
  }
  /** Every other engagement in this store, for adoption's declared-worktree check. */
  private others(id: string): Run[] {
    return (this.db.prepare("SELECT body FROM runs WHERE id<>?").all(id) as { body: string }[]).map(row => JSON.parse(row.body) as Run);
  }
  /** Readiness plus reserved-resource ownership (ticket, worktree, exclusive) across engagements. */
  readyReason(run: Run, task: Assignment): string | null {
    return readyReason(run, task) ?? this.ownedElsewhere(run, task, reservationResources(task));
  }
  /** Every task's reason at once, for `status`. */
  readyReasons(run: Run): Map<string, string | null> {
    return new Map(run.tasks.map(task => [task.spec.id, this.readyReason(run, task)]));
  }
  /** The first resource another assignment owns, as a refusal, or null. */
  private ownedElsewhere(run: Run, task: Assignment, resources: string[]): string | null {
    for (const resource of resources) {
      const owner = this.db.prepare("SELECT run,task FROM owners WHERE resource=?").get(resource) as { run: string; task: string } | undefined;
      // Name the holder: with overlap no longer gating dispatch, merge-lock contention is routine,
      // and 'wait for a live peer' versus 'a dead engagement still holds it' read identically without it.
      if (owner && (owner.run !== run.config.id || owner.task !== task.spec.id)) return `resource already owned: ${resource} (${owner.run}/${owner.task})`;
    }
    return null;
  }
  /** Every identity refusal `attach` makes, ownership included, without writing. The CLI asks
   * this before inspecting git: a peer already bound elsewhere must not hear a worktree verdict. */
  attachRefusal(run: Run, task: Assignment, worker: Worker): string | null {
    return attachRefusal(run, task, worker) ?? this.ownedElsewhere(run, task, workerResources(worker));
  }
  create(input: unknown): Run {
    const config = parseEngagement(input);
    const run: Run = { schema: 1, config, revision: 0, epoch: 1, mode: "running", reconciled: false, received: [],
      tasks: config.tasks.map(spec => ({ spec, phase: "pending", attempts: 0, recoveries: 0 })), events: [] };
    this.db.prepare("INSERT INTO runs (id,body) VALUES (?,?)").run(config.id, JSON.stringify(run));
    return run;
  }
  private transaction(id: string, leader: string, revision: number, fn: (run: Run) => void | boolean): Run {
    return this.write(id, revision, run => requireValue(run.config.leader === leader, "stale leader; resume and reconcile before writing"), fn);
  }
  /** The fence every write shares, led or not: an exclusive re-read, then the exact revision. */
  private write(id: string, revision: number, authorize: (run: Run) => void, fn: (run: Run) => void | boolean): Run {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.read(id);
      authorize(run);
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
    const refusal = this.ownedElsewhere(run, task, resources);
    requireValue(refusal === null, refusal!);
    for (const resource of resources) {
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
  /** A worker outside the declared worktree binds only with `adoption` evidence: its checkout
   * must be a linked worktree of the same repository that names the ticket and that no other
   * task declares or owns. Adoption issues a new token; read it from the returned run. Refusing every mismatch stranded the reservation — the launched
   * worker was live, unbound, and so neither attachable, interruptible, nor recoverable. */
  attach(id: string, leader: string, revision: number, taskId: string, token: string, worker: Worker, adoption?: WorktreeAdoption): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      // Identity refusals first: a fenced or already-bound worker must hear that, not a worktree-adoption verdict.
      const refusal = this.attachRefusal(run, task, worker);
      requireValue(refusal === null, refusal!);
      const stoppingLaunch = run.mode === "stopping";
      const observed = canonicalWorktree(worker.worktree);
      const declared = canonicalWorktree(task.spec.worktree);
      if (observed !== declared) this.adopt(run, task, observed, declared, adoption);
      this.own(run, task, workerResources(worker));
      task.worker = { ...structuredClone(worker), worktree: observed };
      if (stoppingLaunch) task.stoppedFrom = "intake";
      else task.phase = "intake";
      this.event(run, "attached", worker.id, taskId);
    });
  }
  /** Runs inside `attach`'s transaction, so a later refusal rolls the adoption back too.
   * The declared tree stays owned by this task: nothing observed that path unoccupied. */
  private adopt(run: Run, task: Assignment, observed: string, declared: string, adoption?: WorktreeAdoption): void {
    requireValue(adoption, "worker worktree mismatch");
    requireValue(completeChecks(adoption.checks, ADOPTION_CHECKS), "incomplete worktree adoption evidence");
    requireValue(fresh(adoption), "worktree adoption evidence is stale; attach again");
    requireValue(adoption.observed === observed && adoption.declared === declared, "worktree adoption evidence mismatch");
    requireValue(adoption.toplevel === observed, `worker worktree mismatch: ${observed} is not a worktree root`);
    // Git keeps each linked worktree's private dir at <common>/worktrees/<name>.
    requireValue(nonempty(adoption.gitDir) && nonempty(adoption.commonDir) &&
      path.dirname(adoption.gitDir) === path.join(adoption.commonDir, "worktrees"),
      `worker worktree mismatch: ${observed} is not a linked worktree`);
    requireValue(adoption.repositoryKey === repositoryKey(task.spec), `worker worktree mismatch: ${observed} belongs to ${adoption.repositoryKey}`);
    requireValue(observed !== canonicalWorktree(task.spec.repo), "worker needs an isolated worktree");
    // Takeover moved this task to a fresh, absent worktree to preserve the orphan's checkout.
    // Its tree is still owned by this task, so `own` would admit it; Claude's
    // `--worktree=<ticket>` re-attaching a relaunch there must not undo the takeover.
    requireValue(!task.takeovers?.some(t => [t.previousSpec.worktree, t.evidence.worker.worktree].some(p => canonicalWorktree(p) === observed)),
      `worker worktree mismatch: ${observed} belongs to a fenced worker; takeover requires a fresh worktree`);
    requireValue(namesTicket(task.spec.ticket, path.basename(observed), adoption.branch), `worker worktree mismatch: ${observed} does not name ${task.spec.ticket}`);
    // A swept task released its worktree, and `reserve` already admits the path again;
    // its lingering declaration must not refuse the same path to adoption alone.
    const declaredBy = [run, ...this.others(run.config.id)].flatMap(r => r.tasks)
      // Stored worktrees are canonical already; compare them as `tree:` ownership keys do, off the filesystem.
      .find(t => t !== task && t.phase !== "swept" && path.resolve(t.spec.worktree) === observed);
    requireValue(!declaredBy, `worker worktree mismatch: ${observed} is declared by ${declaredBy?.spec.ticket}`);
    this.own(run, task, [`tree:${observed}`]);
    this.respec(run, task, { ...task.spec, worktree: observed });
    // The launch brief names the declared path under the old token. A new token refuses its
    // reports until the worker holds the regenerated packet, as takeover does for its respec.
    task.token = randomUUID();
    this.event(run, "worktree-adopted", JSON.stringify({ ...adoption, token: task.token }), task.spec.id);
  }
  /** The spec lives in both the assignment and the engagement config; rewrite them together. */
  private respec(run: Run, task: Assignment, spec: TaskSpec): void {
    task.spec = spec;
    run.config.tasks = run.config.tasks.map(t => t.id === spec.id ? structuredClone(spec) : t);
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
  resume(id: string, oldLeader: string, revision: number, newLeader: string, limits?: unknown, discovery?: LeadershipEvidence): Run {
    return this.transaction(id, oldLeader, revision, run => {
      requireValue(nonempty(newLeader), "leader identity is required");
      requireValue(run.mode !== "complete", "engagement already complete");
      requireValue(run.mode !== "swept", "engagement was swept; it is terminal");
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
      if (newLeader !== oldLeader) {
        requireValue(discovery, "leadership transfer requires complete discovery evidence");
        assertLeadershipTransfer(oldLeader, discovery);
        // Apply the exact window the worker's receipt check applies, against the timestamp this
        // record will actually carry: `fresh` tolerates an observation up to 5s in the FUTURE and
        // is evaluated before `at` is stamped, so at the boundary the store can persist a receipt
        // its only reader ("observed ≤ transferred ≤ observed + 60s") must refuse forever.
        const at = new Date();
        const observed = Date.parse(discovery.observedAt);
        requireValue(observed <= at.getTime() && at.getTime() - observed <= 60_000, "leadership discovery stale");
        (run.transfers ??= []).push({ previous: oldLeader, current: newLeader, epoch: run.epoch + 1,
          at: at.toISOString(), discovery: structuredClone(discovery) });
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
      requireValue(fresh(task.observation) && fresh(evidence), "takeover evidence is stale; reconcile again");
      requireValue(JSON.stringify(evidence.worker) === JSON.stringify(task.worker), "takeover evidence worker mismatch");
      requireValue(completeChecks(evidence.checks, ORPHAN_CHECKS), "incomplete orphan evidence");
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
      this.respec(run, task, { ...task.spec, provider: request.provider, worktree, model: request.model, effort: request.effort });
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
  integrate(id: string, leader: string, revision: number, taskId: string, token: string, base: string, evidence: BaseEvidence): Run {
    return this.transaction(id, leader, revision, run => {
      const task = this.task(run, taskId, token);
      requireValue(run.mode === "running" && run.reconciled && task.phase === "review", "task is not ready for integration");
      requireValue(/^[0-9a-f]{40,64}$/.test(base), "integration requires an observed base SHA");
      // The shape check above admits a foreign-repository SHA, a typo, and an hour-stale tip
      // alike; only the observation can tell them from the tip this repository has right now.
      const refusal = baseRefusal(run, task, base, evidence);
      requireValue(refusal === null, refusal!);
      // Repository-wide serialization also covers undeclared release-file seams.
      this.own(run, task, [`merge:${repositoryKey(task.spec)}`, ...task.spec.mergeResources.map(r => `merge-resource:${r}`)]);
      task.integrationBase = base; task.baseEvidence = structuredClone(evidence); task.phase = "integrating";
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
      requireValue(ticketClosed(evidence.ticketState), "repository completion milestone not recorded in Alfred");
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
      this.event(run, "verified", evidence.merge, taskId);
      this.settle(run);
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
      requireValue(run.mode !== "swept", "engagement was swept; it is terminal");
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
  /** Maintenance, not leadership: releases what `sweepVerdicts` proves dead. No leader identity
   * is required, because the leader may be gone; the exact revision the evidence was gathered
   * against still fences it. Verdicts are recomputed here, never trusted from the caller. */
  sweep(id: string, revision: number, evidence: SweepEvidence, invokedBy: string | null): { run: Run; verdicts: SweepVerdict[] } {
    let verdicts: SweepVerdict[] = [];
    const run = this.write(id, revision, () => undefined, run => {
      // The write fence proves the run is at `revision`, not that the evidence was read there.
      requireValue(evidence.revision === revision, "sweep evidence was gathered at another revision; sweep again");
      verdicts = this.sweepVerdicts(run, evidence);
      const releases = verdicts.filter(v => v.action === "release");
      if (releases.length === 0) return false;
      requireValue(fresh(evidence), "sweep evidence is stale; sweep again");
      for (const verdict of releases) {
        const task = this.task(run, verdict.task);
        const record: SweepRecord = { authority: SWEEP_AUTHORITY, invokedBy, leaderOfRecord: run.config.leader,
          revision, epoch: run.epoch, verdict, ...(task.stoppedFrom ? { stoppedFrom: task.stoppedFrom } : {}),
          ...(task.worker ? { worker: structuredClone(task.worker) } : {}),
          evidence: { ...structuredClone(evidence.tasks[task.spec.id]), observedAt: evidence.observedAt, peers: structuredClone(evidence.peers) },
          released: this.owned(id, task.spec.id) };
        this.db.prepare("DELETE FROM owners WHERE run=? AND task=?").run(id, task.spec.id);
        // The record keeps the worker for audit; the task drops it, so no capacity rule or
        // later reconcile keeps observing a released identity.
        task.phase = "swept"; task.stoppedFrom = undefined; task.worker = undefined; task.observation = undefined; task.swept = record;
        this.event(run, "swept", JSON.stringify(record), task.spec.id);
      }
      if (!this.settle(run) && run.mode === "stopping" && !run.tasks.some(active)) run.mode = "stopped";
    });
    return { run, verdicts };
  }
  /** The one terminal-mode rule `complete` and `sweep` share. Every task verified is `complete`;
   * every task verified or swept, with at least one swept, is terminal `swept`. Applying it in
   * `sweep` alone would leave a partially swept run `running` forever once its last task is
   * verified: `sweep` then has no candidate left, so it never runs again to settle the mode. */
  private settle(run: Run): boolean {
    if (run.tasks.every(t => t.phase === "done")) { run.mode = "complete"; return true; }
    if (!run.tasks.every(t => t.phase === "done" || t.phase === "swept")) return false;
    run.mode = "swept";
    this.event(run, "swept", `every task verified or released; engagement terminal (${SWEEP_AUTHORITY})`);
    return true;
  }
}
