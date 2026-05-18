#!/usr/bin/env node
/**
 * context_compactor CLI — TypeScript port of
 * `scripts/context_compactor.py`. Surface preserved 1:1:
 *
 *   context_compactor.ts [--session-id ID] [--json]
 *
 * JSON output: { "session_id", "checkpoint_path" }. Text output: human
 * lines naming the freshly-written and latest checkpoint paths.
 */

import fs from "node:fs";

import {
  generateCheckpoint,
  getLatestCheckpoint,
} from "./context_compactor_lib.ts";
import { resolveSessionId } from "./session_id_lib.ts";

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
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      "usage: context_compactor.ts [--session-id ID] [--json]\n",
    );
    return 0;
  }
  const args = parseArgs(argv);
  const sessionId = flagString(args, "session-id");
  const asJson = flagBool(args, "json");

  const checkpointPath = generateCheckpoint({ sessionId });
  const sid = sessionId ?? resolveSessionId();

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        { session_id: sid, checkpoint_path: checkpointPath },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`Checkpoint written: ${checkpointPath}\n`);
    const latest = getLatestCheckpoint({ sessionId: sid });
    if (latest) process.stdout.write(`Latest checkpoint:  ${latest}\n`);
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
    process.stderr.write(`context_compactor: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
