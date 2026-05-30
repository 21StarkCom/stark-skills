#!/usr/bin/env node
/**
 * preflight CLI — TypeScript port of `scripts/preflight.py`'s argparse
 * surface.
 *
 *   preflight.ts [--workflow NAME] [--json] [--skip-check NAME]...
 *
 * Output:
 *   - Default: a human-readable table on stdout.
 *   - `--json`: the full PreFlightResult as JSON on stdout (the format
 *     every SKILL reads via `jq`).
 * Side effects (best-effort, errors logged to stderr):
 *   - Appends one JSON line to `~/.claude/code-review/preflight.jsonl`.
 *
 * Exit code: 1 when `overall == "blocked"`, otherwise 0.
 */

import fs from "node:fs";

import {
  logResult,
  renderTable,
  runPreflight,
} from "./preflight_lib.ts";

const HELP = `usage: preflight.ts [--workflow NAME] [--json] [--skip-check NAME]...

Options:
  --workflow NAME    Workflow name (used in log and event payload, default 'default')
  --json             Output PreFlightResult as JSON instead of a table
  --skip-check NAME  Skip a named check (repeatable, logs override to stderr)
  -h, --help         Show this help
`;

interface Parsed {
  workflow: string;
  json: boolean;
  skip: Set<string>;
  help: boolean;
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = {
    workflow: "default",
    json: false,
    skip: new Set(),
    help: false,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") {
      out.help = true;
      i++;
      continue;
    }
    if (a === "--json") {
      out.json = true;
      i++;
      continue;
    }
    if (a === "--workflow") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("Missing value for --workflow");
      out.workflow = v;
      i += 2;
      continue;
    }
    if (a === "--skip-check") {
      const v = argv[i + 1];
      if (v === undefined) throw new Error("Missing value for --skip-check");
      out.skip.add(v);
      i += 2;
      continue;
    }
    throw new Error(`Unknown option: ${a}`);
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const result = await runPreflight({
    workflow: parsed.workflow,
    skip: parsed.skip,
  });

  // Side effect: log. Swallows errors internally.
  logResult(result);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderTable(result));
  }

  return result.overall === "blocked" ? 1 : 0;
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
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`preflight: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
