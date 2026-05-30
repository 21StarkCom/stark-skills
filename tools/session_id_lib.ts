/**
 * Session ID resolver — TypeScript port of `scripts/session_id.py`.
 *
 * Resolution order:
 *   1. CLAUDE_SESSION_ID env var (trimmed; blank falls through)
 *   2. ~/.claude/projects/ marker files (newest-mtime JSON with a
 *      non-empty `session_id` string key)
 *   3. uuid4 fallback
 *
 * Also exports the standalone `resolveFromCheckpoint(path)` reader for
 * one-shot checkpoint reads (used by external callers that want a
 * specific file rather than the scan).
 *
 * Designed to be the single source of truth for session ID resolution
 * across the TS tools.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

interface FileEntry {
  path: string;
  mtimeMs: number;
}

/** Recursive *.json scanner matching Python's `Path.rglob("*.json")` order. */
function rglobJson(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...rglobJson(full));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        const stat = fs.statSync(full);
        out.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch {
        // Race with deletion; skip silently to match Python's try/except.
      }
    }
  }
  return out;
}

/**
 * Read a single checkpoint file and return its `session_id` value, or
 * null if missing/malformed/empty. Matches the Python helper of the
 * same name.
 */
export function resolveFromCheckpoint(checkpointPath: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(checkpointPath, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const sid = (data as Record<string, unknown>).session_id;
  if (typeof sid !== "string") return null;
  const trimmed = sid.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Scan a projects directory for a session_id marker. Returns the
 * newest-mtime non-empty value, or null. Matches Python's
 * `_resolve_from_projects_dir` semantics — including the lenient
 * "skip and continue" behavior for malformed JSON / non-dict roots /
 * empty values.
 */
export function resolveFromProjectsDir(projectsDir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(projectsDir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const entries = rglobJson(projectsDir);
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of entries) {
    let text: string;
    try {
      text = fs.readFileSync(entry.path, "utf8");
    } catch {
      continue;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      continue;
    }
    const sid = (data as Record<string, unknown>).session_id;
    if (typeof sid !== "string") continue;
    const trimmed = sid.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

export interface ResolveSessionIdOpts {
  env?: NodeJS.ProcessEnv;
  projectsDir?: string;
}

/**
 * Authoritative session ID resolver. Three-tier precedence; never
 * throws; always returns a non-empty string.
 *
 * Unlike the Python original, results are NOT memoized at the module
 * level — the projects-dir scan is cheap on cold caches and the env
 * var is the dominant fast path in practice. Callers wanting
 * per-process caching should wrap with their own memo.
 */
export function resolveSessionId(opts: ResolveSessionIdOpts = {}): string {
  const env = opts.env ?? process.env;
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();

  const envVal = (env.CLAUDE_SESSION_ID ?? "").trim();
  if (envVal.length > 0) return envVal;

  const fromMarkers = resolveFromProjectsDir(projectsDir);
  if (fromMarkers) return fromMarkers;

  return randomUUID();
}
