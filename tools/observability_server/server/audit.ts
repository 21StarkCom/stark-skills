/**
 * Append-only security audit log (Phase 4 Task 7).
 *
 * One JSONL record per `recordAudit()` call. File mode 0600. Every
 * write fsyncs the file descriptor before returning so a crash mid-row
 * cannot lose the lifecycle event. Never carries raw tokens, bootstrap
 * codes, session cookies, payload bodies, or `Authorization` header
 * values — only the field surface enumerated in the plan.
 *
 * Survives `docker volume rm observability_index`: the log path is
 * `/audit/audit.jsonl` inside the container, which is a HOST bind to
 * `~/.claude/code-review/observability/audit/` (see Phase 1 Task 1 /
 * docker-compose.yml). Trimming + rotation is the prune CLI's
 * responsibility; this module only appends.
 */

import fs from "node:fs";
import path from "node:path";

export type AuditResult = "success" | "failure";

export interface AuditFields {
  run_id?: string;
  credential_kind?: "bootstrap_token" | "session_cookie" | "prune_token";
  host_meta?: {
    /** Remote address attributed to the request by Fastify. */
    remote?: string;
    /** Host header value seen at the boundary. */
    host?: string;
    /** Origin header value seen at the boundary. */
    origin?: string;
  };
  reason_code?: string;
  generation?: number;
  /** Best-effort row count of the affected `truncated[]` array. NEVER the rows themselves. */
  rows?: number;
  /** Free-form bind/operational metadata (e.g. `{ "bind": "lan" }`). NEVER carries a secret. */
  extra?: Record<string, string | number | boolean>;
}

export interface AuditEntry {
  ts: string;
  action: string;
  result: AuditResult;
  run_id?: string;
  credential_kind?: AuditFields["credential_kind"];
  host_meta?: AuditFields["host_meta"];
  reason_code?: string;
  generation?: number;
  rows?: number;
  extra?: AuditFields["extra"];
}

const FORBIDDEN_KEYS = new Set([
  "token",
  "tokens",
  "bootstrap_token",
  "prune_token",
  "code",
  "session",
  "session_cookie",
  "cookie",
  "authorization",
]);

export interface AuditWriterOptions {
  /** Container-side path to the audit log file (default `/audit/audit.jsonl`). */
  filePath?: string;
  /** Test seam — let tests inject a deterministic clock. */
  now?: () => number;
}

export class AuditWriter {
  private readonly filePath: string;
  private readonly now: () => number;

  constructor(opts: AuditWriterOptions = {}) {
    this.filePath = opts.filePath ?? "/audit/audit.jsonl";
    this.now = opts.now ?? Date.now;
  }

  getFilePath(): string {
    return this.filePath;
  }

  record(action: string, result: AuditResult, fields: AuditFields = {}): void {
    const entry: AuditEntry = {
      ts: new Date(this.now()).toISOString(),
      action,
      result,
    };
    if (fields.run_id !== undefined) entry.run_id = fields.run_id;
    if (fields.credential_kind !== undefined)
      entry.credential_kind = fields.credential_kind;
    if (fields.host_meta !== undefined) entry.host_meta = fields.host_meta;
    if (fields.reason_code !== undefined) entry.reason_code = fields.reason_code;
    if (fields.generation !== undefined) entry.generation = fields.generation;
    if (fields.rows !== undefined) entry.rows = fields.rows;
    if (fields.extra !== undefined) entry.extra = sanitizeExtra(fields.extra);

    const line = JSON.stringify(entry) + "\n";
    let fd: number | null = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      fd = fs.openSync(this.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (err) {
      // Best-effort: an audit-write failure is reported on stderr but
      // does NOT fail the originating request. The auth path remains
      // available; a missing audit row is a known-but-bounded gap that
      // the operator can detect via the `/audit` mount sanity check.
      process.stderr.write(
        `[audit] write failed (${action}/${result}): ${(err as Error).message}\n`,
      );
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // best-effort
        }
      }
    }
  }
}

function sanitizeExtra(
  extra: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}
