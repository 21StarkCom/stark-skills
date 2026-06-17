#!/usr/bin/env node
/**
 * self_healer CLI — TypeScript port of `scripts/self_healer.py`.
 *
 * Surface (preserved 1:1 from the Python):
 *
 *   self_healer.ts --pattern-id ID --stderr-file PATH \
 *                  [--mode suggest|auto] [--json]
 *
 * Consumed by:
 *   - `skill/stark-phase-execute/SKILL.md` (subprocess hop to this CLI).
 *
 * Reads `circuit_breaker_threshold` and `auto_patterns` from
 * `config.self_heal.*` in `~/.claude/code-review/config.json` (inline
 * loader — no `config_loader.py` dependency).
 */

import fs from "node:fs";

import { assetConfigPath } from "./asset_root_lib.ts";
import { runHeal, type HealMode } from "./self_healer_lib.ts";

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
// Inline config loader (just the self_heal section we care about)
// ---------------------------------------------------------------------------

interface SelfHealConfig {
  threshold: number;
  autoPatterns: string[];
}

function loadSelfHealConfig(): SelfHealConfig {
  const file = assetConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { threshold: 3, autoPatterns: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { threshold: 3, autoPatterns: [] };
  }
  if (typeof data !== "object" || data === null) {
    return { threshold: 3, autoPatterns: [] };
  }
  const section = (data as Record<string, unknown>).self_heal as
    | Record<string, unknown>
    | undefined;
  const threshold =
    typeof section?.circuit_breaker_threshold === "number"
      ? section.circuit_breaker_threshold
      : 3;
  const autoPatterns = Array.isArray(section?.auto_patterns)
    ? (section.auto_patterns as unknown[]).map((x) => String(x))
    : [];
  return { threshold, autoPatterns };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function emitResult(result: Record<string, unknown>, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    for (const [k, v] of Object.entries(result)) {
      process.stdout.write(`  ${k}: ${v}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP =
  "usage: self_healer.ts --pattern-id ID --stderr-file PATH " +
  "[--mode suggest|auto] [--json]\n";

function main(argv: string[]): number {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stderr.write(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const patternId = flagString(args, "pattern-id");
  const stderrFile = flagString(args, "stderr-file");
  const modeRaw = flagString(args, "mode") ?? "suggest";
  const asJson = flagBool(args, "json");

  if (!patternId || !stderrFile) {
    process.stderr.write("Error: --pattern-id and --stderr-file are required\n");
    return 2;
  }
  if (modeRaw !== "suggest" && modeRaw !== "auto") {
    process.stderr.write("Error: --mode must be 'suggest' or 'auto'\n");
    return 2;
  }

  const cfg = loadSelfHealConfig();
  const { exit, result } = runHeal({
    patternId,
    stderrFile,
    mode: modeRaw as HealMode,
    threshold: cfg.threshold,
    autoPatterns: cfg.autoPatterns,
  });

  if (exit !== 0 && result.error) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      process.stderr.write(`Error: ${result.error}\n`);
    }
    return exit;
  }

  emitResult(result, asJson);
  return exit;
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
    process.stderr.write(`self_healer: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
