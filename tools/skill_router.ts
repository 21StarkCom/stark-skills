#!/usr/bin/env node
/**
 * skill_router CLI — TypeScript port of `scripts/skill_router.py`.
 *
 * Surface preserved 1:1:
 *
 *   skill_router.ts --context {review|implementation|session|debug} [--json]
 *
 * JSON output keeps the same shape (`suggestions`, `context`,
 * `timestamp`, `config`) — the `_suppressed_count` key from the
 * internal result is stripped before printing, like the Python.
 */

import fs from "node:fs";

import {
  computeSuggestions,
  humanReadable,
  loadSkillActivationConfig,
  loadSkillUsage,
  VALID_CONTEXTS,
  type Context,
} from "./skill_router_lib.ts";

// ---------------------------------------------------------------------------
// Tiny argv parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), true);
      }
    }
  }
  return { flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(
      "usage: skill_router.ts --context {review|implementation|session|debug} [--json]\n",
    );
    return 0;
  }
  const args = parseArgs(argv);
  const context = flagString(args, "context");
  if (!context) {
    process.stderr.write("Error: --context is required\n");
    return 2;
  }
  if (!VALID_CONTEXTS.has(context as Context)) {
    process.stderr.write(
      `Error: --context must be one of: ${[...VALID_CONTEXTS].sort().join(", ")}\n`,
    );
    return 2;
  }

  const cfg = loadSkillActivationConfig();
  const usage = loadSkillUsage();
  const result = computeSuggestions({
    context: context as Context,
    cfg,
    usage,
    now: new Date(),
  });
  // Strip the internal field before printing — matches Python's
  // `result.pop("_suppressed_count", 0)` right before output.
  const out: Record<string, unknown> = { ...result };
  delete (out as Record<string, unknown>)._suppressed_count;

  if (flagBool(args, "json")) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    process.stdout.write(`${humanReadable(result)}\n`);
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
    process.stderr.write(`skill_router: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
