// Cross-check / conflict resolution + deterministic plan assembly.
//
// Conflict resolution and the structured backlog are HOST-owned, not left to an
// LLM: agents supply findings and prose, but the host decides what survives a
// conflict and emits the typed tasks/duplicates so the final JSON is valid and
// the dependency graph is a real DAG (tests before moves, moves before deletes).
//
// Tie-breakers, in order: keep > delete; test before move; move before delete;
// evidence > inference; smaller PRs > large rewrites.

import { detectCycles } from "./refactor_planner_context.ts";
import type {
  AnalysisFindings, BacklogDuplicate, BacklogRiskyArea, BacklogSummary, BacklogTask,
  CommandDiscoveryOutput, Conflict, DeadCodeFinding, DupBacklogAction, DuplicateFinding, FirstPr,
  PlanModel, ProblemRow, RefactorPhase, RepoInventory, Severity, TaskType,
} from "./refactor_planner_schemas.ts";

export interface SynthInput {
  inventory: RepoInventory;
  findings: AnalysisFindings;
  /** Raw artifact-synthesis agent output (prose), if it ran. */
  proseRaw?: unknown;
}

// ── conflict resolution ───────────────────────────────────────────────────────

export function crossCheckAndResolve(inv: RepoInventory, findings: AnalysisFindings): {
  findings: AnalysisFindings;
  conflicts: Conflict[];
} {
  const conflicts: Conflict[] = [];
  const out: AnalysisFindings = { ...findings };

  const entryPoints = new Set([
    ...inv.entry_points,
    ...(findings.architecture?.main_modules ?? []),
    ...(findings.architecture?.api_or_interface_layers ?? []),
  ]);
  const inbound = new Set(inv.import_edges.map((e) => e.to));
  const canonicalPaths = new Set((findings.duplication?.duplicates ?? []).map((d) => d.canonical_replacement).filter(Boolean));

  // 1+2. Dead-code claims that contradict reachability evidence are dropped (keep > delete).
  if (out.deadCode) {
    const kept: DeadCodeFinding[] = [];
    for (const d of out.deadCode.dead_or_suspicious_code) {
      if (entryPoints.has(d.path)) {
        conflicts.push({ kind: "dead-vs-entrypoint", detail: `${d.path} flagged dead but is an entry point / main module`, resolution: "kept (keep over delete)" });
        continue;
      }
      if (inbound.has(d.path)) {
        conflicts.push({ kind: "dead-vs-imported", detail: `${d.path} flagged dead but has inbound imports`, resolution: "downgraded to suspicious; kept pending evidence" });
        kept.push({ ...d, risk: "high", recommended_action: `INVESTIGATE (has inbound imports): ${d.recommended_action}` });
        continue;
      }
      kept.push(d);
    }
    out.deadCode = { dead_or_suspicious_code: kept };
  }

  // 3. A duplicate whose "delete/replace" target IS the canonical survivor is contradictory → keep.
  if (out.duplication) {
    const fixed = out.duplication.duplicates.map((d) => {
      const deletesCanonical = (d.action === "delete" || d.action === "replace") && d.paths.includes(d.canonical_replacement);
      if (deletesCanonical) {
        conflicts.push({ kind: "delete-vs-canonical", detail: `${d.id} would delete its own canonical ${d.canonical_replacement}`, resolution: "action downgraded to merge" });
        return { ...d, action: "merge" as const };
      }
      return d;
    });
    out.duplication = { duplicates: fixed };
  }

  // (Target-architecture contradictions are checked in `resolveWave2Conflicts`,
  // which runs AFTER the target-architecture agent — see finding #1.)

  // 5. Import cycles surfaced by the host but not addressed by the dependency agent.
  const cycles = detectCycles(inv);
  if (cycles.length && !(out.dependencyHealth?.dependency_issues.length)) {
    conflicts.push({ kind: "unaddressed-cycles", detail: `${cycles.length} import cycle(s) detected by host but no dependency findings`, resolution: "added host-derived dependency problems" });
  }

  // `canonicalPaths` participates in dedup reasoning above via the delete-vs-canonical rule.
  void canonicalPaths;
  return { findings: out, conflicts };
}

/**
 * Second conflict pass, run AFTER wave 2 (target-architecture + phase-planner)
 * so it can see the dependency rules those agents produce — which the wave-1
 * `crossCheckAndResolve` cannot (finding #1). Currently catches a target
 * directory that both allows and forbids the same dependency.
 */
export function resolveWave2Conflicts(findings: AnalysisFindings): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const dir of findings.targetArchitecture?.target_directories ?? []) {
    const overlap = dir.allowed_dependencies.filter((a) => dir.forbidden_dependencies.includes(a));
    if (overlap.length) {
      conflicts.push({ kind: "dep-rule-contradiction", detail: `${dir.path} both allows and forbids: ${overlap.join(", ")}`, resolution: "treated as forbidden (stricter wins)" });
    }
  }
  // A phase that moves/deletes a risky-area path must not precede the tests-before-movement phase.
  const phases = findings.phases?.phases ?? [];
  const riskyPaths = new Set((findings.testRisk?.risky_areas ?? []).map((r) => r.path));
  const testsPhaseIdx = phases.findIndex((p) => /test/i.test(p.name) && /before|baseline|coverage/i.test(p.name));
  if (testsPhaseIdx >= 0) {
    for (let i = 0; i < testsPhaseIdx; i++) {
      const early = phases[i];
      const touchesRisky = early.affected_paths.some((p) => riskyPaths.has(p));
      if (touchesRisky && /move|reorg|delete|dedup/i.test(early.name)) {
        conflicts.push({ kind: "phase-before-tests", detail: `phase ${early.number} "${early.name}" touches a risky path before the tests phase`, resolution: "reorder: schedule tests-before-movement first" });
      }
    }
  }
  return conflicts;
}

// ── plan model assembly ───────────────────────────────────────────────────────

const REQUIRED_PHASES = [
  "Safety baseline", "Test coverage before movement", "Directory/module reorganization",
  "Deduplication", "Dependency cleanup", "Configuration cleanup", "Test cleanup",
  "Documentation and final validation",
];

export function buildPlanModel(input: SynthInput, conflicts: Conflict[]): PlanModel {
  const { inventory: inv, findings } = input;
  const commands = findings.commands ?? toAgentCommands(inv);
  const summary = buildSummary(inv, findings);

  const problems = buildProblems(inv, findings);
  const duplicates_table = findings.duplication?.duplicates ?? [];
  const dead_code = findings.deadCode?.dead_or_suspicious_code ?? [];
  const risky_areas: BacklogRiskyArea[] = findings.testRisk?.risky_areas ?? [];

  const validationCommands = pickValidationCommands(commands);
  const { tasks } = buildTasks(findings, validationCommands);
  const duplicates_backlog = buildBacklogDuplicates(duplicates_table);
  const phases = buildPhases(findings, validationCommands);

  const prose = readProse(input.proseRaw);

  return {
    summary,
    architectural_style: prose.architectural_style ?? inferStyle(inv, findings),
    main_risk_areas: prose.main_risk_areas ?? deriveRiskAreas(findings),
    inventory: inv,
    architecture: findings.architecture,
    current_architecture_narrative: prose.current_architecture_narrative ?? (findings.architecture?.current_architecture ?? "(architecture agent produced no narrative)"),
    problems,
    duplicates_table,
    dead_code,
    target_architecture: findings.targetArchitecture,
    phases,
    tasks,
    duplicates_backlog,
    risky_areas,
    conventions: prose.conventions ?? defaultConventions(findings),
    first_pr: prose.first_pr ?? deriveFirstPr(tasks, validationCommands),
    open_questions: prose.open_questions ?? deriveOpenQuestions(findings, conflicts),
    conflicts,
  };
}

// ── summary / style ────────────────────────────────────────────────────────────

function buildSummary(inv: RepoInventory, f: AnalysisFindings): BacklogSummary {
  const c = f.commands;
  const cmd = (agentVal: string | undefined, invVal: string) =>
    agentVal && agentVal !== "unknown" ? agentVal : invVal;
  return {
    language: f.inventory?.language || inv.languages[0] || "unknown",
    framework: (f.inventory?.frameworks ?? inv.frameworks)[0] ?? "none",
    package_manager: f.inventory?.package_manager || inv.package_managers[0] || "unknown",
    install_command: cmd(c?.install_command, inv.commands.install_command),
    test_command: cmd(c?.test_command, inv.commands.test_command),
    build_command: cmd(c?.build_command, inv.commands.build_command),
    lint_command: cmd(c?.lint_command, inv.commands.lint_command),
    typecheck_command: cmd(c?.typecheck_command, inv.commands.typecheck_command),
  };
}

function inferStyle(inv: RepoInventory, f: AnalysisFindings): string {
  if (f.architecture?.current_architecture) return f.architecture.current_architecture.split("\n")[0].slice(0, 120);
  const langs = inv.languages.slice(0, 2).join("/") || "unknown";
  return `${langs} project (${inv.file_count} files); architecture not yet characterized`;
}

function deriveRiskAreas(f: AnalysisFindings): string[] {
  const out: string[] = [];
  for (const r of f.testRisk?.risky_areas ?? []) out.push(`${r.path}: ${r.reason}`);
  for (const i of f.dependencyHealth?.dependency_issues ?? []) if (i.severity === "critical" || i.severity === "high") out.push(`${i.paths.join(", ")}: ${i.problem}`);
  return out.slice(0, 12);
}

// ── problems table ─────────────────────────────────────────────────────────────

function buildProblems(inv: RepoInventory, f: AnalysisFindings): ProblemRow[] {
  const rows: ProblemRow[] = [];
  let n = 1;
  const id = () => `P-${String(n++).padStart(3, "0")}`;
  for (const d of f.dependencyHealth?.dependency_issues ?? []) {
    rows.push({ id: id(), severity: d.severity, area: "Dependencies", paths: d.paths, problem: d.problem, evidence: d.evidence, why_it_matters: "Unhealthy dependency direction makes change unsafe and testing hard.", recommended_fix: d.recommended_fix });
  }
  for (const risk of f.architecture?.architecture_risks ?? []) {
    rows.push({ id: id(), severity: "medium", area: "Architecture", paths: [], problem: risk, evidence: ["architecture agent"], why_it_matters: "Architectural risk raises the blast radius of refactors.", recommended_fix: "Address during reorganization phase." });
  }
  for (const g of f.testRisk?.test_gaps ?? []) {
    rows.push({ id: id(), severity: g.risk === "high" ? "high" : "medium", area: "Tests", paths: [g.path], problem: g.gap, evidence: ["test-risk agent"], why_it_matters: "Untested code cannot be moved safely.", recommended_fix: g.recommended_test });
  }
  // Host-derived: large god-modules with no other finding.
  for (const big of inv.largest_files.slice(0, 3)) {
    if (big.loc > 800) rows.push({ id: id(), severity: "medium", area: "Maintainability", paths: [big.path], problem: `Large module (${big.loc} LOC) — likely mixed responsibilities`, evidence: [`${big.path} has ${big.loc} lines`], why_it_matters: "God modules are hard to navigate, test, and split.", recommended_fix: "Split by responsibility during reorganization." });
  }
  return rows;
}

// ── tasks (the dependency-DAG backbone) ───────────────────────────────────────

function buildTasks(f: AnalysisFindings, validation: string[]): { tasks: BacklogTask[] } {
  const tasks: BacklogTask[] = [];
  let n = 1;
  const nextId = () => `RF-${String(n++).padStart(3, "0")}`;
  const pathToTestTask = new Map<string, string>();

  // 1) Safety / test tasks first — no dependencies.
  for (const r of f.testRisk?.risky_areas ?? []) {
    const id = nextId();
    for (const p of [r.path]) pathToTestTask.set(p, id);
    tasks.push(mkTask(id, `Add tests for ${r.path} before refactor`, "test", "high", "low", [r.path], r.required_tests_before_refactor.length ? r.required_tests_before_refactor : [`Add coverage for ${r.path}`], [], validation, `Tests are additive; revert the test files if they fail to compile.`, [r.reason]));
  }
  for (const g of f.testRisk?.test_gaps ?? []) {
    if (pathToTestTask.has(g.path)) continue;
    const id = nextId();
    pathToTestTask.set(g.path, id);
    tasks.push(mkTask(id, `Cover test gap: ${g.path}`, "test", g.risk === "high" ? "high" : "medium", "low", [g.path], [g.recommended_test], [], validation, "Tests are additive; safe to revert.", [g.gap]));
  }

  const depsForPaths = (paths: string[]): string[] => {
    const deps = new Set<string>();
    for (const p of paths) { const t = pathToTestTask.get(p); if (t) deps.add(t); }
    return [...deps];
  };

  // 2) Dependency-cleanup tasks.
  for (const d of f.dependencyHealth?.dependency_issues ?? []) {
    const id = nextId();
    tasks.push(mkTask(id, `Fix dependency issue: ${truncate(d.problem, 60)}`, "architecture", d.severity, sevToRisk(d.severity), d.paths, [d.recommended_fix], depsForPaths(d.paths), validation, "Revert the import/boundary change; re-run the build.", d.evidence));
  }

  // 3) Deduplication tasks (move/merge before delete).
  const mergeIdByPath = new Map<string, string>();
  for (const dup of f.duplication?.duplicates ?? []) {
    const type = dupActionToTaskType(dup.action);
    const id = nextId();
    for (const p of dup.paths) mergeIdByPath.set(p, id);
    tasks.push(mkTask(id, `Deduplicate ${dup.symbols.join(", ") || dup.paths.join(", ")}`, type, "medium", "medium",
      dup.paths, [`Consolidate into ${dup.canonical_replacement}`, ...(dup.call_sites_to_update.length ? [`Update call sites: ${dup.call_sites_to_update.join(", ")}`] : [])],
      depsForPaths(dup.paths), validation, "Restore the duplicated file and its imports.", dup.evidence));
  }

  // 4) Dead-code: emit a `delete` task ONLY when the recommendation is an explicit
  //    removal. Investigate/suspicious findings (including conflict-downgraded
  //    "INVESTIGATE …" ones) become non-destructive investigation tasks so an
  //    executor never deletes code on a soft signal (finding #2; keep > delete).
  for (const dc of f.deadCode?.dead_or_suspicious_code ?? []) {
    const id = nextId();
    const deps = new Set(depsForPaths([dc.path]));
    const m = mergeIdByPath.get(dc.path); if (m) deps.add(m);
    if (isExplicitDelete(dc.recommended_action)) {
      tasks.push(mkTask(id, `Remove dead code: ${dc.symbol_or_file}`, "delete", "low", dc.risk, [dc.path], [dc.recommended_action], [...deps], validation, "Restore the file from git history.", dc.evidence));
    } else {
      tasks.push(mkTask(id, `Investigate suspected dead code: ${dc.symbol_or_file}`, "test", "low", dc.risk, [dc.path],
        [`Confirm reachability before any removal: ${dc.recommended_action}`, "If confirmed dead, raise a follow-up delete task; otherwise close."],
        [...deps], validation, "No code change; investigation only.", dc.evidence));
    }
  }

  return { tasks };
}

function mkTask(
  id: string, title: string, type: TaskType, severity: Severity, risk: BacklogTask["risk"],
  paths: string[], steps: string[], depends_on: string[], validation_commands: string[], rollback_plan: string, evidence: string[],
): BacklogTask {
  return { id, title, type, severity, risk, status: "planned", paths, symbols: [], description: title, evidence, implementation_steps: steps, depends_on, validation_commands, rollback_plan };
}

// ── backlog duplicates ─────────────────────────────────────────────────────────

function buildBacklogDuplicates(dups: DuplicateFinding[]): BacklogDuplicate[] {
  let n = 1;
  return dups.map((d) => ({
    id: `DUP-${String(n++).padStart(3, "0")}`,
    paths: d.paths,
    symbols: d.symbols,
    canonical_path: d.canonical_replacement,
    action: toBacklogDupAction(d.action),
    reason: d.duplicate_or_overlap,
    evidence: d.evidence,
  }));
}

function toBacklogDupAction(a: string): DupBacklogAction {
  if (a === "delete" || a === "merge" || a === "replace" || a === "keep") return a;
  return "merge"; // rename/move collapse to merge in the backlog vocabulary
}
function dupActionToTaskType(a: string): TaskType {
  switch (a) {
    case "delete": return "delete";
    case "rename": return "rename";
    case "move": return "move";
    case "replace": return "replace";
    default: return "merge";
  }
}

// ── phases ─────────────────────────────────────────────────────────────────────

function buildPhases(f: AnalysisFindings, validation: string[]): RefactorPhase[] {
  if (f.phases?.phases.length) return f.phases.phases;
  // Host fallback: the eight required phases with risk-appropriate defaults.
  return REQUIRED_PHASES.map((name, i) => ({
    number: i + 1,
    name,
    goal: `${name} (auto-generated; refine with findings).`,
    actions: [`Execute ${name.toLowerCase()} using the file-by-file plan.`],
    affected_paths: [],
    validation_commands: validation,
    rollback: "Revert the phase's commits; re-run validation.",
    risk: i <= 1 ? "low" : i <= 4 ? "medium" : "low",
  }));
}

// ── prose extraction ───────────────────────────────────────────────────────────

interface Prose {
  architectural_style?: string;
  main_risk_areas?: string[];
  current_architecture_narrative?: string;
  conventions?: string[];
  first_pr?: FirstPr;
  open_questions?: string[];
}

function readProse(raw: unknown): Prose {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined => Array.isArray(v) && v.every((x) => typeof x === "string") ? v as string[] : undefined;
  const str = (v: unknown): string | undefined => typeof v === "string" ? v : undefined;
  let first_pr: FirstPr | undefined;
  if (o.first_pr && typeof o.first_pr === "object") {
    const fp = o.first_pr as Record<string, unknown>;
    first_pr = {
      title: str(fp.title) ?? "First refactor PR",
      goal: str(fp.goal) ?? "",
      files: strArr(fp.files) ?? [],
      steps: strArr(fp.steps) ?? [],
      validation: strArr(fp.validation) ?? [],
      why_low_risk: str(fp.why_low_risk) ?? "",
    };
  }
  return {
    architectural_style: str(o.architectural_style),
    main_risk_areas: strArr(o.main_risk_areas),
    current_architecture_narrative: str(o.current_architecture_narrative),
    conventions: strArr(o.conventions),
    first_pr,
    open_questions: strArr(o.open_questions),
  };
}

// ── host defaults ────────────────────────────────────────────────────────────

function defaultConventions(f: AnalysisFindings): string[] {
  const base = [
    "Directory ownership: each top-level dir has one responsibility (see target architecture).",
    "Naming: keep file names consistent with the dominant convention already in the repo.",
    "Module boundaries: domain code must not import infrastructure/framework code.",
    "Imports: no cycles; dependency direction points inward toward domain logic.",
    "Shared utilities: prefer domain-scoped modules over a global misc/helpers/utils dump.",
    "Testing: add tests before moving risky logic; keep tests beside or mirroring source.",
  ];
  if (f.targetArchitecture?.rationale.length) base.push(...f.targetArchitecture.rationale.slice(0, 4));
  return base;
}

function deriveFirstPr(tasks: BacklogTask[], validation: string[]): FirstPr {
  const firstTest = tasks.find((t) => t.type === "test");
  if (firstTest) {
    return {
      title: `Safety baseline: ${firstTest.title}`,
      goal: "Establish test coverage on a risky area before any code moves — pure additive change.",
      files: firstTest.paths,
      steps: firstTest.implementation_steps,
      validation,
      why_low_risk: "Adds tests only; no source is moved, renamed, or deleted, so behavior cannot change.",
    };
  }
  return {
    title: "Adopt refactor plan artifacts",
    goal: "Land REFACTOR_PLAN.md + REFACTOR_BACKLOG.json and wire the validate gate.",
    files: ["REFACTOR_PLAN.md", "REFACTOR_BACKLOG.json"],
    steps: ["Review the generated plan", "Commit the two artifacts", "Run the validate mode in CI"],
    validation,
    why_low_risk: "Adds planning documents only; touches no source.",
  };
}

function deriveOpenQuestions(f: AnalysisFindings, conflicts: Conflict[]): string[] {
  const qs: string[] = [];
  for (const c of conflicts) qs.push(`Conflict (${c.kind}): ${c.detail} — confirm resolution: ${c.resolution}`);
  if (!f.testRisk?.risky_areas.length) qs.push("No risky areas were identified — confirm the test-risk pass was complete before deleting anything.");
  return qs.slice(0, 12);
}

// ── command helpers ────────────────────────────────────────────────────────────

function pickValidationCommands(commands: { test_command?: string; typecheck_command?: string; build_command?: string }): string[] {
  return [commands.test_command, commands.typecheck_command, commands.build_command].filter((c): c is string => !!c && c !== "unknown");
}

function toAgentCommands(inv: RepoInventory): CommandDiscoveryOutput {
  return { ...inv.commands, evidence: ["deterministic discovery"] };
}

function sevToRisk(s: Severity): BacklogTask["risk"] {
  return s === "critical" || s === "high" ? "high" : s === "medium" ? "medium" : "low";
}
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + "…" : s; }

/** A dead-code recommendation only earns a `delete` task when it explicitly says
 * remove/delete AND isn't hedged with investigate/verify/suspicious language. */
function isExplicitDelete(recommendedAction: string): boolean {
  const a = recommendedAction.toLowerCase();
  if (/\b(investigat|verify|confirm|review|suspicious|unsure|maybe)\b/.test(a)) return false;
  return /\b(delete|remove|drop|prune|dead-?code)\b/.test(a);
}
