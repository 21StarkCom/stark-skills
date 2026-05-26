#!/usr/bin/env -S node --experimental-strip-types
/**
 * Phase 6 Task 3 — observability adapter for `/stark-phase-execute`.
 *
 * The phase-execute SKILL.md is not a TS dispatcher; it shells out to many
 * child processes across many bash command blocks, each of which may run in
 * its own ephemeral `/bin/bash -c '…'` shell. The writer daemon (Phase 2)
 * needs a single long-lived tracked-parent pid for the duration of the run.
 *
 * The design choice (from the plan §Phase 6 Task 3): a **session sentinel
 * process** that:
 *   - has no controlling terminal
 *   - persists across SKILL.md bash blocks
 *   - exits when the SKILL stops touching `lease.tick`
 *
 * The daemon's `kill(sentinel_pid, 0)` poll then drives the canonical
 * crashed-`run_end` if the SKILL aborts mid-execution.
 *
 * Subcommands (every subcommand resolves session id itself per E3 — fresh
 * SKILL.md bash blocks may have `$SESSION_ID` empty, so all session-bound
 * state derives from `resolveSessionId(--session-id || env || marker-scan)`):
 *   start --plan-slug SLUG --session-id ID [--repo ORG/REPO] [--branch NAME]
 *     - spawn the lease-checking sentinel script
 *     - call startRun({..., trackedParentPid: <sentinel_pid>})
 *     - write phase_run.json + phase_run.env
 *     - print runId to stdout
 *   touch-lease
 *     - resolve session id internally, `utimensSync` lease.tick to "now".
 *     - The load-bearing call every SKILL.md bash block makes as its first
 *       action (replaces bare `touch "$HOME/.../$SESSION_ID/lease.tick"`
 *       which would write to the wrong path when $SESSION_ID is empty in a
 *       fresh shell).
 *   progress --kind K --payload JSON
 *   subagent-start --agent A --model M --task T   (prints subagent_id)
 *   subagent-end --subagent-id ID --status S [--duration-ms N] [--summary JSON]
 *   end --status ok|error|timeout
 *     - child-dispatcher barrier (waitpid-equivalent on `children/<pid>.json`)
 *     - endRun via daemon, then SIGTERM sentinel, cleanup state files
 *   exec-child -- <cmd> [args...]
 *     - resolve SESSION_ID, refresh lease, exec child with merged env
 *     - register pid in children/ so `end` can barrier-wait on it
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import {
  connectRun,
  emitProgress,
  endRun,
  endSubAgent,
  startRun,
  startSubAgent,
  type SubAgent,
} from "./observability_emit_lib.ts";

// ─── Paths ─────────────────────────────────────────────────────────────────

const HOME = os.homedir();

function sessionsDir(): string {
  return path.join(HOME, ".claude", "code-review", "sessions");
}

function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), sanitizeSessionId(sessionId));
}

function phaseRunJsonPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "phase_run.json");
}

function phaseRunEnvPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "phase_run.env");
}

function leasePath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "lease.tick");
}

function childrenDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), "children");
}

function sentinelScriptPath(): string {
  return path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "phase_execute_observability_sentinel.sh",
  );
}

function sanitizeSessionId(raw: string): string {
  // Same sanitization rule used by session_state.ts: keep alnum, dashes, underscores.
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned.length === 0) throw new Error("invalid session id (empty after sanitize)");
  return cleaned;
}

// ─── Session ID resolver ───────────────────────────────────────────────────

async function resolveSessionId(explicit: string | undefined): Promise<string> {
  if (explicit && explicit.length > 0) return explicit;
  // Precedence (wing-round-3 fix): explicit > STARK_OBS_SESSION_ID > shared
  // session_id_lib (CLAUDE_SESSION_ID > projects marker scan > uuid4).
  // `start` writes only STARK_OBS_SESSION_ID into phase_run.env, so a fresh
  // SKILL.md shell that `source`s phase_run.env must find the same session
  // here — otherwise touch-lease/exec-child/end resolve a different marker
  // session or a brand-new uuid and touch the wrong lease file.
  const fromObsEnv = process.env.STARK_OBS_SESSION_ID;
  if (fromObsEnv && fromObsEnv.length > 0) return fromObsEnv;
  const mod = await import("./session_id_lib.ts");
  const fn = (mod as { resolveSessionId?: () => string }).resolveSessionId;
  if (typeof fn === "function") return fn();
  throw new Error("session_id_lib.ts is missing resolveSessionId — pass --session-id");
}

// ─── Phase-run state ───────────────────────────────────────────────────────

interface PhaseRunRecord {
  runId: string;
  sentinel_pid: number;
  sentinel_pgid: number;
  lease_path: string;
  lease_ttl_s: number;
  sessionId: string;
  started_at: string;
}

function readPhaseRun(sessionId: string): PhaseRunRecord {
  const p = phaseRunJsonPath(sessionId);
  if (!existsSync(p)) {
    throw new Error(
      `no active phase run for session ${sessionId} — call \`start\` first (looked at ${p})`,
    );
  }
  return JSON.parse(readFileSync(p, "utf-8")) as PhaseRunRecord;
}

// ─── start ─────────────────────────────────────────────────────────────────

async function cmdStart(args: {
  planSlug: string;
  sessionId: string;
  repo?: string;
  branch?: string;
}): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  mkdirSync(sessionDir(sid), { recursive: true, mode: 0o700 });
  mkdirSync(childrenDir(sid), { recursive: true, mode: 0o700 });

  // Idempotency (E3): a re-run of the SKILL `start` block on the same
  // session must NOT spawn a second sentinel + writer daemon and
  // overwrite phase_run.json — that would orphan the prior pair. If a
  // phase_run.json already exists and its sentinel is alive, short-
  // circuit by printing the existing runId. If the sentinel is dead,
  // remove the stale record and fall through to a fresh start.
  const existingJsonPath = phaseRunJsonPath(sid);
  if (existsSync(existingJsonPath)) {
    try {
      const prior = JSON.parse(
        readFileSync(existingJsonPath, "utf-8"),
      ) as PhaseRunRecord;
      let aliveSentinel = false;
      try {
        process.kill(prior.sentinel_pid, 0);
        aliveSentinel = true;
      } catch {
        aliveSentinel = false;
      }
      if (aliveSentinel) {
        process.stdout.write(`${prior.runId}\n`);
        return 0;
      }
      // Sentinel is gone — clear the stale record and the env file so
      // the fresh start writes uncontested.
      try { unlinkSync(existingJsonPath); } catch { /* ignore */ }
      try { unlinkSync(phaseRunEnvPath(sid)); } catch { /* ignore */ }
    } catch {
      // Malformed JSON — same recovery: drop the stale record.
      try { unlinkSync(existingJsonPath); } catch { /* ignore */ }
    }
  }

  // Touch the lease BEFORE spawning the sentinel so the first poll sees a
  // fresh mtime (the sentinel polls every 15 s, default TTL 180 s).
  writeFileSync(leasePath(sid), "");

  const leaseTtlS = Number.parseInt(process.env.STARK_PHASE_LEASE_TTL_S ?? "", 10) || 180;
  const sentinel = spawn(
    "/bin/sh",
    [sentinelScriptPath(), leasePath(sid), String(leaseTtlS)],
    { detached: true, stdio: "ignore" },
  );
  if (typeof sentinel.pid !== "number") {
    throw new Error("failed to spawn session sentinel");
  }
  const sentinelPid = sentinel.pid;
  // pgid resolution: the sentinel calls `setsid` itself, so its pgid equals
  // its own pid post-exec; we record the same value here for the SIGTERM
  // cleanup path in `end`.
  const sentinelPgid = sentinelPid;
  sentinel.unref();

  // Spawn the writer daemon via startRun, with the sentinel as the tracked
  // parent. The dispatcher field uses the canonical SKILL name so the UI
  // groups runs correctly.
  const ctx = await startRun({
    dispatcher: "stark-phase-execute",
    repo: args.repo,
    branch: args.branch,
    trackedParentPid: sentinelPid,
    meta: {
      plan_slug: args.planSlug,
      session_id: sid,
      sentinel_pid: sentinelPid,
      writer_daemon_pid: null, // best-effort — we don't have direct access
    },
  });

  const record: PhaseRunRecord = {
    runId: ctx.runId,
    sentinel_pid: sentinelPid,
    sentinel_pgid: sentinelPgid,
    lease_path: leasePath(sid),
    lease_ttl_s: leaseTtlS,
    sessionId: sid,
    started_at: new Date().toISOString(),
  };
  writeFileSync(phaseRunJsonPath(sid), JSON.stringify(record, null, 2), { mode: 0o600 });

  // phase_run.env exports the env-vars the `exec-child` wrapper merges into
  // each child dispatcher's environment.
  const envBody =
    `export STARK_OBS_PARENT_RUN_ID='${ctx.runId}'\n` +
    `export STARK_OBS_SESSION_ID='${sid}'\n`;
  writeFileSync(phaseRunEnvPath(sid), envBody, { mode: 0o600 });

  // Close our copy of the writer client; subsequent CLI subcommands open
  // fresh connections via `connectRun`. The daemon keeps running detached.
  ctx._client?.close();

  process.stdout.write(`${ctx.runId}\n`);
  return 0;
}

// ─── touch-lease ───────────────────────────────────────────────────────────

/**
 * Idempotent lease-refresh: resolve session id internally, ensure the session
 * dir exists, then `utimensSync` lease.tick to now. Lifts E3's load-bearing
 * requirement off the SKILL.md (which can't trust `$SESSION_ID` to survive
 * across fresh bash command blocks) and onto this TS subcommand whose own
 * session-id resolver handles the env > marker-scan > uuid4 fallback.
 *
 * No phase_run.json read — works even before `start` runs (no-op if the
 * session dir is missing; never errors out so the SKILL's first-block
 * touch-lease never fails).
 */
async function cmdTouchLease(args: { sessionId: string }): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  try {
    mkdirSync(sessionDir(sid), { recursive: true, mode: 0o700 });
  } catch {
    // ignore — directory may already exist or be unwritable; the touch
    // attempt below will surface a real problem if any.
  }
  const lp = leasePath(sid);
  const now = new Date();
  try {
    utimesSync(lp, now, now);
  } catch {
    // Lease file doesn't exist yet → create it (mtime defaults to now).
    try {
      writeFileSync(lp, "");
    } catch {
      // ignore — best-effort. The sentinel may not have been spawned yet
      // (touch-lease run before start) and that's fine.
    }
  }
  return 0;
}

// ─── progress ──────────────────────────────────────────────────────────────

async function cmdProgress(args: {
  sessionId: string;
  kind: string;
  payload: string;
}): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  const record = readPhaseRun(sid);
  let payload: unknown;
  try {
    payload = JSON.parse(args.payload);
  } catch (e) {
    throw new Error(`--payload must be valid JSON: ${(e as Error).message}`);
  }
  const ctx = await connectRun(record.runId);
  try {
    await emitProgress(ctx, null, args.kind, payload);
  } finally {
    ctx._client?.close();
  }
  return 0;
}

// ─── subagent-start / subagent-end ─────────────────────────────────────────

async function cmdSubAgentStart(args: {
  sessionId: string;
  agent: string;
  model: string;
  task: string;
}): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  const record = readPhaseRun(sid);
  const ctx = await connectRun(record.runId);
  try {
    const sa = await startSubAgent(ctx, { agent: args.agent, model: args.model, task: args.task });
    process.stdout.write(`${sa.id}\n`);
  } finally {
    ctx._client?.close();
  }
  return 0;
}

async function cmdSubAgentEnd(args: {
  sessionId: string;
  subagentId: string;
  status: "ok" | "error" | "timeout";
  durationMs?: number;
  summary?: string;
}): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  const record = readPhaseRun(sid);
  const ctx = await connectRun(record.runId);
  try {
    // The emit lib's endSubAgent uses sa.startedAtMs to default durationMs;
    // for an out-of-band call we don't have that timestamp, so fabricate a
    // minimal SubAgent shape and let the caller pass --duration-ms.
    const sa: SubAgent = {
      id: args.subagentId,
      agent: "<unknown>",
      model: "<unknown>",
      task: "<unknown>",
      startedAtMs: Date.now(),
    };
    const summary = args.summary !== undefined ? JSON.parse(args.summary) : null;
    await endSubAgent(ctx, sa, args.status, args.durationMs ?? 0, summary);
  } finally {
    ctx._client?.close();
  }
  return 0;
}

// ─── end ───────────────────────────────────────────────────────────────────

async function cmdEnd(args: {
  sessionId: string;
  status: "ok" | "error" | "timeout";
}): Promise<number> {
  const sid = sanitizeSessionId(args.sessionId);
  const record = readPhaseRun(sid);

  // Child-dispatcher barrier (E2 + Phase 6 Task 3 §end). Poll every 250 ms;
  // cap at STARK_PHASE_CHILD_WAIT_MAX_S (default 600 s).
  const maxWaitS = Number.parseInt(process.env.STARK_PHASE_CHILD_WAIT_MAX_S ?? "", 10) || 600;
  const deadline = Date.now() + maxWaitS * 1000;
  const cdir = childrenDir(sid);
  while (true) {
    const pids = listChildPids(cdir);
    if (pids.length === 0) break;
    // Filter to ones that are still alive (file may be stale if exec-child
    // died before its `unlink` cleanup fired).
    const stillAlive = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // Process gone but the marker file isn't. Best-effort cleanup.
        try {
          unlinkSync(path.join(cdir, `${pid}.json`));
        } catch {
          // ignore
        }
        return false;
      }
    });
    if (stillAlive.length === 0) break;
    if (Date.now() > deadline) {
      process.stderr.write(
        `phase_execute_observability: child dispatcher pids still alive after ${maxWaitS}s: ${stillAlive.join(",")}\n`,
      );
      // Preserve lifecycle records: do NOT call endRun if children are still
      // emitting. Exit non-zero so the SKILL's failure-handling kicks in.
      return 2;
    }
    await sleep(250);
  }

  // All children done → end the parent run via the daemon.
  const ctx = await connectRun(record.runId);
  try {
    await endRun(ctx, args.status);
  } finally {
    ctx._client?.close();
  }

  // Now SIGTERM the sentinel (it polls slowly so we accelerate the exit).
  try {
    process.kill(record.sentinel_pid, "SIGTERM");
    const sigtermDeadline = Date.now() + 5000;
    while (Date.now() < sigtermDeadline) {
      try {
        process.kill(record.sentinel_pid, 0);
      } catch {
        break; // gone
      }
      await sleep(100);
    }
    try {
      process.kill(record.sentinel_pid, 0);
      process.kill(record.sentinel_pid, "SIGKILL");
    } catch {
      // already gone — good
    }
  } catch {
    // sentinel already gone — fine
  }

  // Cleanup phase run state files.
  for (const p of [phaseRunJsonPath(sid), phaseRunEnvPath(sid), leasePath(sid)]) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
  try {
    rmSync(childrenDir(sid), { recursive: true, force: true });
  } catch {
    // ignore
  }
  return 0;
}

function listChildPids(cdir: string): number[] {
  if (!existsSync(cdir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(cdir);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const pid = Number.parseInt(f.slice(0, -5), 10);
    if (Number.isFinite(pid) && pid > 0) out.push(pid);
  }
  return out;
}

// ─── exec-child ────────────────────────────────────────────────────────────

async function cmdExecChild(args: {
  sessionId: string;
  child: string[];
}): Promise<number> {
  if (args.child.length === 0) throw new Error("exec-child requires a command after `--`");
  const sid = sanitizeSessionId(args.sessionId);
  // Refresh the lease so the sentinel doesn't exit mid-child.
  try {
    const now = new Date();
    utimesSync(leasePath(sid), now, now);
  } catch {
    // Lease may not exist yet if exec-child fired before start; ignore.
  }

  // Merge phase_run.env into the current environment, then spawn the child.
  const env = { ...process.env };
  const envPath = phaseRunEnvPath(sid);
  if (existsSync(envPath)) {
    const body = readFileSync(envPath, "utf-8");
    for (const line of body.split("\n")) {
      const m = line.match(/^export\s+([A-Z_][A-Z0-9_]*)='([^']*)'$/);
      if (m) env[m[1]] = m[2];
    }
  }

  const [cmd, ...rest] = args.child;
  const child = spawn(cmd, rest, { env, stdio: "inherit" });
  if (typeof child.pid === "number") {
    const markerPath = path.join(childrenDir(sid), `${child.pid}.json`);
    try {
      mkdirSync(childrenDir(sid), { recursive: true, mode: 0o700 });
      writeFileSync(
        markerPath,
        JSON.stringify({ pid: child.pid, cmd: args.child, started_at: new Date().toISOString() }),
        { mode: 0o600 },
      );
    } catch {
      // best-effort; if we can't write the marker, the `end` barrier will be
      // less strict for this child.
    }
    process.on("exit", () => {
      try {
        unlinkSync(markerPath);
      } catch {
        // ignore
      }
    });
  }

  // Background lease-refresh loop (every 30s while the child runs) so a
  // long-running child won't let the lease go stale even if the SKILL bash
  // block has exited (E3).
  const refresh = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(leasePath(sid), now, now);
    } catch {
      // ignore
    }
  }, 30_000);
  if (refresh.unref) refresh.unref();

  // Forward signals.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    });
  }

  return await new Promise<number>((resolve) => {
    child.on("error", (err) => {
      clearInterval(refresh);
      process.stderr.write(`exec-child: ${(err as Error).message}\n`);
      resolve(126);
    });
    child.on("exit", (code, signal) => {
      clearInterval(refresh);
      if (typeof code === "number") resolve(code);
      else if (signal) resolve(128 + (signalNum(signal) ?? 1));
      else resolve(1);
    });
  });
}

function signalNum(sig: NodeJS.Signals): number | null {
  // Minimal map used to translate signal → POSIX-style exit code.
  const m: Record<string, number> = {
    SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9, SIGQUIT: 3, SIGABRT: 6,
  };
  return m[sig] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── CLI ───────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  phase_execute_observability.ts start    --plan-slug SLUG [--session-id ID] [--repo ORG/REPO] [--branch NAME]
  phase_execute_observability.ts touch-lease [--session-id ID]
  phase_execute_observability.ts progress --kind KIND --payload JSON [--session-id ID]
  phase_execute_observability.ts subagent-start --agent A --model M --task T [--session-id ID]
  phase_execute_observability.ts subagent-end   --subagent-id ID --status ok|error|timeout [--duration-ms N] [--summary JSON] [--session-id ID]
  phase_execute_observability.ts end       --status ok|error|timeout [--session-id ID]
  phase_execute_observability.ts exec-child [--session-id ID] -- <cmd> [args...]
`;

async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const sub = argv[0];
  const rest = argv.slice(1);
  const flags = parseFlags(rest);

  const sessionId = await resolveSessionId(flags.get("--session-id"));

  switch (sub) {
    case "start": {
      const planSlug = flags.get("--plan-slug");
      if (!planSlug) throw new Error("start requires --plan-slug");
      return await cmdStart({
        planSlug,
        sessionId,
        repo: flags.get("--repo"),
        branch: flags.get("--branch"),
      });
    }
    case "touch-lease": {
      return await cmdTouchLease({ sessionId });
    }
    case "progress": {
      const kind = flags.get("--kind");
      const payload = flags.get("--payload");
      if (!kind) throw new Error("progress requires --kind");
      if (!payload) throw new Error("progress requires --payload");
      return await cmdProgress({ sessionId, kind, payload });
    }
    case "subagent-start": {
      const agent = flags.get("--agent");
      const model = flags.get("--model");
      const task = flags.get("--task");
      if (!agent) throw new Error("subagent-start requires --agent");
      if (!model) throw new Error("subagent-start requires --model");
      if (!task) throw new Error("subagent-start requires --task");
      return await cmdSubAgentStart({ sessionId, agent, model, task });
    }
    case "subagent-end": {
      const subagentId = flags.get("--subagent-id");
      const status = flags.get("--status") as "ok" | "error" | "timeout" | undefined;
      if (!subagentId) throw new Error("subagent-end requires --subagent-id");
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error("subagent-end --status must be ok|error|timeout");
      }
      const durationMsStr = flags.get("--duration-ms");
      return await cmdSubAgentEnd({
        sessionId,
        subagentId,
        status,
        durationMs: durationMsStr ? Number.parseInt(durationMsStr, 10) : undefined,
        summary: flags.get("--summary"),
      });
    }
    case "end": {
      const status = flags.get("--status") as "ok" | "error" | "timeout" | undefined;
      if (status !== "ok" && status !== "error" && status !== "timeout") {
        throw new Error("end --status must be ok|error|timeout");
      }
      return await cmdEnd({ sessionId, status });
    }
    case "exec-child": {
      const sep = rest.indexOf("--");
      const child = sep === -1 ? [] : rest.slice(sep + 1);
      if (child.length === 0) throw new Error("exec-child requires `-- <cmd> [args...]`");
      return await cmdExecChild({ sessionId, child });
    }
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n${USAGE}`);
      return 2;
  }
}

/**
 * Tiny flag parser: collects `--name value` pairs into a Map. Stops at `--`.
 * Does NOT validate; subcommand-specific logic does that.
 */
function parseFlags(argv: ReadonlyArray<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break;
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        // boolean flag — record presence with empty string
        out.set(a, "");
      } else {
        out.set(a, v);
        i++;
      }
    }
  }
  return out;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`phase_execute_observability: ${(err as Error).message}\n`);
    process.exit(1);
  });
