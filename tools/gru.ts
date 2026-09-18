#!/usr/bin/env node
/** Gru's durable action boundary. The `gru` skill owns the agentic loop. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { canonicalWorktree, completionSummary, GruStore, integrationReady, parseEngagement, parseSettlement, parseTakeover, verificationReady } from "./gru_lib.ts";
import type { Assignment, Engagement } from "./gru_lib.ts";
import { canonicalRepository, checkLeadershipTransfer, checkRebrief, defaultBaseRef, discoverWorker, inspectAdoption, inspectUnreviewedMerge, interruptWorker, observeBase, observeOrphan, observeSweep, observeWorkers, packet, receive, reconnectWorker, retireWorker, validateReconnect, verifyCompletion, workerFromPeer } from "./gru_runtime_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

const HELP = `Gru: durable Minion ownership, recovery, and verification.

Usage: node tools/gru.ts <command> [options]

  init         --file engagement.json
  status       --run ID
  reconcile    --run ID --revision N
  reserve      --run ID --revision N --task ID
  packet       --run ID --task ID
  rebrief-check --message ID --run ID --task ID --current-leader SESSION [--current-message ID]
  attach       --run ID --revision N --task ID --token TOKEN --peer PEER_ID
  receive      --run ID --revision N --message HERMOD_MESSAGE_ID
  resume       --run ID --revision N [--limits-file limits.json]
  continue     --run ID --revision N --task ID --token TOKEN
  reconnect    --run ID --revision N --task ID --token TOKEN
  reconnected  --run ID --revision N --task ID --token TOKEN
  recover      --run ID --revision N --task ID --token TOKEN
  takeover     --run ID --revision N --task ID --token TOKEN --file operator-request.json
  settle       --run ID --revision N --task ID --token TOKEN --file operator-request.json
  integrate    --run ID --revision N --task ID --token TOKEN --base SHA [--base-ref BRANCH]
  verify       --run ID --revision N --task ID --token TOKEN --pr N --review N
  stop         --run ID --revision N
  interrupt    --run ID --revision N --task ID --token TOKEN
  stopped      --run ID --revision N --task ID --token TOKEN
  retire       --run ID --revision N --task ID --token TOKEN
  sweep        [--run ID] [--apply]

Every command returns JSON. packet returns the complete worker brief as text.
Writes require the current leader identity and an exact state revision; sweep is
the one maintenance write that needs no leader.
The leader identity is CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID from the
environment (legacy CLAUDE_SESSION_ID is accepted); --leader is the fallback.
State defaults to ~/.stark/gru/state.sqlite, shared across runtimes.
rebrief-check reads only Hermod, never that database. Its session identity is the worker.
Pass the current accepted leader and latest accepted message id, if any. To reread that
packet after resumption, use its id for both --message and --current-message.
Only exit 0 accepts the returned body; retain messageId for the next check.
--state PATH overrides the database. --help, -h, help exit without side effects.

reserve records intent, not successful startup. Launch through Hermod only.
attach requires a live Hermod peer; receive requires a confirmed worker message.
A peer outside the declared worktree attaches only from a linked worktree root of the
same repository whose directory or branch names the ticket, with no other unswept task
declaring it, no other task owning it, and no takeover having fenced it; attach then
adopts that path, audited, and issues a new token for the fresh packet. Anything else
refuses, as does the leader's own session; identity refusals are named before git is read.
init records each task's base branch — the "baseRef" field, else the default branch origin
itself reports — and refuses rather than leaving it unset, so the worker is briefed with
that branch in its FIRST packet, long before it opens a PR. Declaring it also skips the
lookup, which is the only way to run init with no network.
integrate checks --base against the repository, not just its hex shape: it fetches the
base branch from origin (the task's recorded baseRef, or --base-ref BRANCH to override it
for one grant, else the default branch origin reports, asked of origin rather than read
from the local refs/remotes/origin/HEAD) and refuses unless the SHA is a commit that
repository holds and is that branch's current tip, which already implies every merge
landed on that branch. A refusal names the current tip.
A failed fetch, an unreachable origin, an origin reporting no default branch, or a shallow
checkout (which verify cannot walk after the merge) refuses too, and says which. It never
walks history: the shallow probe is one local call, not an ancestry comparison.
verify settles against the branch the grant was actually taken on, and refuses a PR that
merged into any other. Prefer declaring baseRef over reaching for --base-ref: a grant
cannot be retaken once the task is integrating.
reconcile never equates missing discovery with death. Keep uncertain reservations.
stop freezes dispatch; use Hermod to interrupt workers and observe termination.
verify reruns declared checks in a disposable detached worktree, on fetched main.
It requires a merged PR, posted head-matching review, and Alfred completion.
Replacement retains pending merge grants. verify can settle an earlier merge
until the replacement attaches, or after stop froze an in-flight integration,
and never while a reconnect is unsettled. Once attached, the replacement must
report ready and receive its own integration grant first; cancelling it mid-work
leaves it resumable through continue, not verifiable.
Each check is bounded by the task's checkTimeoutMs (default 30 minutes).
Verification removes its disposable checkout and retains its logs.
When every task is verified the engagement completes; session ownership remains.
No command publishes, changes authentication, or deletes worker/session worktrees.
takeover requires explicit operator authorization bound to the run/task/token/revision.
It checks complete Hermod absence, fences the old worker, preserves budgets and merge
ownership, and permits an explicitly selected provider/new worktree. Unknown stays unknown.
settle requires --file with run/task/token/revision, a GitHub pr URL, noReview: true,
reason, and the operator's actual operatorRequest. Never author your own authorization.
It requires the current leader, running/reconciled state, the same integration phase,
merged PR, both ancestry checks, closed ticket and green disposable checks as verify.
GitHub must report zero reviews. It records settled-without-review, releases only merge
resources, and reports released-unverified with the reason, never verified. Dependencies
remain blocked. A fully settled engagement is terminal released-unverified, not complete.
sweep releases a held task only on proof, never on elapsed time: Alfred (read from a
recorded repository, else this directory, that reads the handle) reports its ticket
done or Closed, it holds no integration grant or uncertain reconnect, it is not a
reserved launch in a running engagement, any bound worker is observed terminal, and
complete Hermod discovery finds no live or uncertain peer, and no saved session whose
pid probes alive, in any worktree it owns or any directory naming its ticket.
Without --run it evaluates every engagement.
It is a read-only dry run unless --apply; --apply fences on the exact revision, records
a swept event naming the proof, and ends a run whose tasks are all verified or
released. Alfred or Hermod failure exits non-zero with nothing released.
After settlement sweep can release the remaining resources on that same proof; status
and the completion summary retain released-unverified and the reason even after sweep.
`;

/** The one base a grant may name, shared by the three hints below so they cannot drift.
 * There is no "take the lock, then read the tip" ordering to prescribe: `integrate` takes
 * `merge:<repo>` in the same transaction that records the base, and refuses a second call
 * once the phase is `integrating`. `integrate` fetches the base branch itself and refuses
 * anything but that tip, so this text describes an enforced rule, not an obligation the
 * leader carries alone; the lock refusal still names the task to wait for. */
const GRANT_BASE = "at the base branch tip fetched immediately before the grant";

/** Explain why `verificationReady` refused, naming the command that actually repairs it.
 * `integrate` only accepts phase `review`, so it is the wrong instruction everywhere else;
 * a stopped worker needs `continue`, an in-flight one needs its own READY report
 * first. NOT `reserve` for either: `readyReason` refuses every phase except
 * `pending`, so prescribing it hands over a command that throws — the exact defect
 * this function exists to remove. The `stopped` branch below says the same thing.
 *
 * No `stopping` case on purpose: `verify` refuses unless `run.mode === "running"` (see the
 * call site), and `stop()` is the only writer of phase `stopping` — it sets the whole run to
 * `stopping`/`stopped` in the same transaction, and `resume()` only maps `stopped` back to
 * `running`, which requires no task to be active, which `stopping` is. So a `stopping` task
 * can never reach this function; a branch for it is dead text that reads as live guidance.
 * `gru_lib.test.ts` pins that invariant. */
export function verifyBlocker(task: Assignment): string {
  if (task.phase === "released-unverified") return `task was released-unverified: ${task.settlement?.request.reason}; it cannot be verified`;
  if (task.phase === "swept") return "task was released by a proof-based sweep; it cannot be verified";
  if (task.reconnect?.pending) return "reconnect outcome is uncertain; observe it before verification";
  if (!task.integrationBase) {
    // Phase-aware, because this branch — not the switch — is the one an ordinary `review`
    // task reaches. A grant only survives into `review` when `reserve` hands a replacement
    // its predecessor's unsettled one, so the switch's `review` case covers the RARE path;
    // the first attempt reports ready with no grant at all and lands here. Telling it to
    // "integrate after its READY report" names a prerequisite already behind it — exactly
    // the misdirection the `review` case below exists to remove.
    return task.phase === "review"
      ? `task reported ready and holds no integration grant; integrate it ${GRANT_BASE}, then verify`
      : `task is ${task.phase} with no integration grant; integrate after its READY report`;
  }
  switch (task.phase) {
    case "done": return "task is already verified";
    // Reaching `review` IS the READY report (gru_lib.ts report()), so telling this task to
    // report ready names a step it already took. `integrate` is the one command that applies.
    case "review": return `task reported ready but holds a stale integration grant; integrate it ${GRANT_BASE}, then verify`;
    // Reachable only WITH a grant (the guard above took the ungranted case), so "cancelled
    // before integration" would contradict its own precondition. `continue` is the ONLY
    // repair: it needs an observed live idle worker, which is exactly the recoverable case.
    // Do NOT name `reserve` here — `readyReason` refuses every phase except `pending`, so
    // suggesting it hands the operator a command that throws, which is the defect this
    // function exists to remove.
    case "stopped": return `task was cancelled holding an unsettled integration grant; continue it once its worker is observed live and idle, then integrate ${GRANT_BASE}`;
    default: return `task is ${task.phase}; its worker must report ready and receive integration before verification`;
  }
}

/** Canonical form of a path that need not exist yet: realpath the parent, keep the leaf. */
const canonicalLeaf = (p: string): string => {
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch (error) {
    throw new Error(`worktree parent must exist and be readable: ${path.dirname(p)} (${(error as Error).message})`);
  }
};

/** Report each held task as `release` or `held`; with `apply`, release through the store. */
async function sweep(store: GruStore | null, runId: string | undefined, apply: boolean, invokedBy: string | null): Promise<number> {
  if (store === null && runId !== undefined) throw new Error(`unknown engagement ${runId}`);
  const all = store === null ? [] : store.list();
  const runs = runId === undefined ? all : [store!.read(runId)];
  // Gather everything before writing anything: an Alfred or Hermod failure releases nothing.
  // Every repository the store records is an Alfred context, even when --run narrows the sweep.
  const repositories = all.flatMap(run => run.config.tasks.map(task => task.repo));
  const evidence = await observeSweep(runs, undefined, repositories);
  let failed = false;
  const report = runs.filter(run => runId !== undefined || evidence.has(run.config.id)).map(run => {
    const id = run.config.id;
    const gathered = evidence.get(id);
    const verdicts = gathered ? store!.sweepVerdicts(run, gathered) : [];
    const entry = { run: id, mode: run.mode, revision: run.revision, leader: run.config.leader,
      tasks: verdicts.map(v => ({ ...v, resources: store!.owned(id, v.task) })) };
    if (!apply || !gathered || !verdicts.some(v => v.action === "release")) return entry;
    try {
      const swept = store!.sweep(id, run.revision, gathered, invokedBy);
      return { ...entry, applied: true, modeAfter: swept.run.mode, revisionAfter: swept.run.revision };
    } catch (error) {
      failed = true;
      process.stderr.write(`gru: sweep ${id}: ${(error as Error).message}\n`);
      return { ...entry, applied: false, error: (error as Error).message };
    }
  });
  process.stdout.write(JSON.stringify({ apply, runs: report }, null, 2) + "\n");
  return failed ? 2 : 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Only a leading `help` verb or a real `--help`/`-h` flag: a bare "help" scanned
  // anywhere in argv turns a flag VALUE (--run help, --task help) into a silent exit-0 no-op.
  if (argv.length === 0 || argv[0] === "help" || argv.some(a => a === "--help" || a === "-h")) { process.stdout.write(HELP); return 0; }
  let store: GruStore | undefined;
  try {
    const verb = argv[0];
    const options: Record<string, { type: "string" | "boolean" }> = { apply: { type: "boolean" }, ...Object.fromEntries(
      ["file", "run", "revision", "task", "token", "peer", "message", "base", "base-ref", "pr", "review", "state", "leader", "limits-file", "current-leader", "current-message"].map(key => [key, { type: "string" }])) };
    const { values } = parseArgs({ args: argv.slice(1), strict: true, options });
    const flag = (name: string): string => {
      const value = values[name];
      if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
      return value;
    };
    // parseArgs registers one option set for every verb, so a flag only `resume` reads is
    // silently accepted everywhere else. An operator who puts --limits-file on `reconcile`
    // would get exit 0 and believe the dead-leader limits were replaced while `packet` kept
    // shipping the old text — the precise failure this flag exists to fix. Refuse instead.
    if (verb !== "resume" && values["limits-file"] !== undefined) {
      throw new Error(`--limits-file applies to resume, not ${verb}`);
    }
    if (!["init", "takeover", "settle"].includes(verb) && values.file !== undefined) throw new Error(`--file applies to init or takeover or settle, not ${verb}`);
    // Fail before opening state or starting any network/check work without written authority.
    if (verb === "settle") {
      flag("file");
      const unused = Object.keys(values).find(key => !["file", "run", "revision", "task", "token", "state", "leader"].includes(key));
      if (unused) throw new Error(`--${unused} does not apply to settle`);
    }
    // Same trap as --limits-file: a --base-ref parsed but ignored would read as a grant checked
    // against the named branch while the tip actually came from origin's default one.
    for (const key of ["base", "base-ref"]) {
      if (verb !== "integrate" && values[key] !== undefined) throw new Error(`--${key} applies to integrate, not ${verb}`);
    }
    if (verb !== "sweep" && values.apply !== undefined) throw new Error(`--apply applies to sweep, not ${verb}`);
    // sweep evaluates whole engagements: a --task it ignored would read as a narrowed sweep.
    const unused = verb === "sweep" && Object.keys(values).find(key => !["run", "apply", "state", "leader"].includes(key));
    if (unused) throw new Error(`--${unused} does not apply to sweep`);
    for (const key of ["current-leader", "current-message"]) {
      if (verb !== "rebrief-check" && values[key] !== undefined) throw new Error(`--${key} applies to rebrief-check, not ${verb}`);
    }
    // Read a JSON file named by a flag, attributing any failure to the FLAG and the PATH.
    // A bare `JSON.parse` surfaces "Unexpected token } in JSON at position 41" — an offset
    // into an unnamed buffer. The operator is running several files through several flags;
    // a parser offset that names neither tells them nothing they can act on. Shared by
    // `init --file` and `resume --limits-file` so neither can drift back to the bare form.
    const readJsonFlag = (name: string): unknown => {
      const filePath = flag(name);
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        throw new Error(`--${name} ${filePath}: ${(error as Error).message}`);
      }
    };
    const integer = (name: string): number => {
      const value = flag(name);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} must be an integer`);
      return Number(value);
    };
    // Claude Code exports CLAUDE_CODE_SESSION_ID to its shells; CLAUDE_SESSION_ID is the older name.
    const identity = process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || values.leader;
    if (values.leader && values.leader !== identity) throw new Error("--leader differs from the runtime session identity");
    if (verb === "rebrief-check") {
      const extra = Object.keys(values).find(key => !["message", "run", "task", "current-leader", "current-message"].includes(key));
      if (extra) throw new Error(`--${extra} does not apply to rebrief-check`);
      if (typeof identity !== "string" || !identity) throw new Error("worker runtime session identity unavailable");
      const result = await checkRebrief({ message: flag("message"), run: flag("run"), task: flag("task"),
        currentLeader: flag("current-leader"), worker: identity,
        ...(values["current-message"] === undefined ? {} : { currentMessage: flag("current-message") }) });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n"); return 0;
    }
    const statePath = typeof values.state === "string" ? path.resolve(values.state) : path.join(os.homedir(), ".stark", "gru", "state.sqlite");
    // sweep is maintenance, not leadership: it runs from any shell and records the invoker it has.
    if (verb === "sweep") {
      const runId = values.run === undefined ? undefined : flag("run");
      const apply = values.apply === true;
      // A dry run is a preview: it opens the store read-only, and neither mode creates a store
      // that does not exist yet — there is nothing in it to release.
      if (fs.existsSync(statePath)) store = new GruStore(statePath, { readOnly: !apply });
      return await sweep(store ?? null, runId, apply, typeof identity === "string" ? identity : null);
    }
    if (!identity || typeof identity !== "string") throw new Error("current session identity unavailable; supply --leader SESSION");
    store = new GruStore(statePath);
    const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    if (verb === "init") {
      // Shape is asserted by `parseEngagement` two lines down, not by this cast.
      const input = readJsonFlag("file") as Engagement;
      if (input.leader !== identity) throw new Error("engagement leader differs from current session");
      // Validate first: realpath would silently absolutize a relative path against this cwd.
      parseEngagement(input);
      // Canonical paths prevent aliases hiding duplicate ownership.
      const repositoryKeys = new Map<string, string>();
      // ONLY origin's resolved default branch, keyed by repository — never a task's DECLARED
      // `baseRef`. A declared value is a property of the task, not of the checkout: caching it
      // here made a sibling task in the same repository that declared nothing inherit it,
      // silently and in input order, so `t1: release` + `t2: <omitted>` briefed t2 on
      // `release` too. That is the wrong-branch brief this whole field exists to remove,
      // reintroduced by the cache meant to save one `ls-remote`.
      const originDefaults = new Map<string, string>();
      for (const task of input.tasks) {
        task.repo = fs.realpathSync(task.repo);
        task.repositoryKey = repositoryKeys.get(task.repo) ?? await canonicalRepository(task.repo);
        repositoryKeys.set(task.repo, task.repositoryKey);
        // Resolve the base branch ONCE, here, so every later reader — the first packet the
        // worker gets, `integrate`'s default, `verify`'s comparison — sees the same concrete
        // value. Leaving it unset until grant time is what let a worker open its PR against a
        // branch nobody had told it about, and `verify` refuse that merge terminally.
        // Refuse rather than leave it unset: an engagement whose tasks carry no base branch
        // cannot brief its workers about one, and the terminal grant/PR mismatch this field
        // exists to remove comes straight back. The escape hatch is the field itself —
        // declare `baseRef` in the input and no network read happens at all.
        if (task.baseRef === undefined) {
          try {
            task.baseRef = originDefaults.get(task.repo) ?? await defaultBaseRef(task.repo);
          } catch (error) {
            throw new Error(`cannot resolve the base branch for ${task.id} in ${task.repo}: ${(error as Error).message}. Declare "baseRef" on that task to skip this lookup.`);
          }
          originDefaults.set(task.repo, task.baseRef);
        }
        task.worktree = fs.existsSync(task.worktree) ? fs.realpathSync(task.worktree) : canonicalLeaf(task.worktree);
      }
      emit(store.create(input)); return 0;
    }
    const id = flag("run");
    const run = store.read(id);
    if (verb === "status") {
      const reasons = store.readyReasons(run);
      emit({ ...run, summary: completionSummary(run), ready: run.tasks.filter(t => reasons.get(t.spec.id) === null).map(t => t.spec.id),
        waiting: run.tasks.filter(t => !["done", "swept", "released-unverified"].includes(t.phase)).map(t => ({ task: t.spec.id, reason: reasons.get(t.spec.id) })) }); return 0;
    }
    const task = (token?: string) => {
      const found = run.tasks.find(t => t.spec.id === flag("task"));
      if (!found) throw new Error("unknown task");
      if (token !== undefined && found.token !== token) throw new Error("stale assignment token");
      return found;
    };
    if (verb === "packet") { process.stdout.write(packet(run, task()) + "\n"); return 0; }
    const revision = integer("revision");
    if (run.revision !== revision) throw new Error(`stale revision; expected ${run.revision}`);
    if (verb !== "resume" && identity !== run.config.leader) throw new Error("current session is not this engagement's leader");
    switch (verb) {
      case "reconcile": emit(store.reconcile(id, identity, revision, await observeWorkers(run))); break;
      case "reserve": emit(store.reserve(id, identity, revision, flag("task"))); break;
      case "attach": {
        const assigned = task(flag("token"));
        const peers = await discoverWorker({ provider: assigned.spec.provider, id: flag("peer") });
        // Positive live evidence always wins, including in an incomplete namespace. `incomplete`
        // answers whether absence proves death; a returned peer is present, and `workerFromPeer`
        // below is the identity bar it must clear. Absence refuses either way — preserving the
        // reservation is the safe direction — but it names which absence it saw: inside an
        // incomplete view the launch may simply be an identity Hermod cannot enumerate yet
        // (a just-launched worker is briefly unregistered), so re-running `attach` is the repair,
        // not a takeover, which refuses that view anyway.
        const peer = peers.peers.find(p => p.id === flag("peer"));
        if (!peer) throw new Error(`Hermod peer missing; preserve launch reservation${
          peers.incomplete ? "; the view was incomplete, so this absence is unproven — attach again" : ""}`);
        const worker = workerFromPeer(peer);
        // Inspect git only for a peer that could bind; the store names any other refusal.
        const adoption = canonicalWorktree(worker.worktree) === canonicalWorktree(assigned.spec.worktree) || store.attachRefusal(run, assigned, worker)
          ? undefined : await inspectAdoption(assigned, worker);
        const attached = store.attach(id, identity, revision, flag("task"), flag("token"), worker, adoption);
        emit(attached);
        // The launch brief names the declared path. A running worker needs the regenerated packet;
        // a launch bound during stop must be interrupted, not briefed to start work.
        if (adoption) process.stderr.write(`gru: adopted observed worktree ${adoption.observed} (declared ${adoption.declared}); the token changed; ${
          attached.mode === "stopping" ? "interrupt the worker with the new token" : "send the worker a fresh packet"}\n`);
        break;
      }
      case "receive": {
        const report = await receive(run, flag("message"));
        emit(store.report(id, identity, revision, report.task, report.token, report.session, report.kind, report.message, flag("message"))); break;
      }
      case "resume": {
        // --limits-file replaces the frozen limits array; omitted keeps it. Read as a file,
        // not an inline string: limits are prose the operator authored, and shell quoting is
        // exactly where an authority line gets silently truncated.
        //
        // Read BEFORE the transfer check. That check performs live Hermod discovery, so a
        // mistyped path would otherwise surface only after a slow network round trip — and
        // report a discovery failure instead of the typo that actually caused it.
        //
        // `readJsonFlag` attributes any failure to the flag AND the path, which is precisely
        // the early-read's stated purpose; `init --file` shares it for the same reason.
        const limits = values["limits-file"] === undefined ? undefined : readJsonFlag("limits-file");
        const discovery = await checkLeadershipTransfer(run.config.leader, identity);
        emit(store.resume(id, run.config.leader, revision, identity, limits, discovery)); break;
      }
      case "recover": emit(store.recover(id, identity, revision, flag("task"), flag("token"))); break;
      case "takeover": {
        const request = parseTakeover(readJsonFlag("file"));
        if (request.run !== id || request.task !== flag("task") || request.token !== flag("token") || request.revision !== revision) {
          throw new Error("takeover request does not match the current assignment revision");
        }
        request.worktree = canonicalLeaf(request.worktree);
        const evidence = await observeOrphan(task(flag("token")), request.worktree);
        emit(store.takeover(id, identity, revision, flag("task"), flag("token"), request, evidence)); break;
      }
      case "continue": emit(store.continueWorker(id, identity, revision, flag("task"), flag("token"))); break;
      case "reconnect": {
        validateReconnect(task());
        const reserved = store.beginReconnect(id, identity, revision, flag("task"), flag("token"));
        emit(reserved);
        await reconnectWorker(reserved.tasks.find(t => t.spec.id === flag("task"))!);
        process.stderr.write("gru: reconnect submitted; reconcile and confirm its outcome\n"); break;
      }
      case "reconnected": emit(store.finishReconnect(id, identity, revision, flag("task"), flag("token"))); break;
      case "integrate": {
        const assigned = task(flag("token"));
        const base = flag("base");
        // integrate() will refuse this anyway; refuse before a network fetch that writes
        // objects into the leader's own checkout, exactly as `verify` refuses below. Share the
        // store's own predicate rather than re-spelling it: a hand-copy that drifts either
        // restores the wasted round trip or refuses a grant the store would have taken.
        if (!integrationReady(run, assigned)) throw new Error("task is not ready for integration");
        // Observe before the transaction: the store owns the verdict, but only git can say the
        // SHA is a commit this repository holds and is the base branch's current tip. Gathering
        // first also keeps a failed fetch from taking the merge lock.
        const observed = await observeBase(assigned, base,
          values["base-ref"] === undefined ? undefined : flag("base-ref"));
        emit(store.integrate(id, identity, revision, flag("task"), flag("token"), base, observed)); break;
      }
      case "verify": {
        const assigned = task(flag("token"));
        // complete() will refuse these anyway; refuse before spending a full verification run.
        if (run.mode !== "running" || !run.reconciled) throw new Error("resume and reconcile before verification");
        // Name the repair that actually applies. "integrate" only works from `review`,
        // so offering it for a stopped or in-flight task hands over a command that refuses.
        if (!verificationReady(assigned)) throw new Error(verifyBlocker(assigned));
        const evidenceRoot = path.join(path.dirname(statePath), "evidence", id);
        fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        const evidenceDir = fs.mkdtempSync(path.join(evidenceRoot, "verification-"));
        const proof = await verifyCompletion(assigned, integer("pr"), integer("review"), evidenceDir);
        const completed = store.complete(id, identity, revision, assigned.spec.id, assigned.token!, proof);
        emit({ ...completed, summary: completionSummary(completed) }); break;
      }
      case "settle": {
        const request = parseSettlement(readJsonFlag("file"));
        const assigned = task(flag("token"));
        if (request.run !== id || request.task !== assigned.spec.id || request.token !== assigned.token || request.revision !== revision) {
          throw new Error("settlement request does not match the current assignment revision");
        }
        if (run.mode !== "running" || !run.reconciled) throw new Error("resume and reconcile before settlement");
        if (!verificationReady(assigned)) throw new Error(verifyBlocker(assigned));
        const evidenceRoot = path.join(path.dirname(statePath), "evidence", id);
        fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        const proof = await inspectUnreviewedMerge(assigned, request, fs.mkdtempSync(path.join(evidenceRoot, "settlement-")));
        const settled = store.settleWithoutReview(id, identity, revision, assigned.spec.id, assigned.token!, request, proof);
        emit({ ...settled, summary: completionSummary(settled) }); break;
      }
      case "stop": emit(store.stop(id, identity, revision)); break;
      case "interrupt": {
        await interruptWorker(task(flag("token")));
        emit(store.reconcile(id, identity, revision, await observeWorkers(run))); break;
      }
      case "stopped": emit(store.stopped(id, identity, revision, flag("task"), flag("token"))); break;
      case "retire": {
        const surface = await retireWorker(task(flag("token")));
        const retired = store.retire(id, identity, revision, flag("task"), flag("token"), surface);
        emit(store.reconcile(id, identity, retired.revision, await observeWorkers(retired))); break;
      }
      default: throw new Error(`unknown command ${verb}`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`gru: ${(error as Error).message}\n`); return 2;
  } finally { store?.close(); }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
