#!/usr/bin/env node
/**
 * healer_canary CLI — TypeScript port of `scripts/healer_canary.py`
 * plus new subcommands.
 *
 * Surface:
 *
 *   healer_canary.ts [--status] [--json]
 *     List every pattern with mode/circuit/eligibility. Same JSON
 *     shape as the Python (consumed by `tools/stark_session_lib.ts`).
 *
 *   healer_canary.ts --promote PATTERN_ID [--json]
 *     Move a pattern from suggest-mode to auto-mode. Fails fast with
 *     explicit unmet criteria if the promotion gate isn't met.
 *
 *   healer_canary.ts --demote PATTERN_ID [--json]
 *     Move a pattern from auto-mode back to suggest-mode.
 *
 *   healer_canary.ts --check [--json]                          (NEW)
 *     Exits 0 if no auto-mode pattern has its circuit open, exits 2
 *     otherwise (and prints the offenders). Designed for oncall paging
 *     — "is the canary still healthy?"
 *
 *   healer_canary.ts --close-circuit PATTERN_ID [--json]       (NEW)
 *     Reset a tripped circuit. Clears `tripped_at` and
 *     `consecutive_failures`, stamps `last_reset_at`, preserves
 *     `ever_tripped` as historical record.
 *
 *   healer_canary.ts --explain PATTERN_ID [--json]             (NEW)
 *     Audit trail for a single pattern: every log entry, current
 *     circuit state, computed stats, mode, eligibility.
 */

import fs from "node:fs";

import {
  cmdCheck,
  cmdCloseCircuit,
  cmdDemote,
  cmdExplain,
  cmdPromote,
  cmdStatus,
} from "./healer_canary_lib.ts";

// ---------------------------------------------------------------------------
// Tiny argv parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags.set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else {
        flags.set(a.slice(2), true);
      }
    }
  }
  return { flags };
}

function flagString(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

// ---------------------------------------------------------------------------
// Output renderers (text / JSON)
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function renderStatusText(rows: ReturnType<typeof cmdStatus>): string {
  const lines: string[] = [];
  for (const row of rows.patterns) {
    const circuit = row.circuit === "open" ? "OPEN  " : "closed";
    const eligible = row.eligible_for_promotion ? " [eligible]" : "";
    const suggests = `${row.successful_suggests}/5 suggests`;
    lines.push(
      `  ${pad(row.id, 30)}  mode=${pad(row.mode, 7)}  circuit=${circuit}  ${suggests}  rate=${Math.round(row.success_rate * 100)}%${eligible}`,
    );
  }
  return lines.join("\n");
}

function renderCheckText(result: ReturnType<typeof cmdCheck>): string {
  if (result.ok) return `OK: ${result.checked} auto-mode pattern(s), all circuits closed.`;
  const lines: string[] = [
    `FAIL: ${result.tripped_auto_patterns.length} auto-mode pattern(s) have an open circuit:`,
  ];
  for (const id of result.tripped_auto_patterns) lines.push(`  - ${id}`);
  return lines.join("\n");
}

function renderExplainText(result: ReturnType<typeof cmdExplain>): string {
  if (!result.found) return `Pattern '${result.pattern_id}' not found in healer_patterns.json.`;
  const lines: string[] = [];
  lines.push(`Pattern:  ${result.pattern_id}`);
  lines.push(`Mode:     ${result.mode}`);
  const s = result.stats!;
  const circuit = s.circuit_open ? "OPEN" : "closed";
  lines.push(
    `Stats:    total=${s.total_attempts}  suggested=${s.successful_suggests}  applied=${s.applied}  aborts(7d)=${s.aborts_last_7d}  rate=${Math.round(s.success_rate * 100)}%`,
  );
  lines.push(
    `Circuit:  ${circuit}  consecutive_failures=${s.consecutive_failures}  ever_tripped=${s.ever_tripped}${s.tripped_at ? `  tripped_at=${s.tripped_at}` : ""}`,
  );
  if (result.mode === "suggest") {
    const eligible = result.eligible_for_promotion ? "yes" : "no";
    lines.push(`Eligible: ${eligible}`);
    if (result.promotion_blockers && result.promotion_blockers.length > 0) {
      lines.push("Blockers:");
      for (const b of result.promotion_blockers) lines.push(`  - ${b}`);
    }
  }
  lines.push("");
  lines.push(`Log entries (${result.entries.length}):`);
  for (const e of result.entries) {
    const tag = e.status ?? e.event ?? "(unknown)";
    lines.push(`  ${e.timestamp}  ${tag}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP = [
  "usage: healer_canary.ts <one of:>",
  "  --status [--json]",
  "  --promote PATTERN_ID [--json]",
  "  --demote PATTERN_ID [--json]",
  "  --check [--json]                 (oncall: nonzero if auto circuit open)",
  "  --close-circuit PATTERN_ID [--json]",
  "  --explain PATTERN_ID [--json]",
  "",
].join("\n");

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const asJson = flagBool(args, "json");

  const promote = flagString(args, "promote");
  const demote = flagString(args, "demote");
  const closeCircuit = flagString(args, "close-circuit");
  const explain = flagString(args, "explain");
  const check = flagBool(args, "check");

  if (promote) {
    const result = cmdPromote(promote, {});
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok && result.already_present) {
      process.stdout.write(`Pattern '${promote}' is already in auto_patterns\n`);
    } else if (result.ok) {
      process.stdout.write(`Promoted '${promote}' to auto-mode.\n`);
    } else {
      process.stderr.write(`Cannot promote '${promote}' — criteria not met:\n`);
      for (const r of result.reasons ?? []) process.stderr.write(`  - ${r}\n`);
      return 1;
    }
    return 0;
  }

  if (demote) {
    const result = cmdDemote(demote, {});
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.not_present) {
      process.stdout.write(`Pattern '${demote}' is not in auto_patterns\n`);
    } else {
      process.stdout.write(`Demoted '${demote}' to suggest-mode.\n`);
    }
    return 0;
  }

  if (closeCircuit) {
    const result = cmdCloseCircuit(closeCircuit, {});
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.no_op) {
      process.stdout.write(`Pattern '${closeCircuit}' circuit was already closed.\n`);
    } else {
      process.stdout.write(`Closed circuit for '${closeCircuit}'.\n`);
    }
    return 0;
  }

  if (explain) {
    const result = cmdExplain(explain, {});
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.found ? 0 : 1;
    }
    process.stdout.write(`${renderExplainText(result)}\n`);
    return result.found ? 0 : 1;
  }

  if (check) {
    const result = cmdCheck({});
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stdout.write(`${renderCheckText(result)}\n`);
    }
    // Non-zero exit when an auto-mode circuit is open — for oncall paging.
    return result.ok ? 0 : 2;
  }

  // Default: status
  const result = cmdStatus({});
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ patterns: result.patterns })}\n`);
  } else {
    process.stdout.write(`${renderStatusText(result)}\n`);
  }
  return 0;
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
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`healer_canary: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
