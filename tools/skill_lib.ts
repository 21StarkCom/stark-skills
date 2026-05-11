import fs from "node:fs";
import path from "node:path";

export type SkillRefKind = "markdown" | "python";

export type SkillBundle = {
  skillPath: string;
  refs: string[];
  missingRefs: string[];
  refKinds: Record<string, SkillRefKind>;
  wordCount: number;
  lineCount: number;
};

export type BundleFile = {
  path: string;
  content: string;
  kind: "markdown" | "python" | "text";
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

const ROOT_RELATIVE_PREFIXES = [
  "automation/",
  "config/",
  "data/",
  "docs/",
  "global/",
  "org/",
  "scripts/",
  "skill/",
  "standards/",
  "tests/",
  "tools/",
];

const SCRIPT_INSTALL_PREFIXES = [
  "~/.claude/code-review/scripts/",
  "$HOME/.claude/code-review/scripts/",
  "${HOME}/.claude/code-review/scripts/",
  "$SCRIPTS/",
  "${SCRIPTS}/",
];

const ROOT_INSTALL_PREFIXES = ["$ROOT/", "${ROOT}/"];

/**
 * Walk up from `start` until a `.git/` entry is found. Returns `null` when
 * no ancestor has one — prior versions silently returned `path.resolve(start)`
 * and forced every caller to re-check `.git` independently, which led to the
 * bypass described in round 24 of the stark-forged review.
 */
export function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
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
  const refs = inspectLocalRefs(repoRoot, skillPath, raw);
  return {
    skillPath: rel(repoRoot, skillPath),
    refs: refs.found,
    missingRefs: refs.missing,
    refKinds: refs.refKinds,
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
): BundleFile[] {
  return [bundle.skillPath, ...bundle.refs].map((file) => ({
    path: file,
    content: fs.readFileSync(path.join(repoRoot, file), "utf8"),
    kind: detectFileKind(file),
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

export function detectFileKind(
  filePath: string,
): "markdown" | "python" | "text" {
  const lowered = filePath.toLowerCase();
  if (lowered.endsWith(".md")) {
    return "markdown";
  }
  if (lowered.endsWith(".py")) {
    return "python";
  }
  return "text";
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
  // Shortcut reference links: bare `[label]` with a matching `[label]: dest`
  // definition. Only match a label that isn't immediately followed by `(` or
  // `[`, to avoid re-capturing inline or full reference links already handled
  // above, and exclude labels that look like reference-definition lines
  // themselves (so `[foo]: dest` doesn't trigger).
  for (const match of scanned.matchAll(/\[([^\]\n]+)\](?!\(|\[|\s*:)/g)) {
    const ref = defs.get(match[1].trim().toLowerCase());
    if (ref) {
      targets.add(ref);
    }
  }
  return [...targets];
}

export function inspectLocalRefs(
  repoRoot: string,
  sourcePath: string,
  raw: string,
  options?: {
    fileExists?: (absolutePath: string) => boolean;
  },
): {
  found: string[];
  missing: string[];
  refKinds: Record<string, SkillRefKind>;
} {
  const absoluteSourcePath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.join(repoRoot, sourcePath);
  const sourceDir = path.dirname(absoluteSourcePath);
  const fileExists = options?.fileExists ?? defaultFileExists;
  const candidates = new Map<string, { kind: SkillRefKind; source: "link" | "text" }>();

  for (const rawRef of parseMarkdownLinkTargets(raw)) {
    addCandidate(candidates, rawRef, "link");
  }
  for (const match of raw.matchAll(/([~$./A-Za-z0-9_-]+\/[~$./A-Za-z0-9_-]*\.py)/g)) {
    addCandidate(candidates, match[1], "text");
  }
  for (const match of raw.matchAll(/\b([A-Za-z0-9_.-]+\.py)\b/g)) {
    addCandidate(candidates, match[1], "text");
  }

  const repoRootReal = fs.realpathSync(repoRoot);
  const found = new Set<string>();
  const missing = new Set<string>();
  const refKinds: Record<string, SkillRefKind> = {};

  for (const [rawRef, candidate] of candidates) {
    if (!isSupportedLocalRef(rawRef)) {
      continue;
    }
    const resolved = resolveLocalRef(repoRoot, sourceDir, rawRef, candidate.source, fileExists);
    if (!resolved) {
      continue;
    }
    const resolvedRel = rel(repoRoot, resolved);
    if (!isWithinRepo(repoRoot, resolved)) {
      missing.add(resolvedRel);
      continue;
    }
    if (fileExists(resolved) && fs.realpathSync(resolved).startsWith(repoRootReal + path.sep)) {
      found.add(resolvedRel);
      refKinds[resolvedRel] = candidate.kind;
      continue;
    }
    missing.add(resolvedRel);
  }

  return {
    found: [...found].sort(),
    missing: [...missing].sort(),
    refKinds,
  };
}

function addCandidate(
  candidates: Map<string, { kind: SkillRefKind; source: "link" | "text" }>,
  rawRef: string,
  source: "link" | "text",
): void {
  const normalized = stripWrappers(rawRef);
  const kind = inferRefKind(normalized);
  if (!kind) {
    return;
  }
  const existing = candidates.get(normalized);
  if (!existing || existing.source === "text") {
    candidates.set(normalized, { kind, source });
  }
}

function inferRefKind(ref: string): SkillRefKind | null {
  const lowered = ref.toLowerCase();
  if (lowered.endsWith(".py")) {
    return "python";
  }
  if (lowered.endsWith(".md") || lowered.includes(".md#")) {
    return "markdown";
  }
  return null;
}

function isSupportedLocalRef(ref: string): boolean {
  if (!ref || ref.startsWith("#")) {
    return false;
  }
  if (ref.includes("://")) {
    return false;
  }
  const lowered = ref.toLowerCase();
  return (
    lowered.endsWith(".md") ||
    lowered.includes(".md#") ||
    lowered.endsWith(".py")
  );
}

function resolveLocalRef(
  repoRoot: string,
  sourceDir: string,
  rawRef: string,
  source: "link" | "text",
  fileExists: (absolutePath: string) => boolean,
): string | null {
  const normalized = normalizeRef(rawRef);
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("~/Code/")) {
    return null;
  }

  for (const prefix of SCRIPT_INSTALL_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return path.join(repoRoot, "scripts", normalized.slice(prefix.length));
    }
  }

  for (const prefix of ROOT_INSTALL_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return path.join(repoRoot, normalized.slice(prefix.length));
    }
  }

  if (normalized.startsWith("$") || normalized.startsWith("~/")) {
    return null;
  }

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return path.resolve(sourceDir, normalized);
  }

  if (normalized.startsWith("references/")) {
    return path.resolve(sourceDir, normalized);
  }

  if (ROOT_RELATIVE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    if (source === "text" && !normalized.startsWith("scripts/")) {
      return null;
    }
    return path.join(repoRoot, normalized);
  }

  if (!normalized.includes("/")) {
    const localCandidate = path.resolve(sourceDir, normalized);
    if (source === "link" || fileExists(localCandidate)) {
      return localCandidate;
    }
    if (normalized.toLowerCase().endsWith(".py")) {
      const scriptCandidate = path.join(repoRoot, "scripts", normalized);
      if (fileExists(scriptCandidate)) {
        return scriptCandidate;
      }
    }
    return null;
  }

  const localCandidate = path.resolve(sourceDir, normalized);
  if (isWithinRepo(repoRoot, localCandidate) && (source === "link" || fileExists(localCandidate))) {
    return localCandidate;
  }
  return null;
}

function normalizeRef(rawRef: string): string {
  return stripWrappers(rawRef).split("#", 1)[0].replace(/^['"`]+|['"`]+$/g, "");
}

function isWithinRepo(repoRoot: string, absolutePath: string): boolean {
  return absolutePath === repoRoot || absolutePath.startsWith(repoRoot + path.sep);
}

function defaultFileExists(absolutePath: string): boolean {
  return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
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
