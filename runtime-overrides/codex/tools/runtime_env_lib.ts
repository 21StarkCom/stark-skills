/**
 * Credential-scrubbed subprocess environments with process-scoped temp dirs.
 * GitHub commands use the operator's existing gh login without token injection.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";

import { AGENT_ENV_ALLOWLIST, isCredentialEnvKey } from "./agent_env_lib.ts";
import { getRuntimeConfig } from "./stark_config_lib.ts";
import { applyClaudeAuth } from "./claude_auth_lib.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Recognized operations, using the operator's native gh login. */
const USER_AUTH_OPS: ReadonlySet<string> = new Set([
  "review",
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
 * Claude model auth follows `claude_auth_lib.ts` (subscription default;
 * ANTHROPIC_API_KEY injected only in api mode) and the key is always
 * absent from codex/gemini envs. GitHub credentials are never injected.
 */
export async function buildAgentEnv(
  agent: string,
  operation: string,
): Promise<Record<string, string>> {
  const runtimeCfg = getRuntimeConfig();

  const allowlist = new Set([...AGENT_ENV_ALLOWLIST, ...runtimeCfg.subagent_env_allowlist]);

  // Start from allowlisted host env keys, excluding blocked keys.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && allowlist.has(k) && !BLOCKED_KEYS.has(k) && !isCredentialEnvKey(k)) {
      env[k] = v;
    }
  }

  // Always propagate Codex's structural roots so nested Stark tools resolve
  // packaged assets and mutable state without consulting a Claude install.
  for (const key of ["STARK_ASSET_ROOT", "STARK_PLUGIN_ROOT", "STARK_STATE_ROOT"] as const) {
    const value = process.env[key];
    if (value && value.trim() !== "") env[key] = value;
  }

  // Claude uses the logged-in account's subscription.
  if (agent === "claude") {
    applyClaudeAuth(env);
  }

  if (!USER_AUTH_OPS.has(operation)) {
    process.stderr.write(
      `runtime_env: warning: unknown operation '${operation}' for agent ` +
        `'${agent}'; no GitHub credentials are ever injected\n`,
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
