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
  buildAgentEnv,
  parseCodexJsonl,
  releaseAgentTempDir,
  run,
} from "./copilot_dispatch.ts";
import {
  type AgentCommand,
  buildLeadCmd,
  buildWingCmd,
  deriveSlugFromOut,
  loadAgentPromptText,
  loadContractText,
  parseClaudeJson,
  runWriteSpec,
  type WriteSpecAgent,
  type WriteSpecDeps,
  type WriteSpecReceipt,
  writeExitArtifacts,
} from "./write_spec_lib.ts";
import { getWriteSpecConfig } from "./stark_config_lib.ts";

/** The v1 agent allowlist. `gemini` is a KNOWN-but-unsupported name (distinct
 * error message); anything else is an unknown value. */
const VALID_AGENTS: ReadonlySet<string> = new Set(["claude", "codex"]);

interface CliArgs {
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

function printHelp(): void {
  process.stdout.write(`usage: write_spec.ts [-h] --intent-brief BRIEF --out PATH
                     [--lead claude|codex] [--wing claude|codex]
                     [--lead-model ID] [--wing-model ID]
                     [--max-rounds N] [--timeout SEC] [--wing-timeout SEC]
                     [--dry-run] [--json]

Author a spec via the bounded lead/wing contract loop (TS dispatcher).

There is NO --slug flag — the slug is derived from --out, whose basename must
match docs/specs/YYYY-MM-DD-<slug>-spec.md.

options:
  -h, --help              show this help message and exit
  --intent-brief BRIEF    Concrete intent the spec must satisfy (required).
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
 * Pin a model id into a built agent argv by replacing the value after the
 * model flag (`--model` for claude, `-m` for codex). The lib's
 * `buildLeadCmd`/`buildWingCmd` already emit a config-resolved model; this
 * swaps that value for the CLI override without duplicating the flag.
 */
function pinModel(cmd: AgentCommand, agent: WriteSpecAgent, model: string): AgentCommand {
  const flag = agent === "codex" ? "-m" : "--model";
  const args = [...cmd.args];
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) {
    args[idx + 1] = model;
  } else {
    args.push(flag, model);
  }
  return { cmd: cmd.cmd, args };
}

/** Resolve the lead argv (with optional model pin) for a run/dry-run. */
function resolveLeadCmd(a: CliArgs): AgentCommand {
  const base = buildLeadCmd(a.lead);
  return a.leadModel ? pinModel(base, a.lead, a.leadModel) : base;
}

/** Resolve the wing argv (with optional model pin) for a run/dry-run. */
function resolveWingCmd(a: CliArgs): AgentCommand {
  const cfg = getWriteSpecConfig();
  const base = buildWingCmd(a.wing, String(cfg.wing_reasoning_effort || "xhigh"));
  return a.wingModel ? pinModel(base, a.wing, a.wingModel) : base;
}

/**
 * Build custom dispatch+write deps ONLY when the CLI supplies model/timeout
 * overrides the lib's `RunWriteSpecOpts` cannot carry. Mirrors
 * `defaultWriteSpecDeps` (isolated agent env, run, codex/claude output parse,
 * fatal exit writer) with the resolved argv + timeouts substituted in. Returns
 * `undefined` when there is nothing to override, so `runWriteSpec` uses its own
 * defaults unchanged.
 */
function buildOverrideDeps(a: CliArgs): Partial<WriteSpecDeps> | undefined {
  if (!a.leadModel && !a.wingModel && a.timeout == null && a.wingTimeout == null) {
    return undefined;
  }
  const cfg = getWriteSpecConfig();
  const leadTimeout = a.timeout ?? (Number(cfg.timeout_s) || 900);
  const wingTimeout = a.wingTimeout ?? (Number(cfg.wing_timeout_s) || 600);
  const leadCmd = resolveLeadCmd(a);
  const wingCmd = resolveWingCmd(a);

  async function dispatch(
    agent: WriteSpecAgent,
    cmd: AgentCommand,
    prompt: string,
    timeoutSec: number,
  ): Promise<string> {
    const { env, tempDir } = await buildAgentEnv(agent, "local");
    try {
      const res = await run(cmd.cmd, cmd.args, { env, stdin: prompt, timeoutSec });
      if (res.notFound) {
        throw new Error(`write-spec: ${agent} CLI not found (${cmd.cmd})`);
      }
      if (res.code !== 0) {
        throw new Error(
          `write-spec: ${agent} exited ${res.code}: ${res.stderr.slice(0, 400)}`,
        );
      }
      return agent === "codex"
        ? parseCodexJsonl(res.stdout)
        : parseClaudeJson(res.stdout).text;
    } finally {
      releaseAgentTempDir(tempDir);
    }
  }

  return {
    loadContract: loadContractText,
    loadAgentPrompt: loadAgentPromptText,
    dispatchLead: ({ prompt }) => dispatch(a.lead, leadCmd, prompt, leadTimeout),
    dispatchWing: ({ prompt }) => dispatch(a.wing, wingCmd, prompt, wingTimeout),
    writeArtifacts: writeExitArtifacts,
  };
}

/**
 * Assemble the planned-dispatch object for `--dry-run`. Pure — resolves the
 * derived slug + the exact lead/wing argv WITHOUT dispatching or writing.
 */
function buildDryRunPlan(a: CliArgs) {
  const cfg = getWriteSpecConfig();
  const lead = resolveLeadCmd(a);
  const wing = resolveWingCmd(a);
  return {
    dry_run: true,
    slug: deriveSlugFromOut(a.out),
    out: a.out,
    lead_agent: a.lead,
    wing_agent: a.wing,
    lead_model: a.leadModel,
    wing_model: a.wingModel,
    max_rounds: a.maxRounds ?? (Number(cfg.max_rounds) || 3),
    lead_timeout_s: a.timeout ?? (Number(cfg.timeout_s) || 900),
    wing_timeout_s: a.wingTimeout ?? (Number(cfg.wing_timeout_s) || 600),
    lead_cmd: [lead.cmd, ...lead.args],
    wing_cmd: [wing.cmd, ...wing.args],
  };
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

  // ── Dry run: print the planned dispatch, exit 0, zero side effects ──────
  if (args.dryRun) {
    const plan = buildDryRunPlan(args);
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
    }
    return 0;
  }

  // ── Real run ────────────────────────────────────────────────────────────
  let receipt: WriteSpecReceipt;
  try {
    receipt = await runWriteSpec(
      {
        out: args.out,
        brief: args.intentBrief,
        leadAgent: args.lead,
        wingAgent: args.wing,
        maxRounds: args.maxRounds ?? undefined,
      },
      buildOverrideDeps(args),
    );
  } catch (err) {
    const envelope = {
      ok: false,
      slug,
      spec_path: args.out,
      error: { code: "dispatch_failed", message: (err as Error).message },
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return 1;
  }

  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  // Exit 0 iff the contract was satisfied; otherwise non-zero (the skill 5-1
  // captures the handled verdict without aborting).
  return receipt.ok ? 0 : 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`write_spec: unhandled: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
