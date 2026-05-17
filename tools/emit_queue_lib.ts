/**
 * TS-native emit-queue (subset).
 *
 * Port of the red-team-relevant `scripts/emit_queue.py` surface
 * (`make_event` + `enqueue` + schema init) so the TS dispatcher and the
 * TS backfill CLI can write to the same `~/.stark-insights/queue.db`
 * SQLite without shelling out to Python.
 *
 * Only the **enqueue + make_event** subset is ported. The HTTP drain,
 * dead-letter retry, and other op-side functions stay in Python (they
 * run from CLI jobs that are not red-team-specific). Both implementations
 * write to the same DB shape, so a Python drain still processes events
 * enqueued by TS and vice versa.
 *
 * The schema is created idempotently on first write. Subsequent
 * inserts hit a cached "this DB has been initialized" record so we
 * don't re-run DDL on every event.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID_TYPES: ReadonlySet<string> = new Set([
  // Subset relevant to the red-team subsystem (matches the entries in
  // emit_queue.py::_VALID_TYPES). If TS callers ever start emitting
  // event types outside this list, the validate() check below will
  // refuse and we'll fail loud.
  "red_team_run",
  "red_team_finding",
  "red_team_fix_plan",
  "red_team_call_start",
  "red_team_call_end",
  "red_team_override_rejected",
]);

const VALID_CLIS: ReadonlySet<string> = new Set(["claude", "codex", "gemini"]);
const VALID_SOURCES: ReadonlySet<string> = new Set(["skill", "hook", "subagent"]);

const REQUIRED_FIELDS: readonly string[] = [
  "type", "timestamp", "cli", "source", "schema_version", "payload",
];

// Mirror of emit_queue.py::_REDACT_PATTERNS — applied to the serialized
// event JSON before storage. Keep in lockstep with the Python regex set.
const REDACT_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]"],
  [/ghp_[A-Za-z0-9]{10,}/g, "ghp_[REDACTED]"],
  [/ghs_[A-Za-z0-9]{10,}/g, "ghs_[REDACTED]"],
  [/[A-Za-z0-9+/]{41,}={0,2}/g, "[BASE64-REDACTED]"],
];

function redact(text: string): string {
  let out = text;
  for (const [pat, repl] of REDACT_PATTERNS) out = out.replace(pat, repl);
  return out;
}

export function queueDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STARK_QUEUE_DIR ?? path.join(os.homedir(), ".stark-insights");
}

export function queueDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(queueDir(env), "queue.db");
}

function resolveSessionId(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.CLAUDE_SESSION_ID ?? "").trim();
  if (explicit) return explicit;
  // Skip the projects-dir resolution path (Python's _resolve_from_projects_dir).
  // uuid4 fallback matches Python's final branch.
  return randomUUID();
}

const SCHEMA_SQL = `\
CREATE TABLE IF NOT EXISTS pending (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key  TEXT UNIQUE,
    event_json  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    retries     INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT
);
CREATE TABLE IF NOT EXISTS dead_letter (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    dedupe_key  TEXT,
    event_json  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    retries     INTEGER NOT NULL,
    last_error  TEXT,
    source_path TEXT NOT NULL DEFAULT 'http'
);
CREATE INDEX IF NOT EXISTS idx_pending_created ON pending(created_at);
CREATE TABLE IF NOT EXISTS inflight (
    tool_use_id TEXT PRIMARY KEY,
    tool_name   TEXT NOT NULL,
    started_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS session_stats (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

const _initialized: Map<string, number> = new Map();

function dbInodeOrZero(dbPath: string): number {
  try {
    return fs.statSync(dbPath).ino;
  } catch {
    return 0;
  }
}

function openQueueDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  const cachedIno = _initialized.get(dbPath);
  const currentIno = dbInodeOrZero(dbPath);
  if (cachedIno === undefined || cachedIno !== currentIno) {
    db.exec(SCHEMA_SQL);
    // The Python `dead_letter` schema gained a `source_path` column
    // via ALTER; do the idempotent ALTER here too so a TS writer
    // never trips over a legacy DB shape.
    const dlCols = (db.prepare("PRAGMA table_info(dead_letter)").all() as Array<{
      name: string;
    }>).map((r) => r.name);
    if (!dlCols.includes("source_path")) {
      db.exec(
        "ALTER TABLE dead_letter ADD COLUMN source_path TEXT NOT NULL DEFAULT 'http'",
      );
    }
    _initialized.set(dbPath, dbInodeOrZero(dbPath));
  }
  return db;
}

export interface EmitEvent {
  type: string;
  event_id: string;
  timestamp: string;
  cli: string;
  source: string;
  schema_version: number;
  session_id: string;
  payload: Record<string, unknown>;
  project?: string;
  user_id?: string;
  dedupe_key: string;
}

export interface MakeEventArgs {
  eventType: string;
  payload: Record<string, unknown>;
  cli?: string;
  source?: string;
  sessionId?: string;
  project?: string;
  userId?: string;
  dedupeKey?: string;
  env?: NodeJS.ProcessEnv;
}

export function makeEvent(args: MakeEventArgs): EmitEvent {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const cli = args.cli ?? "claude";
  const source = args.source ?? "skill";
  const sessionId = args.sessionId ?? resolveSessionId(args.env);
  const event: EmitEvent = {
    type: args.eventType,
    event_id: randomUUID(),
    timestamp: now,
    cli,
    source,
    schema_version: 2,
    session_id: sessionId,
    payload: args.payload,
    dedupe_key: args.dedupeKey ?? defaultDedupeKey({
      eventType: args.eventType, source, cli, sessionId, payload: args.payload,
    }),
  };
  if (args.project) event.project = args.project;
  if (args.userId) event.user_id = args.userId;
  return event;
}

function defaultDedupeKey(args: {
  eventType: string;
  source: string;
  cli: string;
  sessionId: string;
  payload: Record<string, unknown>;
}): string {
  // Mirrors Python `_default_dedupe_key`: SHA-1 of source+cli+session+type+payload.
  // Red-team callers always pass an explicit dedupe_key (run/finding/fix_plan
  // keys), so this path is rare for the red-team subsystem; included for
  // parity with Python event creation in case a caller skips it.
  const canonical = `${args.source}|${args.cli}|${args.sessionId}|${args.eventType}|${JSON.stringify(args.payload)}`;
  return `auto-${createHash("sha1").update(canonical, "utf8").digest("hex").slice(0, 16)}`;
}

export function validate(event: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!(field in event)) errors.push(`missing required field: ${field}`);
  }
  if (errors.length > 0) return errors;
  for (const field of ["type", "timestamp", "cli", "source"] as const) {
    const value = event[field];
    if (typeof value !== "string") {
      errors.push(`${field} must be a non-empty string, got: ${typeof value}`);
    } else if (!value) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const t = event.type;
  if (typeof t === "string" && !VALID_TYPES.has(t)) errors.push(`invalid type: ${t}`);
  const c = event.cli;
  if (typeof c === "string" && !VALID_CLIS.has(c)) errors.push(`invalid cli: ${c}`);
  const s = event.source;
  if (typeof s === "string" && !VALID_SOURCES.has(s)) errors.push(`invalid source: ${s}`);
  const sv = event.schema_version;
  if (typeof sv !== "number" || !Number.isInteger(sv) || sv < 1) {
    errors.push(`schema_version must be int >= 1, got: ${sv}`);
  }
  const pl = event.payload;
  if (pl === null || typeof pl !== "object" || Array.isArray(pl)) {
    errors.push(`payload must be a dict, got: ${typeof pl}`);
  }
  if ("event_id" in event) {
    const id = event.event_id;
    if (typeof id !== "string" || !id) errors.push(`event_id must be a non-empty string, got: ${String(id)}`);
  }
  return errors;
}

export interface EnqueueResult {
  ok: boolean;
  event_id?: string;
  dedupe_key?: string;
  duplicate?: boolean;
  error?: string;
}

export function enqueue(event: EmitEvent, env: NodeJS.ProcessEnv = process.env): EnqueueResult {
  const errors = validate(event as unknown as Record<string, unknown>);
  if (errors.length > 0) {
    return { ok: false, error: `Invalid event: ${errors.join("; ")}` };
  }
  const eventJson = redact(JSON.stringify(event));
  const db = openQueueDb(queueDbPath(env));
  try {
    const info = db
      .prepare("INSERT OR IGNORE INTO pending (dedupe_key, event_json) VALUES (?, ?)")
      .run(event.dedupe_key, eventJson);
    const duplicate = Number(info.changes) === 0;
    return {
      ok: true,
      event_id: event.event_id,
      dedupe_key: event.dedupe_key,
      duplicate,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    db.close();
  }
}
