import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMarker,
  DEFAULT_TEST_ENV_ALLOWLIST,
  evaluateFixLoopGate,
  findingId,
  loadTrustedConfig,
  PathRejectedError,
  renderReviewPrompt,
  resolveBaseRef,
  resolvePromptRoot,
  resolvePromptSources,
  resolveClassifierPrompt,
  selectDomains,
  resolveAgentsForDomains,
  compareSeverityDesc,
  severityMeetsThreshold,
  validateStagePaths,
  type AgentName,
  type Finding,
  type ResolvedConfig,
  type Severity,
} from "./stark_review_lib.ts";
import type { BuildContext, BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";
import { assetToolsDir } from "./asset_root_lib.ts";

// ─── Agent port loader (Phase 3, preserved) ─────────────────────────────────

export interface AgentPort {
  buildCommand(prompt: string, model?: string, ctx?: BuildContext): BuiltCommand;
  parseOutput(stdout: string): ParseResult;
  /** Unwrap any agent-specific envelope (e.g. `{"response":"..."}` for gemini)
   * to expose the raw assistant text. Optional — callers fall back to the
   * raw stdout when absent. */
  normalizeOutput?: (stdout: string) => string;
}

const AGENT_MODULE_PATHS: Readonly<Record<AgentName, string>> = Object.freeze({
  claude: "./agent_claude.ts",
  codex: "./agent_codex.ts",
  gemini: "./agent_gemini.ts",
});

const portCache: Map<AgentName, Promise<AgentPort>> = new Map();

export async function loadAgentPort(agent: AgentName): Promise<AgentPort> {
  const cached = portCache.get(agent);
  if (cached) return cached;

  const modulePath = AGENT_MODULE_PATHS[agent];
  if (!modulePath) {
    throw Object.assign(
      new Error(`loadAgentPort: unknown agent '${agent}'`),
      { code: "agent_not_supported" as const },
    );
  }

  const promise = import(modulePath).then((mod): AgentPort => {
    if (
      typeof mod.buildCommand !== "function" ||
      typeof mod.parseOutput !== "function"
    ) {
      throw Object.assign(
        new Error(
          `loadAgentPort: module ${modulePath} does not export buildCommand/parseOutput`,
        ),
        { code: "agent_not_supported" as const },
      );
    }
    return {
      buildCommand: mod.buildCommand as AgentPort["buildCommand"],
      parseOutput: mod.parseOutput as AgentPort["parseOutput"],
      ...(typeof mod.normalizeOutput === "function"
        ? { normalizeOutput: mod.normalizeOutput as (s: string) => string }
        : {}),
    };
  });

  portCache.set(agent, promise);
  try {
    return await promise;
  } catch (err) {
    portCache.delete(agent);
    throw err;
  }
}

export async function resolveAgentPorts(
  agentByDomain: Record<string, AgentName>,
): Promise<Map<AgentName, AgentPort>> {
  const unique = new Set<AgentName>(Object.values(agentByDomain));
  const out = new Map<AgentName, AgentPort>();
  for (const agent of unique) {
    const port = await loadAgentPort(agent);
    out.set(agent, port);
  }
  return out;
}

export function _resetAgentPortCacheForTests(): void {
  portCache.clear();
}

// ─── Task 4-1: CLI parser ───────────────────────────────────────────────────

export interface CliConfig {
  pr: number;
  repo: string;
  base: string;
  worktree: string;
  configRoot: string;
  agent: AgentName | null;
  quick: boolean;
  domains: string[] | null;
  dryRun: boolean;
  noFixLoop: boolean;
  allowUntrustedFixLoop: boolean;
  maxRounds: number;
  maxRoundsExplicit: boolean;
  json: boolean;
}

export interface ParseCliResult {
  config?: CliConfig;
  helpRequested: boolean;
  warnings: string[];
  errors: string[];
}

/** Hard ceiling for --max-rounds. Fix loops are bounded to prevent runaway
 * sessions; values above this are rejected with a CLI error. */
export const MAX_ROUNDS_CEILING = 10;

export const HELP_TEXT = `Usage: stark_review --pr <N> --repo <owner/repo> --base <branch> \\
                      --worktree <abs path> --config-root <abs path> [options]

Required:
  --pr <int>                PR number
  --repo <owner/repo>       Repository slug
  --base <branch>           Base branch / ref
  --worktree <abs path>     Absolute path to PR checkout
  --config-root <abs path>  Absolute path to trusted config root

Options:
  --agent <name>            Force a single agent (claude|codex|gemini)
  --quick                   Use config.quick_domains
  --domains <a,b,c>         Comma-separated domain slugs (overrides --quick)
  --dry-run                 Skip POST; record intended payload in receipt
  --no-fix-loop             Skip the fix loop for this run (review still posts)
  --allow-untrusted-fix-loop  Opt in to fork-PR fix loop without maintainer_can_modify;
                              ALSO requires config.untrusted_fix_loop=true
  --max-rounds <int>        Max review+fix rounds; every round (incl. the last) fixes
                            (default from config.max_rounds, else 3; ceiling 10)
  --json                    Emit machine receipt to stdout
  --help                    Show this help
`;

function takeFlagValue(argv: string[], i: number, name: string): { value: string; next: number } {
  const tok = argv[i];
  const eq = tok.indexOf("=");
  if (eq >= 0) return { value: tok.slice(eq + 1), next: i + 1 };
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`flag ${name} requires a value`);
  }
  return { value: v, next: i + 2 };
}

export function parseCli(argv: string[]): ParseCliResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  let helpRequested = false;

  let pr: number | null = null;
  let repo: string | null = null;
  let base: string | null = null;
  let worktree: string | null = null;
  let configRoot: string | null = null;
  let agent: AgentName | null = null;
  let quick = false;
  let domains: string[] | null = null;
  let dryRun = false;
  let noFixLoop = false;
  let allowUntrustedFixLoop = false;
  let maxRounds = 3;
  let maxRoundsExplicit = false;
  let json = false;

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    const flag = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
    try {
      switch (flag) {
        case "--help":
        case "-h":
          helpRequested = true;
          i += 1;
          continue;
        case "--pr": {
          const { value, next } = takeFlagValue(argv, i, flag);
          const n = Number.parseInt(value, 10);
          if (!Number.isFinite(n) || n <= 0) {
            errors.push(`--pr must be a positive integer (got ${JSON.stringify(value)})`);
          } else {
            pr = n;
          }
          i = next;
          break;
        }
        case "--repo": {
          const { value, next } = takeFlagValue(argv, i, flag);
          if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
            errors.push(`--repo must be owner/repo (got ${JSON.stringify(value)})`);
          } else {
            repo = value;
          }
          i = next;
          break;
        }
        case "--base": {
          const { value, next } = takeFlagValue(argv, i, flag);
          base = value;
          i = next;
          break;
        }
        case "--worktree": {
          const { value, next } = takeFlagValue(argv, i, flag);
          if (!path.isAbsolute(value)) {
            errors.push(`--worktree must be absolute (got ${JSON.stringify(value)})`);
          } else {
            worktree = value;
          }
          i = next;
          break;
        }
        case "--config-root": {
          const { value, next } = takeFlagValue(argv, i, flag);
          if (!path.isAbsolute(value)) {
            errors.push(`--config-root must be absolute (got ${JSON.stringify(value)})`);
          } else {
            configRoot = value;
          }
          i = next;
          break;
        }
        case "--agent": {
          const { value, next } = takeFlagValue(argv, i, flag);
          if (value !== "claude" && value !== "codex" && value !== "gemini") {
            errors.push(`--agent must be claude|codex|gemini (got ${JSON.stringify(value)})`);
          } else {
            agent = value as AgentName;
          }
          i = next;
          break;
        }
        case "--quick":
          quick = true;
          i += 1;
          break;
        case "--domains": {
          const { value, next } = takeFlagValue(argv, i, flag);
          domains = value.split(",").map((s) => s.trim()).filter(Boolean);
          i = next;
          break;
        }
        case "--dry-run":
          dryRun = true;
          i += 1;
          break;
        case "--no-fix-loop":
          noFixLoop = true;
          i += 1;
          break;
        case "--allow-untrusted-fix-loop":
          allowUntrustedFixLoop = true;
          i += 1;
          break;
        case "--max-rounds": {
          const { value, next } = takeFlagValue(argv, i, flag);
          const n = Number.parseInt(value, 10);
          if (!Number.isFinite(n) || n <= 0) {
            errors.push(`--max-rounds must be a positive integer (got ${JSON.stringify(value)})`);
          } else if (n > MAX_ROUNDS_CEILING) {
            errors.push(
              `--max-rounds exceeds sane ceiling of ${MAX_ROUNDS_CEILING} (got ${n}); fix loops are bounded to prevent runaway sessions`,
            );
          } else {
            maxRounds = n;
            maxRoundsExplicit = true;
          }
          i = next;
          break;
        }
        case "--json":
          json = true;
          i += 1;
          break;
        default:
          errors.push(`unknown flag: ${flag}`);
          i += 1;
      }
    } catch (err) {
      errors.push((err as Error).message);
      i += 1;
    }
  }

  if (helpRequested) return { helpRequested: true, warnings, errors: [] };

  if (allowUntrustedFixLoop) {
    warnings.push(
      "--allow-untrusted-fix-loop: requires config.untrusted_fix_loop=true to actually run on fork PRs without maintainer_can_modify; otherwise the fix loop will refuse with auth_denied.",
    );
  }

  if (domains && quick) {
    warnings.push("--domains beats --quick; --quick ignored.");
  }

  for (const [name, val] of [
    ["--pr", pr],
    ["--repo", repo],
    ["--base", base],
    ["--worktree", worktree],
    ["--config-root", configRoot],
  ] as const) {
    if (val === null || val === undefined) errors.push(`missing required flag: ${name}`);
  }

  if (worktree && !fs.existsSync(worktree)) {
    errors.push(`--worktree path does not exist: ${worktree}`);
  }

  if (errors.length > 0) return { helpRequested: false, warnings, errors };

  return {
    helpRequested: false,
    warnings,
    errors: [],
    config: {
      pr: pr!,
      repo: repo!,
      base: base!,
      worktree: worktree!,
      configRoot: configRoot!,
      agent,
      quick,
      domains,
      dryRun,
      noFixLoop,
      allowUntrustedFixLoop,
      maxRounds,
      maxRoundsExplicit,
      json,
    },
  };
}

// ─── Task 4-2: REST-only gh helpers ─────────────────────────────────────────

export interface GhJsonOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  paginate?: boolean;
  /** Optional env keys merged into the gh subprocess env. Used by Task 8-3
   * to inject a per-agent GitHub App token at POST time without polluting
   * process.env. */
  envOverride?: Record<string, string>;
}

export interface GhJsonResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export class GhError extends Error {
  status: number;
  body: string;
  headers: Record<string, string>;
  constructor(status: number, body: string, headers: Record<string, string>, msg?: string) {
    super(msg ?? `gh api failed with status ${status}: ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function rejectGraphqlPath(p: string): void {
  // Avoid embedding the literal token "graphql" preceded by '/' in this source
  // so tools/check-rest-only.sh (the REST-only CI guard) does not flag the
  // rejection itself as a violation.
  if (p.toLowerCase().includes("graph" + "ql")) {
    throw new Error(`REST-only contract violated: ${p} contains forbidden token`);
  }
}

function buildGhEnv(envOverride?: Record<string, string>): NodeJS.ProcessEnv {
  if (!envOverride) return { ...process.env };
  return { ...process.env, ...envOverride };
}

// ─── Per-agent GitHub App token resolution (Task 8-3) ───────────────────────

/** Resolve the GitHub App installation token for a specific agent identity
 * (stark-claude / stark-codex / stark-gemini). Cached per process for the
 * agent's ~1h token lifetime. Tokens are NEVER injected into the agent CLI
 * environment — only into the gh transport that POSTs the review and the git
 * transport that pushes fix commits. Callers that may run long after a token
 * was first minted (the POST and push steps) pass forceRefresh to re-mint. */
const tokenCache: Map<AgentName, string> = new Map();

export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}

export interface TokenForAgentOpts {
  repo?: string;
  toolsDir?: string;
  spawnFn?: typeof spawnCollect;
  nodeBin?: string;
  /** Bypass and overwrite the per-process cache. GH App installation tokens
   * live ~1h, but a single review round can run longer; the POST and push
   * steps force a fresh mint so they never present an expired credential. */
  forceRefresh?: boolean;
}

export async function tokenForAgent(
  agent: AgentName,
  opts: TokenForAgentOpts = {},
): Promise<string> {
  const cached = opts.forceRefresh ? undefined : tokenCache.get(agent);
  if (cached) return cached;
  // Default to the installed TS CLI at ~/.claude/code-review/tools/github_app.ts.
  // Override via `toolsDir` for tests / out-of-tree invocations.
  const tools = opts.toolsDir ?? assetToolsDir();
  const node = opts.nodeBin ?? "node";
  const args = [
    "--experimental-strip-types",
    path.join(tools, "github_app.ts"),
    "--app", `stark-${agent}`,
  ];
  if (opts.repo) args.push("--repo", opts.repo);
  args.push("token");
  const sp = await (opts.spawnFn ?? spawnCollect)(node, args, { env: process.env });
  if (sp.status !== 0) {
    throw new Error(
      `tokenForAgent(${agent}) failed (exit ${sp.status}): ${sp.stderr.slice(0, 400)}`,
    );
  }
  const token = sp.stdout.trim();
  if (!token) {
    throw new Error(`tokenForAgent(${agent}) returned empty token`);
  }
  tokenCache.set(agent, token);
  return token;
}

// ─── Progress logging ───────────────────────────────────────────────────────
// Writes to stderr so it doesn't pollute the JSON receipt on stdout.
// On by default when stderr is a TTY; force via STARK_REVIEW_VERBOSE=1; silence
// via STARK_REVIEW_QUIET=1.

export function progressEnabled(): boolean {
  if (process.env.STARK_REVIEW_QUIET === "1") return false;
  if (process.env.STARK_REVIEW_VERBOSE === "1") return true;
  return Boolean((process.stderr as NodeJS.WriteStream).isTTY);
}

// Strip ASCII control characters (incl. ANSI/OSC escapes) from any text that
// might end up interpolated into a progress() line. PR titles, agent error
// messages, and domain slugs are all attacker-influenceable surfaces, so any
// terminal output of those values is sanitized first.
export function stripControl(s: string): string {
  // Removes C0 (0x00–0x1F except \t/\n/\r are also dropped) and DEL (0x7F).
  // Progress lines are single-line, so we drop tabs/newlines too — the caller
  // shouldn't be passing them in.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1F\x7F]/g, "");
}

// Defensive: even String(err) can throw for exotic thrown values (e.g. an
// object whose `Symbol.toPrimitive` throws). Wrap it so the catch-path is
// guaranteed not to throw recursively.
export function safeStringify(err: unknown): string {
  try {
    if (err instanceof Error) return String(err.message);
    return String(err);
  } catch {
    return "<unrepresentable error>";
  }
}

function progress(msg: string): void {
  if (!progressEnabled()) return;
  process.stderr.write(`stark-review: ${stripControl(msg)}\n`);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  // Round to whole seconds first so a value like 119.5s carries cleanly into
  // 2m 0s instead of producing "1m 60s".
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const rs = total - m * 60;
  return `${m}m ${rs}s`;
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  status: number;
  /** Signal that killed the child, if any. `status` is -1 in that case;
   * callers should consult `signal` before formatting "exit N" messages,
   * since signal-killed processes have no real exit code. Optional so
   * tests can construct SpawnResult literals without spelling it out. */
  signal?: NodeJS.Signals | null;
}

async function spawnCollect(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  } = {},
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const sopts: SpawnOptionsWithoutStdio = {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    };
    const child = spawn(cmd, args, sopts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed: SpawnResult | null = null;
    let settled = false;
    const tryFinish = () => {
      if (settled) return;
      if (closed === null) return;
      if (!stdoutEnded || !stderrEnded) return;
      settled = true;
      resolve(closed);
    };
    child.stdout.on("data", (b) => out.push(b as Buffer));
    child.stderr.on("data", (b) => err.push(b as Buffer));
    child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      closed = {
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: code ?? -1,
        signal: signal ?? null,
      };
      tryFinish();
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Format a one-line failure description for a non-zero/signalled child.
 * Signal-killed processes report no real exit code (status=-1) and often
 * leave only framing chatter on stderr — falling back to stdout and the
 * captured byte counts keeps the message diagnostically useful instead of
 * surfacing things like "agent exit -1: Reading prompt from stdin...". */
function formatAgentExitError(sp: SpawnResult): string {
  const stderrTail = sp.stderr.trim().slice(-400);
  const stdoutTail = sp.stdout.trim().slice(-400);
  const tail = stderrTail || stdoutTail || "<no output captured>";
  if (sp.signal) {
    return `agent killed by signal ${sp.signal} (stdout=${sp.stdout.length}B stderr=${sp.stderr.length}B): ${tail}`;
  }
  return `agent exit ${sp.status}: ${tail}`;
}

/**
 * Call `gh api` against a REST endpoint. Forbids any 'graphql' substring in the
 * path. With paginate=true (default for GET array endpoints), uses gh's
 * --paginate flag and concatenates result arrays.
 */
export async function ghJsonOnce(p: string, opts: GhJsonOpts = {}): Promise<GhJsonResult> {
  rejectGraphqlPath(p);
  const method = opts.method ?? "GET";
  const args: string[] = ["api"];
  if (opts.paginate ?? method === "GET") args.push("--paginate");
  args.push("-X", method);
  args.push("-H", "Accept: application/vnd.github+json");
  args.push("-i");
  args.push(p);
  const input = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
  if (input !== undefined) args.push("--input", "-");
  const res = await spawnCollect("gh", args, { input, env: buildGhEnv(opts.envOverride) });
  const { headers, body, status } = parseHttpStream(res.stdout);
  if (status === 0) {
    throw new GhError(-1, res.stderr || res.stdout, {}, `gh api ${p} failed: ${res.stderr.slice(0, 400)}`);
  }
  let data: unknown = null;
  if (body.length > 0) data = parseConcatenatedJson(body);
  if (status >= 400) throw new GhError(status, body, headers);
  return { status, data, headers };
}

/**
 * Public ghJson: same as ghJsonOnce but retries on 429 / 403 rate-limit / 5xx
 * per the retry policy. Non-retriable failures (4xx other than rate-limit, and
 * 422) still throw on the first attempt.
 */
export async function ghJson(p: string, opts: GhJsonOpts = {}): Promise<GhJsonResult> {
  return await withRetry(() => ghJsonOnce(p, opts));
}

function parseHttpStream(raw: string): { headers: Record<string, string>; body: string; status: number } {
  const blocks: string[] = raw.split(/(?=^HTTP\/[\d.]+ \d+)/m);
  let lastStatus = 0;
  let lastHeaders: Record<string, string> = {};
  const bodies: string[] = [];
  for (const blk of blocks) {
    if (!blk.trim()) continue;
    const sep = blk.indexOf("\r\n\r\n");
    const sep2 = blk.indexOf("\n\n");
    const splitAt =
      sep >= 0 && (sep2 < 0 || sep < sep2) ? { idx: sep, len: 4 } :
      sep2 >= 0 ? { idx: sep2, len: 2 } :
      null;
    let head: string, body: string;
    if (splitAt) {
      head = blk.slice(0, splitAt.idx);
      body = blk.slice(splitAt.idx + splitAt.len);
    } else {
      head = blk;
      body = "";
    }
    const lines = head.split(/\r?\n/);
    const statusLine = lines[0] ?? "";
    const m = statusLine.match(/^HTTP\/[\d.]+\s+(\d+)/);
    if (m) lastStatus = Number.parseInt(m[1], 10);
    lastHeaders = {};
    for (const line of lines.slice(1)) {
      const ci = line.indexOf(":");
      if (ci > 0) {
        const k = line.slice(0, ci).trim().toLowerCase();
        const v = line.slice(ci + 1).trim();
        lastHeaders[k] = v;
      }
    }
    if (body.length > 0) bodies.push(body);
  }
  return { headers: lastHeaders, body: bodies.join(""), status: lastStatus };
}

function parseConcatenatedJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const parts: unknown[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        parts.push(JSON.parse(trimmed.slice(start, i + 1)));
        let j = i + 1;
        while (j < trimmed.length && /\s/.test(trimmed[j])) j++;
        start = j;
        i = j - 1;
      }
    }
  }
  if (parts.length > 0 && parts.every((p) => Array.isArray(p))) {
    return (parts as unknown[][]).flat();
  }
  if (parts.length === 1) return parts[0];
  return parts;
}

/**
 * Run gh with the given argv and return stdout. Used for `gh pr view --json` /
 * `gh pr diff` where the output is not strict JSON-API. Forbids 'graphql' in
 * any arg.
 */
export async function ghText(args: string[]): Promise<string> {
  for (const a of args) rejectGraphqlPath(a);
  const res = await spawnCollect("gh", args, { env: buildGhEnv() });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${res.status}): ${res.stderr.slice(0, 400)}`);
  }
  return res.stdout;
}

// ─── Task 4-3: dispatchDomains with concurrency cap and token isolation ─────

export interface DomainAssignment {
  domain: string;
  agent: AgentName;
  prompt: string;
  model?: string;
}

export interface DispatchResult {
  domain: string;
  agent: AgentName;
  ok: boolean;
  findings: Finding[];
  parseErrors: ParseError[];
  error?: string;
  durationMs: number;
}

const FORBIDDEN_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "STARK_PUSH_TOKEN"] as const;

export function pickAllowlistedEnv(
  source: NodeJS.ProcessEnv,
  allowlist: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = new Set(allowlist);
  for (const k of allow) {
    if (FORBIDDEN_ENV_KEYS.includes(k as (typeof FORBIDDEN_ENV_KEYS)[number])) continue;
    const v = source[k];
    if (typeof v === "string") out[k] = v;
  }
  for (const f of FORBIDDEN_ENV_KEYS) delete (out as Record<string, string>)[f];
  return out;
}

export interface DispatchOptions {
  assignments: DomainAssignment[];
  ports: Map<AgentName, AgentPort>;
  config: ResolvedConfig;
  spawnFn?: typeof spawnCollect;
}

export async function dispatchDomains(opts: DispatchOptions): Promise<DispatchResult[]> {
  const globalCap = Math.max(1, opts.config.runtime?.max_concurrent_agents ?? 3);
  const perAgentCapMap = (opts.config.runtime?.max_concurrent_per_agent ?? {}) as Partial<Record<AgentName, number>>;
  const perAgentCap = (a: AgentName): number => {
    const v = perAgentCapMap[a];
    // Absent / non-number → no cap. Explicit 0 (or negative) means "block":
    // the scheduler's deadlock-drain branch then fails the assignment with
    // dispatch_blocked rather than spinning forever.
    if (typeof v !== "number") return Number.POSITIVE_INFINITY;
    return Math.max(0, v);
  };
  const allowlist = opts.config.runtime?.subagent_env_allowlist ?? [];
  const tempPrefix = opts.config.runtime?.temp_dir_prefix ?? "stark-env";
  const spawner = opts.spawnFn ?? spawnCollect;

  const assignments = opts.assignments;
  const results: DispatchResult[] = new Array(assignments.length);
  const total = assignments.length;
  const pending = new Set<number>();
  for (let i = 0; i < total; i++) pending.add(i);
  const inflight = new Map<number, Promise<void>>();
  const perAgentInFlight = new Map<AgentName, number>();

  async function runOne(idx: number): Promise<void> {
    const a = assignments[idx];
    const start = Date.now();
    progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  starting…`);
    const port = opts.ports.get(a.agent);
    if (!port) {
      results[idx] = {
        domain: a.domain, agent: a.agent, ok: false,
        findings: [], parseErrors: [],
        error: `agent_not_supported: ${a.agent}`,
        durationMs: Date.now() - start,
      };
      progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  fail  agent_not_supported  ${fmtDuration(Date.now() - start)}`);
      return;
    }
    let tempDir: string | null = null;
    try {
      // Create the cwd FIRST so per-agent setup (e.g. Gemini's
      // GEMINI_CLI_HOME / projects.json) can register it before spawn.
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-`));
      const built = port.buildCommand(a.prompt, a.model, {
        cwd: tempDir,
        trustedGeneratedCwd: true,
      });
      const env = pickAllowlistedEnv(process.env, allowlist);
      for (const [k, v] of Object.entries(built.env)) {
        if (!FORBIDDEN_ENV_KEYS.includes(k as (typeof FORBIDDEN_ENV_KEYS)[number])) {
          env[k] = v;
        }
      }
      env.TMPDIR = tempDir;
      const cwd = built.cwd ?? tempDir;
      const sp = await spawner(built.cmd, built.args, {
        input: built.stdin, env, cwd,
      });
      if (sp.status !== 0 || sp.signal) {
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: false,
          findings: [], parseErrors: [],
          error: formatAgentExitError(sp),
          durationMs: Date.now() - start,
        };
        const tag = sp.signal ? `signal=${sp.signal}` : `exit=${sp.status}`;
        progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  fail  ${tag}  ${fmtDuration(Date.now() - start)}`);
        return;
      }
      const parsed = port.parseOutput(sp.stdout);
      // Tier 1 detection: stdout that yields no findings, no parse errors,
      // and no explicit no-findings sentinel is not a clean review. This
      // includes empty stdout: the prompt contract requires either findings
      // or the sentinel, so silence must not become a silent "0 findings".
      if (
        parsed.findings.length === 0 &&
        parsed.parseErrors.length === 0 &&
        !parsed.noFindingsAck
      ) {
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: false,
          findings: [], parseErrors: [],
          error: `no parseable findings and no no_findings sentinel (${sp.stdout.length} stdout bytes)`,
          durationMs: Date.now() - start,
        };
        progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  fail  no-sentinel  ${fmtDuration(Date.now() - start)}`);
        return;
      }
      results[idx] = {
        domain: a.domain, agent: a.agent, ok: true,
        findings: parsed.findings.map((f) => ({ ...f, domain: a.domain, agent: a.agent })),
        parseErrors: parsed.parseErrors,
        durationMs: Date.now() - start,
      };
      progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  ok    ${parsed.findings.length} findings  ${fmtDuration(Date.now() - start)}`);
    } catch (err) {
      const message = safeStringify(err);
      progress(`[${idx + 1}/${total}] ${a.agent} × ${a.domain}  fail  ${message.slice(0, 80)}  ${fmtDuration(Date.now() - start)}`);
      results[idx] = {
        domain: a.domain, agent: a.agent, ok: false,
        findings: [], parseErrors: [],
        error: message,
        durationMs: Date.now() - start,
      };
    } finally {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
      }
    }
  }

  // Scheduler honors BOTH the global cap and any per-agent cap. On each tick
  // it walks pending in submission order and starts every assignment whose
  // agent has a free slot. Skipping a per-agent-blocked assignment to start a
  // later one is intentional — it keeps an unrelated agent's quota usable
  // when one agent is already at its cap, without changing where the result
  // lands in the output array (results[] is keyed by original index).
  while (pending.size > 0 || inflight.size > 0) {
    for (const idx of [...pending]) {
      if (inflight.size >= globalCap) break;
      const agent = assignments[idx].agent;
      if ((perAgentInFlight.get(agent) ?? 0) >= perAgentCap(agent)) continue;
      pending.delete(idx);
      perAgentInFlight.set(agent, (perAgentInFlight.get(agent) ?? 0) + 1);
      const p = runOne(idx).finally(() => {
        perAgentInFlight.set(agent, Math.max(0, (perAgentInFlight.get(agent) ?? 1) - 1));
        inflight.delete(idx);
      });
      inflight.set(idx, p);
    }
    if (inflight.size === 0) {
      // Pending work but no slot for any of it — only reachable when every
      // remaining assignment's per-agent cap is 0 or negative. Drain the
      // remainder as dispatch_blocked so callers see a clear error instead
      // of the scheduler spinning forever.
      for (const idx of pending) {
        const a = assignments[idx];
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: false,
          findings: [], parseErrors: [],
          error: `dispatch_blocked: per-agent concurrency cap for '${a.agent}' is non-positive`,
          durationMs: 0,
        };
      }
      pending.clear();
      break;
    }
    await Promise.race(inflight.values());
  }
  return results;
}

// ─── Task 4-4: parsing + failure tiers ──────────────────────────────────────

export type FailureTier = "tier1_partial" | "tier2_total" | "all_success";

export function applySeverityOverrides(
  findings: Finding[],
  overrides: Record<string, Severity> | undefined,
): Finding[] {
  if (!overrides || Object.keys(overrides).length === 0) return findings;
  return findings.map((f) => {
    const o = overrides[f.domain];
    return o ? { ...f, severity: o } : f;
  });
}

export function classifyDispatchTier(results: DispatchResult[]): FailureTier {
  if (results.length === 0) return "tier2_total";
  const anyOk = results.some((r) => r.ok);
  const anyFail = results.some((r) => !r.ok);
  if (!anyOk) return "tier2_total";
  if (anyFail) return "tier1_partial";
  return "all_success";
}

// ─── Task 4-5: classifier with path validation + abort semantics ────────────

export interface ClassifyOpts {
  worktree: string;
  classifierAgent: AgentName;
  ports: Map<AgentName, AgentPort>;
  classifierPrompt: string;
  spawnFn?: typeof spawnCollect;
  config: ResolvedConfig;
}

export interface ClassifyEvent {
  type:
    | "path_rejected"
    | "classifier_failed"
    | "classifier_aborted"
    | "classifier_prompt_fallback";
  finding_id: string;
  reason: string;
}

export interface ClassifyResult {
  findings: Finding[];
  events: ClassifyEvent[];
  aborted: boolean;
  errorCount: number;
}

const CLASSIFIER_ABORT_THRESHOLD = 5;

export function validatePathContainment(worktree: string, file: string): boolean {
  if (path.isAbsolute(file)) return false;
  if (file.split(/[\\/]/).some((seg) => seg === "..")) return false;
  let realWorktree: string;
  try {
    realWorktree = fs.realpathSync(worktree);
  } catch {
    return false;
  }
  const target = path.join(realWorktree, file);
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(target);
  } catch {
    const normalized = path.resolve(realWorktree, file);
    return normalized === realWorktree || normalized.startsWith(realWorktree + path.sep);
  }
  return realTarget === realWorktree || realTarget.startsWith(realWorktree + path.sep);
}

async function classifyOne(
  finding: Finding,
  opts: ClassifyOpts,
): Promise<{ classification: Finding["classification"]; reason: string; ok: boolean }> {
  const port = opts.ports.get(opts.classifierAgent);
  if (!port) {
    return { classification: "fix", reason: `classifier_failed: agent ${opts.classifierAgent} not loaded`, ok: false };
  }
  const allowlist = opts.config.runtime?.subagent_env_allowlist ?? [];
  const tempPrefix = opts.config.runtime?.temp_dir_prefix ?? "stark-env";
  const safeFinding = {
    id: finding.id,
    domain: finding.domain,
    agent: finding.agent,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    body: finding.body,
  };
  const prompt = `${opts.classifierPrompt}\n\nFinding to classify:\n\`\`\`json\n${JSON.stringify(safeFinding, null, 2)}\n\`\`\`\n\nRespond with a single JSON object: {"classification":"fix|false_positive|noise|ignored","classification_reason":"..."}`;
  const spawner = opts.spawnFn ?? spawnCollect;
  let tempDir: string | null = null;
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-cls-`));
    const built = port.buildCommand(prompt, undefined, {
      cwd: tempDir,
      trustedGeneratedCwd: true,
    });
    const env = pickAllowlistedEnv(process.env, allowlist);
    for (const [k, v] of Object.entries(built.env)) {
      if (!FORBIDDEN_ENV_KEYS.includes(k as (typeof FORBIDDEN_ENV_KEYS)[number])) env[k] = v;
    }
    env.TMPDIR = tempDir;
    const cwd = built.cwd ?? tempDir;
    const sp = await spawner(built.cmd, built.args, { input: built.stdin, env, cwd });
    if (sp.status !== 0) {
      return { classification: "fix", reason: `classifier_failed: exit ${sp.status}`, ok: false };
    }
    // Unwrap any agent-specific framing (e.g. Gemini's `{"response":"..."}`
    // envelope) before scanning for the classification JSON. Without this,
    // gemini-as-classifier would always fail with classifier_failed because
    // the scanner never sees the embedded `"classification"` key.
    const normalized = port.normalizeOutput ? port.normalizeOutput(sp.stdout) : sp.stdout;
    const obj = extractClassificationJson(normalized);
    if (!obj) {
      // Last-ditch fallback: maybe the agent emitted findings JSONL with
      // `classification` already populated (some agents over-deliver).
      const parsed = port.parseOutput(sp.stdout);
      if (parsed.findings.length > 0 && parsed.findings[0].classification) {
        return {
          classification: parsed.findings[0].classification,
          reason: parsed.findings[0].classification_reason ?? "",
          ok: true,
        };
      }
      return { classification: "fix", reason: "classifier_failed: no classification in output", ok: false };
    }
    const c = obj.classification;
    if (c !== "fix" && c !== "false_positive" && c !== "noise" && c !== "ignored") {
      return { classification: "fix", reason: `classifier_failed: bad classification ${JSON.stringify(c)}`, ok: false };
    }
    // Accept both `classification_reason` (the prompt's name) and the legacy
    // `reason` field — some prompt revisions used the shorter name.
    const reasonRaw = obj.classification_reason ?? obj.reason;
    const reason = typeof reasonRaw === "string" ? reasonRaw : "";
    return { classification: c, reason, ok: true };
  } catch (err) {
    return { classification: "fix", reason: `classifier_failed: ${(err as Error).message}`, ok: false };
  } finally {
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
    }
  }
}

/**
 * Find the first balanced JSON object in `text` that has a `classification`
 * field of one of the four enum values. Tolerates surrounding prose, markdown
 * fences, nested braces, and string-escaped braces.
 *
 * Replaces the previous regex (`/\{[^{}]*"classification"[^{}]*\}/`) which
 * silently failed on JSONs containing nested objects (e.g. `extra`, `details`).
 *
 * Strategy: scan for `{` characters and use a brace-balancing parser that
 * respects JSON string escaping (so `{` inside a string doesn't increment the
 * depth). When a balanced `{...}` is found, attempt JSON.parse and check the
 * shape. Returns the first matching object, or null.
 */
export function extractClassificationJson(text: string): Record<string, unknown> | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findBalancedJsonEnd(text, i);
    if (end < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(i, end + 1));
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const obj = parsed as Record<string, unknown>;
    const c = obj.classification;
    if (c === "fix" || c === "false_positive" || c === "noise" || c === "ignored") {
      return obj;
    }
  }
  return null;
}

/** Returns the index of the matching `}` for the `{` at `start`, or -1 if
 * unbalanced. Honors JSON string escaping so braces inside strings are ignored. */
function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

export async function runClassifier(
  findings: Finding[],
  opts: ClassifyOpts,
): Promise<ClassifyResult> {
  const events: ClassifyEvent[] = [];
  const out: Finding[] = [];
  let errorCount = 0;
  let aborted = false;

  for (const f of findings) {
    let working: Finding = { ...f };
    if (working.file && working.line !== null && working.line !== undefined) {
      const safe = validatePathContainment(opts.worktree, working.file);
      if (!safe) {
        events.push({ type: "path_rejected", finding_id: working.id, reason: `path containment rejected: ${working.file}` });
        working = { ...working, file: null, line: null };
      }
    }

    if (aborted) {
      working.classification = "fix";
      working.classification_reason = "classifier_aborted_after_5_errors";
      out.push(working);
      continue;
    }

    const cls = await classifyOne(working, opts);
    if (!cls.ok) {
      errorCount++;
      events.push({ type: "classifier_failed", finding_id: working.id, reason: cls.reason });
      if (errorCount >= CLASSIFIER_ABORT_THRESHOLD) {
        aborted = true;
        events.push({ type: "classifier_aborted", finding_id: working.id, reason: "5 classifier errors in this round" });
      }
    }
    working.classification = cls.classification;
    working.classification_reason = cls.reason;
    if (aborted && !cls.ok) {
      working.classification = "fix";
      working.classification_reason = "classifier_aborted_after_5_errors";
    }
    out.push(working);
  }

  return { findings: out, events, aborted, errorCount };
}

// ─── Task 4-6: history writer + retention pruning ───────────────────────────

export const HISTORY_SCHEMA_VERSION = 2;

export function historyDir(home: string, repo: string, pr: number): string {
  const parts = repo.split("/");
  if (parts.length === 2) {
    return path.join(home, ".claude", "code-review", "history", parts[0], parts[1], String(pr));
  }
  return path.join(home, ".claude", "code-review", "history", repo, String(pr));
}

export function nextRoundNumber(dir: string): number {
  if (!fs.existsSync(dir)) return 1;
  const nums: number[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const m = entry.match(/^round-(\d+)\.json$/);
    if (m) nums.push(Number.parseInt(m[1], 10));
  }
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

export interface RoundHistoryInput {
  home: string;
  repo: string;
  pr: number;
  round: number;
  mode: "single" | "team";
  domain_agents: Record<string, AgentName> | null;
  results: Array<{
    agent: AgentName;
    model: string | null;
    domain: string;
    duration_s: number;
    error: string | null;
    api_key_fallback: boolean;
    findings: Finding[];
  }>;
}

/**
 * Allocate the next round number (max existing round-N + 1) AND write the
 * round file in a single code path. The caller MUST hold the per-PR review
 * lock (see {@link acquireLock}); this function does NOT acquire it itself.
 *
 * Returns the {round, path} so the orchestrator can record both in the receipt.
 *
 * Wing-review fix #2: `nextRoundNumber()` and `writeRoundHistory()` were
 * previously two independent helpers, so a caller that locked around only one
 * could still race. This helper makes the read-max-plus-write atomic within
 * the held lock scope.
 */
export function allocateAndWriteRoundHistory(
  input: Omit<RoundHistoryInput, "round"> & { round?: number },
): { round: number; path: string } {
  const dir = historyDir(input.home, input.repo, input.pr);
  fs.mkdirSync(dir, { recursive: true });
  const round = input.round ?? nextRoundNumber(dir);
  const filePath = writeRoundHistory({ ...input, round });
  return { round, path: filePath };
}

export function writeRoundHistory(input: RoundHistoryInput): string {
  const dir = historyDir(input.home, input.repo, input.pr);
  fs.mkdirSync(dir, { recursive: true });
  const all: Finding[] = [];
  for (const r of input.results) all.push(...r.findings);
  const data = {
    schema_version: HISTORY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    repo: input.repo,
    pr: input.pr,
    mode: input.mode,
    round: input.round,
    domain_agents: input.domain_agents,
    models: Object.fromEntries(
      input.results.filter((r) => r.model).map((r) => [r.agent, r.model] as const),
    ),
    results: input.results.map((r) => ({
      agent: r.agent,
      model: r.model,
      domain: r.domain,
      duration_s: r.duration_s,
      error: r.error,
      api_key_fallback: r.api_key_fallback,
      findings: r.findings.map((f) => ({ ...f })),
    })),
    classification_summary: {
      fix: all.filter((f) => f.classification === "fix").length,
      noise: all.filter((f) => f.classification === "noise").length,
      false_positive: all.filter((f) => f.classification === "false_positive").length,
      ignored: all.filter((f) => f.classification === "ignored").length,
      unclassified: all.filter((f) => f.classification === undefined).length,
      total: all.length,
    },
  };
  const filePath = path.join(dir, `round-${input.round}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

export interface PruneOpts {
  home: string;
  retentionDays: number;
  lockTtlMinutes: number;
  now?: () => number;
}

export interface PruneResult {
  attempted: boolean;
  pruned: string[];
  skipped: Array<{ dir: string; reason: string }>;
  events: Array<{ type: string; message: string }>;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ESRCH") return false;
    return true;
  }
}

function readLockFile(p: string): { pid: number; hostname: string; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(p);
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split(/\r?\n/);
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const hostname = lines[1] ?? "";
    if (!Number.isFinite(pid)) return null;
    return { pid, hostname, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function pruneHistory(opts: PruneOpts): PruneResult {
  const out: PruneResult = { attempted: false, pruned: [], skipped: [], events: [] };
  if (!opts.retentionDays || opts.retentionDays <= 0) return out;
  out.attempted = true;
  const now = opts.now ?? Date.now;
  const lockDir = path.join(opts.home, ".claude", "code-review", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const pruneLock = path.join(lockDir, "prune.lock");
  let pruneFd: number | null = null;
  try {
    try {
      pruneFd = fs.openSync(pruneLock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") throw err;
      const meta = readLockFile(pruneLock);
      const ttlMs = (opts.lockTtlMinutes ?? 30) * 60 * 1000;
      const stale = meta && (now() - meta.mtimeMs) > ttlMs && !pidAlive(meta.pid);
      if (stale) {
        try {
          fs.unlinkSync(pruneLock);
          pruneFd = fs.openSync(pruneLock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
        } catch {
          out.events.push({ type: "prune_lock_skip", message: "could not reclaim stale prune lock" });
          return out;
        }
      } else {
        out.events.push({ type: "prune_lock_skip", message: "another pruner holds the lock" });
        return out;
      }
    }
    fs.writeSync(pruneFd!, `${process.pid}\n${os.hostname()}\n`);

    const cutoff = now() - opts.retentionDays * 24 * 60 * 60 * 1000;
    const root = path.join(opts.home, ".claude", "code-review", "history");
    if (!fs.existsSync(root)) return out;

    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (!e.isDirectory()) continue;
        if (/^\d+$/.test(e.name)) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(full);
          } catch {
            continue;
          }
          if (stat.mtimeMs >= cutoff) continue;
          const segs = full.split(path.sep);
          const pr = segs[segs.length - 1];
          let org: string | undefined;
          let repo: string | undefined;
          if (segs.length >= 4) {
            repo = segs[segs.length - 2];
            org = segs[segs.length - 3];
          }
          const lockName = org && repo ? `${org}-${repo}-${pr}.lock` : `${repo ?? "repo"}-${pr}.lock`;
          const reviewLock = path.join(lockDir, lockName);
          if (fs.existsSync(reviewLock)) {
            const meta = readLockFile(reviewLock);
            const ttlMs = (opts.lockTtlMinutes ?? 30) * 60 * 1000;
            const live = !meta || (now() - meta.mtimeMs) <= ttlMs || pidAlive(meta.pid);
            if (live) {
              out.skipped.push({ dir: full, reason: "review lock held" });
              continue;
            }
          }
          try {
            fs.rmSync(full, { recursive: true, force: true });
            out.pruned.push(full);
          } catch (err) {
            out.events.push({ type: "prune_failed", message: `${full}: ${(err as Error).message}` });
          }
        } else {
          visit(full);
        }
      }
    };
    visit(root);
  } catch (err) {
    out.events.push({ type: "prune_failed", message: (err as Error).message });
  } finally {
    if (pruneFd !== null) {
      try { fs.closeSync(pruneFd); } catch { /* */ }
      try { fs.unlinkSync(pruneLock); } catch { /* */ }
    }
  }
  return out;
}

// ─── Task 4-7: postReview with inline-vs-body routing + 422 fallback ────────

export interface InlineComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  /** Original finding this inline maps back to; used to preserve metadata when
   * GitHub rejects the anchor (422) and we have to demote the comment to body. */
  origin?: Finding;
}

export interface PartitionResult {
  inline: InlineComment[];
  bodyFindings: Finding[];
}

export function partitionInlineVsBody(
  findings: Finding[],
  changedFiles: Set<string>,
  fixThreshold: Severity,
): PartitionResult {
  const inline: InlineComment[] = [];
  const bodyFindings: Finding[] = [];
  for (const f of findings) {
    const eligibleInline =
      f.classification === "fix" &&
      f.file !== null &&
      f.file !== undefined &&
      typeof f.line === "number" &&
      changedFiles.has(f.file) &&
      severityMeetsThreshold(f.severity, fixThreshold);
    if (eligibleInline) {
      inline.push({
        path: f.file as string,
        line: f.line as number,
        side: "RIGHT",
        body: `**${f.severity}** — ${f.title}\n\n${f.body}`,
        origin: f,
      });
    } else {
      bodyFindings.push(f);
    }
  }
  // origin is set above for every push; non-null assertion is safe here.
  inline.sort((a, b) => compareSeverityDesc(a.origin!, b.origin!));
  bodyFindings.sort(compareSeverityDesc);
  return { inline, bodyFindings };
}

/** Render the per-domain agent assignment as a markdown list. Used in the
 * review body for mixed-agent runs so a reader can tell which agent produced
 * each finding even when only one bot identity owns the posted review. */
export function renderAgentsResolvedSummary(
  agentsResolved: Record<string, AgentName>,
): string {
  const entries = Object.entries(agentsResolved).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const lines: string[] = ["## agents_resolved", ""];
  for (const [domain, agent] of entries) {
    lines.push(`- \`${domain}\` → \`${agent}\``);
  }
  return lines.join("\n");
}

/** Choose the agent that owns the posted review when findings span multiple
 * agents. Strategy: agent with the most findings; ties broken by
 * lexicographic order on agent name. Returns null when findings is empty —
 * caller should fall back to the dispatcher's default agent. */
export function selectPostingAgent(findings: Finding[]): AgentName | null {
  if (findings.length === 0) return null;
  const counts = new Map<AgentName, number>();
  for (const f of findings) counts.set(f.agent, (counts.get(f.agent) ?? 0) + 1);
  let best: AgentName | null = null;
  let bestCount = -1;
  for (const [agent, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > bestCount) {
      best = agent;
      bestCount = count;
    }
  }
  return best;
}

export function buildReviewBody(
  marker: string,
  humanSummary: string,
  bodyFindings: Finding[],
  opts: {
    agentsResolved?: Record<string, AgentName>;
    postingAgentNote?: string;
  } = {},
): string {
  const lines: string[] = [marker, "", humanSummary];
  if (opts.postingAgentNote) {
    lines.push("", opts.postingAgentNote);
  }
  if (bodyFindings.length > 0) {
    lines.push("", "## Cross-cutting / out-of-diff findings", "");
    for (const f of bodyFindings) {
      const anchor = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "(no anchor)";
      lines.push(`- **${f.severity}** [${f.domain}] (${anchor}) — ${f.title}`);
      if (f.body) {
        const indented = f.body.split("\n").map((l) => `  ${l}`).join("\n");
        lines.push(indented);
      }
    }
  }
  // Always render the per-domain `agents_resolved` summary when more than one
  // distinct agent is assigned across domains, even if only one of them
  // produced findings. Mixed `domain_agents` runs must remain debuggable from
  // the posted review alone (Task 8-4).
  if (opts.agentsResolved) {
    const distinct = new Set(Object.values(opts.agentsResolved));
    if (distinct.size > 1) {
      const summary = renderAgentsResolvedSummary(opts.agentsResolved);
      if (summary) lines.push("", summary);
    }
  }
  return lines.join("\n");
}

function extract422Indices(errBody: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(errBody);
  } catch {
    return extract422IndicesFromString(errBody);
  }
  if (typeof parsed !== "object" || parsed === null) return extract422IndicesFromString(errBody);
  const errs = (parsed as Record<string, unknown>).errors;
  const idxs = new Set<number>();
  if (Array.isArray(errs)) {
    for (const e of errs) {
      if (typeof e !== "object" || e === null) continue;
      const ei = (e as Record<string, unknown>).index;
      if (typeof ei === "number") idxs.add(ei);
      const field = (e as Record<string, unknown>).field;
      if (typeof field === "string") {
        const m = field.match(/comments?\/(\d+)\b/);
        if (m) idxs.add(Number.parseInt(m[1], 10));
      }
      const msg = (e as Record<string, unknown>).message;
      if (typeof msg === "string") {
        const m = msg.match(/comments\[(\d+)\]/);
        if (m) idxs.add(Number.parseInt(m[1], 10));
      }
    }
  }
  if (idxs.size > 0) return [...idxs].sort((a, b) => a - b);
  return extract422IndicesFromString(errBody);
}

function extract422IndicesFromString(s: string): number[] {
  const idxs = new Set<number>();
  const re = /comments\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) idxs.add(Number.parseInt(m[1], 10));
  const re2 = /comments?\/(\d+)\b/g;
  while ((m = re2.exec(s)) !== null) idxs.add(Number.parseInt(m[1], 10));
  return [...idxs].sort((a, b) => a - b);
}

export interface PostReviewOpts {
  repo: string;
  pr: number;
  round: number;
  agent: AgentName;
  runHash: string;
  findings: Finding[];
  changedFiles: Set<string>;
  fixThreshold: Severity;
  humanSummary: string;
  prHeadSha: string;
  dryRun: boolean;
  /** Per-domain agent assignment; rendered into the review body for
   * mixed-agent runs (Task 8-4). */
  agentsResolved?: Record<string, AgentName>;
  /** When set, included as a body note explaining which bot identity owns
   * the posted review (used for mixed-agent finding rounds, Task 8-3). */
  postingAgentNote?: string;
  /** Per-agent GitHub App installation token. When set, the gh transport
   * runs with GH_TOKEN set to this value so the posted review appears under
   * stark-<agent>[bot] (Task 8-3). The token never reaches agent CLIs. */
  posterToken?: string;
  /** Retrying GH transport, used for the marker GET. Defaults to {@link ghJson}. */
  ghJsonFn?: typeof ghJson;
  /** Non-retrying GH transport, used for the POST itself so the outer
   * marker-aware retry is the only POST retry layer. Defaults to
   * {@link ghJsonOnce}. Falls back to {@link PostReviewOpts.ghJsonFn} for
   * back-compat when only one transport is injected by tests. */
  ghJsonOnceFn?: typeof ghJson;
  /** Inject a custom retry wrapper for tests. Defaults to {@link withRetry}. */
  retryFn?: typeof withRetry;
}

export interface PostReviewResult {
  posted: boolean;
  attempts: Array<{ inline: number; status: "ok" | "fallback" | "body_only"; httpStatus?: number }>;
  fallbacksApplied: number;
  payloadSummary: { inlineCount: number; bodyFindingsCount: number; bodyChars: number };
  reviewId?: number;
  /** Set when retry exhaustion (5xx/429/403 rate-limit) prevented posting; the
   * dispatcher must propagate this into receipt.unposted_reviews and exit
   * non-zero. */
  unposted?: boolean;
  unpostedReason?: string;
}

/** Demote a rejected inline comment back to a body finding, preserving the
 * original Finding metadata (severity, domain, title, body). Anchor info is
 * carried only as routing metadata via file/line. */
function demoteInlineToFinding(c: InlineComment, agent: AgentName): Finding {
  if (c.origin) {
    return { ...c.origin, file: c.path, line: c.line };
  }
  // Fallback when origin missing (defensive — partitionInlineVsBody now always
  // attaches origin, but keep this branch for older callers).
  return {
    id: findingId("anchor-rejected", agent, c.body.slice(0, 64)),
    domain: "anchor-rejected",
    agent,
    severity: "low",
    file: c.path,
    line: c.line,
    title: c.body.split("\n")[0].replace(/^\*\*[^*]+\*\* — /, ""),
    body: c.body,
  };
}

export async function postReview(opts: PostReviewOpts): Promise<PostReviewResult> {
  const part = partitionInlineVsBody(opts.findings, opts.changedFiles, opts.fixThreshold);
  const marker = buildMarker(opts.round, opts.agent, opts.runHash);
  let body = buildReviewBody(marker, opts.humanSummary, part.bodyFindings, {
    agentsResolved: opts.agentsResolved,
    postingAgentNote: opts.postingAgentNote,
  });
  let inline = [...part.inline];
  const result: PostReviewResult = {
    posted: false,
    attempts: [],
    fallbacksApplied: 0,
    payloadSummary: { inlineCount: inline.length, bodyFindingsCount: part.bodyFindings.length, bodyChars: body.length },
  };
  if (opts.dryRun) return result;
  // Inject the per-agent App token so the posted review is owned by the
  // matching bot identity (Task 8-3). The override never reaches process.env
  // and never reaches agent CLIs — only the gh subprocess sees it.
  const tokenEnv: Record<string, string> | undefined = opts.posterToken
    ? { GH_TOKEN: opts.posterToken, GITHUB_TOKEN: opts.posterToken }
    : undefined;
  const wrap = (fn: typeof ghJson) =>
    (p: string, o: GhJsonOpts = {}) =>
      fn(p, tokenEnv ? { ...o, envOverride: { ...(o.envOverride ?? {}), ...tokenEnv } } : o);
  const gh = wrap(opts.ghJsonFn ?? ghJson);
  // POST transport must NOT retry internally — the outer retry below re-checks
  // the marker before each retry to guarantee idempotency on 5xx. If both inner
  // (ghJson) and outer retried, a successful-but-unacknowledged POST could be
  // re-sent before the marker check ran, double-posting the review.
  const ghPost = wrap(opts.ghJsonOnceFn ?? opts.ghJsonFn ?? ghJsonOnce);
  const retry = opts.retryFn ?? withRetry;

  const checkMarker = async (): Promise<{ stopReason?: string } | void> => {
    try {
      const found = await findExistingMarker({
        repo: opts.repo, pr: opts.pr, marker, ghJsonFn: gh,
      });
      if (found) return { stopReason: "marker_found" };
    } catch { /* swallow — retry continues */ }
    return undefined;
  };

  // Wrap every POST with the retry policy. Between 5xx attempts we re-do the
  // marker GET to short-circuit on success (idempotency under double-post).
  const post = async (): Promise<void> => {
    const path_ = `/repos/${opts.repo}/pulls/${opts.pr}/reviews`;
    await retry(async () => {
      const payload = {
        commit_id: opts.prHeadSha,
        event: "COMMENT",
        body,
        comments: inline.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      };
      const r = await ghPost(path_, { method: "POST", body: payload });
      result.posted = true;
      if (r.data && typeof r.data === "object" && "id" in (r.data as object)) {
        const id = (r.data as { id?: unknown }).id;
        if (typeof id === "number") result.reviewId = id;
      }
      result.attempts.push({ inline: inline.length, status: "ok", httpStatus: r.status });
    }, { beforeRetry: checkMarker });
    if (!result.posted) {
      // beforeRetry returned stopReason — POST may have already landed on a
      // prior attempt; treat as success.
      result.posted = true;
      result.attempts.push({ inline: inline.length, status: "ok" });
    }
  };

  try {
    await post();
    return result;
  } catch (err) {
    if (!(err instanceof GhError)) {
      // Non-HTTP error from the retry wrapper — bubble.
      throw err;
    }
    if (err.status !== 422) {
      // Retry exhaustion on rate-limit / 5xx — surface as unposted, not throw.
      result.unposted = true;
      result.unpostedReason = `http_${err.status}: ${err.body.slice(0, 200)}`;
      result.attempts.push({ inline: inline.length, status: "ok", httpStatus: err.status });
      return result;
    }
    const indices = extract422Indices(err.body);
    if (indices.length > 0 && inline.length > 0) {
      const offenders = new Set(indices);
      const demote: Finding[] = [];
      const keep: InlineComment[] = [];
      for (let i = 0; i < inline.length; i++) {
        if (offenders.has(i)) {
          demote.push(demoteInlineToFinding(inline[i], opts.agent));
        } else {
          keep.push(inline[i]);
        }
      }
      inline = keep;
      body = buildReviewBody(marker, opts.humanSummary, [...part.bodyFindings, ...demote], {
        agentsResolved: opts.agentsResolved,
        postingAgentNote: opts.postingAgentNote,
      });
      result.fallbacksApplied++;
      result.attempts.push({ inline: inline.length + offenders.size, status: "fallback", httpStatus: 422 });
      try {
        await post();
        return result;
      } catch (err2) {
        if (!(err2 instanceof GhError)) throw err2;
        if (err2.status !== 422) {
          result.unposted = true;
          result.unpostedReason = `http_${err2.status}: ${err2.body.slice(0, 200)}`;
          return result;
        }
      }
    }
    inline = [];
    const allBody = [...part.bodyFindings];
    for (const c of part.inline) {
      allBody.push(demoteInlineToFinding(c, opts.agent));
    }
    body = buildReviewBody(marker, opts.humanSummary, allBody, {
      agentsResolved: opts.agentsResolved,
      postingAgentNote: opts.postingAgentNote,
    });
    result.fallbacksApplied++;
    result.attempts.push({ inline: 0, status: "body_only", httpStatus: 422 });
    try {
      await post();
    } catch (err3) {
      if (!(err3 instanceof GhError)) throw err3;
      result.unposted = true;
      result.unpostedReason = `http_${err3.status}: ${err3.body.slice(0, 200)}`;
    }
    return result;
  }
}

// ─── Task 4-8: retry policy ─────────────────────────────────────────────────

export interface RetryOpts {
  attempts?: number;
  backoffsMs?: number[];
  beforeRetry?: () => Promise<{ stopReason?: string } | void>;
  sleepFn?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFFS_MS = [1000, 4000, 16000];

function shouldRetry(err: unknown): boolean {
  if (!(err instanceof GhError)) return false;
  if (err.status === 429) return true;
  if (err.status === 403 && err.headers["x-ratelimit-remaining"] === "0") return true;
  if (err.status >= 500) return true;
  return false;
}

function retryAfterMs(err: GhError): number | null {
  const ra = err.headers["retry-after"];
  if (!ra) return null;
  const asNum = Number.parseInt(ra, 10);
  if (Number.isFinite(asNum) && /^\d+$/.test(ra.trim())) return asNum * 1000;
  const asDate = Date.parse(ra);
  if (Number.isFinite(asDate)) {
    const delta = asDate - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const total = (opts.attempts ?? backoffs.length + 1);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < total; attempt++) {
    if (attempt > 0) {
      const baseMs = backoffs[Math.min(attempt - 1, backoffs.length - 1)];
      let wait = baseMs;
      if (lastErr instanceof GhError) {
        const ra = retryAfterMs(lastErr);
        if (ra !== null) wait = ra;
      }
      await sleep(wait);
      if (opts.beforeRetry) {
        const r = await opts.beforeRetry();
        if (r && r.stopReason) {
          return undefined as unknown as T;
        }
      }
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!shouldRetry(err)) throw err;
    }
  }
  throw lastErr;
}

// ─── Task 4-9: per-PR idempotency lock + run hash ───────────────────────────

export interface RunHashInput {
  pr_head_sha: string;
  domains: string[];
  agents_resolved: Record<string, AgentName>;
  severity_overrides: Record<string, Severity>;
  fix_threshold: Severity;
}

export function computeRunHash(input: RunHashInput): string {
  const canonical = {
    pr_head_sha: input.pr_head_sha,
    domains: [...input.domains].sort(),
    agents_resolved: Object.fromEntries(
      Object.entries(input.agents_resolved).sort(([a], [b]) => a.localeCompare(b)),
    ),
    severity_overrides: Object.fromEntries(
      Object.entries(input.severity_overrides).sort(([a], [b]) => a.localeCompare(b)),
    ),
    fix_threshold: input.fix_threshold,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export interface AcquireLockOpts {
  home: string;
  repo: string;
  pr: number;
  lockTtlMinutes: number;
  waitMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface LockHandle {
  path: string;
  release: () => void;
  startHeartbeat: () => void;
  stopHeartbeat: () => void;
}

export class LockHeldError extends Error {
  code = "lock_held" as const;
}
export class LockIoError extends Error {
  code = "lock_io" as const;
}

export async function acquireLock(opts: AcquireLockOpts): Promise<LockHandle> {
  const lockDir = path.join(opts.home, ".claude", "code-review", "locks");
  fs.mkdirSync(lockDir, { recursive: true });
  const [org, repo] = opts.repo.split("/");
  const lockName = repo ? `${org}-${repo}-${opts.pr}.lock` : `${org}-${opts.pr}.lock`;
  const lockPath = path.join(lockDir, lockName);
  const sleep = opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const totalWaitMs = opts.waitMs ?? 30_000;
  const startTs = now();
  let fd: number | null = null;
  let reclaimed = false;

  while (true) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
      break;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EEXIST") {
        if (e.code === "EIO" || e.code === "ENOSPC" || e.code === "EROFS") {
          throw Object.assign(new LockIoError(`lock_io: ${e.code} on ${lockPath}`), { cause: e });
        }
        throw Object.assign(new LockIoError(`lock_io: ${e.message}`), { cause: e });
      }
      const meta = readLockFile(lockPath);
      const ttlMs = opts.lockTtlMinutes * 60 * 1000;
      const ageOk = !!meta && (now() - meta.mtimeMs) > ttlMs;
      const dead = !!meta && !pidAlive(meta.pid);
      if (!reclaimed && ageOk && dead) {
        try {
          fs.unlinkSync(lockPath);
          reclaimed = true;
          continue;
        } catch {
          /* fall through */
        }
      }
      if (now() - startTs >= totalWaitMs) {
        throw new LockHeldError(`lock_held: ${lockPath} (waited ${totalWaitMs}ms)`);
      }
      await sleep(500);
    }
  }
  fs.writeSync(fd, `${process.pid}\n${os.hostname()}\n`);

  let hbTimer: ReturnType<typeof setInterval> | null = null;
  const heartbeatMs = 5 * 60 * 1000;

  return {
    path: lockPath,
    release: () => {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* */ }
        fd = null;
      }
      try { fs.unlinkSync(lockPath); } catch { /* */ }
    },
    startHeartbeat: () => {
      if (hbTimer) return;
      hbTimer = setInterval(() => {
        try {
          const t = new Date();
          fs.utimesSync(lockPath, t, t);
        } catch { /* */ }
      }, heartbeatMs);
      if (typeof hbTimer === "object" && hbTimer && "unref" in hbTimer) {
        (hbTimer as { unref: () => void }).unref();
      }
    },
    stopHeartbeat: () => {
      if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    },
  };
}

/**
 * Look for an existing review on the PR whose body starts with the given marker.
 * Used to short-circuit POSTing when a previous run already completed.
 */
export async function findExistingMarker(opts: {
  repo: string;
  pr: number;
  marker: string;
  ghJsonFn?: typeof ghJson;
}): Promise<boolean> {
  const gh = opts.ghJsonFn ?? ghJson;
  const r = await gh(`/repos/${opts.repo}/pulls/${opts.pr}/reviews`);
  if (!Array.isArray(r.data)) return false;
  for (const rev of r.data) {
    if (typeof rev !== "object" || rev === null) continue;
    const body = (rev as { body?: unknown }).body;
    if (typeof body === "string" && body.startsWith(opts.marker)) return true;
  }
  return false;
}

// ─── Task 4-10: receipt + stderr summary ────────────────────────────────────

export interface ReceiptRound {
  round: number;
  findings: number;
  summary: { fix: number; noise: number; false_positive: number; ignored: number; unclassified: number; total: number };
  failed_results: Array<{ domain: string; agent: AgentName; error: string }>;
  parse_errors: ParseError[];
  classifier_errors: ClassifyEvent[];
  duration_ms: number;
}

export interface SuccessReceipt {
  ok: true;
  schema_version: 1;
  repo: string;
  pr: number;
  agent: AgentName | null;
  agents_resolved: Record<string, AgentName>;
  domains: string[];
  rounds: ReceiptRound[];
  fixes_pushed: number;
  comments_posted: number;
  unposted_reviews: Array<{ round: number; reason: string }>;
  history_files: string[];
}

export interface FailureReceipt {
  ok: false;
  schema_version: 1;
  repo: string;
  pr: number;
  error: { code: string; message: string; [k: string]: unknown };
  rounds: ReceiptRound[];
}

export type Receipt = SuccessReceipt | FailureReceipt;

export function renderHumanSummary(r: Receipt): string {
  const lines: string[] = [];
  if (r.ok) {
    lines.push(`stark-review: PR #${r.pr} (${r.repo}) — ok`);
    lines.push(`  domains: ${r.domains.join(", ") || "(none)"}`);
    lines.push(`  rounds: ${r.rounds.length}`);
    for (const rd of r.rounds) {
      lines.push(`    round ${rd.round}: ${rd.findings} findings (fix=${rd.summary.fix} noise=${rd.summary.noise} fp=${rd.summary.false_positive}) — ${rd.duration_ms}ms`);
      if (rd.failed_results.length > 0) {
        lines.push(`      failed: ${rd.failed_results.map((f) => `${f.agent}/${f.domain}`).join(", ")}`);
      }
      if (rd.parse_errors.length > 0) {
        lines.push(`      parse_errors: ${rd.parse_errors.length}`);
      }
    }
    lines.push(`  comments_posted: ${r.comments_posted}, fixes_pushed: ${r.fixes_pushed}`);
    if (r.unposted_reviews.length > 0) {
      lines.push(`  unposted: ${r.unposted_reviews.length}`);
    }
  } else {
    lines.push(`stark-review: PR #${r.pr} (${r.repo}) — FAILED`);
    lines.push(`  error.code: ${r.error.code}`);
    lines.push(`  error.message: ${r.error.message}`);
  }
  return lines.join("\n");
}

/**
 * Compute the final exit code per the spec:
 *   0 only when ok:true AND failed_results=[] AND parse_errors=[]
 *     AND unposted_reviews=[]
 *   1 partial (ok:true with failures, parse errors, or unposted) or terminal
 *     (ok:false)
 */
export function computeExitCode(r: Receipt): number {
  if (!r.ok) return 1;
  const anyFailed = r.rounds.some((rd) => rd.failed_results.length > 0);
  if (anyFailed) return 1;
  const anyParseErrors = r.rounds.some((rd) => rd.parse_errors.length > 0);
  if (anyParseErrors) return 1;
  if (r.unposted_reviews.length > 0) return 1;
  return 0;
}

/**
 * Emit receipt + summary per the --json contract:
 *   --json: receipt JSON to stdout, human summary to stderr
 *   no --json: both go to stderr, stdout empty
 */
export function emitReceipt(
  r: Receipt,
  json: boolean,
  streams?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream },
): void {
  const out = streams?.stdout ?? process.stdout;
  const err = streams?.stderr ?? process.stderr;
  const summary = renderHumanSummary(r);
  if (json) {
    out.write(JSON.stringify(r));
    err.write(summary + "\n");
  } else {
    err.write(JSON.stringify(r, null, 2) + "\n");
    err.write(summary + "\n");
  }
}

// ─── Phase 9: audit log (Task 9-6) ──────────────────────────────────────────

export type AuditAction = "commit" | "push" | "stage" | "post" | "skip" | "deny" | "test_pass" | "test_fail" | "fixer_run" | "fixer_parse_error";

export interface AuditEvent {
  ts: string;
  action: AuditAction;
  round: number;
  files?: string[];
  sha?: string;
  reason?: string;
  ref?: string;
  /** owner/name of the head repo for push events (NEVER the token). */
  head_repo?: string;
  [k: string]: unknown;
}

export interface AppendAuditOpts {
  home: string;
  repo: string;
  pr: number;
  /** Strings to redact from any audit value before writing. Used for token
   * values; the writer scrubs each provided substring with `***REDACTED***`. */
  redactInLogs?: string[];
}

export function auditLogPath(home: string, repo: string, pr: number): string {
  const parts = repo.split("/");
  const base = path.join(home, ".claude", "code-review", "audit");
  if (parts.length === 2) {
    return path.join(base, parts[0], parts[1], `${pr}.jsonl`);
  }
  return path.join(base, repo, `${pr}.jsonl`);
}

function redactValue(val: unknown, redactions: string[]): unknown {
  if (!redactions || redactions.length === 0) return val;
  if (typeof val === "string") {
    let out: string = val;
    for (const s of redactions) {
      if (s) out = out.split(s).join("***REDACTED***");
    }
    return out;
  }
  if (Array.isArray(val)) {
    return val.map((v) => redactValue(v, redactions));
  }
  if (val && typeof val === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      o[k] = redactValue(v, redactions);
    }
    return o;
  }
  return val;
}

export function appendAudit(event: Omit<AuditEvent, "ts"> & { ts?: string }, opts: AppendAuditOpts): void {
  const filePath = auditLogPath(opts.home, opts.repo, opts.pr);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const enriched: AuditEvent = { ts: event.ts ?? new Date().toISOString(), ...event } as AuditEvent;
  const redacted = redactValue(enriched, opts.redactInLogs ?? []);
  const fd = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_APPEND, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(redacted) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Phase 9: fixer prompt + serial exec (Task 9-2) ─────────────────────────

export interface FixerInput {
  findings: Array<Pick<Finding, "id" | "domain" | "agent" | "severity" | "file" | "line" | "title" | "body">>;
}

export interface FixerOutput {
  modified_files: string[];
  summary: string;
}

export class FixerParseError extends Error {
  code = "fixer_parse_error" as const;
}

/** Parse the fixer's stdout into the structured shape. Throws FixerParseError
 * on any deviation. The contract is strict: stdout (after trim) must be exactly
 * one JSON object with no surrounding prose. Framing chatter is rejected. */
export function parseFixerOutput(stdout: string): FixerOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new FixerParseError("fixer emitted no output");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new FixerParseError("fixer output not a single JSON object (no framing chatter allowed)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new FixerParseError("fixer output not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const mf = obj.modified_files;
  if (!Array.isArray(mf) || !mf.every((s) => typeof s === "string")) {
    throw new FixerParseError("fixer output: modified_files must be string[]");
  }
  const sum = obj.summary;
  if (typeof sum !== "string") {
    throw new FixerParseError("fixer output: summary must be string");
  }
  return { modified_files: mf, summary: sum };
}

export interface RunFixerOpts {
  worktree: string;
  findings: Finding[];
  fixerPromptPath: string;
  config: ResolvedConfig;
  spawnFn?: typeof spawnCollect;
  /** Codex model override (mostly for tests); production reads pin from config
   * elsewhere. */
  model?: string;
}

export interface RunFixerResult {
  output: FixerOutput;
  durationMs: number;
}

/** Run the codex-based fixer serially against the given findings. Builds the
 * structured input shape, runs codex with the allowlisted env (no tokens),
 * parses the output, and returns it. Throws FixerParseError on bad output. */
export async function runFixer(opts: RunFixerOpts): Promise<RunFixerResult> {
  const start = Date.now();
  const promptText = fs.readFileSync(opts.fixerPromptPath, "utf8");
  // Contract: stdin carries ONLY {findings:[...]}. The worktree path is passed
  // explicitly via codex's `-C/--cd` flag (a reviewed CLI mechanism) rather
  // than smuggled through the untrusted JSON payload. This keeps the
  // trusted/untrusted boundary clean: argv = trust, stdin = data.
  const inputJson: FixerInput = {
    findings: opts.findings.map((f) => ({
      id: f.id,
      domain: f.domain,
      agent: f.agent,
      severity: f.severity,
      file: f.file,
      line: f.line,
      title: f.title,
      body: f.body,
    })),
  };
  // Security boundary: pass the trusted prompt text as a positional CLI argument
  // (instructions), and the structured JSON as the ONLY stdin payload. Codex
  // appends piped stdin as a `<stdin>` block separate from the prompt arg, so
  // findings (which are PR-derived data) never get concatenated into the
  // instruction stream.
  const stdin = JSON.stringify(inputJson);
  const allowlist = opts.config.runtime?.subagent_env_allowlist ?? [];
  const tempPrefix = opts.config.runtime?.temp_dir_prefix ?? "stark-env";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-fixer-`));
  try {
    const env = pickAllowlistedEnv(process.env, allowlist);
    env.TMPDIR = tempDir;
    // The fixer runs in `opts.worktree` — a real PR checkout. Codex's
    // untrusted-directory guard applies and we deliberately do NOT pass
    // `--skip-git-repo-check` here (that flag is only safe for the agent
    // dispatcher's ephemeral temp cwds, never for a PR checkout that may
    // contain adversarial code from a fork). If a PR worktree isn't on
    // codex's trusted list, the operator is expected to either trust it
    // explicitly or run the fixer in a sandboxed temp checkout.
    const args = ["exec", "--json", "-c", `model_reasoning_effort="high"`, "-C", opts.worktree];
    if (opts.model) args.push("-m", opts.model);
    args.push(promptText);
    const sp = await (opts.spawnFn ?? spawnCollect)("codex", args, {
      input: stdin,
      env,
      cwd: opts.worktree,
    });
    if (sp.status !== 0) {
      throw new FixerParseError(`fixer exited ${sp.status}: ${sp.stderr.slice(0, 300)}`);
    }
    // Codex JSONL framing — extract ONLY the final assistant message. At
    // higher reasoning effort codex emits intermediate "agent_message" events
    // as reasoning preambles; concatenating them all (as normalizeOutput
    // does for finding parsing) would violate the fixer's single-JSON-object
    // output contract. We want the last message — the model's final answer.
    const codex = await import("./agent_codex.ts");
    const text = (codex as { extractLastAgentText?: (s: string) => string }).extractLastAgentText?.(sp.stdout) ?? sp.stdout;
    const output = parseFixerOutput(text);
    return { output, durationMs: Date.now() - start };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// ─── Phase 9: explicit-path staging (Task 9-3) ──────────────────────────────

// ─── Phase 9.5: fixer destructiveness guard ─────────────────────────────────
//
// Defense-in-depth against the fixer "deleting test fixtures to silence a
// finding" failure mode. The primary defense is the prompt
// (global/prompts/codex/fixer.md's minimal-edit discipline section); this is
// the structural backstop that runs even when the agent ignores the prompt.

export class FixerDestructiveError extends Error {
  code = "fixer_destructive" as const;
  violations: FixerDestructivenessViolation[];
  constructor(violations: FixerDestructivenessViolation[]) {
    super(
      `fixer produced destructive changes (${violations.length} file(s)): ` +
        violations.map((v) => `${v.path} (${v.reason})`).join("; "),
    );
    this.violations = violations;
  }
}

/** Per-file destructiveness verdict for one modified path. */
export interface FixerDiffStats {
  path: string;
  /** Lines added in the working-tree diff vs HEAD. -1 for binary. */
  added: number;
  /** Lines removed in the working-tree diff vs HEAD. -1 for binary. */
  removed: number;
  /** True if the path existed at HEAD but no longer exists in the worktree. */
  deletedEntirely: boolean;
  /** True if the path did not exist at HEAD (brand-new file). */
  isNew: boolean;
  /** True if `git diff --numstat` reported the file as binary. */
  binary: boolean;
}

export interface FixerDestructivenessViolation {
  path: string;
  reason: string;
}

/** Thresholds — picked conservatively so the common-case fixer edit passes,
 * and only the "delete everything" anti-pattern trips. */
export const FIXER_DELETE_LINES_HARD_CAP = 500;
export const FIXER_DELETE_DOMINANT_MIN = 100;
export const FIXER_DELETE_DOMINANT_RATIO = 3; // removed > ratio * added

/** Pure function: given the per-file diff stats and the fixer's summary text,
 * decide if the change is destructive enough to block. Returns the violations
 * (empty when the change is acceptable). */
export function assessFixerDestructiveness(
  stats: FixerDiffStats[],
  summary: string,
): FixerDestructivenessViolation[] {
  const violations: FixerDestructivenessViolation[] = [];
  const summaryLower = summary.toLowerCase();
  for (const s of stats) {
    if (s.binary) continue; // binary diffs have no line counts to reason about
    if (s.isNew) continue; // brand-new files cannot delete anything
    if (s.deletedEntirely) {
      // File removal is only acceptable if the summary explicitly names the
      // path. Cheap substring check — the fixer summary is single-paragraph,
      // adversarial-content here is the fixer's own output.
      if (!summary.includes(s.path)) {
        violations.push({ path: s.path, reason: "file deleted without summary justification" });
      }
      continue;
    }
    if (s.removed >= FIXER_DELETE_LINES_HARD_CAP) {
      // Hard cap, regardless of additions. 500+ removed lines is "rewrite a
      // small library," not "address a finding."
      if (!summaryLower.includes("delet") && !summaryLower.includes("remov")) {
        violations.push({
          path: s.path,
          reason: `${s.removed} lines deleted (cap ${FIXER_DELETE_LINES_HARD_CAP}); summary does not acknowledge`,
        });
      }
      continue;
    }
    if (
      s.removed >= FIXER_DELETE_DOMINANT_MIN &&
      s.removed > FIXER_DELETE_DOMINANT_RATIO * s.added
    ) {
      violations.push({
        path: s.path,
        reason: `deletion-dominant: -${s.removed} / +${s.added} (ratio > ${FIXER_DELETE_DOMINANT_RATIO}, min ${FIXER_DELETE_DOMINANT_MIN})`,
      });
    }
  }
  return violations;
}

export interface CheckFixerDestructivenessOpts {
  worktree: string;
  paths: string[];
  summary: string;
  spawnFn?: typeof spawnCollect;
}

/** Gather working-tree diff stats for the fixer's modified files and apply
 * assessFixerDestructiveness. Throws FixerDestructiveError on violation. */
export async function checkFixerDestructiveness(opts: CheckFixerDestructivenessOpts): Promise<void> {
  if (opts.paths.length === 0) return;
  const spawn = opts.spawnFn ?? spawnCollect;
  // git diff --numstat HEAD -- <paths> covers staged+unstaged plus new files.
  // Output format per line: "<added>\t<removed>\t<path>" or "-\t-\t<path>" for binary.
  const numstat = await spawn("git", ["-C", opts.worktree, "diff", "--numstat", "HEAD", "--", ...opts.paths], {
    env: process.env,
  });
  if (numstat.status !== 0) {
    // Don't block on a git failure — surface to caller via a thrown Error
    // with a distinct (non-FixerDestructiveError) shape so the dispatcher's
    // audit log records it as a generic skip rather than a destruction abort.
    throw new Error(`fixer destructiveness check: git diff --numstat exit ${numstat.status}: ${numstat.stderr.slice(0, 200)}`);
  }
  // Pre-existence check via ls-tree (file path WAS in HEAD?).
  const lsTree = await spawn("git", ["-C", opts.worktree, "ls-tree", "-r", "--name-only", "HEAD", "--", ...opts.paths], {
    env: process.env,
  });
  const existedAtHead = new Set<string>();
  if (lsTree.status === 0) {
    for (const line of lsTree.stdout.split("\n")) {
      const t = line.trim();
      if (t) existedAtHead.add(t);
    }
  }
  const stats: FixerDiffStats[] = [];
  const sawInDiff = new Set<string>();
  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [a, r, ...rest] = line.split("\t");
    const p = rest.join("\t");
    if (!p) continue;
    sawInDiff.add(p);
    const binary = a === "-" && r === "-";
    const added = binary ? -1 : Number.parseInt(a ?? "0", 10) || 0;
    const removed = binary ? -1 : Number.parseInt(r ?? "0", 10) || 0;
    const isNew = !existedAtHead.has(p);
    // git diff lists pure deletions with --numstat too — to know if the file
    // is "deleted entirely" we check that it existed at HEAD AND no longer
    // exists in the worktree.
    const deletedEntirely = existedAtHead.has(p) && !fs.existsSync(path.join(opts.worktree, p));
    stats.push({ path: p, added, removed, deletedEntirely, isNew, binary });
  }
  // Also capture paths the fixer listed that produced no diff (no-op edit or
  // pure deletion that ls-tree captured but numstat skipped) — for the
  // deletion case, synthesize a stat row so the deletedEntirely branch fires.
  for (const p of opts.paths) {
    if (sawInDiff.has(p)) continue;
    if (existedAtHead.has(p) && !fs.existsSync(path.join(opts.worktree, p))) {
      stats.push({ path: p, added: 0, removed: 0, deletedEntirely: true, isNew: false, binary: false });
    }
  }
  const violations = assessFixerDestructiveness(stats, opts.summary);
  if (violations.length > 0) throw new FixerDestructiveError(violations);
}

export interface StageFilesOpts {
  worktree: string;
  paths: string[];
  spawnFn?: typeof spawnCollect;
}

/** Validate paths and `git add --` only those paths. NEVER `git add -A`. */
export async function stageFiles(opts: StageFilesOpts): Promise<{ staged: string[] }> {
  const cleaned = validateStagePaths(opts.worktree, opts.paths);
  if (cleaned.length === 0) return { staged: [] };
  const sp = await (opts.spawnFn ?? spawnCollect)(
    "git",
    ["-C", opts.worktree, "add", "--", ...cleaned],
    { env: process.env },
  );
  if (sp.status !== 0) {
    throw new Error(`git add failed (${sp.status}): ${sp.stderr.slice(0, 300)}`);
  }
  return { staged: cleaned };
}

// ─── Phase 9: trusted test runner (Task 9-5) ────────────────────────────────

export interface RunTrustedTestOpts {
  worktree: string;
  testCommand: string;
  config: ResolvedConfig;
  spawnFn?: typeof spawnCollect;
}

export interface RunTrustedTestResult {
  ok: boolean;
  exitCode: number;
  stderr: string;
}

const TRUSTED_TEST_FORBIDDEN = new Set(["GH_TOKEN", "GITHUB_TOKEN", "STARK_PUSH_TOKEN"]);

export function buildTrustedTestEnv(
  source: NodeJS.ProcessEnv,
  config: ResolvedConfig,
): Record<string, string> {
  const allowlist = config.runtime?.test_env_allowlist ?? DEFAULT_TEST_ENV_ALLOWLIST;
  const out: Record<string, string> = {};
  for (const k of allowlist) {
    if (TRUSTED_TEST_FORBIDDEN.has(k)) continue;
    const v = source[k];
    if (typeof v === "string") out[k] = v;
  }
  for (const k of TRUSTED_TEST_FORBIDDEN) delete out[k];
  return out;
}

/**
 * Run config.test_command in the worktree using the trusted test env allowlist.
 * The command MUST come from trusted config (the caller is responsible) — this
 * function never reads a test command from the worktree.
 */
export async function runTrustedTest(opts: RunTrustedTestOpts): Promise<RunTrustedTestResult> {
  const env = buildTrustedTestEnv(process.env, opts.config);
  const sp = await (opts.spawnFn ?? spawnCollect)(
    "/bin/sh",
    ["-c", opts.testCommand],
    { env, cwd: opts.worktree },
  );
  return { ok: sp.status === 0, exitCode: sp.status, stderr: sp.stderr };
}

// ─── Phase 9: push target + GIT_ASKPASS (Task 9-4) ──────────────────────────

export interface PushTarget {
  /** When 'origin', push to the origin remote of the worktree (same-repo PR).
   * When 'fork', set up a temporary 'stark-fork-push' remote with GIT_ASKPASS
   * so the push is authenticated without leaking the token via URL/argv. */
  kind: "origin" | "fork";
  /** head ref (branch name) — what we push HEAD to. */
  ref: string;
  /** owner/name of the head repo, recorded in the audit log only. */
  fullName: string;
  /** clone URL (no embedded credentials) for fork pushes. */
  cloneUrl?: string;
}

export interface ResolvePushTargetInput {
  prHeadIsFork: boolean;
  prHeadRef: string;
  prHeadRepoFullName: string;
  prHeadCloneUrl: string;
  maintainerCanModify: boolean;
}

export class PushTargetUnauthorizedError extends Error {
  code = "push_unauthorized" as const;
}

/** Pure helper: decide whether to push via origin or via a fork remote. Rejects
 * fork PRs without `maintainer_can_modify`: V1.1 only implements push for
 * fork-with-MCM (App-token push via GIT_ASKPASS works because MCM grants the
 * upstream maintainer push access to the fork branch). No untrusted-fork push
 * credential path is implemented, so even if the fix-loop gate authorizes the
 * round, we refuse to push. */
export function resolvePushTarget(input: ResolvePushTargetInput): PushTarget {
  if (!input.prHeadIsFork) {
    return { kind: "origin", ref: input.prHeadRef, fullName: input.prHeadRepoFullName };
  }
  if (!input.maintainerCanModify) {
    throw new PushTargetUnauthorizedError(
      "fork PR without maintainer_can_modify: no push credential path implemented",
    );
  }
  return {
    kind: "fork",
    ref: input.prHeadRef,
    fullName: input.prHeadRepoFullName,
    cloneUrl: input.prHeadCloneUrl,
  };
}

const FORK_PUSH_REMOTE = "stark-fork-push";

/** Best-effort cleanup of a stale `stark-fork-push` remote from a prior crashed
 * run. Called once after the per-PR review lock is acquired. */
export async function cleanupStaleForkRemote(
  worktree: string,
  spawnFn: typeof spawnCollect = spawnCollect,
): Promise<void> {
  try {
    const sp = await spawnFn("git", ["-C", worktree, "remote"], { env: process.env });
    if (sp.status !== 0) return;
    if (!sp.stdout.split(/\r?\n/).some((l) => l.trim() === FORK_PUSH_REMOTE)) return;
    await spawnFn("git", ["-C", worktree, "remote", "remove", FORK_PUSH_REMOTE], { env: process.env });
  } catch { /* best-effort */ }
}

export interface PushOpts {
  worktree: string;
  target: PushTarget;
  /** GH App installation token. Authenticates both origin and fork pushes via
   * GIT_ASKPASS; NEVER embedded in a URL or argv. When omitted, the origin
   * push falls back to ambient git credentials (test / non-token callers). */
  token?: string;
  spawnFn?: typeof spawnCollect;
}

export interface PushResult {
  ok: boolean;
  conflict: boolean;
  stderr: string;
}

/** Write a one-shot GIT_ASKPASS helper that echoes $STARK_PUSH_TOKEN, so the
 * token reaches git via env + a 0700 temp file — never argv or a remote URL.
 * Returns the script path and a cleanup fn. */
function makeAskpass(): { askpath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-askpass-"));
  const askpath = path.join(dir, "askpass.sh");
  fs.writeFileSync(askpath, '#!/bin/sh\nprintf "%s" "$STARK_PUSH_TOKEN"\n', { mode: 0o700 });
  fs.chmodSync(askpath, 0o700);
  return {
    askpath,
    cleanup: () => {
      try { fs.unlinkSync(askpath); } catch { /* */ }
      try { fs.rmdirSync(dir); } catch { /* */ }
    },
  };
}

/** Execute the push. Never `--force`.
 *  - origin (same-repo) with a token: push over `origin` with the token fed
 *    via GIT_ASKPASS and ambient credential helpers disabled (`-c
 *    credential.helper=`), so neither a stale keychain entry nor an expired
 *    `gh`/`GH_TOKEN` credential can shadow the freshly minted token.
 *  - origin without a token: bare `git push origin` on ambient credentials.
 *  - fork-with-MCM: add a temporary `stark-fork-push` remote, push via the
 *    same GIT_ASKPASS path, then remove the remote. */
export async function pushBranch(opts: PushOpts): Promise<PushResult> {
  const spawn = opts.spawnFn ?? spawnCollect;
  if (opts.target.kind === "origin") {
    // No token: legacy / test path — rely on ambient git credentials.
    if (!opts.token) {
      const sp = await spawn(
        "git",
        ["-C", opts.worktree, "push", "origin", `HEAD:${opts.target.ref}`],
        { env: process.env },
      );
      return analyzePushResult(sp);
    }
    const { askpath, cleanup } = makeAskpass();
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_ASKPASS: askpath,
        GIT_TERMINAL_PROMPT: "0",
        STARK_PUSH_TOKEN: opts.token,
      };
      const sp = await spawn(
        "git",
        ["-C", opts.worktree, "-c", "credential.helper=", "push", "origin", `HEAD:${opts.target.ref}`],
        { env },
      );
      return analyzePushResult(sp);
    } finally {
      cleanup();
    }
  }
  // Fork push via askpass.
  if (!opts.token) {
    return { ok: false, conflict: false, stderr: "fork push requires token" };
  }
  if (!opts.target.cloneUrl) {
    return { ok: false, conflict: false, stderr: "fork push requires cloneUrl" };
  }
  const { askpath, cleanup } = makeAskpass();
  try {
    // Add the fork remote (no embedded credentials in URL).
    const addSp = await spawn(
      "git",
      ["-C", opts.worktree, "remote", "add", FORK_PUSH_REMOTE, opts.target.cloneUrl],
      { env: process.env },
    );
    if (addSp.status !== 0) {
      return { ok: false, conflict: false, stderr: `remote add failed: ${addSp.stderr.slice(0, 300)}` };
    }
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_ASKPASS: askpath,
        GIT_TERMINAL_PROMPT: "0",
        STARK_PUSH_TOKEN: opts.token,
      };
      const sp = await spawn(
        "git",
        ["-C", opts.worktree, "-c", "credential.helper=", "push", FORK_PUSH_REMOTE, `HEAD:${opts.target.ref}`],
        { env },
      );
      return analyzePushResult(sp);
    } finally {
      try {
        await spawn("git", ["-C", opts.worktree, "remote", "remove", FORK_PUSH_REMOTE], { env: process.env });
      } catch { /* */ }
    }
  } finally {
    cleanup();
  }
}

function analyzePushResult(sp: SpawnResult): PushResult {
  if (sp.status === 0) return { ok: true, conflict: false, stderr: sp.stderr };
  const conflict = /non-fast-forward|rejected|fetch first|stale info/i.test(sp.stderr);
  return { ok: false, conflict, stderr: sp.stderr };
}

// Re-exports for tests / dispatcher consumers
export {
  buildMarker,
  evaluateFixLoopGate,
  loadTrustedConfig,
  resolveBaseRef,
  resolvePromptRoot,
  selectDomains,
  resolveAgentsForDomains,
  renderReviewPrompt,
  resolvePromptSources,
  resolveClassifierPrompt,
  validateStagePaths,
  PathRejectedError,
};

// ─── CLI orchestration ──────────────────────────────────────────────────────

/**
 * End-to-end dispatcher pipeline. Wires every Phase-4 helper together:
 *  1. parseCli
 *  2. loadTrustedConfig + selectDomains + resolveAgentsForDomains
 *  3. acquireLock (per-PR, with heartbeat)
 *  4. compute runHash; short-circuit on existing marker
 *  5. dispatchDomains + applySeverityOverrides + classify tier
 *  6. runClassifier
 *  7. allocateAndWriteRoundHistory inside the held lock
 *  8. postReview (skipped on classifier abort or dry-run)
 *  9. pruneHistory (best-effort)
 * 10. emitReceipt + computeExitCode
 *
 * Returns the receipt and the exit code. Releases the per-PR lock in a
 * try/finally. Failure modes surface as either ok:false receipts (terminal)
 * or ok:true with non-empty failed_results / unposted_reviews (partial).
 */
/**
 * Injection points for tests. Production callers omit `deps` and the bare
 * top-level transports are used. Tests pass fakes here to drive main() under
 * a fake clock/transport (e.g. lock-ordering coverage in the dispatcher
 * suite — see tools/stark_review.phase6.test.ts).
 */
export interface MainDeps {
  ghJsonFn?: typeof ghJson;
  ghTextFn?: typeof ghText;
  ghJsonOnceFn?: typeof ghJsonOnce;
  spawnFn?: typeof spawnCollect;
}

export async function main(
  argv: string[],
  deps: MainDeps = {},
): Promise<{ receipt: Receipt; exitCode: number }> {
  const mainStart = Date.now();
  const ghJsonD = deps.ghJsonFn ?? ghJson;
  const ghTextD = deps.ghTextFn ?? ghText;
  const ghJsonOnceD = deps.ghJsonOnceFn ?? ghJsonOnce;
  const spawnD = deps.spawnFn;
  const parsed = parseCli(argv);
  for (const w of parsed.warnings) process.stderr.write(`warning: ${w}\n`);
  if (parsed.helpRequested) {
    process.stdout.write(HELP_TEXT);
    return { receipt: terminalReceipt("o/r", 0, "help", "help requested"), exitCode: 0 };
  }
  if (parsed.errors.length > 0 || !parsed.config) {
    for (const e of parsed.errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write(HELP_TEXT);
    return { receipt: terminalReceipt("o/r", 0, "bad_args", parsed.errors.join("; ")), exitCode: 1 };
  }
  let cli = parsed.config;
  const repo = cli.repo;
  const pr = cli.pr;
  const resolvedBase = resolveBaseRef(cli.base, cli.worktree);
  if (resolvedBase !== cli.base) {
    progress(`resolved base ${cli.base} -> ${resolvedBase}`);
    cli = { ...cli, base: resolvedBase };
  }

  let config: ResolvedConfig;
  try {
    config = loadTrustedConfig({
      home: os.homedir(),
      configRoot: cli.configRoot,
      baseRef: cli.base,
      worktree: cli.worktree,
    });
  } catch (err) {
    return finalizeFailure(repo, pr, "config_load_failed", (err as Error).message, cli.json);
  }

  if (!cli.maxRoundsExplicit && typeof config.max_rounds === "number") {
    const n = config.max_rounds;
    if (!Number.isInteger(n) || n <= 0) {
      return finalizeFailure(
        repo, pr, "config_load_failed",
        `config.max_rounds must be a positive integer (got ${JSON.stringify(n)})`,
        cli.json,
      );
    }
    if (n > MAX_ROUNDS_CEILING) {
      return finalizeFailure(
        repo, pr, "config_load_failed",
        `config.max_rounds=${n} exceeds sane ceiling of ${MAX_ROUNDS_CEILING}; fix loops are bounded to prevent runaway sessions`,
        cli.json,
      );
    }
    cli = { ...cli, maxRounds: n };
  }

  const promptRoot = resolvePromptRoot({ configRoot: cli.configRoot, home: os.homedir() });
  let domains: string[];
  try {
    const mode = cli.domains ? "explicit" : cli.quick ? "quick" : "default";
    domains = selectDomains({
      mode,
      explicitDomains: cli.domains ?? undefined,
      config,
      promptRoot,
      agentResolver: (d) => cli.agent ?? config.domain_agents?.[d] ?? config.default_agent ?? "codex",
    });
    if (domains.length === 0) {
      throw new Error(
        `selectDomains: no review domains selected (prompt root ${promptRoot})`,
      );
    }
  } catch (err) {
    return finalizeFailure(repo, pr, "domain_selection_failed", (err as Error).message, cli.json);
  }
  const agentsResolved = resolveAgentsForDomains({
    domains, forcedAgent: cli.agent, config,
  });

  const lockHandle = await tryAcquireLock(repo, pr, config);
  if ("error" in lockHandle) {
    return finalizeFailure(repo, pr, lockHandle.error.code, lockHandle.error.message, cli.json);
  }
  const lock = lockHandle.handle;
  lock.startHeartbeat();

  // ── Phase 9: clean up any stale fork-push remote from a prior crashed run.
  try { await cleanupStaleForkRemote(cli.worktree); } catch { /* best-effort */ }

  const unposted: Array<{ round: number; reason: string }> = [];
  const historyFiles: string[] = [];
  const receiptRounds: ReceiptRound[] = [];
  const home = os.homedir();
  let commentsPosted = 0;
  let fixesPushed = 0;

  // Round-invariant inputs for runReviewPass.
  const passDeps: PassDeps = { ghJsonFn: ghJsonD, ghTextFn: ghTextD, ghJsonOnceFn: ghJsonOnceD };
  if (spawnD) passDeps.spawnFn = spawnD;
  const passCtx: PassCtx = {
    cli, config, repo, pr, domains, agentsResolved, promptRoot, home,
  };

  try {
    let lastPass: PassResult | null = null;
    let terminalCode: { code: string; message: string } | null = null;

    for (let round = 1; round <= cli.maxRounds; round++) {
      // Re-issue GH App tokens at the start of each round (~1h lifetime).
      if (round > 1) _resetTokenCacheForTests();

      const pass = await runReviewPass(passCtx, passDeps);
      lastPass = pass;
      if (pass.kind === "terminal") {
        terminalCode = { code: pass.code, message: pass.message };
        if (pass.partial) {
          receiptRounds.push(pass.partial);
          if (pass.historyPath) historyFiles.push(pass.historyPath);
        }
        break;
      }
      receiptRounds.push(buildRound(
        pass.round, pass.allFindings, pass.failedResults, pass.parseErrors,
        pass.classifierEvents, pass.durationMs,
      ));
      historyFiles.push(pass.historyPath);
      commentsPosted += pass.commentsPosted;
      if (pass.unpostedReason) unposted.push({ round: pass.round, reason: pass.unpostedReason });
      if (pass.classifierAborted) {
        terminalCode = { code: "classifier_aborted", message: "classifier aborted after 5 errors; POST skipped" };
        break;
      }

      // ── Fix-loop authorization gate (Phase 9 task 1) ─────────────────────
      const gate = evaluateFixLoopGate({
        testCommand: config.test_command ?? null,
        prHeadIsFork: pass.prHeadIsFork,
        maintainerCanModify: pass.maintainerCanModify,
        cliAllowUntrustedFixLoop: cli.allowUntrustedFixLoop,
        configUntrustedFixLoop: !!config.untrusted_fix_loop,
        noFixLoop: cli.noFixLoop,
        allowNoTestCommand: !!config.allow_no_test_command,
      });
      if (!gate.allow) {
        appendAudit({ action: "deny", round: pass.round, reason: gate.reason }, { home, repo, pr });
        if (gate.terminal) {
          terminalCode = { code: "auth_denied", message: `fix loop authorization denied: ${gate.reason}` };
        }
        break;
      }
      // The final round runs the fix step too — `maxRounds` bounds review+fix
      // cycles, not reviews. Every round that finds fixable findings attempts a
      // fix; the trusted test_command (below) is the per-round verification gate
      // instead of relying on a subsequent review round to confirm the fix.

      const fixCandidates = pass.allFindings.filter(
        (f) => f.classification === "fix" && severityMeetsThreshold(f.severity, config.fix_threshold),
      );
      if (fixCandidates.length === 0) {
        appendAudit({ action: "skip", round: pass.round, reason: "no_fix_candidates" }, { home, repo, pr });
        break;
      }

      // Resolve and validate push target BEFORE mutating the worktree. If
      // there's no implemented push path (e.g. fork-PR-without-MCM even when
      // both opt-ins are true), bail terminally before the fixer touches any
      // files. This keeps a worktree from being left with a local commit for
      // a flow that cannot push.
      let pushTarget: PushTarget;
      try {
        pushTarget = resolvePushTarget({
          prHeadIsFork: pass.prHeadIsFork,
          prHeadRef: pass.prHeadRef,
          prHeadRepoFullName: pass.prHeadRepoFullName,
          prHeadCloneUrl: pass.prHeadCloneUrl,
          maintainerCanModify: pass.maintainerCanModify,
        });
      } catch (err) {
        const reason = err instanceof PushTargetUnauthorizedError ? err.message : (err as Error).message;
        appendAudit({ action: "deny", round: pass.round, reason: `push_unauthorized: ${reason}` }, { home, repo, pr });
        terminalCode = { code: "push_unauthorized", message: reason };
        break;
      }

      // ── Phase 9 fix-loop step (after each round's review POST) ──────────
      const fixerPromptPath = path.join(promptRoot, "codex", "fixer.md");
      let fixerOutput: FixerOutput;
      try {
        const fr = await runFixer({
          worktree: cli.worktree,
          findings: fixCandidates,
          fixerPromptPath,
          config,
          ...(spawnD ? { spawnFn: spawnD } : {}),
        });
        fixerOutput = fr.output;
        appendAudit({ action: "fixer_run", round: pass.round, files: fixerOutput.modified_files, reason: fixerOutput.summary.slice(0, 240) }, { home, repo, pr });
      } catch (err) {
        const reason = err instanceof FixerParseError ? err.message : (err as Error).message;
        appendAudit({ action: "skip", round: pass.round, reason: `fixer_parse_error: ${reason}` }, { home, repo, pr });
        terminalCode = { code: "fixer_parse_error", message: reason };
        break;
      }
      if (fixerOutput.modified_files.length === 0) {
        appendAudit({ action: "skip", round: pass.round, reason: "fixer_no_changes" }, { home, repo, pr });
        break;
      }

      // Destructiveness guard (Phase 9.5). Backstops the fixer prompt's
      // minimal-edit discipline by inspecting the working-tree diff before
      // staging. Trips on file deletions without summary justification,
      // single-file deletions ≥ 500 lines without acknowledgement, or
      // deletion-dominant changes (≥100 lines, removed > 3 × added).
      try {
        await checkFixerDestructiveness({
          worktree: cli.worktree,
          paths: fixerOutput.modified_files,
          summary: fixerOutput.summary,
          ...(spawnD ? { spawnFn: spawnD } : {}),
        });
      } catch (err) {
        if (err instanceof FixerDestructiveError) {
          const reason = `fixer_destructive: ${err.violations.map((v) => `${v.path} (${v.reason})`).join("; ")}`;
          appendAudit({ action: "deny", round: pass.round, reason }, { home, repo, pr });
          terminalCode = { code: "fixer_destructive", message: err.message };
          break;
        }
        // Non-violation error (e.g. git command failure) — treat as a soft
        // skip so the loop bails without claiming the change was destructive.
        const reason = `fixer_destructiveness_check_error: ${(err as Error).message}`;
        appendAudit({ action: "skip", round: pass.round, reason }, { home, repo, pr });
        terminalCode = { code: "fixer_destructiveness_check_error", message: (err as Error).message };
        break;
      }

      // Validate + stage
      let stagedPaths: string[];
      try {
        const r = await stageFiles({
          worktree: cli.worktree,
          paths: fixerOutput.modified_files,
          ...(spawnD ? { spawnFn: spawnD } : {}),
        });
        stagedPaths = r.staged;
        appendAudit({ action: "stage", round: pass.round, files: stagedPaths }, { home, repo, pr });
      } catch (err) {
        const reason = err instanceof PathRejectedError ? err.message : (err as Error).message;
        appendAudit({ action: "deny", round: pass.round, reason: `path_rejected: ${reason}` }, { home, repo, pr });
        terminalCode = { code: "path_rejected", message: reason };
        break;
      }

      // Trusted test — skip when no test_command is configured AND the gate
      // explicitly allowed the loop via allow_no_test_command. The gate is the
      // sole authority on whether that opt-in is set; if we reach here with an
      // empty command, the operator has accepted unverified autofixes.
      const tcRaw = config.test_command ?? null;
      const tcEmpty = tcRaw === null || (typeof tcRaw === "string" && tcRaw.trim() === "");
      if (tcEmpty) {
        appendAudit({ action: "test_skipped", round: pass.round, reason: "no_test_command_allowed" }, { home, repo, pr });
      } else {
        const testRes = await runTrustedTest({
          worktree: cli.worktree,
          testCommand: tcRaw as string,
          config,
          ...(spawnD ? { spawnFn: spawnD } : {}),
        });
        if (!testRes.ok) {
          appendAudit({ action: "test_fail", round: pass.round, reason: `exit ${testRes.exitCode}` }, { home, repo, pr });
          terminalCode = { code: "test_failure", message: `tests failed (exit ${testRes.exitCode})` };
          break;
        }
        appendAudit({ action: "test_pass", round: pass.round }, { home, repo, pr });
      }

      // Commit
      const commitMsg = `fix: address review findings (round ${pass.round})`;
      const commitSp = await (spawnD ?? spawnCollect)("git", [
        "-C", cli.worktree, "commit", "-m", commitMsg,
      ], { env: process.env });
      if (commitSp.status !== 0) {
        const reason = commitSp.stderr.slice(0, 300);
        appendAudit({ action: "skip", round: pass.round, reason: `commit_failed: ${reason}` }, { home, repo, pr });
        terminalCode = { code: "commit_failed", message: reason };
        break;
      }
      // Capture the new SHA for the audit log.
      const shaSp = await (spawnD ?? spawnCollect)("git", ["-C", cli.worktree, "rev-parse", "HEAD"], { env: process.env });
      const newSha = shaSp.status === 0 ? shaSp.stdout.trim() : "";
      appendAudit({ action: "commit", round: pass.round, sha: newSha, files: stagedPaths }, { home, repo, pr });

      // Push. Mint a FRESH GH App token immediately before pushing — a single
      // review round can outlast the ~1h installation-token lifetime, so a
      // round-start token may already be expired. forceRefresh re-mints, and
      // pushBranch authenticates origin and fork pushes alike via GIT_ASKPASS.
      // pushTarget was resolved up-front (before the fixer ran).
      let pushToken: string;
      try {
        pushToken = await tokenForAgent(pass.postingAgent, {
          repo,
          forceRefresh: true,
          ...(spawnD ? { spawnFn: spawnD } : {}),
        });
      } catch (err) {
        const reason = (err as Error).message;
        appendAudit({ action: "skip", round: pass.round, reason: `push_token_failed: ${reason}` }, { home, repo, pr });
        terminalCode = { code: "push_token_failed", message: reason };
        break;
      }
      const pushRes = await pushBranch({
        worktree: cli.worktree,
        target: pushTarget,
        token: pushToken,
        ...(spawnD ? { spawnFn: spawnD } : {}),
      });
      const auditOpts: AppendAuditOpts = { home, repo, pr, redactInLogs: [pushToken] };
      if (!pushRes.ok) {
        appendAudit({
          action: "skip", round: pass.round,
          reason: pushRes.conflict ? "push_conflict" : `push_failed: ${pushRes.stderr.slice(0, 240)}`,
          head_repo: pushTarget.fullName, ref: pushTarget.ref,
        }, auditOpts);
        terminalCode = {
          code: pushRes.conflict ? "push_conflict" : "push_failed",
          message: pushRes.stderr.slice(0, 300) || "push failed",
        };
        break;
      }
      appendAudit({
        action: "push", round: pass.round, sha: newSha,
        head_repo: pushTarget.fullName, ref: pushTarget.ref,
      }, auditOpts);
      fixesPushed += stagedPaths.length;
    }

    // ── Best-effort prune (separate lock) ──────────────────────────────────
    try {
      pruneHistory({
        home,
        retentionDays: config.history_retention_days ?? 0,
        lockTtlMinutes: config.runtime?.lock_ttl_minutes ?? config.lock_ttl_minutes ?? 30,
      });
    } catch { /* best-effort */ }

    if (terminalCode) {
      const r: FailureReceipt = {
        ok: false, schema_version: 1, repo, pr,
        error: { code: terminalCode.code, message: terminalCode.message },
        rounds: receiptRounds,
      };
      emitReceipt(r, cli.json);
      progress(`done  fail=${terminalCode.code}  ${fmtDuration(Date.now() - mainStart)}`);
      return { receipt: r, exitCode: 1 };
    }

    const receipt: SuccessReceipt = {
      ok: true, schema_version: 1, repo, pr,
      agent: cli.agent, agents_resolved: agentsResolved, domains,
      rounds: receiptRounds,
      fixes_pushed: fixesPushed,
      comments_posted: commentsPosted,
      unposted_reviews: unposted,
      history_files: historyFiles,
    };
    if (lastPass && lastPass.kind === "ok") {
      // commentsPosted included; nothing else to merge.
    }
    emitReceipt(receipt, cli.json);
    progress(`done  posted=${commentsPosted}  fixes_pushed=${fixesPushed}  ${fmtDuration(Date.now() - mainStart)}`);
    return { receipt, exitCode: computeExitCode(receipt) };
  } finally {
    try { lock.release(); } catch { /* */ }
  }
}

// ─── Per-round pipeline pass (extracted from main for fix-loop) ─────────────

interface PassCtx {
  cli: CliConfig;
  config: ResolvedConfig;
  repo: string;
  pr: number;
  domains: string[];
  agentsResolved: Record<string, AgentName>;
  promptRoot: string;
  home: string;
}

interface PassDeps {
  ghJsonFn: typeof ghJson;
  ghTextFn: typeof ghText;
  ghJsonOnceFn: typeof ghJsonOnce;
  spawnFn?: typeof spawnCollect;
}

type PassResult =
  | {
      kind: "ok";
      round: number;
      historyPath: string;
      allFindings: Finding[];
      failedResults: Array<{ domain: string; agent: AgentName; error: string }>;
      parseErrors: ParseError[];
      classifierEvents: ClassifyEvent[];
      classifierAborted: boolean;
      durationMs: number;
      commentsPosted: number;
      unpostedReason?: string;
      postingAgent: AgentName;
      prHeadSha: string;
      prHeadIsFork: boolean;
      prHeadRef: string;
      prHeadRepoFullName: string;
      prHeadCloneUrl: string;
      maintainerCanModify: boolean;
    }
  | { kind: "terminal"; code: string; message: string; partial?: ReceiptRound; historyPath?: string };

async function runReviewPass(ctx: PassCtx, deps: PassDeps): Promise<PassResult> {
  const { cli, config, repo, pr, domains, agentsResolved, promptRoot, home } = ctx;
  const start = Date.now();
  const failedResults: Array<{ domain: string; agent: AgentName; error: string }> = [];
  const parseErrors: ParseError[] = [];
  const classifierEvents: ClassifyEvent[] = [];

  // PR metadata
  let prHeadSha = "";
  let prTitle = "";
  let prBody = "";
  let prDiff = "";
  let prHeadIsFork = false;
  let prHeadRef = "";
  let prHeadRepoFullName = "";
  let prHeadCloneUrl = "";
  let maintainerCanModify = false;
  const changedFiles = new Set<string>();
  try {
    const meta = await deps.ghJsonFn(`/repos/${repo}/pulls/${pr}`);
    const m = meta.data as Record<string, unknown>;
    const head = (m?.head as Record<string, unknown> | undefined) ?? {};
    prHeadSha = (head.sha as string | undefined) ?? "";
    prHeadRef = (head.ref as string | undefined) ?? "";
    const headRepo = (head.repo as Record<string, unknown> | undefined) ?? {};
    prHeadIsFork = headRepo.fork === true;
    prHeadRepoFullName = (headRepo.full_name as string | undefined) ?? "";
    prHeadCloneUrl = (headRepo.clone_url as string | undefined) ?? "";
    maintainerCanModify = (m?.maintainer_can_modify as boolean | undefined) === true;
    prTitle = (m?.title as string) ?? "";
    prBody = (m?.body as string) ?? "";
    const filesRes = await deps.ghJsonFn(`/repos/${repo}/pulls/${pr}/files`);
    if (Array.isArray(filesRes.data)) {
      for (const f of filesRes.data) {
        const name = (f as Record<string, unknown>)?.filename;
        if (typeof name === "string") changedFiles.add(name);
      }
    }
    prDiff = await deps.ghTextFn(["pr", "diff", String(pr), "--repo", repo]);
  } catch (err) {
    return { kind: "terminal", code: "pr_fetch_failed", message: (err as Error).message };
  }

  const runHash = computeRunHash({
    pr_head_sha: prHeadSha,
    domains,
    agents_resolved: agentsResolved,
    severity_overrides: config.severity_overrides ?? {},
    fix_threshold: config.fix_threshold,
  });
  const classifierAgent: AgentName = cli.agent ?? config.default_agent ?? "codex";

  // Build assignments
  const assignments: DomainAssignment[] = [];
  for (const domain of domains) {
    const agent = agentsResolved[domain];
    try {
      const sources = resolvePromptSources({
        agent, domain,
        promptRoots: { global: promptRoot, shared: path.join(promptRoot, "domains") },
        baseRef: cli.base, repoRoot: cli.worktree,
      });
      const prompt = renderReviewPrompt({
        agent, domain, promptSources: sources, prTitle, prBody, prDiff,
      });
      assignments.push({ domain, agent, prompt });
    } catch (err) {
      failedResults.push({ domain, agent, error: (err as Error).message });
    }
  }

  let ports: Map<AgentName, AgentPort>;
  try {
    ports = await resolveAgentPorts(agentsResolved);
  } catch (err) {
    return { kind: "terminal", code: "agent_port_load_failed", message: (err as Error).message };
  }
  progress(
    `pr #${pr} (${repo}) • ${assignments.length} assignment(s) across ${domains.length} domain(s) • max_concurrent=${config.runtime?.max_concurrent_agents ?? 3}`,
  );
  const results = await dispatchDomains({
    assignments, ports, config,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  let allFindings: Finding[] = [];
  for (const r of results) {
    if (!r.ok) {
      failedResults.push({ domain: r.domain, agent: r.agent, error: r.error ?? "unknown" });
    }
    parseErrors.push(...r.parseErrors);
    allFindings.push(...r.findings);
  }
  allFindings = applySeverityOverrides(allFindings, config.severity_overrides);
  progress(`dispatch done: ${allFindings.length} findings, ${failedResults.length} failed domain(s)`);
  const tier = classifyDispatchTier(results);
  if (tier === "tier2_total") {
    return { kind: "terminal", code: "dispatch_failure", message: "all domains failed" };
  }

  if (!ports.has(classifierAgent)) {
    try {
      ports.set(classifierAgent, await loadAgentPort(classifierAgent));
    } catch { /* */ }
  }
  const classifierPromptResolved = resolveClassifierPrompt({
    agent: classifierAgent,
    promptRoot,
    baseRef: cli.base,
    repoRoot: cli.worktree,
  });
  if (classifierPromptResolved.source === "fallback") {
    progress(
      `classifier prompt fallback: ${classifierAgent}/classifier.md not found in repo override or global; using one-line default — noise/false_positive classification will skew toward fix`,
    );
    classifierEvents.push({
      type: "classifier_prompt_fallback",
      finding_id: "",
      reason: `no classifier.md for agent=${classifierAgent}`,
    });
  }
  progress(`classifying ${allFindings.length} finding(s)…`);
  const cls = await runClassifier(allFindings, {
    worktree: cli.worktree,
    classifierAgent,
    ports,
    classifierPrompt: classifierPromptResolved.prompt,
    config,
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
  });
  classifierEvents.push(...cls.events);
  allFindings = cls.findings;
  {
    const tally: Record<string, number> = { fix: 0, noise: 0, false_positive: 0, ignored: 0, unclassified: 0 };
    for (const f of allFindings) tally[f.classification ?? "unclassified"]++;
    progress(
      `classified  fix=${tally.fix} noise=${tally.noise} false_positive=${tally.false_positive} ignored=${tally.ignored} unclassified=${tally.unclassified}`,
    );
  }

  const allocated = allocateAndWriteRoundHistory({
    home,
    repo, pr,
    mode: "single",
    domain_agents: agentsResolved,
    results: domains.map((domain) => {
      const r = results.find((rr) => rr.domain === domain);
      return {
        agent: agentsResolved[domain],
        model: null,
        domain,
        duration_s: r ? r.durationMs / 1000 : 0,
        error: r && !r.ok ? (r.error ?? "unknown") : null,
        api_key_fallback: false,
        findings: allFindings.filter((f) => f.domain === domain),
      };
    }),
  });

  const findingAgents = new Set(allFindings.map((f) => f.agent));
  const postingAgent: AgentName = selectPostingAgent(allFindings) ?? classifierAgent;
  const mixedFindingAgents = findingAgents.size > 1;
  const postingAgentNote = mixedFindingAgents
    ? `_Posted under stark-${postingAgent}[bot] (majority of findings: ${allFindings.filter((f) => f.agent === postingAgent).length}/${allFindings.length}); per-domain agents in agents_resolved._`
    : undefined;

  const marker = buildMarker(allocated.round, postingAgent, runHash);
  let alreadyPosted = false;
  try {
    alreadyPosted = await findExistingMarker({ repo, pr, marker, ghJsonFn: deps.ghJsonFn });
  } catch { /* */ }

  let commentsPosted = 0;
  let unpostedReason: string | undefined;

  if (cls.aborted) {
    appendAudit({ action: "skip", round: allocated.round, reason: "classifier_aborted" }, { home, repo, pr });
  } else if (!alreadyPosted) {
    let posterToken: string | undefined;
    if (!cli.dryRun) {
      try {
        // Force a fresh mint: a long review round can outlast the token's
        // ~1h lifetime, so a round-start token may be expired by POST time.
        posterToken = await tokenForAgent(postingAgent, {
          repo,
          forceRefresh: true,
          ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
        });
      } catch (err) {
        unpostedReason = `token_resolution_failed: ${(err as Error).message}`;
      }
    }
    if ((posterToken || cli.dryRun) && !unpostedReason) {
      progress(`posting as stark-${postingAgent}${cli.dryRun ? "  [dry-run]" : ""}`);
      try {
        const pr_ = await postReview({
          repo, pr, round: allocated.round,
          agent: postingAgent,
          runHash,
          findings: allFindings,
          changedFiles,
          fixThreshold: config.fix_threshold,
          humanSummary: `stark-review TS dispatcher: ${allFindings.length} findings`,
          prHeadSha,
          dryRun: cli.dryRun,
          agentsResolved,
          ...(postingAgentNote ? { postingAgentNote } : {}),
          ...(posterToken ? { posterToken } : {}),
          ghJsonFn: deps.ghJsonFn,
          ghJsonOnceFn: deps.ghJsonOnceFn,
        });
        if (pr_.posted && !pr_.unposted) {
          commentsPosted = pr_.payloadSummary.inlineCount;
          appendAudit({
            action: "post", round: allocated.round,
            ...(pr_.reviewId ? { reason: `review_id=${pr_.reviewId}` } : {}),
          }, { home, repo, pr });
          progress(`posted  ${pr_.payloadSummary.inlineCount} inline + ${pr_.payloadSummary.bodyFindingsCount} body${pr_.reviewId ? `  review_id=${pr_.reviewId}` : ""}`);
        }
        if (pr_.unposted) {
          unpostedReason = pr_.unpostedReason ?? "post failed";
          progress(`unposted: ${unpostedReason}`);
        }
      } catch (err) {
        unpostedReason = (err as Error).message;
      }
    }
  } else {
    appendAudit({ action: "skip", round: allocated.round, reason: "duplicate_marker" }, { home, repo, pr });
  }

  return {
    kind: "ok",
    round: allocated.round,
    historyPath: allocated.path,
    allFindings,
    failedResults,
    parseErrors,
    classifierEvents,
    classifierAborted: cls.aborted,
    durationMs: Date.now() - start,
    commentsPosted,
    ...(unpostedReason !== undefined ? { unpostedReason } : {}),
    postingAgent,
    prHeadSha,
    prHeadIsFork,
    prHeadRef,
    prHeadRepoFullName,
    prHeadCloneUrl,
    maintainerCanModify,
  };
}

function buildRound(
  round: number,
  findings: Finding[],
  failedResults: Array<{ domain: string; agent: AgentName; error: string }>,
  parseErrors: ParseError[],
  classifierEvents: ClassifyEvent[],
  durationMs: number,
): ReceiptRound {
  return {
    round,
    findings: findings.length,
    summary: {
      fix: findings.filter((f) => f.classification === "fix").length,
      noise: findings.filter((f) => f.classification === "noise").length,
      false_positive: findings.filter((f) => f.classification === "false_positive").length,
      ignored: findings.filter((f) => f.classification === "ignored").length,
      unclassified: findings.filter((f) => f.classification === undefined).length,
      total: findings.length,
    },
    failed_results: failedResults,
    parse_errors: parseErrors,
    classifier_errors: classifierEvents,
    duration_ms: durationMs,
  };
}

function terminalReceipt(repo: string, pr: number, code: string, message: string): FailureReceipt {
  return { ok: false, schema_version: 1, repo, pr, error: { code, message }, rounds: [] };
}

function finalizeFailure(
  repo: string, pr: number, code: string, message: string, json: boolean,
): { receipt: Receipt; exitCode: number } {
  const r = terminalReceipt(repo, pr, code, message);
  emitReceipt(r, json);
  return { receipt: r, exitCode: 1 };
}


async function tryAcquireLock(
  repo: string, pr: number, config: ResolvedConfig,
): Promise<{ handle: LockHandle } | { error: { code: string; message: string } }> {
  try {
    const handle = await acquireLock({
      home: os.homedir(), repo, pr,
      lockTtlMinutes: config.runtime?.lock_ttl_minutes ?? config.lock_ttl_minutes ?? 30,
    });
    return { handle };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { error: { code: e.code ?? "lock_io", message: e.message ?? String(err) } };
  }
}

// Run main() when invoked directly (not when imported as a module).
// Resolve symlinks on both sides — the install path is symlinked (e.g.
// ~/.claude/code-review/tools → repo/tools) and a naive path comparison would
// silently treat a direct invocation as an import and exit 0 with no output.
const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv?.[1]) return false;
    const entry = fs.realpathSync(path.resolve(process.argv[1]));
    const here = fs.realpathSync(new URL(import.meta.url).pathname);
    return here === entry;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  (async () => {
    let exit = 0;
    try {
      const { exitCode } = await main(process.argv.slice(2));
      exit = exitCode;
    } catch (err) {
      process.stderr.write(`stark-review: fatal: ${(err as Error).stack ?? err}\n`);
      process.exit(2);
    }
    process.exit(exit);
  })();
}
