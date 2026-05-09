import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildMarker,
  findingId,
  loadTrustedConfig,
  renderReviewPrompt,
  resolvePromptSources,
  selectDomains,
  resolveAgentsForDomains,
  severityMeetsThreshold,
  type AgentName,
  type Finding,
  type ResolvedConfig,
  type Severity,
} from "./stark_review_lib.ts";
import type { BuiltCommand, ParseError, ParseResult } from "./agent_codex.ts";

// ─── Agent port loader (Phase 3, preserved) ─────────────────────────────────

export interface AgentPort {
  buildCommand(prompt: string, model?: string): BuiltCommand;
  parseOutput(stdout: string): ParseResult;
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
    try {
      port.buildCommand("");
    } catch (err) {
      throw Object.assign(
        new Error(
          `agent '${agent}' is not supported by the TS pipeline yet: ${(err as Error).message}`,
        ),
        { code: "agent_not_supported" as const, cause: err },
      );
    }
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
  json: boolean;
}

export interface ParseCliResult {
  config?: CliConfig;
  helpRequested: boolean;
  warnings: string[];
  errors: string[];
}

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
  --no-fix-loop             Disabled in V1 (default)
  --allow-untrusted-fix-loop  Inert in V1 (warning emitted)
  --max-rounds <int>        Max rounds (default 3)
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
          } else {
            maxRounds = n;
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
    warnings.push("--allow-untrusted-fix-loop: fix loop not enabled in V1; flag is ignored.");
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
      json,
    },
  };
}

// ─── Task 4-2: REST-only gh helpers ─────────────────────────────────────────

export interface GhJsonOpts {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  paginate?: boolean;
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
  if (/graphql/i.test(p)) {
    throw new Error(`REST-only contract violated: ${p} contains 'graphql'`);
  }
}

function buildGhEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

interface SpawnResult { stdout: string; stderr: string; status: number }

async function spawnCollect(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<SpawnResult> {
  return await new Promise((resolve, reject) => {
    const sopts: SpawnOptionsWithoutStdio = {
      env: opts.env ?? process.env,
      cwd: opts.cwd,
    };
    const child = spawn(cmd, args, sopts);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b as Buffer));
    child.stderr.on("data", (b) => err.push(b as Buffer));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        status: code ?? -1,
      });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
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
  const res = await spawnCollect("gh", args, { input, env: buildGhEnv() });
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
  const cap = Math.max(1, opts.config.runtime?.max_concurrent_agents ?? 3);
  const allowlist = opts.config.runtime?.subagent_env_allowlist ?? [];
  const tempPrefix = opts.config.runtime?.temp_dir_prefix ?? "stark-env";
  const spawner = opts.spawnFn ?? spawnCollect;

  const queue = [...opts.assignments];
  const results: DispatchResult[] = new Array(queue.length);
  let nextIdx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIdx++;
      if (idx >= queue.length) return;
      const a = queue[idx];
      const start = Date.now();
      const port = opts.ports.get(a.agent);
      if (!port) {
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: false,
          findings: [], parseErrors: [],
          error: `agent_not_supported: ${a.agent}`,
          durationMs: Date.now() - start,
        };
        continue;
      }
      let tempDir: string | null = null;
      try {
        const built = port.buildCommand(a.prompt, a.model);
        const env = pickAllowlistedEnv(process.env, allowlist);
        for (const [k, v] of Object.entries(built.env)) {
          if (!FORBIDDEN_ENV_KEYS.includes(k as (typeof FORBIDDEN_ENV_KEYS)[number])) {
            env[k] = v;
          }
        }
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-`));
        env.TMPDIR = tempDir;
        const sp = await spawner(built.cmd, built.args, {
          input: built.stdin, env, cwd: tempDir,
        });
        if (sp.status !== 0) {
          results[idx] = {
            domain: a.domain, agent: a.agent, ok: false,
            findings: [], parseErrors: [],
            error: `agent exit ${sp.status}: ${sp.stderr.slice(0, 400)}`,
            durationMs: Date.now() - start,
          };
          continue;
        }
        const parsed = port.parseOutput(sp.stdout);
        // Tier 1 detection: non-empty stdout that yields no findings AND no parse
        // errors is unparseable prose — route to failed_results, not a silent ok.
        if (
          parsed.findings.length === 0 &&
          parsed.parseErrors.length === 0 &&
          sp.stdout.trim().length > 0
        ) {
          results[idx] = {
            domain: a.domain, agent: a.agent, ok: false,
            findings: [], parseErrors: [],
            error: `unparseable agent stdout (${sp.stdout.length} bytes, no findings)`,
            durationMs: Date.now() - start,
          };
          continue;
        }
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: true,
          findings: parsed.findings.map((f) => ({ ...f, domain: a.domain, agent: a.agent })),
          parseErrors: parsed.parseErrors,
          durationMs: Date.now() - start,
        };
      } catch (err) {
        results[idx] = {
          domain: a.domain, agent: a.agent, ok: false,
          findings: [], parseErrors: [],
          error: (err as Error).message,
          durationMs: Date.now() - start,
        };
      } finally {
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
        }
      }
    }
  }

  const workers = Array.from({ length: Math.min(cap, queue.length) }, () => worker());
  await Promise.all(workers);
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
  type: "path_rejected" | "classifier_failed" | "classifier_aborted";
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
  const prompt = `${opts.classifierPrompt}\n\nFinding to classify:\n\`\`\`json\n${JSON.stringify(safeFinding, null, 2)}\n\`\`\`\n\nRespond with a single JSON object: {"classification":"fix|false_positive|noise|ignored","reason":"..."}`;
  const spawner = opts.spawnFn ?? spawnCollect;
  let tempDir: string | null = null;
  try {
    const built = port.buildCommand(prompt);
    const env = pickAllowlistedEnv(process.env, allowlist);
    for (const [k, v] of Object.entries(built.env)) {
      if (!FORBIDDEN_ENV_KEYS.includes(k as (typeof FORBIDDEN_ENV_KEYS)[number])) env[k] = v;
    }
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${tempPrefix}-cls-`));
    env.TMPDIR = tempDir;
    const sp = await spawner(built.cmd, built.args, { input: built.stdin, env, cwd: tempDir });
    if (sp.status !== 0) {
      return { classification: "fix", reason: `classifier_failed: exit ${sp.status}`, ok: false };
    }
    const parsed = port.parseOutput(sp.stdout);
    const m = sp.stdout.match(/\{[^{}]*"classification"[^{}]*\}/);
    if (!m) {
      if (parsed.findings.length > 0 && parsed.findings[0].classification) {
        return {
          classification: parsed.findings[0].classification,
          reason: parsed.findings[0].classification_reason ?? "",
          ok: true,
        };
      }
      return { classification: "fix", reason: "classifier_failed: no classification in output", ok: false };
    }
    let obj: unknown;
    try {
      obj = JSON.parse(m[0]);
    } catch (err) {
      return { classification: "fix", reason: `classifier_failed: ${(err as Error).message}`, ok: false };
    }
    if (typeof obj !== "object" || obj === null) {
      return { classification: "fix", reason: "classifier_failed: bad shape", ok: false };
    }
    const c = (obj as Record<string, unknown>).classification;
    if (c !== "fix" && c !== "false_positive" && c !== "noise" && c !== "ignored") {
      return { classification: "fix", reason: `classifier_failed: bad classification ${JSON.stringify(c)}`, ok: false };
    }
    const reasonRaw = (obj as Record<string, unknown>).reason;
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
  return { inline, bodyFindings };
}

export function buildReviewBody(
  marker: string,
  humanSummary: string,
  bodyFindings: Finding[],
): string {
  const lines: string[] = [marker, "", humanSummary];
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
  let body = buildReviewBody(marker, opts.humanSummary, part.bodyFindings);
  let inline = [...part.inline];
  const result: PostReviewResult = {
    posted: false,
    attempts: [],
    fallbacksApplied: 0,
    payloadSummary: { inlineCount: inline.length, bodyFindingsCount: part.bodyFindings.length, bodyChars: body.length },
  };
  if (opts.dryRun) return result;
  const gh = opts.ghJsonFn ?? ghJson;
  // POST transport must NOT retry internally — the outer retry below re-checks
  // the marker before each retry to guarantee idempotency on 5xx. If both inner
  // (ghJson) and outer retried, a successful-but-unacknowledged POST could be
  // re-sent before the marker check ran, double-posting the review.
  const ghPost = opts.ghJsonOnceFn ?? opts.ghJsonFn ?? ghJsonOnce;
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
      body = buildReviewBody(marker, opts.humanSummary, [...part.bodyFindings, ...demote]);
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
    body = buildReviewBody(marker, opts.humanSummary, allBody);
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
 *   0 only when ok:true AND failed_results=[] AND unposted_reviews=[]
 *   1 partial (ok:true with failures or unposted) or terminal (ok:false)
 */
export function computeExitCode(r: Receipt): number {
  if (!r.ok) return 1;
  const anyFailed = r.rounds.some((rd) => rd.failed_results.length > 0);
  if (anyFailed) return 1;
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

// Re-exports for tests / dispatcher consumers
export {
  buildMarker,
  loadTrustedConfig,
  selectDomains,
  resolveAgentsForDomains,
  renderReviewPrompt,
  resolvePromptSources,
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
export async function main(argv: string[]): Promise<{ receipt: Receipt; exitCode: number }> {
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
  const cli = parsed.config;
  const repo = cli.repo;
  const pr = cli.pr;

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

  const promptRoot = path.join(cli.configRoot, "prompts");
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

  const round1Start = Date.now();
  const failedResults: Array<{ domain: string; agent: AgentName; error: string }> = [];
  const parseErrors: ParseError[] = [];
  const classifierEvents: ClassifyEvent[] = [];
  const unposted: Array<{ round: number; reason: string }> = [];
  const historyFiles: string[] = [];
  let commentsPosted = 0;
  let allFindings: Finding[] = [];

  try {
    // ── PR metadata ────────────────────────────────────────────────────────
    let prHeadSha = "";
    let prTitle = "";
    let prBody = "";
    let prDiff = "";
    let changedFiles = new Set<string>();
    try {
      const meta = await ghJson(`/repos/${repo}/pulls/${pr}`);
      const m = meta.data as Record<string, unknown>;
      prHeadSha = (m?.head as { sha?: string } | undefined)?.sha ?? "";
      prTitle = (m?.title as string) ?? "";
      prBody = (m?.body as string) ?? "";
      const filesRes = await ghJson(`/repos/${repo}/pulls/${pr}/files`);
      if (Array.isArray(filesRes.data)) {
        for (const f of filesRes.data) {
          const name = (f as Record<string, unknown>)?.filename;
          if (typeof name === "string") changedFiles.add(name);
        }
      }
      prDiff = await ghText(["pr", "diff", String(pr), "--repo", repo]);
    } catch (err) {
      return finalizeAndRelease(lock, repo, pr, "pr_fetch_failed", (err as Error).message, cli.json);
    }

    // ── Run hash (marker is built later, after round allocation) ──────────
    const runHash = computeRunHash({
      pr_head_sha: prHeadSha,
      domains,
      agents_resolved: agentsResolved,
      severity_overrides: config.severity_overrides ?? {},
      fix_threshold: config.fix_threshold,
    });
    // Resolve the posting agent once — the same identity must be used for
    // marker construction, marker check, and POST. Otherwise duplicate
    // detection scans for a marker that differs from the one we'd post.
    const classifierAgent: AgentName = cli.agent ?? config.default_agent ?? "codex";

    // ── Build assignments and dispatch ─────────────────────────────────────
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
      return finalizeAndRelease(
        lock, repo, pr, "agent_port_load_failed", (err as Error).message, cli.json,
      );
    }
    const results = await dispatchDomains({ assignments, ports, config });
    for (const r of results) {
      if (!r.ok) {
        failedResults.push({ domain: r.domain, agent: r.agent, error: r.error ?? "unknown" });
      }
      parseErrors.push(...r.parseErrors);
      allFindings.push(...r.findings);
    }
    allFindings = applySeverityOverrides(allFindings, config.severity_overrides);
    const tier = classifyDispatchTier(results);
    if (tier === "tier2_total") {
      return finalizeAndRelease(lock, repo, pr, "dispatch_failure", "all domains failed", cli.json);
    }

    // ── Classifier ─────────────────────────────────────────────────────────
    if (!ports.has(classifierAgent)) {
      try {
        ports.set(classifierAgent, await loadAgentPort(classifierAgent));
      } catch { /* fall through; classifyOne will fail-safe to fix */ }
    }
    const cls = await runClassifier(allFindings, {
      worktree: cli.worktree,
      classifierAgent,
      ports,
      classifierPrompt: "Classify each finding as fix|false_positive|noise|ignored.",
      config,
    });
    classifierEvents.push(...cls.events);
    allFindings = cls.findings;

    // ── Allocate round + write history (atomic, inside lock) ──────────────
    const allocated = allocateAndWriteRoundHistory({
      home: os.homedir(),
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
    historyFiles.push(allocated.path);

    // ── Idempotency marker check (after round allocation) ─────────────────
    // The marker MUST use the same (round, agent, runHash) tuple that postReview
    // will use for the body; otherwise we'd scan for the wrong marker and could
    // double-post. Round comes from allocateAndWriteRoundHistory above; agent
    // is the classifierAgent resolved at start of run.
    const marker = buildMarker(allocated.round, classifierAgent, runHash);
    let alreadyPosted = false;
    try {
      alreadyPosted = await findExistingMarker({ repo, pr, marker });
    } catch { /* swallow — proceed to post */ }

    // ── Post review ────────────────────────────────────────────────────────
    if (cls.aborted) {
      const errMsg = "classifier aborted after 5 errors; POST skipped";
      return finalizeAndRelease(lock, repo, pr, "classifier_aborted", errMsg, cli.json, {
        round: allocated.round, findings: allFindings, failedResults, parseErrors,
        classifierEvents, durationMs: Date.now() - round1Start,
        unposted, historyFiles,
      });
    }
    if (alreadyPosted) {
      // Idempotent skip — duplicate_detected already implied by marker presence.
    } else {
      try {
        const pr_ = await postReview({
          repo, pr, round: allocated.round,
          agent: classifierAgent,
          runHash,
          findings: allFindings,
          changedFiles,
          fixThreshold: config.fix_threshold,
          humanSummary: `stark-review TS dispatcher: ${allFindings.length} findings`,
          prHeadSha,
          dryRun: cli.dryRun,
        });
        if (pr_.posted && !pr_.unposted) commentsPosted = pr_.payloadSummary.inlineCount;
        if (pr_.unposted) {
          unposted.push({ round: allocated.round, reason: pr_.unpostedReason ?? "post failed" });
        }
      } catch (err) {
        unposted.push({ round: allocated.round, reason: (err as Error).message });
      }
    }

    // ── Best-effort prune (separate lock) ──────────────────────────────────
    try {
      pruneHistory({
        home: os.homedir(),
        retentionDays: config.history_retention_days ?? 0,
        lockTtlMinutes: config.runtime?.lock_ttl_minutes ?? config.lock_ttl_minutes ?? 30,
      });
    } catch { /* best-effort */ }

    const receipt: SuccessReceipt = {
      ok: true, schema_version: 1, repo, pr,
      agent: cli.agent, agents_resolved: agentsResolved, domains,
      rounds: [buildRound(allocated.round, allFindings, failedResults, parseErrors, classifierEvents, Date.now() - round1Start)],
      fixes_pushed: 0,
      comments_posted: commentsPosted,
      unposted_reviews: unposted,
      history_files: historyFiles,
    };
    emitReceipt(receipt, cli.json);
    return { receipt, exitCode: computeExitCode(receipt) };
  } finally {
    try { lock.release(); } catch { /* */ }
  }
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

function finalizeAndRelease(
  lock: LockHandle, repo: string, pr: number, code: string, message: string, json: boolean,
  partial?: {
    round: number; findings: Finding[];
    failedResults: Array<{ domain: string; agent: AgentName; error: string }>;
    parseErrors: ParseError[]; classifierEvents: ClassifyEvent[];
    durationMs: number;
    unposted: Array<{ round: number; reason: string }>;
    historyFiles: string[];
  },
): { receipt: Receipt; exitCode: number } {
  const r: FailureReceipt = {
    ok: false, schema_version: 1, repo, pr,
    error: { code, message },
    rounds: partial
      ? [buildRound(partial.round, partial.findings, partial.failedResults, partial.parseErrors, partial.classifierEvents, partial.durationMs)]
      : [],
  };
  emitReceipt(r, json);
  try { lock.release(); } catch { /* */ }
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
const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv?.[1]) return false;
    const entry = path.resolve(process.argv[1]);
    // import.meta.url is a file:// URL; convert to path.
    const here = new URL(import.meta.url).pathname;
    return path.resolve(here) === entry;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    ({ exitCode }) => process.exit(exitCode),
    (err) => {
      process.stderr.write(`stark-review: fatal: ${(err as Error).stack ?? err}\n`);
      process.exit(2);
    },
  );
}
