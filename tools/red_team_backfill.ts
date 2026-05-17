#!/usr/bin/env node
/**
 * `red_team_backfill` TS CLI — port of `scripts/red_team_backfill.py`.
 *
 * Backfill local red-team SQLite audit rows into the insights queue.
 *
 * Usage:
 *   node --experimental-strip-types tools/red_team_backfill.ts \
 *     [--scope all|legacy|forward] [--db PATH] [--limit N] \
 *     [--dry-run] [--manifest PATH]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDb } from "./red_team_db_resolver.ts";

import { initRedTeamTables } from "./red_team_audit_lib.ts";
import { runBackfill, type BackfillScope } from "./red_team_backfill_lib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

interface CliArgs {
  scope: BackfillScope;
  db: string | null;
  limit: number | null;
  dryRun: boolean;
  manifest: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    scope: "legacy",
    db: null,
    limit: null,
    dryRun: false,
    manifest: null,
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
      case "--scope": {
        const v = next();
        if (v !== "all" && v !== "legacy" && v !== "forward") {
          throw new Error(`--scope must be all|legacy|forward, got ${JSON.stringify(v)}`);
        }
        args.scope = v;
        break;
      }
      case "--db":
        args.db = next();
        break;
      case "--limit": {
        const v = Number(next());
        if (!Number.isFinite(v) || v < 0) throw new Error("--limit must be >= 0");
        args.limit = Math.trunc(v);
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--manifest":
        args.manifest = next();
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
Usage: red_team_backfill [options]

Backfill red-team SQLite audit rows into the stark-insights queue.

Options:
  --scope SCOPE      Rows to backfill: all|legacy|forward (default: legacy).
                     legacy = pre-v1.2 rows (fix_plan_status IS NULL).
                     forward = post-v1.2 rows (fix_plan_status IS NOT NULL).
  --db PATH          Path to forged_review_metrics.db. Defaults to the
                     canonical resolver (scripts/red_team_audit_cli.py resolve-db).
  --limit N          Maximum red_team_runs rows to process (>=0).
  --dry-run          Build events without enqueueing.
  --manifest PATH    Write generated dedupe keys to this JSON file
                     (for rollback support).
  -h, --help         Show this help.
`,
  );
}


export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`red-team backfill: ${(err as Error).message}\n`);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  const dbPath = resolveDb(args.db).db_path;
  process.stderr.write(
    `red-team backfill: scope=${args.scope} db=${dbPath} dry_run=${args.dryRun} ` +
      `limit=${args.limit === null ? "none" : args.limit}\n`,
  );
  let stats;
  try {
    stats = runBackfill({
      dbPath,
      scope: args.scope,
      limit: args.limit,
      dryRun: args.dryRun,
      manifestPath: args.manifest,
      ensureSchema: initRedTeamTables,
    });
  } catch (err) {
    process.stderr.write(`red-team backfill failed: ${(err as Error).message}\n`);
    return 1;
  }
  process.stderr.write(
    `red-team backfill complete: rows=${stats.rows} skipped_rows=${stats.skipped_rows} ` +
      `runs=${stats.red_team_run} findings=${stats.red_team_finding} ` +
      `fix_plans=${stats.red_team_fix_plan} enqueued=${stats.enqueued} ` +
      `duplicates=${stats.duplicates}\n`,
  );
  process.stderr.write(
    "Note: enqueue success means the local durable queue accepted the event; " +
      "verify cloud insertion with a dedupe-key query against events.\n",
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
