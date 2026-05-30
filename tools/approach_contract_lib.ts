/**
 * Approach contract — TypeScript port of `scripts/approach_contract.py`.
 *
 * Builds a lightweight pre-execution contract from a plan file: the
 * derived goal ("what"), execution steps ("how"), CLAUDE.md constraints,
 * and any detected constraint violations. Used as a confirmation gate
 * before long-running skills begin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function logPath(): string {
  return path.join(
    os.homedir(),
    ".claude",
    "code-review",
    "approach-contracts.jsonl",
  );
}

const GOAL_HEADING_RE = /^#{1,6}\s+(what|goal|goals|objective|objectives)\b/i;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_RE = /^\s*[-*]\s+(.+?)\s*$/;
const CONSTRAINT_RE =
  /\b(must|must not|should|should not|do not|don't|never|required)\b/i;

export interface ContractResult {
  plan_file: string;
  what: string[];
  how: string[];
  constraints: string[];
  valid: boolean;
  violations: string[];
  confirmed: boolean;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split like Python's `str.splitlines()` for markdown text. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Dedupe items, normalizing internal whitespace, preserving first-seen order. */
export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/** Walk up from the plan file to the nearest dir with `.git` or `CLAUDE.md`. */
export function findRepoRoot(planFile: string): string {
  const bases: string[] = [];
  let cur = path.dirname(planFile);
  while (true) {
    bases.push(cur);
    const next = path.dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  for (const base of bases) {
    if (
      fs.existsSync(path.join(base, ".git")) ||
      fs.existsSync(path.join(base, "CLAUDE.md"))
    ) {
      return base;
    }
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export function extractGoals(planText: string): string[] {
  const lines = splitLines(planText);
  const goals: string[] = [];
  let inGoalSection = false;

  for (const line of lines) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const title = headingMatch[2].trim();
      inGoalSection = GOAL_HEADING_RE.test(line);
      if (inGoalSection) goals.push(title);
      continue;
    }
    const bulletMatch = BULLET_RE.exec(line);
    if (inGoalSection && bulletMatch) {
      goals.push(bulletMatch[1].trim());
      continue;
    }
    if (inGoalSection && line.trim() && !line.startsWith("#")) {
      goals.push(line.trim());
    }
  }

  if (goals.length > 0) return dedupe(goals).slice(0, 8);

  const headings: string[] = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const title = m[2].trim();
    const lower = title.toLowerCase();
    if (
      lower.startsWith("phase") ||
      lower.startsWith("task") ||
      lower.startsWith("step")
    ) {
      continue;
    }
    headings.push(title);
  }
  return dedupe(headings).slice(0, 6);
}

const HOW_HEADING_PREFIXES = [
  "phase",
  "task",
  "step",
  "implementation",
  "rollout",
  "verify",
  "validation",
];

export function extractHow(planText: string): string[] {
  const steps: string[] = [];
  for (const line of splitLines(planText)) {
    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      const title = headingMatch[2].trim();
      const lower = title.toLowerCase();
      if (HOW_HEADING_PREFIXES.some((p) => lower.startsWith(p))) {
        steps.push(title);
        continue;
      }
    }
    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch) {
      const text = bulletMatch[1].trim();
      if (text.split(/\s+/).filter(Boolean).length >= 3) {
        steps.push(text);
      }
    }
  }
  return dedupe(steps).slice(0, 10);
}

export function extractConstraints(repoRoot: string): string[] {
  const claudePath = path.join(repoRoot, "CLAUDE.md");
  if (!fs.existsSync(claudePath)) return [];

  const constraints: string[] = [];
  for (const rawLine of splitLines(readText(claudePath))) {
    let line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("-") || line.startsWith("*")) {
      line = line.slice(1).trim();
    }
    if (CONSTRAINT_RE.test(line)) constraints.push(line);
  }
  return dedupe(constraints).slice(0, 12);
}

const VIOLATION_CHECKS: Array<[string, string[]]> = [
  ["do not commit", ["git commit", "commit the changes"]],
  ["do not push", ["git push", "push the branch"]],
  ["never use destructive commands", ["git reset --hard", "git checkout --"]],
  ["must run tests", ["skip tests", "without tests"]],
  ["must verify", ["skip verification", "without verification"]],
];

export function detectViolations(
  planText: string,
  constraints: string[],
): string[] {
  const lowerPlan = planText.toLowerCase();
  const violations: string[] = [];
  for (const constraint of constraints) {
    const lowerConstraint = constraint.toLowerCase();
    for (const [marker, forbiddenTerms] of VIOLATION_CHECKS) {
      if (
        lowerConstraint.includes(marker) &&
        forbiddenTerms.some((term) => lowerPlan.includes(term))
      ) {
        violations.push(constraint);
        break;
      }
    }
  }
  return dedupe(violations);
}

// ---------------------------------------------------------------------------
// Build / format / persist
// ---------------------------------------------------------------------------

function utcTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function buildContract(planFile: string): ContractResult {
  const repoRoot = findRepoRoot(planFile);
  const planText = readText(planFile);
  const constraints = extractConstraints(repoRoot);
  const violations = detectViolations(planText, constraints);
  return {
    plan_file: planFile,
    what: extractGoals(planText),
    how: extractHow(planText),
    constraints,
    valid: violations.length === 0,
    violations,
    confirmed: false,
    timestamp: utcTimestamp(),
  };
}

export function formatContract(contract: ContractResult): string {
  const section = (title: string, items: string[], empty: string): string[] => {
    const values = items.length > 0 ? items : [empty];
    return [title, ...values.map((item) => `- ${item}`)];
  };

  const lines: string[] = [`Approach Contract: ${contract.plan_file}`, ""];
  lines.push(...section("What", contract.what, "No explicit goals detected"));
  lines.push("");
  lines.push(...section("How", contract.how, "No execution steps detected"));
  lines.push("");
  lines.push(
    ...section(
      "Constraints",
      contract.constraints,
      "No CLAUDE.md constraints found",
    ),
  );
  if (contract.violations.length > 0) {
    lines.push("");
    lines.push(...section("Violations", contract.violations, "None"));
  }
  return lines.join("\n");
}

export function logContract(contract: ContractResult): void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.appendFileSync(file, `${JSON.stringify(contract)}\n`);
  } catch (err) {
    process.stderr.write(
      `approach_contract: warning: failed to write log: ${(err as Error).message}\n`,
    );
  }
}
