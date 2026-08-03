/**
 * Run store for `/stark-jury` — the on-disk layout every jury run persists to.
 *
 *   {root}/<name>/<run-id>/
 *     manifest.json     skill, input path+hash, panel, timestamps, per-seat
 *                       outcome (incl. usage_source), totals
 *     input.md          the source document as dispatched
 *     prompt.md         the byte-identical payload sent to every seat
 *     candidates/       claude.md … + claude.meta.json … (tokens/cost/rc/hash)
 *     verify/           claude.json … (CLEAN|DISQUALIFIED + violations)
 *     merge.md          session-written (rewrite skills)
 *     report.md         session-written (judge calibration)
 *     audit.jsonl       one row per LLM call, INCLUDING the session's merge row
 *
 * `root` defaults to `<stateRoot()>/history/jury` — operator state, never repo
 * content, and never under `CLAUDE_PLUGIN_ROOT` (plugin caches are replaced
 * wholesale on update).
 *
 * Three properties this module exists to guarantee:
 *
 *   - **Private by construction.** Dirs 0700, files 0600. The corpus is
 *     unpublished drafts as often as published posts.
 *   - **Manifest-skeleton first, final manifest atomic.** The skeleton is
 *     written BEFORE dispatch so a crashed run leaves a diagnosable directory;
 *     the final write goes to a temp file in the same dir and is renamed, so
 *     an interrupted rewrite never leaves invalid JSON behind.
 *   - **Append-only audit.** Every LLM call appends its row immediately after
 *     it returns, so a crash mid-run still leaves the calls that completed.
 *
 * Run ids are a UTC timestamp plus a 4-char random suffix and the run dir is
 * created EXCLUSIVELY: two runs starting in the same second cannot land in the
 * same directory (the loser retries with a fresh suffix rather than silently
 * sharing a dir).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./asset_root_lib.ts";
import { SEAT_IDS, type SeatId } from "./jury_panel.ts";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_NAME_LEN = 60;
const MAX_RUN_ID_ATTEMPTS = 8;

let tmpCounter = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunPaths {
  /** The jury root (`{root}`), i.e. the parent of every `<name>` dir. */
  root: string;
  name: string;
  runId: string;
  /** `{root}/<name>/<run-id>` */
  dir: string;
  manifest: string;
  input: string;
  prompt: string;
  candidatesDir: string;
  verifyDir: string;
  merge: string;
  report: string;
  audit: string;
}

/** Per-seat outcome as the manifest records it. Token/cost fields are nullable
 *  by design: a seat whose CLI reports no usage stores nulls and an honest
 *  `usage_source`, never an estimate. */
export interface SeatOutcome {
  seat: SeatId;
  model: string;
  /** Resolved effort, or `"n/a"` for a vendor with no knob. */
  effort: string;
  status: "clean" | "disqualified" | "failed" | "pending";
  exit_code: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  /** Where the numbers came from — `null` when the CLI reported none. */
  usage_source: string | null;
  error: string | null;
  [key: string]: unknown;
}

export interface JuryManifest {
  run_id: string;
  name: string;
  skill: string;
  mode: string;
  input_path: string;
  input_sha256: string;
  panel: Array<{ seat: SeatId; model: string; effort: string }>;
  started_at: string;
  finished_at: string | null;
  seats: SeatOutcome[];
  totals: {
    cost_usd: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** One audit row — an LLM call that happened, including the calling session's
 *  own merge/report work. */
export interface AuditRow {
  ts: string;
  kind: string;
  model: string;
  [key: string]: unknown;
}

export interface RunSummary {
  name: string;
  runId: string;
  dir: string;
  mtimeMs: number;
  /** Parsed manifest, or `null` when absent/unreadable (a crashed run). */
  manifest: JuryManifest | null;
}

export interface CreateRunOpts {
  name: string;
  root?: string;
  runId?: string;
  now?: Date;
  /** Injectable randomness — tests pin the suffix. */
  rand?: () => string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `<stateRoot()>/history/jury` — the run store's root. */
export function juryRoot(): string {
  return path.join(stateRoot(), "history", "jury");
}

/** Filesystem-safe `<name>` segment. Defends the store against a `../` in an
 *  input basename as much as it normalizes cosmetics. */
export function sanitizeName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LEN)
    .replace(/^-+|-+$/g, "");
  return slug || "run";
}

function defaultRand(): string {
  return crypto.randomBytes(2).toString("hex");
}

/** UTC timestamp + 4-char random suffix, e.g. `20260803T143745Z-a3f9`. */
export function makeRunId(now: Date = new Date(), rand: () => string = defaultRand): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${rand().slice(0, 4).padStart(4, "0")}`;
}

/** Pure path assembly for a run dir — no I/O, no side effects. */
export function runPaths(root: string, name: string, runId: string): RunPaths {
  const dir = path.join(root, name, runId);
  return {
    root,
    name,
    runId,
    dir,
    manifest: path.join(dir, "manifest.json"),
    input: path.join(dir, "input.md"),
    prompt: path.join(dir, "prompt.md"),
    candidatesDir: path.join(dir, "candidates"),
    verifyDir: path.join(dir, "verify"),
    merge: path.join(dir, "merge.md"),
    report: path.join(dir, "report.md"),
    audit: path.join(dir, "audit.jsonl"),
  };
}

export function candidatePath(paths: RunPaths, seat: SeatId): string {
  return path.join(paths.candidatesDir, `${seat}.md`);
}

export function candidateMetaPath(paths: RunPaths, seat: SeatId): string {
  return path.join(paths.candidatesDir, `${seat}.meta.json`);
}

export function verifyPath(paths: RunPaths, seat: SeatId): string {
  return path.join(paths.verifyDir, `${seat}.json`);
}

// ---------------------------------------------------------------------------
// Private-by-construction write helpers
// ---------------------------------------------------------------------------

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function chmodIfExists(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
  }
}

/** mkdir -p with an explicit chmod: the `mode` option is masked by the
 *  process umask, so it alone does not guarantee 0700. */
function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodIfExists(dir, DIR_MODE);
}

function writePrivateFile(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: FILE_MODE });
  chmodIfExists(file, FILE_MODE);
}

function tempPathFor(file: string): string {
  tmpCounter += 1;
  return `${file}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
}

/** Write via a temp file in the SAME dir, then rename. The rename is atomic on
 *  a single filesystem, so a reader never sees a half-written manifest. */
function atomicWrite(file: string, content: string): void {
  const tmp = tempPathFor(file);
  writePrivateFile(tmp, content);
  try {
    fs.renameSync(tmp, file);
    chmodIfExists(file, FILE_MODE);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a run directory (plus `candidates/` and `verify/`), all 0700.
 *
 * The leaf is created EXCLUSIVELY: on collision — a concurrent run that drew
 * the same second and the same suffix — a fresh run id is drawn instead of
 * two runs sharing one dir. An explicit `runId` gets no retry: the caller
 * asked for that exact directory, so EEXIST is a real error.
 */
export function createRun(opts: CreateRunOpts): RunPaths {
  const root = opts.root ?? juryRoot();
  const name = sanitizeName(opts.name);
  const explicit = opts.runId !== undefined;
  ensurePrivateDir(path.join(root, name));

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < (explicit ? 1 : MAX_RUN_ID_ATTEMPTS); attempt += 1) {
    const runId = explicit ? (opts.runId as string) : makeRunId(opts.now ?? new Date(), opts.rand);
    const paths = runPaths(root, name, runId);
    try {
      fs.mkdirSync(paths.dir, { mode: DIR_MODE });
    } catch (err) {
      if (!explicit && isErrnoException(err) && err.code === "EEXIST") {
        lastErr = err;
        continue;
      }
      throw err;
    }
    chmodIfExists(paths.dir, DIR_MODE);
    ensurePrivateDir(paths.candidatesDir);
    ensurePrivateDir(paths.verifyDir);
    return paths;
  }
  throw new Error(
    `jury_store: could not allocate a free run id under ${path.join(root, name)} ` +
      `after ${MAX_RUN_ID_ATTEMPTS} attempts (${String(lastErr)})`,
  );
}

/** sha256 of a UTF-8 string, hex — the hash the manifest and candidate meta
 *  files record for their artifacts. */
export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Write the manifest SKELETON — called BEFORE dispatch, so a run that crashes
 * mid-flight still leaves a directory that says what it was trying to do.
 * Non-atomic on purpose: there is nothing yet to clobber.
 */
export function writeManifestSkeleton(paths: RunPaths, manifest: JuryManifest): void {
  writePrivateFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Write the FINAL manifest atomically (temp file + rename). */
export function writeManifest(paths: RunPaths, manifest: JuryManifest): void {
  atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Parsed manifest, or `null` when absent or unparseable (a crashed run). */
export function readManifest(dirOrPaths: string | RunPaths): JuryManifest | null {
  const file =
    typeof dirOrPaths === "string" ? path.join(dirOrPaths, "manifest.json") : dirOrPaths.manifest;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as JuryManifest) : null;
  } catch {
    return null;
  }
}

export function writeInput(paths: RunPaths, text: string): void {
  writePrivateFile(paths.input, text);
}

/** The payload — byte-identical across seats, so it is stored ONCE. */
export function writePrompt(paths: RunPaths, text: string): void {
  writePrivateFile(paths.prompt, text);
}

export function writeCandidate(paths: RunPaths, seat: SeatId, text: string): string {
  const file = candidatePath(paths, seat);
  writePrivateFile(file, text);
  return file;
}

export function writeCandidateMeta(
  paths: RunPaths,
  seat: SeatId,
  meta: Record<string, unknown>,
): string {
  const file = candidateMetaPath(paths, seat);
  writePrivateFile(file, `${JSON.stringify(meta, null, 2)}\n`);
  return file;
}

export function writeVerify(
  paths: RunPaths,
  seat: SeatId,
  verdict: Record<string, unknown>,
): string {
  const file = verifyPath(paths, seat);
  writePrivateFile(file, `${JSON.stringify(verdict, null, 2)}\n`);
  return file;
}

/** Session-written merge (rewrite skills). */
export function writeMerge(paths: RunPaths, text: string): void {
  writePrivateFile(paths.merge, text);
}

/** Session-written calibration report (judge mode). */
export function writeReport(paths: RunPaths, text: string): void {
  writePrivateFile(paths.report, text);
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * Append one audit row. Called immediately after each LLM call returns —
 * including the calling session's own merge/report row, which is why this is
 * append-only and never rewritten: the trail must survive a crash and must not
 * be summarizable after the fact.
 */
export function appendAudit(paths: RunPaths, row: AuditRow): void {
  const line = `${JSON.stringify(row)}\n`;
  const fd = fs.openSync(paths.audit, "a", FILE_MODE);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
  chmodIfExists(paths.audit, FILE_MODE);
}

/** Audit rows in append order. Unparseable lines are skipped, not thrown on —
 *  a truncated final line from a killed process must not hide the rest. */
export function readAudit(paths: RunPaths): AuditRow[] {
  let text: string;
  try {
    text = fs.readFileSync(paths.audit, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const out: AuditRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object") out.push(parsed as AuditRow);
    } catch {
      // partial write from a killed process — skip the line, keep the rest
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read side (`jury.ts list` / `show` read ONLY this store)
// ---------------------------------------------------------------------------

function readdirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
}

/** Every run under the store, newest first. `name` narrows to one input's runs. */
export function listRuns(opts: { root?: string; name?: string } = {}): RunSummary[] {
  const root = opts.root ?? juryRoot();
  const names =
    opts.name !== undefined
      ? [sanitizeName(opts.name)]
      : readdirSafe(root)
          .filter((e) => e.isDirectory())
          .map((e) => e.name);

  const out: RunSummary[] = [];
  for (const name of names) {
    for (const entry of readdirSafe(path.join(root, name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, name, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(dir).mtimeMs;
      } catch {
        // race with deletion; keep 0
      }
      out.push({ name, runId: entry.name, dir, mtimeMs, manifest: readManifest(dir) });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? 1 : -1));
  return out;
}

/** Locate one run by id across every `<name>` dir; `null` when absent. */
export function findRun(runId: string, opts: { root?: string } = {}): RunSummary | null {
  return listRuns({ root: opts.root }).find((r) => r.runId === runId) ?? null;
}

/** Which seats actually produced a candidate file — the read side's view of
 *  what the run captured, independent of what the manifest claims. */
export function candidateSeats(paths: RunPaths): SeatId[] {
  const present = new Set(
    readdirSafe(paths.candidatesDir)
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name.slice(0, -3)),
  );
  return SEAT_IDS.filter((s) => present.has(s));
}
