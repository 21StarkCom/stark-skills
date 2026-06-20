// Provider abstraction for the refactor-planner.
//
// The repo already has a CLI-based agent backend (claude/codex via
// copilot_dispatch.ts), so we adapt to it rather than pulling in a vendor SDK.
// The dispatcher's business logic talks ONLY to the AgentProvider interface;
// provider + model are chosen from config/env, never hardcoded. A deterministic
// `noop` provider lets the full pipeline run (and be tested) with no LLM calls.

import {
  buildAgentEnv, isAgentEnabled, parseCodexJsonl, releaseAgentTempDir, resolveModel, run,
  type AgentName as VendorAgent,
} from "./copilot_dispatch.ts";
import type { AgentName, ContextFile } from "./refactor_planner_schemas.ts";

export interface AgentRunInput {
  agentName: AgentName;
  systemPrompt: string;
  userPrompt: string;
  contextFiles: ContextFile[];
  expectedOutput: "json" | "markdown";
}

export interface AgentRunResult {
  rawText: string;
  parsedJson?: unknown;
  error?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AgentProvider {
  readonly name: string;
  runAgent(input: AgentRunInput): Promise<AgentRunResult>;
}

export type ProviderKind = "claude" | "codex" | "noop";

export interface ProviderConfig {
  /** Which backend to dispatch to. Resolved from `--provider` / REFACTOR_PLANNER_PROVIDER / default. */
  provider: ProviderKind;
  /** Model id override. Falls back to the repo's `resolveModel()` for the chosen vendor. */
  model?: string;
  timeoutSec: number;
}

export function resolveProviderConfig(opts: Partial<ProviderConfig> = {}): ProviderConfig {
  const envProvider = (process.env.REFACTOR_PLANNER_PROVIDER ?? "").toLowerCase();
  const provider = (opts.provider ?? (isProviderKind(envProvider) ? envProvider : "claude")) as ProviderKind;
  const model = opts.model ?? process.env.REFACTOR_PLANNER_MODEL ?? undefined;
  const timeoutSec = opts.timeoutSec ?? Number(process.env.REFACTOR_PLANNER_TIMEOUT_SEC ?? 600);
  return { provider, model, timeoutSec };
}

function isProviderKind(v: string): v is ProviderKind {
  return v === "claude" || v === "codex" || v === "noop";
}

export function createProvider(config: ProviderConfig): AgentProvider {
  if (config.provider === "noop") return new NoopProvider();
  return new CliAgentProvider(config);
}

// ── CLI-backed provider (claude / codex, read-only) ───────────────────────────

class CliAgentProvider implements AgentProvider {
  readonly name: string;
  private readonly vendor: VendorAgent;
  private readonly model: string;
  private readonly timeoutSec: number;

  constructor(config: ProviderConfig) {
    this.vendor = config.provider === "codex" ? "codex" : "claude";
    this.model = config.model ?? resolveModel(this.vendor);
    this.timeoutSec = config.timeoutSec;
    this.name = `${this.vendor}:${this.model}`;
  }

  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    if (!isAgentEnabled(this.vendor)) {
      return { rawText: "", error: `agent ${this.vendor} is disabled in config` };
    }
    const prompt = serializePrompt(input);
    const { cmd, args } = this.buildCmd();
    const { env, tempDir } = await buildAgentEnv(this.vendor, "review");
    try {
      const res = await run(cmd, args, { stdin: prompt, env, timeoutSec: this.timeoutSec });
      if (res.notFound) return { rawText: "", error: `${cmd} CLI not found on PATH` };
      if (res.timedOut) return { rawText: res.stdout, error: `${this.vendor} timed out after ${this.timeoutSec}s` };
      if (res.code !== 0) return { rawText: res.stdout, error: `${this.vendor} exited ${res.code}: ${res.stderr.slice(0, 400)}` };
      let raw = res.stdout;
      if (this.vendor === "codex") raw = parseCodexJsonl(raw);
      const parsed = input.expectedOutput === "json" ? extractJsonObject(raw) : undefined;
      return { rawText: raw, parsedJson: parsed ?? undefined, error: input.expectedOutput === "json" && parsed === null ? "no JSON object found in output" : undefined };
    } finally {
      releaseAgentTempDir(tempDir);
    }
  }

  private buildCmd(): { cmd: string; args: string[] } {
    if (this.vendor === "claude") {
      // No filesystem tools (finding #5): the host embeds every excerpt the agent
      // needs in the prompt, so granting Read/Glob/Grep would only create a
      // prompt-injection path for untrusted repo content to read local secrets.
      return {
        cmd: "claude",
        args: ["-p", "-", "--output-format", "text", "--model", this.model, "--no-session-persistence", "--allowedTools", ""],
      };
    }
    // codex: read-only, network-disabled sandbox confined to a throwaway cwd — it
    // likewise works from the embedded context and cannot reach out of the sandbox.
    return { cmd: "codex", args: ["exec", "-m", this.model, "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="read-only"', "-c", 'tools.web_search=false', "-s", "read-only", "--ephemeral", "--json", "-"] };
  }
}

// ── Deterministic noop provider (offline / dry / tests) ───────────────────────

class NoopProvider implements AgentProvider {
  readonly name = "noop";
  async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    const obj = EMPTY_OUTPUTS[input.agentName] ?? {};
    return { rawText: JSON.stringify(obj), parsedJson: obj };
  }
}

/** Minimal schema-valid empty outputs — used by the noop provider so the full
 * pipeline produces valid (empty) artifacts with no LLM. */
export const EMPTY_OUTPUTS: Record<AgentName, unknown> = {
  "repository-inventory": { language: "unknown", frameworks: [], package_manager: "unknown", entry_points: [], build_files: [], test_files: [], config_files: [], ci_files: [], docs: [], generated_or_vendored_paths: [], summary: "" },
  "command-discovery": { install_command: "unknown", test_command: "unknown", lint_command: "unknown", typecheck_command: "unknown", build_command: "unknown", format_command: "unknown", evidence: [] },
  "architecture": { current_architecture: "", runtime_flow: [], dependency_flow: [], main_modules: [], api_or_interface_layers: [], domain_modules: [], infrastructure_modules: [], shared_utilities: [], external_integrations: [], configuration_flow: [], test_organization: [], architecture_risks: [] },
  "dependency-health": { dependency_issues: [] },
  "duplication": { duplicates: [] },
  "dead-code": { dead_or_suspicious_code: [] },
  "test-risk": { test_gaps: [], risky_areas: [], safety_baseline: [] },
  "target-architecture": { target_directories: [], target_tree: "", rationale: [] },
  "phase-planner": { phases: [] },
  "artifact-synthesis": {},
};

// ── prompt serialization + JSON extraction ────────────────────────────────────

export function serializePrompt(input: AgentRunInput): string {
  const parts: string[] = [input.systemPrompt.trim(), "", `## Task`, input.userPrompt.trim()];
  if (input.contextFiles.length) {
    parts.push("", "## Context files");
    for (const f of input.contextFiles) {
      parts.push("", `### ${f.path}${f.purpose ? `  (${f.purpose})` : ""}`);
      if (f.content) parts.push("```", f.content, "```");
      else if (f.excerpt) parts.push(`(${f.summary ?? "excerpt"})`, "```", f.excerpt, "```");
      else if (f.summary) parts.push(f.summary);
    }
  }
  if (input.expectedOutput === "json") {
    parts.push("", "Respond with ONLY the JSON object defined by your output schema. No prose, no markdown fence.");
  }
  return parts.join("\n");
}

/** Tolerant JSON-object extraction: direct parse → fenced ```json → first balanced {…}. */
export function extractJsonObject(text: string): unknown | null {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    const v = tryParse(fence[1].trim());
    if (v !== undefined) return v;
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const v = tryParse(text.slice(start, i + 1));
        return v === undefined ? null : v;
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}
