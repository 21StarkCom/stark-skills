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
  return walk(repoRoot)
    .filter((file) => {
      const base = path.basename(file);
      return base === "SKILL.md" || base === "skill.md";
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

function resolveRefs(
  repoRoot: string,
  skillPath: string,
  raw: string,
): {
  found: string[];
  missing: string[];
} {
  const skillDir = path.dirname(skillPath);
  const defs = new Map<string, string>();

  for (const match of raw.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)/gm)) {
    defs.set(match[1].trim().toLowerCase(), stripWrappers(match[2]));
  }

  const rawRefs = new Set<string>();

  for (const match of raw.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)) {
    rawRefs.add(stripWrappers(match[1]));
  }

  for (const match of raw.matchAll(/\[[^\]]+\]\[([^\]]+)\]/g)) {
    const ref = defs.get(match[1].trim().toLowerCase());
    if (ref) {
      rawRefs.add(ref);
    }
  }

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
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
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
