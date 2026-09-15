#!/usr/bin/env node
/** Gru's durable action boundary. The team-leader skill owns the agentic loop. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { GruStore, readyReason } from "./gru_lib.ts";
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
  resume       --run ID --revision N
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
Use --leader SESSION only when the runtime has no session environment.
State defaults to ~/.stark/gru/state.sqlite, shared across runtimes.
--state PATH overrides the database. --help, -h, help exit without side effects.

reserve records intent, not successful startup. Launch through Hermod only.
attach requires a live Hermod peer; receive requires a confirmed worker message.
reconcile never equates missing discovery with death. Keep uncertain reservations.
stop freezes dispatch; use Hermod to interrupt workers and observe termination.
verify reruns declared checks in a disposable detached worktree, on fetched main.
It requires a merged PR, posted head-matching review, and Alfred completion.
Verification removes its disposable checkout and retains its logs.
No command publishes, changes authentication, or deletes worker/session worktrees.
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv[0] === "help" || argv.some(a => ["--help", "-h"].includes(a))) { process.stdout.write(HELP); return 0; }
  let store: GruStore | undefined;
  try {
    const verb = argv[0];
    const { values } = parseArgs({ args: argv.slice(1), strict: true, options: Object.fromEntries(
      ["file", "run", "revision", "task", "token", "peer", "message", "base", "pr", "review", "state", "leader"].map(key => [key, { type: "string" as const }])) });
    const flag = (name: string): string => {
      const value = values[name];
      if (typeof value !== "string" || !value) throw new Error(`--${name} is required`);
      return value;
    };
    const integer = (name: string): number => {
      const value = flag(name);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} must be an integer`);
      return Number(value);
    };
    const identity = process.env.CODEX_THREAD_ID || process.env.CLAUDE_SESSION_ID || values.leader;
    if (!identity || typeof identity !== "string") throw new Error("current session identity unavailable; supply --leader SESSION");
    if (values.leader && values.leader !== identity) throw new Error("--leader differs from the runtime session identity");
    const statePath = typeof values.state === "string" ? path.resolve(values.state) : path.join(os.homedir(), ".stark", "gru", "state.sqlite");
    store = new GruStore(statePath);
    const emit = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    if (verb === "init") {
      const input = JSON.parse(fs.readFileSync(flag("file"), "utf8"));
      if (input.leader !== identity) throw new Error("engagement leader differs from current session");
      // Canonical paths prevent aliases hiding duplicate ownership.
      for (const task of input.tasks ?? []) {
        task.repo = fs.realpathSync(task.repo);
        task.repositoryKey = await canonicalRepository(task.repo);
        task.worktree = fs.existsSync(task.worktree) ? fs.realpathSync(task.worktree) : path.join(fs.realpathSync(path.dirname(task.worktree)), path.basename(task.worktree));
      }
      emit(store.create(input)); return 0;
    }
    const id = flag("run");
    const run = store.read(id);
    if (verb === "status") {
      emit({ ...run, ready: run.tasks.filter(t => readyReason(run, t) === null).map(t => t.spec.id),
        waiting: run.tasks.filter(t => t.phase !== "done").map(t => ({ task: t.spec.id, reason: readyReason(run, t) })) }); return 0;
    }
    const task = () => {
      const found = run.tasks.find(t => t.spec.id === flag("task"));
      if (!found) throw new Error("unknown task");
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
        if (!peer) throw new Error("Hermod peer missing; preserve launch reservation");
        emit(store.attach(id, identity, revision, flag("task"), flag("token"), workerFromPeer(peer))); break;
      }
      case "receive": {
        const report = await receive(run, flag("message"));
        emit(store.report(id, identity, revision, report.task, report.token, report.session, report.kind, report.message, flag("message"))); break;
      }
      case "resume": {
        await checkLeadershipTransfer(run.config.leader, identity);
        emit(store.resume(id, run.config.leader, revision, identity)); break;
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
        const assigned = task();
        if (assigned.token !== flag("token")) throw new Error("stale assignment token");
        const evidenceRoot = path.join(path.dirname(statePath), "evidence", id);
        fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
        const evidenceDir = fs.mkdtempSync(path.join(evidenceRoot, "verification-"));
        const proof = await verifyCompletion(assigned, integer("pr"), integer("review"), evidenceDir);
        emit(store.complete(id, identity, revision, assigned.spec.id, assigned.token!, proof)); break;
      }
      case "stop": emit(store.stop(id, identity, revision)); break;
      case "interrupt": {
        const assigned = task();
        if (assigned.token !== flag("token")) throw new Error("stale assignment token");
        await interruptWorker(assigned);
        emit(store.reconcile(id, identity, revision, await observeWorkers(run))); break;
      }
      case "stopped": emit(store.stopped(id, identity, revision, flag("task"), flag("token"))); break;
      case "retire": {
        const assigned = task();
        if (assigned.token !== flag("token")) throw new Error("stale assignment token");
        await retireWorker(assigned);
        emit(store.reconcile(id, identity, revision, await observeWorkers(run))); break;
      }
      default: throw new Error(`unknown command ${verb}`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`gru: ${(error as Error).message}\n`); return 2;
  } finally { store?.close(); }
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
