// Verify that a compressed file preserved everything that must not change:
// headings, code blocks, URLs, paths, bullet structure, inline code.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const URL_REGEX = /https?:\/\/[^\s)]+/g;
const FENCE_OPEN_REGEX = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING_REGEX = /^(#{1,6})\s+(.*)/gm;
const BULLET_REGEX = /^\s*[-*+]\s+/gm;

// Crude but effective path detection. Requires either a path prefix
// (./ ../ / or drive letter) or a slash/backslash within the match.
const PATH_REGEX = /(?:\.\/|\.\.\/|\/|[A-Za-z]:\\)[\w\-/\\.]+|[\w\-.]+[/\\][\w\-/\\.]+/g;

export class ValidationResult {
  isValid = true;
  errors: string[] = [];
  warnings: string[] = [];

  addError(msg: string): void {
    this.isValid = false;
    this.errors.push(msg);
  }

  addWarning(msg: string): void {
    this.warnings.push(msg);
  }
}

// ---------- Extractors ----------

function extractHeadings(text: string): Array<[string, string]> {
  return [...text.matchAll(HEADING_REGEX)].map(
    (m) => [m[1], m[2].trim()] as [string, string],
  );
}

// Line-based fenced code block extractor. Handles ``` and ~~~ fences with
// variable length (CommonMark: closing fence must use the same char and be
// at least as long as the opening). Supports nested fences.
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const lines = text.split("\n");
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const m = lines[i].match(FENCE_OPEN_REGEX);
    if (!m) {
      i++;
      continue;
    }
    const fenceChar = m[2][0];
    const fenceLen = m[2].length;
    const blockLines = [lines[i]];
    i++;
    let closed = false;
    while (i < n) {
      const closeM = lines[i].match(FENCE_OPEN_REGEX);
      if (
        closeM &&
        closeM[2][0] === fenceChar &&
        closeM[2].length >= fenceLen &&
        closeM[3].trim() === ""
      ) {
        blockLines.push(lines[i]);
        closed = true;
        i++;
        break;
      }
      blockLines.push(lines[i]);
      i++;
    }
    if (closed) blocks.push(blockLines.join("\n"));
    // Unclosed fences are silently skipped — they indicate malformed markdown
    // and including them would cause false-positive validation failures.
  }
  return blocks;
}

function extractUrls(text: string): Set<string> {
  return new Set([...text.matchAll(URL_REGEX)].map((m) => m[0]));
}

function extractPaths(text: string): Set<string> {
  return new Set([...text.matchAll(PATH_REGEX)].map((m) => m[0]));
}

function countBullets(text: string): number {
  return [...text.matchAll(BULLET_REGEX)].length;
}

function extractInlineCodes(text: string): string[] {
  let t = text.replace(/^```[\s\S]*?^```/gm, "");
  t = t.replace(/^~~~[\s\S]*?^~~~/gm, "");
  return [...t.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

function counter(items: string[]): Map<string, number> {
  const c = new Map<string, number>();
  for (const item of items) c.set(item, (c.get(item) ?? 0) + 1);
  return c;
}

function setDiff(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => !b.has(x));
}

// ---------- Validators ----------

function validateHeadings(orig: string, comp: string, result: ValidationResult): void {
  const h1 = extractHeadings(orig);
  const h2 = extractHeadings(comp);
  if (h1.length !== h2.length) {
    result.addError(`Heading count mismatch: ${h1.length} vs ${h2.length}`);
  }
  if (JSON.stringify(h1) !== JSON.stringify(h2)) {
    result.addWarning("Heading text/order changed");
  }
}

function validateCodeBlocks(orig: string, comp: string, result: ValidationResult): void {
  const c1 = extractCodeBlocks(orig);
  const c2 = extractCodeBlocks(comp);
  if (JSON.stringify(c1) !== JSON.stringify(c2)) {
    result.addError("Code blocks not preserved exactly");
  }
}

function validateUrls(orig: string, comp: string, result: ValidationResult): void {
  const u1 = extractUrls(orig);
  const u2 = extractUrls(comp);
  if (JSON.stringify([...u1].sort()) !== JSON.stringify([...u2].sort())) {
    result.addError(
      `URL mismatch: lost=${JSON.stringify(setDiff(u1, u2))}, added=${JSON.stringify(setDiff(u2, u1))}`,
    );
  }
}

function validatePaths(orig: string, comp: string, result: ValidationResult): void {
  const p1 = extractPaths(orig);
  const p2 = extractPaths(comp);
  if (JSON.stringify([...p1].sort()) !== JSON.stringify([...p2].sort())) {
    result.addWarning(
      `Path mismatch: lost=${JSON.stringify(setDiff(p1, p2))}, added=${JSON.stringify(setDiff(p2, p1))}`,
    );
  }
}

function validateBullets(orig: string, comp: string, result: ValidationResult): void {
  const b1 = countBullets(orig);
  const b2 = countBullets(comp);
  if (b1 === 0) return;
  const diff = Math.abs(b1 - b2) / b1;
  if (diff > 0.15) {
    result.addWarning(`Bullet count changed too much: ${b1} -> ${b2}`);
  }
}

function validateInlineCodes(orig: string, comp: string, result: ValidationResult): void {
  const c1 = counter(extractInlineCodes(orig));
  const c2 = counter(extractInlineCodes(comp));

  let identical = c1.size === c2.size;
  if (identical) {
    for (const [code, count] of c1) {
      if (c2.get(code) !== count) {
        identical = false;
        break;
      }
    }
  }
  if (identical) return;

  const lost = new Set<string>(setDiff(new Set(c1.keys()), new Set(c2.keys())));
  const added = setDiff(new Set(c2.keys()), new Set(c1.keys()));
  for (const [code, count] of c1) {
    const seen = c2.get(code);
    if (seen !== undefined && seen < count) {
      lost.add(`${code} (lost ${count - seen} of ${count} occurrences)`);
    }
  }
  if (lost.size > 0) {
    result.addError(`Inline code lost: ${JSON.stringify([...lost])}`);
  }
  if (added.length > 0) {
    result.addWarning(`Inline code added: ${JSON.stringify(added)}`);
  }
}

// ---------- Main ----------

export function validate(originalPath: string, compressedPath: string): ValidationResult {
  const result = new ValidationResult();
  const orig = readFileSync(originalPath, "utf8");
  const comp = readFileSync(compressedPath, "utf8");

  validateHeadings(orig, comp, result);
  validateCodeBlocks(orig, comp, result);
  validateUrls(orig, comp, result);
  validatePaths(orig, comp, result);
  validateBullets(orig, comp, result);
  validateInlineCodes(orig, comp, result);

  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.log("Usage: node --experimental-strip-types validate.ts <original> <compressed>");
    process.exit(1);
  }
  const res = validate(resolve(args[0]), resolve(args[1]));
  console.log(`\nValid: ${res.isValid}`);
  if (res.errors.length > 0) {
    console.log("\nErrors:");
    for (const e of res.errors) console.log(`  - ${e}`);
  }
  if (res.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const w of res.warnings) console.log(`  - ${w}`);
  }
}
