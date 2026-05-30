#!/usr/bin/env node
/**
 * multi_review CLI — multi-agent PR review orchestrator.
 * TypeScript port of `scripts/multi_review.py`.
 *
 * Usage:
 *   multi_review.ts --pr 10
 *   multi_review.ts --pr 10 --repo Org/repo --base main
 *   multi_review.ts --pr 10 --dry-run --json-only
 *   multi_review.ts --all-repos ~/Code/repo-a ~/Code/repo-b
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

import {
  detectBaseBranch,
  detectRepo,
  getOpenPrs,
  type Logger,
  reviewPr,
  reviewPrSingle,
} from "./multi_review_lib.ts";

const HELP = `Multi-agent PR review orchestrator.

Usage: multi_review.ts (--pr N | --all-repos DIR...) [options]

Target (one required):
  --pr N               PR number to review
  --all-repos DIR...   Directories of repos to scan for open PRs

Options:
  --repo ORG/NAME      Override repo. Default: auto-detect
  --base BRANCH        Base branch. Default: auto-detect (main/master)
  --dry-run            Don't post reviews to GitHub
  --json               Output JSON (logs interleaved on stdout)
  --json-only          Strict JSON mode: stdout is JSON only, logs to stderr
  --post-raw           Post per-agent raw findings even in --json-only mode
  --single             Single-agent mode: 1 agent per domain
  --agent AGENT        Override agent for all domains (implies --single)
  --domains SLUGS      Comma-separated domain slugs to review
  --round N            Round number to record this run as
  --no-persist-history Skip writing round-N.json to the history dir
  --help               Show this help
`;

function expanduser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return os.homedir() + p.slice(1);
  return p;
}

interface Args {
  pr: number | null;
  allRepos: string[] | null;
  repo: string | null;
  base: string | null;
  dryRun: boolean;
  jsonOutput: boolean;
  jsonOnly: boolean;
  postRaw: boolean;
  single: boolean;
  agent: string | null;
  domains: string | null;
  roundNum: number | null;
  persistHistory: boolean;
}

function parseArgs(argv: string[]): Args | "help" {
  const args: Args = {
    pr: null,
    allRepos: null,
    repo: null,
    base: null,
    dryRun: false,
    jsonOutput: false,
    jsonOnly: false,
    postRaw: false,
    single: false,
    agent: null,
    domains: null,
    roundNum: null,
    persistHistory: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return "help";
    else if (arg === "--pr") args.pr = Number(argv[++i]);
    else if (arg === "--all-repos") {
      args.allRepos = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args.allRepos.push(argv[++i]);
      }
    } else if (arg === "--repo") args.repo = argv[++i];
    else if (arg === "--base") args.base = argv[++i];
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.jsonOutput = true;
    else if (arg === "--json-only") args.jsonOnly = true;
    else if (arg === "--post-raw") args.postRaw = true;
    else if (arg === "--single") args.single = true;
    else if (arg === "--agent") args.agent = argv[++i];
    else if (arg === "--domains") args.domains = argv[++i];
    else if (arg === "--round") args.roundNum = Number(argv[++i]);
    else if (arg === "--no-persist-history") args.persistHistory = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.agent) args.single = true;
  return args;
}

function gitRoot(): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return (r.stdout ?? "").trim() || undefined;
  } catch {
    return undefined;
  }
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
  if ((args.pr === null) === (args.allRepos === null)) {
    process.stderr.write("Error: exactly one of --pr or --all-repos is required\n");
    return 2;
  }

  const stdoutLog: Logger = (m) => process.stdout.write(`${m}\n`);
  const stderrLog: Logger = (m) => process.stderr.write(`${m}\n`);

  if (args.pr !== null) {
    const root = gitRoot();
    const repo = args.repo || detectRepo(root);
    if (!repo) {
      process.stderr.write("Could not detect repo. Use --repo.\n");
      return 1;
    }
    let base: string;
    try {
      base = args.base || detectBaseBranch(root);
    } catch (exc) {
      process.stderr.write(`${(exc as Error).message}\n`);
      return 1;
    }

    const jsonOutput = args.jsonOutput || args.jsonOnly;
    const log = args.jsonOnly ? stderrLog : stdoutLog;

    const reviewOptions = {
      base,
      dryRun: args.dryRun,
      jsonOutput,
      jsonOnly: args.jsonOnly,
      postRaw: args.postRaw,
      domains: args.domains,
      cwd: root,
      roundNum: args.roundNum,
      persistHistory: args.persistHistory,
    };

    const result: Record<string, unknown> = args.single
      ? await reviewPrSingle(repo, args.pr, { ...reviewOptions, overrideAgent: args.agent }, log)
      : await reviewPr(repo, args.pr, reviewOptions, log);

    if (jsonOutput) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
    return 0;
  }

  // --all-repos
  const allResults: Array<Record<string, unknown>> = [];
  for (const rawDir of args.allRepos ?? []) {
    const repoDir = expanduser(rawDir);
    try {
      if (!fs.statSync(repoDir).isDirectory()) {
        process.stderr.write(`  Skipping ${repoDir} (not a directory)\n`);
        continue;
      }
    } catch {
      process.stderr.write(`  Skipping ${repoDir} (not a directory)\n`);
      continue;
    }
    const repo = detectRepo(repoDir);
    if (!repo) {
      process.stderr.write(`  Skipping ${repoDir} (no git remote)\n`);
      continue;
    }
    let base: string;
    try {
      base = detectBaseBranch(repoDir);
    } catch (exc) {
      process.stderr.write(`  Skipping ${repoDir} (${(exc as Error).message})\n`);
      continue;
    }
    stdoutLog(`\n  Scanning ${repo} for open PRs...`);
    const prs = await getOpenPrs(repo);
    if (prs.length === 0) {
      stdoutLog(`  No open PRs in ${repo}`);
      continue;
    }
    for (const pr of prs) {
      const prNum = pr.number as number;
      stdoutLog(`  Found PR #${prNum}: ${pr.title}`);
      const result = await reviewPr(
        repo,
        prNum,
        { base, dryRun: args.dryRun, jsonOutput: args.jsonOutput, domains: args.domains, cwd: repoDir },
        stdoutLog,
      );
      allResults.push(result);
    }
  }
  if (args.jsonOutput) {
    process.stdout.write(`${JSON.stringify(allResults, null, 2)}\n`);
  } else {
    process.stdout.write(`\n${"#".repeat(60)}\n`);
    process.stdout.write(
      `  Reviewed ${allResults.length} PRs across ${(args.allRepos ?? []).length} repos\n`,
    );
    process.stdout.write(`${"#".repeat(60)}\n`);
  }
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
