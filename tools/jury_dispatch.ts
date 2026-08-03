/**
 * Parallel seat fan-out for `/stark-jury` — the layer between a validated
 * panel and three vendor CLIs.
 *
 * What this module owns:
 *
 *   - **Command construction via the BUILDERS.** `agent_claude.ts`,
 *     `agent_codex.ts` and `agent_gemini.ts` already solve per-vendor argv and
 *     per-vendor environment; this module adds only what the jury needs on top
 *     and nothing else. A vendor CLI change therefore breaks in ONE place, with
 *     tests that assert command shape.
 *   - **Workspace parity.** Every seat runs from an empty scratch cwd with the
 *     repo unreachable: claude with its tool set disabled (`--tools ""`), codex
 *     under `-s read-only` (+ the builder's `--skip-git-repo-check`, without
 *     which codex refuses to start outside a trusted dir), gemini through the
 *     scratch-home machinery `agent_gemini.ts` already provides. Vendor system
 *     prompts still differ — that residual asymmetry is stated in SKILL.md, not
 *     hidden here.
 *   - **Per-seat capture:** stdout, exit code, wall latency, and — where the
 *     vendor CLI actually reports them — token counts and cost. Token/cost
 *     fields are NULLABLE and carry a `usage_source`. A seat whose CLI reported
 *     nothing stores nulls; this module never estimates.
 *   - **Timeout → process-group kill → no-survivor check.** The default is 30
 *     minutes (`jury.timeout_sec` in the global config overrides it). The kill
 *     targets the process GROUP, not the pid: a bare `child.kill()` leaves the
 *     vendor CLI's own children running, which is how a "killed" run keeps
 *     billing and keeps competing with its retry.
 *   - **Truncation + length-floor detection.** The CLI's own finish/limit
 *     signal where one exists, plus a length floor for rewrite candidates:
 *     below 15% of the source is FAILED, below 40% is a warning that travels
 *     into the report.
 *   - **The failure ladder's call-level half:** all seats failed, exactly one
 *     survivor, or partial failure recorded. (The CLEAN/DISQUALIFIED half is
 *     `jury_verify.ts`; the ladder's session-facing half is SKILL.md.)
 *
 * **The prompt travels on stdin: write-then-close.** All three builders deliver
 * the prompt that way. The fleet's `</dev/null` scar belongs to shell-style
 * dispatches that pass the prompt as an argv argument — here a `</dev/null`
 * would deliver an EMPTY prompt and burn a run, so `assertPromptOnStdin` makes
 * both mistakes (an empty prompt, a `/dev/null` in argv) loud before spawn.
 *
 * Every effectful edge is injectable (`DispatchDeps`), so the tests assert
 * command shape against the REAL builders and exercise the execution paths
 * through fake runners — no vendor CLI, no cost, no network.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildCommand as buildClaude, normalizeOutput as normalizeClaude } from "./agent_claude.ts";
import { buildCommand as buildCodex, extractLastAgentText as lastCodexText } from "./agent_codex.ts";
import { buildCommand as buildGemini, normalizeOutput as normalizeGemini } from "./agent_gemini.ts";
import type { BuildContext, BuiltCommand } from "./agent_codex.ts";
import { effortForManifest, type Panel, type PanelSeat, type SeatId } from "./jury_panel.ts";
import { getModelRates, loadGlobalConfig, type ModelRate } from "./stark_config_lib.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rewrite modes merge; calibration mode reports. The length floor applies to
 *  rewrite candidates only — a scorecard is legitimately shorter than the post
 *  it scores. */
export type JuryMode = "rewrite" | "calibration";

/** 30 minutes. Reasoning-heavy seats take minutes, not seconds; a shorter
 *  default would kill the exact runs the jury exists to compare. */
export const DEFAULT_TIMEOUT_SEC = 30 * 60;

/** Below this fraction of the source length a rewrite candidate is FAILED. */
export const LENGTH_FLOOR_FAIL = 0.15;
/** Below this fraction it is a warning that travels into the report. */
export const LENGTH_FLOOR_WARN = 0.4;

/** After "exit", how long to wait for "close" before force-settling: an
 *  escaped descendant (setsid, EPERM on the group kill) can inherit stdout and
 *  hold the pipe open forever, and a survivor must never hang the whole run. */
export const EXIT_CLOSE_GRACE_MS = 2_000;

/** SIGTERM → grace → SIGKILL, then confirm the group is actually gone. */
export const KILL_GRACE_MS = 5_000;
export const SURVIVOR_CHECK_ATTEMPTS = 10;
export const SURVIVOR_CHECK_INTERVAL_MS = 200;

/** 32 MiB per stream — a runaway CLI cannot eat the host's memory. */
const OUTPUT_CAP_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FailureReason =
  | "spawn_failed"
  | "timeout"
  | "cli_error"
  | "exit_nonzero"
  | "empty_output"
  | "truncated"
  | "too_short";

export interface SeatFailure {
  reason: FailureReason;
  detail: string;
}

/** What the vendor actually reported. Every numeric field is nullable and
 *  `usage_source` names the shape it came from; `null` means the CLI reported
 *  nothing and nothing was invented. */
export interface SeatUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  usage_source: string | null;
  cost_source: string | null;
}

export interface KillReport {
  /** False when there was no live process group to signal. */
  attempted: boolean;
  signals: string[];
  /** True when something in the group outlived SIGKILL — a loud, recorded fact. */
  survivors: boolean;
  detail: string;
}

export interface SeatCommand {
  seat: SeatId;
  model: string;
  effort: string | null;
  cmd: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
}

export interface SeatResult {
  seat: SeatId;
  model: string;
  /** Manifest form: the resolved level, or `"n/a"` for a vendor with no knob. */
  effort: string;
  status: "ok" | "failed";
  /** The candidate text, vendor framing unwrapped. Empty on failure. */
  output: string;
  raw_stdout: string;
  raw_stderr: string;
  exit_code: number | null;
  signal: string | null;
  latency_ms: number;
  timed_out: boolean;
  truncated: boolean;
  /** Candidate length / source length, or null when the source is empty. */
  length_ratio: number | null;
  warnings: string[];
  failure: SeatFailure | null;
  usage: SeatUsage;
  kill: KillReport | null;
  command: { cmd: string; args: string[] };
}

/**
 * Call-level ladder:
 *   all-failed — nothing came back; the run errors loudly (`assertSurvivors`).
 *   single     — exactly one seat produced output; the session performs NO
 *                merge ("arbitrating one opinion is theater").
 *   partial    — two or more survived, at least one failed; failures recorded.
 *   complete   — every seat survived.
 */
export type Ladder = "all-failed" | "single" | "partial" | "complete";

export interface DispatchResult {
  mode: JuryMode;
  seats: SeatResult[];
  survivors: SeatResult[];
  failures: SeatResult[];
  ladder: Ladder;
}

export interface RunRequest {
  seat: SeatId;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  timeoutMs: number;
}

export interface RunOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
  /** True once the prompt was written AND the pipe closed. */
  stdinClosed: boolean;
  kill?: KillReport | null;
}

export type SeatRunner = (req: RunRequest) => Promise<RunOutcome>;

export type SeatBuilder = (
  prompt: string,
  model?: string,
  ctx?: BuildContext,
) => BuiltCommand;

export interface DispatchDeps {
  runner?: SeatRunner;
  builders?: Record<SeatId, SeatBuilder>;
  /** Monotonic-ish clock for wall latency. */
  now?: () => number;
  /** Scratch-cwd lifecycle — injectable so tests never touch the real tmpdir. */
  mkScratch?: (seat: SeatId) => string;
  cleanupScratch?: (dir: string) => void;
  rates?: Record<string, ModelRate>;
  /** Global config object, for the timeout override. */
  config?: Record<string, unknown>;
}

export interface DispatchOptions {
  panel: Panel;
  /** The byte-identical payload every seat receives. */
  prompt: string;
  /** The source document — the length floor measures against it. */
  source: string;
  mode: JuryMode;
  timeoutMs?: number;
  deps?: DispatchDeps;
  /** Fired as each seat settles, so the caller can persist the candidate and
   *  append its audit row immediately after the call returns. */
  onSeat?: (result: SeatResult) => void;
}

/** Thrown by `assertSurvivors` when nothing came back — carries EVERY seat's
 *  failure so one error message names all three. */
export class DispatchError extends Error {
  readonly failures: SeatResult[];

  constructor(failures: SeatResult[]) {
    const lines = failures.map(
      (f) => `${f.seat} (${f.model}): ${f.failure?.reason ?? "unknown"} — ${f.failure?.detail ?? ""}`,
    );
    super(`every seat failed:\n  - ${lines.join("\n  - ")}`);
    this.name = "DispatchError";
    this.failures = failures;
  }
}

// ---------------------------------------------------------------------------
// Command construction
// ---------------------------------------------------------------------------

export const REAL_BUILDERS: Record<SeatId, SeatBuilder> = {
  claude: buildClaude,
  codex: buildCodex,
  gemini: buildGemini,
};

const NORMALIZERS: Record<SeatId, (stdout: string) => string> = {
  claude: normalizeClaude,
  // The LAST agent message only: normalizeOutput concatenates every
  // agent_message including intermediate narration ("I'll apply the skill
  // now..."), and the payload contract is the resulting document ALONE.
  codex: lastCodexText,
  gemini: normalizeGemini,
};

/**
 * Add the codex sandbox flag the jury requires. `-s read-only` is NOT part of
 * `agent_codex.ts` (it lives only in stark-story-judge's shell dispatch today),
 * so the jury adds it explicitly rather than trusting the builder's default.
 * Idempotent: a builder that grows the flag later does not get a second copy.
 */
function withCodexSandbox(args: string[]): string[] {
  if (args.includes("-s") || args.includes("--sandbox")) return args;
  const execAt = args.indexOf("exec");
  const at = execAt === -1 ? 0 : execAt + 1;
  return [...args.slice(0, at), "-s", "read-only", ...args.slice(at)];
}

/**
 * Build one seat's command from the vendor builder.
 *
 * claude — `--effort <level>` + `--tools ""` (tool lockdown), run from the
 *          scratch cwd so it cannot read a repo the other seats cannot.
 * codex  — `-c model_reasoning_effort="<level>"` from the builder, plus
 *          `-s read-only`; `--skip-git-repo-check` must already be there or the
 *          CLI refuses to start in the scratch cwd, so its absence is an error
 *          here rather than a burnt dispatch.
 * gemini — no effort knob; the builder owns the isolated GEMINI_CLI_HOME and
 *          returns the cwd it registered.
 */
export function buildSeatCommand(
  seat: PanelSeat,
  prompt: string,
  scratchCwd: string,
  builders: Record<SeatId, SeatBuilder> = REAL_BUILDERS,
): SeatCommand {
  const build = builders[seat.seat];
  if (typeof build !== "function") {
    throw new Error(`jury_dispatch: no builder for seat "${seat.seat}"`);
  }

  const ctx: BuildContext = { cwd: scratchCwd, trustedGeneratedCwd: true };
  if (seat.effort !== null) ctx.effort = seat.effort;
  if (seat.seat === "claude") ctx.disableTools = true;

  const built = build(prompt, seat.model, ctx);
  let args = built.args;

  if (seat.seat === "codex") {
    if (!args.includes("--skip-git-repo-check")) {
      throw new Error(
        "jury_dispatch: codex command is missing --skip-git-repo-check — the seat " +
          "runs from an untrusted scratch cwd and the CLI would refuse to start " +
          "(agent_codex.ts owns the flag; a builder change broke it)",
      );
    }
    args = withCodexSandbox(args);
  }

  const command: SeatCommand = {
    seat: seat.seat,
    model: seat.model,
    effort: seat.effort,
    cmd: built.cmd,
    args,
    stdin: built.stdin,
    env: built.env,
    cwd: built.cwd ?? scratchCwd,
  };
  assertPromptOnStdin(command);
  return command;
}

/**
 * The prompt must travel on stdin, written then closed.
 *
 * Two failure shapes this catches before a vendor bills for them: an EMPTY
 * prompt (what a literal `</dev/null` delivers through these builders — the
 * inverse of the fleet's hang scar), and a `/dev/null` that leaked into argv
 * because someone ported a shell-style dispatch verbatim.
 */
export function assertPromptOnStdin(command: SeatCommand): void {
  if (typeof command.stdin !== "string" || command.stdin.trim() === "") {
    throw new Error(
      `jury_dispatch: seat "${command.seat}" has an empty stdin prompt — these ` +
        "builders deliver the prompt on stdin, so an empty one dispatches nothing",
    );
  }
  const nullish = command.args.find((a) => a.includes("/dev/null"));
  if (nullish !== undefined) {
    throw new Error(
      `jury_dispatch: seat "${command.seat}" carries "${nullish}" in argv — the ` +
        "prompt travels on stdin (write-then-close), never a redirect",
    );
  }
}

// ---------------------------------------------------------------------------
// Timeout resolution
// ---------------------------------------------------------------------------

/**
 * Dispatch timeout in ms: `jury.timeout_sec` from the global config, else 30
 * minutes. A non-numeric or non-positive override is ignored rather than
 * silently producing an instant-kill run.
 */
export function resolveTimeoutMs(config?: Record<string, unknown>): number {
  const cfg = config ?? loadGlobalConfig();
  const section = cfg["jury"];
  if (section !== null && typeof section === "object") {
    const raw = (section as Record<string, unknown>)["timeout_sec"];
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.round(raw * 1000);
  }
  return DEFAULT_TIMEOUT_SEC * 1000;
}

// ---------------------------------------------------------------------------
// Usage + cost
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Every JSON value the stdout carries — one envelope object, or one per JSONL
 *  line. Unparseable lines are skipped: framing chatter is not an error. */
function jsonValues(stdout: string): unknown[] {
  const out: unknown[] = [];
  const trimmed = stdout.trim();
  if (trimmed === "") return out;
  try {
    out.push(JSON.parse(trimmed));
    return out;
  } catch {
    // not one document — fall through to the line scan
  }
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || (!line.startsWith("{") && !line.startsWith("["))) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // partial or non-JSON line — skip it, keep the rest
    }
  }
  return out;
}

/** Depth-first walk over every object node, in document order. */
function walkObjects(value: unknown, visit: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (!isPlainObject(value)) return;
  visit(value);
  for (const child of Object.values(value)) walkObjects(child, visit);
}

/** Token-count key pairs the three CLIs actually use, most specific first. */
const TOKEN_KEY_PAIRS: ReadonlyArray<{ input: string; output: string; label: string }> = [
  { input: "input_tokens", output: "output_tokens", label: "input_tokens/output_tokens" },
  { input: "prompt_tokens", output: "completion_tokens", label: "prompt_tokens/completion_tokens" },
  {
    input: "promptTokenCount",
    output: "candidatesTokenCount",
    label: "promptTokenCount/candidatesTokenCount",
  },
];

/**
 * Extract token counts + cost from raw vendor stdout.
 *
 * Deliberately tolerant across the shapes the three CLIs emit (claude's result
 * envelope, codex's JSONL usage events, gemini's usage metadata) and
 * deliberately honest when it recognizes none: nulls with `usage_source: null`.
 * The LAST matching record wins — vendors emit running totals, and the final
 * one is the turn total.
 *
 * Cost prefers a vendor-reported figure (`total_cost_usd`) and otherwise
 * computes from the config rates table; `cost_source` says which.
 */
export function extractUsage(
  seat: SeatId,
  model: string,
  stdout: string,
  rates?: Record<string, ModelRate>,
): SeatUsage {
  const empty: SeatUsage = {
    input_tokens: null,
    output_tokens: null,
    cost_usd: null,
    usage_source: null,
    cost_source: null,
  };

  // Held in a box, not a bare `let`: the assignments happen inside a callback,
  // so a plain local would narrow to `null` for every reader below it.
  const hit: {
    tokens: { input: number | null; output: number | null; label: string } | null;
    cost: number | null;
  } = { tokens: null, cost: null };

  for (const value of jsonValues(stdout)) {
    walkObjects(value, (node) => {
      const cost = finiteNumber(node["total_cost_usd"]);
      if (cost !== null) hit.cost = cost;
      for (const pair of TOKEN_KEY_PAIRS) {
        const input = finiteNumber(node[pair.input]);
        const output = finiteNumber(node[pair.output]);
        if (input === null && output === null) continue;
        hit.tokens = { input, output, label: pair.label };
        return;
      }
    });
  }

  const found = hit.tokens;
  const vendorCost = hit.cost;
  if (found === null && vendorCost === null) return empty;

  const inputTokens = found?.input ?? null;
  const outputTokens = found?.output ?? null;
  const usage: SeatUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: null,
    usage_source: found === null ? `${seat}:total_cost_usd` : `${seat}:${found.label}`,
    cost_source: null,
  };

  if (vendorCost !== null) {
    usage.cost_usd = vendorCost;
    usage.cost_source = `${seat}:total_cost_usd`;
    return usage;
  }
  const computed = computeCost(model, inputTokens, outputTokens, rates);
  if (computed !== null) {
    usage.cost_usd = computed;
    usage.cost_source = `rates:${model}`;
  }
  return usage;
}

/**
 * Cost from the config rates table. Returns null when the model has no row —
 * the manifest carries a null, never a guess. (`jury_panel.ts` already rejects
 * a model absent from the table, so a null here means a table changed under a
 * run in flight.)
 */
export function computeCost(
  model: string,
  inputTokens: number | null,
  outputTokens: number | null,
  rates?: Record<string, ModelRate>,
): number | null {
  if (inputTokens === null && outputTokens === null) return null;
  const table = rates ?? getModelRates();
  const rate = table[model];
  if (rate === undefined) return null;
  const inUsd = ((inputTokens ?? 0) / 1_000_000) * rate.input_per_1m_usd;
  const outUsd = ((outputTokens ?? 0) / 1_000_000) * rate.output_per_1m_usd;
  return inUsd + outUsd;
}

// ---------------------------------------------------------------------------
// Truncation + length floor
// ---------------------------------------------------------------------------

export interface TruncationSignal {
  truncated: boolean;
  /** `key=value` of the signal that fired, or null. */
  signal: string | null;
}

const FINISH_KEYS = ["stop_reason", "stopReason", "finish_reason", "finishReason"] as const;
const LIMIT_VALUES = new Set(["max_tokens", "max_output_tokens", "length", "model_max_tokens"]);

/**
 * The CLI's OWN finish/limit signal, where one exists: claude's
 * `stop_reason: "max_tokens"`, codex's `finish_reason: "length"`, gemini's
 * `finishReason: "MAX_TOKENS"`, or an explicit `truncated: true`. Case- and
 * shape-tolerant on purpose — a vendor renaming its enum casing must not
 * silently turn a truncated candidate into a clean one.
 */
export function detectTruncation(stdout: string): TruncationSignal {
  // Boxed for the same reason as extractUsage's: assigned inside a callback.
  const found: { signal: string | null } = { signal: null };
  for (const value of jsonValues(stdout)) {
    walkObjects(value, (node) => {
      if (node["truncated"] === true) found.signal = "truncated=true";
      for (const key of FINISH_KEYS) {
        const raw = node[key];
        if (typeof raw !== "string") continue;
        if (LIMIT_VALUES.has(raw.toLowerCase())) found.signal = `${key}=${raw}`;
      }
    });
  }
  return { truncated: found.signal !== null, signal: found.signal };
}

export type LengthStatus = "ok" | "warning" | "failed";

export interface LengthCheck {
  status: LengthStatus;
  /** candidate length / source length, or null when the source is empty. */
  ratio: number | null;
  message: string | null;
}

/**
 * Length floor for REWRITE candidates: below 15% of the source is FAILED (a
 * truncated or refused generation), below 40% is a warning that travels into
 * the report. Calibration is exempt — a scorecard is legitimately a fraction of
 * the post it scores.
 *
 * Measured in trimmed characters, the one unit that needs no tokenizer and no
 * vendor agreement.
 */
export function checkLength(source: string, candidate: string, mode: JuryMode): LengthCheck {
  const sourceLen = source.trim().length;
  const candidateLen = candidate.trim().length;
  if (sourceLen === 0) {
    return { status: "ok", ratio: null, message: null };
  }
  const ratio = candidateLen / sourceLen;
  if (mode !== "rewrite") return { status: "ok", ratio, message: null };
  const pct = (ratio * 100).toFixed(1);
  if (ratio < LENGTH_FLOOR_FAIL) {
    return {
      status: "failed",
      ratio,
      message:
        `candidate is ${pct}% of the source length (${candidateLen}/${sourceLen} chars), ` +
        `below the ${LENGTH_FLOOR_FAIL * 100}% floor`,
    };
  }
  if (ratio < LENGTH_FLOOR_WARN) {
    return {
      status: "warning",
      ratio,
      message:
        `candidate is ${pct}% of the source length (${candidateLen}/${sourceLen} chars), ` +
        `below the ${LENGTH_FLOOR_WARN * 100}% warning line`,
    };
  }
  return { status: "ok", ratio, message: null };
}

// ---------------------------------------------------------------------------
// Process-group kill
// ---------------------------------------------------------------------------

export interface KillDeps {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  graceMs?: number;
  survivorChecks?: number;
  survivorIntervalMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

function isEsrch(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ESRCH";
}

/**
 * Kill a whole process GROUP and confirm nothing survived.
 *
 * Why the group: the vendor CLIs spawn children (a sandbox helper, a language
 * server, a model-side streamer). `child.kill()` signals the leader only, so a
 * "killed" seat keeps burning tokens and keeps competing with whatever runs
 * next — the fleet has already paid for that lesson.
 *
 * SIGTERM → grace → SIGKILL → poll `kill(pgid, 0)` until ESRCH. An EPERM on the
 * probe means the group exists but is not ours to signal, which counts as a
 * SURVIVOR: reporting it is the whole point of the check.
 *
 * `pgid` is the group id (== the detached child's pid); the negation is applied
 * here so callers cannot get the sign wrong.
 */
export async function killProcessGroup(pgid: number, deps: KillDeps = {}): Promise<KillReport> {
  const kill = deps.kill ?? defaultKill;
  const sleep = deps.sleep ?? defaultSleep;
  const graceMs = deps.graceMs ?? KILL_GRACE_MS;
  const checks = deps.survivorChecks ?? SURVIVOR_CHECK_ATTEMPTS;
  const intervalMs = deps.survivorIntervalMs ?? SURVIVOR_CHECK_INTERVAL_MS;
  const signals: string[] = [];

  if (!Number.isInteger(pgid) || pgid <= 1) {
    return {
      attempted: false,
      signals,
      survivors: false,
      detail: `no process group to kill (pgid=${String(pgid)})`,
    };
  }
  const group = -pgid;

  const alive = (): boolean => {
    try {
      kill(group, 0);
      return true;
    } catch (err) {
      // ESRCH = gone. Anything else (EPERM) means it exists and we cannot
      // signal it — alive, and the caller must hear about it.
      return !isEsrch(err);
    }
  };

  /** Poll until the group is gone or the budget runs out. Polling rather than
   *  one blind sleep: the common case is a group that dies on SIGTERM in
   *  milliseconds, and a fixed grace would stall every timeout by the full
   *  window before the caller could record anything. */
  const waitForExit = async (budgetMs: number): Promise<boolean> => {
    const rounds = Math.max(1, Math.ceil(budgetMs / Math.max(1, intervalMs)));
    for (let i = 0; i < rounds; i += 1) {
      if (!alive()) return true;
      await sleep(intervalMs);
    }
    return !alive();
  };

  try {
    kill(group, "SIGTERM");
    signals.push("SIGTERM");
  } catch (err) {
    if (isEsrch(err)) {
      return { attempted: true, signals, survivors: false, detail: "group already gone at SIGTERM" };
    }
    signals.push("SIGTERM(failed)");
  }

  if (await waitForExit(graceMs)) {
    return { attempted: true, signals, survivors: false, detail: "group exited on SIGTERM" };
  }

  try {
    kill(group, "SIGKILL");
    signals.push("SIGKILL");
  } catch (err) {
    if (isEsrch(err)) {
      return { attempted: true, signals, survivors: false, detail: "group exited before SIGKILL" };
    }
    signals.push("SIGKILL(failed)");
  }

  if (await waitForExit(checks * intervalMs)) {
    return { attempted: true, signals, survivors: false, detail: "group exited on SIGKILL" };
  }
  return {
    attempted: true,
    signals,
    survivors: true,
    detail: `process group ${pgid} survived SIGKILL after ${checks} checks`,
  };
}

// ---------------------------------------------------------------------------
// The real runner
// ---------------------------------------------------------------------------

/**
 * Spawn one seat. `detached: true` puts the child in its OWN process group so
 * the timeout path can kill the whole tree; stdin is always a pipe that gets
 * the prompt written and then CLOSED (never inherited — an inherited pipe never
 * EOFs, which is how a headless dispatch hangs for hours).
 */
export const realRunner: SeatRunner = (req) =>
  new Promise<RunOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(req.cmd, req.args, {
        cwd: req.cwd,
        env: req.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: e.message ?? String(err),
        timedOut: false,
        notFound: e.code === "ENOENT",
        stdinClosed: false,
        kill: null,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdinClosed = false;
    let timedOut = false;
    let notFound = false;
    let killing: Promise<KillReport | null> | null = null;
    let settled = false;

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const emit = (kill: KillReport | null): void =>
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          timedOut,
          notFound,
          stdinClosed,
          kill,
        });
      // A killed group usually closes our pipes the instant SIGTERM lands —
      // well before the no-survivor check finishes. Resolving on "close" alone
      // therefore drops the kill report on the floor, which is the one piece of
      // evidence a timeout exists to produce. Wait for the check.
      if (killing === null) emit(null);
      else void killing.then(emit, () => emit(null));
    };

    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      // Do NOT resolve here: the result still waits for "close" so the bytes the
      // child already wrote are captured.
      killing = pid === undefined ? Promise.resolve(null) : killProcessGroup(pid);
      void killing.catch(() => null);
    }, req.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen >= OUTPUT_CAP_BYTES) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen >= OUTPUT_CAP_BYTES) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });

    // Write-then-close. EPIPE here means the CLI exited before reading the
    // whole prompt — the exit code tells that story, so swallow the noise.
    child.stdin?.on("error", () => { /* EPIPE on an early exit */ });
    child.stdin?.once("close", () => { stdinClosed = true; });
    child.stdin?.end(req.stdin);

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      notFound = e.code === "ENOENT";
      stderrChunks.push(Buffer.from(e.message ?? String(err)));
      finish(null, null);
    });
    // "close" requires every stdio pipe to end, and an escaped descendant can
    // hold stdout open after the leader dies — so "exit" arms a grace timer
    // and force-settles (destroying the streams) if "close" never comes.
    // finish() is idempotent, so the normal close path is unaffected.
    child.on("exit", (code, signal) => {
      const grace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, EXIT_CLOSE_GRACE_MS);
      child.once("close", () => clearTimeout(grace));
    });
    child.on("close", (code, signal) => finish(code, signal));
  });

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function defaultMkScratch(seat: SeatId): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stark-jury-${seat}-`));
}

function defaultCleanupScratch(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a leftover scratch dir is noise, never a run failure
  }
}

function failedSeat(
  seat: PanelSeat,
  failure: SeatFailure,
  base: Partial<SeatResult> = {},
): SeatResult {
  return {
    seat: seat.seat,
    model: seat.model,
    effort: effortForManifest(seat),
    status: "failed",
    output: "",
    raw_stdout: "",
    raw_stderr: "",
    exit_code: null,
    signal: null,
    latency_ms: 0,
    timed_out: false,
    truncated: false,
    length_ratio: null,
    warnings: [],
    failure,
    usage: {
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      usage_source: null,
      cost_source: null,
    },
    kill: null,
    command: { cmd: "", args: [] },
    ...base,
  };
}

/**
 * Run ONE seat: build, dispatch, capture, classify. Never throws for a seat
 * failure — a failed seat is data the manifest must carry, not an exception
 * that loses the other two seats' work.
 */
export async function dispatchSeat(
  seat: PanelSeat,
  opts: Omit<DispatchOptions, "panel">,
): Promise<SeatResult> {
  const deps = opts.deps ?? {};
  const runner = deps.runner ?? realRunner;
  const now = deps.now ?? (() => Date.now());
  const mkScratch = deps.mkScratch ?? defaultMkScratch;
  const cleanupScratch = deps.cleanupScratch ?? defaultCleanupScratch;
  const timeoutMs = opts.timeoutMs ?? resolveTimeoutMs(deps.config);

  let scratch: string | null = null;
  try {
    scratch = mkScratch(seat.seat);
    const command = buildSeatCommand(seat, opts.prompt, scratch, deps.builders);
    const started = now();
    const outcome = await runner({
      seat: seat.seat,
      cmd: command.cmd,
      args: command.args,
      env: command.env,
      cwd: command.cwd,
      stdin: command.stdin,
      timeoutMs,
    });
    const latency = Math.max(0, now() - started);
    return classifySeat(seat, command, outcome, latency, opts);
  } catch (err) {
    // A build-time refusal (empty prompt, a builder that dropped a required
    // flag) is this seat's failure, recorded like any other.
    return failedSeat(seat, { reason: "spawn_failed", detail: (err as Error).message });
  } finally {
    if (scratch !== null) cleanupScratch(scratch);
  }
}

/**
 * Turn a raw run outcome into a seat result. The classification order is the
 * spec's: timeout, spawn failure, CLI-reported error, non-zero exit, empty
 * output, truncation, then the length floor.
 */
export function classifySeat(
  seat: PanelSeat,
  command: SeatCommand,
  outcome: RunOutcome,
  latencyMs: number,
  opts: Pick<DispatchOptions, "source" | "mode" | "deps">,
): SeatResult {
  const normalize = NORMALIZERS[seat.seat];
  const output = outcome.stdout === "" ? "" : normalize(outcome.stdout);
  const truncation = detectTruncation(outcome.stdout);
  const length = checkLength(opts.source, output, opts.mode);
  const usage = extractUsage(seat.seat, seat.model, outcome.stdout, opts.deps?.rates);
  const warnings: string[] = [];

  const result: SeatResult = {
    seat: seat.seat,
    model: seat.model,
    effort: effortForManifest(seat),
    status: "ok",
    output,
    raw_stdout: outcome.stdout,
    raw_stderr: outcome.stderr,
    exit_code: outcome.code,
    signal: outcome.signal,
    latency_ms: latencyMs,
    timed_out: outcome.timedOut,
    truncated: truncation.truncated,
    length_ratio: length.ratio,
    warnings,
    failure: null,
    usage,
    kill: outcome.kill ?? null,
    command: { cmd: command.cmd, args: command.args },
  };

  if (outcome.kill?.survivors === true) {
    warnings.push(`process group survived the kill: ${outcome.kill.detail}`);
  }

  const fail = (reason: FailureReason, detail: string): SeatResult => {
    result.status = "failed";
    result.failure = { reason, detail };
    return result;
  };

  if (outcome.timedOut) {
    const killDetail = outcome.kill === null || outcome.kill === undefined
      ? "no kill report"
      : `${outcome.kill.signals.join("→") || "no signal"}; ${outcome.kill.detail}`;
    return fail("timeout", `seat exceeded its timeout (${killDetail})`);
  }
  if (outcome.notFound) {
    return fail("spawn_failed", `${command.cmd} not found on PATH: ${outcome.stderr.trim()}`);
  }
  const cliError = claudeEnvelopeError(seat.seat, outcome.stdout);
  if (cliError !== null) return fail("cli_error", cliError);
  if (outcome.code !== 0) {
    return fail(
      "exit_nonzero",
      `exit ${outcome.code === null ? `signal ${outcome.signal}` : outcome.code}: ` +
        `${outcome.stderr.trim().slice(0, 500)}`,
    );
  }
  if (output.trim() === "") return fail("empty_output", "the seat returned no output");
  if (truncation.truncated) {
    return fail("truncated", `the CLI reported a length limit (${truncation.signal})`);
  }
  if (length.status === "failed") return fail("too_short", length.message ?? "below the length floor");
  if (length.status === "warning" && length.message !== null) warnings.push(length.message);
  return result;
}

/** claude's `--output-format json` envelope marks a failed run with
 *  `is_error: true` and puts the reason in `result` — an exhausted account must
 *  not read as "the model returned prose". */
function claudeEnvelopeError(seat: SeatId, stdout: string): string | null {
  if (seat !== "claude") return null;
  const trimmed = stdout.trim();
  if (trimmed === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed) || parsed["is_error"] !== true) return null;
  const detail = typeof parsed["result"] === "string" && parsed["result"] !== ""
    ? parsed["result"]
    : typeof parsed["subtype"] === "string"
      ? parsed["subtype"]
      : "no detail in envelope";
  return `claude run failed: ${detail}`;
}

/** Classify the ladder from settled seats. */
export function ladderFor(results: SeatResult[]): Ladder {
  const ok = results.filter((r) => r.status === "ok");
  if (ok.length === 0) return "all-failed";
  if (ok.length === 1) return "single";
  return ok.length === results.length ? "complete" : "partial";
}

/**
 * Fan the payload out to every seat IN PARALLEL and settle them all.
 *
 * Parallel is not an optimization here: the seats are the comparison, and a
 * sequential run would let a slow vendor's timeout dictate the run's wall
 * clock. No seat's failure cancels another — every seat's outcome is recorded.
 */
export async function dispatchPanel(opts: DispatchOptions): Promise<DispatchResult> {
  const { panel, onSeat, ...rest } = opts;
  const seats = await Promise.all(
    panel.seats.map(async (seat) => {
      const result = await dispatchSeat(seat, rest);
      if (onSeat !== undefined) onSeat(result);
      return result;
    }),
  );
  return {
    mode: opts.mode,
    seats,
    survivors: seats.filter((s) => s.status === "ok"),
    failures: seats.filter((s) => s.status === "failed"),
    ladder: ladderFor(seats),
  };
}

/**
 * The ladder's loud end: zero survivors throws, listing every seat's failure.
 * Kept separate from `dispatchPanel` on purpose — the caller persists the
 * manifest and the per-seat evidence FIRST, then raises. A run that dies before
 * writing what it learned is a run you cannot diagnose.
 */
export function assertSurvivors(result: DispatchResult): void {
  if (result.ladder === "all-failed") throw new DispatchError(result.failures);
}
