#!/usr/bin/env -S node --experimental-strip-types
// CLI entry point for the refactor-planner dispatcher.
//
//   node --experimental-strip-types tools/refactor_planner.ts --mode dry-run
//   node --experimental-strip-types tools/refactor_planner.ts --mode run --provider claude
//   node --experimental-strip-types tools/refactor_planner.ts --mode validate
//
// Modes:
//   dry-run   build the inventory + planned subagent jobs, no LLM calls
//   run       full multi-agent planning workflow -> REFACTOR_PLAN.md + REFACTOR_BACKLOG.json
//   validate  validate an existing REFACTOR_BACKLOG.json (schema + DAG + path checks)

import { runDispatcher, type DispatcherReceipt, type RunMode } from "./refactor_planner_lib.ts";
import type { ProviderKind } from "./refactor_planner_provider.ts";

interface CliArgs {
  mode: RunMode;
  root: string;
  provider?: ProviderKind;
  model?: string;
  out?: string;
  maxConcurrency?: number;
  overwrite: boolean;
  promptsDir?: string;
  excludes?: string[];
  allowPartial: boolean;
  json: boolean;
}

const HELP = `refactor_planner — multi-agent repository refactor-planning dispatcher

Usage:
  node --experimental-strip-types tools/refactor_planner.ts --mode <dry-run|run|validate> [options]

Options:
  --mode <m>             dry-run (default) | run | validate
  --root <dir>           repository root to analyze (default: cwd)
  --provider <p>         claude | codex | noop  (default: env REFACTOR_PLANNER_PROVIDER or claude)
  --model <id>           model id override (default: repo resolveModel for the provider)
  --out <dir>            intermediates dir (default: <root>/.refactor-planner)
  --max-concurrency <n>  wave-1 fanout concurrency (default: 4)
  --prompts-dir <dir>    subagent prompt dir (default: env STARK_REFACTOR_PROMPTS or asset prompts/refactor-planner)
  --exclude <a,b,c>      extra path exclusions (added to defaults)
  --no-overwrite         refuse to overwrite existing artifacts
  --allow-partial        (run) write a plan even if some subagents failed
  --json                 print the machine-readable receipt to stdout
  -h, --help             show this help

Planning only: writes <root>/.refactor-planner/ and the two root artifacts; never edits source.`;

function parseArgs(argv: string[]): CliArgs | { help: true } | { error: string } {
  const a: CliArgs = { mode: "dry-run", root: process.cwd(), overwrite: true, allowPartial: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "-h": case "--help": return { help: true };
      case "--mode": {
        const m = next();
        if (m !== "dry-run" && m !== "run" && m !== "validate") return { error: `invalid --mode '${m}'` };
        a.mode = m; break;
      }
      case "--root": a.root = next(); break;
      case "--provider": {
        const p = next();
        if (p !== "claude" && p !== "codex" && p !== "noop") return { error: `invalid --provider '${p}'` };
        a.provider = p; break;
      }
      case "--model": a.model = next(); break;
      case "--out": a.out = next(); break;
      case "--max-concurrency": a.maxConcurrency = Number(next()); break;
      case "--prompts-dir": a.promptsDir = next(); break;
      case "--exclude": a.excludes = (next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--no-overwrite": a.overwrite = false; break;
      case "--allow-partial": a.allowPartial = true; break;
      case "--json": a.json = true; break;
      default: return { error: `unknown argument '${arg}'` };
    }
  }
  return a;
}

function printHuman(r: DispatcherReceipt): void {
  const L = (s: string) => process.stderr.write(s + "\n");
  L(`refactor-planner — mode=${r.mode} provider=${r.provider} root=${r.root}`);
  L(r.ok ? "status: OK" : "status: FAILED");
  if (r.inventorySummary) L(`inventory: ${JSON.stringify(r.inventorySummary)}`);
  if (r.plannedJobs) {
    L(`planned jobs (${r.plannedJobs.length}):`);
    for (const j of r.plannedJobs) L(`  - ${j.agent}: ${j.files} files, ${j.commandOutputs} command outputs`);
  }
  if (r.findingCounts) L(`findings: ${JSON.stringify(r.findingCounts)}`);
  if (typeof r.conflicts === "number") L(`conflicts resolved: ${r.conflicts}`);
  if (r.validation) {
    L(`backlog validation: ${r.validation.ok ? "PASS" : "FAIL"}`);
    for (const e of r.validation.errors) L(`  ERROR ${e}`);
    for (const w of r.validation.warnings.slice(0, 10)) L(`  warn  ${w}`);
  }
  if (r.diagnostics.length) {
    L(`diagnostics (${r.diagnostics.length}):`);
    for (const d of r.diagnostics) L(`  - ${d.agent}: ${d.error}${d.rawPath ? ` (raw: ${d.rawPath})` : ""}`);
  }
  if (r.artifacts) { L(`wrote: ${r.artifacts.planPath}`); L(`wrote: ${r.artifacts.backlogPath}`); }
  for (const e of r.errors) L(`  ! ${e}`);
  L(`intermediates: ${r.outDir}`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) { process.stdout.write(HELP + "\n"); process.exitCode = 0; return; }
  if ("error" in parsed) { process.stderr.write(`error: ${parsed.error}\n\n${HELP}\n`); process.exitCode = 2; return; }

  const receipt = await runDispatcher({
    mode: parsed.mode,
    root: parsed.root,
    provider: { provider: parsed.provider, model: parsed.model },
    discover: parsed.excludes ? { excludes: [...defaultExcludes(), ...parsed.excludes] } : undefined,
    outDir: parsed.out,
    maxConcurrency: parsed.maxConcurrency,
    overwrite: parsed.overwrite,
    promptsDir: parsed.promptsDir,
    allowPartial: parsed.allowPartial,
  });

  if (parsed.json) process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  printHuman(receipt);
  process.exit(receipt.ok ? 0 : 1);
}

function defaultExcludes(): string[] {
  // Mirror discovery defaults so --exclude is additive, not replacing.
  return [".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", ".turbo", ".cache", ".refactor-planner"];
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
