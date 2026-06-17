/**
 * Isolated subprocess environments — TypeScript port of
 * `scripts/runtime_env.py`.
 *
 * Controls which env vars reach CLI subprocesses, injects GitHub App
 * tokens for operations that need repo access, manages process-scoped
 * temp dirs, and injects ANTHROPIC_API_KEY (from the ANTHROPIC_AGENTS
 * host var) for the claude agent while keeping it out of codex/gemini.
 *
 * The Python imported `config_loader` + shelled out to `github_app.ts`;
 * this port reads config via `stark_config_lib.ts` and mints tokens by
 * importing `github_app_lib.ts` directly.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { getToken, resolveAppName } from "./github_app_lib.ts";
import { getRuntimeConfig, loadGlobalConfig } from "./stark_config_lib.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Operations that require a GitHub App token (review bot identity). */
const GH_TOKEN_OPS: ReadonlySet<string> = new Set(["review"]);

/** Operations using the user's native gh auth — no bot token injected. */
const USER_AUTH_OPS: ReadonlySet<string> = new Set([
  "pr_create",
  "issue_ops",
  "local",
]);

/** Host env var holding the Anthropic API key. */
const API_KEY_SOURCE_VAR = "ANTHROPIC_AGENTS";

/** Host env keys that must NEVER appear verbatim in subprocess envs. */
const BLOCKED_KEYS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  API_KEY_SOURCE_VAR,
]);

// ---------------------------------------------------------------------------
// Process-scoped temp dirs
// ---------------------------------------------------------------------------

const trackedTempDirs: string[] = [];
let exitHandlerRegistered = false;

function registerExitCleanup(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  process.on("exit", () => {
    for (const dir of trackedTempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
}

/**
 * Remove temp dirs from dead processes. Format: `/tmp/{prefix}-{pid}-{uuid8}`.
 */
export function cleanupStaleTempDirs(prefix: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync("/tmp");
  } catch {
    return;
  }
  const marker = `${prefix}-`;
  for (const name of entries) {
    if (!name.startsWith(marker)) continue;
    const full = `/tmp/${name}`;
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const pidStr = name.slice(marker.length).split("-")[0];
    const pid = Number(pidStr);
    if (!Number.isInteger(pid) || pidStr === "" || !/^\d+$/.test(pidStr)) {
      continue;
    }
    try {
      process.kill(pid, 0); // probe — alive, skip
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // Process is dead — remove the stale dir.
        try {
          fs.rmSync(full, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      // EPERM → alive but owned by another user → skip.
    }
  }
}

let cleanupDone = false;

function runCleanupOnce(prefix: string): void {
  if (!cleanupDone) {
    cleanupStaleTempDirs(prefix);
    cleanupDone = true;
  }
}

/** Create a process-scoped temp dir (mode 0o700), cleaned up on exit. */
export function makeTempDir(prefix: string): string {
  const uid8 = randomUUID().replace(/-/g, "").slice(0, 8);
  const dir = `/tmp/${prefix}-${process.pid}-${uid8}`;
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  trackedTempDirs.push(dir);
  registerExitCleanup();
  return dir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a sanitized environment for a subagent subprocess.
 *
 * @param agent      "claude", "codex", or "gemini".
 * @param operation  "review", "pr_create", "issue_ops", "local", or other.
 *
 * ANTHROPIC_API_KEY is injected for the claude agent (sourced from
 * ANTHROPIC_AGENTS) and absent from codex/gemini envs. GH_TOKEN is
 * present only when `operation === "review"`.
 */
export async function buildAgentEnv(
  agent: string,
  operation: string,
): Promise<Record<string, string>> {
  const runtimeCfg = getRuntimeConfig();
  const fullCfg = loadGlobalConfig();

  const allowlist = new Set(runtimeCfg.subagent_env_allowlist);
  const githubAppsRaw = fullCfg["github_apps"];
  const githubApps: Record<string, string> =
    githubAppsRaw && typeof githubAppsRaw === "object" && !Array.isArray(githubAppsRaw)
      ? (githubAppsRaw as Record<string, string>)
      : {};

  // Start from allowlisted host env keys, excluding blocked keys.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && allowlist.has(k) && !BLOCKED_KEYS.has(k)) {
      env[k] = v;
    }
  }

  // Always propagate CLAUDE_PLUGIN_ROOT (when set) so any stark tool a
  // sub-agent shells out to resolves its vendored assets (config/prompts/tools)
  // from the same installed-plugin dir. Structural runtime path, not a
  // user-tunable allowlist entry — injected unconditionally.
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot && pluginRoot.trim() !== "") {
    env["CLAUDE_PLUGIN_ROOT"] = pluginRoot;
  }

  // Inject ANTHROPIC_API_KEY for the claude agent, from ANTHROPIC_AGENTS.
  if (agent === "claude") {
    const sourceKey = process.env[API_KEY_SOURCE_VAR];
    if (!sourceKey) {
      throw new Error(
        `${API_KEY_SOURCE_VAR} not set in environment. ` +
          "Source your Anthropic key file before dispatching claude.",
      );
    }
    env["ANTHROPIC_API_KEY"] = sourceKey;
  }

  // GH_TOKEN: inject the bot token only for review operations.
  if (GH_TOKEN_OPS.has(operation)) {
    const appName = githubApps[agent] ?? `stark-${agent}`;
    env["GH_TOKEN"] = await getToken({ app: resolveAppName(appName) });
  } else if (!USER_AUTH_OPS.has(operation)) {
    process.stderr.write(
      `runtime_env: warning: unknown operation '${operation}' for agent ` +
        `'${agent}'; defaulting to no GH_TOKEN\n`,
    );
  }

  // Final safety rails — never leak the raw source key var.
  delete env[API_KEY_SOURCE_VAR];
  if (agent !== "claude") delete env["ANTHROPIC_API_KEY"];

  // Temp dir lifecycle: create a process-scoped dir and inject its path.
  const prefix = runtimeCfg.temp_dir_prefix || "stark-env";
  runCleanupOnce(prefix);
  env["STARK_AGENT_TMPDIR"] = makeTempDir(prefix);

  return env;
}
