/**
 * Persistent session state — TypeScript port of `scripts/session_state.py`.
 *
 * Sessions live at `~/.claude/code-review/sessions/{sanitized-id}.json`
 * and survive `/clear`. The store key is the session ID resolved via
 * `session_id_lib` (same precedence as the Python).
 *
 * `scripts/session_state.py` stays alongside this port — `scripts/
 * context_compactor.py` still imports `SessionState` as a Python class.
 * That gets deleted in the context_compactor port.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSessionId } from "./session_id_lib.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STARK_SESSIONS_DIR;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".claude", "code-review", "sessions");
}

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

export interface SessionState {
  session_id: string;
  started_at: string;
  branch: string;
  repo: string;
  tasks_completed: string[];
  last_checkpoint: string | null;
  context: Record<string, unknown>;
  name: string | null;
  start_head: string | null;
}

// ---------------------------------------------------------------------------
// ID sanitization (defends against path traversal)
// ---------------------------------------------------------------------------

const SAFE_ID_CHARS = /[^a-zA-Z0-9_-]/g;

export function sanitizeId(sessionId: string): string {
  return sessionId.replace(SAFE_ID_CHARS, "");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function gitBranch(): string {
  const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

function gitRepoUrl(): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return (result.stdout ?? "").trim();
}

/**
 * Normalize a remote URL to `owner/repo` for GitHub remotes; pass other
 * hosts through after trimming the trailing slash and `.git` suffix.
 * Matches Python's `_git_repo` (minus the subprocess piece).
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.replace(/\/+$/, "");
  if (u.endsWith(".git")) u = u.slice(0, -".git".length);
  for (const prefix of ["https://github.com/", "git@github.com:"]) {
    if (u.startsWith(prefix)) return u.slice(prefix.length);
  }
  return u;
}

function gitRepo(): string {
  return normalizeRepoUrl(gitRepoUrl());
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function statePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sanitizeId(sessionId)}.json`);
}

export function saveState(state: SessionState, sessionsDir?: string): void {
  const dir = sessionsDir ?? defaultSessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = statePath(dir, state.session_id);
  fs.writeFileSync(p, JSON.stringify(state, null, 2));
}

export function loadState(
  sessionId: string,
  sessionsDir?: string,
): SessionState | null {
  const dir = sessionsDir ?? defaultSessionsDir();
  const p = statePath(dir, sessionId);
  let text: string;
  try {
    text = fs.readFileSync(p, "utf8");
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
  const d = data as Record<string, unknown>;
  return {
    session_id:
      typeof d.session_id === "string" && d.session_id ? d.session_id : sessionId,
    started_at: typeof d.started_at === "string" ? d.started_at : "",
    branch: typeof d.branch === "string" ? d.branch : "",
    repo: typeof d.repo === "string" ? d.repo : "",
    tasks_completed: Array.isArray(d.tasks_completed)
      ? d.tasks_completed.map((x) => String(x))
      : [],
    last_checkpoint:
      typeof d.last_checkpoint === "string" ? d.last_checkpoint : null,
    context:
      typeof d.context === "object" && d.context !== null && !Array.isArray(d.context)
        ? (d.context as Record<string, unknown>)
        : {},
    name: typeof d.name === "string" ? d.name : null,
    start_head: typeof d.start_head === "string" ? d.start_head : null,
  };
}

// ---------------------------------------------------------------------------
// get_current equivalent — load existing or seed a new one from git state
// ---------------------------------------------------------------------------

export interface GetCurrentOpts {
  sessionId?: string;
  sessionsDir?: string;
  /** Override for tests; defaults to `new Date()`. */
  now?: () => Date;
  /** Override for tests; defaults to `gitBranch()`. */
  branch?: string;
  /** Override for tests; defaults to `gitRepo()`. */
  repo?: string;
}

export function getCurrent(opts: GetCurrentOpts = {}): SessionState {
  const sid = opts.sessionId ?? resolveSessionId();
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const existing = loadState(sid, dir);
  if (existing) return existing;
  const now = (opts.now ?? (() => new Date()))();
  return {
    session_id: sid,
    started_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    branch: opts.branch ?? gitBranch(),
    repo: opts.repo ?? gitRepo(),
    tasks_completed: [],
    last_checkpoint: null,
    context: {},
    name: null,
    start_head: null,
  };
}

// ---------------------------------------------------------------------------
// setField — used by /stark-session SKILL.md Phase 3 / Phase 6
// ---------------------------------------------------------------------------

export type SetFieldName = "name" | "start_head" | "last_checkpoint";

const SET_FIELD_NAMES: ReadonlySet<string> = new Set([
  "name",
  "start_head",
  "last_checkpoint",
]);

export interface SetFieldOpts {
  sessionId: string;
  field: SetFieldName;
  value: string;
  sessionsDir?: string;
  /** Seed values used only when there's no existing state file. */
  started_at?: string;
  branch?: string;
  repo?: string;
}

export function setField(opts: SetFieldOpts): SessionState {
  if (!SET_FIELD_NAMES.has(opts.field)) {
    throw new Error(`setField: unknown field '${opts.field}'`);
  }
  const dir = opts.sessionsDir ?? defaultSessionsDir();
  const existing = loadState(opts.sessionId, dir);
  const state: SessionState = existing ?? {
    session_id: opts.sessionId,
    started_at: opts.started_at ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    branch: opts.branch ?? gitBranch(),
    repo: opts.repo ?? gitRepo(),
    tasks_completed: [],
    last_checkpoint: null,
    context: {},
    name: null,
    start_head: null,
  };
  state[opts.field] = opts.value;
  saveState(state, dir);
  return state;
}
