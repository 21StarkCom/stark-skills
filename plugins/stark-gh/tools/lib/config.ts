import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type ReasoningEffort = "medium" | "high" | "xhigh";

export interface DraftConfig {
  agent: "codex";
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutSeconds: number;
}

const DEFAULTS: DraftConfig = {
  agent: "codex",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  timeoutSeconds: 180,
};

const VALID_EFFORTS: ReasoningEffort[] = ["medium", "high", "xhigh"];

function loadJsonConfig(): Partial<DraftConfig> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cfgPath = path.join(here, "..", "..", "config.json");
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    return raw.draft ?? {};
  } catch {
    return {};
  }
}

export interface DraftOverrides {
  model?: string;
  reasoningEffort?: ReasoningEffort | string;
  timeoutSeconds?: number;
}

export function resolveDraftConfig(overrides: DraftOverrides): DraftConfig {
  const fileCfg = loadJsonConfig();
  const definedOverrides = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  );
  const merged: DraftConfig = { ...DEFAULTS, ...fileCfg, ...definedOverrides } as DraftConfig;
  if (/haiku/i.test(merged.model)) {
    throw new Error(`stark-gh refuses to use Haiku models: '${merged.model}' is forbidden by config policy`);
  }
  if (!VALID_EFFORTS.includes(merged.reasoningEffort as ReasoningEffort)) {
    throw new Error(`invalid reasoning effort '${merged.reasoningEffort}'; allowed: ${VALID_EFFORTS.join(", ")}`);
  }
  if (typeof merged.timeoutSeconds !== "number" || merged.timeoutSeconds < 30 || merged.timeoutSeconds > 600) {
    throw new Error(`invalid timeoutSeconds '${merged.timeoutSeconds}'; must be 30..600`);
  }
  if (merged.agent !== "codex") {
    throw new Error(`invalid draft agent '${merged.agent}'; only codex is supported`);
  }
  return merged;
}
