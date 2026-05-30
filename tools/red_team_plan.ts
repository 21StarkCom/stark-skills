#!/usr/bin/env node
/**
 * `/stark-red-team-plan` TS dispatcher (Phase 3 of the migration plan).
 *
 * Sibling of `tools/red_team_design.ts`; only the stage + flag name
 * differ. Delegates everything to `tools/red_team_lib.ts`.
 */

import fs from "node:fs";
import path from "node:path";

import {
  buildRunContext,
  type ClassLevel,
  dispatchAsync,
  loadPersonaPrompts,
  PROMPTS_DIR,
  resolveDbPath,
  type PersonaSlug,
  VALID_PERSONAS,
} from "./red_team_lib.ts";

const DEFAULT_MODEL = "gpt-5.5-pro";
const DEFAULT_TIMEOUT_MS = 900_000;

interface CliArgs {
  plan: string;
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
    plan: "",
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
      case "--plan":
        args.plan = next();
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
  if (!args.plan) {
    throw new Error("--plan is required");
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(`usage: red_team_plan.ts [-h] --plan PLAN
                        [--source-spec SOURCE_SPEC]
                        [--model MODEL]
                        [--no-sidecar] [--no-audit] [--json]
                        [--replay-transcript PATH]
                        [--classification-override LEVEL]

Adversarial red-team review of an execution plan doc (TS port).

options:
  -h, --help                       show this help message and exit
  --plan PLAN                      Path to the plan markdown file.
  --source-spec SOURCE_SPEC        Optional source-spec file.
  --model MODEL                    Override the configured red-team model.
  --no-sidecar                     Skip writing the <plan>.red-team.md sidecar.
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
    process.stderr.write(`red_team_plan: ${(err as Error).message}\n`);
    return 2;
  }

  const planPath = path.resolve(args.plan);
  if (!fs.existsSync(planPath)) {
    const envelope = {
      status: "error",
      error: `plan file not found: ${planPath}`,
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

  const artifact = fs.readFileSync(planPath, "utf8");
  const sourceSpec = sourceSpecPath
    ? fs.readFileSync(sourceSpecPath, "utf8")
    : artifact;

  const resolved = resolveDbPath();
  const ctx = buildRunContext({
    stage: "plan",
    artifactPath: planPath,
    sourceSpecPath,
    dbPath: resolved.db_path,
  });

  const prompts = loadPersonaPrompts(PROMPTS_DIR, "plan");

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
    process.stderr.write(`red_team_plan: unhandled: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
