// Deterministic repository discovery for the refactor-planner.
//
// This is the host-side scan that runs with zero LLM calls. It produces the
// `RepoInventory` that seeds every subagent context pack, so the agents reason
// over a focused, factual slice instead of re-walking the tree themselves. All
// ordering is sorted and all reads are bounded, so `dry-run` output is stable.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CommandSet, FileFact, ImportEdge, RepoInventory, TodoMarker } from "./refactor_planner_schemas.ts";

export const DEFAULT_EXCLUDES: readonly string[] = [
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt",
  "target", "vendor", "__pycache__", ".venv", ".turbo", ".cache", ".refactor-planner",
];

export interface DiscoverOptions {
  excludes?: readonly string[];
  maxFiles?: number;       // cap on files scanned for LOC/imports/todos
  maxFileBytes?: number;   // skip reading files larger than this
  maxTreeDepth?: number;   // depth for the rendered directory tree
}

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".rs", ".java",
  ".kt", ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift", ".scala",
]);

const EXT_LANG: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".go": "Go", ".py": "Python", ".rs": "Rust",
  ".java": "Java", ".kt": "Kotlin", ".rb": "Ruby", ".php": "PHP", ".cs": "C#",
  ".swift": "Swift", ".scala": "Scala", ".c": "C", ".cpp": "C++", ".cc": "C++",
};

const TODO_RE = /\b(TODO|FIXME|HACK|XXX|DEPRECATED)\b/;

export function discoverRepo(root: string, opts: DiscoverOptions = {}): RepoInventory {
  const excludes = new Set(opts.excludes ?? DEFAULT_EXCLUDES);
  const maxFiles = opts.maxFiles ?? 4000;
  const maxFileBytes = opts.maxFileBytes ?? 2_000_000;
  const maxTreeDepth = opts.maxTreeDepth ?? 4;
  const absRoot = path.resolve(root);

  const allFiles: string[] = [];
  walk(absRoot, absRoot, excludes, allFiles);
  allFiles.sort();

  const git = resolveGit(absRoot);

  // Classify files.
  const build_files: string[] = [];
  const config_files: string[] = [];
  const test_files: string[] = [];
  const ci_files: string[] = [];
  const docs: string[] = [];
  const langCount = new Map<string, number>();

  for (const rel of allFiles) {
    const base = path.basename(rel).toLowerCase();
    const ext = path.extname(rel).toLowerCase();
    if (EXT_LANG[ext]) langCount.set(EXT_LANG[ext], (langCount.get(EXT_LANG[ext]) ?? 0) + 1);
    if (isCi(rel)) ci_files.push(rel);
    if (isBuildManifest(base)) build_files.push(rel);
    if (isConfig(base, ext)) config_files.push(rel);
    if (isTest(rel)) test_files.push(rel);
    if (isDoc(base, ext)) docs.push(rel);
  }

  const languages = [...langCount.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const package_managers = detectPackageManagers(absRoot, allFiles);
  const frameworks = detectFrameworks(absRoot, allFiles);
  const entry_points = detectEntryPoints(absRoot, allFiles);
  const commands = parseCommands(absRoot, allFiles, package_managers);

  // Bounded content scans (largest files, TODOs, import edges).
  const scanTargets = allFiles.filter((f) => SOURCE_EXTS.has(path.extname(f).toLowerCase())).slice(0, maxFiles);
  const facts: FileFact[] = [];
  const todo_markers: TodoMarker[] = [];
  const import_edges: ImportEdge[] = [];

  for (const rel of scanTargets) {
    const abs = path.join(absRoot, rel);
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > maxFileBytes) { facts.push({ path: rel, loc: -1, ext: path.extname(rel) }); continue; }
    let text = "";
    try { text = fs.readFileSync(abs, "utf-8"); } catch { continue; }
    const lines = text.split("\n");
    facts.push({ path: rel, loc: lines.length, ext: path.extname(rel) });
    scanTodos(rel, lines, todo_markers);
    scanImports(rel, text, allFiles, import_edges);
  }

  const largest_files = facts.filter((f) => f.loc >= 0).sort((a, b) => b.loc - a.loc).slice(0, 25);

  const generated_or_vendored_paths = [...excludes].filter((e) => fs.existsSync(path.join(absRoot, e))).sort();

  return {
    root: absRoot,
    git,
    languages,
    package_managers,
    frameworks,
    entry_points,
    build_files: build_files.sort(),
    config_files: config_files.sort(),
    test_files: test_files.sort(),
    ci_files: ci_files.sort(),
    docs: docs.sort(),
    generated_or_vendored_paths,
    largest_files,
    todo_markers: todo_markers.slice(0, 500),
    import_edges,
    commands,
    file_count: allFiles.length,
    all_paths: allFiles,
    directory_tree: renderTree(absRoot, excludes, maxTreeDepth),
  };
}

// ── walking ──────────────────────────────────────────────────────────────────

function walk(dir: string, root: string, excludes: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (excludes.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(abs, root, excludes, out);
    else if (e.isFile()) out.push(path.relative(root, abs));
  }
}

function resolveGit(root: string): RepoInventory["git"] {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (head === null) return { isRepo: false, head: null, dirty: [] };
  const status = git(root, ["status", "--porcelain"]) ?? "";
  const dirty = status.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ""));
  return { isRepo: true, head: head.trim(), dirty: dirty.sort() };
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0 || r.error) return null;
  return r.stdout;
}

// ── classification ───────────────────────────────────────────────────────────

function isCi(rel: string): boolean {
  return rel.startsWith(".github/workflows/") || rel.startsWith(".gitlab") ||
    rel === ".circleci/config.yml" || /(^|\/)azure-pipelines\.ya?ml$/.test(rel) ||
    /(^|\/)\.travis\.ya?ml$/.test(rel) || /(^|\/)Jenkinsfile$/.test(rel);
}
function isBuildManifest(base: string): boolean {
  return new Set([
    "package.json", "pnpm-workspace.yaml", "turbo.json", "makefile", "pyproject.toml",
    "requirements.txt", "poetry.lock", "cargo.toml", "go.mod", "pom.xml", "build.gradle",
    "build.gradle.kts", "setup.py", "setup.cfg", "gemfile", "composer.json",
  ]).has(base);
}
function isConfig(base: string, ext: string): boolean {
  if (new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env"]).has(ext)) {
    return !base.endsWith("package.json"); // build manifest, not generic config
  }
  return base.startsWith(".eslintrc") || base.startsWith("tsconfig") || base === ".prettierrc" || base.startsWith(".env");
}
function isTest(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)/.test(rel) ||
    /\.(test|spec)\.[a-z]+$/.test(rel) || /_test\.(go|py)$/.test(rel) || /test_.*\.py$/.test(path.basename(rel));
}
function isDoc(base: string, ext: string): boolean {
  return ext === ".md" || ext === ".mdx" || ext === ".rst" || base === "readme";
}

function detectPackageManagers(root: string, files: string[]): string[] {
  const pm = new Set<string>();
  const has = (p: string) => files.includes(p) || fs.existsSync(path.join(root, p));
  if (has("package-lock.json")) pm.add("npm");
  if (has("pnpm-lock.yaml")) pm.add("pnpm");
  if (has("yarn.lock")) pm.add("yarn");
  if (has("bun.lockb")) pm.add("bun");
  if (files.some((f) => path.basename(f) === "go.mod")) pm.add("go modules");
  if (files.some((f) => path.basename(f) === "Cargo.toml")) pm.add("cargo");
  if (files.some((f) => /requirements\.txt|pyproject\.toml|poetry\.lock/.test(path.basename(f)))) pm.add("pip/poetry");
  if (pm.size === 0 && files.some((f) => path.basename(f) === "package.json")) pm.add("npm");
  return [...pm].sort();
}

function detectFrameworks(root: string, files: string[]): string[] {
  const fw = new Set<string>();
  const pkgPath = firstFile(files, "package.json");
  if (pkgPath) {
    const pkg = readJson(path.join(root, pkgPath));
    const deps = { ...(asObj(pkg?.dependencies)), ...(asObj(pkg?.devDependencies)) };
    const map: Record<string, string> = {
      react: "React", next: "Next.js", vue: "Vue", nuxt: "Nuxt", "@angular/core": "Angular",
      svelte: "Svelte", express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS",
      vite: "Vite", webpack: "webpack", jest: "Jest", vitest: "Vitest", "@playwright/test": "Playwright",
    };
    for (const [dep, label] of Object.entries(map)) if (dep in deps) fw.add(label);
  }
  if (files.some((f) => path.basename(f) === "go.mod")) {
    const gomod = readText(path.join(root, firstFile(files, "go.mod") ?? "go.mod"));
    if (/gin-gonic\/gin/.test(gomod)) fw.add("Gin");
    if (/labstack\/echo/.test(gomod)) fw.add("Echo");
  }
  return [...fw].sort();
}

function detectEntryPoints(root: string, files: string[]): string[] {
  const eps = new Set<string>();
  const pkgPath = firstFile(files, "package.json");
  if (pkgPath) {
    const pkg = readJson(path.join(root, pkgPath));
    for (const k of ["main", "module", "bin"]) {
      const v = pkg?.[k];
      if (typeof v === "string") eps.add(normRel(pkgPath, v));
      else if (isObjLike(v)) for (const b of Object.values(v)) if (typeof b === "string") eps.add(normRel(pkgPath, b));
    }
  }
  for (const f of files) {
    const b = path.basename(f);
    if (/^(index|main|app|server|cli)\.(ts|tsx|js|mjs|go|py)$/.test(b)) eps.add(f);
    if (f.startsWith("cmd/") && b === "main.go") eps.add(f);
    if (b === "__main__.py") eps.add(f);
  }
  return [...eps].sort();
}

// ── command discovery (deterministic seed) ───────────────────────────────────

function parseCommands(root: string, files: string[], pms: string[]): CommandSet {
  const out: CommandSet = {
    install_command: "unknown", test_command: "unknown", lint_command: "unknown",
    typecheck_command: "unknown", build_command: "unknown", format_command: "unknown",
  };
  const runner = pms.includes("pnpm") ? "pnpm" : pms.includes("yarn") ? "yarn" : pms.includes("bun") ? "bun" : "npm";

  const pkgPath = firstFile(files, "package.json");
  if (pkgPath) {
    const pkg = readJson(path.join(root, pkgPath));
    const scripts = asObj(pkg?.scripts);
    const runScript = (name: string) => (runner === "npm" ? `npm run ${name}` : `${runner} ${name}`);
    if ("test" in scripts) out.test_command = runScript("test");
    for (const name of ["lint", "eslint"]) if (name in scripts) { out.lint_command = runScript(name); break; }
    for (const name of ["typecheck", "type-check", "tsc"]) if (name in scripts) { out.typecheck_command = runScript(name); break; }
    for (const name of ["build", "compile"]) if (name in scripts) { out.build_command = runScript(name); break; }
    for (const name of ["format", "fmt", "prettier"]) if (name in scripts) { out.format_command = runScript(name); break; }
    out.install_command = runner === "npm" ? "npm install" : `${runner} install`;
  }

  if (files.some((f) => path.basename(f) === "go.mod")) {
    if (out.test_command === "unknown") out.test_command = "go test ./...";
    if (out.build_command === "unknown") out.build_command = "go build ./...";
    if (out.format_command === "unknown") out.format_command = "gofmt -w .";
    if (out.install_command === "unknown") out.install_command = "go mod download";
  }
  if (files.some((f) => path.basename(f) === "Cargo.toml")) {
    if (out.test_command === "unknown") out.test_command = "cargo test";
    if (out.build_command === "unknown") out.build_command = "cargo build";
    if (out.format_command === "unknown") out.format_command = "cargo fmt";
  }
  if (files.some((f) => /requirements\.txt|pyproject\.toml/.test(path.basename(f)))) {
    if (out.install_command === "unknown") {
      out.install_command = files.some((f) => path.basename(f) === "pyproject.toml") ? "pip install -e ." : "pip install -r requirements.txt";
    }
    if (out.test_command === "unknown") out.test_command = "pytest";
  }
  return out;
}

// ── content scans ────────────────────────────────────────────────────────────

function scanTodos(rel: string, lines: string[], out: TodoMarker[]): void {
  for (let i = 0; i < lines.length; i++) {
    const m = TODO_RE.exec(lines[i]);
    if (m) out.push({ path: rel, line: i + 1, marker: m[1], text: lines[i].trim().slice(0, 200) });
  }
}

const IMPORT_RES: RegExp[] = [
  /^\s*import\s+(?:[^'"]+\s+from\s+)?["']([^"']+)["']/gm,        // ts/js import ... from "x"
  /\brequire\(\s*["']([^"']+)["']\s*\)/gm,                       // require("x")
  /^\s*from\s+["']([^"']+)["']/gm,                              // ts re-export
];

function scanImports(rel: string, text: string, files: string[], out: ImportEdge[]): void {
  const fileSet = new Set(files);
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue; // external/stdlib — out of scope for the intra-repo graph
      const resolved = resolveRelImport(rel, spec, fileSet);
      if (resolved) out.push({ from: rel, to: resolved });
    }
  }
}

function resolveRelImport(fromRel: string, spec: string, fileSet: Set<string>): string | null {
  const baseDir = path.dirname(fromRel);
  const target = path.normalize(path.join(baseDir, spec));
  const candidates = [
    target,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((e) => target + e),
    ...[".ts", ".tsx", ".js", ".jsx"].map((e) => path.join(target, "index" + e)),
  ];
  for (const cand of candidates) {
    const norm = cand.split(path.sep).join("/");
    if (fileSet.has(norm)) return norm;
  }
  return null;
}

// ── tree rendering ───────────────────────────────────────────────────────────

function renderTree(root: string, excludes: Set<string>, maxDepth: number): string {
  const lines: string[] = [];
  const recur = (dir: string, prefix: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter((e) => e.isDirectory() && !excludes.has(e.name)).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      lines.push(`${prefix}${d.name}/`);
      recur(path.join(dir, d.name), prefix + "  ", depth + 1);
    }
  };
  recur(root, "", 1);
  return lines.slice(0, 400).join("\n");
}

// ── small helpers ────────────────────────────────────────────────────────────

function firstFile(files: string[], base: string): string | undefined {
  // Prefer a root-level manifest, else the shallowest.
  const matches = files.filter((f) => path.basename(f) === base).sort((a, b) => a.split("/").length - b.split("/").length);
  return matches[0];
}
function readText(p: string): string { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } }
function readJson(p: string): Record<string, unknown> | null {
  try { const v = JSON.parse(fs.readFileSync(p, "utf-8")); return isObjLike(v) ? v : null; } catch { return null; }
}
function asObj(v: unknown): Record<string, unknown> { return isObjLike(v) ? v : {}; }
function isObjLike(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v); }
function normRel(manifestRel: string, p: string): string {
  return path.normalize(path.join(path.dirname(manifestRel), p)).split(path.sep).join("/");
}
