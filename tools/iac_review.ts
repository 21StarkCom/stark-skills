#!/usr/bin/env -S node --experimental-strip-types
/**
 * iac_review — CLI for multi-agent Terraform / Terragrunt review.
 *
 * Dispatches the review across one or more configured LLM agents (each its own
 * headless subagent) and merges the findings. Backs /stark-terraform-review and
 * /stark-terragrunt-review.
 *
 * Usage:
 *   iac_review.ts --kind terraform|terragrunt [path] [options]
 *
 * Options:
 *   --agents a,b         agents to run (claude,codex,gemini). Overrides config.
 *                        Default: config `iac_review.agents`, else "codex".
 *   --changed            review only HCL changed vs the merge-base / working tree
 *   --no-tools           skip host scanners (review by reading only)
 *   --allow-agent-dispatch
 *                        REQUIRED for a real model dispatch; acknowledges that
 *                        selected file contents are sent to the configured CLIs
 *   --include-tfvars     Terraform only; separately acknowledge inclusion of
 *                        .tfvars, which are excluded because they may be secret
 *   --trust-source       REQUIRED before installed scanners/provider tools may
 *                        inspect or evaluate source; otherwise use --no-tools
 *   --min-severity S     drop findings below S (critical|high|medium|low)
 *   --pr N --repo O/R    post findings to PR N (authored by the first agent's App)
 *   --timeout SEC        per-agent timeout (default from config)
 *   --dry-run            preview resolved agents + selected files; run no
 *                        scanners and dispatch nothing (no consent flags needed)
 *   --json               print the receipt as JSON instead of the markdown report
 *   --help               show this help
 *
 * Examples:
 *   # Safe preview before consent (no scanners, no model dispatch):
 *   iac_review.ts --kind terraform infra/ --agents gemini,codex --dry-run --no-tools --json
 *   # Real review after model-dispatch consent, with scanners disabled:
 *   iac_review.ts --kind terraform infra/ --agents gemini,codex --allow-agent-dispatch --no-tools
 *   # Add only after separate source-execution and tfvars consent:
 *   iac_review.ts --kind terraform infra/ --allow-agent-dispatch --trust-source --include-tfvars
 *   # Terragrunt real review after dispatch consent; no HCL evaluation:
 *   iac_review.ts --kind terragrunt live/ --changed --allow-agent-dispatch --no-tools
 */
import {
  runIacReview,
  renderReport,
  type Kind,
  type Severity,
} from "./iac_review_lib.ts";

const SEVERITIES = new Set<Severity>(["critical", "high", "medium", "low"]);
function isSeverity(v: string): v is Severity {
  return SEVERITIES.has(v as Severity);
}

function parseArgs(argv: string[]): {
  kind: Kind | null;
  target: string;
  agents: string[] | null;
  changed: boolean;
  noTools: boolean;
  allowAgentDispatch: boolean;
  includeTfvars: boolean;
  trustSource: boolean;
  minSeverity: Severity | null;
  pr: number | null;
  repo: string | null;
  timeout: number | null;
  dryRun: boolean;
  json: boolean;
  help: boolean;
} {
  const o = {
    kind: null as Kind | null,
    target: ".",
    agents: null as string[] | null,
    changed: false,
    noTools: false,
    allowAgentDispatch: false,
    includeTfvars: false,
    trustSource: false,
    minSeverity: null as Severity | null,
    pr: null as number | null,
    repo: null as string | null,
    timeout: null as number | null,
    dryRun: false,
    json: false,
    help: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--help": case "-h": o.help = true; break;
      case "--kind": o.kind = next() as Kind; break;
      case "--agents": o.agents = String(next() ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--changed": o.changed = true; break;
      case "--no-tools": o.noTools = true; break;
      case "--allow-agent-dispatch": o.allowAgentDispatch = true; break;
      case "--include-tfvars": o.includeTfvars = true; break;
      case "--trust-source": o.trustSource = true; break;
      case "--min-severity": {
        const v = String(next() ?? "").toLowerCase();
        if (!isSeverity(v)) throw new Error(`--min-severity must be one of critical|high|medium|low (got '${v}')`);
        o.minSeverity = v;
        break;
      }
      case "--pr": o.pr = Number(next()); break;
      case "--repo": o.repo = next() ?? null; break;
      case "--timeout": o.timeout = Number(next()); break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`unknown flag: ${a}`);
        positionals.push(a);
    }
  }
  if (positionals.length > 0) o.target = positionals[0];
  return o;
}

const HELP = `iac_review — multi-agent Terraform/Terragrunt review

Usage: iac_review.ts --kind terraform|terragrunt [path] [options]

  --agents a,b       agents to run (claude,codex,gemini); overrides config
  --changed          review only changed HCL (git)
  --no-tools         skip host scanners
  --allow-agent-dispatch
                     REQUIRED for model dispatch; acknowledges sending selected
                     file contents to the configured model CLIs
  --include-tfvars   Terraform only; separately acknowledge inclusion of .tfvars,
                     which are excluded by default because they may contain secrets
  --trust-source     REQUIRED before scanners/provider tools may inspect or evaluate
                     source; otherwise use --no-tools
  --min-severity S   critical|high|medium|low floor
  --pr N --repo O/R  post findings to PR N
  --timeout SEC      per-agent timeout
  --dry-run          preview resolved agents + selected files; run no scanners and
                     dispatch nothing (no consent flags required)
  --json             print receipt JSON
  --help             this help

Consent-safe examples:
  # Preview first; no file content leaves the machine.
  iac_review.ts --kind terraform infra/ --agents gemini,codex --dry-run --no-tools --json
  # After dispatch consent; scanners remain disabled.
  iac_review.ts --kind terraform infra/ --agents gemini,codex --allow-agent-dispatch --no-tools
  # Only after separate scanner and .tfvars consent.
  iac_review.ts --kind terraform infra/ --allow-agent-dispatch --trust-source --include-tfvars
  # Terragrunt without evaluating repository-controlled HCL.
  iac_review.ts --kind terragrunt live/ --changed --allow-agent-dispatch --no-tools
`;

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(1);
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return;
  }
  if (opts.kind !== "terraform" && opts.kind !== "terragrunt") {
    process.stderr.write(`--kind must be 'terraform' or 'terragrunt'\n\n${HELP}`);
    process.exit(1);
  }
  if (opts.pr && !opts.repo) {
    process.stderr.write("--pr requires --repo OWNER/NAME\n");
    process.exit(1);
  }

  const receipt = await runIacReview({
    kind: opts.kind,
    target: opts.target,
    agents: opts.agents,
    changed: opts.changed,
    noTools: opts.noTools,
    allowAgentDispatch: opts.allowAgentDispatch,
    includeTfvars: opts.includeTfvars,
    trustSource: opts.trustSource,
    minSeverity: opts.minSeverity ?? undefined,
    pr: opts.pr,
    repo: opts.repo,
    timeoutSec: opts.timeout ?? undefined,
    dryRun: opts.dryRun,
    log: (m) => process.stderr.write(`[iac-review] ${m}\n`),
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(receipt) + "\n");
  }

  // sec-003: a review where every agent failed is INCONCLUSIVE, not clean —
  // don't let it fail open with a green exit. Exit 3 so a gate can't mistake
  // total dispatch failure for "no findings".
  if (!receipt.dry_run && receipt.agents.length > 0) {
    const succeeded = receipt.agent_runs.filter((r) => r.ok).length;
    if (succeeded === 0) {
      const errs = receipt.agent_runs.map((r) => `${r.agent}:${r.error}`).join(", ");
      process.stderr.write(`INCONCLUSIVE: all ${receipt.agents.length} agent(s) failed (${errs}) — no review was produced\n`);
      process.exit(3);
    }
  }

  // Non-zero exit when critical/high findings remain (useful as a gate).
  const blocking = receipt.findings.some((f) => f.severity === "critical" || f.severity === "high");
  process.exit(blocking ? 2 : 0);
}

main().catch((err) => {
  process.stderr.write(`iac_review fatal: ${(err as Error).stack || err}\n`);
  process.exit(1);
});
