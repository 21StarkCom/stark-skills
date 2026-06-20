// Tests for the refactor-planner dispatcher.
//
// Covers: deterministic discovery + cycle detection, schema validators, the
// backlog gate (DAG / id / enum / path checks), context-pack caps, conflict
// resolution, plan assembly with test-before-delete ordering, artifact
// rendering, and the three dispatcher modes end-to-end via the noop provider.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";

import { discoverRepo } from "./refactor_planner_discovery.ts";
import { buildAnalysisPacks, detectCycles, planAllJobs } from "./refactor_planner_context.ts";
import { crossCheckAndResolve, buildPlanModel, resolveWave2Conflicts } from "./refactor_planner_synth.ts";
import type { AgentProvider } from "./refactor_planner_lib.ts";
import { renderPlanMarkdown, buildBacklog } from "./refactor_planner_artifacts.ts";
import { extractJsonObject } from "./refactor_planner_provider.ts";
import { runDispatcher } from "./refactor_planner_lib.ts";
import {
  validateBacklog, validateInventory, validateDependencyHealth,
  type AnalysisFindings, type RefactorBacklog,
} from "./refactor_planner_schemas.ts";

// ── fixture repo ──────────────────────────────────────────────────────────────

let fixture: string;

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "refplan-"));
  write("package.json", JSON.stringify({
    name: "fix", scripts: { test: "node --test", lint: "eslint .", build: "tsc -p ." },
    dependencies: { express: "^4" },
  }));
  write("src/a.ts", `import { b } from "./b.ts";\n// TODO: refactor this\nexport const a = () => b();\n`);
  write("src/b.ts", `import { a } from "./a.ts";\nexport const b = () => a();\n`); // cycle a<->b
  write("src/index.ts", `import { a } from "./a.ts";\nexport function main() { return a(); }\n`);
  write("src/util/helper.ts", `export const help = () => 1;\n`);
  write("tests/a.test.ts", `import { a } from "../src/a.ts";\n`);
  write("node_modules/dep/index.js", "module.exports = 1;\n"); // must be excluded
  write("README.md", "# fixture\n");
});

after(() => { try { fs.rmSync(fixture, { recursive: true, force: true }); } catch { /* ignore */ } });

function write(rel: string, content: string): void {
  const p = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ── discovery ─────────────────────────────────────────────────────────────────

test("discovery detects language, package manager, commands, todos; excludes node_modules", () => {
  const inv = discoverRepo(fixture);
  assert.ok(inv.languages.includes("TypeScript"));
  assert.ok(inv.package_managers.includes("npm"));
  assert.equal(inv.commands.test_command, "npm run test");
  assert.equal(inv.commands.lint_command, "npm run lint");
  assert.equal(inv.commands.build_command, "npm run build");
  assert.ok(inv.frameworks.includes("Express"));
  assert.ok(inv.entry_points.includes("src/index.ts"));
  assert.ok(inv.todo_markers.some((t) => t.path === "src/a.ts" && t.marker === "TODO"));
  assert.ok(!inv.largest_files.some((f) => f.path.includes("node_modules")), "node_modules must be excluded");
  assert.ok(inv.test_files.includes("tests/a.test.ts"));
});

test("import-edge cycle detection finds the a<->b cycle", () => {
  const inv = discoverRepo(fixture);
  const cycles = detectCycles(inv);
  assert.ok(cycles.length >= 1, "expected at least one cycle");
  const flat = cycles.flat();
  assert.ok(flat.includes("src/a.ts") && flat.includes("src/b.ts"));
});

// ── schema validators ─────────────────────────────────────────────────────────

test("validateInventory accepts valid and rejects malformed", () => {
  const good = validateInventory({ language: "Go", frameworks: [], package_manager: "go", entry_points: [], build_files: [], test_files: [], config_files: [], ci_files: [], docs: [], generated_or_vendored_paths: [], summary: "ok" });
  assert.ok(good.ok);
  const bad = validateInventory({ language: 5, frameworks: "no" });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.length > 0);
});

test("validateDependencyHealth enforces severity enum", () => {
  const bad = validateDependencyHealth({ dependency_issues: [{ id: "DEP-1", severity: "fatal", paths: [], problem: "x", evidence: [], recommended_fix: "y" }] });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => e.includes("severity")));
});

// ── backlog gate ──────────────────────────────────────────────────────────────

function minimalBacklog(): RefactorBacklog {
  return {
    summary: { language: "TypeScript", framework: "none", package_manager: "npm", install_command: "npm install", test_command: "npm test", build_command: "npm run build", lint_command: "unknown", typecheck_command: "unknown" },
    target_architecture: { directories: [] },
    tasks: [
      { id: "RF-001", title: "add tests", type: "test", severity: "high", risk: "low", status: "planned", paths: ["src/a.ts"], symbols: [], description: "d", evidence: [], implementation_steps: [], depends_on: [], validation_commands: [], rollback_plan: "r" },
      { id: "RF-002", title: "remove dead", type: "delete", severity: "low", risk: "low", status: "planned", paths: ["src/a.ts"], symbols: [], description: "d", evidence: [], implementation_steps: [], depends_on: ["RF-001"], validation_commands: [], rollback_plan: "r" },
    ],
    duplicates: [], risky_areas: [],
  };
}

test("validateBacklog passes a well-formed backlog", () => {
  const v = validateBacklog(minimalBacklog());
  assert.ok(v.ok, v.errors.join("; "));
});

test("validateBacklog rejects a depends_on cycle", () => {
  const b = minimalBacklog();
  b.tasks[0].depends_on = ["RF-002"]; // RF-001 -> RF-002 -> RF-001
  const v = validateBacklog(b);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => e.includes("cycle")));
});

test("validateBacklog rejects unknown depends_on, bad id, dup id, bad enum", () => {
  const unknown = minimalBacklog(); unknown.tasks[1].depends_on = ["RF-999"];
  assert.ok(validateBacklog(unknown).errors.some((e) => e.includes("unknown task")));

  const badId = minimalBacklog(); badId.tasks[0].id = "TASK-1";
  assert.ok(validateBacklog(badId).errors.some((e) => e.includes("RF-NNN")));

  const dup = minimalBacklog(); dup.tasks[1].id = "RF-001";
  assert.ok(validateBacklog(dup).errors.some((e) => e.includes("duplicated")));

  const badEnum = minimalBacklog(); (badEnum.tasks[0] as { type: string }).type = "frobnicate";
  assert.ok(!validateBacklog(badEnum).ok);
});

test("validateBacklog errors on a missing source path for a destructive task", () => {
  const v = validateBacklog(minimalBacklog(), new Set(["src/other.ts"]));
  assert.ok(!v.ok, "missing delete source path must fail the gate");
  assert.ok(v.errors.some((e) => e.includes("src/a.ts") && e.includes("delete")));
});

test("validateBacklog enforces sequential and non-empty task ids", () => {
  const gap = minimalBacklog(); gap.tasks[1].id = "RF-003"; // RF-001, RF-003 -> gap
  assert.ok(validateBacklog(gap).errors.some((e) => e.includes("sequential")));

  const empty = minimalBacklog(); empty.tasks[0].id = ""; empty.tasks[1].depends_on = [];
  assert.ok(validateBacklog(empty).errors.some((e) => e.includes("non-empty")));
});

// ── context packs ─────────────────────────────────────────────────────────────

test("buildAnalysisPacks yields 7 capped packs; planAllJobs yields 10", () => {
  const inv = discoverRepo(fixture);
  const packs = buildAnalysisPacks(inv);
  assert.equal(packs.length, 7);
  for (const p of packs) {
    assert.equal(p.expectedOutput, "json");
    assert.ok(p.constraints.length > 0);
    const bytes = p.files.reduce((n, f) => n + (f.content?.length ?? f.excerpt?.length ?? 0), 0);
    assert.ok(bytes <= 60_000, `pack ${p.agentName} over byte budget`);
  }
  assert.equal(planAllJobs(inv).length, 10);
});

// ── conflict resolution ───────────────────────────────────────────────────────

test("crossCheck drops dead-code on an entry point and downgrades delete-of-canonical", () => {
  const inv = discoverRepo(fixture);
  const findings: AnalysisFindings = {
    deadCode: { dead_or_suspicious_code: [
      { id: "DEAD-1", path: "src/index.ts", symbol_or_file: "main", evidence: ["x"], recommended_action: "delete", risk: "low" },
      { id: "DEAD-2", path: "src/util/helper.ts", symbol_or_file: "help", evidence: ["0 refs"], recommended_action: "delete", risk: "low" },
    ] },
    duplication: { duplicates: [
      { id: "DUP-1", paths: ["src/util/helper.ts"], symbols: ["help"], duplicate_or_overlap: "dup", canonical_replacement: "src/util/helper.ts", action: "delete", call_sites_to_update: [], evidence: ["x"] },
    ] },
  };
  const { findings: resolved, conflicts } = crossCheckAndResolve(inv, findings);
  // index.ts is an entry point -> dead claim removed
  assert.ok(!resolved.deadCode!.dead_or_suspicious_code.some((d) => d.path === "src/index.ts"));
  // helper has inbound import? no inbound edges -> stays. delete-of-canonical -> merge
  assert.equal(resolved.duplication!.duplicates[0].action, "merge");
  assert.ok(conflicts.some((c) => c.kind === "dead-vs-entrypoint"));
  assert.ok(conflicts.some((c) => c.kind === "delete-vs-canonical"));
});

// ── plan assembly + ordering ──────────────────────────────────────────────────

test("buildPlanModel orders tests before deletes and yields a valid backlog", () => {
  const inv = discoverRepo(fixture);
  const findings: AnalysisFindings = {
    testRisk: { test_gaps: [], risky_areas: [{ path: "src/a.ts", reason: "important + untested", required_tests_before_refactor: ["test a()"] }], safety_baseline: ["run suite"] },
    deadCode: { dead_or_suspicious_code: [{ id: "DEAD-1", path: "src/a.ts", symbol_or_file: "a", evidence: ["x"], recommended_action: "delete", risk: "low" }] },
  };
  const model = buildPlanModel({ inventory: inv, findings }, []);
  const testTask = model.tasks.find((t) => t.type === "test" && t.paths.includes("src/a.ts"));
  const delTask = model.tasks.find((t) => t.type === "delete" && t.paths.includes("src/a.ts"));
  assert.ok(testTask && delTask);
  assert.ok(delTask!.depends_on.includes(testTask!.id), "delete must depend on the test task");
  const v = validateBacklog(buildBacklog(model));
  assert.ok(v.ok, v.errors.join("; "));
});

test("investigate-recommended dead code becomes a non-destructive task, not a delete", () => {
  const inv = discoverRepo(fixture);
  const findings: AnalysisFindings = {
    deadCode: { dead_or_suspicious_code: [
      { id: "DEAD-1", path: "src/util/helper.ts", symbol_or_file: "help", evidence: ["unsure"], recommended_action: "investigate whether this is reachable", risk: "high" },
      { id: "DEAD-2", path: "src/util/helper.ts", symbol_or_file: "old", evidence: ["0 refs"], recommended_action: "delete the unused export", risk: "low" },
    ] },
  };
  const model = buildPlanModel({ inventory: inv, findings }, []);
  const investigate = model.tasks.find((t) => t.title.startsWith("Investigate"));
  const del = model.tasks.find((t) => t.type === "delete");
  assert.ok(investigate && investigate.type !== "delete", "investigate finding must not be a delete task");
  assert.ok(del, "explicit-delete finding still becomes a delete task");
  assert.ok(validateBacklog(buildBacklog(model)).ok);
});

test("resolveWave2Conflicts catches a self-contradictory target directory", () => {
  const conflicts = resolveWave2Conflicts({
    targetArchitecture: { target_tree: "", rationale: [], target_directories: [
      { path: "src/core", responsibility: "x", belongs_here: [], does_not_belong_here: [], allowed_dependencies: ["src/util"], forbidden_dependencies: ["src/util"] },
    ] },
  });
  assert.ok(conflicts.some((c) => c.kind === "dep-rule-contradiction"));
});

test("non-noop run fails (no artifacts) when subagents fail and --allow-partial is off", async () => {
  const failing: AgentProvider = { name: "failing", async runAgent() { return { rawText: "", error: "boom" }; } };
  const r = await runDispatcher({ mode: "run", root: fixture, provider: { provider: "claude" }, providerInstance: failing });
  assert.ok(!r.ok, "must fail when required subagents fail");
  assert.ok(r.diagnostics.length > 0);
  assert.ok(!r.artifacts, "must not write artifacts on subagent failure");
});

test("--allow-partial lets a degraded non-noop run still produce a valid plan", async () => {
  const failing: AgentProvider = { name: "failing", async runAgent() { return { rawText: "", error: "boom" }; } };
  const r = await runDispatcher({ mode: "run", root: fixture, provider: { provider: "claude" }, providerInstance: failing, allowPartial: true });
  assert.ok(r.ok, r.errors.join("; "));
  assert.ok(r.validation!.ok);
});

// ── artifact rendering ────────────────────────────────────────────────────────

test("renderPlanMarkdown contains all 14 sections", () => {
  const inv = discoverRepo(fixture);
  const model = buildPlanModel({ inventory: inv, findings: {} }, []);
  const md = renderPlanMarkdown(model);
  for (let i = 1; i <= 14; i++) assert.ok(md.includes(`## ${i}. `), `missing section ${i}`);
  assert.ok(md.includes("| Step | Path | Action |"));
});

// ── JSON extraction ───────────────────────────────────────────────────────────

test("extractJsonObject handles direct, fenced, and embedded JSON", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJsonObject('blah\n{"a":3, "b":{"c":4}} trailing'), { a: 3, b: { c: 4 } });
  assert.equal(extractJsonObject("no json here"), null);
});

// ── dispatcher modes (noop provider) ──────────────────────────────────────────

test("dry-run writes inventory + 10 context packs, no artifacts", async () => {
  // isolate from any prior test that wrote artifacts into the shared fixture
  fs.rmSync(path.join(fixture, "REFACTOR_PLAN.md"), { force: true });
  fs.rmSync(path.join(fixture, "REFACTOR_BACKLOG.json"), { force: true });
  const r = await runDispatcher({ mode: "dry-run", root: fixture });
  assert.ok(r.ok);
  assert.equal(r.plannedJobs!.length, 10);
  assert.ok(fs.existsSync(path.join(fixture, ".refactor-planner", "inventory.json")));
  assert.ok(fs.existsSync(path.join(fixture, ".refactor-planner", "context-packs", "architecture.json")));
  assert.ok(!fs.existsSync(path.join(fixture, "REFACTOR_PLAN.md")), "dry-run must not write artifacts");
});

test("run (noop provider) produces valid artifacts; validate mode passes them", async () => {
  const r = await runDispatcher({ mode: "run", root: fixture, provider: { provider: "noop" } });
  assert.ok(r.ok, r.errors.join("; "));
  assert.ok(r.validation!.ok, r.validation!.errors.join("; "));
  const planPath = path.join(fixture, "REFACTOR_PLAN.md");
  const backlogPath = path.join(fixture, "REFACTOR_BACKLOG.json");
  assert.ok(fs.existsSync(planPath) && fs.existsSync(backlogPath));
  const parsed = JSON.parse(fs.readFileSync(backlogPath, "utf-8"));
  assert.ok(validateBacklog(parsed).ok);

  const v = await runDispatcher({ mode: "validate", root: fixture });
  assert.ok(v.ok, v.validation?.errors.join("; "));
});

test("validate mode fails a tampered backlog (injected cycle)", async () => {
  const backlogPath = path.join(fixture, "REFACTOR_BACKLOG.json");
  const b = minimalBacklog();
  b.tasks[0].depends_on = ["RF-002"]; // cycle
  fs.writeFileSync(backlogPath, JSON.stringify(b, null, 2));
  const v = await runDispatcher({ mode: "validate", root: fixture });
  assert.ok(!v.ok);
  assert.ok(v.validation!.errors.some((e) => e.includes("cycle")));
});
