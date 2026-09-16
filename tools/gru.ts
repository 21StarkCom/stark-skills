#!/usr/bin/env node
/** Gru's durable action boundary. The `gru` skill owns the agentic loop. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GruStore, parseEngagement, verificationReady } from "./gru_lib.ts";
import type { Assignment } from "./gru_lib.ts";
import { canonicalRepository, checkLeadershipTransfer, discoverWorker, interruptWorker, observeWorkers, packet, receive, reconnectWorker, retireWorker, validateReconnect, verifyCompletion, workerFromPeer } from "./gru_runtime_lib.ts";
import { isMainModule } from "./main_module_lib.ts";

const HELP = `Gru: durable Minion ownership, recovery, and verification.

Usage: node tools/gru.ts <command> [options]

  init         --file engagement.json
  status       --run ID
  reconcile    --run ID --revision N
  reserve      --run ID --revision N --task ID
  packet       --run ID --task ID
  attach       --run ID --revision N --task ID --token TOKEN --peer PEER_ID
  receive      --run ID --revision N --message HERMOD_MESSAGE_ID
  resume       --run ID --revision N [--limits-file limits.json]
  continue     --run ID --revision N --task ID --token TOKEN
  reconnect    --run ID --revision N --task ID --token TOKEN
  reconnected  --run ID --revision N --task ID --token TOKEN
  recover      --run ID --revision N --task ID --token TOKEN
  integrate    --run ID --revision N --task ID --token TOKEN --base SHA
  verify       --run ID --revision N --task ID --token TOKEN --pr N --review N
  stop         --run ID --revision N
  interrupt    --run ID --revision N --task ID --token TOKEN
  stopped      --run ID --revision N --task ID --token TOKEN
  retire       --run ID --revision N --task ID --token TOKEN

Every command returns JSON. packet returns the complete worker brief as text.
Writes require the current leader identity and an exact state revision.
The leader identity is CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID from the
environment (legacy CLAUDE_SESSION_ID is accepted); --leader is the fallback.
State defaults to ~/.stark/gru/state.sqlite, shared across runtimes.
--state PATH overrides the database. --help, -h, help exit without side effects.

reserve records intent, not successful startup. Launch through Hermod only.
attach requires a live Hermod peer; receive requires a confirmed worker message.
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
`;

/** Explain why `verificationReady` refused, naming the command that actually repairs it.
 * `integrate` only accepts phase `review`, so it is the wrong instruction everywhere else;
 * a stopped worker needs `continue`, an in-flight one needs its own READY report first. */
export function verifyBlocker(task: Assignment): string {
  if (task.reconnect?.pending) return "reconnect outcome is uncertain; observe it before verification";
  if (!task.integrationBase) return `task is ${task.phase} with no integration grant; integrate after its READY report`;
  switch (task.phase) {
    case "done": return "task is already verified";
    case "stopping": return "task is stopping; observe termination and record stopped first";
    case "stopped": return "task was cancelled before integration; continue it, then integrate after its READY report";
    default: return `task is ${task.phase}; its worker must report ready and receive integration before verification`;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // Only a leading `help` verb or a real `--help`/`-h` flag: a bare "help" scanned
  // anywhere in argv turns a flag VALUE (--run help, --task help) into a silent exit-0 no-op.
  if (argv.length === 0 || argv[0] === "help" || argv.some(a => a === "--help" || a === "-h")) { process.stdout.write(HELP); return 0; }
  let store: GruStore | undefined;
  try {
    const verb = argv[0];
    const { values } = parseArgs({ args: argv.slice(1), strict: true, options: Object.fromEntries(
      ["file", "run", "revision", "task", "token", "peer", "message", "base", "pr", "review", "state", "leader", "limits-file"].map(key => [key, { type: "string" as const }])) });
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
    const integer = (name: string): number => {
      const value = flag(name);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} must be an integer`);
      return Number(value);
    };
    // Claude Code exports CLAUDE_CODE_SESSION_ID to its shells; CLAUDE_SESSION_ID is the older name.
    const identity = process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || values.leader;
    if (!identity || typeof identity !== "string") throw new Error("current session identity unavailable; supply --leader SESSION");
    if (values.leader && values.leader !== identity) throw new Error("--leader differs from the runtime session identity");
    const statePath = typeof values.state === "string" ? path.resolve(values.state) : path.join(os.homedir(), ".stark", "gru", "state.sqlite");
    store = new GruStore(statePath);
    const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    if (verb === "init") {
      const input = JSON.parse(fs.readFileSync(flag("file"), "utf8"));
      if (input.leader !== identity) throw new Error("engagement leader differs from current session");
      // Validate first: realpath would silently absolutize a relative path against this cwd.
      parseEngagement(input);
      // Canonical paths prevent aliases hiding duplicate ownership.
      const repositoryKeys = new Map<string, string>();
      for (const task of input.tasks) {
        task.repo = fs.realpathSync(task.repo);
        task.repositoryKey = repositoryKeys.get(task.repo) ?? await canonicalRepository(task.repo);
        repositoryKeys.set(task.repo, task.repositoryKey);
        task.worktree = fs.existsSync(task.worktree) ? fs.realpathSync(task.worktree) : path.join(fs.realpathSync(path.dirname(task.worktree)), path.basename(task.worktree));
      }
      emit(store.create(input)); return 0;
    }
    const id = flag("run");
    const run = store.read(id);
    if (verb === "status") {
      const reasons = store.readyReasons(run);
      emit({ ...run, ready: run.tasks.filter(t => reasons.get(t.spec.id) === null).map(t => t.spec.id),
        waiting: run.tasks.filter(t => t.phase !== "done").map(t => ({ task: t.spec.id, reason: reasons.get(t.spec.id) })) }); return 0;
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
        const peers = await discoverWorker({ provider: task().spec.provider, id: flag("peer") });
        if (peers.incomplete) throw new Error("Hermod discovery incomplete; preserve launch reservation");
        const peer = peers.peers.find(p => p.id === flag("peer"));
        if (!peer) throw new Error(`Hermod peer ${peers.incomplete ? "discovery incomplete" : "missing"}; preserve launch reservation`);
        emit(store.attach(id, identity, revision, flag("task"), flag("token"), workerFromPeer(peer))); break;
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
        const limits = values["limits-file"] === undefined ? undefined
          : JSON.parse(fs.readFileSync(flag("limits-file"), "utf8"));
        await checkLeadershipTransfer(run.config.leader, identity);
        emit(store.resume(id, run.config.leader, revision, identity, limits)); break;
      }
      case "recover": emit(store.recover(id, identity, revision, flag("task"), flag("token"))); break;
      case "continue": emit(store.continueWorker(id, identity, revision, flag("task"), flag("token"))); break;
      case "reconnect": {
        validateReconnect(task());
        const reserved = store.beginReconnect(id, identity, revision, flag("task"), flag("token"));
        emit(reserved);
        await reconnectWorker(reserved.tasks.find(t => t.spec.id === flag("task"))!);
        process.stderr.write("gru: reconnect submitted; reconcile and confirm its outcome\n"); break;
      }
      case "reconnected": emit(store.finishReconnect(id, identity, revision, flag("task"), flag("token"))); break;
      case "integrate": emit(store.integrate(id, identity, revision, flag("task"), flag("token"), flag("base"))); break;
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
        emit(store.complete(id, identity, revision, assigned.spec.id, assigned.token!, proof)); break;
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
