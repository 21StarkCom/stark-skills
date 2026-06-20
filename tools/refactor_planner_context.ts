// Context-pack builder for the refactor-planner.
//
// The whole point of the dispatcher is that NO subagent sees the whole repo.
// Each agent gets a focused pack: only the files/excerpts/command-outputs it
// needs, plus its constraints and the exact schema it must emit. Packs are
// size-capped so a large repo doesn't blow a single agent's context.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentName, AnalysisFindings, CommandOutput, ContextFile, ContextPack, RepoInventory,
} from "./refactor_planner_schemas.ts";

export interface ContextOptions {
  maxFilesPerPack?: number;
  maxExcerptLines?: number;
  maxPackBytes?: number;
}

const DEFAULTS: Required<ContextOptions> = {
  maxFilesPerPack: 14,
  maxExcerptLines: 120,
  maxPackBytes: 48_000,
};

const SHARED_CONSTRAINTS: string[] = [
  "Do not guess. Every claim must cite a real path and, where relevant, a symbol.",
  "Provide evidence (a search result, an import, a call site, or its absence).",
  "Stay strictly within your task; ignore unrelated observations.",
  "Do not propose broad rewrites. Preserve existing behavior.",
  "Mark uncertainty explicitly rather than inventing detail.",
  "Output ONLY the JSON object defined by your schema — no prose, no markdown fence.",
];

// ── Wave 1: analysis packs (built from the deterministic inventory) ───────────

export function buildAnalysisPacks(inv: RepoInventory, opts: ContextOptions = {}): ContextPack[] {
  const o = { ...DEFAULTS, ...opts };
  return [
    inventoryPack(inv, o),
    commandPack(inv, o),
    architecturePack(inv, o),
    dependencyPack(inv, o),
    duplicationPack(inv, o),
    deadCodePack(inv, o),
    testRiskPack(inv, o),
  ];
}

function inventoryPack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  return pack("repository-inventory",
    "Map the repository structure: languages, frameworks, package managers, build systems, entry points, configs, tests, CI, docs, and generated/vendored paths.",
    pickFiles(inv, [...inv.build_files, ...inv.ci_files].slice(0, o.maxFilesPerPack), o, "manifest / CI"),
    [tree(inv), listOut("entry_points", inv.entry_points), listOut("config_files", inv.config_files), listOut("docs", inv.docs)],
    inv);
}

function commandPack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  const manifests = inv.build_files.filter((f) => /package\.json|Makefile|go\.mod|Cargo\.toml|pyproject\.toml|requirements\.txt|build\.gradle|pom\.xml/.test(path.basename(f)));
  return pack("command-discovery",
    "Determine the install, test, lint, typecheck, build, and format commands. Prefer commands defined in package/build manifests and CI. Use \"unknown\" where a command cannot be determined.",
    pickFiles(inv, [...manifests, ...inv.ci_files].slice(0, o.maxFilesPerPack), o, "command source"),
    [cmdOut("deterministic command seed (refine with evidence)", JSON.stringify(inv.commands, null, 2))],
    inv);
}

function architecturePack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  const sources = [...inv.entry_points, ...inv.largest_files.slice(0, 8).map((f) => f.path)];
  return pack("architecture",
    "Describe the architecture AS IMPLEMENTED: runtime flow, dependency flow, module boundaries, domain vs infrastructure, shared utilities, external integrations, configuration flow, and test organization.",
    pickFiles(inv, dedupe(sources).slice(0, o.maxFilesPerPack), o, "entry point / large module"),
    [importEdgeSummary(inv), listOut("entry_points", inv.entry_points)],
    inv);
}

function dependencyPack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  return pack("dependency-health",
    "Identify unhealthy dependency direction, circular dependencies, framework leakage into domain code, and module-boundary violations. Use the import graph as primary evidence.",
    pickFiles(inv, inv.largest_files.slice(0, o.maxFilesPerPack).map((f) => f.path), o, "module"),
    [importEdgeSummary(inv), cmdOut("precomputed import cycles (host)", JSON.stringify(detectCycles(inv), null, 2))],
    inv);
}

function duplicationPack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  const utilLike = inv.largest_files.map((f) => f.path).filter((p) => /util|helper|common|shared|lib|misc/i.test(p));
  const targets = dedupe([...utilLike, ...inv.largest_files.slice(0, 10).map((f) => f.path)]).slice(0, o.maxFilesPerPack);
  return pack("duplication",
    "Find duplicate functions, overlapping helpers, redundant utilities, and competing canonical implementations. Name the canonical survivor and the call sites to update.",
    pickFiles(inv, targets, o, "utility / large module"),
    [cmdOut("util-like files (heuristic)", utilLike.join("\n") || "(none detected by name)")],
    inv);
}

function deadCodePack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  return pack("dead-code",
    "Identify dead, unreachable, deprecated, or unused code. Be conservative: never call code dead without evidence (e.g. zero in-repo references to an export). Treat entry points and their transitive imports as reachable.",
    pickFiles(inv, inv.largest_files.slice(0, o.maxFilesPerPack).map((f) => f.path), o, "module"),
    [todoSummary(inv), importEdgeSummary(inv), listOut("entry_points (reachable roots)", inv.entry_points)],
    inv);
}

function testRiskPack(inv: RepoInventory, o: Required<ContextOptions>): ContextPack {
  const targets = dedupe([...inv.test_files.slice(0, 8), ...inv.largest_files.slice(0, 8).map((f) => f.path)]).slice(0, o.maxFilesPerPack);
  return pack("test-risk",
    "Identify test coverage gaps, risky areas that must not be moved before tests exist, and the safety-baseline work needed first. Map source modules to their tests.",
    pickFiles(inv, targets, o, "test / risky module"),
    [listOut("test_files", inv.test_files), cmdOut("commands", JSON.stringify(inv.commands, null, 2))],
    inv);
}

// ── Wave 2: synthesis packs (built from normalized wave-1 findings) ───────────

export function buildTargetArchPack(inv: RepoInventory, f: AnalysisFindings): ContextPack {
  return pack("target-architecture",
    "Propose the target directory structure with ownership and dependency rules. Avoid unnecessary abstraction. Ground every directory in the current architecture and the findings.",
    [], [findingsOut(f, ["architecture", "dependencyHealth", "duplication", "testRisk"]), listOut("current_top_level_dirs", topDirs(inv))], inv);
}

export function buildPhasePlannerPack(inv: RepoInventory, f: AnalysisFindings): ContextPack {
  return pack("phase-planner",
    "Turn the findings and target architecture into safe, incremental, behavior-preserving phases (safety baseline; tests before movement; reorg; dedup; dependency cleanup; config cleanup; test cleanup; docs + final validation).",
    [], [findingsOut(f, ["targetArchitecture", "dependencyHealth", "duplication", "deadCode", "testRisk"]), cmdOut("validation commands", JSON.stringify(inv.commands, null, 2))], inv);
}

export function buildSynthesisPack(inv: RepoInventory, f: AnalysisFindings): ContextPack {
  return pack("artifact-synthesis",
    "Resolve conflicts conservatively and produce the narrative prose for the plan (current-architecture summary, conventions, first-PR writeup, open questions). The host assembles and validates the structured backlog; you supply prose grounded in the findings.",
    [], [findingsOut(f, ["inventory", "commands", "architecture", "dependencyHealth", "duplication", "deadCode", "testRisk", "targetArchitecture", "phases"])], inv);
}

/** Lightweight descriptors for ALL ten jobs — used by `dry-run` to show the plan. */
export function planAllJobs(inv: RepoInventory, opts: ContextOptions = {}): ContextPack[] {
  const wave1 = buildAnalysisPacks(inv, opts);
  const empty: AnalysisFindings = {};
  const wave2 = [buildTargetArchPack(inv, empty), buildPhasePlannerPack(inv, empty), buildSynthesisPack(inv, empty)];
  // strip heavy content for the dry-run descriptor view
  return [...wave1, ...wave2].map((p) => ({ ...p, files: p.files.map((cf) => ({ path: cf.path, purpose: cf.purpose, summary: cf.summary })) }));
}

// ── pack assembly + caps ──────────────────────────────────────────────────────

function pack(name: AgentName, task: string, files: ContextFile[], commandOutputs: CommandOutput[], inv: RepoInventory): ContextPack {
  const constraints = [...SHARED_CONSTRAINTS];
  const capped = capBytes(files, commandOutputs);
  return {
    id: `${name}-${inv.git.head?.slice(0, 8) ?? "nohead"}`,
    agentName: name,
    task,
    files: capped.files,
    commandOutputs: capped.commandOutputs,
    constraints,
    expectedSchema: name,
    expectedOutput: "json",
  };
}

function pickFiles(inv: RepoInventory, rels: string[], o: Required<ContextOptions>, purpose: string): ContextFile[] {
  const out: ContextFile[] = [];
  for (const rel of dedupe(rels).slice(0, o.maxFilesPerPack)) {
    out.push(excerptFile(inv.root, rel, o.maxExcerptLines, purpose));
  }
  return out;
}

function excerptFile(root: string, rel: string, maxLines: number, purpose: string): ContextFile {
  const abs = path.join(root, rel);
  let text = "";
  try { text = fs.readFileSync(abs, "utf-8"); } catch { return { path: rel, purpose, summary: "(unreadable)" }; }
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { path: rel, purpose, content: text };
  const head = lines.slice(0, maxLines).join("\n");
  return { path: rel, purpose, excerpt: head, summary: `first ${maxLines} of ${lines.length} lines` };
}

/** Greedily drop file content (keep the path/summary) until under the byte cap. */
function capBytes(files: ContextFile[], cmds: CommandOutput[]): { files: ContextFile[]; commandOutputs: CommandOutput[] } {
  const size = (fsArr: ContextFile[]) => fsArr.reduce((n, f) => n + (f.content?.length ?? f.excerpt?.length ?? 0) + f.path.length, 0);
  const cmdSize = cmds.reduce((n, c) => n + c.output.length, 0);
  const out = files.map((f) => ({ ...f }));
  let i = out.length - 1;
  while (size(out) + cmdSize > DEFAULTS.maxPackBytes && i >= 0) {
    const f = out[i];
    if (f.content || f.excerpt) {
      const kept = (f.excerpt ?? f.content ?? "").split("\n").length;
      out[i] = { path: f.path, purpose: f.purpose, summary: f.summary ?? `dropped to fit context cap (${kept} lines)` };
    }
    i--;
  }
  return { files: out, commandOutputs: cmds };
}

// ── command-output renderers ──────────────────────────────────────────────────

function cmdOut(command: string, output: string): CommandOutput {
  const cap = 16_000;
  return output.length > cap ? { command, output: output.slice(0, cap), truncated: true } : { command, output };
}
function listOut(label: string, items: string[]): CommandOutput {
  return cmdOut(label, items.length ? items.join("\n") : "(none)");
}
function tree(inv: RepoInventory): CommandOutput {
  return cmdOut("directory tree", inv.directory_tree);
}
function todoSummary(inv: RepoInventory): CommandOutput {
  const lines = inv.todo_markers.map((t) => `${t.path}:${t.line} ${t.marker} ${t.text}`);
  return cmdOut(`TODO/FIXME/DEPRECATED markers (${inv.todo_markers.length})`, lines.join("\n") || "(none)");
}
function importEdgeSummary(inv: RepoInventory): CommandOutput {
  const lines = inv.import_edges.slice(0, 600).map((e) => `${e.from} -> ${e.to}`);
  return cmdOut(`intra-repo import edges (${inv.import_edges.length})`, lines.join("\n") || "(none resolved)");
}
function findingsOut(f: AnalysisFindings, keys: (keyof AnalysisFindings)[]): CommandOutput {
  const subset: Record<string, unknown> = {};
  for (const k of keys) if (f[k] !== undefined) subset[k] = f[k];
  return cmdOut("normalized upstream findings", JSON.stringify(subset, null, 2) || "{}");
}

// ── deterministic helpers shared with synth ──────────────────────────────────

export function detectCycles(inv: RepoInventory): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const e of inv.import_edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set());
    adj.get(e.from)!.add(e.to);
  }
  const cycles: string[][] = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const nodes = [...adj.keys()].sort();
  for (const n of nodes) color.set(n, WHITE);

  const dfs = (u: string) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of [...(adj.get(u) ?? [])].sort()) {
      if (!color.has(v)) continue;
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        if (cycles.length < 25) cycles.push([...stack.slice(idx), v]);
      } else if (color.get(v) === WHITE) dfs(v);
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const n of nodes) if (color.get(n) === WHITE) dfs(n);
  return cycles;
}

function topDirs(inv: RepoInventory): string[] {
  return inv.directory_tree.split("\n").filter((l) => !l.startsWith(" ") && l.endsWith("/")).slice(0, 40);
}
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}
