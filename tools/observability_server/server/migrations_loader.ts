/**
 * Migration file discovery. Pure fs reads, no DB driver — so tests can
 * walk file ordering and parsing without needing the native
 * better-sqlite3 binding compiled on the host. The actual runMigrations
 * function (in db.ts) wraps this with the BEGIN/COMMIT-per-file logic.
 */

import fs from "node:fs";
import path from "node:path";

export interface MigrationFile {
  version: number;
  fileName: string;
  sql: string;
}

const FILENAME_RE = /^(\d+)_[A-Za-z0-9_]+\.sql$/;

export function loadMigrations(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs
    .readdirSync(dir)
    .filter((name) => FILENAME_RE.test(name))
    .sort();
  return entries.map((name) => {
    const m = name.match(FILENAME_RE)!;
    const version = Number(m[1]);
    const sql = fs.readFileSync(path.join(dir, name), "utf8");
    return { version, fileName: name, sql };
  });
}
