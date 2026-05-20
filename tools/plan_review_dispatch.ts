#!/usr/bin/env node
/**
 * plan_review_dispatch CLI — plan/spec document review orchestrator.
 * TypeScript port of `scripts/plan_review_dispatch.py`.
 *
 * Progress goes to stderr; the JSON result goes to stdout.
 *
 * Usage:
 *   plan_review_dispatch.ts --file plan.md [--round N] [--prompts-dir DIR] ...
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TIMEOUT,
  dispatchPlanReview,
  discoverPlanDomains,
  loadPlanReviewConfig,
  type Logger,
} from "./plan_review_dispatch_lib.ts";

const HELP = `Plan review dispatch — multi-agent review of a plan/spec document.

Usage: plan_review_dispatch.ts --file PATH [options]

Options:
  --file PATH          Path to the plan/spec file (required)
  --round N            Review round number (default: 1)
  --timeout SECONDS    Per-agent timeout (default: 300, codex 2x)
  --repo-dir PATH      Repository root for config/prompt overrides
  --repo ORG/NAME      Repo identifier for telemetry attribution
  --agents LIST        Comma-separated list of agents
  --disabled-domains LIST  Comma-separated domains to skip
  --domains LIST       Comma-separated domain slugs to review
  --json-only          (accepted for compatibility; progress always to stderr)
  --prompts-dir DIR    Prompt dir under prompts/ (default: plan-review)
  --config-section KEY Config JSON key (default: derived from --prompts-dir)
  --help               Show this help
`;

interface Args {
  file: string | null;
  round: number;
  timeout: number;
  repoDir: string | null;
  repo: string | null;
  agents: string | null;
  disabledDomains: string | null;
  domains: string | null;
  promptsDir: string;
  configSection: string | null;
}

function parseArgs(argv: string[]): Args | "help" {
  const args: Args = {
    file: null,
    round: 1,
    timeout: DEFAULT_TIMEOUT,
    repoDir: null,
    repo: null,
    agents: null,
    disabledDomains: null,
    domains: null,
    promptsDir: "plan-review",
    configSection: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--file") args.file = argv[++i];
    else if (arg === "--round") args.round = Number(argv[++i]);
    else if (arg === "--timeout") args.timeout = Number(argv[++i]);
    else if (arg === "--repo-dir") args.repoDir = argv[++i];
    else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--agents") args.agents = argv[++i];
    else if (arg === "--disabled-domains") args.disabledDomains = argv[++i];
    else if (arg === "--domains") args.domains = argv[++i];
    else if (arg === "--json-only") {
      /* accepted; progress always goes to stderr */
    } else if (arg === "--prompts-dir") args.promptsDir = argv[++i];
    else if (arg === "--config-section") args.configSection = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
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
  if (!args.file) {
    process.stderr.write("Error: --file is required\n");
    return 2;
  }

  const log: Logger = (m) => process.stderr.write(`${m}\n`);

  const configSection = args.configSection ?? args.promptsDir.replace(/-/g, "_");
  const config = loadPlanReviewConfig(args.repoDir, undefined, configSection);

  const agents = args.agents ? args.agents.split(",") : (config.agents as string[]);
  const disabled = args.disabledDomains
    ? args.disabledDomains.split(",")
    : (config.disabled_domains as string[]);
  const timeout =
    args.timeout !== DEFAULT_TIMEOUT
      ? args.timeout
      : Number(config.timeout ?? DEFAULT_TIMEOUT);

  const promptsDir = path.join(
    os.homedir(),
    ".claude",
    "code-review",
    "prompts",
    args.promptsDir,
  );
  let domains = discoverPlanDomains(promptsDir);
  if (args.domains) {
    const allowed = new Set(args.domains.split(","));
    domains = Object.fromEntries(Object.entries(domains).filter(([k]) => allowed.has(k)));
  }

  const planContent = fs.readFileSync(args.file, "utf8");
  const inferredReviewType =
    args.promptsDir === "design-review"
      ? "design"
      : args.promptsDir === "plan-review"
        ? "plan"
        : null;

  const result = await dispatchPlanReview(
    planContent,
    args.round,
    {
      repoDir: args.repoDir,
      agents,
      domains,
      disabledDomains: disabled,
      timeout,
      promptsDirOverride: promptsDir,
      reviewType: inferredReviewType,
      filePath: inferredReviewType ? args.file : null,
      repo: args.repo,
    },
    log,
  );

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
