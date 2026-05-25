/**
 * Path + permission helpers for the stark-review observability stack.
 *
 * Every writer in the stack (emit lib, writer daemon, host ticker, prune
 * CLI, bootstrap helper, server) goes through this module so that
 * directory/file modes are uniformly 0700/0600 even if the user's
 * interactive umask is the macOS default 022.
 *
 * The acceptance criterion for Phase 1 Task 1 is a permission unit test
 * that plants synthetic files through every exported helper, stats each,
 * and fails on any wider-than-policy mode. Keep this module's public
 * surface stable so that test stays the single source of truth.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OBSERVABILITY_ROOT = path.join(
  os.homedir(),
  ".claude",
  "code-review",
  "observability",
);

const SESSIONS_ROOT = path.join(
  os.homedir(),
  ".claude",
  "code-review",
  "sessions",
);

const AUDIT_ROOT = path.join(OBSERVABILITY_ROOT, "audit");

export function runsDir(): string {
  return path.join(OBSERVABILITY_ROOT, "runs");
}

export function hostinfoDir(): string {
  return path.join(OBSERVABILITY_ROOT, "hostinfo");
}

export function trashDir(): string {
  return path.join(OBSERVABILITY_ROOT, ".trash");
}

export function auditDir(): string {
  return AUDIT_ROOT;
}

export function sessionsDir(): string {
  return SESSIONS_ROOT;
}

export function sessionDir(sessionId: string): string {
  return path.join(SESSIONS_ROOT, sanitizeId(sessionId));
}

export function runDir(runId: string): string {
  return path.join(runsDir(), sanitizeId(runId));
}

export function metaPath(runId: string): string {
  return path.join(runDir(runId), "meta.json");
}

export function currentSpoolFile(runId: string, rotationIndex: number): string {
  const idx = String(rotationIndex).padStart(4, "0");
  return path.join(runDir(runId), `events-${idx}.jsonl`);
}

/**
 * Path to the writer daemon's UDS for a run.
 *
 * macOS caps `sun_path` at 104 bytes. The natural per-run-dir path
 * (`~/.claude/code-review/observability/runs/<uuid>/writer.sock`) is right
 * at the edge for a normal `$HOME` and well over the limit under `/var/
 * folders/.../T/...` paths used by tmpdir-rebased tests. We store the
 * socket under a short shared prefix (`/tmp/stark-obs/`) keyed by a short
 * hash of the runId, and keep `writer.pid` + `writer.cap` co-located in
 * the per-run dir for diagnostics.
 */
export function writerSocketPath(runId: string): string {
  const hash = quickHash(sanitizeId(runId));
  return path.join(os.tmpdir(), "stark-obs", `${hash}.sock`);
}

/** Short, stable hash of a run id for socket-path keying. Not security
 * critical — the cap file is the auth surface. */
function quickHash(input: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** mkdir for the short-prefix socket dir under tmpdir. Mode 0700; only
 * the owning user can open the sockets inside. */
export function ensureSocketDir(): string {
  const d = path.join(os.tmpdir(), "stark-obs");
  ensurePrivateDir(d);
  return d;
}

export function writerPidPath(runId: string): string {
  return path.join(runDir(runId), "writer.pid");
}

/**
 * Path to the writer daemon's capability secret (RT1). 32-byte random
 * b64url token written 0600 in the per-run dir at daemon-boot time;
 * dispatchers read this file and present its contents on the first UDS
 * `hello` frame. The 0600 mode is the same-UID gate — a same-UID process
 * that has not opened this file cannot synthesize a valid cap.
 */
export function writerCapPath(runId: string): string {
  return path.join(runDir(runId), "writer.cap");
}

export function sessionCookiePath(): string {
  return path.join(OBSERVABILITY_ROOT, "session.cookie");
}

export function auditLogPath(): string {
  return path.join(AUDIT_ROOT, "audit.jsonl");
}

/**
 * `mkdir -p` the path with mode 0700. Always re-chmods to 0700 (idempotent
 * across runs that may have inherited a wider mode from an earlier umask).
 *
 * Wraps the mkdir in a process-wide umask(0o077) window so that even if
 * mkdirSync's `mode` is ignored on platforms where it's clamped, the
 * resulting bits cannot be wider than 0700.
 */
export function ensurePrivateDir(target: string): void {
  const prev = process.umask(0o077);
  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    // mkdirSync's mode is ANDed with ~umask AND only applied to NEWLY-created
    // dirs. If the path already exists, force the mode here so we converge.
    fs.chmodSync(target, 0o700);
  } finally {
    process.umask(prev);
  }
}

/**
 * Open a file for the given fs.open flags with mode 0600. Used by every
 * writer so JSONL spool files, meta.json, writer.sock pid files, host.json,
 * session.cookie, prune.log, audit.jsonl, phase_run.json/env, lease.tick
 * all land at 0600.
 *
 * Returns the raw numeric fd so callers can stream-write or fsync as they
 * see fit. Closing is the caller's responsibility.
 */
export function openPrivate(target: string, flags: number | string): number {
  const prev = process.umask(0o077);
  try {
    return fs.openSync(target, flags, 0o600);
  } finally {
    process.umask(prev);
  }
}

/**
 * Ensure the full observability directory tree exists with mode 0700.
 * Idempotent — a second call is a no-op modulo the chmod converge step.
 * Includes the audit dir (E9) so the Phase 1 acceptance "audit is
 * writable" check passes on a fresh install.
 */
export function ensureRoot(): void {
  ensurePrivateDir(OBSERVABILITY_ROOT);
  ensurePrivateDir(runsDir());
  ensurePrivateDir(hostinfoDir());
  ensurePrivateDir(trashDir());
  ensurePrivateDir(auditDir());
  ensurePrivateDir(SESSIONS_ROOT);
  ensureSocketDir();
}

/**
 * Reject path-traversal in run/session ids so a hostile id can't escape
 * the observability root via "../". Mirror of session_state_lib's
 * sanitizer — kept local so this module has no cross-tool deps.
 */
function sanitizeId(id: string): string {
  if (!id || typeof id !== "string") {
    throw new Error("observability id must be a non-empty string");
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`unsafe observability id: ${id}`);
  }
  return id;
}

/** Test seam — let tests reach the sanitizer + audit root without
 * depending on internals across modules. */
export const __test = { sanitizeId, AUDIT_ROOT };
