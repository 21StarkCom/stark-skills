#!/usr/bin/env -S node --experimental-strip-types
/**
 * Hostinfo ticker — the SOLE host-introspection surface for the
 * observability stack on macOS.
 *
 * Docker Desktop on macOS does not expose host `/proc` to containers, so
 * every host fact the server needs (boot id, uptime, free disk, the live
 * pid set for parent-pid liveness) is written here to `host.json` on the
 * host and bind-mounted read-only at `/hostinfo` inside the container.
 *
 * Writes are atomic: `host.json.tmp` → `rename(2)`. Cadence is 5 s.
 *
 * Field derivation (executable, verified on macOS):
 *   - boot_time_seconds: parse `sysctl -n kern.boottime` into sec + usec/1e6
 *   - host_boot_id:      "<sec>.<usec>" (stable per boot session)
 *   - uptime_seconds:    Date.now()/1000 - boot_time_seconds
 *   - wall_clock:        new Date().toISOString()
 *   - free_disk_bytes:   fs.statfs(spoolDir).bavail * bsize
 *   - live_pids:         `ps -axo pid= -u $(id -u)` parsed to integers
 *
 * Run modes:
 *   --once               write a single tick and exit (used by tests)
 *   --loop               run forever, ticking every interval
 *   --interval 5s|N ms   tick interval (default 5s)
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ensureRoot,
  hostinfoDir,
  runsDir,
  openPrivate,
} from "./observability_paths_lib.ts";

export interface HostInfo {
  host_boot_id: string;
  boot_time_seconds: number;
  uptime_seconds: number;
  free_disk_bytes: number;
  wall_clock: string;
  live_pids: number[];
}

export interface CollectorEnv {
  /** Override `sysctl -n kern.boottime` for unit tests. */
  sysctl?: () => string;
  /** Override `ps -axo pid= -u <uid>` for unit tests. */
  ps?: () => string;
  /** Override `fs.statfs(spoolDir)` for unit tests. */
  statfs?: (spoolDir: string) => { bavail: number; bsize: number };
  /** Override `Date.now()` for unit tests. */
  now?: () => number;
  /** Override the spool dir path for unit tests. */
  spoolDir?: string;
}

/**
 * Parse `kern.boottime` into a fractional seconds-since-epoch value.
 * Output shape on macOS:
 *   { sec = 1779692400, usec = 123456 } Wed May 25 09:00:00 2026
 */
export function parseBootTime(raw: string): number {
  const m = raw.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
  if (!m) {
    throw new Error(`unparseable kern.boottime output: ${raw}`);
  }
  const sec = Number(m[1]);
  const usec = Number(m[2]);
  if (!Number.isFinite(sec) || !Number.isFinite(usec)) {
    throw new Error(`non-numeric kern.boottime fields: ${raw}`);
  }
  return sec + usec / 1e6;
}

/** Format host_boot_id from the raw boottime values — stable per boot. */
export function formatBootId(raw: string): string {
  const m = raw.match(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/);
  if (!m) {
    throw new Error(`unparseable kern.boottime output: ${raw}`);
  }
  return `${m[1]}.${m[2]}`;
}

/**
 * Parse a `ps -axo pid= -u $(id -u)` capture into a deduped sorted int
 * array. Skips non-integer lines defensively (ps shouldn't emit them, but
 * we'd rather drop garbage than crash the ticker).
 */
export function parsePidList(raw: string): number[] {
  const out = new Set<number>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const n = Number.parseInt(t, 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function defaultSysctl(): string {
  const r = spawnSync("sysctl", ["-n", "kern.boottime"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) {
    throw new Error(
      `sysctl -n kern.boottime failed (status ${r.status}): ${r.stderr}`,
    );
  }
  return r.stdout ?? "";
}

function defaultPs(): string {
  // -axo pid= => only the pid column with no header
  // -u <uid>  => filter to this user's processes
  // argv passed explicitly so no shell quoting can leak.
  const uid = process.getuid?.() ?? -1;
  const r = spawnSync(
    "ps",
    ["-axo", "pid=", "-u", String(uid)],
    { encoding: "utf8", timeout: 5000 },
  );
  if (r.status !== 0) {
    throw new Error(`ps failed (status ${r.status}): ${r.stderr}`);
  }
  return r.stdout ?? "";
}

function defaultStatfs(spoolDir: string): { bavail: number; bsize: number } {
  // fs.statfsSync arrived in Node 18.15 / 20+. We accept Number return
  // because bavail*bsize on a 1 TB+ free volume fits in a Number safely
  // up to 2^53 — that's ~9 PB, way beyond plausible laptop disks.
  const s = fs.statfsSync(spoolDir);
  return { bavail: Number(s.bavail), bsize: Number(s.bsize) };
}

/**
 * Collect a single hostinfo snapshot. Pure-function on top of the
 * injected environment, so unit tests can drive every field.
 */
export function collect(env: CollectorEnv = {}): HostInfo {
  const sysctl = env.sysctl ?? defaultSysctl;
  const ps = env.ps ?? defaultPs;
  const statfs = env.statfs ?? defaultStatfs;
  const now = env.now ?? Date.now;
  const spoolDir = env.spoolDir ?? runsDir();

  const sysctlRaw = sysctl();
  const bootTimeSeconds = parseBootTime(sysctlRaw);
  const bootId = formatBootId(sysctlRaw);
  const wallSeconds = now() / 1000;
  const uptimeSeconds = Math.max(0, wallSeconds - bootTimeSeconds);

  const psRaw = ps();
  const livePids = parsePidList(psRaw);

  const sf = statfs(spoolDir);
  const freeDiskBytes = sf.bavail * sf.bsize;

  return {
    host_boot_id: bootId,
    boot_time_seconds: bootTimeSeconds,
    uptime_seconds: uptimeSeconds,
    free_disk_bytes: freeDiskBytes,
    wall_clock: new Date(now()).toISOString(),
    live_pids: livePids,
  };
}

/**
 * Atomically write `host.json` via tmp + rename(2). The reader uses
 * `O_RDONLY`; rename guarantees no torn reads on POSIX file systems.
 */
export function writeAtomic(target: string, info: HostInfo): void {
  const dir = path.dirname(target);
  const tmp = path.join(dir, ".host.json.tmp");
  const payload = JSON.stringify(info, null, 2) + "\n";
  // Open the tmp via openPrivate so the file lands at 0600 even if the
  // umask leaked wider. Truncate any leftover tmp from a previous crash.
  const fd = openPrivate(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
  );
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}

export function hostInfoFilePath(): string {
  return path.join(hostinfoDir(), "host.json");
}

export interface RunOptions {
  intervalMs: number;
  once: boolean;
}

export function parseIntervalArg(raw: string | undefined): number {
  if (!raw) return 5000;
  const m = raw.match(/^(\d+)(ms|s|m)?$/);
  if (!m) throw new Error(`bad --interval: ${raw}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  if (unit === "ms") return n;
  if (unit === "s") return n * 1000;
  return n * 60_000;
}

function parseArgv(argv: string[]): RunOptions {
  let once = false;
  let loop = false;
  let intervalRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") once = true;
    else if (a === "--loop") loop = true;
    else if (a === "--interval") intervalRaw = argv[++i];
    else throw new Error(`unknown arg: ${a}`);
  }
  if (once && loop) throw new Error("--once and --loop are mutually exclusive");
  if (!once && !loop) once = true; // sensible default for `--help` ergonomics
  return { intervalMs: parseIntervalArg(intervalRaw), once };
}

async function tickOnce(env?: CollectorEnv): Promise<void> {
  ensureRoot();
  const info = collect(env);
  writeAtomic(hostInfoFilePath(), info);
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  if (opts.once) {
    await tickOnce();
    return;
  }
  // Loop mode — exit on SIGTERM/SIGINT; launchd KeepAlive will respawn if
  // the ticker dies for any other reason.
  let stop = false;
  const signal = () => {
    stop = true;
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);

  while (!stop) {
    try {
      await tickOnce();
    } catch (err) {
      // Best-effort: a transient sysctl/ps/statfs failure should not
      // crash the loop. Surface the error to stderr so launchd's stderr
      // log captures it, but keep ticking.
      process.stderr.write(
        `[hostinfo] tick failed: ${(err as Error).message}\n`,
      );
    }
    await sleep(opts.intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// Equivalent of Python's `if __name__ == "__main__":` — only run the
// CLI when this file is invoked as the entry point, not when it's
// imported by tests.
const isEntry =
  import.meta.url ===
  (process.argv[1]
    ? new URL(`file://${path.resolve(process.argv[1])}`).href
    : "");
if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`[hostinfo] fatal: ${(err as Error).message}\n`);
    process.exit(1);
  });
}

// Test seam — silences unused-export lint warnings.
export const __test = { parseArgv, sleep, tickOnce };
