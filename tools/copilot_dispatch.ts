#!/usr/bin/env -S node --experimental-strip-types
/**
 * Copilot dispatch — paired lead/wing implementation with review-fix loop.
 *
 * For each implementation step:
 *   1. Create one git worktree for the lead agent
 *   2. Lead implements the step in its worktree
 *   3. Wing reviews the lead's diff out-of-tree, returns approve|revise|block JSON verdict
 *   4. If revise and rounds remain, lead resumes in the same worktree to address findings
 *   5. Loop until approved, blocked, max-rounds exhausted, or empty-diff revision detected
 *
 * Drop-in replacement for the Python copilot_dispatch.py. Same CLI surface,
 * same JSON output shape. Shells out to `tools/github_app.ts` only when a
 * GitHub App token is actually required (wing review with operation="review").
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { assetConfigPath } from "./asset_root_lib.ts";
import { resolveVertexLocation, resolveVertexProject } from "./vertex_config_lib.ts";

// Constants ---------------------------------------------------------------

export const VALID_AGENTS = ["claude", "codex", "gemini"] as const;
export type AgentName = (typeof VALID_AGENTS)[number];

export const DEFAULT_LEAD: AgentName = "claude";
export const DEFAULT_WING: AgentName = "codex";
export const DEFAULT_MAX_ROUNDS = 4;
export const DEFAULT_TIMEOUT_SEC = 900;
export const WING_TIMEOUT_DEFAULT_SEC = 600;
export const DEFAULT_GOAL_MAX_BUDGET_USD = 10;
export const TEST_TIMEOUT_SEC = 120;
// Claude Code applies a low DEFAULT per-invocation turn cap in `-p` mode; a phase
// (write sources + slow swift build + test + fix) blows past it and the CLI exits 1
// with subtype `error_max_turns` (looks like a generic cli_error to the dispatcher).
// Pass an explicit generous cap so the lead can finish a phase in one pass.
export const LEAD_MAX_TURNS = 100;
// Runaway $ guard for the no-goal lead (goal mode already caps via --goal-max-budget-usd).
export const LEAD_MAX_BUDGET_USD = 12;

const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro-preview";
const CODEX_REASONING_EFFORT_MEDIUM = 'model_reasoning_effort="medium"';

// Vertex project/location resolved at dispatch time (env > config >
// GOOGLE_CLOUD_PROJECT > gcloud-derived); no project id hardcoded here.

const HOME = os.homedir();
const CONFIG_PATH = assetConfigPath();
const DEFAULT_ADC_PATH = path.join(
  HOME,
  ".config",
  "gcloud",
  "application_default_credentials.json",
);
const GEMINI_FALLBACK_LOG = path.join(
  HOME,
  ".claude",
  "code-review",
  "gemini-api-key-fallback.log",
);

function resolveSelfDir(): string {
  const url = new URL(import.meta.url);
  const filePath = realpathSync(url.pathname);
  return path.dirname(filePath);
}

const SELF_DIR = resolveSelfDir();
// Config (minimal port of config_loader.py) -------------------------------

interface AgentModelConfig {
  enabled: boolean;
  model_id: string;
}

const DEFAULT_MODELS: Record<AgentName, AgentModelConfig> = {
  claude: { enabled: true, model_id: CLAUDE_DEFAULT_MODEL },
  codex: { enabled: true, model_id: CODEX_DEFAULT_MODEL },
  gemini: { enabled: true, model_id: GEMINI_DEFAULT_MODEL },
};

const DEFAULT_RUNTIME_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "ANTHROPIC_AGENTS",
];

const DEFAULT_GITHUB_APPS: Record<AgentName, string> = {
  claude: "stark-claude",
  codex: "stark-codex",
  gemini: "stark-gemini",
};

let _configCache: Record<string, unknown> | null = null;

function loadConfig(): Record<string, unknown> {
  if (_configCache !== null) return _configCache;
  if (!existsSync(CONFIG_PATH)) {
    _configCache = {};
    return _configCache;
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    _configCache = isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    process.stderr.write(
      `copilot_dispatch: failed to load ${CONFIG_PATH}: ${(err as Error).message}\n`,
    );
    _configCache = {};
  }
  return _configCache;
}

function getAgentModelConfig(agent: string): AgentModelConfig | null {
  const models = loadConfig()["models"];
  const fromUser = isPlainObject(models) ? (models as Record<string, unknown>)[agent] : null;
  const defaults = (DEFAULT_MODELS as Record<string, AgentModelConfig>)[agent];
  if (!defaults && !isPlainObject(fromUser)) return null;
  const merged: AgentModelConfig = {
    enabled: defaults?.enabled ?? false,
    model_id: defaults?.model_id ?? "",
  };
  if (isPlainObject(fromUser)) {
    const f = fromUser as Record<string, unknown>;
    if (typeof f["enabled"] === "boolean") merged.enabled = f["enabled"];
    if (typeof f["model_id"] === "string") merged.model_id = f["model_id"];
  }
  return merged;
}

export function isAgentEnabled(agent: string): boolean {
  const cfg = getAgentModelConfig(agent);
  return cfg?.enabled === true;
}

export function resolveModel(agent: AgentName): string {
  const cfg = getAgentModelConfig(agent);
  return cfg?.model_id || DEFAULT_MODELS[agent].model_id;
}

function getEnvAllowlist(): readonly string[] {
  const runtime = loadConfig()["runtime"];
  if (isPlainObject(runtime)) {
    const list = (runtime as Record<string, unknown>)["subagent_env_allowlist"];
    if (Array.isArray(list) && list.every((x) => typeof x === "string")) {
      return list as string[];
    }
  }
  return DEFAULT_RUNTIME_ALLOWLIST;
}

function getGitHubAppName(agent: AgentName): string {
  const apps = loadConfig()["github_apps"];
  if (isPlainObject(apps)) {
    const v = (apps as Record<string, unknown>)[agent];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return DEFAULT_GITHUB_APPS[agent];
}

// Types -------------------------------------------------------------------

export interface RoundResult {
  round_num: number;
  diff: string;
  files_changed: string[];
  lines_added: number;
  lines_removed: number;
  test_passed: boolean | null;
  verdict: string;
  blocking_findings: string[];
  suggestions: string[];
  summary: string;
  wing_raw: string;
  parse_retry_used: boolean;
  duration_s: number;
  error: string | null;
}

function newRound(round_num: number): RoundResult {
  return {
    round_num,
    diff: "",
    files_changed: [],
    lines_added: 0,
    lines_removed: 0,
    test_passed: null,
    verdict: "",
    blocking_findings: [],
    suggestions: [],
    summary: "",
    wing_raw: "",
    parse_retry_used: false,
    duration_s: 0,
    error: null,
  };
}

interface ImplementOutcome {
  diff: string;
  files_changed: string[];
  lines_added: number;
  lines_removed: number;
  test_passed: boolean | null;
  raw_output: string;
  error: string | null;
  duration_s: number;
  api_key_fallback: boolean;
}

export type Verdict = "approve" | "revise" | "block" | "unparseable";

// Utilities ---------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function sanitizeRef(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

// Subprocess helper (timeout-aware, stdin-aware) --------------------------
// Note: uses spawn() with an argv array, never shell interpolation, so user-
// supplied strings (paths, prompts) cannot be parsed as shell metacharacters.

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
  outputCapBytes?: number;
}

const DEFAULT_OUTPUT_CAP = 32 * 1024 * 1024; // 32 MiB

export async function run(
  cmd: string,
  args: string[],
  opts: RunOptions,
): Promise<RunResult> {
  const cap = opts.outputCapBytes ?? DEFAULT_OUTPUT_CAP;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutLen = 0;
  let stderrLen = 0;

  const inner = await new Promise<RunResult>((resolve) => {
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
    let closedResult: RunResult | null = null;
    const tryFinish = () => {
      if (settled) return;
      if (closedResult === null) return;
      if (!stdoutEnded || !stderrEnded || !processClosed) return;
      settled = true;
      resolve(closedResult);
    };

    const timer = setTimeout(() => {
      // E2 sequencing: kill the child but DON'T resolve here. The
      // staged result waits for child.on("close") (and stdout/stderr
      // "end") via tryFinish()'s processClosed gate. Resolving on
      // stdio-end alone is unsafe — a child can close its FDs while
      // the process keeps running.
      timedOutFlag = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5_000);
    }, opts.timeoutSec * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (cap > 0 && stdoutLen >= cap) return;
      stdoutChunks.push(chunk);
      stdoutLen += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (cap > 0 && stderrLen >= cap) return;
      stderrChunks.push(chunk);
      stderrLen += chunk.length;
    });
    // E2: await stdout/stderr "end" before resolving so the final bytes
    // are captured before the result resolves.
    if (child.stdout) child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    else stdoutEnded = true;
    if (child.stderr) child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    else stderrEnded = true;

    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      // On error, streams may not emit "end" and the process may never
      // fire "close". Force all three gates.
      stdoutEnded = true;
      stderrEnded = true;
      processClosed = true;
      closedResult = {
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
      closedResult = {
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

  return inner;
}

async function runGit(
  args: string[],
  cwd: string,
  timeoutSec = 60,
  stdin?: string,
): Promise<RunResult> {
  return run("git", args, { cwd, timeoutSec, stdin });
}

// Env builders ------------------------------------------------------------

const BLOCKED_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AGENTS"]);
const ANTHROPIC_PREFIX = "ANTHROPIC_";
const ALLOWED_ANTHROPIC_KEYS = new Set(["ANTHROPIC_CODE_CLI"]);

export type Operation = "implementation" | "review" | "local";

// Tracks subprocess scratch dirs that survived past their subprocess (e.g.
// caller forgot to clean them). A single process.exit handler sweeps them
// at shutdown — avoids the "MaxListenersExceededWarning" footgun from
// registering one listener per buildAgentEnv call.
const _liveTempDirs = new Set<string>();
let _tempDirSweeperInstalled = false;

function installTempDirSweeperOnce(): void {
  if (_tempDirSweeperInstalled) return;
  _tempDirSweeperInstalled = true;
  process.on("exit", () => {
    for (const d of _liveTempDirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    _liveTempDirs.clear();
  });
}

function makeAgentTempDir(): string {
  installTempDirSweeperOnce();
  const tmp = mkdtempSync(path.join(os.tmpdir(), `stark-copilot-env-${process.pid}-`));
  _liveTempDirs.add(tmp);
  return tmp;
}

export function releaseAgentTempDir(tmp: string): void {
  _liveTempDirs.delete(tmp);
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

interface AgentEnv {
  env: NodeJS.ProcessEnv;
  /** Caller MUST call releaseAgentTempDir(tempDir) after the subprocess exits. */
  tempDir: string;
}

export async function buildAgentEnv(
  agent: AgentName,
  operation: Operation,
): Promise<AgentEnv> {
  const allowlist = new Set(getEnvAllowlist());
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (BLOCKED_ENV_KEYS.has(k)) continue;
    if (!allowlist.has(k)) continue;
    env[k] = v;
  }

  if (agent === "claude") {
    const sourceKey = process.env["ANTHROPIC_AGENTS"];
    if (!sourceKey) {
      throw new Error(
        "ANTHROPIC_AGENTS not set in environment. Source your Anthropic key file " +
          "(e.g. `source \"$HOME/Code/.private/API Keys/.anthropic.key\"`) before dispatching claude.",
      );
    }
    env["ANTHROPIC_API_KEY"] = sourceKey;
  } else {
    delete env["ANTHROPIC_API_KEY"];
  }

  if (operation === "review") {
    const token = await fetchGitHubAppToken(getGitHubAppName(agent));
    if (token) env["GH_TOKEN"] = token;
  }

  delete env["ANTHROPIC_AGENTS"];

  const tempDir = makeAgentTempDir();
  env["STARK_AGENT_TMPDIR"] = tempDir;
  return { env, tempDir };
}

async function fetchGitHubAppToken(appName: string): Promise<string | null> {
  // Sibling TS CLI: tools/github_app.ts (resolved relative to this script).
  const ts = path.join(SELF_DIR, "github_app.ts");
  if (!existsSync(ts)) return null;
  const res = await run(
    "node",
    ["--experimental-strip-types", ts, "--app", appName, "token"],
    { timeoutSec: 30, env: process.env },
  );
  if (res.code !== 0) {
    process.stderr.write(
      `copilot_dispatch: github_app token fetch failed (exit ${res.code}): ` +
        `${res.stderr.slice(0, 300)}\n`,
    );
    return null;
  }
  const token = res.stdout.trim();
  return token.length > 0 ? token : null;
}

// Gemini home setup -------------------------------------------------------

const GEMINI_AUTH_FILES = [
  "oauth_creds.json",
  "google_accounts.json",
  "installation_id",
] as const;

const GEMINI_AUTH_ERROR_PATTERNS = [
  "ModelNotFound",
  "403",
  "PERMISSION_DENIED",
  "401",
  "UNAUTHENTICATED",
  "DefaultCredentialsError",
  "RefreshError",
  "Could not automatically determine credentials",
  // No Vertex project resolved → CLI demands one; degrade to the API key.
  "GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION",
] as const;

export function setupGeminiHome(
  prefix: string,
  projectDir: string,
  projectLabel: string,
  approvalMode?: "plan" | "yolo",
): string {
  const home = mkdtempSync(path.join(os.tmpdir(), prefix));
  const geminiDir = path.join(home, ".gemini");
  mkdirSync(geminiDir, { recursive: true });

  const realHome = process.env["GEMINI_CLI_HOME"] ?? HOME;
  const realGeminiDir = path.join(realHome, ".gemini");
  for (const f of GEMINI_AUTH_FILES) {
    const src = path.join(realGeminiDir, f);
    if (existsSync(src)) {
      try { copyFileSync(src, path.join(geminiDir, f)); } catch { /* best-effort */ }
    }
  }

  const project = resolveVertexProject();
  const vertexAi: Record<string, string> = { region: resolveVertexLocation() };
  if (project) vertexAi.projectId = project;
  const settings: Record<string, unknown> = {
    security: {
      auth: {
        selectedType: "vertex-ai",
        vertexAi,
      },
    },
    selectedAuthType: "vertex-ai",
  };
  if (approvalMode) settings["defaultApprovalMode"] = approvalMode;
  writeFileSync(path.join(geminiDir, "settings.json"), JSON.stringify(settings));
  writeFileSync(
    path.join(geminiDir, "projects.json"),
    JSON.stringify({ projects: { [projectDir]: projectLabel } }),
  );
  return home;
}

export function makeGeminiEnv(
  geminiHome: string,
  opts: { trustWorkspace?: boolean } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (BLOCKED_ENV_KEYS.has(k)) continue;
    if (k.startsWith(ANTHROPIC_PREFIX) && !ALLOWED_ANTHROPIC_KEYS.has(k)) continue;
    env[k] = v;
  }
  env["GEMINI_CLI_HOME"] = geminiHome;
  if (opts.trustWorkspace) env["GEMINI_CLI_TRUST_WORKSPACE"] = "true";
  env["GOOGLE_GENAI_USE_VERTEXAI"] = "true";
  const vertexProject = resolveVertexProject();
  if (vertexProject) env["GOOGLE_CLOUD_PROJECT"] = vertexProject;
  env["GOOGLE_CLOUD_LOCATION"] = resolveVertexLocation();
  if (!env["GOOGLE_APPLICATION_CREDENTIALS"] && existsSync(DEFAULT_ADC_PATH)) {
    env["GOOGLE_APPLICATION_CREDENTIALS"] = DEFAULT_ADC_PATH;
  }
  return env;
}

export function shouldFallbackToApiKey(stderr: string): boolean {
  return GEMINI_AUTH_ERROR_PATTERNS.some((p) => stderr.includes(p));
}

let _geminiApiKeyCache: string | null | undefined;
async function getGeminiApiKey(): Promise<string | null> {
  if (_geminiApiKeyCache !== undefined) return _geminiApiKeyCache;
  const res = await run("security", ["find-generic-password", "-s", "GEMINI_API_KEY", "-w"], {
    timeoutSec: 5,
  });
  _geminiApiKeyCache = res.code === 0 ? res.stdout.trim() || null : null;
  return _geminiApiKeyCache;
}

function logApiKeyFallback(task: string, reason: string): void {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const red = "\x1b[1;31m";
  const redBg = "\x1b[1;37;41m";
  const reset = "\x1b[0m";
  const border = `${redBg}${"=".repeat(60)}${reset}`;
  process.stderr.write(
    `${border}\n${redBg}  GEMINI API KEY FALLBACK  ${reset}\n` +
      `${red}  Agent: gemini:${task}${reset}\n` +
      `${red}  Reason: ${reason}${reset}\n` +
      `${red}  Vertex AI auth failed -> using GEMINI_API_KEY from Keychain${reset}\n` +
      `${border}\n`,
  );
  try {
    mkdirSync(path.dirname(GEMINI_FALLBACK_LOG), { recursive: true });
    appendFileSync(GEMINI_FALLBACK_LOG, `${ts}  gemini:${task}  reason=${reason}\n`);
  } catch { /* best-effort */ }
}

export async function tryGeminiApiKeyFallback(
  env: NodeJS.ProcessEnv,
  contextLabel: string,
  stderrSnippet: string,
): Promise<boolean> {
  const apiKey = await getGeminiApiKey();
  if (!apiKey) return false;
  logApiKeyFallback(contextLabel, stderrSnippet.slice(0, 120));
  env["GEMINI_API_KEY"] = apiKey;
  env["GOOGLE_GENAI_USE_VERTEXAI"] = "false";
  for (const k of ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"]) {
    delete env[k];
  }
  const home = env["GEMINI_CLI_HOME"];
  if (home) {
    const settingsPath = path.join(home, ".gemini", "settings.json");
    try {
      const existing: unknown = existsSync(settingsPath)
        ? JSON.parse(readFileSync(settingsPath, "utf-8"))
        : {};
      const root: Record<string, unknown> = isPlainObject(existing) ? existing : {};
      const security: Record<string, unknown> = isPlainObject(root["security"])
        ? (root["security"] as Record<string, unknown>) : {};
      const auth: Record<string, unknown> = isPlainObject(security["auth"])
        ? (security["auth"] as Record<string, unknown>) : {};
      auth["selectedType"] = "gemini-api-key";
      delete auth["vertexAi"];
      security["auth"] = auth;
      root["security"] = security;
      root["selectedAuthType"] = "gemini-api-key";
      writeFileSync(settingsPath, JSON.stringify(root));
    } catch { /* best-effort */ }
  }
  return true;
}

// Output parsers ----------------------------------------------------------

export function parseCodexJsonl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  const parts: string[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: unknown;
    try { ev = JSON.parse(t); } catch { continue; }
    if (!isPlainObject(ev) || ev["type"] !== "item.completed") continue;
    const item = ev["item"];
    if (!isPlainObject(item)) continue;
    const itype = item["type"];
    if (itype === "agent_message") {
      const text = item["text"];
      if (typeof text === "string" && text) parts.push(text);
    } else if (itype === "message") {
      const content = item["content"];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (isPlainObject(c) && c["type"] === "output_text" && typeof c["text"] === "string") {
            parts.push(c["text"]);
          }
        }
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : raw;
}

export function parseGeminiJson(raw: string): string {
  if (!raw.trim()) return raw;
  try {
    const obj = JSON.parse(raw);
    if (isPlainObject(obj) && typeof obj["response"] === "string") return obj["response"];
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) {
        if (isPlainObject(item) && typeof item["response"] === "string") parts.push(item["response"]);
      }
      if (parts.length > 0) return parts.join("\n");
    }
  } catch { /* fall through */ }
  return raw;
}

/**
 * Find the trailing JSON verdict block in a wing review response.
 * Walks the text tracking balanced braces with string/escape awareness so a
 * `{` inside a JSON string never desyncs the depth counter. Returns the
 * last top-level object that parses to a dict containing "verdict".
 */
export function extractVerdictJson(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenceRe = /```(?:json)?\s*\n(\{[\s\S]*?\})\s*\n```/g;
  for (const m of text.matchAll(fenceRe)) {
    if (m[1]) candidates.push(m[1]);
  }
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          const cand = text.slice(start, i + 1);
          if (!candidates.includes(cand)) candidates.push(cand);
          start = -1;
        }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]!);
      if (isPlainObject(obj) && "verdict" in obj) return obj;
    } catch { /* skip */ }
  }
  return null;
}

export interface NormalizedVerdict {
  verdict: Verdict;
  blocking: string[];
  suggestions: string[];
  summary: string;
}

function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item);
    else if (item !== null && item !== undefined) out.push(String(item));
  }
  return out;
}

export function normalizeVerdict(obj: Record<string, unknown>): NormalizedVerdict {
  const rawVerdict = typeof obj["verdict"] === "string" ? obj["verdict"].trim().toLowerCase() : "";
  const verdict: Verdict =
    rawVerdict === "approve" || rawVerdict === "revise" || rawVerdict === "block"
      ? (rawVerdict as Verdict)
      : "unparseable";
  return {
    verdict,
    blocking: toStringList(obj["blocking_findings"]),
    suggestions: toStringList(obj["non_blocking_suggestions"]),
    summary: typeof obj["summary"] === "string" ? obj["summary"].trim() : "",
  };
}

// Worktree management -----------------------------------------------------

async function gitHead(cwd: string): Promise<string> {
  const r = await runGit(["rev-parse", "HEAD"], cwd, 30);
  if (r.code !== 0) throw new Error(`git rev-parse HEAD failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

export async function createWorktree(
  repoRoot: string,
  agent: AgentName,
  stepId: string,
): Promise<string> {
  const safeAgent = sanitizeRef(agent);
  const safeStep = sanitizeRef(stepId);
  const branchName = `autopilot/${safeAgent}/${safeStep}`;
  const worktreeDir = path.join(repoRoot, ".worktrees", `autopilot-${safeAgent}-${safeStep}`);

  const head = await gitHead(repoRoot);

  let r = await runGit(
    ["worktree", "add", "-b", branchName, worktreeDir, head],
    repoRoot,
    60,
  );
  if (r.code !== 0) {
    await runGit(["worktree", "remove", "--force", worktreeDir], repoRoot, 30);
    if (existsSync(worktreeDir)) {
      try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    await runGit(["worktree", "prune"], repoRoot, 30);
    await runGit(["branch", "-D", branchName], repoRoot, 30);
    r = await runGit(
      ["worktree", "add", "-b", branchName, worktreeDir, head],
      repoRoot,
      60,
    );
    if (r.code !== 0) {
      throw new Error(`Failed to create worktree: ${r.stderr}`);
    }
  }
  return worktreeDir;
}

export async function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
  branchName: string,
): Promise<void> {
  await runGit(["worktree", "remove", "--force", worktreePath], repoRoot, 30);
  await runGit(["branch", "-D", branchName], repoRoot, 30);
}

export async function collectDiff(
  worktreePath: string,
): Promise<{ diff: string; files: string[]; added: number; removed: number }> {
  await runGit(["add", "-A"], worktreePath, 60);
  const diffRes = await runGit(["diff", "--cached"], worktreePath, 120);
  const numstat = await runGit(["diff", "--cached", "--numstat"], worktreePath, 60);
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of numstat.stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const a = parts[0] === "-" ? 0 : Number.parseInt(parts[0]!, 10);
    const r = parts[1] === "-" ? 0 : Number.parseInt(parts[1]!, 10);
    if (Number.isFinite(a)) added += a;
    if (Number.isFinite(r)) removed += r;
    files.push(parts[2]!);
  }
  return { diff: diffRes.stdout, files, added, removed };
}

export type WorktreeSnapshot = readonly [head: string, tree: string];

/**
 * Capture (HEAD sha, content-hash of full worktree). The content hash is
 * `git write-tree` after staging every file — deterministic across any
 * tracked-or-untracked content change, including the case where a reviewer
 * replaces a staged file's content and re-stages it.
 */
export async function snapshotWorktree(worktreePath: string): Promise<WorktreeSnapshot> {
  const headRes = await runGit(["rev-parse", "HEAD"], worktreePath, 30);
  await runGit(["add", "-A"], worktreePath, 60);
  const treeRes = await runGit(["write-tree"], worktreePath, 30);
  return [headRes.stdout.trim(), treeRes.stdout.trim()] as const;
}

export async function restoreWorktree(
  worktreePath: string,
  snapshot: WorktreeSnapshot,
): Promise<void> {
  const [head] = snapshot;
  await runGit(["reset", "--hard", head], worktreePath, 30);
  await runGit(["clean", "-fd"], worktreePath, 30);
}

// Agent dispatch ----------------------------------------------------------

export function buildClaudeCmd(opts: {
  allowedTools?: string;
  outputFormat?: "text" | "json";
  // When set, the prompt is passed as the `-p` ARGUMENT instead of stdin (`-p -`).
  // Required for the `/goal` loop to fire: a leading `/goal` is only honored in the
  // argument form — via stdin it is read as plain prompt text (verified 2026-06-03,
  // Claude Code 2.1.161). Passing from a Node args array avoids any shell quoting.
  // The `/goal` argument is a SHORT completion condition that points at a staged
  // prompt file (the full task must NOT be inlined — Claude Code caps the `/goal`
  // argument at 4000 chars and silently no-ops a longer one; see the goal branch in
  // runImplementationAgent). TRADEOFF: an argv-passed goal string is visible in
  // `ps`/process listings, but it now carries only the short condition + a file path
  // (never secrets), so on a single-user host this exposure is acceptable.
  promptArg?: string;
  maxBudgetUsd?: number; // runaway guard for goal loops
  maxTurns?: number; // explicit turn cap so a phase doesn't hit the CLI default and exit 1
}): { cmd: string; args: string[] } {
  const args = [
    "-p", opts.promptArg ?? "-",
    "--output-format", opts.outputFormat ?? "text",
    "--model", resolveModel("claude"),
    "--no-session-persistence",
  ];
  if (opts.maxTurns && opts.maxTurns > 0) {
    args.push("--max-turns", String(opts.maxTurns));
  }
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.allowedTools) args.push("--allowedTools", opts.allowedTools);
  return { cmd: "claude", args };
}

function buildCodexCmd(opts: { readOnly: boolean }): { cmd: string; args: string[] } {
  const args = [
    "exec",
    "-m", resolveModel("codex"),
    "-c", CODEX_REASONING_EFFORT_MEDIUM,
    "--ephemeral", "--json",
  ];
  if (opts.readOnly) args.push("-s", "read-only");
  else args.push("--full-auto");
  args.push("-");
  return { cmd: "codex", args };
}

async function runImplementationAgent(
  agent: AgentName,
  prompt: string,
  worktreePath: string,
  timeoutSec: number,
  goalCondition: string | null = null,
  goalMaxBudgetUsd: number | null = null,
): Promise<ImplementOutcome> {
  const t0 = process.hrtime.bigint();
  const out: ImplementOutcome = {
    diff: "",
    files_changed: [],
    lines_added: 0,
    lines_removed: 0,
    test_passed: null,
    raw_output: "",
    error: null,
    duration_s: 0,
    api_key_fallback: false,
  };

  if (!isAgentEnabled(agent)) {
    out.error = "agent_disabled";
    out.duration_s = elapsedSec(t0);
    return out;
  }

  let cmd: string;
  let args: string[];
  let stdin: string | undefined;
  let geminiHome: string | null = null;
  let agentTempDir: string | null = null;
  let env: NodeJS.ProcessEnv;

  try {
    if (agent === "claude") {
      // Build the env (and its temp dir) FIRST so goal mode can stage the prompt
      // file inside it — outside the worktree, so it never pollutes collectDiff.
      const built = await buildAgentEnv("claude", "implementation");
      env = built.env; agentTempDir = built.tempDir;
      if (goalCondition) {
        // Goal-driven lead: Claude Code caps the `/goal` ARGUMENT at 4000 chars,
        // so an inlined multi-KB implement prompt silently no-ops the loop (it
        // prints "Goal condition is limited to 4000 characters" and exits 0 with
        // an empty diff). Instead, write the full prompt to a file and keep the
        // `/goal` argument short, pointing the lead at that file — the lead reads
        // it with its Read tool, then loops until the condition holds. The lead
        // never commits (the dispatcher owns git), so the condition omits it.
        const promptFile = path.join(agentTempDir, "implement-prompt.md");
        writeFileSync(promptFile, prompt, "utf8");
        const goalPrompt =
          `/goal Read the full task specification in the file ${promptFile}, ` +
          `then implement it completely in this repository. ` +
          `Done when: ${goalCondition}.`;
        const c = buildClaudeCmd({
          allowedTools: "Edit,Write,Read,Bash,Glob,Grep",
          promptArg: goalPrompt,
          maxBudgetUsd: goalMaxBudgetUsd ?? undefined,
          maxTurns: LEAD_MAX_TURNS,
        });
        cmd = c.cmd; args = c.args; stdin = undefined;
      } else {
        const c = buildClaudeCmd({
          allowedTools: "Edit,Write,Read,Bash,Glob,Grep",
          maxTurns: LEAD_MAX_TURNS,
          maxBudgetUsd: LEAD_MAX_BUDGET_USD,
        });
        cmd = c.cmd; args = c.args; stdin = prompt;
      }
    } else if (agent === "codex") {
      const c = buildCodexCmd({ readOnly: false });
      cmd = c.cmd; args = c.args; stdin = prompt;
      const built = await buildAgentEnv("codex", "implementation");
      env = built.env; agentTempDir = built.tempDir;
    } else {
      geminiHome = setupGeminiHome("gemini-copilot-lead-", worktreePath, "copilot");
      cmd = "gemini";
      args = ["-m", resolveModel("gemini"), "-p", prompt, "--yolo"];
      env = makeGeminiEnv(geminiHome);
    }
  } catch (err) {
    out.error = `env_setup_failed:${(err as Error).message}`;
    out.duration_s = elapsedSec(t0);
    return out;
  }

  try {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await run(cmd, args, { cwd: worktreePath, env, stdin, timeoutSec });
      if (res.notFound) {
        out.error = "agent_unavailable";
        out.duration_s = elapsedSec(t0);
        return out;
      }
      if (res.timedOut) {
        // A lead timeout is TERMINAL — do NOT retry. The lead was already granted the
        // full `timeoutSec` budget; re-running it from scratch consumes a SECOND full
        // window (worst case ~2×timeoutSec of wall-clock). In goal mode the /goal loop
        // reliably spends the whole budget iterating on tests, so a timeout there is
        // common, and the 2× blowup pushes the dispatch past the host's background-
        // process reap limit — the run is killed with no verdict (empty result JSON).
        // Fail fast instead so the orchestrator can re-dispatch with a larger --timeout
        // (or without goal mode). Transient CLI errors below still get one bounded retry.
        out.error = "timeout";
        out.duration_s = elapsedSec(t0);
        return out;
      }
      if (res.code !== 0) {
        const stderrSnippet = res.stderr.slice(0, 500);
        process.stderr.write(
          `  [${agent}] CLI error (exit ${res.code}): ${stderrSnippet}\n`,
        );
        if (
          agent === "gemini" &&
          attempt < maxAttempts &&
          shouldFallbackToApiKey(stderrSnippet) &&
          (await tryGeminiApiKeyFallback(env, "lead", stderrSnippet))
        ) {
          out.api_key_fallback = true;
          await sleep(2_000);
          continue;
        }
        if (attempt < maxAttempts) {
          await sleep(5_000 * attempt);
          continue;
        }
        out.error = "cli_error";
        out.duration_s = elapsedSec(t0);
        return out;
      }
      let raw = res.stdout;
      if (agent === "codex") raw = parseCodexJsonl(raw);
      else if (agent === "gemini") raw = parseGeminiJson(raw);
      out.raw_output = raw;
      break;
    }
  } finally {
    if (geminiHome) {
      try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (agentTempDir) releaseAgentTempDir(agentTempDir);
  }

  try {
    const d = await collectDiff(worktreePath);
    out.diff = d.diff;
    out.files_changed = d.files;
    out.lines_added = d.added;
    out.lines_removed = d.removed;
  } catch (err) {
    out.error = `diff_collection_failed:${(err as Error).message}`;
  }
  out.duration_s = elapsedSec(t0);
  return out;
}

async function runWingReview(
  wing: AgentName,
  reviewPayload: string,
  cwd: string,
  timeoutSec: number,
): Promise<{ raw: string; error: string | null }> {
  if (!isAgentEnabled(wing)) return { raw: "", error: "agent_disabled" };

  let cmd: string;
  let args: string[];
  let stdin: string | undefined;
  let geminiHome: string | null = null;
  let agentTempDir: string | null = null;
  let env: NodeJS.ProcessEnv;

  try {
    if (wing === "claude") {
      const c = buildClaudeCmd({ allowedTools: "Read,Glob,Grep" });
      cmd = c.cmd; args = c.args; stdin = reviewPayload;
      const built = await buildAgentEnv("claude", "review");
      env = built.env; agentTempDir = built.tempDir;
    } else if (wing === "codex") {
      const c = buildCodexCmd({ readOnly: true });
      cmd = c.cmd; args = c.args; stdin = reviewPayload;
      const built = await buildAgentEnv("codex", "review");
      env = built.env; agentTempDir = built.tempDir;
    } else {
      geminiHome = setupGeminiHome("gemini-copilot-wing-", cwd, "copilot", "plan");
      cmd = "gemini";
      args = ["-m", resolveModel("gemini"), "--skip-trust", "-p", reviewPayload];
      env = makeGeminiEnv(geminiHome);
    }
  } catch (err) {
    return { raw: "", error: `env_setup_failed:${(err as Error).message}` };
  }

  const callRun = async (): Promise<Awaited<ReturnType<typeof run>>> => {
    return await run(cmd, args, { cwd, env, stdin, timeoutSec });
  };

  try {
    let res = await callRun();
    if (res.notFound) return { raw: "", error: "agent_unavailable" };
    if (res.timedOut) return { raw: "", error: "timeout" };

    if (res.code !== 0) {
      const stderrSnippet = res.stderr.slice(0, 500);
      if (
        wing === "gemini" &&
        shouldFallbackToApiKey(stderrSnippet) &&
        (await tryGeminiApiKeyFallback(env, "wing-review", stderrSnippet))
      ) {
        res = await callRun();
        if (res.notFound) return { raw: "", error: "agent_unavailable" };
        if (res.timedOut) return { raw: "", error: "timeout" };
        if (res.code !== 0) return { raw: res.stderr.slice(0, 500), error: "cli_error" };
      } else {
        return { raw: stderrSnippet, error: "cli_error" };
      }
    }

    let raw = res.stdout;
    if (wing === "codex") raw = parseCodexJsonl(raw);
    else if (wing === "gemini") raw = parseGeminiJson(raw);
    return { raw, error: null };
  } finally {
    if (geminiHome) {
      try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    if (agentTempDir) releaseAgentTempDir(agentTempDir);
  }
}

// Prompt builders ---------------------------------------------------------

export function buildReviewPayload(
  reviewPrompt: string,
  stepTask: string,
  diff: string,
  testPassed: boolean | null,
  priorRounds: ReadonlyArray<Pick<RoundResult, "round_num" | "verdict" | "blocking_findings" | "summary">>,
): string {
  const testWord = testPassed === true ? "passed" : testPassed === false ? "failed" : "no test command";
  const parts: string[] = [
    reviewPrompt,
    "\n\n## Step task being implemented\n",
    stepTask,
    "\n\n## Test result\n",
    testWord,
    "\n\n## Diff under review\n```diff\n",
    diff.trim() ? diff : "(empty diff)",
    "\n```\n",
  ];
  if (priorRounds.length > 0) {
    parts.push("\n\n## Prior review history (most recent last)\n");
    for (const r of priorRounds) {
      parts.push(`\n### Round ${r.round_num}: ${r.verdict}\n`);
      if (r.blocking_findings.length > 0) {
        parts.push("Blocking findings:\n");
        for (const f of r.blocking_findings) parts.push(`- ${f}\n`);
      }
      if (r.summary) parts.push(`Summary: ${r.summary}\n`);
    }
  }
  return parts.join("");
}

export function buildFixPrompt(
  baseImplementPrompt: string,
  stepTask: string,
  findings: ReadonlyArray<string>,
  roundNum: number,
): string {
  const findingsBlock =
    findings.length > 0
      ? findings.map((f) => `- ${f}`).join("\n")
      : "(no findings — fix anyway)";
  return (
    `# Revision Round ${roundNum} — address wing reviewer findings\n\n` +
    "Your previous diff was reviewed by another AI agent (the wing reviewer). " +
    "It is not approved yet. Address every blocking finding below, then stop.\n\n" +
    "## Wing's blocking findings (verbatim)\n" +
    `${findingsBlock}\n\n` +
    "## Original step task (for reference)\n" +
    `${stepTask}\n\n` +
    "## Your prior implementation prompt (for context)\n" +
    `${baseImplementPrompt}\n\n` +
    "Make the minimum changes needed to resolve the findings. Do NOT commit. " +
    "Re-run tests if a test command was provided."
  );
}

// Test command tokenizer (POSIX-ish; no shell invocation) -----------------

export function tokenizeShell(cmd: string): string[] {
  const out: string[] = [];
  let buf = "";
  let i = 0;
  let quote: '"' | "'" | null = null;
  while (i < cmd.length) {
    const ch = cmd[i]!;
    if (quote) {
      if (ch === quote) { quote = null; i++; continue; }
      if (quote === '"' && ch === "\\" && i + 1 < cmd.length) {
        buf += cmd[i + 1]!; i += 2; continue;
      }
      buf += ch; i++; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch as '"' | "'"; i++; continue; }
    if (ch === "\\" && i + 1 < cmd.length) { buf += cmd[i + 1]!; i += 2; continue; }
    if (/\s/.test(ch)) {
      if (buf) { out.push(buf); buf = ""; }
      i++; continue;
    }
    buf += ch; i++;
  }
  if (quote) throw new Error(`unterminated quote in test_command: ${cmd}`);
  if (buf) out.push(buf);
  return out;
}

async function runTestCommand(
  testCommand: string | null,
  worktreePath: string,
): Promise<{ passed: boolean | null; output: string }> {
  if (!testCommand) return { passed: null, output: "" };
  let argv: string[];
  try { argv = tokenizeShell(testCommand); }
  catch (e) { return { passed: false, output: `Test command parse failed: ${(e as Error).message}` }; }
  if (argv.length === 0) return { passed: null, output: "" };
  const res = await run(argv[0]!, argv.slice(1), {
    cwd: worktreePath,
    timeoutSec: TEST_TIMEOUT_SEC,
    env: process.env,
  });
  if (res.notFound) return { passed: false, output: `Test command not found: ${argv[0]}` };
  if (res.timedOut) return { passed: false, output: `Test timed out after ${TEST_TIMEOUT_SEC}s` };
  const tail = (s: string, n: number): string => (s.length > n ? s.slice(-n) : s);
  return {
    passed: res.code === 0,
    output: tail(res.stdout, 2000) + tail(res.stderr, 1000),
  };
}

// Main loop ---------------------------------------------------------------

export type FinalVerdict =
  | "approved"
  | "blocked"
  | "aborted"
  | "max_rounds_unresolved"
  | "unresolved";

export interface CopilotResult {
  step_id: string;
  lead: AgentName;
  wing: AgentName;
  worktree_path: string;
  final_verdict: FinalVerdict;
  error: string | null;
  duration_s: number;
  rounds: Array<{
    round: number;
    files_changed: string[];
    lines_added: number;
    lines_removed: number;
    diff_length: number;
    test_passed: boolean | null;
    verdict: string;
    blocking_findings: string[];
    non_blocking_suggestions: string[];
    summary: string;
    parse_retry_used: boolean;
    duration_s: number;
    error: string | null;
  }>;
  final_diff: string;
}

export interface RunCopilotOpts {
  repoRoot: string;
  stepId: string;
  implementPrompt: string;
  reviewPrompt: string;
  stepTask: string;
  lead: AgentName;
  wing: AgentName;
  maxRounds: number;
  timeoutSec: number;
  wingTimeoutSec: number;
  testCommand: string | null;
  // When set (and lead === "claude"), the lead runs as a Claude Code /goal loop
  // that iterates until the condition holds. null/undefined → single-pass (legacy).
  goalCondition?: string | null;
  goalMaxBudgetUsd?: number | null;
}

interface PreflightFailure {
  step_id: string;
  lead?: AgentName;
  wing?: AgentName;
  error: string;
  rounds: [];
}

export async function runCopilotStep(
  opts: RunCopilotOpts,
): Promise<CopilotResult | PreflightFailure> {
  const { repoRoot, stepId, implementPrompt, reviewPrompt, stepTask, lead, wing,
    maxRounds, timeoutSec, wingTimeoutSec, testCommand } = opts;
  // Goal mode only applies to a claude lead (/goal is a Claude Code feature).
  const goalCondition = lead === "claude" ? (opts.goalCondition ?? null) : null;
  // When goal mode is active the budget is a mandatory runaway guard: a null,
  // NaN, or non-positive value must NOT silently disable it — fall back to the
  // documented default rather than running unbounded.
  const goalMaxBudgetUsd = goalCondition
    ? (Number.isFinite(opts.goalMaxBudgetUsd) && (opts.goalMaxBudgetUsd as number) > 0
        ? (opts.goalMaxBudgetUsd as number)
        : DEFAULT_GOAL_MAX_BUDGET_USD)
    : null;

  if (lead === wing) return { step_id: stepId, error: "lead_eq_wing", rounds: [] };
  if (!VALID_AGENTS.includes(lead) || !VALID_AGENTS.includes(wing)) {
    return { step_id: stepId, error: "invalid_agent", rounds: [] };
  }
  if (!isAgentEnabled(lead)) {
    return { step_id: stepId, error: `lead_disabled:${lead}`, rounds: [] };
  }
  if (!isAgentEnabled(wing)) {
    return { step_id: stepId, error: `wing_disabled:${wing}`, rounds: [] };
  }

  const t0 = process.hrtime.bigint();
  const rounds: RoundResult[] = [];

  let worktreePath: string;
  try {
    worktreePath = await createWorktree(repoRoot, lead, stepId);
  } catch (err) {
    return {
      step_id: stepId,
      lead,
      wing,
      error: `worktree_create_failed: ${(err as Error).message}`,
      rounds: [],
    };
  }

  // Round 1: lead implements --------------------------------------------
  const sr = await runImplementationAgent(lead, implementPrompt, worktreePath, timeoutSec, goalCondition, goalMaxBudgetUsd);
  const r1 = newRound(1);
  r1.diff = sr.diff;
  r1.files_changed = sr.files_changed;
  r1.lines_added = sr.lines_added;
  r1.lines_removed = sr.lines_removed;
  r1.test_passed = sr.test_passed;
  r1.error = sr.error;
  r1.duration_s = sr.duration_s;
  if (testCommand && !sr.error) {
    const { passed } = await runTestCommand(testCommand, worktreePath);
    if (passed !== null) r1.test_passed = passed;
  }
  if (sr.error) {
    rounds.push(r1);
    return buildResult(stepId, lead, wing, rounds, worktreePath, "aborted",
      `lead_round1_failed:${sr.error}`, elapsedSec(t0));
  }
  if (!sr.diff.trim()) {
    rounds.push(r1);
    return buildResult(stepId, lead, wing, rounds, worktreePath, "aborted",
      "lead_round1_empty_diff", elapsedSec(t0));
  }

  // Review-fix loop ------------------------------------------------------
  let finalVerdict: FinalVerdict = "unresolved";
  let error: string | null = null;
  let currentRound = r1;

  for (let roundNum = 1; roundNum <= maxRounds + 1; roundNum++) {
    const prior = rounds.slice();
    const payload = buildReviewPayload(
      reviewPrompt, stepTask, currentRound.diff, currentRound.test_passed, prior,
    );

    const preSnapshot = await snapshotWorktree(worktreePath);
    let wingResult = await runWingReview(wing, payload, worktreePath, wingTimeoutSec);
    if (wingResult.error === "timeout") {
      wingResult = await runWingReview(wing, payload, worktreePath, wingTimeoutSec);
    }
    const postSnapshot = await snapshotWorktree(worktreePath);

    if (preSnapshot[0] !== postSnapshot[0] || preSnapshot[1] !== postSnapshot[1]) {
      await restoreWorktree(worktreePath, preSnapshot);
      currentRound.wing_raw = wingResult.raw;
      currentRound.verdict = "unparseable";
      currentRound.blocking_findings = [
        "wing reviewer mutated the worktree — read-only contract violated; worktree restored",
      ];
      currentRound.summary = "Wing mutation detected; aborting.";
      rounds.push(currentRound);
      finalVerdict = "unresolved";
      error = "wing_mutation_detected";
      break;
    }

    if (wingResult.error) {
      currentRound.wing_raw = wingResult.raw;
      currentRound.verdict = "unparseable";
      currentRound.blocking_findings = [`wing review ${wingResult.error}`];
      currentRound.summary = `Wing dispatch error: ${wingResult.error}`;
      rounds.push(currentRound);
      finalVerdict = "unresolved";
      error = `wing_error:${wingResult.error}`;
      break;
    }

    let verdictObj = extractVerdictJson(wingResult.raw);
    let parseRetry = false;
    if (verdictObj === null) {
      const retryPayload =
        payload +
        "\n\n## CRITICAL\nYour previous response did not contain a parseable JSON " +
        "verdict block. Respond again ending with EXACTLY one ```json fenced block " +
        "containing keys verdict, blocking_findings, non_blocking_suggestions, summary.";
      const retryPre = await snapshotWorktree(worktreePath);
      const retry = await runWingReview(wing, retryPayload, worktreePath, wingTimeoutSec);
      const retryPost = await snapshotWorktree(worktreePath);
      if (retryPre[0] !== retryPost[0] || retryPre[1] !== retryPost[1]) {
        await restoreWorktree(worktreePath, retryPre);
        currentRound.wing_raw = retry.raw;
        currentRound.verdict = "unparseable";
        currentRound.blocking_findings = [
          "wing reviewer mutated the worktree on parse-retry — read-only contract violated; worktree restored",
        ];
        currentRound.summary = "Wing mutation detected on parse-retry; aborting.";
        rounds.push(currentRound);
        finalVerdict = "unresolved";
        error = "wing_mutation_detected";
        break;
      }
      parseRetry = true;
      wingResult = retry;
      if (!retry.error) verdictObj = extractVerdictJson(retry.raw);
    }

    currentRound.wing_raw = wingResult.raw;
    currentRound.parse_retry_used = parseRetry;

    if (verdictObj === null) {
      currentRound.verdict = "revise";
      currentRound.blocking_findings = [
        "wing review failed to parse — manual inspection required",
      ];
      currentRound.summary = "Unparseable verdict; treated as revise.";
    } else {
      const n = normalizeVerdict(verdictObj);
      currentRound.verdict = n.verdict;
      currentRound.blocking_findings = n.blocking;
      currentRound.suggestions = n.suggestions;
      currentRound.summary = n.summary;
    }

    rounds.push(currentRound);

    if (currentRound.verdict === "approve") {
      finalVerdict = "approved";
      break;
    }
    if (currentRound.verdict === "block") {
      finalVerdict = "blocked";
      error = "wing_blocked";
      break;
    }

    if (roundNum > maxRounds) {
      finalVerdict = "max_rounds_unresolved";
      error = `unresolved_after_${maxRounds}_fix_rounds`;
      break;
    }

    const nextRoundNum = roundNum + 1;
    const fixPrompt = buildFixPrompt(
      implementPrompt, stepTask, currentRound.blocking_findings, nextRoundNum,
    );
    const srFix = await runImplementationAgent(lead, fixPrompt, worktreePath, timeoutSec, goalCondition, goalMaxBudgetUsd);
    const nextRound = newRound(nextRoundNum);
    nextRound.diff = srFix.diff;
    nextRound.files_changed = srFix.files_changed;
    nextRound.lines_added = srFix.lines_added;
    nextRound.lines_removed = srFix.lines_removed;
    nextRound.test_passed = srFix.test_passed;
    nextRound.error = srFix.error;
    nextRound.duration_s = srFix.duration_s;
    if (testCommand && !srFix.error) {
      const { passed } = await runTestCommand(testCommand, worktreePath);
      if (passed !== null) nextRound.test_passed = passed;
    }
    if (srFix.error) {
      rounds.push(nextRound);
      finalVerdict = "unresolved";
      error = `lead_fix_round_failed:${srFix.error}`;
      break;
    }

    if (nextRound.diff.trim() === currentRound.diff.trim()) {
      rounds.push(nextRound);
      finalVerdict = "unresolved";
      error = "lead_fix_round_no_change";
      break;
    }

    currentRound = nextRound;
  }

  return buildResult(stepId, lead, wing, rounds, worktreePath, finalVerdict, error, elapsedSec(t0));
}

function buildResult(
  stepId: string,
  lead: AgentName,
  wing: AgentName,
  rounds: RoundResult[],
  worktreePath: string,
  finalVerdict: FinalVerdict,
  error: string | null,
  totalDuration: number,
): CopilotResult {
  const finalRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  return {
    step_id: stepId,
    lead,
    wing,
    worktree_path: worktreePath,
    final_verdict: finalVerdict,
    error,
    duration_s: totalDuration,
    rounds: rounds.map((r) => ({
      round: r.round_num,
      files_changed: r.files_changed,
      lines_added: r.lines_added,
      lines_removed: r.lines_removed,
      diff_length: r.diff.length,
      test_passed: r.test_passed,
      verdict: r.verdict,
      blocking_findings: r.blocking_findings,
      non_blocking_suggestions: r.suggestions,
      summary: r.summary,
      parse_retry_used: r.parse_retry_used,
      duration_s: r.duration_s,
      error: r.error,
    })),
    final_diff: finalRound ? finalRound.diff : "",
  };
}

export async function cleanupStep(
  repoRoot: string,
  stepId: string,
  lead: AgentName,
): Promise<void> {
  const safeLead = sanitizeRef(lead);
  const safeStep = sanitizeRef(stepId);
  const branchName = `autopilot/${safeLead}/${safeStep}`;
  const worktreeDir = path.join(repoRoot, ".worktrees", `autopilot-${safeLead}-${safeStep}`);
  await cleanupWorktree(repoRoot, worktreeDir, branchName);
}

// Helpers -----------------------------------------------------------------

function elapsedSec(t0: bigint): number {
  const ns = process.hrtime.bigint() - t0;
  return Number(ns) / 1e9;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// CLI ---------------------------------------------------------------------

interface CliArgs {
  repoRoot: string;
  stepId: string;
  implementPromptFile: string | null;
  reviewPromptFile: string | null;
  stepTaskFile: string | null;
  lead: AgentName;
  wing: AgentName;
  maxRounds: number;
  timeoutSec: number;
  wingTimeoutSec: number;
  testCommand: string | null;
  cleanup: boolean;
  goalCondition: string | null;
  goalMaxBudgetUsd: number | null;
}

function usage(): string {
  return [
    "Usage: copilot_dispatch.ts --repo-root DIR --step-id ID [options]",
    "",
    "Required:",
    "  --repo-root DIR",
    "  --step-id ID",
    "",
    "Required unless --cleanup:",
    "  --implement-prompt-file PATH    Lead's implement prompt",
    "  --review-prompt-file PATH       Wing's review prompt template",
    "  --step-task-file PATH           Step task description (shared context)",
    "",
    "Options:",
    `  --lead AGENT                    one of: ${VALID_AGENTS.join(", ")} (default ${DEFAULT_LEAD})`,
    `  --wing AGENT                    one of: ${VALID_AGENTS.join(", ")} (default ${DEFAULT_WING})`,
    `  --max-rounds N                  Max fix rounds (default ${DEFAULT_MAX_ROUNDS})`,
    `  --timeout N                     Per-lead-invocation timeout sec (default ${DEFAULT_TIMEOUT_SEC})`,
    `  --wing-timeout N                Per-wing-invocation timeout sec (default ${WING_TIMEOUT_DEFAULT_SEC})`,
    "  --test-command CMD              Optional test command to run after each round",
    "  --goal-condition TEXT           Run the claude lead as a /goal loop until TEXT holds",
    "                                  (ignored when lead is codex/gemini)",
    `  --goal-max-budget-usd N         Runaway guard for the goal loop (default ${DEFAULT_GOAL_MAX_BUDGET_USD}; must be > 0)`,
    "  --cleanup                       Remove the lead's worktree for --step-id and exit",
  ].join("\n");
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const args: CliArgs = {
    repoRoot: "",
    stepId: "",
    implementPromptFile: null,
    reviewPromptFile: null,
    stepTaskFile: null,
    lead: DEFAULT_LEAD,
    wing: DEFAULT_WING,
    maxRounds: DEFAULT_MAX_ROUNDS,
    timeoutSec: DEFAULT_TIMEOUT_SEC,
    wingTimeoutSec: WING_TIMEOUT_DEFAULT_SEC,
    testCommand: null,
    cleanup: false,
    goalCondition: null,
    goalMaxBudgetUsd: null,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${flag} requires a value`);
    return v;
  };
  const asAgent = (v: string, flag: string): AgentName => {
    if ((VALID_AGENTS as readonly string[]).includes(v)) return v as AgentName;
    throw new Error(`${flag} must be one of ${VALID_AGENTS.join(", ")} (got ${v})`);
  };
  const asInt = (v: string, flag: string): number => {
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`${flag} must be an integer (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--repo-root":            args.repoRoot = need(i, a); i++; break;
      case "--step-id":              args.stepId = need(i, a); i++; break;
      case "--implement-prompt-file": args.implementPromptFile = need(i, a); i++; break;
      case "--review-prompt-file":   args.reviewPromptFile = need(i, a); i++; break;
      case "--step-task-file":       args.stepTaskFile = need(i, a); i++; break;
      case "--lead":                 args.lead = asAgent(need(i, a), a); i++; break;
      case "--wing":                 args.wing = asAgent(need(i, a), a); i++; break;
      case "--max-rounds":           args.maxRounds = asInt(need(i, a), a); i++; break;
      case "--timeout":              args.timeoutSec = asInt(need(i, a), a); i++; break;
      case "--wing-timeout":         args.wingTimeoutSec = asInt(need(i, a), a); i++; break;
      case "--test-command":         args.testCommand = need(i, a); i++; break;
      case "--goal-condition":       args.goalCondition = need(i, a); i++; break;
      case "--goal-max-budget-usd": {
        const v = Number.parseFloat(need(i, a));
        if (!Number.isFinite(v) || v <= 0) {
          throw new Error(`${a} must be a positive number (got ${argv[i + 1]})`);
        }
        args.goalMaxBudgetUsd = v; i++; break;
      }
      case "--cleanup":              args.cleanup = true; break;
      case "-h": case "--help":      process.stdout.write(usage() + "\n"); process.exit(0);
      default: throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!args.repoRoot) throw new Error("--repo-root is required");
  if (!args.stepId) throw new Error("--step-id is required");
  if (args.maxRounds < 0) throw new Error("--max-rounds must be >= 0");
  if (args.timeoutSec <= 0) throw new Error("--timeout must be > 0");
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

  if (args.cleanup) {
    await cleanupStep(args.repoRoot, args.stepId, args.lead);
    process.stdout.write(
      `Cleaned up copilot worktree for ${args.stepId} (lead=${args.lead})\n`,
    );
    return 0;
  }

  if (!args.implementPromptFile || !args.reviewPromptFile || !args.stepTaskFile) {
    process.stderr.write(
      "error: --implement-prompt-file, --review-prompt-file, --step-task-file are required unless --cleanup\n",
    );
    return 2;
  }

  const [implementPrompt, reviewPrompt, stepTask] = await Promise.all([
    readFile(args.implementPromptFile, "utf-8"),
    readFile(args.reviewPromptFile, "utf-8"),
    readFile(args.stepTaskFile, "utf-8"),
  ]);

  const result: CopilotResult | PreflightFailure = await runCopilotStep({
    repoRoot: args.repoRoot,
    stepId: args.stepId,
    implementPrompt,
    reviewPrompt,
    stepTask,
    lead: args.lead,
    wing: args.wing,
    maxRounds: args.maxRounds,
    timeoutSec: args.timeoutSec,
    wingTimeoutSec: args.wingTimeoutSec,
    testCommand: args.testCommand,
    goalCondition: args.goalCondition,
    goalMaxBudgetUsd: args.goalMaxBudgetUsd,
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return (result as CopilotResult).final_verdict === "approved" ? 0 : 1;
}

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
