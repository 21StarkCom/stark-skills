/**
 * Alert delivery — TypeScript implementation (replaces the deleted
 * `scripts/alert_delivery.py`).
 *
 * On-disk contract:
 *   - alerts log:  `<base>/alerts.jsonl` (one JSON object per line)
 *   - marker file: `<base>/alert-{unix-ts}[-{counter}].marker`
 * `<base>` defaults to `~/.claude/code-review/`. Cross-language
 * interop was the seam while the Python and TS implementations lived
 * side by side; with the Python gone (self_healer cutover, 2026-05-18)
 * the on-disk format is now owned purely by this module.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function defaultBaseDir(): string {
  return path.join(os.homedir(), ".claude", "code-review");
}

export function alertsPath(baseDir?: string): string {
  return path.join(baseDir ?? defaultBaseDir(), "alerts.jsonl");
}

export function markersDir(baseDir?: string): string {
  return baseDir ?? defaultBaseDir();
}

// ---------------------------------------------------------------------------
// emitAlert
// ---------------------------------------------------------------------------

export type AlertLevel = "info" | "warning" | "critical";

export interface EmitAlertOpts {
  level: AlertLevel;
  source: string;
  message: string;
  baseDir?: string;
  /** Override for tests; defaults to `Date.now() / 1000 | 0`. */
  now?: () => number;
  /** Override for tests; defaults to `new Date()`. */
  nowDate?: () => Date;
}

function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function appendJsonl(file: string, entry: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function emitAlert(opts: EmitAlertOpts): void {
  const base = opts.baseDir ?? defaultBaseDir();
  const nowDate = (opts.nowDate ?? (() => new Date()))();
  const entry = {
    timestamp: isoZ(nowDate),
    level: opts.level,
    source: opts.source,
    message: opts.message,
  };
  appendJsonl(alertsPath(base), entry);

  if (opts.level !== "critical") return;

  const dir = markersDir(base);
  fs.mkdirSync(dir, { recursive: true });
  const ts = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
  let marker = path.join(dir, `alert-${ts}.marker`);
  // Match Python's same-second collision counter exactly: while the
  // candidate file already exists, append `-N` and bump.
  let counter = 0;
  while (fs.existsSync(marker)) {
    counter += 1;
    marker = path.join(dir, `alert-${ts}-${counter}.marker`);
  }
  fs.writeFileSync(marker, "");
}

// ---------------------------------------------------------------------------
// acknowledgeAlert
// ---------------------------------------------------------------------------

export function acknowledgeAlert(markerPath: string): void {
  try {
    fs.unlinkSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// ---------------------------------------------------------------------------
// checkAlerts
// ---------------------------------------------------------------------------

export interface UnacknowledgedAlert {
  path: string;
}

export interface CheckAlertsResult {
  unacknowledged: UnacknowledgedAlert[];
}

export interface CheckAlertsOpts {
  baseDir?: string;
}

export function checkAlerts(opts: CheckAlertsOpts = {}): CheckAlertsResult {
  const dir = markersDir(opts.baseDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { unacknowledged: [] };
  }
  const markers = entries
    .filter((n) => n.startsWith("alert-") && n.endsWith(".marker"))
    .sort();
  return {
    unacknowledged: markers.map((n) => ({ path: path.join(dir, n) })),
  };
}
