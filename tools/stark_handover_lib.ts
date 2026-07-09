/**
 * Handover storage engine — backs `/stark-handover`.
 *
 * Persists session handovers OUTSIDE the conversation so `/clear` between
 * iterations costs nothing: a fresh session resumes from disk instead of a
 * recap. Two artifacts per task, deliberately split:
 *
 *   {root}/{project}/{worktree}/{task}/handover_{N}.md   — numbered chain,
 *       one per save, frontmatter links `prev` so the history reads as a
 *       sequence (seq 1 → 2 → 3 …). Immutable once written.
 *   {root}/{project}/{worktree}/{task}/PROGRESS.md       — the single
 *       evolving done-vs-todo tracker, rewritten wholesale on every save.
 *
 * Root precedence: `STARK_HANDOVER_ROOT` env > `handover.root` config
 * (`stark_config_lib.ts::DEFAULT_HANDOVER`, default `~/Code/Handovers`).
 * This is user-space output (like a docs tree), not plugin state — so it
 * does NOT live under `stateRoot()`.
 *
 * The library owns the deterministic parts only (paths, seq numbering,
 * atomic writes, payload assembly); the handover/progress *content* is
 * authored by Claude in the skill. Pure functions with injected deps
 * (`runGit`, `nowIso`, `env`, `home`) for testability.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitContext {
  isGit: boolean;
  /** Repo name — basename of the dir holding the resolved `--git-common-dir`
   *  (identical from the main checkout and every linked worktree). */
  project: string;
  /** Linked worktree → worktree dir basename; main checkout → branch slug;
   *  fallbacks: `detached`, `no-git`. */
  worktree: string;
  branch: string | null;
  head: string | null;
}

export interface ChainEntry {
  seq: number;
  file: string;
}

export interface TaskInfo {
  task: string;
  dir: string;
  latestSeq: number;
  mtimeMs: number;
  hasProgress: boolean;
}

export interface SaveOpts {
  root: string;
  ctx: GitContext;
  task: string;
  /** Claude-authored handover body (markdown, no frontmatter). */
  body: string;
  /** When present, replaces PROGRESS.md wholesale. */
  progress?: string;
  nowIso?: () => string;
}

export interface SaveResult {
  task: string;
  dir: string;
  seq: number;
  handoverPath: string;
  progressPath: string | null;
  warnings: string[];
}

export interface ResumeOpts {
  root: string;
  ctx: GitContext;
  /** Explicit task slug; defaults to the most recently touched task. */
  task?: string;
}

export interface ResumePayload {
  task: string;
  dir: string;
  seq: number;
  handoverPath: string;
  handoverContent: string;
  progressPath: string | null;
  progressContent: string | null;
  chain: ChainEntry[];
  /** All task slugs under this project/worktree, newest first. */
  taskSlugs: string[];
}

// ---------------------------------------------------------------------------
// Slug + root resolution
// ---------------------------------------------------------------------------

const MAX_SLUG_LEN = 60;

/** Kebab-case a free-text task name into a filesystem-safe slug. Strips
 *  path separators / traversal; never returns an empty string. */
export function sanitizeSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/^-+|-+$/g, "");
  return slug || "task";
}

export interface ResolveRootOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** The `handover.root` config value (caller wires `getHandoverConfig()`). */
  configRoot: string;
}

/** `STARK_HANDOVER_ROOT` env > config root, with leading `~` expanded. */
export function resolveRoot(opts: ResolveRootOpts): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const fromEnv = (env.STARK_HANDOVER_ROOT ?? "").trim();
  const raw = fromEnv || opts.configRoot;
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return path.join(home, raw.slice(2));
  return raw;
}

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

export type RunGit = (args: string[], cwd: string) => string | null;

function defaultRunGit(args: string[], cwd: string): string | null {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  if (res.status !== 0) return null;
  return (res.stdout ?? "").trim();
}

export interface DeriveGitOpts {
  cwd?: string;
  runGit?: RunGit;
}

/**
 * Derive {project, worktree} deterministically, with no network:
 *   project  = basename(dirname(resolve(toplevel, --git-common-dir)))
 *   worktree = linked worktree (`--git-dir` under `worktrees/`) → basename
 *              of the toplevel; else current branch slug; else `detached`.
 * Non-git dirs → {cwd basename, `no-git`}.
 */
export function deriveGitContext(opts: DeriveGitOpts = {}): GitContext {
  const cwd = opts.cwd ?? process.cwd();
  const runGit = opts.runGit ?? defaultRunGit;

  const inside = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  if (inside !== "true") {
    return {
      isGit: false,
      project: sanitizeSlug(path.basename(cwd)),
      worktree: "no-git",
      branch: null,
      head: null,
    };
  }

  const toplevel = runGit(["rev-parse", "--show-toplevel"], cwd) ?? cwd;
  const commonDirRaw = runGit(["rev-parse", "--git-common-dir"], cwd) ?? ".git";
  const gitDirRaw = runGit(["rev-parse", "--git-dir"], cwd) ?? ".git";
  const branchRaw = runGit(["branch", "--show-current"], cwd) ?? "";
  const head = runGit(["rev-parse", "--short", "HEAD"], cwd);

  const commonDir = path.resolve(toplevel, commonDirRaw);
  const gitDir = path.resolve(toplevel, gitDirRaw);
  const project = sanitizeSlug(path.basename(path.dirname(commonDir)));

  const isLinkedWorktree = gitDir !== commonDir && gitDir.includes(`${path.sep}worktrees${path.sep}`);
  const branch = branchRaw.trim() || null;
  const worktree = isLinkedWorktree
    ? sanitizeSlug(path.basename(toplevel))
    : branch
      ? sanitizeSlug(branch)
      : "detached";

  return { isGit: true, project, worktree, branch, head: head || null };
}

// ---------------------------------------------------------------------------
// Paths, chain, tasks
// ---------------------------------------------------------------------------

export const PROGRESS_FILE = "PROGRESS.md";

const HANDOVER_RE = /^handover_(\d+)\.md$/;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
let tmpCounter = 0;

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function taskDirFor(root: string, ctx: GitContext, task: string): string {
  return path.join(root, ctx.project, ctx.worktree, sanitizeSlug(task));
}

/** Numbered handover files in a task dir, ascending by seq. */
export function chainFiles(dir: string): ChainEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    return [];
  }
  const out: ChainEntry[] = [];
  for (const name of names) {
    const m = HANDOVER_RE.exec(name);
    if (m) out.push({ seq: Number(m[1]), file: name });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

/** Next chain number: max existing seq + 1 (gaps preserved), else 1. */
export function nextSeq(dir: string): number {
  const chain = chainFiles(dir);
  return chain.length === 0 ? 1 : chain[chain.length - 1].seq + 1;
}

/** Tasks under {root}/{project}/{worktree}, newest activity first. */
export function listTasks(root: string, ctx: GitContext): TaskInfo[] {
  const base = path.join(root, ctx.project, ctx.worktree);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
    return [];
  }
  const out: TaskInfo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const chain = chainFiles(dir);
    if (chain.length === 0) continue; // not a handover task dir
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      // race with deletion; keep 0
    }
    for (const c of chain) {
      try {
        mtimeMs = Math.max(mtimeMs, fs.statSync(path.join(dir, c.file)).mtimeMs);
      } catch {
        // ignore
      }
    }
    out.push({
      task: entry.name,
      dir,
      latestSeq: chain[chain.length - 1].seq,
      mtimeMs,
      hasProgress: fs.existsSync(path.join(dir, PROGRESS_FILE)),
    });
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Resolve the task to operate on: explicit slug (must exist) or the most
 *  recently touched one. Null when nothing matches. */
export function pickTask(root: string, ctx: GitContext, task?: string): string | null {
  const tasks = listTasks(root, ctx);
  if (task !== undefined) {
    const slug = sanitizeSlug(task);
    return tasks.some((t) => t.task === slug) ? slug : null;
  }
  return tasks.length > 0 ? tasks[0].task : null;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function chmodIfExists(file: string, mode: number): void {
  try {
    fs.chmodSync(file, mode);
  } catch (err) {
    if (!isErrnoException(err) || err.code !== "ENOENT") throw err;
  }
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodIfExists(dir, DIR_MODE);
}

function tempPathFor(file: string): string {
  tmpCounter += 1;
  return `${file}.tmp-${process.pid}-${Date.now()}-${tmpCounter}`;
}

function writeTempFile(file: string, content: string): string {
  const tmp = tempPathFor(file);
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: FILE_MODE });
  chmodIfExists(tmp, FILE_MODE);
  return tmp;
}

function atomicWrite(file: string, content: string): void {
  const tmp = writeTempFile(file, content);
  try {
    fs.renameSync(tmp, file);
    chmodIfExists(file, FILE_MODE);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function exclusiveAtomicWrite(file: string, content: string): boolean {
  const tmp = writeTempFile(file, content);
  try {
    fs.linkSync(tmp, file);
    chmodIfExists(file, FILE_MODE);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "EEXIST") return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function redactSensitiveContent(content: string): { content: string; warnings: string[] } {
  const warnings = new Set<string>();
  let redacted = content.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => {
      warnings.add("private key block redacted");
      return "[REDACTED PRIVATE KEY]";
    },
  );
  redacted = redacted.replace(
    /(^|\n)([^\n]*(?:api[_-]?key|access[_-]?key|authorization|bearer|password|private[_-]?key|secret|token)[^\n]*[:=]\s*)(["']?)[^\s"'`]{8,}\3/gi,
    (_match, lineStart: string, prefix: string, quote: string) => {
      warnings.add("possible secret value redacted");
      return `${lineStart}${prefix}${quote}[REDACTED]${quote}`;
    },
  );
  return { content: redacted, warnings: [...warnings] };
}

function buildFrontmatter(opts: {
  task: string;
  seq: number;
  ctx: GitContext;
  createdIso: string;
  prev: string | null;
}): string {
  const { task, seq, ctx, createdIso, prev } = opts;
  return [
    "---",
    `task: ${task}`,
    `seq: ${seq}`,
    `project: ${ctx.project}`,
    `worktree: ${ctx.worktree}`,
    `branch: ${ctx.branch ?? "none"}`,
    `head: ${ctx.head ?? "none"}`,
    `created: ${createdIso}`,
    `prev: ${prev ?? "none"}`,
    "---",
    "",
  ].join("\n");
}

/** Write the next `handover_{N}.md` (frontmatter + body) and, when given,
 *  replace `PROGRESS.md`. Handover files use exclusive creation so concurrent
 *  saves cannot overwrite an already-allocated sequence. */
export function saveHandover(opts: SaveOpts): SaveResult {
  const task = sanitizeSlug(opts.task);
  const dir = taskDirFor(opts.root, opts.ctx, task);
  ensurePrivateDir(dir);

  const createdIso = (opts.nowIso ?? (() => new Date().toISOString()))();
  const body = redactSensitiveContent(opts.body);
  const progress = opts.progress === undefined ? null : redactSensitiveContent(opts.progress);
  const warnings = [...new Set([...body.warnings, ...(progress?.warnings ?? [])])];

  let seq = 0;
  let handoverPath = "";
  for (let attempt = 0; attempt < 1000; attempt++) {
    const chain = chainFiles(dir);
    seq = chain.length === 0 ? 1 : chain[chain.length - 1].seq + 1;
    const prev = chain.length === 0 ? null : chain[chain.length - 1].file;
    handoverPath = path.join(dir, `handover_${seq}.md`);
    const frontmatter = buildFrontmatter({ task, seq, ctx: opts.ctx, createdIso, prev });
    if (exclusiveAtomicWrite(handoverPath, frontmatter + body.content)) break;
    seq = 0;
  }
  if (seq === 0) {
    throw new Error(`could not allocate a handover sequence under ${dir}`);
  }

  let progressPath: string | null = null;
  if (progress !== null) {
    progressPath = path.join(dir, PROGRESS_FILE);
    atomicWrite(progressPath, progress.content);
  }

  return { task, dir, seq, handoverPath, progressPath, warnings };
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Assemble everything a fresh session needs in one payload: the latest
 *  handover in the chain, the PROGRESS.md tracker, and the chain listing.
 *  Null when the task (or any task) has no handovers yet. */
export function resumePayload(opts: ResumeOpts): ResumePayload | null {
  const task = pickTask(opts.root, opts.ctx, opts.task);
  if (task === null) return null;

  const dir = taskDirFor(opts.root, opts.ctx, task);
  const chain = chainFiles(dir);
  if (chain.length === 0) return null;

  const latest = chain[chain.length - 1];
  const handoverPath = path.join(dir, latest.file);
  const handoverContent = readIfExists(handoverPath);
  if (handoverContent === null) return null;

  const progressPath = path.join(dir, PROGRESS_FILE);
  const progressContent = readIfExists(progressPath);

  return {
    task,
    dir,
    seq: latest.seq,
    handoverPath,
    handoverContent,
    progressPath: progressContent === null ? null : progressPath,
    progressContent,
    chain,
    taskSlugs: listTasks(opts.root, opts.ctx).map((t) => t.task),
  };
}
