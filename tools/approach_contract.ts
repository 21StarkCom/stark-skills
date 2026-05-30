#!/usr/bin/env node
/**
 * approach_contract CLI — pre-execution confirmation gate for expensive
 * workflow execution. TypeScript port of `scripts/approach_contract.py`.
 *
 * Usage:
 *   node --experimental-strip-types approach_contract.ts --plan-file PATH [--force-confirm] [--json]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as readline from "node:readline/promises";

import {
  buildContract,
  type ContractResult,
  formatContract,
  logContract,
} from "./approach_contract_lib.ts";

const HELP = `Approach contract confirmation gate.

Usage: approach_contract.ts --plan-file PATH [--force-confirm] [--json]

Options:
  --plan-file PATH  Path to a markdown plan file (required)
  --force-confirm   Bypass the confirmation prompt
  --json            Emit JSON result
  --help            Show this help
`;

function expanduser(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function finish(contract: ContractResult, asJson: boolean): void {
  logContract(contract);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
  }
}

async function main(argv: string[]): Promise<number> {
  let planFileArg: string | undefined;
  let forceConfirm = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "--force-confirm") {
      forceConfirm = true;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--plan-file") {
      planFileArg = argv[++i];
    } else if (arg.startsWith("--plan-file=")) {
      planFileArg = arg.slice("--plan-file=".length);
    } else {
      process.stderr.write(`Error: unknown argument: ${arg}\n`);
      return 2;
    }
  }

  if (!planFileArg) {
    process.stderr.write("Error: --plan-file is required\n");
    return 2;
  }

  const planFile = expanduser(planFileArg);
  const contract = buildContract(planFile);

  if (forceConfirm) {
    contract.confirmed = true;
    process.stderr.write(
      `approach_contract: force-confirm enabled for ${contract.plan_file}\n`,
    );
    finish(contract, asJson);
    return 0;
  }

  const interactive = Boolean(process.stdin.isTTY) && !asJson;
  if (interactive) {
    process.stdout.write(`${formatContract(contract)}\n`);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      while (true) {
        let answer: string;
        try {
          answer = (await rl.question("Proceed? [Y/n/edit] ")).trim().toLowerCase();
        } catch {
          answer = "n";
        }
        if (answer === "" || answer === "y" || answer === "yes") {
          contract.confirmed = true;
          finish(contract, asJson);
          return 0;
        }
        if (answer === "n" || answer === "no") {
          finish(contract, asJson);
          return 1;
        }
        if (answer === "edit") {
          process.stdout.write("Edit the plan file and re-run\n");
          finish(contract, asJson);
          return 1;
        }
      }
    } finally {
      rl.close();
    }
  }

  // Non-interactive: a constraint violation blocks; otherwise auto-confirm.
  if (!contract.valid) {
    finish(contract, asJson);
    process.stderr.write(
      `approach_contract: constraint violation: ${contract.violations[0]}\n`,
    );
    return 1;
  }
  contract.confirmed = true;
  finish(contract, asJson);
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
