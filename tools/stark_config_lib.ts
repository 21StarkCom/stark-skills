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
 *     `getCostConfig`, `getForgeConfig`, `getForgedReviewConfig`,
 *     `getModelRates`) — deep-merge default + global.
 *   - `getRedTeamConfig()` — additionally walks repo/org
 *     `.code-review/config.json` overrides with locked-fields enforcement
 *     + unknown-keys pruning (spec rt1 + rt2).
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
  claude: { enabled: true, model_id: "claude-opus-4-8" },
  codex: { enabled: true, model_id: "gpt-5.5" },
  gemini: { enabled: true, model_id: "gemini-3.1-pro-preview" },
};

export interface RedTeamConfig {
  enabled?: boolean;
  agent?: string;
  model?: string;
  max_rounds?: number;
  halt_on_unresolved?: boolean;
  stages?: Record<string, { enabled?: boolean }>;
  personas?: string[];
  min_severity_to_block?: string;
  timeout_s?: number;
  per_run_budget_usd?: number;
  stability_overlap_jaccard_min?: number;
  max_input_chars?: number;
  allow_human_review_halt?: boolean;
  fix_plan?: {
    enabled?: boolean;
    model?: string;
    reasoning_effort?: string;
    timeout_s?: number;
    min_moves?: number;
    max_moves?: number;
    max_input_chars?: number;
  };
  audit?: {
    retain_full_text?: boolean;
    excerpt_max_chars?: number;
  };
  [key: string]: unknown;
}

export const DEFAULT_RED_TEAM: RedTeamConfig = {
  enabled: true,
  agent: "codex",
  model: "gpt-5.5-pro",
  max_rounds: 2,
  halt_on_unresolved: true,
  stages: {
    design: { enabled: true },
    plan: { enabled: false },
  },
  personas: [
    "security-trust",
    "reliability-distsys",
    "data",
    "product-dx",
    "cost-ops",
  ],
  min_severity_to_block: "high",
  timeout_s: 900,
  per_run_budget_usd: 30.0,
  stability_overlap_jaccard_min: 0.4,
  max_input_chars: 200_000,
  allow_human_review_halt: true,
  fix_plan: {
    enabled: false,
    model: "gpt-5.5-pro",
    reasoning_effort: "xhigh",
    timeout_s: 1200,
    min_moves: 2,
    max_moves: 6,
    max_input_chars: 200_000,
  },
  audit: {
    retain_full_text: false,
    excerpt_max_chars: 240,
  },
};

export interface ModelRate {
  input_per_1m_usd: number;
  output_per_1m_usd: number;
}

export const DEFAULT_MODEL_RATES: Record<string, ModelRate> = {
  o3: { input_per_1m_usd: 15.0, output_per_1m_usd: 60.0 },
  "claude-opus-4-8": { input_per_1m_usd: 15.0, output_per_1m_usd: 75.0 },
  "gpt-5.4": { input_per_1m_usd: 5.0, output_per_1m_usd: 15.0 },
  "gpt-5.5": { input_per_1m_usd: 5.0, output_per_1m_usd: 15.0 },
  "gpt-5.4-pro": { input_per_1m_usd: 20.0, output_per_1m_usd: 80.0 },
  "gpt-5.5-pro": { input_per_1m_usd: 25.0, output_per_1m_usd: 100.0 },
  _fallback: { input_per_1m_usd: 100.0, output_per_1m_usd: 300.0 },
};

// ---------------------------------------------------------------------------
// Remaining config sections (mirror `scripts/config_loader.py:DEFAULT_*`).
// These complete the port beyond preflight's original needs — the Phase 3
// dispatch infra (runtime_env, dispatcher_base) consumes `runtime`.
// ---------------------------------------------------------------------------

export const DEFAULT_RUNTIME = {
  lock_ttl_minutes: 30,
  subagent_env_allowlist: ["PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "ANTHROPIC_AGENTS"],
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

export const DEFAULT_FORGE = {
  domain_routing: {
    completeness: "claude",
    security: "codex",
    scope: "claude",
    "api-design": "codex",
    "data-modeling": "codex",
    consistency: "claude",
    accessibility: "claude",
    "test-plan": "codex",
  },
  plan_review_routing: {
    completeness: "claude",
    security: "codex",
    sequencing: "claude",
    viability: "codex",
  },
  agent_fallback_order: ["claude", "codex", "gemini"],
  consensus_domains: ["security"],
  consensus_threshold: 2,
  max_rounds: 3,
  workers: 3,
  fix_threshold: "medium",
  noise_improvement_threshold: 0.33,
  heuristic_consolidation_threshold: 50,
  review_timeout: 300,
  fix_timeout: 900,
};

export const DEFAULT_FORGED_REVIEW = {
  forge_threshold: 4,
  max_rounds: 3,
  domain_pairs: {
    architecture: { leader: "claude", second: "codex" },
    behavior: { leader: "codex", second: "claude" },
    "type-safety": { leader: "codex", second: "gemini" },
    security: { leader: "gemini", second: "codex" },
    "test-coverage": { leader: "codex", second: "gemini" },
    "spec-conformance": { leader: "claude", second: "codex" },
  },
  always_on_domains: ["behavior"],
  triage_agent: "claude",
  delta_rereview: true,
  auto_merge_when_clean: true,
};

// ---------------------------------------------------------------------------
// Locked-field paths (red_team) — repo/org overrides on these paths are
// rejected at config load, matching `scripts/config_loader.py` rt1 + rt2.
// ---------------------------------------------------------------------------

/** Dotted paths that may NOT be overridden below the global config level. */
const RED_TEAM_LOCKED_FIELDS: ReadonlySet<string> = new Set([
  "personas",
  "model",
  "enabled",
  "agent",
  "min_severity_to_block",
  "halt_on_unresolved",
  "allow_human_review_halt",
  "stages",
  "fix_plan.enabled",
  "fix_plan.model",
  "fix_plan.reasoning_effort",
  "fix_plan.min_moves",
  "fix_plan.max_moves",
  "audit.retain_full_text",
  "audit.excerpt_max_chars",
]);

/**
 * Locked PARENT paths derived from `RED_TEAM_LOCKED_FIELDS` — used to
 * reject non-dict overrides at a parent path that would replace the whole
 * locked subtree (e.g. `fix_plan: "off"` would defeat the per-leaf locks).
 */
const RED_TEAM_LOCKED_PARENTS: ReadonlySet<string> = (() => {
  const parents = new Set<string>();
  for (const dotted of RED_TEAM_LOCKED_FIELDS) {
    const parts = dotted.split(".");
    for (let i = 1; i < parts.length; i++) {
      parents.add(parts.slice(0, i).join("."));
    }
  }
  return parents;
})();

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
export function getCostConfig(): typeof DEFAULT_COST {
  return getSection(DEFAULT_COST, "cost");
}
export function getForgeConfig(): typeof DEFAULT_FORGE {
  return getSection(DEFAULT_FORGE, "forge");
}
export function getForgedReviewConfig(): typeof DEFAULT_FORGED_REVIEW {
  return getSection(DEFAULT_FORGED_REVIEW, "forged_review");
}
export function getIacReviewConfig(): typeof DEFAULT_IAC_REVIEW {
  return getSection(DEFAULT_IAC_REVIEW, "iac_review");
}

// ---------------------------------------------------------------------------
// red_team — locked-fields + unknown-keys pruning
// ---------------------------------------------------------------------------

interface DropResult {
  cleaned: Record<string, unknown>;
  rejected: string[];
}

/** Strip locked dotted paths from a repo/org override. */
function dropLockedOverrides(
  override: Record<string, unknown>,
  basePath: string = "",
): DropResult {
  const cleaned: Record<string, unknown> = {};
  const rejected: string[] = [];
  for (const [k, v] of Object.entries(override)) {
    const dotted = basePath ? `${basePath}.${k}` : k;
    if (RED_TEAM_LOCKED_FIELDS.has(dotted)) {
      rejected.push(dotted);
      continue;
    }
    if (
      RED_TEAM_LOCKED_PARENTS.has(dotted) &&
      (v === null || typeof v !== "object" || Array.isArray(v))
    ) {
      // A non-dict override at a locked parent would replace the entire
      // locked subtree wholesale, bypassing per-leaf locks. Reject.
      rejected.push(dotted);
      continue;
    }
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const sub = dropLockedOverrides(v as Record<string, unknown>, dotted);
      cleaned[k] = sub.cleaned;
      rejected.push(...sub.rejected);
    } else {
      cleaned[k] = v;
    }
  }
  return { cleaned, rejected };
}

function pruneUnknownKeys(
  override: Record<string, unknown>,
  known: ReadonlySet<string>,
  source: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(override)) {
    if (!known.has(k)) {
      warn(
        `red_team.${k} is not a known config key and will be ignored in ${source} — drop it from your config or add it to the schema`,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

function findRedTeamOverrideChain(cwd: string = process.cwd()): string[] {
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
  return chain.reverse();
}

const RED_TEAM_KNOWN_KEYS: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_RED_TEAM),
);

export function getRedTeamConfig(): RedTeamConfig {
  const global = loadGlobalConfig();
  let merged = deepMerge(DEFAULT_RED_TEAM, global["red_team"]);

  for (const cfgPath of findRedTeamOverrideChain()) {
    const layer = loadJsonFile(cfgPath);
    const rawOverride = layer["red_team"];
    if (rawOverride === undefined) continue;
    if (
      rawOverride === null ||
      typeof rawOverride !== "object" ||
      Array.isArray(rawOverride)
    ) {
      warn(
        `expected object at red_team in ${cfgPath}, got ${Array.isArray(rawOverride) ? "array" : typeof rawOverride} — ignoring layer`,
      );
      continue;
    }
    const { cleaned, rejected } = dropLockedOverrides(
      rawOverride as Record<string, unknown>,
    );
    for (const p of rejected) {
      warn(
        `red_team.${p} is locked to global config and cannot be overridden in ${cfgPath}`,
      );
    }
    const pruned = pruneUnknownKeys(cleaned, RED_TEAM_KNOWN_KEYS, cfgPath);
    merged = deepMerge(merged, pruned);
  }

  return merged;
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
