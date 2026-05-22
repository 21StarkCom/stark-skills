// Token-savings benchmark for compressed/original file pairs.
//
// Usage:
//   node --experimental-strip-types benchmark.ts <original.md> <compressed.md>
//   node --experimental-strip-types benchmark.ts            (glob test fixtures)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.ts";

// No tokenizer dependency. The upstream Python used tiktoken when installed
// and fell back to a word count otherwise; this port keeps the word-count
// path only, so counts are a rough proxy, not exact model tokens.
function countTokens(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

type Row = [string, number, number, number, boolean];

function benchmarkPair(origPath: string, compPath: string): Row {
  const origTokens = countTokens(readFileSync(origPath, "utf8"));
  const compTokens = countTokens(readFileSync(compPath, "utf8"));
  const saved = origTokens > 0 ? (100 * (origTokens - compTokens)) / origTokens : 0;
  const result = validate(origPath, compPath);
  return [basename(compPath), origTokens, compTokens, saved, result.isValid];
}

function printTable(rows: Row[]): void {
  console.log("\n| File | Original | Compressed | Saved % | Valid |");
  console.log("|------|----------|------------|---------|-------|");
  for (const r of rows) {
    console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3].toFixed(1)}% | ${r[4] ? "✅" : "❌"} |`);
  }
}

function main(): void {
  const args = process.argv.slice(2);

  // Direct file pair.
  if (args.length === 2) {
    const orig = resolve(args[0]);
    const comp = resolve(args[1]);
    if (!existsSync(orig)) {
      console.log(`❌ Not found: ${orig}`);
      process.exit(1);
    }
    if (!existsSync(comp)) {
      console.log(`❌ Not found: ${comp}`);
      process.exit(1);
    }
    printTable([benchmarkPair(orig, comp)]);
    return;
  }

  // Glob mode: <plugin_root>/tests/caveman-compress/*.original.md
  // benchmark.ts lives at <plugin_root>/skills/caveman-compress/scripts/.
  const here = dirname(fileURLToPath(import.meta.url));
  const testsDir = join(here, "..", "..", "..", "tests", "caveman-compress");
  if (!existsSync(testsDir)) {
    console.log(`❌ Tests dir not found: ${testsDir}`);
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const entry of readdirSync(testsDir).sort()) {
    if (!entry.endsWith(".original.md")) continue;
    const orig = join(testsDir, entry);
    const comp = join(testsDir, entry.replace(/\.original\.md$/, ".md"));
    if (existsSync(comp)) rows.push(benchmarkPair(orig, comp));
  }

  if (rows.length === 0) {
    console.log("No compressed file pairs found.");
    return;
  }
  printTable(rows);
}

if (import.meta.main) {
  main();
}
