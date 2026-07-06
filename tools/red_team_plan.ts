#!/usr/bin/env node
/**
 * `/stark-red-team-plan` TS dispatcher (Phase 3 of the migration plan).
 *
 * Sibling of `tools/red_team_spec.ts`; only the stage + flag name
 * differ. Delegates everything to `tools/red_team_lib.ts`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  buildRunContext,
  type ClassLevel,
  dispatchAsync,
  loadPersonaPrompts,
  redTeamPromptsDir,
  resolveDbPath,
  type PersonaSlug,
  sidecarPathFor,
  VALID_PERSONAS,
} from "./red_team_lib.ts";

const DEFAULT_MODEL = "gpt-5.5-pro";
const DEFAULT_TIMEOUT_MS = 900_000;

interface CliArgs {
  plan: string;
  sourceSpec: string | null;
  specDispositions: string | null;
  noSpecDispositions: boolean;
  model: string;
  noSidecar: boolean;
  noAudit: boolean;
  json: boolean;
  replayTranscript: string | null;
  classificationOverride: ClassLevel | null;
  personas: PersonaSlug[];
  fold: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    plan: "",
    sourceSpec: null,
    specDispositions: null,
    noSpecDispositions: false,
    model: DEFAULT_MODEL,
    noSidecar: false,
    noAudit: false,
    json: false,
    replayTranscript: null,
    classificationOverride: null,
    personas: [...VALID_PERSONAS],
    fold: false,
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
      case "--spec-dispositions":
        args.specDispositions = next();
        break;
      case "--no-spec-dispositions":
        args.noSpecDispositions = true;
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
      case "--fold":
        args.fold = true;
        break;
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
                        [--spec-dispositions PATH] [--no-spec-dispositions]
                        [--model MODEL]
                        [--no-sidecar] [--no-audit] [--json]
                        [--replay-transcript PATH]
                        [--classification-override LEVEL]
                        [--fold]

Adversarial red-team review of an execution plan doc (TS port).

options:
  -h, --help                       show this help message and exit
  --plan PLAN                      Path to the plan markdown file.
  --source-spec SOURCE_SPEC        Optional source-spec (design) file.
  --spec-dispositions PATH       Design-stage red-team sidecar to thread in for
                                   plan-stage dedup. Default: auto-discover the
                                   source-spec's <design>.red-team.md sidecar.
  --no-spec-dispositions         Disable design-dispositions threading.
  --model MODEL                    Override the configured red-team model.
  --no-sidecar                     Skip writing the <plan>.red-team.md sidecar.
  --no-audit                       Skip the SQLite audit row.
  --json                           Emit a single JSON object on stdout.
  --replay-transcript PATH         Phase 1 deterministic seam — bypass live model.
  --classification-override LEVEL  Override the classification gate (public|internal|confidential|restricted).
  --fold                           After a successful challenge, fold the fix plan into the artifact via red_team_fold.ts (non-fatal).
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

  // Task #5 — plan-stage dedup. Thread the design's resolved red-team sidecar
  // (`<design>.red-team.md`) into the plan committee so it stops re-deriving
  // concerns already raised + resolved at the design stage. Resolution order:
  //   explicit --spec-dispositions PATH  >  auto: the source-spec's sidecar
  // `--no-spec-dispositions` opts out entirely. Missing/unreadable → silent
  // skip (the plan committee just runs without the dedup context).
  let specDispositions: string | null = null;
  if (!args.noSpecDispositions) {
    let dispPath: string | null = null;
    if (args.specDispositions) {
      dispPath = path.resolve(args.specDispositions);
      if (!fs.existsSync(dispPath)) {
        const envelope = {
          status: "error",
          error: `design-dispositions file not found: ${dispPath}`,
        };
        process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
        return 2;
      }
    } else if (sourceSpecPath) {
      const auto = sidecarPathFor(sourceSpecPath);
      if (auto !== planPath && fs.existsSync(auto)) dispPath = auto;
    }
    if (dispPath) {
      try {
        specDispositions = fs.readFileSync(dispPath, "utf8");
        process.stderr.write(
          `red_team_plan: threading design dispositions from ${dispPath}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `red_team_plan: could not read design dispositions ${dispPath} (non-fatal): ${(err as Error).message}\n`,
        );
      }
    }
  }

  const resolved = resolveDbPath();
  const ctx = buildRunContext({
    stage: "plan",
    artifactPath: planPath,
    sourceSpecPath,
    dbPath: resolved.db_path,
  });

  const prompts = loadPersonaPrompts(redTeamPromptsDir(), "plan");

  const result = await dispatchAsync({
    ctx,
    prompts,
    personas: args.personas,
    artifact,
    sourceSpec,
    specDispositions: specDispositions ?? undefined,
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
  // Non-fatal convenience post-step: after a successful challenge that wrote a
  // sidecar, fold the fix plan into the artifact by shelling out to the
  // standalone fold CLI (`red_team_fold.ts`, the reusable unit). This is sugar
  // over that CLI — the challenge has already succeeded, written its sidecar,
  // and audited; a fold failure is logged but never changes the challenge's
  // exit code or its stdout/JSON contract. `result.sidecar_path` is null under
  // `--no-sidecar`, so that case is subsumed by the truthiness guard. (These
  // dispatchers have no `--dry-run`.)
  if (args.fold && result.sidecar_path && result.status !== "error") {
    const foldEntry = new URL("./red_team_fold.ts", import.meta.url).pathname;
    const foldArgs = ["--experimental-strip-types", foldEntry, "--artifact", args.plan];
    if (args.sourceSpec) foldArgs.push("--source-spec", args.sourceSpec);
    // We deliberately never pass `--json` to fold. Under the challenge's own
    // `--json` we have already emitted the single JSON object that contract
    // promises; a second JSON envelope on stdout would corrupt it. So under
    // `--json` we route fold's stdout to *our* stderr (fd 2) — stdout stays
    // exactly one JSON object — and log a one-line note to stderr. In human
    // mode fold's summary flows to stdout after a separator.
    if (args.json) {
      process.stderr.write(
        `red_team_plan: --fold running fold step (output routed to stderr to preserve --json stdout)\n`,
      );
    } else {
      process.stdout.write(`\n--- fold step ---\n`);
    }
    const r = spawnSync(process.execPath, foldArgs, {
      stdio: ["inherit", args.json ? 2 : "inherit", "inherit"],
    });
    if (r.error) {
      process.stderr.write(
        `red_team_plan: --fold step failed to spawn (non-fatal): ${r.error.message}\n`,
      );
    } else if (typeof r.status === "number" && r.status !== 0) {
      process.stderr.write(
        `red_team_plan: --fold step exited ${r.status} (non-fatal; challenge already succeeded)\n`,
      );
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
