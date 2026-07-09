#!/usr/bin/env -S node --experimental-strip-types
/**
 * stark_review_doc — multi-round doc review with lead/wing fix loop.
 *
 * Shared dispatcher for /stark-review-spec and /stark-review-plan.
 * Selected with `--prompts-dir spec-review|plan-review`.
 *
 *   Lead:  the reviewer, dispatched per-domain in parallel (capped via
 *          --codex-concurrent). Default agent codex (gpt-5.5) at xhigh; set
 *          --lead-agent claude to run it on a Claude model (defaults to
 *          claude-fable-5). Model override: --lead-model.
 *   Wing:  the fixer — receives findings + current doc, emits a JSON
 *          {patches: [...]} block. Host applies patches sequentially with
 *          unique-match validation; on partial failure it retries the wing
 *          once with failures attached, then gives up the round. Default
 *          agent claude (opus-4-8); set --wing-agent codex to run it on
 *          codex (gpt-5.5 at xhigh). Model override: --wing-model. Lead and
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
 *   0 — ok and no failed_results / unposted reviews
 *   1 — partial or terminal failure
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
  buildFixerPrompt,
  buildReviewerPrompt,
  buildHistoryDir,
  classifyFindings,
  DEFAULT_DOC_REVIEW_CONFIG,
  type DocFinding,
  type DocReviewConfig,
  discoverDomains,
  docFindingId,
  type FixerPatch,
  MAX_ROUNDS_CEILING,
  parseFixerOutput,
  parseReviewerOutput,
  persistRoundsHistory,
  type PersistedRound,
  pmap,
  resolveDocPromptSources,
  selectFindingsToFix,
} from "./stark_review_doc_lib.ts";
import { assetConfigPath, assetPromptsDir } from "./asset_root_lib.ts";

// ─── Constants ─────────────────────────────────────────────────────────

const HOME = os.homedir();
const DEFAULT_PROMPTS_BASE = assetPromptsDir();
const DEFAULT_TIMEOUT_SEC = 600;
const WING_TIMEOUT_SEC = 900;
const CODEX_DEFAULT_MODEL = "gpt-5.5";
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
const CODEX_WING_DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_OUTPUT_CAP = 32 * 1024 * 1024;

const VALID_PROMPTS_DIRS = ["spec-review", "plan-review"] as const;
type PromptsDir = (typeof VALID_PROMPTS_DIRS)[number];

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
 * wing on gpt-5.5 at xhigh). The wing must RETURN a patch, never mutate files —
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
  if (typeof section.max_codex_concurrent === "number" && section.max_codex_concurrent > 0) {
    cfg.max_codex_concurrent = Math.floor(section.max_codex_concurrent);
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
  timeoutSec: number;
  leadAgent: LeadAgent;
  model: string;
  reasoningEffort: string;
}): Promise<LeadDispatchResult[]> {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "stark-doc-review-"));
  try {
    return await pmap(opts.domains, opts.maxConcurrent, async (domain) => {
      const sources = resolveDocPromptSources({
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
      });
      log(`${ts()} → ${opts.leadAgent}:${domain} dispatch (model=${opts.model})`);
      const r = opts.leadAgent === "claude"
        ? await runClaudeReviewer({
          domain,
          prompt,
          timeoutSec: opts.timeoutSec,
          model: opts.model,
        })
        : await runCodexReviewer({
          domain,
          prompt,
          timeoutSec: opts.timeoutSec,
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
}

interface Receipt {
  ok: boolean;
  doc: string;
  prompts_dir: string;
  models: Record<string, string>;
  config: {
    fix_threshold: string;
    max_rounds: number;
    max_codex_concurrent: number;
    disabled_domains: string[];
  };
  domains: string[];
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
      patch_failures: Array<{ finding_id: string; old: string; reason: string }>;
      wing_error: string | null;
      commit_sha: string | null;
    };
    duration_s: number;
  }>;
  unresolved: DocFinding[];
  fixes_committed: number;
  history_dir: string;
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

  // Domain discovery + disabled filter
  const allDomains = discoverDomains(promptsRoot, ["codex", "claude", "gemini"]);
  const enabledDomains = allDomains.filter((d) => !opts.config.disabled_domains.includes(d.key));
  if (enabledDomains.length === 0) {
    return {
      receipt: errorReceipt(opts, "no_domains", `No domains discovered under ${promptsRoot}`),
      exitCode: 1,
    };
  }
  const domainKeys = enabledDomains.map((d) => d.key);

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
  const maxRounds = opts.maxRoundsOverride !== null
    ? Math.min(MAX_ROUNDS_CEILING, Math.max(1, opts.maxRoundsOverride))
    : opts.config.max_rounds;
  const codexConcurrent = opts.codexConcurrentOverride ?? opts.config.max_codex_concurrent;

  log(`config: prompts=${opts.promptsDir} max_rounds=${maxRounds} fix_threshold=${opts.config.fix_threshold} codex_concurrent=${codexConcurrent} dry_run=${opts.dryRun}`);
  log(`domains: ${domainKeys.join(", ")}`);
  log(`lead: ${opts.leadAgent}=${opts.leadModel} | wing: ${opts.wingAgent}=${opts.wingModel}`);

  const persistedRounds: PersistedRound[] = [];
  const receiptRounds: Receipt["rounds"] = [];
  const priorFixed: DocFinding[] = [];
  let fixesCommitted = 0;
  let dispatchFailureEarlyExit = false;

  for (let roundNum = 1; roundNum <= maxRounds; roundNum++) {
    const roundT0 = process.hrtime.bigint();
    log(`── Round ${roundNum} (review-fix) ──`);

    const leadResults = await runLeadReview({
      doc: currentDoc,
      domains: domainKeys,
      promptsDir: opts.promptsDir,
      promptsBase: opts.promptsBase,
      repoDir: opts.repoDir,
      maxConcurrent: codexConcurrent,
      timeoutSec: opts.leadTimeoutSec,
      leadAgent: opts.leadAgent,
      model: opts.leadModel,
      reasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
    });
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
      dispatchFailureEarlyExit = true;
      break;
    }

    const allRaw: DocFinding[] = leadResults.flatMap((r) => r.findings);
    const classified = classifyFindings(allRaw, {
      priorFixed,
      fixThreshold: opts.config.fix_threshold,
    });
    const toFix = selectFindingsToFix(classified);
    log(`round ${roundNum}: ${allRaw.length} raw findings → ${toFix.length} to fix (threshold=${opts.config.fix_threshold})`);

    let fixSummary: Receipt["rounds"][number]["fix"] | undefined;

    if (toFix.length === 0) {
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

    let commitSha: string | null = null;
    if (wingOutcome.applied.length > 0) {
      currentDoc = wingOutcome.finalDoc;
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
    }

    fixSummary = {
      attempted: wingOutcome.attempted.length,
      applied: wingOutcome.applied.length,
      skipped_by_wing: wingOutcome.skipped.length,
      applied_finding_ids: wingOutcome.applied.map((p) => p.finding_id),
      skipped_finding_ids: wingOutcome.skipped.map((s) => s.finding_id),
      patch_failures: wingOutcome.patch_failures.map((pf) => ({
        finding_id: pf.patch.finding_id,
        old: snippet(pf.patch.old, 100),
        reason: pf.reason,
      })),
      wing_error: wingOutcome.wing_error,
      commit_sha: commitSha,
    };

    // Track which (section, domain, agent) we attempted to fix — so the next
    // round can flag the same combo as `recurring`.
    for (const f of toFix) priorFixed.push(f);

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

    if (wingOutcome.applied.length === 0) {
      log(`round ${roundNum}: wing applied 0 patches — terminating fix loop`);
      break;
    }
  }

  // Final review-only round (skipped on dispatch failure or dry-run)
  let unresolved: DocFinding[] = [];
  if (!dispatchFailureEarlyExit && !opts.dryRun) {
    log("── Final review (review-only) ──");
    const finalT0 = process.hrtime.bigint();
    const finalLead = await runLeadReview({
      doc: currentDoc,
      domains: domainKeys,
      promptsDir: opts.promptsDir,
      promptsBase: opts.promptsBase,
      repoDir: opts.repoDir,
      maxConcurrent: codexConcurrent,
      timeoutSec: opts.leadTimeoutSec,
      leadAgent: opts.leadAgent,
      model: opts.leadModel,
      reasoningEffort: CODEX_REASONING_EFFORT_XHIGH,
    });
    const allRaw: DocFinding[] = finalLead.flatMap((r) => r.findings);
    const classified = classifyFindings(allRaw, {
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
  }

  const historyDir = buildHistoryDir({
    home: HOME,
    promptsDir: opts.promptsDir,
    docPath: opts.docPath,
  });
  if (!opts.dryRun) {
    persistRoundsHistory({
      historyDir,
      docPath: opts.docPath,
      promptsDir: opts.promptsDir,
      rounds: persistedRounds,
      models: { lead: opts.leadModel, wing: opts.wingModel, lead_agent: opts.leadAgent, wing_agent: opts.wingAgent },
    });
  }

  const anyFailedResults = receiptRounds.some((r) => r.failed_results.length > 0);
  const exitCode = dispatchFailureEarlyExit || anyFailedResults ? 1 : 0;

  const receipt: Receipt = {
    ok: !dispatchFailureEarlyExit,
    doc: opts.docPath,
    prompts_dir: opts.promptsDir,
    models: { lead: opts.leadModel, wing: opts.wingModel, lead_agent: opts.leadAgent, wing_agent: opts.wingAgent },
    config: {
      fix_threshold: opts.config.fix_threshold,
      max_rounds: maxRounds,
      max_codex_concurrent: codexConcurrent,
      disabled_domains: opts.config.disabled_domains,
    },
    domains: domainKeys,
    rounds: receiptRounds,
    unresolved,
    fixes_committed: fixesCommitted,
    history_dir: historyDir,
    error: dispatchFailureEarlyExit
      ? { code: "dispatch_failure", message: "All lead reviewers failed in a round; see rounds[].failed_results" }
      : null,
  };
  return { receipt, exitCode };
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
      max_codex_concurrent: opts.config.max_codex_concurrent,
      disabled_domains: opts.config.disabled_domains,
    },
    domains: [],
    rounds: [],
    unresolved: [],
    fixes_committed: 0,
    history_dir: "",
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
  // Same for the wing: codex wing defaults to gpt-5.5 (run at xhigh).
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
  };

  const { receipt, exitCode } = await dispatchDocReview(dispatchOpts);
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  // Stderr summary (one-liner; the receipt is the authoritative payload)
  const totalFindings = receipt.rounds.reduce(
    (acc, r) => acc + r.summary.total_findings,
    0,
  );
  log(
    `done: rounds=${receipt.rounds.length} findings=${totalFindings} unresolved=${receipt.unresolved.length} fixes_committed=${receipt.fixes_committed} ok=${receipt.ok}`,
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
