#!/usr/bin/env node
/**
 * plan_to_tasks_validate CLI — validate a plan-to-tasks breakdown against
 * the original plan. TypeScript port of `scripts/plan_to_tasks_validate.py`.
 *
 * Usage:
 *   plan_to_tasks_validate.ts PLAN_FILE BREAKDOWN_FILE [--agents codex,gemini] [--timeout N]
 */

import fs from "node:fs";

import {
  computePlanHash,
  DEFAULT_TIMEOUT,
  dispatchValidators,
  loadConfig,
  SUPPORTED_VALIDATION_AGENTS,
} from "./plan_to_tasks_validate_lib.ts";

const HELP = `Validate a plan-to-tasks breakdown against the original plan.

Usage: plan_to_tasks_validate.ts PLAN_FILE BREAKDOWN_FILE [options]

Arguments:
  PLAN_FILE        Path to the original plan/spec file
  BREAKDOWN_FILE   Path to the task breakdown JSON file to validate

Options:
  --agents LIST    Comma-separated agents (codex, gemini). Default: from config
  --timeout N      Per-agent timeout in seconds (default: ${DEFAULT_TIMEOUT})
  --help           Show this help
`;

interface Args {
  planFile: string;
  breakdownFile: string;
  agents: string | null;
  timeout: number;
}

function parseArgs(argv: string[]): Args | "help" {
  const positionals: string[] = [];
  let agents: string | null = null;
  let timeout = DEFAULT_TIMEOUT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--agents") agents = argv[++i];
    else if (arg === "--timeout") timeout = Number(argv[++i]);
    else if (arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 2) {
    throw new Error("expected exactly two positional arguments: PLAN_FILE BREAKDOWN_FILE");
  }
  return { planFile: positionals[0], breakdownFile: positionals[1], agents, timeout };
}

async function main(argv: string[]): Promise<number> {
  let args: Args | "help";
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    return 2;
  }
  if (args === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const config = loadConfig();
  const agents = args.agents
    ? args.agents.split(",")
    : ((config.validation_agents as string[]) ?? ["codex"]);
  const invalid = agents.filter((a) => !SUPPORTED_VALIDATION_AGENTS.has(a));
  if (invalid.length > 0) {
    process.stderr.write(
      `Error: unsupported validation agent(s): ${invalid.join(",")}. ` +
        `Supported: ${[...SUPPORTED_VALIDATION_AGENTS].sort().join(",")}. ` +
        "Claude is the orchestrator and is not a valid Pass 3 agent.\n",
    );
    return 2;
  }
  const timeout =
    args.timeout !== DEFAULT_TIMEOUT
      ? args.timeout
      : Number(config.timeout ?? DEFAULT_TIMEOUT);

  const planContent = fs.readFileSync(args.planFile, "utf8");
  const breakdownContent = fs.readFileSync(args.breakdownFile, "utf8");
  const planHash = computePlanHash(planContent);

  let breakdown: Record<string, unknown>;
  try {
    const parsed = JSON.parse(breakdownContent);
    breakdown =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    breakdown = {};
  }

  const results = await dispatchValidators(
    planContent,
    breakdown,
    planHash,
    agents,
    timeout,
  );

  const output = {
    plan_hash: planHash,
    agents,
    results: results.map((r) => ({
      agent: r.agent,
      approved: r.approved,
      issues_count: r.issues.length,
      duration_s: r.duration_s,
      ...(r.error ? { error: r.error } : {}),
      ...(r.issues.length > 0
        ? {
            issues: r.issues.map((i) => ({
              phase_id: i.phase_id,
              task_id: i.task_id,
              field: i.field,
              problem: i.problem,
              suggestion: i.suggestion,
            })),
          }
        : {}),
    })),
    summary: {
      total_agents: agents.length,
      completed: results.length,
      approved: results.filter((r) => r.approved).length,
      total_issues: results.reduce((s, r) => s + r.issues.length, 0),
    },
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(argv1) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
