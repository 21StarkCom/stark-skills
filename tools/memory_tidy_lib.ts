/**
 * memory_tidy — measure Claude Code auto-memory dirs against the load/recall
 * caps and flag mis-stored cross-repo facts. Read-only: this lib measures and
 * returns structured findings; the `/stark-memory` skill does the rewriting.
 *
 * The caps are undocumented, version-specific constants baked into the Claude
 * Code binary (verified from the 2.1.259 build, see CAP_SOURCE_VERSION):
 *   - MEMORY.md (the index) is loaded at session start only up to the FIRST 200
 *     lines OR 25,000 chars, whichever comes first; the tail is dropped silently.
 *   - each topic file is shown to recall only up to its first 200 lines / 4,096
 *     BYTES; the rest is invisible unless a session opens the file.
 *   - the prompt asks index lines to stay under ~150 chars (the binary's own
 *     WARNING text says ~200); we flag the stricter prompt number.
 * Re-verify the constants after a `claude` upgrade.
 *
 * Cross-repo detection reuses the fleet-slug matchers from the fact-routing hook
 * (fact_routing_hook_lib.ts); a memory in project X whose fact is about fleet
 * repo Y is stranded in the wrong per-project silo (no cross-repo recall exists).
 *
 * Pure + real-fs against absolute paths so the tree walk is unit-tested against a
 * synthesized ~/.claude/projects tree (see memory_tidy_lib.test.ts).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveFleetSlugs,
  fleetSlugsMentioned,
  descriptionOf,
  bodyOf,
} from "./fact_routing_hook_lib.ts";

/** The `claude` build the cap constants below were read from. */
export const CAP_SOURCE_VERSION = "2.1.259";

/** MEMORY.md load caps: first 200 lines OR 25,000 chars, tail dropped. */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_CHARS = 25000;
/** Per topic-file recall caps: first 200 lines / 4,096 BYTES. */
export const FILE_MAX_LINES = 200;
export const FILE_MAX_BYTES = 4096;
/** Prompt guidance for an index line (binary WARNING says ~200; we flag 150). */
export const INDEX_LINE_SOFT_MAX = 150;

// Fleet slugs to fall back on when the vault-ecosystem corpus is not checked out
// (CI, a fresh machine). Copied — NOT imported — from fact_routing_hook.ts:
// that file's FALLBACK_SLUGS is un-exported and it self-execs main()+exit(0) on
// import. Plus the four live 21Stark checkouts the corpus currently misses
// (cmux-client, gjallarhorn, ratatoskr, vor).
export const FALLBACK_SLUGS: readonly string[] = [
  "tyr", "frigg", "alfred", "meridian", "bifrost", "lumiere", "plume", "sleipnir",
  "hermod", "heimdall", "idun", "draupnir", "kotodama", "mimir", "atlas",
  "stark-skills", "stark-tui", "stark-showcase", "ev-infra-group", "homebrew-tap",
  "apple-developer", "stark-invoices-collector",
  "cmux-client", "gjallarhorn", "ratatoskr", "vor",
];

/** Union of the corpus's entity slugs and the hard fallback, deduped + sorted. */
export function resolveFleetSlugSet(corpusPath: string): string[] {
  return [...new Set([...resolveFleetSlugs(corpusPath), ...FALLBACK_SLUGS])].sort();
}

export interface MemoryFileReport {
  path: string;
  name: string;
  bytes: number;
  lines: number;
  overByteCap: boolean;
  overLineCap: boolean;
  recallTruncated: boolean;
}

/** Measure one topic file against the recall caps (bytes, then lines). */
export function measureFile(content: string, filePath = "", name = ""): MemoryFileReport {
  const bytes = Buffer.byteLength(content, "utf8");
  // Count lines of text, not split segments: a file ends in a newline, so the
  // trailing "" from split must not inflate the count (else an exactly-200-line
  // file reads as 201 and false-flags overLineCap). measureIndex trims; mirror it.
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const lines = body === "" ? 0 : body.split("\n").length;
  const overByteCap = bytes > FILE_MAX_BYTES;
  const overLineCap = lines > FILE_MAX_LINES;
  return { path: filePath, name, bytes, lines, overByteCap, overLineCap, recallTruncated: overByteCap || overLineCap };
}

export interface IndexLineReport {
  line: number;
  chars: number;
  text: string;
}

export interface IndexReport {
  path: string;
  lines: number;
  chars: number;
  bytes: number;
  overLineCap: boolean;
  overCharCap: boolean;
  /** 1-based line index where the session-start load stops (null = nothing dropped). */
  firstDroppedLine: number | null;
  entries: number;
  linkedFiles: string[];
  strayLines: number[];
  hasFrontmatter: boolean;
  longLines: IndexLineReport[];
  orphans: string[];
  dangling: string[];
}

const ENTRY_RE = /^\s*-\s*\[[^\]]*\]\(([^)]+)\)/;

/**
 * Replicate the binary's cut: keep the first INDEX_MAX_LINES lines, then if that
 * still exceeds INDEX_MAX_CHARS, cut at the last newline before the char cap.
 * Operates on the RAW content so the returned line number lines up with the raw
 * line numbers reported for stray/long lines. Returns the 1-based number of the
 * first line NOT loaded, or null.
 */
function firstDroppedLine(raw: string): number | null {
  const lines = raw.split("\n");
  if (lines.length <= INDEX_MAX_LINES && raw.length <= INDEX_MAX_CHARS) return null;
  const capped = lines.slice(0, INDEX_MAX_LINES);
  const joined = capped.join("\n");
  if (joined.length <= INDEX_MAX_CHARS) {
    // Only the line cap bit: line INDEX_MAX_LINES+1 is the first dropped.
    return lines.length > INDEX_MAX_LINES ? INDEX_MAX_LINES + 1 : null;
  }
  // Char cap bites inside the first 200 lines: find the last newline strictly
  // before the char cap (indices 0..CAP-1) and count how many lines survive.
  const cut = joined.lastIndexOf("\n", INDEX_MAX_CHARS - 1);
  const kept = cut === -1 ? joined.slice(0, INDEX_MAX_CHARS) : joined.slice(0, cut);
  const survivingLines = kept === "" ? 0 : kept.split("\n").length;
  return survivingLines + 1;
}

/** Parse and measure a MEMORY.md index. `topicFiles` enables orphan/dangling checks. */
export function measureIndex(content: string, indexPath = "", topicFiles: string[] = []): IndexReport {
  const trimmed = content.trim();
  const rawLines = content.split("\n");
  const chars = trimmed.length;
  const lines = trimmed === "" ? 0 : trimmed.split("\n").length;

  const linkedFiles: string[] = [];
  const strayLines: number[] = [];
  const longLines: IndexLineReport[] = [];
  const hasFrontmatter = content.startsWith("---");

  // Skip a leading frontmatter block when scanning for stray prose.
  let inFrontmatter = false;
  let frontmatterClosed = false;
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1;
    const t = raw.trim();
    if (hasFrontmatter && !frontmatterClosed) {
      if (i === 0 && t === "---") { inFrontmatter = true; return; }
      if (inFrontmatter) {
        if (t === "---") { frontmatterClosed = true; }
        return;
      }
    }
    if (t === "") return;
    if (t.startsWith("#")) return; // an H1/H2 heading is allowed chrome
    const m = raw.match(ENTRY_RE);
    if (m) {
      linkedFiles.push(m[1]!.trim());
      if (raw.length > INDEX_LINE_SOFT_MAX) longLines.push({ line: lineNo, chars: raw.length, text: raw });
      return;
    }
    strayLines.push(lineNo);
  });

  const topicSet = new Set(topicFiles);
  const linkedSet = new Set(linkedFiles);
  const orphans = topicFiles.filter((f) => !linkedSet.has(f)).sort();
  const dangling = linkedFiles.filter((f) => !topicSet.has(f)).sort();

  return {
    path: indexPath,
    lines,
    chars,
    bytes: Buffer.byteLength(content, "utf8"),
    overLineCap: lines > INDEX_MAX_LINES,
    overCharCap: chars > INDEX_MAX_CHARS,
    firstDroppedLine: firstDroppedLine(content),
    entries: linkedFiles.length,
    linkedFiles,
    strayLines,
    hasFrontmatter,
    longLines,
    orphans,
    dangling,
  };
}

/**
 * The project's own fleet slug: the longest known slug that the project dir name
 * ends with (after stripping a `--claude-worktrees-*` suffix). Forward match
 * against the known list only — a project slug is a lossy sanitised path and is
 * never reverse-parsed. Null when the dir ends in no known slug.
 */
export function ownSlugOf(projectDirName: string, fleetSlugs: readonly string[]): string | null {
  const base = projectDirName.replace(/--claude-worktrees-.*$/, "");
  let best: string | null = null;
  for (const s of fleetSlugs) {
    if (base === s || base.endsWith(`-${s}`)) {
      if (best === null || s.length > best.length) best = s;
    }
  }
  return best;
}

export interface CrossRepoFact {
  file: string;
  name: string;
  foreignSlugs: string[];
  strength: "strong" | "weak";
}

/**
 * Fleet slugs that appear as a hyphen-delimited segment run of a filename stem
 * (`tyr-atlassian-...` → tyr, `some-atlas-note` → atlas). Memory files name the
 * subject as a hyphen prefix, so the stem needs SEGMENT matching, not the
 * hyphen-safe prose word matcher (which treats `tyr-atlassian` as one token).
 */
function stemFleetSlugs(stem: string, fleetSlugs: readonly string[]): string[] {
  const s = stem.toLowerCase();
  return fleetSlugs.filter((slug) => {
    const g = slug.toLowerCase();
    return s === g || s.startsWith(`${g}-`) || s.endsWith(`-${g}`) || s.includes(`-${g}-`);
  });
}

/**
 * Classify a topic file's cross-repo signal, or null if it names no foreign
 * fleet slug. `strong` = a foreign slug is in the filename (as a segment) or the
 * description (the operator-visible identity); `weak` = body prose only.
 */
export function crossRepoStrength(
  content: string,
  name: string,
  ownSlug: string | null,
  fleetSlugs: readonly string[],
): CrossRepoFact | null {
  const description = descriptionOf(content).replace(/^["']|["']$/g, "");
  const body = bodyOf(content);
  const stem = name.replace(/\.md$/, "");
  const notOwn = (s: string) => s !== ownSlug;

  const stemSlugs = stemFleetSlugs(stem, fleetSlugs).filter(notOwn);
  const descSlugs = fleetSlugsMentioned(description, fleetSlugs).filter(notOwn);
  const bodySlugs = fleetSlugsMentioned(body, fleetSlugs).filter(notOwn);

  const foreign = [...new Set([...stemSlugs, ...descSlugs, ...bodySlugs])].sort();
  if (foreign.length === 0) return null;
  const strong = stemSlugs.length > 0 || descSlugs.length > 0;
  return { file: name, name, foreignSlugs: foreign, strength: strong ? "strong" : "weak" };
}

export interface ProjectReport {
  slug: string;
  memoryDir: string;
  ownSlug: string | null;
  empty: boolean;
  hasIndex: boolean;
  index: IndexReport | null;
  files: MemoryFileReport[];
  overCapFiles: MemoryFileReport[];
  crossRepo: CrossRepoFact[];
}

export interface TreeReport {
  generatedFor: string;
  projectsDir: string;
  capSourceVersion: string;
  corpusPresent: boolean;
  fleetSlugCount: number;
  projects: ProjectReport[];
  summary: {
    projectsScanned: number;
    projectsEmpty: number;
    indexesOverCap: number;
    filesOverCap: number;
    crossRepoStrong: number;
    crossRepoWeak: number;
  };
}

function listMemoryFiles(memoryDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md")
    .map((e) => e.name)
    .sort();
}

function measureProject(projectsDir: string, slug: string, fleetSlugs: readonly string[]): ProjectReport {
  const memoryDir = path.join(projectsDir, slug, "memory");
  const ownSlug = ownSlugOf(slug, fleetSlugs);
  const topicNames = listMemoryFiles(memoryDir);

  const files: MemoryFileReport[] = [];
  const crossRepo: CrossRepoFact[] = [];
  for (const name of topicNames) {
    const full = path.join(memoryDir, name);
    let content = "";
    try {
      content = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    files.push(measureFile(content, full, name));
    // With no known own slug we cannot separate this project's own subject from a
    // foreign one, so every fleet mention would false-flag — skip cross-repo here.
    if (ownSlug !== null) {
      const cross = crossRepoStrength(content, name, ownSlug, fleetSlugs);
      if (cross) crossRepo.push({ ...cross, file: full });
    }
  }

  const indexPath = path.join(memoryDir, "MEMORY.md");
  let index: IndexReport | null = null;
  try {
    index = measureIndex(fs.readFileSync(indexPath, "utf8"), indexPath, topicNames);
  } catch {
    index = null;
  }

  return {
    slug,
    memoryDir,
    ownSlug,
    empty: topicNames.length === 0 && index === null,
    hasIndex: index !== null,
    index,
    files,
    overCapFiles: files.filter((f) => f.recallTruncated),
    crossRepo,
  };
}

export interface MeasureTreeOptions {
  projectsDir?: string;
  corpusPath?: string;
  /** Restrict to one project by its exact dir-name slug. */
  project?: string;
}

export function defaultProjectsDir(home: string = os.homedir()): string {
  return path.join(home, ".claude", "projects");
}

export function defaultCorpusPath(home: string = os.homedir()): string {
  return process.env.ATLAS_ECOSYSTEM_PATH || path.join(home, "Code", "Vaults", "vault-ecosystem");
}

/** List project dir-name slugs that actually contain a memory/ subdirectory. */
export function listMemoryProjects(projectsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((slug) => {
      try {
        return fs.statSync(path.join(projectsDir, slug, "memory")).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Walk every ~/.claude/projects/<slug>/memory (or one project) and measure it. */
export function measureTree(opts: MeasureTreeOptions = {}): TreeReport {
  const projectsDir = opts.projectsDir ?? defaultProjectsDir();
  const corpusPath = opts.corpusPath ?? defaultCorpusPath();
  // Resolve the corpus once, then union with the fallback inline — a second
  // resolveFleetSlugSet() call would re-walk the corpus repos/ + systems/ dirs.
  const corpusSlugs = resolveFleetSlugs(corpusPath);
  const corpusPresent = corpusSlugs.length > 0;
  const fleetSlugs = [...new Set([...corpusSlugs, ...FALLBACK_SLUGS])].sort();

  const slugs = opts.project ? [opts.project] : listMemoryProjects(projectsDir);
  const projects = slugs.map((slug) => measureProject(projectsDir, slug, fleetSlugs));

  return {
    generatedFor: opts.project ?? "all",
    projectsDir,
    capSourceVersion: CAP_SOURCE_VERSION,
    corpusPresent,
    fleetSlugCount: fleetSlugs.length,
    projects,
    summary: {
      projectsScanned: projects.length,
      projectsEmpty: projects.filter((p) => p.empty).length,
      indexesOverCap: projects.filter((p) => p.index && (p.index.overLineCap || p.index.overCharCap)).length,
      filesOverCap: projects.reduce((n, p) => n + p.overCapFiles.length, 0),
      crossRepoStrong: projects.reduce((n, p) => n + p.crossRepo.filter((c) => c.strength === "strong").length, 0),
      crossRepoWeak: projects.reduce((n, p) => n + p.crossRepo.filter((c) => c.strength === "weak").length, 0),
    },
  };
}
