/**
 * Shared base for the multi-agent dispatchers — TypeScript port of
 * `scripts/dispatcher_base.py`.
 *
 * Provides the hierarchical review-config discovery (`discoverConfig`),
 * model resolution (`resolveModel`), the agent registry (`AGENTS`), and
 * the domain/prompt discovery used by the review orchestrators.
 *
 * The Python imported the three `*_utils` modules + `config_loader`;
 * this port imports the `*_utils_lib.ts` ports + `stark_config_lib.ts`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAUDE_MODEL } from "./claude_utils_lib.ts";
import { CODEX_MODEL } from "./codex_utils_lib.ts";
import { GEMINI_MODEL } from "./gemini_utils_lib.ts";
import { assetRoot } from "./asset_root_lib.ts";
import { getModelId, isAgentEnabled } from "./stark_config_lib.ts";

// ---------------------------------------------------------------------------
// Agent definitions
// ---------------------------------------------------------------------------

export interface AgentInfo {
  app: string;
  emoji: string;
  label: string;
}

const ALL_AGENTS: Record<string, AgentInfo> = {
  claude: { app: "stark-claude", emoji: "\u{1f9e0}", label: "Claude" },
  codex: { app: "stark-codex", emoji: "\u{1f4bb}", label: "Codex" },
  gemini: { app: "stark-gemini", emoji: "✨", label: "Gemini" },
};

/** Enabled-agent registry — falls back to all agents when none are enabled. */
export function computeAgents(): Record<string, AgentInfo> {
  const enabled: Record<string, AgentInfo> = {};
  for (const [agent, info] of Object.entries(ALL_AGENTS)) {
    if (isAgentEnabled(agent)) enabled[agent] = info;
  }
  return Object.keys(enabled).length > 0 ? enabled : { ...ALL_AGENTS };
}

/** Import-time snapshot of the enabled-agent registry (Python parity). */
export const AGENTS: Record<string, AgentInfo> = computeAgents();

// ---------------------------------------------------------------------------
// Hierarchical review config
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG: Record<string, unknown> = {
  agents: ["claude", "codex", "gemini"],
  fix_threshold: "medium",
  test_command: null,
  build_command: null,
  verify_before_clean: true,
  disabled_domains: [],
  extra_domains: [],
  context_files: [],
  domain_agents: {},
  severity_overrides: {},
  github_apps: {
    claude: "stark-claude",
    codex: "stark-codex",
    gemini: "stark-gemini",
  },
};

const REPLACE_FIELDS: ReadonlySet<string> = new Set([
  "agents",
  "fix_threshold",
  "test_command",
  "build_command",
  "verify_before_clean",
  "disabled_domains",
  "context_files",
]);
const ADDITIVE_FIELDS: ReadonlySet<string> = new Set(["extra_domains"]);
const DEEP_MERGE_FIELDS: ReadonlySet<string> = new Set([
  "severity_overrides",
  "github_apps",
  "domain_agents",
  "triage",
]);

/** Recursively merge `override` into a shallow copy of `base`. */
function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = result[k];
    if (
      cur !== null &&
      typeof cur === "object" &&
      !Array.isArray(cur) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      result[k] = deepMerge(
        cur as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

/** Walk from `cwd` up to `~` collecting `.code-review/config.json`, then global. */
function findConfigChain(cwd: string, globalDir: string): string[] {
  const chain: string[] = [];
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }
  let current: string;
  try {
    current = fs.realpathSync(cwd);
  } catch {
    current = path.resolve(cwd);
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

/** Discover and merge the review config: repo → org → global. */
export function discoverConfig(
  cwd?: string,
  globalDir?: string,
): Record<string, unknown> {
  const resolvedCwd = cwd ?? process.cwd();
  const resolvedGlobal = globalDir ?? assetRoot();

  const chain = findConfigChain(resolvedCwd, resolvedGlobal);
  const merged = structuredClone(DEFAULT_CONFIG);

  // Apply least-specific (global) first, most-specific (repo) last.
  for (const cfgPath of chain.slice().reverse()) {
    let layer: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      layer = parsed as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      // Malformed JSON / unreadable — skip the layer, keep defaults.
      continue;
    }
    for (const [key, val] of Object.entries(layer)) {
      if (REPLACE_FIELDS.has(key)) {
        merged[key] = val;
      } else if (ADDITIVE_FIELDS.has(key)) {
        const existing = Array.isArray(merged[key])
          ? (merged[key] as unknown[])
          : [];
        const additions = Array.isArray(val)
          ? val
          : val !== null && val !== undefined
            ? [val]
            : [];
        merged[key] = [...new Set([...existing, ...additions])];
      } else if (DEEP_MERGE_FIELDS.has(key)) {
        const cur =
          merged[key] !== null && typeof merged[key] === "object" && !Array.isArray(merged[key])
            ? (merged[key] as Record<string, unknown>)
            : {};
        const ov =
          val !== null && typeof val === "object" && !Array.isArray(val)
            ? (val as Record<string, unknown>)
            : {};
        merged[key] = deepMerge(cur, ov);
      } else {
        merged[key] = val;
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/** Map an agent name to its configured model id. */
export function resolveModel(agent: string): string {
  if (agent === "claude") return getModelId("claude") || CLAUDE_MODEL;
  if (agent === "codex") return getModelId("codex") || CODEX_MODEL;
  if (agent === "gemini") return getModelId("gemini") || GEMINI_MODEL;
  throw new Error(`Unknown agent: ${agent}`);
}

// ---------------------------------------------------------------------------
// Domain discovery
// ---------------------------------------------------------------------------

export interface DomainInfo {
  order: string;
  label: string;
  filename: string;
}

/** Title-case a space-separated slug ("type safety" → "Type Safety"). */
function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

function numberedMarkdownFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^[0-9].*\.md$/.test(n)).sort();
}

function domainInfoFromFilename(filename: string): { key: string; info: DomainInfo } {
  const stem = filename.replace(/\.md$/, "");
  const dashIdx = stem.indexOf("-");
  const key = dashIdx >= 0 ? stem.slice(dashIdx + 1) : stem;
  const order = dashIdx >= 0 ? stem.slice(0, dashIdx) : "99";
  return {
    key,
    info: { order, label: titleCase(key.replace(/-/g, " ")), filename },
  };
}

/**
 * Discover review domains from prompt files under `promptsDir`.
 *
 * Scans the first agent directory (in `agents` order) that contains
 * `[0-9]*.md` files, then merges in any additional domains from
 * `{promptsDir}/domains/`. Agent-specific files take priority.
 */
export function discoverDomains(
  promptsDir: string,
  agents: string[] = ["claude", "codex", "gemini"],
): Record<string, DomainInfo> {
  const domains: Record<string, DomainInfo> = {};

  for (const agent of agents) {
    const agentDir = path.join(promptsDir, agent);
    if (!fs.existsSync(agentDir)) continue;
    for (const filename of numberedMarkdownFiles(agentDir)) {
      const { key, info } = domainInfoFromFilename(filename);
      if (!(key in domains)) domains[key] = info;
    }
    if (Object.keys(domains).length > 0) break;
  }

  // Always merge the shared domains/ directory (agent-specific wins).
  const sharedDir = path.join(promptsDir, "domains");
  if (fs.existsSync(sharedDir)) {
    for (const filename of numberedMarkdownFiles(sharedDir)) {
      const { key, info } = domainInfoFromFilename(filename);
      if (!(key in domains)) domains[key] = info;
    }
  }

  return domains;
}

// ---------------------------------------------------------------------------
// Prompt resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a prompt file: repo override → global agent dir → global
 * `domains/`. Returns the trimmed prompt text, or "" if none was found.
 */
export function resolvePrompt(
  agent: string,
  filename: string,
  promptsDir: string,
  repoDir?: string | null,
  repoSubdir = "prompts",
): string {
  // 1. Repo-level override
  if (repoDir) {
    const repoPath = path.join(
      repoDir,
      ".code-review",
      repoSubdir,
      agent,
      filename,
    );
    if (fs.existsSync(repoPath)) return fs.readFileSync(repoPath, "utf8").trim();
  }

  // 2. Global agent-specific path
  const globalPath = path.join(promptsDir, agent, filename);
  if (fs.existsSync(globalPath)) return fs.readFileSync(globalPath, "utf8").trim();

  // 3. Shared domains/ fallback
  const domainsPath = path.join(promptsDir, "domains", filename);
  if (fs.existsSync(domainsPath)) {
    return fs.readFileSync(domainsPath, "utf8").trim();
  }

  return "";
}
