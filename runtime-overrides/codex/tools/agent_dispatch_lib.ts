/**
 * Agent dispatch primitives — the shared, reusable machinery for running a
 * headless model CLI (claude / codex / gemini) as a subprocess.
 *
 * This is a LIBRARY, not a CLI. It carries the pieces that more than one caller
 * needs: model/enablement resolution, the timeout- and stdin-aware `run()`
 * subprocess helper, the credential-scrubbed per-agent env builder (+ its
 * temp-dir lifecycle), the isolated-home Gemini setup with its Vertex→API-key
 * fallback, and the codex/gemini output parsers.
 *
 * Codex variant of `tools/agent_dispatch_lib.ts`. Extracted from the former
 * `copilot_dispatch.ts` when the `/stark-copilot` lead/wing workflow was retired
 * (STARK-2100); only the copilot-specific orchestration was deleted. Consumed by
 * this tree's `iac_review_lib.ts`. Shells out to `tools/github_app.ts` only when
 * a GitHub App token is actually required (operation="review").
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
import * as os from "node:os";
import * as path from "node:path";

import { assetConfigPath, stateRoot } from "./asset_root_lib.ts";
import { applyClaudeAuth } from "./claude_auth_lib.ts";
import { geminiAuthSettings, resolveGeminiAuthMode } from "./gemini_auth_lib.ts";
import { resolveVertexLocation, resolveVertexProject } from "./vertex_config_lib.ts";

// Constants ---------------------------------------------------------------

export const VALID_AGENTS = ["claude", "codex", "gemini"] as const;
export type AgentName = (typeof VALID_AGENTS)[number];

const CLAUDE_DEFAULT_MODEL = "claude-opus-5[1m]";
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";
const GEMINI_DEFAULT_MODEL = "gemini-3.1-pro-preview";

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
  stateRoot(),
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
      `agent_dispatch: failed to load ${CONFIG_PATH}: ${(err as Error).message}\n`,
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

// Utilities ---------------------------------------------------------------

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
        // Last resort: "close" needs BOTH the process to exit and every stdio
        // pipe to end, so a descendant that inherited stdout and outlived the
        // kill holds this promise open forever. After SIGKILL + a grace, tear
        // the pipes down and synthesize the result: destroy() emits "close",
        // never "end", so the tryFinish gate must be released by hand or this
        // does nothing. Same hang class fixed in jury_dispatch's realRunner;
        // this copy had it too.
        setTimeout(() => {
          if (settled) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
          stdoutEnded = true;
          stderrEnded = true;
          processClosed = true;
          closedResult ??= {
            code: null,
            signal: "SIGKILL",
            stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
            stderr: Buffer.concat(stderrChunks).toString("utf-8"),
            timedOut: true,
            notFound: false,
          };
          tryFinish();
        }, 2_000);
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
  const tmp = mkdtempSync(path.join(os.tmpdir(), `stark-agent-env-${process.pid}-`));
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
    // Subscription-only: leaves ANTHROPIC_API_KEY absent so the CLI uses the
    // logged-in account's OAuth creds. See claude_auth_lib.ts.
    applyClaudeAuth(env);
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
    [ts, "--app", appName, "token"],
    { timeoutSec: 30, env: process.env },
  );
  if (res.code !== 0) {
    process.stderr.write(
      `agent_dispatch: github_app token fetch failed (exit ${res.code}): ` +
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

  const auth = geminiAuthSettings(resolveGeminiAuthMode(), {
    projectId: resolveVertexProject() ?? undefined,
    region: resolveVertexLocation(),
  });
  const settings: Record<string, unknown> = {
    security: { auth },
    selectedAuthType: auth.selectedType,
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
  const vertexProject = resolveVertexProject();
  if (vertexProject) env["GOOGLE_CLOUD_PROJECT"] = vertexProject;
  if (resolveGeminiAuthMode() === "vertex") {
    env["GOOGLE_GENAI_USE_VERTEXAI"] = "true";
    env["GOOGLE_CLOUD_LOCATION"] = resolveVertexLocation();
    if (!env["GOOGLE_APPLICATION_CREDENTIALS"] && existsSync(DEFAULT_ADC_PATH)) {
      env["GOOGLE_APPLICATION_CREDENTIALS"] = DEFAULT_ADC_PATH;
    }
  } else {
    // oauth / api-key: Vertex env overrides the settings.json auth type
    // inside the CLI — keep it out. GOOGLE_CLOUD_PROJECT stays (Code
    // Assist licensing resolves through it in oauth mode).
    delete env["GOOGLE_GENAI_USE_VERTEXAI"];
    delete env["GOOGLE_APPLICATION_CREDENTIALS"];
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
