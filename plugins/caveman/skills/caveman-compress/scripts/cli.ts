// Caveman Compress CLI.
//
// Usage:
//   node --experimental-strip-types cli.ts <filepath>

import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { compressFile } from "./compress.ts";
import { detectFileType, shouldCompress } from "./detect.ts";

function printUsage(): void {
  console.log("Usage: caveman-compress <filepath>");
}

const args = process.argv.slice(2);
if (args.length !== 1) {
  printUsage();
  process.exit(1);
}

const inputPath = args[0];

if (!existsSync(inputPath)) {
  console.log(`❌ File not found: ${inputPath}`);
  process.exit(1);
}
if (!statSync(inputPath).isFile()) {
  console.log(`❌ Not a file: ${inputPath}`);
  process.exit(1);
}

const filepath = resolve(inputPath);

const fileType = detectFileType(filepath);
console.log(`Detected: ${fileType}`);

if (!shouldCompress(filepath)) {
  console.log("Skipping: file is not natural language (code/config)");
  process.exit(0);
}

console.log("Starting caveman compression...\n");

try {
  const success = await compressFile(filepath);

  if (success) {
    console.log("\nCompression completed successfully");
    const backupPath = join(
      dirname(filepath),
      `${basename(filepath, extname(filepath))}.original.md`,
    );
    console.log(`Compressed: ${filepath}`);
    console.log(`Original:   ${backupPath}`);
    process.exit(0);
  }

  console.log("\n❌ Compression failed after retries");
  process.exit(2);
} catch (e) {
  console.log(`\n❌ Error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
