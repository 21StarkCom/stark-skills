#!/usr/bin/env node
/**
 * `/stark-write-spec` TS dispatcher — the CLI process boundary the skill invokes.
 *
 * A thin wrapper over `runWriteSpec` (the bounded lead/wing loop, #700) and
 * `deriveSlugFromOut` (the slug contract, #699) from `write_spec_lib.ts`. Its
 * whole job is the process contract the skill (5-1) depends on:
 *
 *  - parse `--intent-brief`/`--out` (+ overrides) — there is deliberately NO
 *    `--slug` flag; the slug is re-derived from `--out` via `deriveSlugFromOut`
 *    so the filename and slug can never desync;
 *  - reject `gemini` at validation with the exact documented message
 *    (`claude`/`codex` only at v1);
 *  - `--dry-run` assembles + prints the planned dispatch (including the derived
 *    slug and the resolved lead/wing argv) and exits 0 with ZERO side effects
 *    outside the scratchpad — no LLM call, no `--out` file, no history/run
 *    record;
 *  - on a real run, print the receipt JSON to stdout and exit 0 iff
 *    `contract_satisfied`, else non-zero with the receipt's `error.code`.
 *
 * Arg-parsing house style mirrors `red_team_spec.ts` (positional-free switch,
 * a `next()` value-consumer, help via the shared standards/help.md pattern).
 *
 * Usage:
 *   node --experimental-strip-types tools/write_spec.ts \
 *     --intent-brief "..." --out docs/specs/YYYY-MM-DD-<slug>-spec.md \
 *     [--lead claude|codex] [--wing claude|codex] \
 *     [--lead-model ID] [--wing-model ID] \
 *     [--max-rounds N] [--timeout SEC] [--wing-timeout SEC] \
 *     [--dry-run] [--json]
 */

import {
  assembleBriefForDispatch,
  buildLeadCmd,
  buildWingCmd,
  composePrompt,
  deriveSlugFromOut,
  loadAgentPromptText,
  loadContractText,
  resolveWriteSpecDefaults,
  runWriteSpec,
  type WriteSpecAgent,
  type WriteSpecReceipt,
  type WriteSpecRole,
} from "./write_spec_lib.ts";
import { getWriteSpecConfig } from "./stark_config_lib.ts";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** The v1 agent allowlist. `gemini` is a KNOWN-but-unsupported name (distinct
 * error message); anything else is an unknown value. */
const VALID_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

interface CliArgs {
  /** Filesystem PATH to the intent brief (a markdown file); its CONTENTS are
   * read at dispatch time and passed as the brief. Never the brief text. */
  intentBrief: string;
  out: string;
  lead: WriteSpecAgent;
  wing: WriteSpecAgent;
  leadModel: string | null;
  wingModel: string | null;
  maxRounds: number | null;
  timeout: number | null;
  wingTimeout: number | null;
  dryRun: boolean;
  json: boolean;
}

/**
 * Validate an `--lead`/`--wing` agent value. `gemini` gets the EXACT documented
 * v1 rejection message; any other non-allowlisted value is a generic error.
 */
function validateAgent(flag: string, value: string): WriteSpecAgent {
  if (value === "gemini") {
    throw new Error("unsupported agent: gemini (claude|codex only at v1)");
  }
  if (!VALID_AGENTS.has(value)) {
    throw new Error(`${flag} must be claude or codex; got ${value}`);
  }
  return value as WriteSpecAgent;
}

function parsePosInt(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer; got ${value}`);
  }
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const cfg = getWriteSpecConfig();
  const args: CliArgs = {
    intentBrief: "",
    out: "",
    lead: validateAgent("--lead", String(cfg.lead_agent || "claude")),
    wing: validateAgent("--wing", String(cfg.wing_agent || "codex")),
    leadModel: null,
    wingModel: null,
    maxRounds: null,
    timeout: null,
    wingTimeout: null,
    dryRun: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case "--intent-brief":
        args.intentBrief = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--lead":
        args.lead = validateAgent("--lead", next());
        break;
      case "--wing":
        args.wing = validateAgent("--wing", next());
        break;
      case "--lead-model":
        args.leadModel = next();
        break;
      case "--wing-model":
        args.wingModel = next();
        break;
      case "--max-rounds":
        args.maxRounds = parsePosInt("--max-rounds", next());
        break;
      case "--timeout":
        args.timeout = parsePosInt("--timeout", next());
        break;
      case "--wing-timeout":
        args.wingTimeout = parsePosInt("--wing-timeout", next());
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
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
  if (!args.intentBrief) throw new Error("--intent-brief is required");
  if (!args.out) throw new Error("--out is required");
  return args;
}

/**
 * Read the intent brief from the PATH passed via `--intent-brief`. The flag is a
 * filesystem path (a markdown brief written to the session scratchpad), per the
 * spec's dispatcher interface — NOT inline text. Throws a clear error if the
 * file is missing or unreadable so a bad path fails before any dispatch.
 */
function readIntentBrief(briefPath: string): string {
  try {
    return readFileSync(briefPath, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read --intent-brief PATH ${briefPath}: ${(err as Error).message}`,
    );
  }
}

function printHelp(): void {
  process.stdout.write(`usage: write_spec.ts [-h] --intent-brief PATH --out PATH
                     [--lead claude|codex] [--wing claude|codex]
                     [--lead-model ID] [--wing-model ID]
                     [--max-rounds N] [--timeout SEC] [--wing-timeout SEC]
                     [--dry-run] [--json]

Author a spec via the bounded lead/wing contract loop (TS dispatcher).

There is NO --slug flag — the slug is derived from --out, whose basename must
match docs/specs/YYYY-MM-DD-<slug>-spec.md.

options:
  -h, --help              show this help message and exit
  --intent-brief PATH     Path to a markdown brief file whose CONTENTS are the concrete intent (required).
  --out PATH              Destination docs/specs/YYYY-MM-DD-<slug>-spec.md (required).
  --lead AGENT            Lead (author) agent: claude|codex (default from config).
  --wing AGENT            Wing (contract verifier) agent: claude|codex (default from config).
  --lead-model ID         Override the lead model id.
  --wing-model ID         Override the wing model id.
  --max-rounds N          Cap the lead/wing rounds (default from config).
  --timeout SEC           Lead dispatch timeout in seconds.
  --wing-timeout SEC      Wing dispatch timeout in seconds.
  --dry-run               Assemble + print the planned dispatch and exit 0 (no LLM, no writes).
  --json                  Emit JSON (dry-run plan / receipt) on stdout.
`);
}

/**
 * Assemble the planned-dispatch object for `--dry-run`. Pure — resolves the
 * derived slug, the exact lead/wing argv, AND the fully-composed lead/wing
 * prompts (contract + per-agent template + assembled brief) WITHOUT dispatching
 * or writing. Resolving the prompts here means a dry run surfaces a missing or
 * broken prompt asset (absent contract.md / per-agent template) — the whole
 * point of a dry run — and never redeclares the lib's default constants
 * (`resolveWriteSpecDefaults`), so the printed numbers match a real run.
 */
function buildDryRunPlan(a: CliArgs, briefText: string) {
  const defaults = resolveWriteSpecDefaults();
  const lead = buildLeadCmd(a.lead, a.leadModel ?? undefined);
  const wing = buildWingCmd(a.wing, defaults.wingEffort, a.wingModel ?? undefined);

  // Resolve + compose the planned prompts. Throws if any asset is missing or
  // the contract is empty — exactly the failure a dry run should expose.
  const contractText = loadContractText();
  const assembledBrief = assembleBriefForDispatch(briefText, defaults.inputCap);
  const composeFor = (agent: WriteSpecAgent, role: WriteSpecRole): string =>
    composePrompt(loadAgentPromptText(agent, role), contractText, assembledBrief);

  return {
    dry_run: true,
    slug: deriveSlugFromOut(a.out),
    out: a.out,
    lead_agent: a.lead,
    wing_agent: a.wing,
    lead_model: a.leadModel,
    wing_model: a.wingModel,
    max_rounds: a.maxRounds ?? defaults.maxRounds,
    lead_timeout_s: a.timeout ?? defaults.leadTimeoutS,
    wing_timeout_s: a.wingTimeout ?? defaults.wingTimeoutS,
    lead_cmd: [lead.cmd, ...lead.args],
    wing_cmd: [wing.cmd, ...wing.args],
    lead_prompt: composeFor(a.lead, "generate"),
    wing_prompt: composeFor(a.wing, "verify"),
  };
}

/**
 * Human-readable rendering of a real-run receipt (emitted when `--json` is NOT
 * passed). `--json` prints the raw receipt object instead; the two paths carry
 * the same information so the flag's advertised effect is consistent with the
 * dry-run path.
 */
export function renderReceipt(r: WriteSpecReceipt): string {
  const lines: string[] = [];
  lines.push(`write-spec ${r.ok ? "OK" : "FAILED"} — ${r.final_verdict}`);
  lines.push(`  slug:      ${r.slug}`);
  lines.push(`  spec_path: ${r.spec_path}`);
  lines.push(`  run_dir:   ${r.run_dir}`);
  lines.push(`  rounds:    ${r.rounds}`);
  lines.push(`  lead/wing: ${r.lead_agent}/${r.wing_agent}`);
  // Cost is a first-class receipt field (#703) — surface it on the human path
  // too, not only under --json, so both output paths carry the same info.
  {
    const n = r.cost_breakdown.length;
    const unavailable = r.cost_notes.length > 0 ? " (some usage unavailable)" : "";
    lines.push(
      `  cost:      $${r.cost_usd.toFixed(4)} (${n} invocation${n === 1 ? "" : "s"})${unavailable}`,
    );
  }
  lines.push("  contract:");
  for (const it of r.contract_status) {
    lines.push(`    [${it.status}] ${it.section}${it.note ? `: ${it.note}` : ""}`);
  }
  if (r.dropped_sections.length > 0) {
    lines.push(`  dropped:   ${r.dropped_sections.join(", ")}`);
  }
  if (r.summary) lines.push(`  summary:   ${r.summary}`);
  if (r.error) lines.push(`  error:     ${r.error.code}: ${r.error.message}`);
  return lines.join("\n") + "\n";
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`write_spec: ${(err as Error).message}\n`);
    return 2;
  }

  // Derive the slug early so a non-conforming --out fails BEFORE any dispatch.
  let slug: string;
  try {
    slug = deriveSlugFromOut(args.out);
  } catch (err) {
    process.stderr.write(`write_spec: ${(err as Error).message}\n`);
    return 2;
  }

  // Read the intent brief from its PATH before any dispatch, so a missing or
  // unreadable file fails fast (and identically on the dry-run + real paths).
  let briefText: string;
  try {
    briefText = readIntentBrief(args.intentBrief);
  } catch (err) {
    process.stderr.write(`write_spec: ${(err as Error).message}\n`);
    return 2;
  }

  // ── Dry run: print the planned dispatch, exit 0, zero side effects ──────
  if (args.dryRun) {
    let plan: ReturnType<typeof buildDryRunPlan>;
    try {
      plan = buildDryRunPlan(args, briefText);
    } catch (err) {
      // A missing/empty prompt asset is exactly what a dry run should surface.
      process.stderr.write(`write_spec: ${(err as Error).message}\n`);
      return 2;
    }
    if (args.json) {
      process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
    } else {
      process.stdout.write("Planned write-spec dispatch (dry run):\n");
      process.stdout.write(`  slug:          ${plan.slug}\n`);
      process.stdout.write(`  out:           ${plan.out}\n`);
      process.stdout.write(`  lead:          ${plan.lead_agent}${args.leadModel ? ` (${args.leadModel})` : ""}\n`);
      process.stdout.write(`  wing:          ${plan.wing_agent}${args.wingModel ? ` (${args.wingModel})` : ""}\n`);
      process.stdout.write(`  max_rounds:    ${plan.max_rounds}\n`);
      process.stdout.write(`  lead_timeout:  ${plan.lead_timeout_s}s\n`);
      process.stdout.write(`  wing_timeout:  ${plan.wing_timeout_s}s\n`);
      process.stdout.write(`  lead_cmd:      ${plan.lead_cmd.join(" ")}\n`);
      process.stdout.write(`  wing_cmd:      ${plan.wing_cmd.join(" ")}\n`);
      process.stdout.write(`  lead_prompt:   ${plan.lead_prompt.length} chars (assembled)\n`);
      process.stdout.write(`  wing_prompt:   ${plan.wing_prompt.length} chars (assembled)\n`);
    }
    return 0;
  }

  // ── Real run ────────────────────────────────────────────────────────────
  let receipt: WriteSpecReceipt;
  try {
    receipt = await runWriteSpec({
      out: args.out,
      brief: briefText,
      leadAgent: args.lead,
      wingAgent: args.wing,
      maxRounds: args.maxRounds ?? undefined,
      leadModel: args.leadModel,
      wingModel: args.wingModel,
      leadTimeoutS: args.timeout,
      wingTimeoutS: args.wingTimeout,
    });
  } catch (err) {
    const envelope = {
      ok: false,
      slug,
      spec_path: args.out,
      error: { code: "dispatch_failed", message: (err as Error).message },
    };
    // The failure envelope is inherently structured; emit it as JSON either way.
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return 1;
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    process.stdout.write(renderReceipt(receipt));
  }
  // Exit 0 iff the contract was satisfied; otherwise non-zero (the skill 5-1
  // captures the handled verdict without aborting).
  return receipt.ok ? 0 : 1;
}

// Run `main` only when executed as the entry point — NOT when imported (e.g. a
// unit test importing `renderReceipt`), so importing this module is side-effect
// free.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`write_spec: unhandled: ${(err as Error).stack ?? err}\n`);
      process.exit(1);
    });
}
