/**
 * Gemini CLI integration helpers — TypeScript port of `scripts/gemini_utils.py`.
 *
 * Constants and helpers shared by the dispatch orchestrators that invoke
 * the Gemini CLI: model resolution, isolated `GEMINI_CLI_HOME` setup,
 * Vertex-AI env construction, API-key fallback, and output parsing.
 *
 * The Python imported `config_loader`; this port reads config via
 * `stark_config_lib.ts`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentDisabledError } from "./agent_disabled_error.ts";
import { getModelId, isAgentEnabled } from "./stark_config_lib.ts";
import { resolveVertexLocation, resolveVertexProject } from "./vertex_config_lib.ts";

export { AgentDisabledError };

/** Default model — pinned to avoid auto-routing unpredictability. */
export const GEMINI_MODEL = "gemini-3.1-pro-preview";

/** Resolve the configured Gemini model. Throws if the agent is disabled. */
export function getGeminiModel(): string {
  if (!isAgentEnabled("gemini")) {
    throw new AgentDisabledError("gemini agent is disabled in config");
  }
  return getModelId("gemini") || GEMINI_MODEL;
}

// Files copied from the real Gemini home to isolated session dirs.
// settings.json is intentionally excluded — a fresh Vertex-AI config is
// written into each isolated home (see setupGeminiHome).
const AUTH_FILES = ["oauth_creds.json", "google_accounts.json", "installation_id"];

// Vertex AI project/location are resolved at dispatch time via
// vertex_config_lib (env > config > GOOGLE_CLOUD_PROJECT > gcloud-derived).
// No project id is hardcoded here — see resolveVertexProject/Location.

// ---------------------------------------------------------------------------
// API key fallback
// ---------------------------------------------------------------------------

// null = not checked yet; "" = checked, absent; non-empty = the key.
let geminiApiKeyCache: string | null = null;

const RED = "\x1b[1;31m";
const RED_BG = "\x1b[1;37;41m";
const RESET = "\x1b[0m";

function fallbackLogPath(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "code-review",
    "gemini-api-key-fallback.log",
  );
}

/** Retrieve the Gemini API key from the macOS Keychain (cached). */
export function getGeminiApiKey(): string | null {
  if (geminiApiKeyCache !== null) return geminiApiKeyCache || null;
  try {
    const r = spawnSync(
      "security",
      ["find-generic-password", "-s", "GEMINI_API_KEY", "-w"],
      { encoding: "utf8", timeout: 5000 },
    );
    if (r.status === 0 && (r.stdout ?? "").trim()) {
      geminiApiKeyCache = r.stdout.trim();
      return geminiApiKeyCache;
    }
  } catch {
    // fall through
  }
  geminiApiKeyCache = "";
  return null;
}

/** Test seam — reset the module-level API-key cache. */
export function __resetGeminiApiKeyCache(): void {
  geminiApiKeyCache = null;
}

/** Log an API-key fallback event to stderr (red) and a persistent file. */
export function logApiKeyFallback(agent: string, task: string, reason: string): void {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const border = `${RED_BG}${"=".repeat(60)}${RESET}`;
  process.stderr.write(`${border}\n`);
  process.stderr.write(`${RED_BG}  GEMINI API KEY FALLBACK  ${RESET}\n`);
  process.stderr.write(`${RED}  Agent: ${agent}:${task}${RESET}\n`);
  process.stderr.write(`${RED}  Reason: ${reason}${RESET}\n`);
  process.stderr.write(
    `${RED}  Vertex AI auth failed -> using GEMINI_API_KEY from Keychain${RESET}\n`,
  );
  process.stderr.write(`${border}\n`);
  try {
    fs.mkdirSync(path.dirname(fallbackLogPath()), { recursive: true });
    fs.appendFileSync(fallbackLogPath(), `${ts}  ${agent}:${task}  reason=${reason}\n`);
  } catch {
    // best-effort
  }
}

/** Error fragments that indicate a Vertex AI auth failure (API-key retryable). */
export const GEMINI_AUTH_ERROR_PATTERNS = [
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
];

/** True if a Gemini CLI error looks like a Vertex AI auth failure. */
export function shouldFallbackToApiKey(stderr: string): boolean {
  return GEMINI_AUTH_ERROR_PATTERNS.some((p) => stderr.includes(p));
}

export interface RunKwargs {
  env?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Attempt Gemini API-key fallback after a Vertex AI auth error. Mutates
 * `runKwargs.env` in place to inject `GEMINI_API_KEY` and switch the
 * isolated home + env off Vertex auth. Returns true if fallback was
 * applied (caller should retry), false otherwise.
 */
export function tryGeminiApiKeyFallback(
  runKwargs: RunKwargs,
  contextLabel: string,
  stderrSnippet: string,
  keyLookup: () => string | null = getGeminiApiKey,
): boolean {
  const apiKey = keyLookup();
  if (!apiKey || !runKwargs.env) return false;
  logApiKeyFallback("gemini", contextLabel, stderrSnippet.slice(0, 120));
  const env = runKwargs.env;
  env.GEMINI_API_KEY = apiKey;
  env.GOOGLE_GENAI_USE_VERTEXAI = "false";
  for (const v of [
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ]) {
    delete env[v];
  }
  const home = env.GEMINI_CLI_HOME;
  if (home) {
    const settingsPath = path.join(home, ".gemini", "settings.json");
    try {
      // Localized loose typing — this is opaque on-disk JSON we munge.
      let existing: Record<string, any> = {};
      if (fs.existsSync(settingsPath)) {
        existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      }
      const security = (existing.security ??= {});
      const auth = (security.auth ??= {});
      auth.selectedType = "gemini-api-key";
      delete auth.vertexAi;
      existing.selectedAuthType = "gemini-api-key";
      fs.writeFileSync(settingsPath, JSON.stringify(existing));
    } catch {
      // best-effort
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

/**
 * Create an isolated `GEMINI_CLI_HOME` with auth files + project scope.
 * Writes a fresh settings.json forcing Vertex-AI auth with the global
 * region. Returns the path to the temp home (caller must clean up).
 */
export function setupGeminiHome(
  prefix: string,
  projectDir: string,
  projectLabel = "session",
  approvalMode?: string,
): string {
  const geminiHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const geminiDir = path.join(geminiHome, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });

  const realGemini = process.env.GEMINI_CLI_HOME || os.homedir();
  const realGeminiDir = path.join(realGemini, ".gemini");
  for (const authFile of AUTH_FILES) {
    const src = path.join(realGeminiDir, authFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(geminiDir, authFile));
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
  if (approvalMode) settings.defaultApprovalMode = approvalMode;
  fs.writeFileSync(path.join(geminiDir, "settings.json"), JSON.stringify(settings));
  fs.writeFileSync(
    path.join(geminiDir, "projects.json"),
    JSON.stringify({ projects: { [projectDir]: projectLabel } }),
  );

  return geminiHome;
}

/**
 * Run `fn` with an isolated Gemini home, cleaning it up afterwards —
 * the equivalent of the Python `gemini_session` context manager.
 */
export async function withGeminiSession<T>(
  prefix: string,
  projectDir: string,
  projectLabel: string,
  approvalMode: string | undefined,
  fn: (home: string) => Promise<T> | T,
): Promise<T> {
  const home = setupGeminiHome(prefix, projectDir, projectLabel, approvalMode);
  try {
    return await fn(home);
  } finally {
    try {
      if (fs.statSync(home).isDirectory()) {
        fs.rmSync(home, { recursive: true, force: true });
      }
    } catch {
      // already gone
    }
  }
}

const BLOCKED_ENV_KEYS = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AGENTS"]);
const ALLOWED_ANTHROPIC_KEYS = new Set(["ANTHROPIC_CODE_CLI"]);

function defaultAdcPath(): string {
  return path.join(
    os.homedir(),
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
}

/**
 * Build the env for headless Gemini CLI dispatch via Vertex AI + ADC.
 * Strips Anthropic vars so Claude auth never leaks into the subprocess.
 */
export function makeGeminiEnv(
  geminiHome: string,
  options: { trustWorkspace?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (BLOCKED_ENV_KEYS.has(k)) continue;
    if (k.startsWith("ANTHROPIC_") && !ALLOWED_ANTHROPIC_KEYS.has(k)) continue;
    env[k] = v;
  }
  env.GEMINI_CLI_HOME = geminiHome;
  if (options.trustWorkspace) {
    env.GEMINI_CLI_TRUST_WORKSPACE = "true";
  }
  env.GOOGLE_GENAI_USE_VERTEXAI = "true";
  const project = resolveVertexProject();
  if (project) env.GOOGLE_CLOUD_PROJECT = project;
  env.GOOGLE_CLOUD_LOCATION = resolveVertexLocation();
  const adc = defaultAdcPath();
  if (!("GOOGLE_APPLICATION_CREDENTIALS" in env) && fs.existsSync(adc)) {
    env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Extract text from Gemini `-o json` output. Gemini wraps responses in
 * `{"response": "..."}` or an array of such objects. Returns the
 * unwrapped text, or the original `raw` if no envelope is detected.
 */
export function parseJsonOutput(raw: string): string {
  if (!raw.trim()) return raw;

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw;
  }

  if (obj && typeof obj === "object" && !Array.isArray(obj) && "response" in obj) {
    return String((obj as Record<string, unknown>).response);
  }
  if (Array.isArray(obj)) {
    const parts: string[] = [];
    for (const item of obj) {
      if (item && typeof item === "object" && !Array.isArray(item) && "response" in item) {
        parts.push(String((item as Record<string, unknown>).response));
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return raw;
}
