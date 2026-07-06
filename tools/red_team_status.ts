#!/usr/bin/env node
/**
 * `/red_team status` TS CLI — port of `scripts/red_team_status.py`.
 *
 * Lists every pending red-team human-review halt (any unaccepted
 * finding whose counter_proposal is REQUEST_HUMAN_REVIEW). Read-only.
 *
 * Usage:
 *   node --experimental-strip-types tools/red_team_status.ts
 *   node --experimental-strip-types tools/red_team_status.ts --repo Evinced/foo
 *   node --experimental-strip-types tools/red_team_status.ts --stage spec
 *   node --experimental-strip-types tools/red_team_status.ts --json
 *
 * Acceptance happens via `tools/red_team_accept.ts`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDb } from "./red_team_db_resolver.ts";

import {
  type PendingHalt,
  listPendingHalts,
} from "./red_team_human_review_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

interface CliArgs {
  repo: string | null;
  stage: "spec" | "plan" | null;
  json: boolean;
  db: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repo: null,
    stage: null,
    json: false,
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
      case "--repo":
        args.repo = next();
        break;
      case "--stage": {
        const v = next();
        if (v !== "spec" && v !== "plan") {
          throw new Error(`--stage must be spec|plan, got ${JSON.stringify(v)}`);
        }
        args.stage = v;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--db":
        args.db = next();
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    `\
Usage: red_team_status [options]

List pending red-team human-review halts. Use red_team_accept to
acknowledge them by stable_key.

Options:
  --repo NAME        Filter to one repo (nameWithOwner).
  --stage STAGE      Filter by stage (spec|plan).
  --json             Emit JSON instead of human text.
  --db PATH          Audit DB path override. Defaults to the canonical
                     resolver (scripts/red_team_audit_cli.py resolve-db).
  -h, --help         Show this help.
`,
  );
}


function formatHuman(halts: readonly PendingHalt[]): string {
  if (halts.length === 0) {
    return "red_team_status: no pending human-review halts\n";
  }
  const lines: string[] = [
    `red_team_status: ${halts.length} pending human-review halts`,
  ];
  for (const h of halts) {
    let excerpt = (h.concern_excerpt ?? "").replace(/\n/g, " ").trim();
    if (excerpt.length > 140) excerpt = excerpt.slice(0, 137) + "...";
    const repoSeg = h.repo ? `  repo=${h.repo}` : "";
    const prSeg = h.pr_number ? `  pr=${h.pr_number}` : "";
    const pathSeg = h.artifact_relative_path
      ? `  artifact=${h.artifact_relative_path}`
      : "";
    lines.push("");
    lines.push(`- stable_key: ${h.stable_key}`);
    lines.push(
      `  run_id=${h.run_id}  stage=${h.stage}  round=${h.round_num}` +
        `  persona=${h.persona}  finding_id=${h.finding_id}${repoSeg}${prSeg}${pathSeg}`,
    );
    if (excerpt) lines.push(`  concern: ${excerpt}`);
  }
  return lines.join("\n") + "\n";
}

/** JSON serializer that matches Python `json.dump(..., indent=2, sort_keys=True)`. */
function formatJson(halts: readonly PendingHalt[]): string {
  return (
    JSON.stringify(
      halts.map((h) => sortKeys(h)),
      null,
      2,
    ) + "\n"
  );
}

function sortKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortKeys) as T;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
    return sorted as T;
  }
  return value;
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`red_team_status: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  const dbPath = resolveDb(args.db).db_path;
  const halts = listPendingHalts({
    repo: args.repo,
    stage: args.stage,
    dbPath,
  });
  if (args.json) {
    process.stdout.write(formatJson(halts));
  } else {
    process.stdout.write(formatHuman(halts));
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
