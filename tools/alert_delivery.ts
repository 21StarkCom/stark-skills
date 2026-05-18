#!/usr/bin/env node
/**
 * alert_delivery CLI — TypeScript port of `scripts/alert_delivery.py`.
 *
 * Surface preserved 1:1:
 *
 *   alert_delivery.ts [--check] [--json]
 *
 * The `--check` flag is the only operation the CLI supports (matching
 * the Python). JSON output: `{ "unacknowledged": [{ "path": "..." }] }`
 * — consumed by `tools/stark_session_lib.ts:collectAlerts`.
 */

import fs from "node:fs";

import { checkAlerts } from "./alert_delivery_lib.ts";

interface ParsedArgs {
  flags: Map<string, true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, true>();
  for (const a of argv) {
    if (a.startsWith("--")) flags.set(a.slice(2), true);
  }
  return { flags };
}

function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write("usage: alert_delivery.ts [--check] [--json]\n");
    return 0;
  }
  const args = parseArgs(argv);
  const asJson = args.flags.has("json");

  const result = checkAlerts();
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const n = result.unacknowledged.length;
  if (n === 0) {
    process.stdout.write("No unacknowledged alerts.\n");
    return 0;
  }
  process.stdout.write(`${n} unacknowledged alert(s):\n`);
  for (const item of result.unacknowledged) {
    process.stdout.write(`  ${item.path}\n`);
  }
  return 0;
}

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
    process.stderr.write(`alert_delivery: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
