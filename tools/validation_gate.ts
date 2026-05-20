#!/usr/bin/env node
/**
 * validation_gate CLI — run lint/typecheck/test commands and report
 * results. TypeScript port of `scripts/validation_gate.py`.
 *
 * Exit code is always 0; failures are reported in the output only.
 *
 * Usage:
 *   node --experimental-strip-types validation_gate.ts [--json] [--repo-root PATH] [--timeout SECONDS]
 */

import fs from "node:fs";
import path from "node:path";

import {
  formatTable,
  getConfiguredTimeout,
  runValidationGate,
} from "./validation_gate_lib.ts";

const HELP = `Validation gate: lint/typecheck/test runner.

Usage: validation_gate.ts [--json] [--repo-root PATH] [--timeout SECONDS]

Options:
  --json            Output JSON instead of a table
  --repo-root PATH  Root directory of the repo to validate (default: .)
  --timeout SECONDS Override timeout (default: from config, fallback 60)
  --help            Show this help
`;

function main(argv: string[]): number {
  let asJson = false;
  let repoRoot = ".";
  let timeoutArg: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--repo-root") {
      repoRoot = argv[++i];
    } else if (arg.startsWith("--repo-root=")) {
      repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--timeout") {
      timeoutArg = Number(argv[++i]);
    } else if (arg.startsWith("--timeout=")) {
      timeoutArg = Number(arg.slice("--timeout=".length));
    } else {
      process.stderr.write(`Error: unknown argument: ${arg}\n`);
      return 2;
    }
  }

  const resolvedRoot = path.resolve(repoRoot);
  const timeoutS =
    timeoutArg !== null && Number.isFinite(timeoutArg)
      ? Math.trunc(timeoutArg)
      : getConfiguredTimeout();

  const result = runValidationGate(resolvedRoot, timeoutS);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatTable(result)}\n`);
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
  process.exit(main(process.argv.slice(2)));
}
