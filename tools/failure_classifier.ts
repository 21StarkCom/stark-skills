#!/usr/bin/env node
/**
 * failure_classifier CLI — classify stderr output into canonical failure
 * categories. TypeScript port of `scripts/failure_classifier.py`.
 *
 * Usage:
 *   node --experimental-strip-types failure_classifier.ts --stderr-file PATH [--json]
 */

import fs from "node:fs";
import { classify, logResult } from "./failure_classifier_lib.ts";

const HELP = `Classify failure stderr into canonical categories.

Usage: failure_classifier.ts --stderr-file PATH [--json]

Options:
  --stderr-file PATH   Path to stderr file (required)
  --json               Output result as JSON (default: human-readable)
  --help               Show this help
`;

function main(argv: string[]): number {
  let stderrFile: string | undefined;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP);
      return 0;
    } else if (arg === "--json") {
      asJson = true;
    } else if (arg === "--stderr-file") {
      stderrFile = argv[++i];
    } else if (arg.startsWith("--stderr-file=")) {
      stderrFile = arg.slice("--stderr-file=".length);
    } else {
      process.stderr.write(`Error: unknown argument: ${arg}\n`);
      return 2;
    }
  }

  if (!stderrFile) {
    process.stderr.write("Error: --stderr-file is required\n");
    return 2;
  }

  if (!fs.existsSync(stderrFile)) {
    process.stderr.write(`Error: stderr file not found: ${stderrFile}\n`);
    return 1;
  }

  const stderrContent = fs.readFileSync(stderrFile, "utf8");
  const stderrExcerpt = stderrContent.slice(0, 500);

  const result = classify(stderrContent);
  result.stderr_excerpt = stderrExcerpt;

  logResult(result, stderrFile);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Category:           ${result.category}\n`);
    process.stdout.write(`Confidence:         ${result.confidence}\n`);
    process.stdout.write(`Pattern ID:         ${result.pattern_id}\n`);
    process.stdout.write(`Recommended action: ${result.recommended_action}\n`);
    if (result.stderr_excerpt) {
      process.stdout.write(`Stderr excerpt:\n${result.stderr_excerpt}\n`);
    }
  }
  return 0;
}

function isMain(): boolean {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    return fs.realpathSync(argv1) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main(process.argv.slice(2)));
}
