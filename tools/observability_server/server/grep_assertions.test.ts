// Static grep assertions required by plan §Phase 4 Verification.
//
// Restricted to repository TypeScript + shell sources so the plan +
// design docs themselves don't trip the forbidden-substring checks.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== ".github") continue;
    if (
      ent.name === "node_modules" ||
      ent.name === "dist" ||
      ent.name === "build"
    ) {
      continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (
        ext === ".ts" ||
        ext === ".tsx" ||
        ext === ".js" ||
        ext === ".mjs" ||
        ext === ".sh"
      ) {
        out.push(full);
      }
    }
  }
}

test("no source file mentions --print-token (helper never echoes tokens)", () => {
  const candidates: string[] = [];
  for (const sub of [
    "tools",
    "scripts",
    "skill",
    "tools/observability_server",
  ]) {
    walk(path.join(REPO_ROOT, sub), candidates);
  }
  const selfPath = path.resolve(import.meta.dirname, "grep_assertions.test.ts");
  const offenders: string[] = [];
  for (const file of candidates) {
    if (file === selfPath) continue;
    const content = fs.readFileSync(file, "utf8");
    if (content.includes("--print-token") || content.includes("printToken")) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("liveness.ts has no SQLite-native clock function call", () => {
  const file = path.resolve(import.meta.dirname, "liveness.ts");
  const content = fs.readFileSync(file, "utf8");
  for (const sql of extractSqlBlocks(content)) {
    assert.ok(
      !sql.includes("strftime"),
      `liveness.ts SQL uses strftime: ${sql}`,
    );
    assert.ok(
      !sql.includes("datetime('now"),
      `liveness.ts SQL uses datetime('now',...): ${sql}`,
    );
  }
});

test("no SQL anywhere binds ended_at via strftime/datetime('now')", () => {
  const candidates: string[] = [];
  walk(path.join(REPO_ROOT, "tools", "observability_server"), candidates);
  for (const file of candidates) {
    if (file.endsWith(".test.ts")) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const sql of extractSqlBlocks(content)) {
      assert.ok(
        !/ended_at\s*=\s*strftime/i.test(sql),
        `${file}: ended_at assignment uses strftime`,
      );
      assert.ok(
        !/strftime[^;]*ended_at/i.test(sql),
        `${file}: strftime expression near ended_at`,
      );
      assert.ok(
        !/ended_at\s*=\s*datetime\('now/i.test(sql),
        `${file}: ended_at uses datetime('now',...)`,
      );
    }
  }
});

function extractSqlBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (const match of content.matchAll(/`([\s\S]*?)`/g)) {
    const body = match[1] ?? "";
    if (/\b(SELECT|UPDATE|INSERT|DELETE|CREATE)\b/i.test(body)) {
      blocks.push(body);
    }
  }
  return blocks;
}
