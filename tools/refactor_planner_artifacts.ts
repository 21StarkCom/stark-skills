// Renders the two final artifacts from the host-assembled PlanModel.
//
// REFACTOR_PLAN.md follows the exact 14-section structure the skill documents,
// and REFACTOR_BACKLOG.json is the structured twin. Both come from the same
// PlanModel, so they can't drift. The writer is planning-only: it writes exactly
// these two files at the repo root and nothing else.

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  BacklogTask, PlanModel, RefactorBacklog,
} from "./refactor_planner_schemas.ts";

// ── REFACTOR_PLAN.md ───────────────────────────────────────────────────────────

export function renderPlanMarkdown(m: PlanModel): string {
  const s: string[] = [];
  const p = (...l: string[]) => s.push(...l);

  p("# Refactor Plan", "");
  if (m.conflicts.length) p(`> Synthesis resolved ${m.conflicts.length} conflict(s) conservatively — see Open Questions.`, "");

  // 1. Repository Summary
  p("## 1. Repository Summary", "");
  p(`- Detected language/framework: ${m.summary.language} / ${m.summary.framework}`);
  p(`- Package/build system: ${m.summary.package_manager}`);
  p(`- Main entry points: ${joinOr(m.inventory.entry_points, "unknown")}`);
  p(`- Install command: ${m.summary.install_command}`);
  p(`- Test command: ${m.summary.test_command}`);
  p(`- Typecheck command: ${m.summary.typecheck_command}`);
  p(`- Lint command: ${m.summary.lint_command}`);
  p(`- Build command: ${m.summary.build_command}`);
  p(`- Current architectural style: ${m.architectural_style}`);
  p(`- Main risk areas: ${joinOr(m.main_risk_areas, "none identified")}`, "");

  // 2. Current Structure
  p("## 2. Current Structure", "");
  p("```text", m.inventory.directory_tree || "(empty)", "```", "");
  p(`Files: ${m.inventory.file_count}. Tests: ${m.inventory.test_files.length}. CI: ${m.inventory.ci_files.length}. Docs: ${m.inventory.docs.length}.`, "");

  // 3. Current Architecture
  p("## 3. Current Architecture", "");
  p(m.current_architecture_narrative, "");
  if (m.architecture) {
    p(bulletBlock("Runtime flow", m.architecture.runtime_flow));
    p(bulletBlock("Dependency flow", m.architecture.dependency_flow));
    p(bulletBlock("Main modules", m.architecture.main_modules));
    p(bulletBlock("Shared utilities", m.architecture.shared_utilities));
    p(bulletBlock("External integrations", m.architecture.external_integrations));
    p(bulletBlock("Configuration flow", m.architecture.configuration_flow));
    p(bulletBlock("Test organization", m.architecture.test_organization));
  }

  // 4. Problems Found
  p("## 4. Problems Found", "");
  p("| ID | Severity | Area | Path(s) | Problem | Evidence | Why It Matters | Recommended Fix |");
  p("| -- | -------- | ---- | ------- | ------- | -------- | -------------- | --------------- |");
  for (const r of m.problems) p(`| ${r.id} | ${cap(r.severity)} | ${cell(r.area)} | ${cell(r.paths.join(", "))} | ${cell(r.problem)} | ${cell(r.evidence.join("; "))} | ${cell(r.why_it_matters)} | ${cell(r.recommended_fix)} |`);
  if (!m.problems.length) p("| — | — | — | — | (no problems found) | — | — | — |");
  p("");

  // 5. Redundant / Duplicate Code
  p("## 5. Redundant / Duplicate Code", "");
  p("| ID | Path | Symbol | Duplicate / Overlap | Evidence | Canonical Replacement | Action | Call Sites To Update |");
  p("| -- | ---- | ------ | ------------------- | -------- | --------------------- | ------ | -------------------- |");
  for (const d of m.duplicates_table) p(`| ${d.id} | ${cell(d.paths.join(", "))} | ${cell(d.symbols.join(", "))} | ${cell(d.duplicate_or_overlap)} | ${cell(d.evidence.join("; "))} | ${cell(d.canonical_replacement)} | ${cap(d.action)} | ${cell(d.call_sites_to_update.join(", "))} |`);
  if (!m.duplicates_table.length) p("| — | — | — | (none found) | — | — | Keep | — |");
  p("");

  // 6. Dead or Suspicious Code
  p("## 6. Dead or Suspicious Code", "");
  p("| ID | Path | Symbol / File | Evidence | Recommended Action | Risk |");
  p("| -- | ---- | ------------- | -------- | ------------------ | ---- |");
  for (const d of m.dead_code) p(`| ${d.id} | ${cell(d.path)} | ${cell(d.symbol_or_file)} | ${cell(d.evidence.join("; "))} | ${cell(d.recommended_action)} | ${cap(d.risk)} |`);
  if (!m.dead_code.length) p("| — | — | — | (none found) | — | — |");
  p("");

  // 7. Proposed Target Architecture
  p("## 7. Proposed Target Architecture", "");
  if (m.target_architecture) {
    p("```text", m.target_architecture.target_tree || "(no tree proposed)", "```", "");
    for (const d of m.target_architecture.target_directories) {
      p(`### \`${d.path}\``);
      p(`- Responsibility: ${d.responsibility}`);
      p(`- Belongs here: ${joinOr(d.belongs_here, "—")}`);
      p(`- Does not belong here: ${joinOr(d.does_not_belong_here, "—")}`);
      p(`- Allowed dependencies: ${joinOr(d.allowed_dependencies, "—")}`);
      p(`- Forbidden dependencies: ${joinOr(d.forbidden_dependencies, "—")}`, "");
    }
    if (m.target_architecture.rationale.length) p(bulletBlock("Rationale", m.target_architecture.rationale));
  } else {
    p("_Target-architecture agent produced no proposal; reorganization phase should design this before moving files._", "");
  }

  // 8. Refactor Phases
  p("## 8. Refactor Phases", "");
  for (const ph of m.phases) {
    p(`### Phase ${ph.number}: ${ph.name}`, "");
    p(`**Goal:** ${ph.goal}`, "");
    p("**Actions:**", "");
    ph.actions.forEach((a, i) => p(`${i + 1}. ${a}`));
    p("");
    p("**Affected paths:**", "");
    p(...(ph.affected_paths.length ? ph.affected_paths.map((x) => `- ${x}`) : ["- (derived from file-by-file plan)"]));
    p("");
    p("**Validation:**", "", "```bash", ...(ph.validation_commands.length ? ph.validation_commands : ["# (no validation command resolved)"]), "```", "");
    p(`**Rollback:** ${ph.rollback}`, "");
    p(`**Risk:** ${cap(ph.risk)}`, "");
  }

  // 9. File-by-File Execution Plan
  p("## 9. File-by-File Execution Plan", "");
  p("| Step | Path | Action | Details | Depends On | Validation | Risk |");
  p("| ---- | ---- | ------ | ------- | ---------- | ---------- | ---- |");
  m.tasks.forEach((t, i) => {
    p(`| ${i + 1} (${t.id}) | ${cell(t.paths.join(", "))} | ${t.type} | ${cell(detail(t))} | ${cell(t.depends_on.join(", ") || "—")} | ${cell(t.validation_commands.join("; ") || "—")} | ${cap(t.risk)} |`);
  });
  if (!m.tasks.length) p("| — | — | — | (no tasks generated) | — | — | — |");
  p("");

  // 10. New Coding Conventions
  p("## 10. New Coding Conventions", "");
  p(...m.conventions.map((c) => `- ${c}`), "");

  // 11. Validation Strategy
  p("## 11. Validation Strategy", "");
  p("```bash");
  p(`# install`, plan(m.summary.install_command));
  p(`# lint`, plan(m.summary.lint_command));
  p(`# typecheck`, plan(m.summary.typecheck_command));
  p(`# test`, plan(m.summary.test_command));
  p(`# build`, plan(m.summary.build_command));
  p("```", "");

  // 12. First PR Recommendation
  p("## 12. First PR Recommendation", "");
  p(`- **Title:** ${m.first_pr.title}`);
  p(`- **Goal:** ${m.first_pr.goal}`);
  p(`- **Files changed:** ${joinOr(m.first_pr.files, "—")}`);
  p("- **Steps:**");
  p(...(m.first_pr.steps.length ? m.first_pr.steps.map((x, i) => `  ${i + 1}. ${x}`) : ["  1. (see backlog)"]));
  p(`- **Validation:** ${joinOr(m.first_pr.validation, "—")}`);
  p(`- **Why low risk:** ${m.first_pr.why_low_risk}`, "");

  // 13. Do-Not-Touch-Yet Areas
  p("## 13. Do-Not-Touch-Yet Areas", "");
  p("| Path | Reason | Required Safety Work First |");
  p("| ---- | ------ | -------------------------- |");
  for (const r of m.risky_areas) p(`| ${cell(r.path)} | ${cell(r.reason)} | ${cell(r.required_tests_before_refactor.join("; ") || "add tests")} |`);
  if (!m.risky_areas.length) p("| — | (none identified) | — |");
  p("");

  // 14. Open Questions
  p("## 14. Open Questions", "");
  p(...(m.open_questions.length ? m.open_questions.map((q) => `- ${q}`) : ["- None blocking."]), "");

  return s.join("\n") + "\n";
}

// ── REFACTOR_BACKLOG.json ─────────────────────────────────────────────────────

export function buildBacklog(m: PlanModel): RefactorBacklog {
  return {
    summary: m.summary,
    target_architecture: {
      directories: (m.target_architecture?.target_directories ?? []).map((d) => ({
        path: d.path,
        responsibility: d.responsibility,
        allowed_dependencies: d.allowed_dependencies,
        forbidden_dependencies: d.forbidden_dependencies,
      })),
    },
    tasks: m.tasks,
    duplicates: m.duplicates_backlog,
    risky_areas: m.risky_areas,
  };
}

// ── planning-only writer ──────────────────────────────────────────────────────

export interface WriteResult { planPath: string; backlogPath: string; }

export function writeArtifacts(root: string, m: PlanModel): WriteResult {
  const planPath = path.join(root, "REFACTOR_PLAN.md");
  const backlogPath = path.join(root, "REFACTOR_BACKLOG.json");
  fs.writeFileSync(planPath, renderPlanMarkdown(m), "utf-8");
  fs.writeFileSync(backlogPath, JSON.stringify(buildBacklog(m), null, 2) + "\n", "utf-8");
  return { planPath, backlogPath };
}

// ── cell / formatting helpers ─────────────────────────────────────────────────

function cell(v: string): string {
  return (v || "—").replace(/\r?\n/g, " ").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").trim() || "—";
}
function cap(v: string): string { return v ? v.charAt(0).toUpperCase() + v.slice(1) : "—"; }
function plan(cmd: string): string { return cmd && cmd !== "unknown" ? cmd : "# unknown — not resolved from the repo"; }
function joinOr(arr: string[], fallback: string): string { return arr.length ? arr.join(", ") : fallback; }
function bulletBlock(label: string, items: string[]): string {
  if (!items.length) return "";
  return [`**${label}:**`, "", ...items.map((i) => `- ${i}`), ""].join("\n");
}
function detail(t: BacklogTask): string {
  const steps = t.implementation_steps.join("; ");
  return steps ? `${t.description} — ${steps}` : t.description;
}
