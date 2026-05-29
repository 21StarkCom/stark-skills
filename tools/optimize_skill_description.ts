#!/usr/bin/env node
/**
 * Local skill description optimizer — TypeScript port of
 * `scripts/optimize_skill_description.py`.
 *
 * Reads a skill's SKILL.md frontmatter, scores its current description
 * against an eval set, then iterates: `claude -p` proposes a better
 * description, scores it, and the best one wins. Stops on threshold or
 * max-iterations.
 *
 * Scoring still delegates to the skill-creator plugin's `run_eval.py`
 * (Python) — we don't own that module and it has its own claude -p
 * subprocess path. The improver half is what runs here.
 *
 * Usage:
 *   node --experimental-strip-types tools/optimize_skill_description.ts \
 *     --skill-path skill/stark-forged-review \
 *     --eval-set path/to/trigger_eval.json \
 *     --model claude-opus-4-8 \
 *     --max-iterations 3 \
 *     --out-json /tmp/optimize-results.json
 *
 * Design notes:
 *   - Does NOT mutate SKILL.md. Produces a report; operator applies
 *     manually (same policy as the Python — never silently rewrite).
 *   - Improvement prompt is small and self-contained so it works with
 *     any model size.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_CREATOR_PLUGIN_PATH = path.join(
  os.homedir(),
  ".claude",
  "plugins",
  "cache",
  "claude-plugins-official",
  "skill-creator",
  "unknown",
  "skills",
  "skill-creator",
);

export const IMPROVE_PROMPT_TEMPLATE = `You are optimizing a Claude Code skill's YAML frontmatter description
so that Claude reliably triggers the skill for the right queries and
does not trigger it for adjacent ones.

Skill name: {skill_name}

Current description:
---
{current_description}
---

Scoring on this iteration's eval set:
  - should-trigger queries that FAILED (the skill should have fired but didn't):
{failed_should_trigger}
  - should-not-trigger queries that FAILED (the skill fired when it shouldn't have):
{failed_should_not_trigger}

Constraints for your new description:
1. Maximum 200 characters.
2. Concrete language — name the mechanism (leader+second, dynamic triage, etc.)
   rather than generic phrases like "reviews code".
3. Disambiguate from sibling skills so false-positives drop.
4. Stay honest — don't claim capabilities the skill doesn't have.

Output ONLY the new description text. No prose around it, no quotes,
no code fences. Just the raw description.
`;

// ---------------------------------------------------------------------------
// SKILL.md frontmatter parsing
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export function parseSkillDescription(skillPath: string): SkillFrontmatter {
  const text = fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0].trim() !== "---") {
    throw new Error(`${skillPath}/SKILL.md has no YAML frontmatter`);
  }
  let name = "";
  const descriptionLines: string[] = [];
  let inDescription = false;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    if (line.startsWith("name:")) {
      name = line.slice("name:".length).trim();
      inDescription = false;
    } else if (line.startsWith("description:")) {
      const rest = line.slice("description:".length).trim();
      inDescription = true;
      if (rest && rest !== ">-") descriptionLines.push(rest);
    } else if (inDescription && line.startsWith(" ")) {
      descriptionLines.push(line.trim());
    } else {
      inDescription = false;
    }
  }
  return { name, description: descriptionLines.join(" ").trim() };
}

// ---------------------------------------------------------------------------
// Improve-prompt assembly
// ---------------------------------------------------------------------------

export interface EvalResult {
  query: string;
  should_trigger?: boolean;
  pass?: boolean;
}

export interface EvalResults {
  summary?: { total?: number; passed?: number };
  results: EvalResult[];
}

export interface BuildImprovePromptOpts {
  skillName: string;
  currentDescription: string;
  evalResults: EvalResults;
}

export function buildImprovePrompt(opts: BuildImprovePromptOpts): string {
  const { skillName, currentDescription, evalResults } = opts;
  const failedTrigger = evalResults.results.filter(
    (r) => r.should_trigger === true && r.pass !== true,
  );
  const failedNoTrigger = evalResults.results.filter(
    (r) => r.should_trigger === false && r.pass !== true,
  );
  const fmt = (rows: EvalResult[]): string =>
    rows.length === 0
      ? "  (none)"
      : rows.map((r) => `  * ${r.query.slice(0, 200)}`).join("\n");
  return IMPROVE_PROMPT_TEMPLATE.replace("{skill_name}", skillName)
    .replace("{current_description}", currentDescription)
    .replace("{failed_should_trigger}", fmt(failedTrigger))
    .replace("{failed_should_not_trigger}", fmt(failedNoTrigger));
}

// ---------------------------------------------------------------------------
// Clean env for `claude -p` dispatch
// ---------------------------------------------------------------------------

const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

export function buildCleanEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const apiKey = source.ANTHROPIC_AGENTS;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_AGENTS not set in environment. " +
        'Source your Anthropic key file (e.g. `source "$HOME/Code/.private/API Keys/.anthropic.key"`) ' +
        "before running Claude sub-agents.",
    );
  }
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") env[key] = v;
  }
  env.ANTHROPIC_API_KEY = apiKey;
  return env;
}

// ---------------------------------------------------------------------------
// Subprocess shell-outs (no unit tests — exercised via integration runs)
// ---------------------------------------------------------------------------

export interface RunEvalOpts {
  evalSet: string;
  skillPath: string;
  description: string;
  model: string;
  runsPerQuery: number;
  timeout: number;
}

export function runEval(opts: RunEvalOpts): EvalResults {
  if (!fs.existsSync(SKILL_CREATOR_PLUGIN_PATH)) {
    throw new Error(
      `skill-creator plugin not found at ${SKILL_CREATOR_PLUGIN_PATH}. ` +
        "Install the claude-plugins-official/skill-creator plugin first.",
    );
  }
  const result = spawnSync(
    "python3",
    [
      "-m",
      "scripts.run_eval",
      "--eval-set",
      opts.evalSet,
      "--skill-path",
      opts.skillPath,
      "--description",
      opts.description,
      "--model",
      opts.model,
      "--runs-per-query",
      String(opts.runsPerQuery),
      "--timeout",
      String(opts.timeout),
    ],
    {
      cwd: SKILL_CREATOR_PLUGIN_PATH,
      env: buildCleanEnv(),
      encoding: "utf8",
      timeout: Math.max(opts.timeout * 2, 300) * 1000,
    },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 500);
    throw new Error(`run_eval failed (exit ${result.status}): ${stderr}`);
  }
  try {
    return JSON.parse(result.stdout ?? "") as EvalResults;
  } catch (err) {
    throw new Error(
      `run_eval output not JSON: ${(result.stdout ?? "").slice(0, 500)}`,
    );
  }
}

export interface ProposeImprovementOpts {
  skillName: string;
  currentDescription: string;
  evalResults: EvalResults;
  model: string;
  timeout: number;
}

export function proposeImprovement(opts: ProposeImprovementOpts): string {
  const prompt = buildImprovePrompt({
    skillName: opts.skillName,
    currentDescription: opts.currentDescription,
    evalResults: opts.evalResults,
  });
  const result = spawnSync(
    "claude",
    ["-p", prompt, "--model", opts.model],
    {
      env: buildCleanEnv(),
      encoding: "utf8",
      timeout: opts.timeout * 1000,
    },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, 500);
    throw new Error(
      `claude -p improve step failed (exit ${result.status}): ${stderr}`,
    );
  }
  return (result.stdout ?? "").trim();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  skillPath: string;
  evalSet: string;
  model: string;
  maxIterations: number;
  runsPerQuery: number;
  timeout: number;
  triggerThreshold: number;
  outJson: string | null;
}

function parseCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    skillPath: "",
    evalSet: "",
    model: "claude-opus-4-8",
    maxIterations: 3,
    runsPerQuery: 3,
    timeout: 180,
    triggerThreshold: 0.8,
    outJson: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };
    switch (a) {
      case "--skill-path": args.skillPath = need(); break;
      case "--eval-set": args.evalSet = need(); break;
      case "--model": args.model = need(); break;
      case "--max-iterations": args.maxIterations = Number(need()); break;
      case "--runs-per-query": args.runsPerQuery = Number(need()); break;
      case "--timeout": args.timeout = Number(need()); break;
      case "--trigger-threshold": args.triggerThreshold = Number(need()); break;
      case "--out-json": args.outJson = need(); break;
      case "-h":
      case "--help":
        process.stderr.write(
          "usage: optimize_skill_description --skill-path PATH --eval-set PATH " +
            "[--model ID] [--max-iterations N] [--runs-per-query N] [--timeout S] " +
            "[--trigger-threshold F] [--out-json PATH]\n",
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.skillPath) throw new Error("--skill-path is required");
  if (!args.evalSet) throw new Error("--eval-set is required");
  return args;
}

interface IterEntry {
  iteration: number;
  description: string;
  pass_rate?: number;
  passed?: number;
  total?: number;
  eval_duration_s?: number;
  proposed_from_iteration?: number;
}

function logStderr(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function main(argv: string[]): number {
  const args = parseCliArgs(argv);
  const { name: skillName, description: currentDesc } = parseSkillDescription(
    args.skillPath,
  );
  logStderr(`[optimize] skill=${skillName}`);
  logStderr(
    `[optimize] current description (${currentDesc.length} chars): ${currentDesc}`,
  );

  const history: IterEntry[] = [];
  let bestDescription = currentDesc;
  let bestPassRate = 0;

  for (let iteration = 0; iteration <= args.maxIterations; iteration++) {
    const label = iteration === 0 ? "current" : `iteration ${iteration}`;
    logStderr(`[optimize] scoring ${label}…`);
    const t0 = Date.now();
    const candidate =
      iteration === 0 ? bestDescription : history[history.length - 1].description;
    const evalResult = runEval({
      evalSet: args.evalSet,
      skillPath: args.skillPath,
      description: candidate,
      model: args.model,
      runsPerQuery: args.runsPerQuery,
      timeout: args.timeout,
    });
    const elapsed = (Date.now() - t0) / 1000;
    const total = evalResult.summary?.total ?? 0;
    const passed = evalResult.summary?.passed ?? 0;
    const passRate = total > 0 ? passed / total : 0;
    logStderr(
      `[optimize] ${label}: ${passed}/${total} = ${(passRate * 100).toFixed(0)}% ` +
        `(${elapsed.toFixed(0)}s)`,
    );

    history.push({
      iteration,
      description: candidate,
      pass_rate: passRate,
      passed,
      total,
      eval_duration_s: elapsed,
    });

    if (passRate > bestPassRate) {
      bestPassRate = passRate;
      bestDescription = candidate;
    }

    if (passRate >= args.triggerThreshold) {
      logStderr(
        `[optimize] pass rate ${(passRate * 100).toFixed(0)}% >= threshold ` +
          `${(args.triggerThreshold * 100).toFixed(0)}%, stopping`,
      );
      break;
    }
    if (iteration === args.maxIterations) break;

    logStderr("[optimize] proposing improved description…");
    let newDesc: string;
    try {
      newDesc = proposeImprovement({
        skillName,
        currentDescription: candidate,
        evalResults: evalResult,
        model: args.model,
        timeout: args.timeout,
      });
    } catch (err) {
      logStderr(`[optimize] improvement failed: ${(err as Error).message}`);
      break;
    }
    history.push({
      iteration: iteration + 0.5,
      description: newDesc,
      proposed_from_iteration: iteration,
    });
    logStderr(`[optimize] proposed (${newDesc.length} chars): ${newDesc}`);
  }

  const report = {
    skill_name: skillName,
    original_description: currentDesc,
    best_description: bestDescription,
    best_pass_rate: bestPassRate,
    iterations: history,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.outJson) {
    fs.writeFileSync(args.outJson, JSON.stringify(report, null, 2));
  }
  return 0;
}

// Run only when invoked directly (not when imported by tests). Resolve real
// paths so a symlinked install (e.g. `~/.claude/code-review/tools/...`)
// still triggers main — `tools/stark_session.ts` had this exact bug.
function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const realArgv = fs.realpathSync(argv1);
    const realModule = fs.realpathSync(new URL(import.meta.url).pathname);
    return realArgv === realModule;
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(
      `optimize_skill_description: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
}
