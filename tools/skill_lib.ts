import fs from "node:fs";
import path from "node:path";

export type SkillBundle = {
  skillPath: string;
  refs: string[];
  missingRefs: string[];
  wordCount: number;
  lineCount: number;
};

const IGNORE_DIRS = new Set([
  ".git",
  ".next",
  ".worktrees",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export function findRepoRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }
    current = parent;
  }
}

export function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(fullPath));
      continue;
    }
    out.push(fullPath);
  }
  return out;
}

export function rel(repoRoot: string, filePath: string): string {
  return path.relative(repoRoot, filePath) || ".";
}

export function countWords(raw: string): number {
  return raw.trim() ? raw.trim().split(/\s+/).length : 0;
}

export function listSkillPaths(repoRoot: string): string[] {
  const repoRootReal = fs.realpathSync(repoRoot);
  return walk(repoRoot)
    .filter((file) => {
      const base = path.basename(file);
      if (base !== "SKILL.md" && base !== "skill.md") {
        return false;
      }
      // Reject symlinks and anything whose realpath escapes the repo root;
      // an in-repo SKILL.md pointing at /etc/shadow would otherwise be
      // uploaded to the Responses API by skill_optimize --mode api.
      if (fs.lstatSync(file).isSymbolicLink()) {
        return false;
      }
      return fs.realpathSync(file).startsWith(repoRootReal + path.sep);
    })
    .sort((a, b) => a.localeCompare(b));
}

export function buildBundle(repoRoot: string, skillPath: string): SkillBundle {
  const raw = fs.readFileSync(skillPath, "utf8");
  const refs = resolveRefs(repoRoot, skillPath, raw);
  return {
    skillPath: rel(repoRoot, skillPath),
    refs: refs.found,
    missingRefs: refs.missing,
    wordCount: countWords(raw),
    lineCount: raw.split(/\r?\n/).length,
  };
}

export function discoverSkillBundles(repoRoot: string): SkillBundle[] {
  return listSkillPaths(repoRoot).map((skillPath) => buildBundle(repoRoot, skillPath));
}

export function collectSharedRefs(
  bundles: SkillBundle[],
): Array<{ ref: string; skills: string[] }> {
  const seen = new Map<string, string[]>();
  for (const bundle of bundles) {
    for (const ref of bundle.refs) {
      const owners = seen.get(ref) ?? [];
      owners.push(bundle.skillPath);
      seen.set(ref, owners);
    }
  }
  return [...seen.entries()]
    .filter(([, owners]) => owners.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ref, skills]) => ({ ref, skills: skills.sort() }));
}

export function hasBrokenRefs(bundles: SkillBundle[]): boolean {
  return bundles.some((bundle) => bundle.missingRefs.length > 0);
}

export function loadBundleFiles(
  repoRoot: string,
  bundle: SkillBundle,
): Array<{ path: string; content: string }> {
  return [bundle.skillPath, ...bundle.refs].map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(repoRoot, file), "utf8"),
  }));
}

export function resolveSkillTarget(
  repoRoot: string,
  bundles: SkillBundle[],
  target: string,
): SkillBundle {
  const normalized = target.replace(/\\/g, "/").replace(/^\.?\//, "");
  const matches = bundles.filter((bundle) => {
    if (bundle.skillPath === normalized) {
      return true;
    }
    const dir = path.posix.dirname(bundle.skillPath);
    const slug = dir.split("/").at(-1) ?? dir;
    return slug === normalized;
  });
  if (!matches.length) {
    throw new Error(`Skill not found: ${target}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Skill target is ambiguous: ${target} -> ${matches
        .map((bundle) => bundle.skillPath)
        .join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * Pure markdown link extractor shared by `resolveRefs` (bundle discovery)
 * and `assertSharedDeletedRefsRemoved` (cross-owner delete safety). Returns
 * every destination mentioned by an inline, angle-bracketed, or reference-
 * style link. Destinations are returned verbatim; callers handle filtering
 * (e.g. local .md only) and path resolution.
 */
export function parseMarkdownLinkTargets(content: string): string[] {
  // Strip fenced (``` / ~~~) and inline (`...`) code spans before scanning
  // so example link syntax inside docs doesn't register as live references.
  // The audit would otherwise flag legitimate example files as missing and
  // the optimizer could over-aggressively delete shared refs shown in code.
  const scanned = stripCodeSpans(content);
  const defs = new Map<string, string>();
  for (const match of scanned.matchAll(
    /^\s*\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm,
  )) {
    const destination = match[2] ?? match[3];
    if (!destination) continue;
    defs.set(match[1].trim().toLowerCase(), stripWrappers(destination));
  }
  const targets = new Set<string>();
  // Inline destinations may contain single-level balanced parens, which are
  // valid per CommonMark (e.g. `./Guide (v2).md`). Match either any non-
  // paren run or a paren-balanced sub-token. The outer non-greedy repeat
  // stops at the first unmatched `)`, which is the link's closing paren.
  for (const match of scanned.matchAll(
    /(?<!!)\[[^\]]+\]\(((?:[^()]|\([^)]*\))+)\)/g,
  )) {
    const trimmed = match[1].replace(/\s+["'].*$/, "").trim();
    targets.add(stripWrappers(trimmed));
  }
  for (const match of scanned.matchAll(/\[[^\]]+\]\[([^\]]+)\]/g)) {
    const ref = defs.get(match[1].trim().toLowerCase());
    if (ref) {
      targets.add(ref);
    }
  }
  // Collapsed reference links `[label][]` reuse the label as the lookup key.
  for (const match of scanned.matchAll(/\[([^\]]+)\]\[\s*\]/g)) {
    const ref = defs.get(match[1].trim().toLowerCase());
    if (ref) {
      targets.add(ref);
    }
  }
  return [...targets];
}

function resolveRefs(
  repoRoot: string,
  skillPath: string,
  raw: string,
): {
  found: string[];
  missing: string[];
} {
  const skillDir = path.dirname(skillPath);
  const rawRefs = new Set(parseMarkdownLinkTargets(raw));

  const found = new Set<string>();
  const missing = new Set<string>();

  for (const rawRef of rawRefs) {
    if (!isLocalMarkdownRef(rawRef)) {
      continue;
    }
    const resolved = path.resolve(skillDir, rawRef.split("#", 1)[0]);
    if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
      missing.add(rel(repoRoot, resolved));
      continue;
    }
    if (
      fs.existsSync(resolved) &&
      fs.lstatSync(resolved).isFile() &&
      fs.realpathSync(resolved).startsWith(fs.realpathSync(repoRoot) + path.sep)
    ) {
      found.add(rel(repoRoot, resolved));
    } else {
      missing.add(rel(repoRoot, resolved));
    }
  }

  return {
    found: [...found].sort(),
    missing: [...missing].sort(),
  };
}

function isLocalMarkdownRef(ref: string): boolean {
  if (!ref || ref.startsWith("#")) {
    return false;
  }
  if (/^[a-z]+:/i.test(ref)) {
    return false;
  }
  return ref.toLowerCase().endsWith(".md") || ref.toLowerCase().includes(".md#");
}

function stripWrappers(input: string): string {
  return input.trim().replace(/^<|>$/g, "");
}

function stripCodeSpans(content: string): string {
  // Remove fenced blocks (``` or ~~~, optionally tagged) in one pass so
  // reference-style definitions that appear inside a fence don't pollute
  // the def table. Then strip single-line inline code spans.
  let scrubbed = content.replace(
    /^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm,
    "",
  );
  scrubbed = scrubbed.replace(/`+[^`\n]*`+/g, "");
  return scrubbed;
}
