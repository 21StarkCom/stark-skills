/**
 * Config reader — TypeScript port of `scripts/config_loader.py`.
 *
 * Started as a preflight-only subset; Phase 3a of the Python→TS migration
 * extended it to the full section surface so the dispatch infra can drop
 * the Python `config_loader.py`. During the Phase 3+4 transition the
 * Python module still exists for the not-yet-ported orchestrators; both
 * sides read the same on-disk JSON, so they stay consistent.
 *
 * Surface:
 *   - `loadGlobalConfig()` — read `~/.claude/code-review/config.json`
 *   - `DEFAULT_*` — schema-defaults the section accessors merge on top of
 *   - Section accessors (`getModelsConfig`, `getRuntimeConfig`,
 *     `getSelfHealConfig`, `getValidationGateConfig`,
 *     `getSkillActivationConfig`, `getContextCompactionConfig`,
 *     `getCostConfig`, `getModelRates`) — deep-merge default + global.
 *   - `isAgentEnabled(agent)` / `getModelId(agent)` — model convenience
 *   - `discoverConfig({cwd})` — minimal hierarchical merge (preflight)
 *
 * No `@lru_cache` equivalent — the file IO is negligible and lazy caching
 * makes test isolation harder. Add memoization at the call site if a hot
 * path ever needs it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assetConfigPath, assetRoot } from "./asset_root_lib.ts";
import { isMainModule } from "./main_module_lib.ts";


// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Global config path. Resolves bundle-relative when running as an installed
 * plugin (`CLAUDE_PLUGIN_ROOT` set), else `~/.claude/code-review/config.json`.
 */
function globalConfigPath(): string {
  return assetConfigPath();
}

// ---------------------------------------------------------------------------
// Default sections (mirror `scripts/config_loader.py:DEFAULT_*`)
// ---------------------------------------------------------------------------

export interface ModelEntry {
  enabled?: boolean;
  model_id?: string;
  [key: string]: unknown;
}

export const DEFAULT_MODELS: Record<string, ModelEntry> = {
  // auth: "subscription" is the only mode — headless claude dispatches on the
  // logged-in account's OAuth credentials. The metered-API mode was removed;
  // any other value warns and is ignored. See claude_auth_lib.ts.
  claude: { enabled: true, model_id: "claude-opus-5[1m]", auth: "subscription" },
  codex: { enabled: true, model_id: "gpt-5.6-sol" },
  // auth: "oauth" rides the logged-in Google account's Code Assist seat;
  // "vertex" = per-token Vertex billing; "api-key" = GEMINI_API_KEY.
  // Env override: STARK_GEMINI_AUTH. See gemini_auth_lib.ts.
  gemini: { enabled: true, model_id: "gemini-3.1-pro-preview", auth: "oauth" },
};

export interface ModelRate {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
}

export const DEFAULT_MODEL_RATES: Record<string, ModelRate> = {
  o3: { input_per_1m_usd: 15.0, output_per_1m_usd: 60.0 },
  // claude-opus-5: $5/$25 per MTok (Anthropic pricing). The `[1m]` suffix is
  // the Claude Code 1M-context variant of the same model — same rates; both
  // keys are listed so cost lookups hit an exact entry either way.
  "claude-opus-5[1m]": { input_per_1m_usd: 5.0, output_per_1m_usd: 25.0 },
  "claude-opus-5": { input_per_1m_usd: 5.0, output_per_1m_usd: 25.0 },
  "claude-opus-4-8": { input_per_1m_usd: 15.0, output_per_1m_usd: 75.0 },
  "claude-fable-5": { input_per_1m_usd: 10.0, output_per_1m_usd: 50.0 },
  // gemini-3.1-pro-preview: $2.00/$12.00 per MTok on the standard paid tier
  // for prompts <= 200k tokens; above 200k the tier doubles to $4.00/$18.00.
  // The <=200k rates are the ones recorded here because that is the tier a
  // dispatch of a document-sized payload actually bills at — a run whose
  // prompt crosses 200k under-reports and the manifest says which rate it
  // used. Source: https://ai.google.dev/gemini-api/docs/pricing (2026-08-03).
  "gemini-3.1-pro-preview": { input_per_1m_usd: 2.0, output_per_1m_usd: 12.0 },
  "gpt-5.4": { input_per_1m_usd: 5.0, output_per_1m_usd: 15.0 },
  "gpt-5.5": { input_per_1m_usd: 5.0, output_per_1m_usd: 15.0 },
  // gpt-5.6 family (2026-07-09): sol is the flagship tier; terra/luna are the
  // cheaper tiers. Rates from developers.openai.com/api/docs/pricing.
  "gpt-5.6-sol": { input_per_1m_usd: 5.0, output_per_1m_usd: 30.0 },
  "gpt-5.6-terra": { input_per_1m_usd: 2.5, output_per_1m_usd: 15.0 },
  "gpt-5.6-luna": { input_per_1m_usd: 1.0, output_per_1m_usd: 6.0 },
  "gpt-5.4-pro": { input_per_1m_usd: 20.0, output_per_1m_usd: 80.0 },
  "gpt-5.5-pro": { input_per_1m_usd: 25.0, output_per_1m_usd: 100.0 },
  _fallback: { input_per_1m_usd: 100.0, output_per_1m_usd: 300.0 },
};

/** Per-model capacity limits. `max_output_tokens` is the request-time output
 *  ceiling (a cap, not a target — the model stops when done, so a higher value
 *  only prevents truncation, it does not add cost); `context_window` is the
 *  model's total input+output token capacity, used for input budgeting.
 *  Single source of truth for anything dispatching a given model. */
export interface ModelLimits {
  max_output_tokens: number;
  context_window: number;
}

export const DEFAULT_MODEL_LIMITS: Record<string, ModelLimits> = {
  // gpt-5.5-pro: verified from OpenAI docs (developers.openai.com,
  // /api/docs/models/gpt-5.5-pro) — 1,050,000 context window, 128,000 max
  // output tokens.
  "gpt-5.5-pro": { max_output_tokens: 128_000, context_window: 1_050_000 },
  // gpt-5.6-sol: verified from OpenAI docs (developers.openai.com,
  // /api/docs/models/gpt-5.6-sol) — same 1,050,000 context window and
  // 128,000 max output tokens as gpt-5.5-pro.
  "gpt-5.6-sol": { max_output_tokens: 128_000, context_window: 1_050_000 },
  // claude-opus-5[1m]: 1M context window, 64K max output tokens — read off a
  // live `claude -p --model 'claude-opus-5[1m]' --output-format json` run
  // (`modelUsage.contextWindow` / `maxOutputTokens`, 2026-07-25) — the CLI
  // caps output at 64K. The bare `claude-opus-5` id is the API model: 1M
  // context, 128K max output (Anthropic docs).
  "claude-opus-5[1m]": { max_output_tokens: 64_000, context_window: 1_000_000 },
  "claude-opus-5": { max_output_tokens: 128_000, context_window: 1_000_000 },
  // claude-fable-5: 1M context window, 128K max output tokens (Anthropic docs).
  "claude-fable-5": { max_output_tokens: 128_000, context_window: 1_000_000 },
  // gemini-3.1-pro-preview: Google publishes an input token limit of 1,048,576
  // and an output token limit of 65,536 — the input limit is what this table's
  // `context_window` budgets against. Source:
  // https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview
  // (2026-08-03).
  "gemini-3.1-pro-preview": { max_output_tokens: 65_536, context_window: 1_048_576 },
  // Conservative floor for models without an explicit entry. Deliberately
  // small so an unknown model never over-promises capacity it may not have;
  // add a real entry (with a sourced number) rather than relying on this.
  _fallback: { max_output_tokens: 16_000, context_window: 128_000 },
};

// ---------------------------------------------------------------------------
// Remaining config sections (mirror `scripts/config_loader.py:DEFAULT_*`).
// These complete the port beyond preflight's original needs — the Phase 3
// dispatch infra (runtime_env, dispatcher_base) consumes `runtime`.
// ---------------------------------------------------------------------------

export const DEFAULT_RUNTIME = {
  lock_ttl_minutes: 30,
  subagent_env_allowlist: ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM"],
  max_concurrent_agents: 3,
  temp_dir_prefix: "stark-env",
};

export const DEFAULT_SELF_HEAL = {
  enabled: true,
  mode: "suggest",
  max_auto_retries: 0,
  patterns_file: "healer_patterns.json",
  circuit_breaker_threshold: 3,
  auto_patterns: [] as string[],
};

export const DEFAULT_VALIDATION_GATE = {
  enabled: true,
  run_on: ["implementation", "autopilot"],
  skip_domains: [] as string[],
  timeout_seconds: 60,
};

export const DEFAULT_SKILL_ACTIVATION = {
  enabled: true,
  suggest_after_review_rounds: 3,
  max_suggestions: 2,
  cooldown_hours: 24,
  suppressed_skills: [] as string[],
  activation_signals: ["review_finding", "correction", "skill_invocation"],
};

export const DEFAULT_CONTEXT_COMPACTION = {
  enabled: true,
  checkpoint_interval_minutes: 15,
  max_checkpoint_size_kb: 50,
  include_file_summaries: true,
};

export const DEFAULT_COST = {
  weekly_budget_usd: 50.0,
  daily_alert_usd: 15.0,
  hard_stop_usd: 100.0,
  track_rolling_7d: true,
};

/**
 * handover — config for `/stark-handover` (cross-/clear session handovers).
 * `root` is the storage tree ({root}/{project}/{worktree}/{task}/); it is
 * user-space output, deliberately NOT under `stateRoot()`. Env override:
 * `STARK_HANDOVER_ROOT`.
 */
export const DEFAULT_HANDOVER = {
  root: "~/Code/Handovers",
};

/**
 * iac_review — config for the multi-agent Terraform/Terragrunt reviewers.
 * `agents` lists the LLMs that each run the review as their own subagent,
 * e.g. ["gemini","codex"]. Overridable via the `iac_review` config section.
 */
export const DEFAULT_IAC_REVIEW = {
  enabled: true,
  agents: ["codex"] as string[],
  timeout_sec: 600,
  max_files: 80,
  max_bytes_per_file: 100_000,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warn(message: string): void {
  process.stderr.write(`config: ${message}\n`);
}

function loadJsonFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warn(`failed to read ${file}: ${(err as Error).message}`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`failed to parse ${file}: ${(err as Error).message}`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`expected top-level object in ${file}`);
    return {};
  }
  return parsed as Record<string, unknown>;
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: unknown,
): T {
  const out: Record<string, unknown> = structuredClone(base);
  if (override === null || override === undefined) return out as T;
  if (typeof override !== "object" || Array.isArray(override)) {
    warn(
      `expected dict override, got ${Array.isArray(override) ? "array" : typeof override} — using defaults`,
    );
    return out as T;
  }
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const baseVal = out[k];
    if (
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        baseVal as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// Global config load
// ---------------------------------------------------------------------------

export function loadGlobalConfig(): Record<string, unknown> {
  return loadJsonFile(globalConfigPath());
}

// ---------------------------------------------------------------------------
// Section accessors
// ---------------------------------------------------------------------------

export function getModelsConfig(): Record<string, ModelEntry> {
  return deepMerge(DEFAULT_MODELS, loadGlobalConfig()["models"]);
}

export function getModelRates(): Record<string, ModelRate> {
  return deepMerge(DEFAULT_MODEL_RATES, loadGlobalConfig()["model_rates"]);
}

/** Merged per-model limits (defaults + global `model_limits` override). */
export function getModelLimits(): Record<string, ModelLimits> {
  return deepMerge(DEFAULT_MODEL_LIMITS, loadGlobalConfig()["model_limits"]);
}

/** Resolve one model's limits, falling back to the `_fallback` entry for an
 *  unknown model id. Never throws. */
export function getModelLimit(modelId: string): ModelLimits {
  const limits = getModelLimits();
  return limits[modelId] ?? limits._fallback;
}

export function isAgentEnabled(agent: string): boolean {
  const m = getModelsConfig()[agent];
  if (!m || typeof m !== "object") return false;
  return Boolean(m.enabled);
}

/** Resolve an agent's configured model id, or null when unset/non-string. */
export function getModelId(agent: string): string | null {
  const m = getModelsConfig()[agent];
  if (!m || typeof m !== "object") return null;
  const id = (m as ModelEntry).model_id;
  return typeof id === "string" ? id : null;
}

/** Deep-merge a default section with its global-config override. */
function getSection<T extends Record<string, unknown>>(
  defaults: T,
  key: string,
): T {
  return deepMerge(defaults, loadGlobalConfig()[key]);
}

export function getRuntimeConfig(): typeof DEFAULT_RUNTIME {
  return getSection(DEFAULT_RUNTIME, "runtime");
}
export function getSelfHealConfig(): typeof DEFAULT_SELF_HEAL {
  return getSection(DEFAULT_SELF_HEAL, "self_heal");
}
export function getValidationGateConfig(): typeof DEFAULT_VALIDATION_GATE {
  return getSection(DEFAULT_VALIDATION_GATE, "validation_gate");
}
export function getSkillActivationConfig(): typeof DEFAULT_SKILL_ACTIVATION {
  return getSection(DEFAULT_SKILL_ACTIVATION, "skill_activation");
}
export function getContextCompactionConfig(): typeof DEFAULT_CONTEXT_COMPACTION {
  return getSection(DEFAULT_CONTEXT_COMPACTION, "context_compaction");
}
export function getHandoverConfig(): typeof DEFAULT_HANDOVER {
  return getSection(DEFAULT_HANDOVER, "handover");
}
export function getCostConfig(): typeof DEFAULT_COST {
  return getSection(DEFAULT_COST, "cost");
}
export function getIacReviewConfig(): typeof DEFAULT_IAC_REVIEW {
  return getSection(DEFAULT_IAC_REVIEW, "iac_review");
}

// ---------------------------------------------------------------------------
// discoverConfig — hierarchical merge across global + org + repo. Preflight
// only reads `cfg.agents`; we keep the surface minimal and let other ports
// extend if they need more fields.
// ---------------------------------------------------------------------------

export interface DiscoverConfigOpts {
  cwd?: string;
  globalDir?: string;
}

interface DiscoveredConfig {
  agents?: string[];
  [key: string]: unknown;
}

function findConfigChain(cwd: string, globalDir: string): string[] {
  const chain: string[] = [];
  const home = fs.realpathSync(os.homedir());
  let current: string;
  try {
    current = fs.realpathSync(cwd);
  } catch {
    current = cwd;
  }
  while (current !== home && current !== path.dirname(current)) {
    const cfg = path.join(current, ".code-review", "config.json");
    if (fs.existsSync(cfg)) chain.push(cfg);
    current = path.dirname(current);
  }
  const globalCfg = path.join(globalDir, "config.json");
  if (fs.existsSync(globalCfg)) chain.push(globalCfg);
  return chain;
}

export function discoverConfig(opts: DiscoverConfigOpts = {}): DiscoveredConfig {
  const cwd = opts.cwd ?? process.cwd();
  const globalDir = opts.globalDir ?? assetRoot();
  const chain = findConfigChain(cwd, globalDir);
  // Walk from least-specific (global) to most-specific (repo) so the
  // top-of-chain layer wins. Only `agents` (REPLACE field) is consumed
  // by preflight today; preserve the Python's last-write-wins semantics.
  const merged: DiscoveredConfig = {};
  for (const cfgPath of chain.slice().reverse()) {
    const layer = loadJsonFile(cfgPath);
    for (const [k, v] of Object.entries(layer)) {
      merged[k] = v;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// CLI — `stark_config_lib.ts --model <agent>` prints the resolved model id.
// The retired stark-phase-execute skill shelled out to this to pin its goal loop's
// `--model` from config instead of hardcoding one; before it existed the
// invocation exited 0 with no output and the `|| echo <fallback>` guard never
// fired, so `--model ""` was passed. Exits 1 (no output) on an unknown agent
// so the caller's fallback runs.
// ---------------------------------------------------------------------------

const USAGE = "usage: stark_config_lib.ts --model <agent>\n";

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h") || argv.includes("help")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const i = argv.indexOf("--model");
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write(USAGE);
    return 1;
  }
  const id = getModelId(argv[i + 1]);
  if (!id) return 1;
  process.stdout.write(`${id}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
