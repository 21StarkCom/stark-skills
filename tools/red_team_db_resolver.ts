/**
 * TS-native canonical audit DB resolver.
 *
 * Port of `scripts/red_team_audit_cli.py::resolve_db` so the TS
 * dispatcher + CLIs no longer need to shell out to Python for the
 * `--db` / env / config / default precedence chain. Returns the
 * canonicalized path (`fs.realpathSync(path.resolve(expand(...)))`)
 * so symlinks + relative paths produce byte-equal outputs for the
 * same input across language bindings.
 *
 * Precedence (highest wins):
 *   1. `cliDb` argument (the `--db PATH` the caller passed).
 *   2. `STARK_RED_TEAM_DB` environment variable.
 *   3. `red_team.audit.db_path` in the shipped config (resolved through the
 *      layout-robust asset seam — see `assetConfigPath()`).
 *   4. Hard-coded `DEFAULT_DB_PATH`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assetConfigPath } from "./asset_root_lib.ts";

const ENV_DB_OVERRIDE = "STARK_RED_TEAM_DB";
const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  ".claude",
  "code-review",
  "history",
  "forged-review",
  "forged_review_metrics.db",
);

export interface ResolvedDb {
  db_path: string;
  source: "cli" | "env" | "config" | "default";
}

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function canonicalize(p: string): string {
  const expanded = expandHome(p);
  const resolved = path.resolve(expanded);
  // Match Python `Path.resolve()` (default `strict=False`): walk parent
  // symlinks even when the leaf path doesn't exist. node's realpathSync
  // throws on missing paths, so we walk upward to find the nearest
  // existing parent, realpath that, then re-append the missing tail.
  // The macOS-specific manifestation: `/tmp` is a symlink to
  // `/private/tmp`, so `/tmp/audit.db` → `/private/tmp/audit.db`
  // under Python but `/tmp/audit.db` under naive node realpath.
  try {
    return fs.realpathSync(resolved);
  } catch {
    /* leaf missing — walk upward */
  }
  const segments: string[] = [];
  let cursor = resolved;
  while (true) {
    try {
      const realParent = fs.realpathSync(cursor);
      return segments.length === 0
        ? realParent
        : path.join(realParent, ...segments.reverse());
    } catch {
      const next = path.dirname(cursor);
      if (next === cursor) return resolved; // hit /, give up
      segments.push(path.basename(cursor));
      cursor = next;
    }
  }
}

function loadConfigDbOverride(): string | null {
  const cfgPath = assetConfigPath();
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rt = parsed.red_team;
    if (!rt || typeof rt !== "object" || Array.isArray(rt)) return null;
    const audit = (rt as Record<string, unknown>).audit;
    if (!audit || typeof audit !== "object" || Array.isArray(audit)) return null;
    const dbPath = (audit as Record<string, unknown>).db_path;
    if (typeof dbPath === "string" && dbPath.length > 0) return dbPath;
    return null;
  } catch {
    return null;
  }
}

export function resolveDb(
  cliDb: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDb {
  if (cliDb !== null && cliDb !== undefined && cliDb !== "") {
    return { db_path: canonicalize(cliDb), source: "cli" };
  }
  const envValue = env[ENV_DB_OVERRIDE];
  if (envValue) {
    return { db_path: canonicalize(envValue), source: "env" };
  }
  const cfgValue = loadConfigDbOverride();
  if (cfgValue) {
    return { db_path: canonicalize(cfgValue), source: "config" };
  }
  return { db_path: canonicalize(DEFAULT_DB_PATH), source: "default" };
}

export { DEFAULT_DB_PATH, ENV_DB_OVERRIDE };
