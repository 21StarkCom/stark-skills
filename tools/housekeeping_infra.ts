#!/usr/bin/env node

// stark-housekeeping Phase 5 — local infrastructure cleanup. Replaces the
// inline Python -c snippets that scanned session files, lock files, log
// rotation, and tar archival.
//
// Pure file ops + a TS reimplementation of `lock_helpers.is_lock_stale`
// (parses the JSON lock format, checks PID liveness via signal 0, compares
// `ps -o lstart=` against the recorded start_time, and applies the TTL).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// ── Lock staleness (TS port of scripts/lock_helpers.is_lock_stale) ──

export type LockData = {
  pid?: number;
  start_time?: string;
  timestamp?: string;
  worktree?: string;
  ttl_minutes?: number;
};

export function readLockJson(filePath: string): LockData | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LockData) : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 is the standard "does this PID exist" probe — kill(pid, 0)
    // returns 0 on Linux/macOS if the process exists OR we lack permission
    // to signal it. Node throws on the latter (EPERM); both mean "alive."
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

export function processStartTime(pid: number): string {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return out.trim();
  } catch {
    return "";
  }
}

export type StaleClock = {
  now: () => Date;
  pidAlive: (pid: number) => boolean;
  startTime: (pid: number) => string;
};

const REAL_CLOCK: StaleClock = {
  now: () => new Date(),
  pidAlive: isPidAlive,
  startTime: processStartTime,
};

export function isLockDataStale(
  lockData: LockData,
  clock: StaleClock = REAL_CLOCK,
): boolean {
  // TTL check first — even a live process holding a lock past its TTL is
  // considered abandoned (matches the Python helper's behavior).
  const ttlMinutes = typeof lockData.ttl_minutes === "number" ? lockData.ttl_minutes : 30;
  const ts = lockData.timestamp;
  if (!ts) return true;
  const stored = parseLockTimestamp(ts);
  if (stored === null) return true;
  if (clock.now().getTime() > stored.getTime() + ttlMinutes * 60_000) {
    return true;
  }
  // PID liveness check.
  const pid = lockData.pid;
  if (typeof pid !== "number" || !Number.isFinite(pid)) return true;
  if (!clock.pidAlive(pid)) return true;
  // Start-time cross-check guards against PID reuse: a recycled PID would
  // pass the alive check but have a different `ps -o lstart=` value.
  const storedStart = (lockData.start_time ?? "").trim();
  const currentStart = clock.startTime(pid).trim();
  if (currentStart && storedStart && currentStart !== storedStart) return true;
  return false;
}

function parseLockTimestamp(ts: string): Date | null {
  // The Python helper writes `2026-04-03T12:34:56Z`. JS Date accepts that
  // directly; some old formats also use `+00:00`, so try replace as a
  // safety belt before bailing.
  const candidates = [ts, ts.replace(/Z$/, "+00:00")];
  for (const c of candidates) {
    const d = new Date(c);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

// ── File-age helpers ────────────────────────────────────────────

export type AgeProvider = (filePath: string) => Date;

const REAL_AGE: AgeProvider = (filePath) => fs.statSync(filePath).mtime;

export function isOlderThan(
  filePath: string,
  maxAgeDays: number,
  ageProvider: AgeProvider = REAL_AGE,
  now: Date = new Date(),
): boolean {
  try {
    const mtime = ageProvider(filePath).getTime();
    return now.getTime() - mtime > maxAgeDays * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function listFilesMatching(
  rootDir: string,
  matcher: (entryPath: string, relPath: string) => boolean,
  recursive: boolean,
): string[] {
  if (!fs.existsSync(rootDir)) return [];
  const out: string[] = [];
  walk(rootDir, "", recursive, (full, rel) => {
    if (matcher(full, rel)) out.push(full);
  });
  return out;
}

function walk(
  rootDir: string,
  prefix: string,
  recursive: boolean,
  visit: (full: string, rel: string) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name);
    const full = path.join(rootDir, rel);
    if (entry.isDirectory()) {
      if (recursive) walk(rootDir, rel, recursive, visit);
      continue;
    }
    visit(full, rel);
  }
}

// ── Phase steps ─────────────────────────────────────────────────

export type StepReceipt = {
  files: string[];
};

export function findStaleSessionFiles(
  sessionsDir: string,
  maxAgeDays: number,
  ageProvider: AgeProvider = REAL_AGE,
  now: Date = new Date(),
): string[] {
  return listFilesMatching(
    sessionsDir,
    (full, rel) =>
      rel.endsWith(".json") &&
      !rel.includes(path.sep) &&
      isOlderThan(full, maxAgeDays, ageProvider, now),
    false,
  );
}

export function findStaleCheckpointFiles(
  sessionsDir: string,
  maxAgeDays: number,
  ageProvider: AgeProvider = REAL_AGE,
  now: Date = new Date(),
): string[] {
  return listFilesMatching(
    sessionsDir,
    (full, rel) => {
      const base = path.basename(rel);
      if (!base.startsWith("checkpoint-") || !base.endsWith(".md")) return false;
      return isOlderThan(full, maxAgeDays, ageProvider, now);
    },
    true,
  );
}

export function findStaleLockFiles(
  scanDirs: string[],
  options: { clock?: StaleClock } = {},
): string[] {
  const clock = options.clock ?? REAL_CLOCK;
  const out: string[] = [];
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".lock")) continue;
      const full = path.join(dir, entry.name);
      const lockData = readLockJson(full);
      if (lockData === null) {
        out.push(full); // Corrupt lock = stale, same as the Python helper.
        continue;
      }
      if (isLockDataStale(lockData, clock)) out.push(full);
    }
  }
  return out;
}

export function rotateLogFile(
  filePath: string,
  keepLines: number,
  dryRun: boolean,
): { rotated: boolean; lines: number } {
  if (!fs.existsSync(filePath)) return { rotated: false, lines: 0 };
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n");
  // Trailing newline produces a final empty element; drop it before counting
  // so a file with N lines + trailing \n reports N, not N+1.
  const trailingNewline = lines[lines.length - 1] === "";
  const effective = trailingNewline ? lines.length - 1 : lines.length;
  if (effective <= keepLines) return { rotated: false, lines: effective };
  if (dryRun) return { rotated: true, lines: effective };
  const kept = lines.slice(effective - keepLines, effective);
  const next = kept.join("\n") + (trailingNewline ? "\n" : "");
  fs.writeFileSync(filePath, next);
  return { rotated: true, lines: effective };
}

export type ArchiveSource = {
  // Display name used in the archive filename, e.g. `automation-logs`.
  slug: string;
  // Directory whose contents we want to compress.
  rootDir: string;
};

export type ArchiveResult = {
  archive: string; // tar.gz path
  files: string[]; // files included
};

export function archiveOldFiles(
  source: ArchiveSource,
  archiveDir: string,
  maxAgeDays: number,
  options: {
    ageProvider?: AgeProvider;
    now?: Date;
    dryRun?: boolean;
    tarRunner?: (args: string[]) => string;
  } = {},
): ArchiveResult[] {
  if (!fs.existsSync(source.rootDir)) return [];
  const ageProvider = options.ageProvider ?? REAL_AGE;
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const tarRunner =
    options.tarRunner ??
    ((args) => execFileSync("tar", args, { encoding: "utf8" }));

  // Group eligible files by YYYY-MM of their mtime, matching the SKILL.md
  // contract (one archive per source per month).
  const groups = new Map<string, string[]>();
  walk(source.rootDir, "", true, (full, _rel) => {
    if (!isOlderThan(full, maxAgeDays, ageProvider, now)) return;
    const month = ageProvider(full).toISOString().slice(0, 7); // YYYY-MM
    const list = groups.get(month) ?? [];
    list.push(full);
    groups.set(month, list);
  });

  const results: ArchiveResult[] = [];
  if (groups.size === 0) return results;
  if (!dryRun) fs.mkdirSync(archiveDir, { recursive: true });

  for (const [month, files] of groups) {
    const archive = path.join(archiveDir, `${source.slug}-${month}.tar.gz`);
    if (!dryRun) {
      const relative = files.map((f) => path.relative(source.rootDir, f));
      tarRunner(["-czf", archive, "-C", source.rootDir, ...relative]);
      // Verify before deleting originals — `tar -tzf` exits non-zero on
      // corruption, which would throw and abort the unlink loop.
      tarRunner(["-tzf", archive]);
      for (const f of files) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* leave it; receipt still records the archive */
        }
      }
    }
    results.push({ archive, files });
  }
  return results;
}

// ── Asset symlink self-healing ──────────────────────────────────
//
// Distribution is marketplace-only since install.sh was removed, but a legacy
// set of symlinks under ~/.claude still resolves the stark-skills assets for
// directly-invoked tools (e.g. stark_review.ts → ~/.claude/code-review/prompts,
// tokens via ~/.claude/code-review/tools). These links live OUTSIDE any repo,
// so a workspace reorg that renames their targets (Code/Playground → Code/21Stark,
// 2026-07-11) leaves them dangling and produces silent, confusing failures.
// Housekeeping re-points them so the tree self-heals.

// Old→new path-segment renames. This map is load-bearing for BOTH detection
// (a link whose target still contains an old segment is stale) AND repair (the
// remapped target is what a stale link is repointed to). Data-driven so a
// future reorg is a one-line addition.
export type RenameMapping = { from: string; to: string };

export const STALE_SEGMENT_RENAMES: RenameMapping[] = [
  { from: `Code${path.sep}Playground${path.sep}`, to: `Code${path.sep}21Stark${path.sep}` },
];

// A known stark-skills asset symlink. Both paths are relative to $HOME so the
// table is home-agnostic (and test-injectable via a synthetic home). `target`
// is the canonical location, used as the FALLBACK repair target when a link is
// dangling for a reason the rename map can't explain (e.g. deleted with no
// stale segment). Stale-segment links are repaired via the rename map instead.
export type AssetSymlink = {
  link: string; // link location, relative to home
  target: string; // canonical/fallback target, relative to home
};

export const ASSET_SYMLINKS: AssetSymlink[] = [
  { link: ".claude/code-review/prompts", target: "Code/21Stark/stark-skills/global/prompts" },
  { link: ".claude/code-review/tools", target: "Code/21Stark/stark-skills/tools" },
  { link: ".claude/code-review/config.json", target: "Code/21Stark/stark-skills/global/config.json" },
  { link: ".claude/code-review/scripts", target: "Code/21Stark/stark-skills/scripts" },
  { link: ".claude/code-review/standards", target: "Code/21Stark/stark-skills/standards" },
  { link: ".claude/code-review/orchestrator.md", target: "Code/21Stark/stark-skills/global/orchestrator.md" },
  { link: ".claude/plugins/stark-gh", target: "Code/21Stark/stark-skills/plugins/stark-gh" },
  { link: ".claude/output-styles/concrete.md", target: "Code/21Stark/stark-skills/config/output-styles/concrete.md" },
];

export type SymlinkRepair = { path: string; from: string; to: string };

// Injectable filesystem seam so a test can force a mid-repair failure (e.g.
// symlink() throwing) and assert the load-bearing link is never left absent.
export type LinkOps = {
  readlink: (p: string) => string;
  symlink: (target: string, p: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (p: string) => void;
  exists: (p: string) => boolean;
};

const REAL_LINK_OPS: LinkOps = {
  readlink: (p) => fs.readlinkSync(p),
  symlink: (target, p) => fs.symlinkSync(target, p),
  rename: (from, to) => fs.renameSync(from, to),
  unlink: (p) => fs.unlinkSync(p),
  exists: (p) => fs.existsSync(p),
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function applyRenames(target: string, renames: RenameMapping[]): string {
  let out = target;
  for (const r of renames) out = out.split(r.from).join(r.to);
  return out;
}

export function healAssetSymlinks(
  home: string,
  options: {
    links?: AssetSymlink[];
    renames?: RenameMapping[];
    dryRun?: boolean;
    ops?: LinkOps;
  } = {},
): { repaired: SymlinkRepair[]; errors: string[] } {
  const links = options.links ?? ASSET_SYMLINKS;
  const renames = options.renames ?? STALE_SEGMENT_RENAMES;
  const dryRun = options.dryRun ?? false;
  const ops = options.ops ?? REAL_LINK_OPS;
  const repaired: SymlinkRepair[] = [];
  const errors: string[] = [];

  for (const entry of links) {
    const linkPath = path.join(home, entry.link);
    const canonicalTarget = path.join(home, entry.target);

    // Only heal things that are actually symlinks. ENOENT (nothing there) and
    // EINVAL (a real file/dir, not a symlink) are "not ours to heal" → skip
    // silently. Any other error (EACCES, EIO, ELOOP) is a real problem worth
    // surfacing rather than swallowing.
    let currentTarget: string;
    try {
      currentTarget = ops.readlink(linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EINVAL") {
        errors.push(`readlink ${linkPath}: ${errMsg(err)}`);
      }
      continue;
    }

    // The rename map determines the repair target for a stale link; existsSync
    // follows the link, so it is false for a dangling one. A link that dangles
    // without a stale segment falls back to the canonical target.
    const remapped = applyRenames(currentTarget, renames);
    const stale = remapped !== currentTarget;
    const dangling = !ops.exists(linkPath);
    if (!dangling && !stale) continue; // healthy → no-op (idempotent)

    const correctedTarget = stale ? remapped : canonicalTarget;

    // Never delete a link whose corrected target is missing — report instead.
    if (!ops.exists(correctedTarget)) {
      errors.push(
        `asset symlink ${linkPath} is ${dangling ? "dangling" : "stale"} ` +
          `(-> ${currentTarget}) but corrected target ${correctedTarget} is missing; left untouched`,
      );
      continue;
    }

    // Already correct? (stale segment somewhere but resolves to the corrected
    // path already) — nothing to do.
    if (currentTarget === correctedTarget) continue;

    if (!dryRun) {
      // Atomic repoint: create the replacement at a temp name, then rename it
      // over the old link. If symlink() throws, the original is untouched; if
      // rename() throws, we remove the orphaned temp link. The load-bearing
      // link is never left absent — unlike a naive unlink-then-symlink.
      const tmp = `${linkPath}.stark-heal-${process.pid}`;
      try {
        try {
          ops.unlink(tmp);
        } catch {
          /* no stale temp from a previous crash — fine */
        }
        ops.symlink(correctedTarget, tmp);
        ops.rename(tmp, linkPath);
      } catch (err) {
        try {
          ops.unlink(tmp);
        } catch {
          /* best-effort temp cleanup */
        }
        errors.push(`repoint ${linkPath}: ${errMsg(err)}`);
        continue;
      }
    }
    repaired.push({ path: linkPath, from: currentTarget, to: correctedTarget });
  }

  return { repaired, errors };
}

// ── Composition ─────────────────────────────────────────────────

export type CleanupReceipt = {
  dryRun: boolean;
  sessionsRemoved: string[];
  checkpointsRemoved: string[];
  staleLocksRemoved: string[];
  validationLogsRemoved: string[];
  logsRotated: { path: string; previousLines: number }[];
  artifactsArchived: ArchiveResult[];
  symlinksRepaired: SymlinkRepair[];
  errors: string[];
};

export type CleanupOptions = {
  dryRun?: boolean;
  homeDir?: string; // override for tests
  cwd?: string; // override for archival source rooted at the repo's automation/
  now?: Date;
  ageProvider?: AgeProvider;
  clock?: StaleClock;
  tarRunner?: (args: string[]) => string;
};

export function cleanInfra(opts: CleanupOptions = {}): CleanupReceipt {
  const dryRun = opts.dryRun ?? false;
  const home = opts.homeDir ?? os.homedir();
  const cwd = opts.cwd ?? process.cwd();
  const codeReview = path.join(home, ".claude", "code-review");
  const sessions = path.join(codeReview, "sessions");
  const archiveDir = path.join(codeReview, "archives");
  const errors: string[] = [];

  const sessionsToRemove = findStaleSessionFiles(
    sessions,
    30,
    opts.ageProvider,
    opts.now,
  );
  const checkpointsToRemove = findStaleCheckpointFiles(
    sessions,
    7,
    opts.ageProvider,
    opts.now,
  );
  const staleLocks = findStaleLockFiles(
    [codeReview, "/tmp"],
    { clock: opts.clock },
  );
  const validationLogs = listFilesMatching(
    path.join(codeReview, "logs"),
    (full, rel) =>
      rel.endsWith(".stderr") &&
      isOlderThan(full, 14, opts.ageProvider, opts.now),
    false,
  );

  if (!dryRun) {
    for (const f of [...sessionsToRemove, ...checkpointsToRemove, ...staleLocks, ...validationLogs]) {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        errors.push(`unlink ${f}: ${(err as Error).message}`);
      }
    }
  }

  const logsRotated: CleanupReceipt["logsRotated"] = [];
  const logFiles = ["healer.jsonl", "preflight.jsonl", "approach-contracts.jsonl"];
  for (const name of logFiles) {
    const full = path.join(codeReview, name);
    try {
      const r = rotateLogFile(full, 1000, dryRun);
      if (r.rotated) {
        logsRotated.push({ path: full, previousLines: r.lines });
      }
    } catch (err) {
      errors.push(`rotate ${full}: ${(err as Error).message}`);
    }
  }

  const archivalSources: ArchiveSource[] = [
    { slug: "automation-logs", rootDir: path.join(cwd, "automation", "logs") },
    { slug: "history-autopilot", rootDir: path.join(codeReview, "history", "autopilot") },
  ];
  const artifactsArchived: ArchiveResult[] = [];
  for (const source of archivalSources) {
    try {
      artifactsArchived.push(
        ...archiveOldFiles(source, archiveDir, 30, {
          ageProvider: opts.ageProvider,
          now: opts.now,
          dryRun,
          tarRunner: opts.tarRunner,
        }),
      );
    } catch (err) {
      errors.push(`archive ${source.slug}: ${(err as Error).message}`);
    }
  }

  // Heal legacy asset symlinks (dangling or pointing through a renamed path
  // segment) so directly-invoked tools keep resolving prompts/tools/config.
  const { repaired: symlinksRepaired, errors: symlinkErrors } = healAssetSymlinks(
    home,
    { dryRun },
  );
  errors.push(...symlinkErrors);

  return {
    dryRun,
    sessionsRemoved: sessionsToRemove,
    checkpointsRemoved: checkpointsToRemove,
    staleLocksRemoved: staleLocks,
    validationLogsRemoved: validationLogs,
    logsRotated,
    artifactsArchived,
    symlinksRepaired,
    errors,
  };
}

// ── CLI ─────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { dryRun: boolean; asJson: boolean } {
  let dryRun = false;
  let asJson = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--json") asJson = true;
    else if (arg === "-h" || arg === "--help") {
      console.log("Usage: housekeeping_infra [--dry-run] [--json]");
      process.exit(0);
    }
  }
  return { dryRun, asJson };
}

function formatText(receipt: CleanupReceipt): string {
  const out: string[] = [];
  out.push(`housekeeping_infra${receipt.dryRun ? " (dry-run)" : ""}`);
  out.push(`  sessions removed:        ${receipt.sessionsRemoved.length}`);
  out.push(`  checkpoints removed:     ${receipt.checkpointsRemoved.length}`);
  out.push(`  stale locks removed:     ${receipt.staleLocksRemoved.length}`);
  out.push(`  validation logs removed: ${receipt.validationLogsRemoved.length}`);
  out.push(`  logs rotated:            ${receipt.logsRotated.length}`);
  const archiveCount = receipt.artifactsArchived.length;
  const fileCount = receipt.artifactsArchived.reduce((n, a) => n + a.files.length, 0);
  out.push(`  artifacts archived:      ${fileCount} files in ${archiveCount} archives`);
  out.push(`  asset symlinks repaired: ${receipt.symlinksRepaired.length}`);
  for (const s of receipt.symlinksRepaired) {
    out.push(`    - ${s.path}: ${s.from} -> ${s.to}`);
  }
  if (receipt.errors.length) {
    out.push("  errors:");
    for (const e of receipt.errors) out.push(`    - ${e}`);
  }
  return out.join("\n");
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const receipt = cleanInfra({ dryRun: opts.dryRun });
  if (opts.asJson) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(formatText(receipt));
  }
  process.exit(receipt.errors.length ? 1 : 0);
}

// Match against both the lexical and realpath form of argv[1]:
//   - Node's --experimental-strip-types loader (Node 25+) sets import.meta.url
//     to the realpath, so a symlinked invocation needs the realpath comparison.
//   - NODE_OPTIONS=--preserve-symlinks-main keeps import.meta.url at the
//     symlink URL, so we need the lexical comparison too.
//   - realpathSync throws if argv[1] doesn't exist on disk (embedded runners
//     that fake argv[1]); swallow that and fall through to "not invoked".
function isInvokedAsScript(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  if (metaUrl === pathToFileURL(path.resolve(argv1)).href) return true;
  try {
    return metaUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isInvokedAsScript(import.meta.url)) {
  main();
}
