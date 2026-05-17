#!/usr/bin/env node
/**
 * `/red_team accept` TS CLI — port of `scripts/red_team_accept.py`.
 *
 * Accepts a red-team human-review halt by stable key. Subsequent
 * dispatcher runs no longer halt on the same concern.
 *
 * Usage:
 *   node --experimental-strip-types tools/red_team_accept.ts STABLE_KEY
 *   node --experimental-strip-types tools/red_team_accept.ts KEY1 KEY2 --no-confirm
 *   node --experimental-strip-types tools/red_team_accept.ts KEY --note "ack'd in standup"
 */

import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDb } from "./red_team_db_resolver.ts";

import {
  acceptFinding,
  lookupFindingMetadata,
  type FindingMetadata,
} from "./red_team_human_review_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

interface CliArgs {
  stableKeys: string[];
  note: string | null;
  acceptedBy: string | null;
  noConfirm: boolean;
  db: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    stableKeys: [],
    note: null,
    acceptedBy: null,
    noConfirm: false,
    db: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--note":
        args.note = next();
        break;
      case "--accepted-by":
        args.acceptedBy = next();
        break;
      case "--no-confirm":
        args.noConfirm = true;
        break;
      case "--db":
        args.db = next();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown argument: ${arg}`);
        args.stableKeys.push(arg);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `\
Usage: red_team_accept [options] STABLE_KEY [STABLE_KEY ...]

Accept one or more red-team human-review halts by stable key.

Options:
  --note TEXT          Optional free-text note recorded with the acceptance.
  --accepted-by NAME   Override the recorded operator identity (defaults to $USER).
  --no-confirm         Skip the interactive confirmation prompt.
  --db PATH            Audit DB path override (defaults to canonical resolver).
  -h, --help           Show this help.
`,
  );
}


function formatFinding(meta: FindingMetadata): string {
  const lines = [
    `  stable_key:  ${meta.stable_key}`,
    `  run_id:      ${meta.run_id}`,
    `  stage:       ${meta.stage}`,
    `  round_num:   ${meta.round_num}`,
    `  persona:     ${meta.persona}`,
    `  finding_id:  ${meta.finding_id}`,
    `  severity:    ${meta.severity}`,
    "",
    "  Concern:",
  ];
  const concern = meta.concern_excerpt ?? "";
  const paragraphs = concern.length > 0 ? concern.split("\n") : ["(no excerpt stored)"];
  for (const p of paragraphs) lines.push(`    ${p}`);
  return lines.join("\n");
}

async function promptConfirm(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question("Accept this finding? [y/N] ", (ans) => {
      rl.close();
      const lowered = ans.trim().toLowerCase();
      resolve(lowered === "y" || lowered === "yes");
    });
  });
}

export async function acceptOne(args: {
  stableKey: string;
  note: string | null;
  acceptedBy: string | null;
  confirm: boolean;
  dbPath: string;
}): Promise<number> {
  const meta = lookupFindingMetadata({
    stableKey: args.stableKey,
    dbPath: args.dbPath,
  });
  if (meta === null) {
    process.stderr.write(
      `red_team_accept: no finding with stable_key=${JSON.stringify(args.stableKey)}\n`,
    );
    return 2;
  }
  if (meta.counter_proposal !== "REQUEST_HUMAN_REVIEW") {
    process.stderr.write(
      `red_team_accept: stable_key=${JSON.stringify(args.stableKey)} is not a human-review finding (counter_proposal=${JSON.stringify(meta.counter_proposal)})\n`,
    );
    return 2;
  }
  process.stdout.write("Matched human-review finding:\n");
  process.stdout.write(formatFinding(meta) + "\n\n");
  if (args.confirm) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "red_team_accept: stdin is not a TTY — pass --no-confirm to accept non-interactively\n",
      );
      return 2;
    }
    const ok = await promptConfirm();
    if (!ok) {
      process.stdout.write("red_team_accept: cancelled\n");
      return 1;
    }
  }
  try {
    acceptFinding({
      stableKey: args.stableKey,
      runId: meta.run_id,
      stage: meta.stage,
      roundNum: meta.round_num,
      persona: meta.persona,
      findingId: meta.finding_id,
      concernHash: meta.concern_hash,
      concernExcerpt: meta.concern_excerpt,
      repo: meta.repo,
      acceptedBy: args.acceptedBy,
      note: args.note,
      dbPath: args.dbPath,
    });
  } catch (err) {
    process.stderr.write(`red_team_accept: ${(err as Error).message}\n`);
    return 2;
  }
  process.stdout.write(`red_team_accept: accepted ${args.stableKey}\n`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`red_team_accept: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.stableKeys.length === 0) {
    process.stderr.write("red_team_accept: at least one STABLE_KEY required\n");
    return 2;
  }
  const dbPath = resolveDb(args.db).db_path;
  let rc = 0;
  for (const key of args.stableKeys) {
    const result = await acceptOne({
      stableKey: key,
      note: args.note,
      acceptedBy: args.acceptedBy,
      confirm: !args.noConfirm,
      dbPath,
    });
    if (result !== 0) rc = result;
  }
  return rc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
