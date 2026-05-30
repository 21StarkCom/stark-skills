#!/usr/bin/env node
/**
 * `/stark-red-team-design` TS dispatcher.
 *
 * Thin wrapper around `tools/red_team_lib.ts`. The former Python entry
 * (`scripts/red_team_design_dispatch.py`) was deleted in Phase 4 of the
 * 2026-05-16 TS migration.
 *
 * Usage:
 *   node --experimental-strip-types tools/red_team_design.ts \
 *     --design path/to/design.md \
 *     [--source-spec path/to/spec.md] \
 *     [--model gpt-5.5-pro] \
 *     [--no-sidecar] [--no-audit] [--json] \
 *     [--replay-transcript path/to/recorded.json] \
 *     [--classification-override LEVEL]
 */

import fs from "node:fs";
import path from "node:path";

import {
  buildRunContext,
  type ClassLevel,
  dispatchAsync,
  loadPersonaPrompts,
  resolveDbPath,
  type PersonaSlug,
  VALID_PERSONAS,
} from "./red_team_lib.ts";

const DEFAULT_MODEL = "gpt-5.5-pro";
const DEFAULT_TIMEOUT_MS = 900_000;

interface CliArgs {
  design: string;
  sourceSpec: string | null;
  model: string;
  noSidecar: boolean;
  noAudit: boolean;
  json: boolean;
  replayTranscript: string | null;
  classificationOverride: ClassLevel | null;
  personas: PersonaSlug[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    design: "",
    sourceSpec: null,
    model: DEFAULT_MODEL,
    noSidecar: false,
    noAudit: false,
    json: false,
    replayTranscript: null,
    classificationOverride: null,
    personas: [...VALID_PERSONAS],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--design":
        args.design = next();
        break;
      case "--source-spec":
        args.sourceSpec = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--no-sidecar":
        args.noSidecar = true;
        break;
      case "--no-audit":
        args.noAudit = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--replay-transcript":
        args.replayTranscript = next();
        break;
      case "--classification-override": {
        const v = next();
        if (
          v !== "public" &&
          v !== "internal" &&
          v !== "confidential" &&
          v !== "restricted"
        ) {
          throw new Error(`invalid --classification-override: ${v}`);
        }
        args.classificationOverride = v;
        break;
      }
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!args.design) {
    throw new Error("--design is required");
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`usage: red_team_design.ts [-h] --design DESIGN
                          [--source-spec SOURCE_SPEC]
                          [--model MODEL]
                          [--no-sidecar] [--no-audit] [--json]
                          [--replay-transcript PATH]
                          [--classification-override LEVEL]

Adversarial red-team review of a design doc (TS port).

options:
  -h, --help                       show this help message and exit
  --design DESIGN                  Path to the design markdown file.
  --source-spec SOURCE_SPEC        Optional source-spec file.
  --model MODEL                    Override the configured red-team model.
  --no-sidecar                     Skip writing the <design>.red-team.md sidecar.
  --no-audit                       Skip the SQLite audit row.
  --json                           Emit a single JSON object on stdout.
  --replay-transcript PATH         Phase 1 deterministic seam — bypass live model.
  --classification-override LEVEL  Override the classification gate (public|internal|confidential|restricted).
`);
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`red_team_design: ${(err as Error).message}\n`);
    return 2;
  }

  const designPath = path.resolve(args.design);
  if (!fs.existsSync(designPath)) {
    const envelope = {
      status: "error",
      error: `design file not found: ${designPath}`,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return 2;
  }
  const sourceSpecPath = args.sourceSpec
    ? path.resolve(args.sourceSpec)
    : null;
  if (sourceSpecPath && !fs.existsSync(sourceSpecPath)) {
    const envelope = {
      status: "error",
      error: `source-spec file not found: ${sourceSpecPath}`,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return 2;
  }

  const artifact = fs.readFileSync(designPath, "utf8");
  const sourceSpec = sourceSpecPath
    ? fs.readFileSync(sourceSpecPath, "utf8")
    : artifact;

  const resolved = resolveDbPath();
  const ctx = buildRunContext({
    stage: "design",
    artifactPath: designPath,
    sourceSpecPath,
    dbPath: resolved.db_path,
  });

  const prompts = loadPersonaPrompts();

  const result = await dispatchAsync({
    ctx,
    prompts,
    personas: args.personas,
    artifact,
    sourceSpec,
    model: args.model,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dbPath: resolved.db_path,
    noAudit: args.noAudit,
    noSidecar: args.noSidecar,
    replayTranscript: args.replayTranscript ?? undefined,
    classificationOverride: args.classificationOverride,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(`Status:           ${result.status}\n`);
    process.stdout.write(`Model:            ${result.model}\n`);
    process.stdout.write(`Run ID:           ${result.run_id}\n`);
    if (result.sidecar_path) {
      process.stdout.write(`Sidecar:          ${result.sidecar_path}\n`);
    }
    if (result.error) {
      process.stdout.write(`Error:            ${result.error}\n`);
    } else {
      process.stdout.write(
        `Findings:         ${result.total_findings} (blocking=${result.blocking_count}, human-review=${result.human_review_count})\n`,
      );
      process.stdout.write(
        `Cost / duration:  $${result.cost_usd.toFixed(4)} / ${result.duration_s.toFixed(1)}s\n`,
      );
      if (result.synthesis) {
        process.stdout.write(`\nSynthesis:\n${result.synthesis}\n`);
      }
    }
  }
  if (result.status === "error") return 2;
  return 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`red_team_design: unhandled: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
