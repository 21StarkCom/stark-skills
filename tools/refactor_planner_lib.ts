// Orchestrator for the refactor-planner dispatcher.
//
// Flow: RepositoryDiscovery → ContextPlanner → FocusedSubagentFanout →
// ResultNormalizer → CrossCheckAndConflictResolver → PlanSynthesizer →
// JsonBacklogValidator → ArtifactWriter. Three modes: dry-run (inventory + jobs,
// no LLM), run (full multi-agent), validate (gate an existing backlog).
//
// Planning-only guarantee: the only writes are .refactor-planner/ (intermediates)
// and the two root artifacts. No application source is ever touched.

import * as fs from "node:fs";
import * as path from "node:path";
import { assetPromptsDir } from "./asset_root_lib.ts";
import { buildAnalysisPacks, buildPhasePlannerPack, buildSynthesisPack, buildTargetArchPack, planAllJobs } from "./refactor_planner_context.ts";
import { discoverRepo, DEFAULT_EXCLUDES, type DiscoverOptions } from "./refactor_planner_discovery.ts";
import { buildBacklog, writeArtifacts } from "./refactor_planner_artifacts.ts";
import { createProvider, resolveProviderConfig, type AgentProvider, type ProviderConfig } from "./refactor_planner_provider.ts";
export type { AgentProvider } from "./refactor_planner_provider.ts";
import { buildPlanModel, crossCheckAndResolve, resolveWave2Conflicts } from "./refactor_planner_synth.ts";
import {
  OUTPUT_VALIDATORS, validateBacklog,
  type AgentName, type AnalysisFindings, type ContextPack, type RepoInventory,
} from "./refactor_planner_schemas.ts";

export type RunMode = "dry-run" | "run" | "validate";

export interface DispatcherOptions {
  mode: RunMode;
  root: string;
  provider?: Partial<ProviderConfig>;
  discover?: DiscoverOptions;
  outDir?: string;          // default <root>/.refactor-planner
  maxConcurrency?: number;
  overwrite?: boolean;      // overwrite existing artifacts (default true for run)
  promptsDir?: string;
  allowPartial?: boolean;   // write a plan even if some subagents failed (non-noop)
  /** Test seam: inject a provider instead of constructing one from config. */
  providerInstance?: AgentProvider;
}

export interface Diagnostic { agent: AgentName; error: string; rawPath?: string; }

export interface DispatcherReceipt {
  mode: RunMode;
  ok: boolean;
  root: string;
  provider: string;
  outDir: string;
  inventorySummary?: Record<string, unknown>;
  plannedJobs?: { agent: AgentName; files: number; commandOutputs: number; task: string }[];
  findingCounts?: Record<string, number>;
  conflicts?: number;
  validation?: { ok: boolean; errors: string[]; warnings: string[] };
  artifacts?: { planPath: string; backlogPath: string };
  diagnostics: Diagnostic[];
  errors: string[];
}

const SLOT: Record<Exclude<AgentName, "artifact-synthesis">, keyof AnalysisFindings> = {
  "repository-inventory": "inventory",
  "command-discovery": "commands",
  "architecture": "architecture",
  "dependency-health": "dependencyHealth",
  "duplication": "duplication",
  "dead-code": "deadCode",
  "test-risk": "testRisk",
  "target-architecture": "targetArchitecture",
  "phase-planner": "phases",
};

export async function runDispatcher(opts: DispatcherOptions): Promise<DispatcherReceipt> {
  const root = path.resolve(opts.root);
  const outDir = opts.outDir ?? path.join(root, ".refactor-planner");
  const providerConfig = resolveProviderConfig(opts.provider);
  const receipt: DispatcherReceipt = {
    mode: opts.mode, ok: false, root, provider: providerConfig.provider, outDir, diagnostics: [], errors: [],
  };

  if (opts.mode === "validate") return validateMode(opts, root, providerConfig, receipt);

  // discovery (dry-run + run)
  const inv = discoverRepo(root, opts.discover);
  ensureDir(outDir);
  writeJson(path.join(outDir, "inventory.json"), inv);
  receipt.inventorySummary = inventorySummary(inv);

  if (opts.mode === "dry-run") {
    const jobs = planAllJobs(inv);
    ensureDir(path.join(outDir, "context-packs"));
    for (const j of jobs) writeJson(path.join(outDir, "context-packs", `${j.agentName}.json`), j);
    receipt.plannedJobs = jobs.map((j) => ({ agent: j.agentName, files: j.files.length, commandOutputs: j.commandOutputs.length, task: j.task }));
    receipt.ok = true;
    writeJson(path.join(outDir, "run-summary.json"), receipt);
    return receipt;
  }

  // run mode
  const provider = opts.providerInstance ?? createProvider(providerConfig);
  const promptsDir = resolvePromptsDir(opts.promptsDir);
  ensureDir(path.join(outDir, "subagent-results"));
  ensureDir(path.join(outDir, "diagnostics"));

  const findings: AnalysisFindings = {};

  // Wave 1: analysis agents, in parallel (bounded).
  const wave1 = buildAnalysisPacks(inv);
  await fanout(wave1, opts.maxConcurrency ?? 4, async (pack) => {
    await dispatchInto(provider, promptsDir, pack, inv, findings, outDir, receipt);
  });

  // Cross-check after wave 1 so wave 2 reasons over cleaned findings.
  const resolved = crossCheckAndResolve(inv, findings);
  Object.assign(findings, resolved.findings);
  const conflicts = [...resolved.conflicts];

  // Wave 2: synthesis agents, sequential (each depends on the prior).
  await dispatchInto(provider, promptsDir, buildTargetArchPack(inv, findings), inv, findings, outDir, receipt);
  await dispatchInto(provider, promptsDir, buildPhasePlannerPack(inv, findings), inv, findings, outDir, receipt);
  const proseRaw = await dispatchProse(provider, promptsDir, buildSynthesisPack(inv, findings), inv, outDir, receipt);

  // Second conflict pass — now that wave-2 dependency rules exist (finding #1).
  conflicts.push(...resolveWave2Conflicts(findings));
  receipt.conflicts = conflicts.length;
  receipt.findingCounts = countFindings(findings);

  // A real (non-noop) provider that produced agent failures must not silently
  // yield a "successful" partial/empty plan (findings #3/#6). Fail loudly unless
  // the caller explicitly opted into a partial run.
  if (providerConfig.provider !== "noop" && receipt.diagnostics.length > 0 && !opts.allowPartial) {
    receipt.errors.push(`${receipt.diagnostics.length} subagent failure(s); refusing to write a partial plan (pass --allow-partial to override). See diagnostics.`);
    writeJson(path.join(outDir, "run-summary.json"), receipt);
    return receipt;
  }

  // Synthesize + validate + write.
  const model = buildPlanModel({ inventory: inv, findings, proseRaw }, conflicts);
  const backlog = buildBacklog(model);
  const existing = new Set(allRepoPaths(inv));
  const v = validateBacklog(backlog, existing);
  receipt.validation = { ok: v.ok, errors: v.errors, warnings: v.warnings };

  if (!v.ok) {
    receipt.errors.push("assembled backlog failed validation — see validation.errors");
    writeJson(path.join(outDir, "subagent-results", "backlog.invalid.json"), backlog);
    writeJson(path.join(outDir, "run-summary.json"), receipt);
    return receipt;
  }

  const overwrite = opts.overwrite ?? true;
  if (!overwrite && (fs.existsSync(path.join(root, "REFACTOR_PLAN.md")) || fs.existsSync(path.join(root, "REFACTOR_BACKLOG.json")))) {
    receipt.errors.push("artifacts already exist and overwrite=false");
    writeJson(path.join(outDir, "run-summary.json"), receipt);
    return receipt;
  }

  const written = writeArtifacts(root, model);
  receipt.artifacts = written;
  receipt.ok = true;
  writeJson(path.join(outDir, "run-summary.json"), receipt);
  return receipt;
}

// ── validate mode ──────────────────────────────────────────────────────────────

function validateMode(opts: DispatcherOptions, root: string, _pc: ProviderConfig, receipt: DispatcherReceipt): DispatcherReceipt {
  const backlogPath = path.join(root, "REFACTOR_BACKLOG.json");
  if (!fs.existsSync(backlogPath)) {
    receipt.errors.push(`no REFACTOR_BACKLOG.json at ${root}`);
    return receipt;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(fs.readFileSync(backlogPath, "utf-8")); }
  catch (e) { receipt.errors.push(`backlog is not valid JSON: ${(e as Error).message}`); return receipt; }

  // Path-existence warnings need the current file set.
  const inv = discoverRepo(root, opts.discover);
  const existing = new Set(allRepoPaths(inv));
  const v = validateBacklog(parsed, existing);
  receipt.validation = { ok: v.ok, errors: v.errors, warnings: v.warnings };
  receipt.ok = v.ok;
  return receipt;
}

// ── dispatch helpers ───────────────────────────────────────────────────────────

async function dispatchInto(
  provider: AgentProvider, promptsDir: string, pack: ContextPack, inv: RepoInventory,
  findings: AnalysisFindings, outDir: string, receipt: DispatcherReceipt,
): Promise<void> {
  if (pack.agentName === "artifact-synthesis") return; // handled by dispatchProse
  const result = await runAgent(provider, promptsDir, pack);
  writeRaw(outDir, pack.agentName, result.rawText);
  if (result.error || result.parsedJson === undefined) {
    receipt.diagnostics.push({ agent: pack.agentName, error: result.error ?? "no JSON parsed", rawPath: rawPath(outDir, pack.agentName) });
    return;
  }
  const validator = OUTPUT_VALIDATORS[pack.agentName as Exclude<AgentName, "artifact-synthesis">];
  const v = validator(result.parsedJson);
  if (!v.ok) {
    receipt.diagnostics.push({ agent: pack.agentName, error: `schema validation failed: ${v.errors.slice(0, 4).join("; ")}`, rawPath: rawPath(outDir, pack.agentName) });
    writeJson(path.join(outDir, "diagnostics", `${pack.agentName}.errors.json`), v.errors);
    return;
  }
  const slot = SLOT[pack.agentName as Exclude<AgentName, "artifact-synthesis">];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (findings as Record<string, unknown>)[slot] = v.value;
  writeJson(path.join(outDir, "subagent-results", `${pack.agentName}.json`), v.value);
  void inv;
}

async function dispatchProse(
  provider: AgentProvider, promptsDir: string, pack: ContextPack, _inv: RepoInventory, outDir: string, receipt: DispatcherReceipt,
): Promise<unknown> {
  const result = await runAgent(provider, promptsDir, { ...pack, expectedOutput: "json" });
  writeRaw(outDir, pack.agentName, result.rawText);
  if (result.error || result.parsedJson === undefined) {
    receipt.diagnostics.push({ agent: pack.agentName, error: result.error ?? "no prose JSON parsed", rawPath: rawPath(outDir, pack.agentName) });
    return undefined;
  }
  writeJson(path.join(outDir, "subagent-results", `${pack.agentName}.json`), result.parsedJson);
  return result.parsedJson;
}

async function runAgent(provider: AgentProvider, promptsDir: string, pack: ContextPack) {
  const systemPrompt = loadPrompt(promptsDir, pack.agentName);
  const userPrompt = buildUserPrompt(pack);
  return provider.runAgent({
    agentName: pack.agentName,
    systemPrompt,
    userPrompt,
    contextFiles: pack.files,
    expectedOutput: pack.expectedOutput,
  });
}

function buildUserPrompt(pack: ContextPack): string {
  const parts = [pack.task, "", "Constraints:", ...pack.constraints.map((c) => `- ${c}`)];
  if (pack.commandOutputs.length) {
    parts.push("", "Command / host outputs:");
    for (const c of pack.commandOutputs) {
      parts.push("", `### ${c.command}${c.truncated ? " (truncated)" : ""}`, "```", c.output, "```");
    }
  }
  return parts.join("\n");
}

// ── prompt loading ─────────────────────────────────────────────────────────────

function resolvePromptsDir(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.STARK_REFACTOR_PROMPTS) return process.env.STARK_REFACTOR_PROMPTS;
  return path.join(assetPromptsDir(), "refactor-planner");
}

function loadPrompt(dir: string, agent: AgentName): string {
  const p = path.join(dir, `${agent}.md`);
  try { return fs.readFileSync(p, "utf-8"); }
  catch { return FALLBACK_PROMPT(agent); }
}

function FALLBACK_PROMPT(agent: AgentName): string {
  return [
    `You are the ${agent} subagent of a repository refactor-planning system.`,
    "Work only within your narrow responsibility described in the task.",
    "Do not guess. Cite real paths and symbols. Provide evidence. Mark uncertainty.",
    "Do not propose broad rewrites. Preserve behavior.",
    "Output ONLY the JSON object matching your schema.",
  ].join("\n");
}

// ── small utils ────────────────────────────────────────────────────────────────

async function fanout<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

function inventorySummary(inv: RepoInventory): Record<string, unknown> {
  return {
    languages: inv.languages,
    package_managers: inv.package_managers,
    frameworks: inv.frameworks,
    file_count: inv.file_count,
    entry_points: inv.entry_points.length,
    test_files: inv.test_files.length,
    largest_file: inv.largest_files[0] ?? null,
    todo_markers: inv.todo_markers.length,
    import_edges: inv.import_edges.length,
    commands: inv.commands,
  };
}

function countFindings(f: AnalysisFindings): Record<string, number> {
  return {
    dependency_issues: f.dependencyHealth?.dependency_issues.length ?? 0,
    duplicates: f.duplication?.duplicates.length ?? 0,
    dead_code: f.deadCode?.dead_or_suspicious_code.length ?? 0,
    test_gaps: f.testRisk?.test_gaps.length ?? 0,
    risky_areas: f.testRisk?.risky_areas.length ?? 0,
    target_dirs: f.targetArchitecture?.target_directories.length ?? 0,
    phases: f.phases?.phases.length ?? 0,
  };
}

function allRepoPaths(inv: RepoInventory): string[] {
  // The full file list (finding #7) — an accurate set so the path-existence gate
  // can't false-error on a real file that wasn't in the notable-files subset.
  return inv.all_paths;
}

function ensureDir(d: string): void { fs.mkdirSync(d, { recursive: true }); }
function writeJson(p: string, v: unknown): void { fs.writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf-8"); }
function rawPath(outDir: string, agent: AgentName): string { return path.join(outDir, "subagent-results", `${agent}.raw.txt`); }
function writeRaw(outDir: string, agent: AgentName, text: string): void {
  ensureDir(path.join(outDir, "subagent-results"));
  fs.writeFileSync(rawPath(outDir, agent), text, "utf-8");
}

export { DEFAULT_EXCLUDES };
