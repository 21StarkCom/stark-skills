#!/usr/bin/env -S node --experimental-strip-types
/**
 * stark_review_doc — multi-round doc review with lead/wing fix loop.
 *
 * Shared dispatcher for /stark-review-spec and /stark-review-plan.
 * Selected with `--prompts-dir spec-review|plan-review`.
 *
 *   Lead:  the reviewer, dispatched per-domain in parallel (capped via
 *          --codex-concurrent). Default agent codex (gpt-5.6-sol) at xhigh; set
 *          --lead-agent claude to run it on a Claude model (defaults to
 *          claude-fable-5). Model override: --lead-model.
 *   Wing:  the fixer — receives findings + current doc, emits a JSON
 *          {patches: [...]} block. Host applies patches sequentially with
 *          unique-match validation; on partial failure it retries the wing
 *          once with failures attached, then gives up the round. Default
 *          agent claude (opus-4-8); set --wing-agent codex to run it on
 *          codex (gpt-5.6-sol at xhigh). Model override: --wing-model. Lead and
 *          wing agents/models are independent.
 *
 * Each fix round commits to git so the evolution of the doc is traceable.
 * A final review-only round runs after the last fix round (or after early
 * termination) to capture unresolved findings.
 *
 * stdout: a single JSON receipt (the wrapper SKILL.md parses this).
 * stderr: human-readable progress + summary.
 *
 * Exit codes:
 *   0 — ok: every domain completed a review at least once (transient
 *       dispatch failures that recovered in a later round do not fail the run)
 *   1 — terminal failure OR coverage gap (≥1 domain never completed a
 *       review in any round — reported in receipt.coverage_gaps)
 *   2 — bad arguments
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";

import type { AgentName } from "./stark_review_lib.ts";
import {
  applyPatches,
  buildConvergenceInput,
  buildFixerPrompt,
  buildReviewerPrompt,
  buildHistoryDir,
  capFindingsToFix,
  classifyFindings,
  computeCoverage,
  DEFAULT_DOC_REVIEW_CONFIG,
  dedupeDocFindings,
  deriveRunOutcome,
  type DocFinding,
  type DocReviewConfig,
  type DomainCoverage,
  discoverDomains,
  docFindingId,
  type FixerPatch,
  isReviewMutationCommitSubject,
  MAX_ROUNDS_CEILING,
  newRunId,
  nextDomainTimeout,
  parseFixerOutput,
  parseReviewerOutput,
  persistRoundsHistory,
  type PersistedRound,
  pmap,
  type PriorDisposition,
  type PromptSources,
  pruneRunDirs,
  renderPriorDispositions,
  renderPriorRoundChanges,
  resolveConvergencePromptSources,
  resolveDocPromptSources,
  scaleTimeoutForDocSize,
  selectFindingsToFix,
  updateLatestPointer,
  writeJsonAtomic,
} from "./stark_review_doc_lib.ts";
import { buildCoherencePrompt } from "./stark_review_doc_lib.ts";
import {
  buildAnalytics,
  countLines,
  evaluateGuards,
  type HealthFlag,
  renderAnalyticsMarkdown,
  type ReviewAnalytics,
  type RoundStat,
  shouldRevertScopeGrowthRound,
} from "./stark_review_doc_analytics_lib.ts";
import { assetConfigPath, assetPromptsDir } from "./asset_root_lib.ts";

// ─── Constants ─────────────────────────────────────────────────────────

const HOME = os.homedir();
const DEFAULT_PROMPTS_BASE = assetPromptsDir();
const DEFAULT_TIMEOUT_SEC = 600;
const WING_TIMEOUT_SEC = 900;
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";
// Default lead-review model when the lead agent is claude (e.g. --lead-agent
// claude). Fable 5 is Anthropic's most capable model; the lead reviewer only
// runs on it when the operator explicitly opts in via --lead-agent claude.
const CLAUDE_LEAD_DEFAULT_MODEL = "claude-fable-5";
const CODEX_REASONING_EFFORT_XHIGH = 'model_reasoning_effort="xhigh"';

const VALID_LEAD_AGENTS = ["codex", "claude"] as const;
type LeadAgent = (typeof VALID_LEAD_AGENTS)[number];

const VALID_WING_AGENTS = ["claude", "codex"] as const;
type WingAgent = (typeof VALID_WING_AGENTS)[number];
// Default fixer model when the wing agent is codex (e.g. --wing-agent codex).
const CODEX_WING_DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_OUTPUT_CAP = 32 * 1024 * 1024;

const VALID_PROMPTS_DIRS = ["spec-review", "plan-review"] as const;
type PromptsDir = (typeof VALID_PROMPTS_DIRS)[number];

// Domain ids whose findings mean "this document is over-engineered." A
// high/critical finding here while the doc has also breached the growth limit
// is the invent-then-condemn signal (the review manufactured scope it now
// condemns). spec-review ships an over-engineering domain (`scope`);
// plan-review has no direct analog, so the signal simply never fires there.
const SCOPE_DOMAIN_IDS = new Set<string>(["scope"]);

// Repo-override subdirectory under .code-review/. Mirrors dispatcher_base.py
// convention (spec-review → spec-prompts, plan-review → plan-prompts).
function repoSubdirFor(promptsDir: PromptsDir): string {
  return promptsDir === "spec-review" ? "spec-prompts" : "plan-prompts";
}

function configSectionFor(promptsDir: PromptsDir): string {
  return promptsDir === "spec-review" ? "spec_review" : "plan_review";
}

// ─── Subprocess runner (lean, signal-aware) ────────────────────────────

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutSec: number;
}

async function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;

  return await new Promise<RunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: [opts.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      resolve({
        code: null,
        signal: null,
        stdout: "",
        stderr: e.message ?? "",
        timedOut: false,
        notFound: e.code === "ENOENT",
      });
      return;
    }

    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let processClosed = false;
    let timedOutFlag = false;
    let closed: RunResult | null = null;
    const tryFinish = () => {
      if (settled) return;
      if (closed === null) return;
      if (!stdoutEnded || !stderrEnded || !processClosed) return;
      settled = true;
      resolve(closed);
    };

    const timer = setTimeout(() => {
      timedOutFlag = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5_000);
    }, opts.timeoutSec * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutLen >= DEFAULT_OUTPUT_CAP) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrLen >= DEFAULT_OUTPUT_CAP) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });
    if (child.stdout) child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    else stdoutEnded = true;
    if (child.stderr) child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    else stderrEnded = true;

    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      stdoutEnded = true;
      stderrEnded = true;
      processClosed = true;
      closed = {
        code: null,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut: false,
        notFound: e.code === "ENOENT",
      };
      tryFinish();
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      processClosed = true;
      closed = {
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut: timedOutFlag,
        notFound: false,
      };
      tryFinish();
    });

    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => { /* broken pipe -- swallow */ });
      child.stdin.end(opts.stdin);
    }
  });
}

async function runGit(args: string[], cwd: string, timeoutSec = 60): Promise<RunResult> {
  return run("git", args, { cwd, timeoutSec });
}

// ─── Codex JSONL parsing (last agent message only) ─────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract concatenated agent text from codex `--json` stdout (covers
 * `agent_message` and legacy `message`/`content[].output_text`). Returns the
 * raw input if no JSONL framing is detected.
 */
function extractCodexAgentText(raw: string): string {
  const parts: string[] = [];
  let sawFraming = false;
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!isPlainObject(ev)) continue;
    sawFraming = true;
    if (ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!isPlainObject(item)) continue;
    const itype = item.type;
    if (itype === "agent_message") {
      const text = item.text;
      if (typeof text === "string" && text) parts.push(text);
    } else if (itype === "message") {
      const content = item.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!isPlainObject(c)) continue;
          if (c.type === "output_text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    }
  }
  if (!sawFraming) return raw;
  return parts.length > 0 ? parts.join("\n") : raw;
}

/** Claude `--output-format json` wraps the assistant response in `{result, ...}`. */
function unwrapClaudeJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  try {
    const obj = JSON.parse(trimmed);
    if (isPlainObject(obj) && typeof obj.result === "string") return obj.result;
  } catch { /* fall through */ }
  return raw;
}

// ─── Env builders ──────────────────────────────────────────────────────

const SUBPROCESS_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR",
] as const;

function baseSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  return env;
}

function claudeSubprocessEnv(): NodeJS.ProcessEnv {
  const env = baseSubprocessEnv();
  const apiKey = process.env.ANTHROPIC_AGENTS ?? process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    env.ANTHROPIC_API_KEY = apiKey;
  }
  return env;
}

// ─── Lead reviewer (codex) ─────────────────────────────────────────────

interface LeadDispatchResult {
  agent: AgentName;
  domain: string;
  model: string;
  raw_output: string;
  duration_s: number;
  findings: DocFinding[];
  /** When the agent emitted an explicit `[]`. Distinguishes clean review
   * from prose-only stdout (which becomes parse_error). */
  empty_ack: boolean;
  error: string | null;
  parse_error: string | null;
}

async function runCodexReviewer(opts: {
  domain: string;
  prompt: string;
  timeoutSec: number;
  model: string;
  reasoningEffort: string;
  /** Spawn cwd. Codex needs a real directory; we use os.tmpdir() so it
   * doesn't refuse to start, and pair that with --skip-git-repo-check. */
  cwd: string;
}): Promise<LeadDispatchResult> {
  const t0 = process.hrtime.bigint();
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-c",
    opts.reasoningEffort,
    "-m",
    opts.model,
    "-",
  ];
  const res = await run("codex", args, {
    cwd: opts.cwd,
    env: baseSubprocessEnv(),
    stdin: opts.prompt,
    timeoutSec: opts.timeoutSec,
  });
  const duration = elapsedSec(t0);

  const base: Omit<LeadDispatchResult, "raw_output" | "findings" | "empty_ack" | "error" | "parse_error"> = {
    agent: "codex",
    domain: opts.domain,
    model: opts.model,
    duration_s: duration,
  };

  if (res.notFound) {
    return { ...base, raw_output: "", findings: [], empty_ack: false, error: "agent_unavailable", parse_error: null };
  }
  if (res.timedOut) {
    return { ...base, raw_output: "", findings: [], empty_ack: false, error: "timeout", parse_error: null };
  }
  if (res.signal !== null) {
    return { ...base, raw_output: res.stdout, findings: [], empty_ack: false, error: `signal_${res.signal}`, parse_error: null };
  }
  if (res.code !== 0) {
    return {
      ...base,
      raw_output: res.stdout,
      findings: [],
      empty_ack: false,
      error: `cli_error_exit_${res.code}`,
      parse_error: null,
    };
  }

  const text = extractCodexAgentText(res.stdout);
  const parsed = parseReviewerOutput(text);
  if (!parsed) {
    return {
      ...base,
      raw_output: text,
      findings: [],
      empty_ack: false,
      error: "parse_error",
      parse_error: snippet(text, 200),
    };
  }

  const findings: DocFinding[] = parsed.findings.map((f) => ({
    id: docFindingId({ domain: opts.domain, agent: "codex", section: f.section, title: f.title }),
    agent: "codex",
    domain: opts.domain,
    severity: f.severity,
    section: f.section,
    title: f.title,
    description: f.description,
    suggestion: f.suggestion,
  }));

  return {
    ...base,
    raw_output: text,
    findings,
    empty_ack: parsed.emptyAck,
    error: null,
    parse_error: null,
  };
}

/**
 * Claude lead reviewer. Same contract as runCodexReviewer (returns a
 * LeadDispatchResult), but dispatches the review through the claude CLI in
 * read-only mode. Used when --lead-agent claude is set (e.g. to run the lead
 * review on Fable 5). Reasoning effort / codex `-c` flags do not apply.
 */
async function runClaudeReviewer(opts: {
  domain: string;
  prompt: string;
  timeoutSec: number;
  model: string;
}): Promise<LeadDispatchResult> {
  const t0 = process.hrtime.bigint();
  const args = [
    "-p",
    "-",
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--no-session-persistence",
    // The reviewer must return findings JSON, not mutate files. Restrict to
    // read-only helpers so it can ground reasoning in the doc but not write.
    "--allowedTools",
    "Read,Glob,Grep",
  ];
  const res = await run("claude", args, {
    env: claudeSubprocessEnv(),
    stdin: opts.prompt,
    timeoutSec: opts.timeoutSec,
  });
  const duration = elapsedSec(t0);

  const base: Omit<LeadDispatchResult, "raw_output" | "findings" | "empty_ack" | "error" | "parse_error"> = {
    agent: "claude",
    domain: opts.domain,
    model: opts.model,
    duration_s: duration,
  };

  if (res.notFound) {
    return { ...base, raw_output: "", findings: [], empty_ack: false, error: "agent_unavailable", parse_error: null };
  }
  if (res.timedOut) {
    return { ...base, raw_output: "", findings: [], empty_ack: false, error: "timeout", parse_error: null };
  }
  if (res.signal !== null) {
    return { ...base, raw_output: res.stdout, findings: [], empty_ack: false, error: `signal_${res.signal}`, parse_error: null };
  }
  if (res.code !== 0) {
    return {
      ...base,
      raw_output: res.stdout,
      findings: [],
      empty_ack: false,
      error: `cli_error_exit_${res.code}`,
      parse_error: null,
    };
  }

  const text = unwrapClaudeJson(res.stdout);
  const parsed = parseReviewerOutput(text);
  if (!parsed) {
    return {
      ...base,
      raw_output: text,
      findings: [],
      empty_ack: false,
      error: "parse_error",
      parse_error: snippet(text, 200),
    };
  }

  const findings: DocFinding[] = parsed.findings.map((f) => ({
    id: docFindingId({ domain: opts.domain, agent: "claude", section: f.section, title: f.title }),
    agent: "claude",
    domain: opts.domain,
    severity: f.severity,
    section: f.section,
    title: f.title,
    description: f.description,
    suggestion: f.suggestion,
  }));

  return {
    ...base,
    raw_output: text,
    findings,
    empty_ack: parsed.emptyAck,
    error: null,
    parse_error: null,
  };
}

function snippet(s: string, n: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= n) return trimmed;
  return trimmed.slice(0, n) + "…";
}

// ─── Wing fixer (claude) ───────────────────────────────────────────────

interface WingDispatchResult {
  raw_output: string;
  duration_s: number;
  error: string | null;
  parsed: ReturnType<typeof parseFixerOutput>["parsed"];
  parse_error: string | null;
}

async function runClaudeWing(opts: {
  prompt: string;
  timeoutSec: number;
  model: string;
}): Promise<WingDispatchResult> {
  const t0 = process.hrtime.bigint();
  const args = [
    "-p",
    "-",
    "--output-format",
    "json",
    "--model",
    opts.model,
    "--no-session-persistence",
    // claude code uses Edit/Write only if explicitly allowed; we want the wing
    // to RETURN a patch, not mutate files itself. Restrict tools to read-only
    // helpers so the model can still ground reasoning in the doc but cannot
    // touch the filesystem.
    "--allowedTools",
    "Read,Glob,Grep",
  ];
  const res = await run("claude", args, {
    env: claudeSubprocessEnv(),
    stdin: opts.prompt,
    timeoutSec: opts.timeoutSec,
  });
  const duration = elapsedSec(t0);

  if (res.notFound) {
    return { raw_output: "", duration_s: duration, error: "agent_unavailable", parsed: null, parse_error: null };
  }
  if (res.timedOut) {
    return { raw_output: "", duration_s: duration, error: "timeout", parsed: null, parse_error: null };
  }
  if (res.signal !== null) {
    return { raw_output: res.stdout, duration_s: duration, error: `signal_${res.signal}`, parsed: null, parse_error: null };
  }
  if (res.code !== 0) {
    return {
      raw_output: res.stdout,
      duration_s: duration,
      error: `cli_error_exit_${res.code}`,
      parsed: null,
      parse_error: null,
    };
  }

  const unwrapped = unwrapClaudeJson(res.stdout);
  const parsed = parseFixerOutput(unwrapped);
  if (!parsed.parsed) {
    return {
      raw_output: unwrapped,
      duration_s: duration,
      error: null,
      parsed: null,
      parse_error: parsed.error ?? "unknown_parse_error",
    };
  }
  return { raw_output: unwrapped, duration_s: duration, error: null, parsed: parsed.parsed, parse_error: null };
}

/**
 * Codex wing fixer. Same WingDispatchResult contract as runClaudeWing, but
 * dispatches the fix pass through the codex CLI (read-only sandbox) and parses
 * its JSONL agent output. Used when --wing-agent codex is set (e.g. to run the
 * wing on gpt-5.6-sol at xhigh). The wing must RETURN a patch, never mutate files —
 * `-s read-only` enforces that.
 */
async function runCodexWing(opts: {
  prompt: string;
  timeoutSec: number;
  model: string;
  reasoningEffort: string;
  cwd: string;
}): Promise<WingDispatchResult> {
  const t0 = process.hrtime.bigint();
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "-c",
    opts.reasoningEffort,
    "-m",
    opts.model,
    "-",
  ];
  const res = await run("codex", args, {
    cwd: opts.cwd,
    env: baseSubprocessEnv(),
    stdin: opts.prompt,
    timeoutSec: opts.timeoutSec,
  });
  const duration = elapsedSec(t0);

  if (res.notFound) {
    return { raw_output: "", duration_s: duration, error: "agent_unavailable", parsed: null, parse_error: null };
  }
  if (res.timedOut) {
    return { raw_output: "", duration_s: duration, error: "timeout", parsed: null, parse_error: null };
  }
  if (res.signal !== null) {
    return { raw_output: res.stdout, duration_s: duration, error: `signal_${res.signal}`, parsed: null, parse_error: null };
  }
  if (res.code !== 0) {
    return {
      raw_output: res.stdout,
      duration_s: duration,
      error: `cli_error_exit_${res.code}`,
      parsed: null,
      parse_error: null,
    };
  }

  const text = extractCodexAgentText(res.stdout);
  const parsed = parseFixerOutput(text);
  if (!parsed.parsed) {
    return {
      raw_output: text,
      duration_s: duration,
      error: null,
      parsed: null,
      parse_error: parsed.error ?? "unknown_parse_error",
    };
  }
  return { raw_output: text, duration_s: duration, error: null, parsed: parsed.parsed, parse_error: null };
}

/** One-shot wing dispatch with the codex-cwd ceremony handled — shared by the
 * per-round compress pass and the end-of-run coherence pass. */
async function runWingOnce(opts: {
  prompt: string;
  wingAgent: WingAgent;
  wingModel: string;
  wingTimeoutSec: number;
}): Promise<WingDispatchResult> {
  const codexCwd = opts.wingAgent === "codex"
    ? fs.mkdtempSync(path.join(os.tmpdir(), "stark-doc-wing-once-"))
    : null;
  try {
    return opts.wingAgent === "codex"
      ? await runCodexWing({
        prompt: opts.prompt,
        timeoutSec: opts.wingTimeoutSec,
        model: opts.wingModel,
        reasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
        cwd: codexCwd!,
      })
      : await runClaudeWing({
        prompt: opts.prompt,
        timeoutSec: opts.wingTimeoutSec,
        model: opts.wingModel,
      });
  } finally {
    if (codexCwd) { try { fs.rmSync(codexCwd, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function elapsedSec(t0: bigint): number {
  const ns = process.hrtime.bigint() - t0;
  return Number(ns) / 1e9;
}

function log(msg: string): void {
  process.stderr.write(`stark_review_doc: ${msg}\n`);
}

function ts(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

// ─── Trusted config (lean) ─────────────────────────────────────────────

/**
 * Load doc-review config from global config.json. We intentionally do NOT
 * read the repo-controlled `.code-review/config.json` from the worktree —
 * doc review operates on a checked-in markdown file in the operator's repo
 * (not a fork), and the playground-mode value is in keeping it simple.
 *
 * Repo override for prompts is still honored via resolveDocPromptSources;
 * that path uses filesystem reads since the doc lives in the operator's
 * trusted local checkout. (Unlike PR review, where the PR head is the
 * untrusted artifact.)
 */
function loadDocReviewConfig(promptsDir: PromptsDir): DocReviewConfig {
  const cfg: DocReviewConfig = { ...DEFAULT_DOC_REVIEW_CONFIG };
  const globalCfgPath = assetConfigPath();
  if (!fs.existsSync(globalCfgPath)) return cfg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(globalCfgPath, "utf-8"));
  } catch {
    return cfg;
  }
  if (!isPlainObject(parsed)) return cfg;
  const section = parsed[configSectionFor(promptsDir)];
  if (!isPlainObject(section)) return cfg;
  if (Array.isArray(section.agents)) {
    const allowed: AgentName[] = ["claude", "codex", "gemini"];
    cfg.agents = section.agents
      .filter((a): a is AgentName => typeof a === "string" && allowed.includes(a as AgentName));
  }
  if (typeof section.fix_threshold === "string") {
    const t = section.fix_threshold.toLowerCase();
    if (t === "critical" || t === "high" || t === "medium" || t === "low") {
      cfg.fix_threshold = t;
    }
  }
  if (Array.isArray(section.disabled_domains)) {
    cfg.disabled_domains = section.disabled_domains.filter((d): d is string => typeof d === "string");
  }
  if (typeof section.max_rounds === "number" && Number.isFinite(section.max_rounds)) {
    cfg.max_rounds = Math.min(MAX_ROUNDS_CEILING, Math.max(1, Math.floor(section.max_rounds)));
  }
  if (typeof section.max_fixes_per_round === "number" && Number.isFinite(section.max_fixes_per_round) && section.max_fixes_per_round >= 0) {
    cfg.max_fixes_per_round = Math.floor(section.max_fixes_per_round);
  }
  if (typeof section.compress_retry_growth_ratio === "number" && Number.isFinite(section.compress_retry_growth_ratio)) {
    // 0 disables; otherwise a GROWTH ratio must be >= 1 — a value in (0,1)
    // (the "+0.15 means +15%" misread) would trigger compress on every round
    // including shrinking ones. Reject nonsense, keep the default.
    const v = section.compress_retry_growth_ratio;
    if (v === 0 || v >= 1) cfg.compress_retry_growth_ratio = v;
    else log(`config: ignoring compress_retry_growth_ratio=${v} — must be 0 (disable) or >= 1 (a growth ratio)`);
  }
  if (typeof section.max_codex_concurrent === "number" && section.max_codex_concurrent > 0) {
    cfg.max_codex_concurrent = Math.floor(section.max_codex_concurrent);
  }
  if (typeof section.coherence_pass === "boolean") {
    cfg.coherence_pass = section.coherence_pass;
  }
  if (typeof section.history_keep_runs === "number" && Number.isFinite(section.history_keep_runs) && section.history_keep_runs >= 1) {
    cfg.history_keep_runs = Math.floor(section.history_keep_runs);
  }
  if (isPlainObject(section.analytics)) {
    const a = section.analytics;
    const num = (v: unknown, min: number): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= min ? v : null;
    cfg.analytics = {
      max_doc_growth_ratio: num(a.max_doc_growth_ratio, 1) ?? cfg.analytics.max_doc_growth_ratio,
      hard_doc_growth_ratio: num(a.hard_doc_growth_ratio, 1) ?? cfg.analytics.hard_doc_growth_ratio,
      max_round_growth_ratio: num(a.max_round_growth_ratio, 1) ?? cfg.analytics.max_round_growth_ratio,
      non_convergent_rounds: num(a.non_convergent_rounds, 1) ?? cfg.analytics.non_convergent_rounds,
      churn_recurring_share: num(a.churn_recurring_share, 0) ?? cfg.analytics.churn_recurring_share,
      rollback_on_hard_growth:
        typeof a.rollback_on_hard_growth === "boolean"
          ? a.rollback_on_hard_growth
          : cfg.analytics.rollback_on_hard_growth,
    };
  }
  return cfg;
}

// ─── Round drivers ─────────────────────────────────────────────────────

async function runLeadReview(opts: {
  doc: string;
  domains: string[];
  promptsDir: PromptsDir;
  promptsBase: string;
  repoDir: string;
  maxConcurrent: number;
  /** Per-domain timeout — escalated across rounds for domains that timed out. */
  timeoutSecFor: (domain: string) => number;
  leadAgent: LeadAgent;
  model: string;
  reasoningEffort: string;
  /** Anti-churn feedback: rendered summary of the previous round's applied
   * wing patches (renderPriorRoundChanges). */
  priorRoundNote?: string;
  /** Convergence mode: bypass per-domain prompt resolution (there is no
   * NN-<domain>.md for "convergence") and use these sources for every domain. */
  promptSourcesOverride?: PromptSources;
}): Promise<LeadDispatchResult[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stark-doc-review-"));
  try {
    return await pmap(opts.domains, opts.maxConcurrent, async (domain) => {
      const sources = opts.promptSourcesOverride ?? resolveDocPromptSources({
        agent: opts.leadAgent,
        domain,
        promptsDir: path.join(opts.promptsBase, opts.promptsDir),
        repoDir: opts.repoDir,
        repoSubdir: repoSubdirFor(opts.promptsDir),
      });
      const prompt = buildReviewerPrompt({
        agentMd: sources.agentMd,
        domainPrompt: sources.domainPrompt,
        doc: opts.doc,
        ...(opts.priorRoundNote ? { priorRoundNote: opts.priorRoundNote } : {}),
      });
      log(`${ts()} → ${opts.leadAgent}:${domain} dispatch (model=${opts.model})`);
      const r = opts.leadAgent === "claude"
        ? await runClaudeReviewer({
          domain,
          prompt,
          timeoutSec: opts.timeoutSecFor(domain),
          model: opts.model,
        })
        : await runCodexReviewer({
          domain,
          prompt,
          timeoutSec: opts.timeoutSecFor(domain),
          model: opts.model,
          reasoningEffort: opts.reasoningEffort,
          cwd,
        });
      log(
        `${ts()} ← ${opts.leadAgent}:${domain} ${r.error ? "error=" + r.error : "ok"} findings=${r.findings.length} ${r.duration_s.toFixed(1)}s`,
      );
      return r;
    });
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runWingFixRound(opts: {
  doc: string;
  findings: DocFinding[];
  roundNum: number;
  wingTimeoutSec: number;
  wingAgent: WingAgent;
  wingModel: string;
  wingReasoningEffort: string;
  maxWingAttempts: number;
}): Promise<{
  finalDoc: string;
  attempted: FixerPatch[];
  applied: FixerPatch[];
  skipped: Array<{ finding_id: string; reason: string }>;
  patch_failures: Array<{ patch: FixerPatch; reason: string }>;
  wing_error: string | null;
}> {
  let currentDoc = opts.doc;
  let priorFailures: Array<{ patch: FixerPatch; reason: string }> | undefined;
  const allAttempted: FixerPatch[] = [];
  const allApplied: FixerPatch[] = [];
  let lastSkipped: Array<{ finding_id: string; reason: string }> = [];
  let lastFailures: Array<{ patch: FixerPatch; reason: string }> = [];
  // Codex needs a real cwd; use a throwaway dir + --skip-git-repo-check.
  const codexCwd = opts.wingAgent === "codex"
    ? fs.mkdtempSync(path.join(os.tmpdir(), "stark-doc-wing-"))
    : null;

  try {
  for (let attempt = 1; attempt <= opts.maxWingAttempts; attempt++) {
    const prompt = buildFixerPrompt({
      doc: currentDoc,
      findings: opts.findings,
      retryFailures: priorFailures,
      roundNum: opts.roundNum,
    });
    log(
      `${ts()} → ${opts.wingAgent} wing dispatch (round ${opts.roundNum}, attempt ${attempt}/${opts.maxWingAttempts}, ${opts.findings.length} findings)`,
    );
    const wing = opts.wingAgent === "codex"
      ? await runCodexWing({
        prompt,
        timeoutSec: opts.wingTimeoutSec,
        model: opts.wingModel,
        reasoningEffort: opts.wingReasoningEffort,
        cwd: codexCwd!,
      })
      : await runClaudeWing({
        prompt,
        timeoutSec: opts.wingTimeoutSec,
        model: opts.wingModel,
      });
    if (wing.error) {
      log(`${ts()} ← ${opts.wingAgent} wing error=${wing.error}`);
      return {
        finalDoc: currentDoc,
        attempted: allAttempted,
        applied: allApplied,
        skipped: lastSkipped,
        patch_failures: lastFailures,
        wing_error: wing.error,
      };
    }
    if (!wing.parsed) {
      log(`${ts()} ← ${opts.wingAgent} wing parse_error=${wing.parse_error}`);
      if (attempt < opts.maxWingAttempts) {
        priorFailures = [
          { patch: { finding_id: "", old: "", new: "" }, reason: `wing output unparseable: ${wing.parse_error}` },
        ];
        continue;
      }
      return {
        finalDoc: currentDoc,
        attempted: allAttempted,
        applied: allApplied,
        skipped: lastSkipped,
        patch_failures: lastFailures,
        wing_error: `parse_error:${wing.parse_error}`,
      };
    }

    const { patches, skipped } = wing.parsed;
    lastSkipped = skipped;
    allAttempted.push(...patches);
    const applyResult = applyPatches(currentDoc, patches);
    allApplied.push(...applyResult.applied);
    currentDoc = applyResult.newDoc;
    lastFailures = applyResult.failures;

    log(
      `${ts()} ← ${opts.wingAgent} wing applied=${applyResult.applied.length}/${patches.length} skipped=${skipped.length} failures=${applyResult.failures.length}`,
    );

    if (applyResult.failures.length === 0) break;
    if (attempt >= opts.maxWingAttempts) break;
    priorFailures = applyResult.failures;
  }

  return {
    finalDoc: currentDoc,
    attempted: allAttempted,
    applied: allApplied,
    skipped: lastSkipped,
    patch_failures: lastFailures,
    wing_error: null,
  };
  } finally {
    if (codexCwd) { try { fs.rmSync(codexCwd, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

// ─── Main loop ────────────────────────────────────────────────────────

export interface DispatchOptions {
  docPath: string;
  promptsDir: PromptsDir;
  promptsBase: string;
  repoDir: string;
  config: DocReviewConfig;
  maxRoundsOverride: number | null;
  codexConcurrentOverride: number | null;
  dryRun: boolean;
  force: boolean;
  leadAgent: LeadAgent;
  leadModel: string;
  wingAgent: WingAgent;
  wingModel: string;
  leadTimeoutSec: number;
  wingTimeoutSec: number;
  maxWingAttempts: number;
  commitFixes: boolean;
  coherencePass: boolean;
  /** Convergence mode (ADR 0022): review only the git delta base..HEAD of the
   * doc instead of running the fix loop. Null = normal review. */
  convergeBase: string | null;
}

interface Receipt {
  ok: boolean;
  doc: string;
  prompts_dir: string;
  models: Record<string, string>;
  config: {
    fix_threshold: string;
    max_rounds: number;
    max_fixes_per_round: number;
    max_codex_concurrent: number;
    disabled_domains: string[];
  };
  domains: string[];
  /** Per-domain completion across the whole run. Zero findings from a domain
   * that never completed means "never ran", not "clean". */
  coverage: Record<string, DomainCoverage>;
  /** Domains that never completed a review in ANY round — a coverage gap.
   * Nonempty gaps make the run not-ok (exit 1). */
  coverage_gaps: string[];
  rounds: Array<{
    round: number;
    kind: "review-fix" | "final-review";
    results: Array<{
      agent: AgentName;
      domain: string;
      model: string;
      duration_s: number;
      findings_count: number;
      empty_ack: boolean;
      error: string | null;
      parse_error: string | null;
    }>;
    failed_results: Array<{ agent: AgentName; domain: string; error: string }>;
    findings: DocFinding[];
    summary: {
      total: number;
      succeeded: number;
      failed: number;
      total_findings: number;
      by_severity: Record<string, number>;
      by_classification: Record<string, number>;
    };
    fix?: {
      attempted: number;
      applied: number;
      skipped_by_wing: number;
      /** finding ids the wing applied a patch for this round. */
      applied_finding_ids: string[];
      /** finding ids the wing explicitly declined to patch this round. */
      skipped_finding_ids: string[];
      /** eligible findings deferred by max_fixes_per_round (recorded, not
       * patched this round). */
      deferred_by_cap: number;
      /** the round's net result grew the doc under an open scope-domain
       * condemnation — the result was discarded, nothing written/committed. */
      round_reverted: boolean;
      /** finding ids whose patches were applied by the wing but then
       * DISCARDED by a round revert — these fixes do NOT exist in the doc
       * and must not be treated as autofixed. */
      discarded_finding_ids: string[];
      /** the in-round compress pass, when it ran: how many patches landed and
       * the char delta it produced — so the round's commit diff reconciles
       * with the receipt. Null when compress didn't run. */
      compress: { patches_applied: number; chars_delta: number } | null;
      patch_failures: Array<{ finding_id: string; old: string; reason: string }>;
      wing_error: string | null;
      commit_sha: string | null;
    };
    duration_s: number;
  }>;
  unresolved: DocFinding[];
  fixes_committed: number;
  /** Unique id of this run; the history dir is `<slug>/<run_id>` so re-runs
   * never clobber earlier records. */
  run_id: string;
  history_dir: string;
  /** History/analytics writes that failed ("phase: message") — surfaced, never
   * swallowed. Persistence failures warn; they do not fail the run. */
  persistence_errors: string[];
  /** HEAD after the final review round — the convergence pass diffs from
   * here (`--converge --base <sha>`). Null on dry runs / git failure. */
  last_reviewed_sha: string | null;
  /** Set when this run WAS a convergence pass: the diff base and delta size
   * (delta_chars 0 = trivially converged, nothing was dispatched). */
  converge: { base: string; delta_chars: number } | null;
  /** Process-health analytics — monitors and judges the review run itself. */
  analytics: ReviewAnalytics | null;
  coherence: {
    ran: boolean;
    patches_applied: number;
    patches_attempted: number;
    chars_delta: number;
    commit_sha: string | null;
    error: string | null;
  } | null;
  error: { code: string; message: string } | null;
}

async function gitCommitDoc(opts: {
  repoDir: string;
  docPath: string;
  message: string;
}): Promise<string | null> {
  const addRes = await runGit(["add", "--", opts.docPath], opts.repoDir, 30);
  if (addRes.code !== 0) {
    log(`git add failed: ${addRes.stderr.trim()}`);
    return null;
  }
  const statusRes = await runGit(
    ["status", "--porcelain", "--", opts.docPath],
    opts.repoDir,
    30,
  );
  if (statusRes.code !== 0) {
    log(`git status failed: ${statusRes.stderr.trim()}`);
    return null;
  }
  if (statusRes.stdout.trim().length === 0) {
    log("git status: no changes to commit (skipped)");
    return null;
  }
  const commitRes = await runGit(
    ["commit", "-m", opts.message, "--", opts.docPath],
    opts.repoDir,
    60,
  );
  if (commitRes.code !== 0) {
    log(`git commit failed: ${commitRes.stderr.trim()}`);
    return null;
  }
  const sha = await runGit(["rev-parse", "HEAD"], opts.repoDir, 15);
  return sha.code === 0 ? sha.stdout.trim() : null;
}

/**
 * Pin the growth baseline to the first-staged doc version. A re-run or
 * resumed review otherwise measures growth against run-start HEAD — which
 * already contains previous rounds' committed growth, so the ratio guards
 * silently reset every re-run. Walk the doc's history past this pipeline's
 * own commits (round fixes, coherence, reverts, Phase-5b fixes) to the last
 * authored version and use its content. Falls back to `runStartDoc` when git
 * is unavailable or every reachable commit is a pipeline mutation.
 */
async function resolveGrowthBaseline(opts: {
  repoDir: string;
  docPath: string;
  docAbs: string;
  runStartDoc: string;
}): Promise<string> {
  const logRes = await runGit(
    ["log", "--format=%H%x09%s", "-n", "100", "--", opts.docPath],
    opts.repoDir,
    30,
  );
  if (logRes.code !== 0) return opts.runStartDoc;
  for (const line of logRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    if (isReviewMutationCommitSubject(subject)) continue;
    // `:./path` resolves relative to the git cwd (repoDir), matching how the
    // doc path is used everywhere else in this dispatcher.
    const rel = path.isAbsolute(opts.docPath)
      ? path.relative(opts.repoDir, opts.docAbs)
      : opts.docPath;
    const show = await runGit(["show", `${sha}:./${rel}`], opts.repoDir, 30);
    return show.code === 0 ? show.stdout : opts.runStartDoc;
  }
  return opts.runStartDoc;
}

export async function dispatchDocReview(opts: DispatchOptions): Promise<{
  receipt: Receipt;
  exitCode: number;
}> {
  const promptsRoot = path.join(opts.promptsBase, opts.promptsDir);
  if (!fs.existsSync(promptsRoot)) {
    return {
      receipt: errorReceipt(opts, "prompts_dir_missing", `${promptsRoot} does not exist`),
      exitCode: 1,
    };
  }

  // Convergence mode (ADR 0022): single "convergence" pseudo-domain with a
  // root-level prompt; skips domain discovery, the fix loop, and coherence.
  const convergeMode = opts.convergeBase !== null;
  let convergeSources: PromptSources | null = null;
  if (convergeMode) {
    convergeSources = resolveConvergencePromptSources({
      agent: opts.leadAgent,
      promptsDir: promptsRoot,
      repoDir: opts.repoDir,
      repoSubdir: repoSubdirFor(opts.promptsDir),
    });
    if (!convergeSources) {
      return {
        receipt: errorReceipt(opts, "convergence_prompt_missing", `${path.join(promptsRoot, "convergence.md")} not found`),
        exitCode: 1,
      };
    }
  }

  // Domain discovery + disabled filter
  let domainKeys: string[];
  if (convergeMode) {
    domainKeys = ["convergence"];
  } else {
    const allDomains = discoverDomains(promptsRoot, ["codex", "claude", "gemini"]);
    const enabledDomains = allDomains.filter((d) => !opts.config.disabled_domains.includes(d.key));
    if (enabledDomains.length === 0) {
      return {
        receipt: errorReceipt(opts, "no_domains", `No domains discovered under ${promptsRoot}`),
        exitCode: 1,
      };
    }
    domainKeys = enabledDomains.map((d) => d.key);
  }

  // Pre-flight: dirty-doc check
  const docAbs = path.resolve(opts.repoDir, opts.docPath);
  if (!fs.existsSync(docAbs)) {
    return {
      receipt: errorReceipt(opts, "doc_not_found", docAbs),
      exitCode: 1,
    };
  }
  if (!opts.force && !opts.dryRun) {
    const dirty = await runGit(
      ["status", "--porcelain", "--", opts.docPath],
      opts.repoDir,
      30,
    );
    if (dirty.code === 0 && dirty.stdout.trim().length > 0) {
      return {
        receipt: errorReceipt(
          opts,
          "doc_dirty",
          `Design file has uncommitted changes. Commit or stash first, or use --force. Changes: ${dirty.stdout.trim()}`,
        ),
        exitCode: 1,
      };
    }
  }

  let currentDoc = fs.readFileSync(docAbs, "utf-8");
  const originalDoc = currentDoc;

  // Convergence delta — everything that changed since the last-reviewed state.
  let convergeDelta = "";
  if (convergeMode) {
    const diff = await runGit(["diff", `${opts.convergeBase}..HEAD`, "--", opts.docPath], opts.repoDir, 30);
    if (diff.code !== 0) {
      return {
        receipt: errorReceipt(opts, "converge_diff_failed", diff.stderr.trim() || `git diff ${opts.convergeBase}..HEAD failed`),
        exitCode: 1,
      };
    }
    convergeDelta = diff.stdout;
    log(`converge: base=${opts.convergeBase} delta=${convergeDelta.length} chars`);
    if (convergeDelta.trim().length === 0) {
      log("converge: empty delta — nothing changed since the last review (trivially converged)");
    }
  }
  const roundStats: RoundStat[] = [];
  let abortedEarly = false;
  let abortReason: string | null = null;
  let rolledBackToOriginal = false;
  // Dispatcher-driven analytics flags (e.g. a scope-growth round revert) that
  // evaluateGuards cannot derive from round stats alone.
  const extraAnalyticsFlags: HealthFlag[] = [];
  // Growth baseline: pinned to the first-staged (last authored) doc version,
  // not run-start HEAD — a re-run otherwise measures growth against content
  // that already contains previous rounds' committed growth. Rollback still
  // restores run-start content (originalDoc); only the ratio guards and
  // analytics use the baseline.
  let baselineDoc = convergeMode
    ? originalDoc
    : await resolveGrowthBaseline({
      repoDir: opts.repoDir,
      docPath: opts.docPath,
      docAbs,
      runStartDoc: originalDoc,
    });
  if (baselineDoc !== originalDoc) {
    // Pre-existing breach: the doc ALREADY exceeds the soft cap vs the pinned
    // baseline before this run touched anything. That growth predates the run
    // (e.g. a completed earlier run whose growth the operator implicitly
    // accepted); aborting round 1 over it would make the doc permanently
    // un-reviewable. Fall back to run-start so the guards measure what THIS
    // run adds — the pinned ratio is still logged for the operator.
    const pinnedRatio = originalDoc.length / Math.max(1, baselineDoc.length);
    if (pinnedRatio > opts.config.analytics.max_doc_growth_ratio) {
      log(`growth baseline: run-start is already ${pinnedRatio.toFixed(2)}x the pinned first-staged version (${baselineDoc.length} chars) — pre-existing growth predates this run; guards measure this run only (baseline = run-start)`);
      baselineDoc = originalDoc;
    } else {
      log(`growth baseline pinned to first-staged doc version (${baselineDoc.length} chars; run-start is ${originalDoc.length})`);
    }
  }
  const maxRounds = opts.maxRoundsOverride !== null
    ? Math.min(MAX_ROUNDS_CEILING, Math.max(1, opts.maxRoundsOverride))
    : opts.config.max_rounds;
  const codexConcurrent = opts.codexConcurrentOverride ?? opts.config.max_codex_concurrent;

  // Adaptive lead timeouts: base scales with document size, and a domain that
  // timed out gets an escalated ceiling on its next attempt (600 → 1200 →
  // 1800) instead of re-failing at the same one every round.
  const effectiveBase = scaleTimeoutForDocSize(opts.leadTimeoutSec, originalDoc.length);
  if (effectiveBase !== opts.leadTimeoutSec) {
    log(`lead timeout scaled for doc size: ${opts.leadTimeoutSec}s → ${effectiveBase}s (${originalDoc.length} chars)`);
  }
  const domainTimeouts = new Map<string, number>(domainKeys.map((d) => [d, effectiveBase]));
  const timeoutSecFor = (domain: string): number => domainTimeouts.get(domain) ?? effectiveBase;
  const escalateTimeouts = (results: LeadDispatchResult[]): void => {
    for (const r of results) {
      if (r.error !== "timeout") continue;
      const cur = domainTimeouts.get(r.domain) ?? effectiveBase;
      const next = nextDomainTimeout(cur, effectiveBase);
      if (next > cur) {
        log(`timeout escalation: ${r.domain} ${cur}s → ${next}s on next attempt`);
        domainTimeouts.set(r.domain, next);
      }
    }
  };

  log(`config: prompts=${opts.promptsDir} max_rounds=${maxRounds} fix_threshold=${opts.config.fix_threshold} max_fixes_per_round=${opts.config.max_fixes_per_round} codex_concurrent=${codexConcurrent} dry_run=${opts.dryRun}`);
  log(`domains: ${domainKeys.join(", ")}`);
  log(`lead: ${opts.leadAgent}=${opts.leadModel} | wing: ${opts.wingAgent}=${opts.wingModel}`);

  const persistedRounds: PersistedRound[] = [];
  const receiptRounds: Receipt["rounds"] = [];
  const priorFixed: DocFinding[] = [];
  // Anti-churn feedback: the previous round's applied wing patches, rendered
  // into the next review prompt so reviewers stop re-reviewing fix text.
  let lastAppliedPatches: FixerPatch[] = [];
  // Disposition memory (the red-team spec_dispositions pattern): every finding
  // raised so far + how it was resolved, threaded into later lead prompts so
  // resolved/accepted concerns are not re-derived round after round.
  const priorDispositions: PriorDisposition[] = [];
  // Findings pushed out by max_fixes_per_round, re-queued host-side into the
  // next round's fix batch — the disposition block tells the lead not to
  // re-derive them, so nothing else would ever fix them.
  let deferredBacklog: DocFinding[] = [];
  let fixesCommitted = 0;
  let dispatchFailureEarlyExit = false;

  // Run-record durability: per-run history dir + incremental persistence so a
  // dead process leaves partials on disk, not nothing. Write failures are
  // surfaced in the receipt (persistence_errors), never swallowed — but they
  // warn rather than fail the run.
  const runId = newRunId();
  const historyDir = buildHistoryDir({ home: HOME, promptsDir: opts.promptsDir, docPath: opts.docPath, runId });
  const persistenceErrors: string[] = [];
  const persistFailed = (phase: string, err: unknown): void => {
    const msg = `${phase}: ${(err as Error).message}`;
    persistenceErrors.push(msg);
    log(`WARN history persistence failed — ${msg}`);
  };
  const runModels = { lead: opts.leadModel, wing: opts.wingModel, lead_agent: opts.leadAgent, wing_agent: opts.wingAgent };
  const persistRunSnapshot = (phase: string, final = false): void => {
    if (opts.dryRun) return;
    try {
      persistRoundsHistory({
        historyDir,
        docPath: opts.docPath,
        promptsDir: opts.promptsDir,
        runId,
        rounds: persistedRounds,
        models: runModels,
      });
    } catch (err) { persistFailed(`${phase}/rounds`, err); }
    try {
      const cov = computeCoverage(receiptRounds, domainKeys);
      const snap = buildAnalytics({
        doc: opts.docPath,
        promptsDir: opts.promptsDir,
        originalDoc: baselineDoc,
        finalDoc: currentDoc,
        roundStats,
        thresholds: opts.config.analytics,
        abortedEarly,
        abortReason,
        extraFlags: extraAnalyticsFlags,
        coverage: cov.domains,
        coverageGaps: cov.gaps,
      });
      writeJsonAtomic(path.join(historyDir, "analytics.json"), final ? snap : { ...snap, partial: true });
    } catch (err) { persistFailed(`${phase}/analytics`, err); }
  };
  if (!opts.dryRun) {
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      updateLatestPointer(path.dirname(historyDir), runId);
      const pruned = pruneRunDirs(path.dirname(historyDir), opts.config.history_keep_runs);
      if (pruned.length > 0) log(`history retention: pruned ${pruned.length} old run(s) (keep ${opts.config.history_keep_runs})`);
    } catch (err) {
      persistFailed("init", err);
    }
  }

  for (let roundNum = 1; !convergeMode && roundNum <= maxRounds; roundNum++) {
    const roundT0 = process.hrtime.bigint();
    log(`── Round ${roundNum} (review-fix) ──`);

    const priorRoundNote = [
      renderPriorDispositions(priorDispositions),
      renderPriorRoundChanges(lastAppliedPatches),
    ].filter((s) => s.length > 0).join("\n\n");
    const leadResults = await runLeadReview({
      doc: currentDoc,
      domains: domainKeys,
      promptsDir: opts.promptsDir,
      promptsBase: opts.promptsBase,
      repoDir: opts.repoDir,
      maxConcurrent: codexConcurrent,
      timeoutSecFor,
      leadAgent: opts.leadAgent,
      model: opts.leadModel,
      reasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
      ...(priorRoundNote ? { priorRoundNote } : {}),
    });
    escalateTimeouts(leadResults);
    const succeeded = leadResults.filter((r) => r.error === null).length;
    if (succeeded === 0) {
      log(`round ${roundNum}: dispatch failure (0/${leadResults.length} succeeded). Aborting fix loop.`);
      const failedRound = buildRoundReceipt({
        roundNum,
        kind: "review-fix",
        leadResults,
        classified: [],
        fix: null,
        durationS: elapsedSec(roundT0),
      });
      receiptRounds.push(failedRound);
      persistedRounds.push(toPersisted(failedRound, "review-fix"));
      persistRunSnapshot(`round-${roundNum}`);
      dispatchFailureEarlyExit = true;
      break;
    }

    const allRaw: DocFinding[] = leadResults.flatMap((r) => r.findings);
    // Cross-domain dedup BEFORE counting and BEFORE the wing: one root cause
    // routinely refracts into 4-5 domain findings; uncollapsed, the
    // convergence math counts the refractions and the wing patches each one
    // separately. The canonical survivor carries cross_validated_by.
    const dedupedRaw = dedupeDocFindings(allRaw);
    if (dedupedRaw.length < allRaw.length) {
      log(`round ${roundNum}: cross-domain dedup merged ${allRaw.length} → ${dedupedRaw.length} findings`);
    }
    const classified = classifyFindings(dedupedRaw, {
      priorFixed,
      fixThreshold: opts.config.fix_threshold,
    });
    // Per-round fix cap: the wing gets only the top-N by severity; the
    // overflow re-queues into the NEXT round's batch host-side (the
    // disposition block suppresses lead re-derivation, so the host must own
    // the backlog). Bulk medium "add detail" batches are what compound growth.
    const eligibleNew = selectFindingsToFix(classified);
    const backlogCarry = deferredBacklog.filter((b) => !eligibleNew.some((e) => e.id === b.id));
    if (backlogCarry.length > 0) {
      log(`round ${roundNum}: re-queued ${backlogCarry.length} deferred finding(s) from the previous round's fix-cap overflow`);
    }
    const eligible = selectFindingsToFix([...eligibleNew, ...backlogCarry]);
    const { selected: toFix, deferred } = capFindingsToFix(eligible, opts.config.max_fixes_per_round);
    deferredBacklog = deferred;
    log(`round ${roundNum}: ${allRaw.length} raw findings → ${eligible.length} to fix (threshold=${opts.config.fix_threshold})${deferred.length > 0 ? `, ${deferred.length} deferred by max_fixes_per_round=${opts.config.max_fixes_per_round}` : ""}`);
    const docBeforeRound = currentDoc;
    // Convergence is measured on the UNCAPPED eligible count — a capped
    // to_fix would sit flat at the cap and fake non-convergence.
    const recurringCount = eligible.filter((f) => f.classification === "recurring").length;
    // High/critical over-engineering findings from the scope domain — the
    // invent-then-condemn signal. Counted from all raw findings (not just
    // above-threshold) since even a demoted scope critique proves the
    // committee is condemning the doc's own scope.
    const scopeFindings = allRaw.filter(
      (f) => SCOPE_DOMAIN_IDS.has(f.domain) && (f.severity === "high" || f.severity === "critical"),
    ).length;
    const pushRoundStat = (fix: { attempted: number; applied: number; failures: number } | null, durationS: number): void => {
      roundStats.push({
        round: roundNum,
        kind: "review-fix",
        doc_chars_before: docBeforeRound.length,
        doc_chars_after: currentDoc.length,
        doc_lines_before: countLines(docBeforeRound),
        doc_lines_after: countLines(currentDoc),
        raw_findings: allRaw.length,
        to_fix: eligible.length,
        recurring: recurringCount,
        scope_findings: scopeFindings,
        fix_cap: opts.config.max_fixes_per_round,
        patches_attempted: fix?.attempted ?? 0,
        patches_applied: fix?.applied ?? 0,
        patch_failures: fix?.failures ?? 0,
        duration_s: durationS,
      });
    };

    let fixSummary: Receipt["rounds"][number]["fix"] | undefined;

    if (eligible.length === 0) {
      log(`round ${roundNum}: zero findings at/above threshold — terminating early`);
      receiptRounds.push(
        buildRoundReceipt({
          roundNum,
          kind: "review-fix",
          leadResults,
          classified,
          fix: null,
          durationS: elapsedSec(roundT0),
        }),
      );
      persistedRounds.push(
        toPersisted(receiptRounds[receiptRounds.length - 1]!, "review-fix"),
      );
      pushRoundStat(null, elapsedSec(roundT0));
      persistRunSnapshot(`round-${roundNum}`);
      break;
    }

    if (opts.dryRun) {
      log(`round ${roundNum}: --dry-run, skipping wing fix pass`);
      receiptRounds.push(
        buildRoundReceipt({
          roundNum,
          kind: "review-fix",
          leadResults,
          classified,
          fix: null,
          durationS: elapsedSec(roundT0),
        }),
      );
      persistedRounds.push(
        toPersisted(receiptRounds[receiptRounds.length - 1]!, "review-fix"),
      );
      pushRoundStat(null, elapsedSec(roundT0));
      persistRunSnapshot(`round-${roundNum}`);
      break;
    }

    // Wing fix pass
    const wingOutcome = await runWingFixRound({
      doc: currentDoc,
      findings: toFix,
      roundNum,
      wingTimeoutSec: opts.wingTimeoutSec,
      wingAgent: opts.wingAgent,
      wingModel: opts.wingModel,
      wingReasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
      maxWingAttempts: opts.maxWingAttempts,
    });

    // Per-round invent-then-condemn (#3): a fix result that GROWS the doc
    // while the scope domain condemned it this round is manufactured bloat —
    // discard the round instead of committing it and carrying the growth into
    // the cumulative breakers.
    const roundReverted =
      wingOutcome.applied.length > 0 &&
      shouldRevertScopeGrowthRound({
        docCharsBefore: docBeforeRound.length,
        docCharsAfter: wingOutcome.finalDoc.length,
        scopeFindings,
        maxRoundGrowthRatio: opts.config.analytics.max_round_growth_ratio,
      });
    let commitSha: string | null = null;
    // Compress bookkeeping: what the in-round shrink pass did, and which wing
    // patches it removed — those findings are NOT fixed and must not be
    // reported (or disposition-recorded) as such.
    let compressInfo: { patches_applied: number; chars_delta: number } | null = null;
    let compressedAway: FixerPatch[] = [];
    if (roundReverted) {
      extraAnalyticsFlags.push("scope_growth_round_reverted");
      abortedEarly = true;
      abortReason = `round ${roundNum} fixes grew the doc (${docBeforeRound.length} → ${wingOutcome.finalDoc.length} chars) while the scope domain raised ${scopeFindings} high/critical over-engineering finding(s) — the round's result was discarded (scope findings are fixed by cutting, not adding).`;
      log(`round ${roundNum}: SCOPE-GROWTH REVERT — ${abortReason}`);
    } else if (wingOutcome.applied.length > 0) {
      // Per-round growth discipline (3b): a fix round that grows the doc past
      // compress_retry_growth_ratio gets ONE in-round shrink pass under the
      // coherence net-reducing contract — the anti-growth force runs before
      // the growth is committed, not once at the end after it compounds.
      let roundDoc = wingOutcome.finalDoc;
      const compressRatio = opts.config.compress_retry_growth_ratio;
      if (compressRatio > 0 && roundDoc.length > docBeforeRound.length * compressRatio) {
        log(`round ${roundNum}: fixes grew doc ${(roundDoc.length / docBeforeRound.length).toFixed(2)}x (> ${compressRatio}x) — running in-round compress pass`);
        const compress = await runWingOnce({
          prompt: buildCoherencePrompt({ doc: roundDoc }),
          wingAgent: opts.wingAgent,
          wingModel: opts.wingModel,
          wingTimeoutSec: opts.wingTimeoutSec,
        });
        if (compress.parsed) {
          const applyResult = applyPatches(roundDoc, compress.parsed.patches);
          // Same guard as the coherence pass: only a non-growing result lands.
          if (applyResult.applied.length > 0 && applyResult.newDoc.length <= roundDoc.length * 1.02) {
            log(`round ${roundNum}: compress removed ${roundDoc.length - applyResult.newDoc.length} chars (${applyResult.applied.length} patches)`);
            compressInfo = {
              patches_applied: applyResult.applied.length,
              chars_delta: applyResult.newDoc.length - roundDoc.length,
            };
            roundDoc = applyResult.newDoc;
            // Survivor check: a compress pass that removed (or rewrote) the
            // text a wing patch just added has UN-fixed that finding —
            // re-open it instead of reporting a fix that isn't in the doc.
            compressedAway = wingOutcome.applied.filter(
              (p) => p.new.length > 0 && !roundDoc.includes(p.new),
            );
            if (compressedAway.length > 0) {
              log(`round ${roundNum}: compress removed the fix text of ${compressedAway.length} applied patch(es) — re-opening those findings`);
            }
          } else if (applyResult.applied.length > 0) {
            log(`round ${roundNum}: compress rejected — result grew the doc`);
          }
        } else {
          log(`round ${roundNum}: compress pass failed (${compress.error ?? compress.parse_error}) — keeping the round's result as-is`);
        }
      }
      currentDoc = roundDoc;
      fs.writeFileSync(docAbs, currentDoc);
      if (opts.commitFixes) {
        commitSha = await gitCommitDoc({
          repoDir: opts.repoDir,
          docPath: opts.docPath,
          message: buildFixCommitMessage({
            roundNum,
            applied: wingOutcome.applied.length,
            failures: wingOutcome.patch_failures.length,
            skipped: wingOutcome.skipped.length,
            promptsDir: opts.promptsDir,
            findingsByDomain: countByDomain(toFix),
          }),
        });
        if (commitSha) fixesCommitted++;
      }
      // Accumulate across rounds (not overwrite): with 3+ rounds, round 1's
      // fix text would otherwise become churn bait again by round 3. Only
      // compress SURVIVORS — quoting removed text as "protected fix text"
      // would mislead the next round's lead. The renderer's size cap keeps
      // the prompt bounded.
      const survivors = wingOutcome.applied.filter((p) => !compressedAway.includes(p));
      lastAppliedPatches.push(...survivors);
    }

    // On a revert (or a compress removal) the wing's patches do NOT exist in
    // the doc — report them as discarded/failed, never as applied, or
    // downstream thread-resolution marks findings "autofixed" for fixes that
    // were thrown away.
    const survivingApplied = roundReverted
      ? []
      : wingOutcome.applied.filter((p) => !compressedAway.includes(p));
    fixSummary = {
      attempted: wingOutcome.attempted.length,
      applied: survivingApplied.length,
      skipped_by_wing: wingOutcome.skipped.length,
      applied_finding_ids: survivingApplied.map((p) => p.finding_id),
      skipped_finding_ids: wingOutcome.skipped.map((s) => s.finding_id),
      deferred_by_cap: deferred.length,
      round_reverted: roundReverted,
      discarded_finding_ids: roundReverted ? wingOutcome.applied.map((p) => p.finding_id) : [],
      compress: compressInfo,
      patch_failures: [
        ...wingOutcome.patch_failures.map((pf) => ({
          finding_id: pf.patch.finding_id,
          old: snippet(pf.patch.old, 100),
          reason: pf.reason,
        })),
        ...compressedAway.map((p) => ({
          finding_id: p.finding_id,
          old: snippet(p.old, 100),
          reason: "removed_by_compress",
        })),
      ],
      wing_error: wingOutcome.wing_error,
      commit_sha: commitSha,
    };

    // Track which (section, domain, agent) we attempted to fix — so the next
    // round can flag the same combo as `recurring`. A reverted round fixed
    // nothing: pushing its findings would make the final review label the
    // same (untouched) findings `recurring` and fake a churn signal.
    if (!roundReverted) for (const f of toFix) priorFixed.push(f);

    // Disposition memory for later rounds' lead prompts. "fixed" only for
    // compress SURVIVORS; a compress-removed fix re-opens as patch_failed.
    // Deferred findings get NO entry — the host re-queues them itself
    // (deferredBacklog), so telling the lead anything about them just risks
    // suppressing a legitimate re-raise.
    {
      const survivingIds = new Set(survivingApplied.map((p) => p.finding_id));
      const compressedIds = new Set(compressedAway.map((p) => p.finding_id));
      const skippedById = new Map(wingOutcome.skipped.map((s) => [s.finding_id, s.reason]));
      for (const f of toFix) {
        if (roundReverted) priorDispositions.push({ finding: f, disposition: "discarded", round: roundNum });
        else if (survivingIds.has(f.id)) priorDispositions.push({ finding: f, disposition: "fixed", round: roundNum });
        else if (compressedIds.has(f.id)) priorDispositions.push({ finding: f, disposition: "patch_failed", round: roundNum, reason: "fix text removed by in-round compress" });
        else if (skippedById.has(f.id)) priorDispositions.push({ finding: f, disposition: "skipped", round: roundNum, reason: skippedById.get(f.id) ?? "" });
        else priorDispositions.push({ finding: f, disposition: "patch_failed", round: roundNum });
      }
    }

    const roundReceipt = buildRoundReceipt({
      roundNum,
      kind: "review-fix",
      leadResults,
      classified,
      fix: fixSummary,
      durationS: elapsedSec(roundT0),
    });
    receiptRounds.push(roundReceipt);
    persistedRounds.push(toPersisted(roundReceipt, "review-fix"));
    pushRoundStat(
      {
        attempted: wingOutcome.attempted.length,
        applied: roundReverted ? 0 : wingOutcome.applied.length,
        failures: wingOutcome.patch_failures.length,
      },
      elapsedSec(roundT0),
    );
    persistRunSnapshot(`round-${roundNum}`);

    if (roundReverted) {
      // The round's result was discarded; continuing would re-review the same
      // doc and reproduce the same conflict. Stop here — coherence + final
      // review still run over the last good state.
      break;
    }

    // Process-health circuit breakers — stop a pathological loop (runaway
    // doc growth, non-converging findings) instead of grinding to maxRounds.
    const guard = evaluateGuards(baselineDoc.length, roundStats, opts.config.analytics);
    if (guard.abort) {
      abortedEarly = true;
      abortReason = guard.abort_reason;
      log(`round ${roundNum}: CIRCUIT BREAKER — ${guard.abort_reason}. Stopping fix loop.`);
      // On an unambiguous-padding abort (hard-growth cap or invent-then-condemn),
      // don't leave the operator holding the ballooned doc — restore it to the
      // pre-review state and commit the revert. Convergence-only aborts keep the
      // doc as-is (they may carry legitimate partial progress).
      if (guard.rollback_recommended && opts.config.analytics.rollback_on_hard_growth && currentDoc !== originalDoc) {
        currentDoc = originalDoc;
        fs.writeFileSync(docAbs, currentDoc);
        rolledBackToOriginal = true;
        abortReason = `${abortReason} — document rolled back to its pre-review state (${roundNum} round(s) of padding discarded).`;
        log(`round ${roundNum}: ROLLBACK — restored ${opts.docPath} to its pre-review state.`);
        if (opts.commitFixes) {
          await gitCommitDoc({
            repoDir: opts.repoDir,
            docPath: opts.docPath,
            message: `revert(review-doc): discard padding — ${guard.flags.includes("runaway_growth_hard") ? "hard growth cap" : "invent-then-condemn"} breaker\n\n${guard.abort_reason}`,
          });
        }
      }
      break;
    }
    if (guard.growth_ack_required) {
      log(`round ${roundNum}: GROWTH WARNING — doc grew past ${opts.config.analytics.max_doc_growth_ratio}x while findings decline; continuing (operator ack required before Phase 5 — receipt analytics.growth_ack_required)`);
    }

    if (wingOutcome.applied.length === 0) {
      log(`round ${roundNum}: wing applied 0 patches — terminating fix loop`);
      break;
    }
  }

  // Coherence pass — a single wing dispatch that tightens the post-fix-loop
  // document: contradictions, repetitions, fluff, leftovers. Net-reducing by
  // contract; runs even after a circuit-breaker abort (that's when the doc
  // needs it most). Skipped on dispatch failure, dry-run, or a padding rollback
  // (nothing to tighten — the doc is back to its pre-review state).
  let coherenceReceipt: Receipt["coherence"] = null;
  if (opts.coherencePass && !convergeMode && !dispatchFailureEarlyExit && !opts.dryRun && !rolledBackToOriginal) {
    log("── Coherence pass ──");
    const cohT0 = process.hrtime.bigint();
    const docBefore = currentDoc;
    const wing = await runWingOnce({
      prompt: buildCoherencePrompt({ doc: currentDoc }),
      wingAgent: opts.wingAgent,
      wingModel: opts.wingModel,
      wingTimeoutSec: opts.wingTimeoutSec,
    });
    let applied = 0;
    let attempted = 0;
    let commitSha: string | null = null;
    const cohError = wing.error ?? (wing.parsed ? null : `parse_error:${wing.parse_error}`);
    if (wing.parsed) {
      attempted = wing.parsed.patches.length;
      const applyResult = applyPatches(currentDoc, wing.parsed.patches);
      applied = applyResult.applied.length;
      if (applied > 0 && applyResult.newDoc.length <= docBefore.length * 1.02) {
        // Guard the guard: a "coherence" result that grows the doc >2% is
        // rejected wholesale — the pass exists to shrink, not to author.
        currentDoc = applyResult.newDoc;
        fs.writeFileSync(docAbs, currentDoc);
        if (opts.commitFixes) {
          commitSha = await gitCommitDoc({
            repoDir: opts.repoDir,
            docPath: opts.docPath,
            message: `docs: ${opts.promptsDir} coherence pass (${applied} patches, ${docBefore.length - currentDoc.length} chars removed)\n\nCo-Authored-By: stark-review-doc <noreply@anthropic.com>`,
          });
          if (commitSha) fixesCommitted++;
        }
      } else if (applied > 0) {
        log(`coherence: rejected — result grew the doc (${docBefore.length} → ${applyResult.newDoc.length} chars)`);
        applied = 0;
      }
    }
    const cohDuration = elapsedSec(cohT0);
    log(`coherence: applied=${applied}/${attempted} delta=${currentDoc.length - docBefore.length} chars${cohError ? ` error=${cohError}` : ""}`);
    roundStats.push({
      round: roundStats.length + 1,
      kind: "coherence",
      doc_chars_before: docBefore.length,
      doc_chars_after: currentDoc.length,
      doc_lines_before: countLines(docBefore),
      doc_lines_after: countLines(currentDoc),
      raw_findings: 0,
      to_fix: 0,
      recurring: 0,
      patches_attempted: attempted,
      patches_applied: applied,
      patch_failures: attempted - applied,
      duration_s: cohDuration,
    });
    coherenceReceipt = {
      ran: true,
      patches_applied: applied,
      patches_attempted: attempted,
      chars_delta: currentDoc.length - docBefore.length,
      commit_sha: commitSha,
      error: cohError,
    };
    persistRunSnapshot("coherence");
  }

  // Final review-only round (skipped on dispatch failure or dry-run; in
  // convergence mode this is THE review — delta-scoped — and an empty delta
  // means there is nothing to dispatch). Also skipped after a padding rollback:
  // the doc is back to its pre-review state, so the run declares itself a bust
  // and the operator re-runs deliberately (now under the scope guards).
  let unresolved: DocFinding[] = [];
  if (!dispatchFailureEarlyExit && !opts.dryRun && !rolledBackToOriginal && !(convergeMode && convergeDelta.trim().length === 0)) {
    log(convergeMode ? "── Convergence review (delta-scoped) ──" : "── Final review (review-only) ──");
    const finalT0 = process.hrtime.bigint();
    const reviewInput = convergeMode
      ? buildConvergenceInput({ base: opts.convergeBase!, delta: convergeDelta, doc: currentDoc })
      : currentDoc;
    // The final review gets the anti-churn + disposition notes too: "revert
    // it" stays a legitimate unresolved finding against fix text; "extend it"
    // does not, and resolved/accepted concerns are not re-derived.
    const finalPriorNote = convergeMode ? "" : [
      renderPriorDispositions(priorDispositions),
      renderPriorRoundChanges(lastAppliedPatches),
    ].filter((s) => s.length > 0).join("\n\n");
    const finalLead = await runLeadReview({
      doc: reviewInput,
      domains: domainKeys,
      promptsDir: opts.promptsDir,
      promptsBase: opts.promptsBase,
      repoDir: opts.repoDir,
      maxConcurrent: codexConcurrent,
      timeoutSecFor,
      leadAgent: opts.leadAgent,
      model: opts.leadModel,
      reasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
      ...(finalPriorNote ? { priorRoundNote: finalPriorNote } : {}),
      ...(convergeSources ? { promptSourcesOverride: convergeSources } : {}),
    });
    const allRaw: DocFinding[] = finalLead.flatMap((r) => r.findings);
    // Same cross-domain dedup as the fix rounds — the final round's findings
    // become PR threads, the most user-visible place for refraction noise.
    const classified = classifyFindings(dedupeDocFindings(allRaw), {
      priorFixed,
      fixThreshold: opts.config.fix_threshold,
    });
    unresolved = classified.filter(
      (f) => f.classification === "fix" || f.classification === "recurring",
    );
    const finalReceipt = buildRoundReceipt({
      roundNum: persistedRounds.length + 1,
      kind: "final-review",
      leadResults: finalLead,
      classified,
      fix: null,
      durationS: elapsedSec(finalT0),
    });
    receiptRounds.push(finalReceipt);
    persistedRounds.push(toPersisted(finalReceipt, "final-review"));
    roundStats.push({
      round: roundStats.length + 1,
      kind: "final-review",
      doc_chars_before: currentDoc.length,
      doc_chars_after: currentDoc.length,
      doc_lines_before: countLines(currentDoc),
      doc_lines_after: countLines(currentDoc),
      raw_findings: allRaw.length,
      to_fix: unresolved.length,
      recurring: unresolved.filter((f) => f.classification === "recurring").length,
      patches_attempted: 0,
      patches_applied: 0,
      patch_failures: 0,
      duration_s: elapsedSec(finalT0),
    });
    persistRunSnapshot("final-review");
  }

  // Where "last reviewed" is: HEAD after the final review round (fix +
  // coherence commits included). The convergence pass diffs from here
  // (`--converge --base <sha>`); the exact reviewed content is snapshotted
  // into the run dir for forensics and non-committed flows.
  let lastReviewedSha: string | null = null;
  if (!opts.dryRun) {
    const head = await runGit(["rev-parse", "HEAD"], opts.repoDir, 15);
    lastReviewedSha = head.code === 0 ? head.stdout.trim() : null;
    try {
      fs.writeFileSync(path.join(historyDir, "final-reviewed-doc.md"), currentDoc);
    } catch (err) {
      persistFailed("final/doc-snapshot", err);
    }
  }

  // Coverage — per-domain completion across the whole run. A domain that
  // never completed in any round is a coverage gap: the receipt, analytics,
  // ok flag, and exit code all say so.
  const coverageReport = computeCoverage(receiptRounds, domainKeys);
  if (coverageReport.gaps.length > 0) {
    log(`COVERAGE GAP: ${coverageReport.gaps.join(", ")} never completed a review in any round`);
  }

  // Analytics — monitor + judge the run itself, then persist as sidecars:
  // machine-readable analytics.json in the history dir, human-readable
  // <doc>.review-analytics.md next to the document (red-team sidecar pattern).
  const analytics = buildAnalytics({
    doc: opts.docPath,
    promptsDir: opts.promptsDir,
    originalDoc: baselineDoc,
    finalDoc: currentDoc,
    roundStats,
    thresholds: opts.config.analytics,
    abortedEarly,
    abortReason,
    extraFlags: extraAnalyticsFlags,
    coverage: coverageReport.domains,
    coverageGaps: coverageReport.gaps,
  });
  const analyticsSidecar = docAbs.replace(/\.md$/i, "") + ".review-analytics.md";
  if (!opts.dryRun) {
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      writeJsonAtomic(path.join(historyDir, "analytics.json"), analytics);
      fs.writeFileSync(analyticsSidecar, renderAnalyticsMarkdown(analytics));
    } catch (err) {
      persistFailed("final/analytics", err);
    }
  }
  log(`analytics: grade=${analytics.grade} growth=${analytics.growth_ratio}x flags=[${analytics.flags.join(", ")}]${abortedEarly ? ` aborted="${abortReason}"` : ""}`);

  // Outcome — single source of truth (deriveRunOutcome): a coverage gap is a
  // failed run; transient failures that recovered in a later round are not.
  const outcome = deriveRunOutcome({
    dispatchFailureEarlyExit,
    coverageGaps: coverageReport.gaps,
  });

  const receipt: Receipt = {
    ok: outcome.ok,
    doc: opts.docPath,
    prompts_dir: opts.promptsDir,
    models: { lead: opts.leadModel, wing: opts.wingModel, lead_agent: opts.leadAgent, wing_agent: opts.wingAgent },
    config: {
      fix_threshold: opts.config.fix_threshold,
      max_rounds: maxRounds,
      max_fixes_per_round: opts.config.max_fixes_per_round,
      max_codex_concurrent: codexConcurrent,
      disabled_domains: opts.config.disabled_domains,
    },
    domains: domainKeys,
    coverage: coverageReport.domains,
    coverage_gaps: coverageReport.gaps,
    rounds: receiptRounds,
    unresolved,
    fixes_committed: fixesCommitted,
    run_id: runId,
    history_dir: historyDir,
    persistence_errors: persistenceErrors,
    last_reviewed_sha: lastReviewedSha,
    converge: convergeMode ? { base: opts.convergeBase!, delta_chars: convergeDelta.length } : null,
    analytics,
    coherence: coherenceReceipt,
    error: outcome.error,
  };
  // The receipt itself lands in the run dir too — today it exists only on
  // stdout, which is exactly what evaporates when the process dies.
  if (!opts.dryRun) {
    try {
      writeJsonAtomic(path.join(historyDir, "receipt.json"), receipt);
    } catch (err) {
      persistFailed("final/receipt", err);
    }
  }
  return { receipt, exitCode: outcome.exitCode };
}

function countByDomain(findings: DocFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.domain] = (out[f.domain] ?? 0) + 1;
  return out;
}

function buildFixCommitMessage(opts: {
  roundNum: number;
  applied: number;
  failures: number;
  skipped: number;
  promptsDir: PromptsDir;
  findingsByDomain: Record<string, number>;
}): string {
  const domains = Object.entries(opts.findingsByDomain)
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d}=${n}`)
    .join(", ");
  return [
    `docs: ${opts.promptsDir} round ${opts.roundNum} fixes (${opts.applied} applied)`,
    "",
    `stark-review-doc round ${opts.roundNum}`,
    `Applied: ${opts.applied} | Failures: ${opts.failures} | Skipped: ${opts.skipped}`,
    `Domains: ${domains}`,
    "",
    "Co-Authored-By: stark-review-doc <noreply@anthropic.com>",
  ].join("\n");
}

function buildRoundReceipt(opts: {
  roundNum: number;
  kind: "review-fix" | "final-review";
  leadResults: LeadDispatchResult[];
  classified: DocFinding[];
  fix: Receipt["rounds"][number]["fix"] | null;
  durationS: number;
}): Receipt["rounds"][number] {
  const failed = opts.leadResults.filter((r) => r.error !== null);
  const bySeverity: Record<string, number> = {};
  const byClassification: Record<string, number> = {};
  for (const f of opts.classified) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const c = f.classification ?? "unclassified";
    byClassification[c] = (byClassification[c] ?? 0) + 1;
  }
  return {
    round: opts.roundNum,
    kind: opts.kind,
    results: opts.leadResults.map((r) => ({
      agent: r.agent,
      domain: r.domain,
      model: r.model,
      duration_s: r.duration_s,
      findings_count: r.findings.length,
      empty_ack: r.empty_ack,
      error: r.error,
      parse_error: r.parse_error,
    })),
    failed_results: failed.map((r) => ({ agent: r.agent, domain: r.domain, error: r.error ?? "unknown" })),
    findings: opts.classified,
    summary: {
      total: opts.leadResults.length,
      succeeded: opts.leadResults.length - failed.length,
      failed: failed.length,
      total_findings: opts.classified.length,
      by_severity: bySeverity,
      by_classification: byClassification,
    },
    fix: opts.fix ?? undefined,
    duration_s: opts.durationS,
  };
}

function toPersisted(
  r: Receipt["rounds"][number],
  kind: "review-fix" | "final-review",
): PersistedRound {
  return {
    round: r.round,
    kind,
    agents_run: [...new Set(r.results.map((x) => x.agent))],
    domains_run: r.results.map((x) => x.domain),
    results_count: r.results.length,
    failed_count: r.failed_results.length,
    findings: r.findings,
    fix: r.fix
      ? {
        attempted: r.fix.attempted,
        applied: r.fix.applied,
        skipped_by_wing: r.fix.skipped_by_wing,
        patch_failures: r.fix.patch_failures.map((pf) => ({
          patch: { finding_id: pf.finding_id, old: pf.old, new: "" },
          reason: pf.reason,
        })),
        commit_sha: r.fix.commit_sha,
        wing_error: r.fix.wing_error,
      }
      : undefined,
    duration_s: r.duration_s,
  };
}

function errorReceipt(opts: DispatchOptions, code: string, message: string): Receipt {
  return {
    ok: false,
    doc: opts.docPath,
    prompts_dir: opts.promptsDir,
    models: { lead: opts.leadModel, wing: opts.wingModel, lead_agent: opts.leadAgent, wing_agent: opts.wingAgent },
    config: {
      fix_threshold: opts.config.fix_threshold,
      max_rounds: opts.config.max_rounds,
      max_fixes_per_round: opts.config.max_fixes_per_round,
      max_codex_concurrent: opts.config.max_codex_concurrent,
      disabled_domains: opts.config.disabled_domains,
    },
    domains: [],
    coverage: {},
    coverage_gaps: [],
    rounds: [],
    unresolved: [],
    fixes_committed: 0,
    run_id: "",
    history_dir: "",
    persistence_errors: [],
    last_reviewed_sha: null,
    converge: null,
    analytics: null,
    coherence: null,
    error: { code, message },
  };
}

// ─── CLI ───────────────────────────────────────────────────────────────

interface CliArgs {
  doc: string;
  promptsDir: PromptsDir;
  promptsBase: string;
  repoDir: string;
  dryRun: boolean;
  force: boolean;
  rounds: number | null;
  codexConcurrent: number | null;
  leadAgent: LeadAgent;
  leadModel: string;
  wingAgent: WingAgent;
  wingModel: string;
  leadTimeoutSec: number;
  wingTimeoutSec: number;
  maxWingAttempts: number;
  commitFixes: boolean;
  coherencePass: boolean;
  converge: boolean;
  convergeBase: string | null;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: stark_review_doc.ts --doc PATH --prompts-dir spec-review|plan-review [options]",
    "",
    "Required:",
    "  --doc PATH                 path to design/plan markdown file (repo-relative or absolute)",
    "  --prompts-dir DIR          one of: spec-review, plan-review",
    "",
    "Options:",
    "  --repo-dir DIR             repo root (default: current working directory)",
    `  --prompts-base DIR         base prompt dir (default: ${DEFAULT_PROMPTS_BASE})`,
    "  --rounds N                 max fix rounds (default: from config)",
    "  --codex-concurrent N       cap on concurrent codex dispatches (default: from config)",
    `  --lead-agent AGENT         lead reviewer agent: ${VALID_LEAD_AGENTS.join(", ")} (default: codex)`,
    `  --lead-model MODEL         lead reviewer model id (default: ${CODEX_DEFAULT_MODEL} for codex, ${CLAUDE_LEAD_DEFAULT_MODEL} for claude)`,
    `  --wing-agent AGENT         wing/fixer agent: ${VALID_WING_AGENTS.join(", ")} (default: claude). codex runs at ${CODEX_REASONING_EFFORT_XHIGH}`,
    `  --wing-model MODEL         wing/fixer model id (default: ${CLAUDE_DEFAULT_MODEL} for claude, ${CODEX_WING_DEFAULT_MODEL} for codex)`,
    `  --lead-timeout SEC         per-codex timeout seconds (default: ${DEFAULT_TIMEOUT_SEC})`,
    `  --wing-timeout SEC         per-claude timeout seconds (default: ${WING_TIMEOUT_SEC})`,
    "  --max-wing-attempts N      wing retries within a round on patch miss (default: 2)",
    "  --dry-run                  review only, skip wing fixes and commits",
    "  --force                    proceed even if doc has uncommitted changes",
    "  --no-commit                apply fixes in-place but skip git commit",
    "  --no-coherence             skip the post-fix-loop coherence pass (contradictions/repetitions/fluff/leftovers)",
    "  --converge --base SHA      convergence mode (ADR 0022): review ONLY the git delta base..HEAD of the doc",
    "                             (post-final-review mutations — wing/coherence/operator fixes). Skips the fix",
    "                             loop + coherence; --rounds is ignored; incompatible with --dry-run",
    "  --json                     emit receipt JSON to stdout (default true; here for clarity)",
  ].join("\n");
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = {
    doc: "",
    promptsDir: "spec-review",
    promptsBase: DEFAULT_PROMPTS_BASE,
    repoDir: process.cwd(),
    dryRun: false,
    force: false,
    rounds: null,
    codexConcurrent: null,
    leadAgent: "codex",
    leadModel: CODEX_DEFAULT_MODEL,
    wingAgent: "claude",
    wingModel: CLAUDE_DEFAULT_MODEL,
    leadTimeoutSec: DEFAULT_TIMEOUT_SEC,
    wingTimeoutSec: WING_TIMEOUT_SEC,
    maxWingAttempts: 2,
    commitFixes: true,
    coherencePass: true,
    converge: false,
    convergeBase: null,
    json: true,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const asInt = (v: string, flag: string): number => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`${flag} must be an integer (got ${v})`);
    return n;
  };
  let sawPromptsDir = false;
  let sawLeadModel = false;
  let sawWingModel = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--doc":                args.doc = need(i, a); i++; break;
      case "--prompts-dir": {
        const v = need(i, a); i++;
        if (!(VALID_PROMPTS_DIRS as readonly string[]).includes(v)) {
          throw new Error(`--prompts-dir must be one of: ${VALID_PROMPTS_DIRS.join(", ")} (got ${v})`);
        }
        args.promptsDir = v as PromptsDir;
        sawPromptsDir = true;
        break;
      }
      case "--repo-dir":           args.repoDir = need(i, a); i++; break;
      case "--prompts-base":       args.promptsBase = need(i, a); i++; break;
      case "--rounds":             args.rounds = asInt(need(i, a), a); i++; break;
      case "--codex-concurrent":   args.codexConcurrent = asInt(need(i, a), a); i++; break;
      case "--lead-agent": {
        const v = need(i, a); i++;
        if (!(VALID_LEAD_AGENTS as readonly string[]).includes(v)) {
          throw new Error(`--lead-agent must be one of: ${VALID_LEAD_AGENTS.join(", ")} (got ${v})`);
        }
        args.leadAgent = v as LeadAgent;
        break;
      }
      case "--lead-model":         args.leadModel = need(i, a); sawLeadModel = true; i++; break;
      case "--wing-agent": {
        const v = need(i, a); i++;
        if (!(VALID_WING_AGENTS as readonly string[]).includes(v)) {
          throw new Error(`--wing-agent must be one of: ${VALID_WING_AGENTS.join(", ")} (got ${v})`);
        }
        args.wingAgent = v as WingAgent;
        break;
      }
      case "--wing-model":         args.wingModel = need(i, a); sawWingModel = true; i++; break;
      case "--lead-timeout":       args.leadTimeoutSec = asInt(need(i, a), a); i++; break;
      case "--wing-timeout":       args.wingTimeoutSec = asInt(need(i, a), a); i++; break;
      case "--max-wing-attempts":  args.maxWingAttempts = asInt(need(i, a), a); i++; break;
      case "--dry-run":            args.dryRun = true; break;
      case "--force":              args.force = true; break;
      case "--no-commit":          args.commitFixes = false; break;
      case "--no-coherence":       args.coherencePass = false; break;
      case "--converge":           args.converge = true; break;
      case "--base":               args.convergeBase = need(i, a); i++; break;
      case "--json":               args.json = true; break;
      case "-h": case "--help":    process.stdout.write(usage() + "\n"); process.exit(0);
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!args.doc) throw new Error("--doc is required");
  if (!sawPromptsDir) throw new Error("--prompts-dir is required");
  // Default the lead model to the agent's default unless explicitly overridden.
  if (!sawLeadModel && args.leadAgent === "claude") {
    args.leadModel = CLAUDE_LEAD_DEFAULT_MODEL;
  }
  // Same for the wing: codex wing defaults to gpt-5.6-sol (run at xhigh).
  if (!sawWingModel && args.wingAgent === "codex") {
    args.wingModel = CODEX_WING_DEFAULT_MODEL;
  }
  if (args.rounds !== null && (args.rounds < 1 || args.rounds > MAX_ROUNDS_CEILING)) {
    throw new Error(`--rounds must be 1..${MAX_ROUNDS_CEILING}`);
  }
  if (args.codexConcurrent !== null && args.codexConcurrent < 1) {
    throw new Error("--codex-concurrent must be >= 1");
  }
  if (args.maxWingAttempts < 1) throw new Error("--max-wing-attempts must be >= 1");
  if (args.leadTimeoutSec <= 0) throw new Error("--lead-timeout must be > 0");
  if (args.wingTimeoutSec <= 0) throw new Error("--wing-timeout must be > 0");
  if (args.converge && args.convergeBase === null) throw new Error("--converge requires --base <sha>");
  if (!args.converge && args.convergeBase !== null) throw new Error("--base only applies with --converge");
  if (args.converge && args.dryRun) throw new Error("--converge cannot be combined with --dry-run");
  return args;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n\n${usage()}\n`);
    return 2;
  }

  const config = loadDocReviewConfig(args.promptsDir);

  const dispatchOpts: DispatchOptions = {
    docPath: args.doc,
    promptsDir: args.promptsDir,
    promptsBase: args.promptsBase,
    repoDir: args.repoDir,
    config,
    maxRoundsOverride: args.rounds,
    codexConcurrentOverride: args.codexConcurrent,
    dryRun: args.dryRun,
    force: args.force,
    leadAgent: args.leadAgent,
    leadModel: args.leadModel,
    wingAgent: args.wingAgent,
    wingModel: args.wingModel,
    leadTimeoutSec: args.leadTimeoutSec,
    wingTimeoutSec: args.wingTimeoutSec,
    maxWingAttempts: args.maxWingAttempts,
    commitFixes: args.commitFixes,
    coherencePass: args.coherencePass && config.coherence_pass,
    convergeBase: args.converge ? args.convergeBase : null,
  };

  const { receipt, exitCode } = await dispatchDocReview(dispatchOpts);
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  // Stderr summary (one-liner; the receipt is the authoritative payload)
  const totalFindings = receipt.rounds.reduce(
    (acc, r) => acc + r.summary.total_findings,
    0,
  );
  log(
    `done: rounds=${receipt.rounds.length} findings=${totalFindings} unresolved=${receipt.unresolved.length} fixes_committed=${receipt.fixes_committed} ok=${receipt.ok} coverage_gaps=${receipt.coverage_gaps.length > 0 ? receipt.coverage_gaps.join(",") : "none"}`,
  );
  return exitCode;
}

// ─── direct-run detection (symlink-aware per /stark-review fix 4c867be) ──

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
  } catch { return false; }
})();

if (invokedDirectly) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
