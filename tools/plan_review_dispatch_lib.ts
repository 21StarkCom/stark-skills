/**
 * Plan/spec document review dispatch — TypeScript port of
 * `scripts/plan_review_dispatch.py`.
 *
 * Runs 3 CLI agents (Claude, Codex, Gemini) × N domain specializations
 * for reviewing plan and specification documents (not code PRs).
 *
 * The Python imported claude/codex/gemini_utils + runtime_env +
 * dispatcher_base + _emit; this port imports their TS ports.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildClaudeCmd } from "./claude_utils_lib.ts";
import { CODEX_REASONING_EFFORT_XHIGH, parseJsonlOutput } from "./codex_utils_lib.ts";
import { discoverDomains, resolvePrompt as baseResolvePrompt, resolveModel } from "./dispatcher_base_lib.ts";
import {
  makeGeminiEnv,
  parseJsonOutput as parseGeminiOutput,
  setupGeminiHome,
  shouldFallbackToApiKey,
  tryGeminiApiKeyFallback,
} from "./gemini_utils_lib.ts";
import { buildAgentEnv } from "./runtime_env_lib.ts";

// ── Config ────────────────────────────────────────────────────────────────

export function globalPromptsDir(promptsDir = "plan-review"): string {
  return path.join(os.homedir(), ".claude", "code-review", "prompts", promptsDir);
}

export const AGENTS = ["claude", "codex", "gemini"];

export const FINDINGS_FORMAT =
  "Output findings as a JSON array. Each finding: " +
  '{"severity": "critical|high|medium|low", "section": "section name or heading", ' +
  '"title": "short title", "description": "what is wrong", ' +
  '"suggestion": "how to fix it"}. ' +
  "If no issues found, return an empty array []. " +
  "Output ONLY the JSON array, no other text.";

export const DEFAULT_TIMEOUT = 300;
const CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_XHIGH;
const MAX_WORKERS = 21;

export type Logger = (msg: string) => void;

export interface PlanFinding {
  agent: string;
  domain: string;
  severity: string;
  section: string;
  title: string;
  description: string;
  suggestion: string;
}

export interface PlanSubAgentResult {
  agent: string;
  domain: string;
  raw_output: string;
  model: string;
  findings: PlanFinding[];
  error: string | null;
  duration_s: number;
  api_key_fallback: boolean;
}

export const DEFAULT_PLAN_REVIEW_CONFIG: Record<string, unknown> = {
  agents: ["claude", "codex"],
  fix_threshold: "medium",
  disabled_domains: [],
  max_rounds: 3,
};

interface DomainInfo {
  order: string;
  label: string;
  filename: string;
}

// ── Prompt + domain + config loading ─────────────────────────────────────

/** Resolve a plan review prompt: repo → global agent → global domains. */
export function resolvePlanPrompt(
  agent: string,
  filename: string,
  repoDir?: string | null,
  promptsDirOverride?: string,
): string {
  const promptsDir = promptsDirOverride ?? globalPromptsDir();
  return baseResolvePrompt(agent, filename, promptsDir, repoDir, "plan-prompts");
}

export function discoverPlanDomains(promptsDirOverride?: string): Record<string, DomainInfo> {
  return discoverDomains(promptsDirOverride ?? globalPromptsDir(), AGENTS);
}

/** Load a config section from config.json (global → repo), over the defaults. */
export function loadPlanReviewConfig(
  repoDir?: string | null,
  globalConfigDir?: string,
  configSection = "plan_review",
): Record<string, unknown> {
  const config: Record<string, unknown> = { ...DEFAULT_PLAN_REVIEW_CONFIG };
  const globalDir =
    globalConfigDir ?? path.join(os.homedir(), ".claude", "code-review");

  const readSection = (file: string): void => {
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const section = data?.[configSection];
      if (section && typeof section === "object" && !Array.isArray(section)) {
        Object.assign(config, section);
      }
    } catch {
      // malformed — skip
    }
  };

  readSection(path.join(globalDir, "config.json"));
  if (repoDir) readSection(path.join(repoDir, ".code-review", "config.json"));
  return config;
}

// ── Findings parser ──────────────────────────────────────────────────────

export function parsePlanFindings(agent: string, domain: string, raw: string): PlanFinding[] {
  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();

  if (text.includes("\\n") && text.startsWith('"')) {
    try {
      const decoded = JSON.parse(text);
      if (typeof decoded === "string") text = decoded;
    } catch {
      // leave as-is
    }
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];

  let items: unknown;
  try {
    items = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];

  const findings: PlanFinding[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    findings.push({
      agent,
      domain,
      severity: String(it.severity ?? "medium"),
      section: String(it.section ?? ""),
      title: String(it.title ?? ""),
      description: String(it.description ?? ""),
      suggestion: String(it.suggestion ?? ""),
    });
  }
  return findings;
}

function agentModelLabel(agent: string, log: Logger): string {
  try {
    return resolveModel(agent);
  } catch (exc) {
    log(`  [!] model resolution failed for '${agent}': ${(exc as Error).message}`);
    return "";
  }
}

/** Normalize a path to a repo-relative identifier safe for telemetry. */
export function safeRepoRelative(filePath: string, repoDir?: string | null): string {
  if (!filePath) return filePath;
  let p = filePath;
  if (repoDir) {
    try {
      p = path.relative(repoDir, filePath);
    } catch {
      // keep original
    }
  }
  p = p.replace(/^\/+/, "");
  const parts = p.split("/").filter((seg) => seg && seg !== "..");
  return parts.join("/") || p;
}

// ── Subprocess helper ────────────────────────────────────────────────────

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: boolean;
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { input?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const done = (r: ProcResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      spawnError = true;
      done({ status: null, stdout, stderr: stderr || String(err), timedOut, spawnError });
    });
    child.on("close", (code) => {
      done({ status: code, stdout, stderr, timedOut, spawnError });
    });
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    child.stdin?.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Sub-agent dispatch ───────────────────────────────────────────────────

async function runPlanSubagent(
  agent: string,
  domainKey: string,
  planContent: string,
  promptText: string,
  timeout: number,
  log: Logger,
): Promise<PlanSubAgentResult> {
  const fullPrompt = promptText ? `${promptText}\n\n${planContent}`.trim() : planContent;
  const result: PlanSubAgentResult = {
    agent,
    domain: domainKey,
    raw_output: "",
    model: agentModelLabel(agent, log),
    findings: [],
    error: null,
    duration_s: 0.0,
    api_key_fallback: false,
  };
  log(`  → start [${agent}:${domainKey}] model=${result.model}`);

  let cmd: string[];
  let stdinInput: string | undefined;
  let geminiHome: string | null = null;

  if (agent === "claude") {
    cmd = buildClaudeCmd();
    stdinInput = fullPrompt;
  } else if (agent === "codex") {
    cmd = [
      "codex",
      "exec",
      "-m",
      resolveModel("codex"),
      "-c",
      CODEX_REASONING_CONFIG,
      "--ephemeral",
      "--json",
      "-s",
      "read-only",
      "-",
    ];
    stdinInput = fullPrompt;
  } else if (agent === "gemini") {
    geminiHome = setupGeminiHome("gemini-plan-review-", process.cwd(), "review", "plan");
    cmd = [
      "gemini",
      "-m",
      resolveModel("gemini"),
      "-p",
      promptText || "Review this plan document.",
      "-o",
      "json",
    ];
    stdinInput = planContent;
  } else {
    result.error = "unknown_agent";
    return result;
  }

  const cleanupTemp = () => {
    if (geminiHome) {
      try {
        fs.rmSync(geminiHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };

  // Codex is slower (reasoning mode) — give it 2x the timeout.
  const effectiveTimeout = agent === "codex" ? timeout * 2 : timeout;
  let env: Record<string, string> | undefined;
  if (agent === "claude" || agent === "codex") {
    env = await buildAgentEnv(agent, "review");
  } else if (geminiHome) {
    env = makeGeminiEnv(geminiHome);
  }

  const maxAttempts = 2;
  const t0 = performance.now();
  let usedApiKeyFallback = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proc = await runProcess(cmd[0], cmd.slice(1), {
      input: stdinInput,
      timeoutMs: effectiveTimeout * 1000,
      env,
    });

    if (proc.timedOut) {
      if (attempt < maxAttempts) {
        log(`    ${agent}:${domainKey} timed out, retrying (${attempt}/${maxAttempts})...`);
        continue;
      }
      cleanupTemp();
      result.duration_s = (performance.now() - t0) / 1000;
      result.error = "timeout";
      return result;
    }
    if (proc.spawnError) {
      cleanupTemp();
      result.duration_s = (performance.now() - t0) / 1000;
      result.error = "agent_unavailable";
      return result;
    }

    if (proc.status !== 0) {
      const stderrSnippet = proc.stderr.slice(0, 500);
      log(`  [${agent}:${domainKey}] CLI error (exit ${proc.status}): ${stderrSnippet}`);
      if (
        agent === "gemini" &&
        attempt < maxAttempts &&
        shouldFallbackToApiKey(stderrSnippet) &&
        env !== undefined &&
        tryGeminiApiKeyFallback({ env }, domainKey, stderrSnippet)
      ) {
        usedApiKeyFallback = true;
        await sleep(2000);
        continue;
      }
      if (attempt < maxAttempts) {
        const backoff = 5000 * attempt;
        log(`    ${agent}:${domainKey} retrying in ${backoff / 1000}s (${attempt}/${maxAttempts})...`);
        await sleep(backoff);
        continue;
      }
      cleanupTemp();
      result.duration_s = (performance.now() - t0) / 1000;
      result.error = "cli_error";
      return result;
    }

    let raw = proc.stdout || "";
    if (agent === "codex") raw = parseJsonlOutput(raw);
    if (geminiHome) {
      raw = parseGeminiOutput(raw);
      cleanupTemp();
    }
    if (!raw.trim()) {
      log(`  [${agent}:${domainKey}] Empty output`);
      cleanupTemp();
      result.duration_s = (performance.now() - t0) / 1000;
      result.error = "empty_output";
      return result;
    }
    result.raw_output = raw;
    break;
  }

  result.duration_s = (performance.now() - t0) / 1000;
  result.api_key_fallback = usedApiKeyFallback;
  result.findings = parsePlanFindings(agent, domainKey, result.raw_output);

  if (
    result.findings.length === 0 &&
    result.raw_output.trim() &&
    result.raw_output.trim() !== "[]"
  ) {
    result.error = "parse_error";
    const preview = result.raw_output.trim().slice(0, 500);
    log(`  [${agent}:${domainKey}] parse_error — raw output preview:\n    ${preview}`);
    try {
      const debugDir = path.join(
        os.homedir(),
        ".claude",
        "code-review",
        "history",
        "parse-errors",
      );
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(
        path.join(debugDir, `${agent}-${domainKey}-${Math.floor(Date.now() / 1000)}.txt`),
        result.raw_output,
      );
    } catch {
      // best-effort
    }
  }
  return result;
}


// ── Bounded parallel pool ────────────────────────────────────────────────

async function runPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = next++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Dispatch ─────────────────────────────────────────────────────────────

export interface DispatchPlanReviewOptions {
  repoDir?: string | null;
  promptsDirOverride?: string;
  agents?: string[] | null;
  domains?: Record<string, DomainInfo> | null;
  disabledDomains?: string[] | null;
  timeout?: number;
  reviewType?: string | null;
  filePath?: string | null;
  repo?: string | null;
}

/** Dispatch plan review across agents × domains in parallel. */
export async function dispatchPlanReview(
  planContent: string,
  roundNum: number,
  options: DispatchPlanReviewOptions,
  log: Logger,
): Promise<Record<string, unknown>> {
  const promptsDir = options.promptsDirOverride ?? globalPromptsDir();
  const agents = options.agents ?? [...AGENTS];
  const disabledDomains = options.disabledDomains ?? [];

  let domains = options.domains ?? discoverPlanDomains(promptsDir);
  domains = { ...domains };
  for (const dd of disabledDomains) delete domains[dd];

  const domainKeys = Object.keys(domains).sort((a, b) => {
    const oa = domains[a].order ?? "99";
    const ob = domains[b].order ?? "99";
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });

  const totalSubagents = agents.length * domainKeys.length;
  log(
    `plan_review_dispatch: round ${roundNum} — ` +
      `${agents.length} agent(s) × ${domainKeys.length} domain(s) = ${totalSubagents} sub-agent(s)`,
  );
  log("plan_review_dispatch: models in use:");
  for (const agent of agents) log(`  - ${agent}: ${agentModelLabel(agent, log)}`);
  log(`plan_review_dispatch: domains: ${domainKeys.join(", ")}`);

  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const workItems: Array<{ agent: string; dk: string; promptText: string }> = [];
  for (const agent of agents) {
    for (const dk of domainKeys) {
      const preamble = resolvePlanPrompt(agent, "agent.md", options.repoDir, promptsDir);
      const domainPrompt = resolvePlanPrompt(agent, domains[dk].filename, options.repoDir, promptsDir);
      const promptText = `${preamble}\n\n${domainPrompt}\n\n${FINDINGS_FORMAT}`.trim();
      workItems.push({ agent, dk, promptText });
    }
  }

  const total = workItems.length;
  let completed = 0;
  const dispatchT0 = performance.now();
  log(
    `plan_review_dispatch: launching ${total} sub-agent(s) in parallel ` +
      `(timeout=${timeout}s, codex 2x)`,
  );

  const tasks = workItems.map(({ agent, dk, promptText }) => async () => {
    let subResult: PlanSubAgentResult;
    try {
      subResult = await runPlanSubagent(agent, dk, planContent, promptText, timeout, log);
    } catch (exc) {
      subResult = {
        agent,
        domain: dk,
        raw_output: "",
        model: agentModelLabel(agent, log),
        findings: [],
        error: (exc as Error).message,
        duration_s: 0.0,
        api_key_fallback: false,
      };
    }
    completed += 1;
    log(
      `  [${completed}/${total}] ${agent}:${dk} ` +
        `(${subResult.error ? subResult.error : "OK"}) ` +
        `${subResult.duration_s.toFixed(1)}s findings=${subResult.findings.length}`,
    );
    return subResult;
  });

  const results = await runPool(tasks, MAX_WORKERS);

  const validCount = results.filter((r) => !r.error).length;
  log(
    `plan_review_dispatch: round ${roundNum} complete — ` +
      `${validCount}/${total} succeeded in ${((performance.now() - dispatchT0) / 1000).toFixed(1)}s`,
  );
  if (total > 0 && validCount / total < 0.5) {
    log(`  Low coverage warning: only ${validCount}/${total} sub-agents succeeded.`);
  }

  // Build findings list with cross-agent dedup on (section, title, agent).
  const allFindingsRaw: Array<Record<string, unknown>> = [];
  for (const r of results) {
    for (const f of r.findings) {
      allFindingsRaw.push({ ...f });
    }
  }
  const seenKeys = new Set<string>();
  const dedupedFindings: Array<Record<string, unknown>> = [];
  for (const f of allFindingsRaw) {
    const key = `${f.section ?? ""} ${f.title ?? ""} ${f.agent ?? ""}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      dedupedFindings.push(f);
    }
  }

  const severityCounts: Record<string, number> = {};
  for (const f of dedupedFindings) {
    const sev = String(f.severity ?? "?");
    severityCounts[sev] = (severityCounts[sev] ?? 0) + 1;
  }

  const serializedResults = results.map((r) => {
    const entry: Record<string, unknown> = {
      agent: r.agent,
      model: r.model,
      domain: r.domain,
      duration_s: r.duration_s,
      findings_count: r.findings.length,
    };
    if (r.error) entry.error = r.error;
    if (r.findings.length > 0) entry.findings = r.findings;
    return entry;
  });

  const modelsInUse: Record<string, string> = {};
  for (const agent of agents) {
    const model = agentModelLabel(agent, log);
    if (model) modelsInUse[agent] = model;
  }


  return {
    round: roundNum,
    agents,
    models: modelsInUse,
    domains: domainKeys,
    results: serializedResults,
    findings: dedupedFindings,
    summary: {
      total_sub_agents: total,
      succeeded: validCount,
      failed: total - validCount,
      total_findings: dedupedFindings.length,
      by_severity: severityCounts,
    },
  };
}
