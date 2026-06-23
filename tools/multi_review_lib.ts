/**
 * Multi-agent PR review orchestrator — TypeScript port of
 * `scripts/multi_review.py`.
 *
 * Runs up to 3 CLI agents (Claude, Codex, Gemini) across the discovered
 * review domains. Each agent posts a consolidated review via its GitHub
 * App, grouped by domain.
 *
 * The Python imported claude/codex/gemini_utils + runtime_env +
 * dispatcher_base + _emit; this port imports their TS ports.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildClaudeCmd } from "./claude_utils_lib.ts";
import { CODEX_REASONING_EFFORT_XHIGH, parseJsonlOutput } from "./codex_utils_lib.ts";
import {
  AGENTS,
  discoverConfig,
  discoverDomains,
  resolveModel,
  resolvePrompt as baseResolvePrompt,
} from "./dispatcher_base_lib.ts";
import {
  makeGeminiEnv,
  parseJsonOutput as parseGeminiOutput,
  setupGeminiHome,
  shouldFallbackToApiKey,
  tryGeminiApiKeyFallback,
} from "./gemini_utils_lib.ts";
import { getToken, resolveAppName } from "./github_app_lib.ts";
import { buildAgentEnv } from "./runtime_env_lib.ts";
import { isAgentEnabled } from "./stark_config_lib.ts";

// ── Config ────────────────────────────────────────────────────────────────

export function globalPromptsDir(): string {
  return path.join(os.homedir(), ".claude", "code-review", "prompts");
}

export const CODEX_REASONING_CONFIG = CODEX_REASONING_EFFORT_XHIGH;

/** Discovered PR review domains (delegates to dispatcher_base). */
export function discoverReviewDomains(): Record<string, DomainInfo> {
  return discoverDomains(globalPromptsDir(), Object.keys(AGENTS));
}

interface DomainInfo {
  order: string;
  label: string;
  filename: string;
}

/** Import-time domain snapshot (Python parity — `DOMAINS` was module-level). */
export const DOMAINS: Record<string, DomainInfo> = discoverReviewDomains();

export type Logger = (msg: string) => void;

function agentModelLabel(agent: string): string {
  try {
    return resolveModel(agent);
  } catch (exc) {
    return `<unresolved: ${(exc as Error).message}>`;
  }
}

function printModelsInUse(agents: string[], log: Logger): void {
  log("  Models in use:");
  for (const agent of agents) log(`    - ${agent}: ${agentModelLabel(agent)}`);
}

// ── Spec extraction ─────────────────────────────────────────────────────

/** Extract a spec link from a PR description. Returns path/URL, 'N/A', or null. */
export function extractSpecLink(prBody: string | null | undefined): string | null {
  if (!prBody) return null;
  const match = prBody.match(/##\s*Spec:\s*(.+)/);
  if (!match) return null;
  const value = match[1].trim();
  if (!value || value.startsWith("<!--")) return null;
  return value;
}

/** Read spec file content. Returns the content or null if unresolvable. */
export function resolveSpecContent(specLink: string, cwd: string): string | null {
  if (specLink === "N/A") return null;
  if (specLink.startsWith("http")) return null;
  const specPath = path.join(cwd, specLink);
  try {
    if (fs.statSync(specPath).isFile()) return fs.readFileSync(specPath, "utf8");
  } catch {
    // not a file
  }
  return null;
}

function globFiles(root: string, pattern: string): string[] {
  // Minimal glob: supports `**`, `*`, and literal segments — enough for the
  // context_files config patterns (e.g. "docs/**/*.md", "spec.md").
  const segments = pattern.split("/");
  let candidates = [root];
  for (const seg of segments) {
    const next: string[] = [];
    for (const dir of candidates) {
      if (seg === "**") {
        next.push(dir, ...walkDirs(dir));
      } else if (seg.includes("*")) {
        const re = new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) if (re.test(e.name)) next.push(path.join(dir, e.name));
      } else {
        const p = path.join(dir, seg);
        if (fs.existsSync(p)) next.push(p);
      }
    }
    candidates = next;
  }
  return candidates.sort();
}

function walkDirs(root: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const full = path.join(root, e.name);
      out.push(full, ...walkDirs(full));
    }
  }
  return out;
}

/** Resolve context_files glob patterns into concatenated content, or null. */
export function resolveContextFiles(patterns: string[], cwd: string): string | null {
  if (!patterns || patterns.length === 0) return null;
  const matched: Array<[string, string]> = [];
  for (const pattern of patterns) {
    for (const p of globFiles(cwd, pattern)) {
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.size < 200_000) {
          matched.push([path.relative(cwd, p), fs.readFileSync(p, "utf8")]);
        }
      } catch {
        continue;
      }
    }
  }
  if (matched.length === 0) return null;
  const sections = matched.map(([rel, content]) => `### ${rel}\n\n${content}`);
  return (
    "## Context Files\nThe following files from the repo provide architectural context:\n\n" +
    sections.join("\n\n---\n\n")
  );
}

// ── Constants ────────────────────────────────────────────────────────────

export const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};
const SEVERITY_ICONS: Record<string, string> = {
  critical: "\u{1f534}",
  high: "\u{1f7e0}",
  medium: "\u{1f7e1}",
  low: "\u{1f535}",
};

export const FINDINGS_FORMAT =
  "Output findings as a JSON array. Each finding: " +
  '{"severity": "critical|high|medium|low", "file": "path/to/file", ' +
  '"line": 42, "title": "short title", "description": "what is wrong", ' +
  '"suggestion": "how to fix it"}. ' +
  "If no issues found, return an empty array []. " +
  "Output ONLY the JSON array, no other text.";

const MAX_GEMINI_CONCURRENT = 3;

// ── Async semaphore (gemini concurrency limiter) ─────────────────────────

class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) {
    this.permits = permits;
  }
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.permits += 1;
  }
}

const geminiSemaphore = new Semaphore(MAX_GEMINI_CONCURRENT);

// ── Git ref resolution ───────────────────────────────────────────────────

const QUALIFIED_REF_PREFIXES = ["refs/", "origin/", "remotes/"];
const GIT_REV_KEYWORDS = new Set(["HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD"]);
const REV_EXPRESSION_CHARS = ["~", "^", "@{"];

/** Resolve `base` to a ref stable across stale local branches. */
export function resolveBaseRef(base: string, cwd?: string): string {
  if (!base) return base;
  if (QUALIFIED_REF_PREFIXES.some((p) => base.startsWith(p))) return base;
  if (GIT_REV_KEYWORDS.has(base)) return base;
  if (REV_EXPRESSION_CHARS.some((ch) => base.includes(ch))) return base;
  try {
    const r = spawnSync(
      "git",
      ["rev-parse", "--verify", "--quiet", `origin/${base}`],
      { encoding: "utf8", timeout: 10_000, cwd },
    );
    if (r.status === 0 && (r.stdout ?? "").trim()) return `origin/${base}`;
  } catch {
    // fall through
  }
  return base;
}

/** Diff (fileCount, lineCount) for adaptive timeout. (0,0) on failure. */
export function getDiffStats(base: string, cwd?: string): [number, number] {
  try {
    const resolved = resolveBaseRef(base, cwd);
    const r = spawnSync("git", ["diff", "--shortstat", `${resolved}...HEAD`], {
      encoding: "utf8",
      timeout: 30_000,
      cwd,
    });
    if (r.status !== 0 || !(r.stdout ?? "").trim()) return [0, 0];
    const text = r.stdout.trim();
    const files = text.match(/(\d+)\s+files?\s+changed/);
    const ins = text.match(/(\d+)\s+insertions?/);
    const del = text.match(/(\d+)\s+deletions?/);
    const fileCount = files ? Number(files[1]) : 0;
    const insertions = ins ? Number(ins[1]) : 0;
    const deletions = del ? Number(del[1]) : 0;
    return [fileCount, insertions + deletions];
  } catch {
    return [0, 0];
  }
}

/** Set of files changed on HEAD since the merge-base with `base`. */
export function getChangedFiles(base: string, cwd?: string): Set<string> {
  try {
    const resolved = resolveBaseRef(base, cwd);
    const r = spawnSync("git", ["diff", "--name-only", `${resolved}...HEAD`], {
      encoding: "utf8",
      timeout: 30_000,
      cwd,
    });
    if (r.status !== 0) return new Set();
    return new Set(
      (r.stdout ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/** Split findings into (kept, dropped) by whether `file` is in `changedFiles`. */
export function filterOutOfDiffFindings(
  findings: Finding[],
  changedFiles: Set<string>,
): [Finding[], Finding[]] {
  if (changedFiles.size === 0) return [[...findings], []];
  const kept: Finding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    if (!f.file || changedFiles.has(f.file)) kept.push(f);
    else dropped.push(f);
  }
  return [kept, dropped];
}

function adaptiveTimeout(
  agent: string,
  fileCount: number,
  lineCount: number,
  config: Record<string, unknown>,
): number {
  const runtime = (config["runtime"] as Record<string, unknown>) ?? {};
  const fileThreshold = Number(runtime["large_pr_file_threshold"] ?? 40);
  const lineThreshold = Number(runtime["large_pr_line_threshold"] ?? 3000);
  const largeTimeout = Number(runtime["large_pr_timeout_s"] ?? 1800);
  const defaultTimeout = agent === "gemini" ? 600 : 900;
  if (fileCount >= fileThreshold || lineCount >= lineThreshold) {
    return Math.max(defaultTimeout, largeTimeout);
  }
  return defaultTimeout;
}

// ── Data structures ──────────────────────────────────────────────────────

export interface Finding {
  agent: string;
  domain: string;
  severity: string;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestion: string;
  classification: string | null;
  classification_reason: string | null;
  cross_validated_by: string[];
  fixed_in_round: number | null;
  fix_verified: boolean | null;
}

export function makeFinding(init: {
  agent: string;
  domain: string;
  severity: string;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestion: string;
}): Finding {
  return {
    ...init,
    classification: null,
    classification_reason: null,
    cross_validated_by: [],
    fixed_in_round: null,
    fix_verified: null,
  };
}

export interface SubAgentResult {
  agent: string;
  domain: string;
  raw_output: string;
  model: string;
  findings: Finding[];
  error: string | null;
  duration_s: number;
  api_key_fallback: boolean;
}

function makeSubAgentResult(init: Partial<SubAgentResult> & { agent: string; domain: string }): SubAgentResult {
  return {
    raw_output: "",
    model: "",
    findings: [],
    error: null,
    duration_s: 0.0,
    api_key_fallback: false,
    ...init,
  };
}

export interface ReviewRound {
  round_num: number;
  results: SubAgentResult[];
}

// ── Prompt loading ───────────────────────────────────────────────────────

/** Walk from `cwd` up to $HOME for a dir containing `.code-review/prompts/`. */
export function findRepoRoot(cwd?: string): string | null {
  const start = cwd ?? process.cwd();
  let home: string;
  try {
    home = fs.realpathSync(os.homedir());
  } catch {
    home = os.homedir();
  }
  let current: string;
  try {
    current = fs.realpathSync(start);
  } catch {
    current = path.resolve(start);
  }
  while (current !== home && current !== path.dirname(current)) {
    try {
      if (fs.statSync(path.join(current, ".code-review", "prompts")).isDirectory()) {
        return current;
      }
    } catch {
      // not here
    }
    current = path.dirname(current);
  }
  return null;
}

export function resolvePrompt(
  agent: string,
  filename: string,
  cwd?: string,
  promptsDirOverride?: string,
): string {
  const promptsDir = promptsDirOverride ?? globalPromptsDir();
  const repoRoot = findRepoRoot(cwd);
  return baseResolvePrompt(agent, filename, promptsDir, repoRoot);
}

function loadAgentPreamble(agent: string, cwd?: string): string {
  return resolvePrompt(agent, "agent.md", cwd);
}

function loadDomainPrompt(agent: string, domainKey: string, cwd: string | undefined, log: Logger): string {
  const domain = DOMAINS[domainKey];
  if (!domain) return `Review this code for ${domainKey} issues. ${FINDINGS_FORMAT}`;
  const content = resolvePrompt(agent, domain.filename, cwd);
  if (content) return content;
  for (const fallbackAgent of Object.keys(AGENTS)) {
    if (fallbackAgent === agent) continue;
    const fb = resolvePrompt(fallbackAgent, domain.filename, cwd);
    if (fb) {
      log(`  [!] Using ${fallbackAgent}'s prompt for ${agent}/${domainKey}`);
      return fb;
    }
  }
  return `Review this code for ${domainKey} issues. ${FINDINGS_FORMAT}`;
}

// ── Repo detection ───────────────────────────────────────────────────────

/** Detect GitHub org/repo from `git remote get-url origin`. */
export function detectRepo(cwd?: string): string {
  try {
    const r = spawnSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      timeout: 5000,
      cwd,
    });
    if (r.status !== 0) return "";
    const url = (r.stdout ?? "").trim();
    let m = url.match(/^git@[\w.-]+:(.+?)(?:\.git)?$/);
    if (m) return m[1];
    m = url.match(/^https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    // fall through
  }
  return "";
}

/** Detect the base branch from origin/HEAD or common default names. */
export function detectBaseBranch(cwd?: string): string {
  try {
    const headRef = spawnSync(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { encoding: "utf8", timeout: 5000, cwd },
    );
    if (headRef.status === 0) {
      const ref = (headRef.stdout ?? "").trim();
      if (ref.startsWith("origin/") && ref !== "origin/HEAD") {
        return ref.split("/").slice(1).join("/");
      }
    }
    const refsResult = spawnSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"],
      { encoding: "utf8", timeout: 5000, cwd },
    );
    if (refsResult.status === 0) {
      const refs = new Set<string>();
      for (const line of (refsResult.stdout ?? "").split("\n")) {
        const t = line.trim();
        if (!t || t === "origin/HEAD") continue;
        refs.add(t.startsWith("origin/") ? t.split("/").slice(1).join("/") : t);
      }
      for (const candidate of ["main", "master", "trunk", "develop", "development"]) {
        if (refs.has(candidate)) return candidate;
      }
    }
  } catch {
    // fall through
  }
  throw new Error(
    "Could not detect base branch from origin/HEAD or known default branch names. " +
      "Pass --base explicitly.",
  );
}

// ── GitHub App auth ──────────────────────────────────────────────────────

async function getGhToken(app: string): Promise<string> {
  return getToken({ app: resolveAppName(app) });
}

/** Post a PR review comment via the specified GitHub App. */
export async function postReview(
  repo: string,
  prNumber: number,
  app: string,
  body: string,
  log: Logger,
): Promise<boolean> {
  let token: string;
  try {
    token = await getGhToken(app);
  } catch (e) {
    log(`  [!] Auth failed for ${app}: ${(e as Error).message}`);
    return false;
  }
  const r = await runProcess(
    "gh",
    [
      "api",
      `repos/${repo}/pulls/${prNumber}/reviews`,
      "--method",
      "POST",
      "-f",
      "event=COMMENT",
      "-f",
      `body=${body}`,
    ],
    { timeoutMs: 30_000, env: { ...process.env, GH_TOKEN: token } as Record<string, string> },
  );
  if (r.status !== 0) {
    log(`  [!] Failed to post review as ${app}: ${r.stderr}`);
    return false;
  }
  return true;
}

/** Get open PRs (full objects) for a repo. */
export async function getOpenPrs(repo: string): Promise<Array<Record<string, unknown>>> {
  const token = await getGhToken("stark-claude");
  const env = { ...process.env, GH_TOKEN: token } as Record<string, string>;
  const list = await runProcess(
    "gh",
    ["api", `repos/${repo}/pulls`, "--jq", ".[].number"],
    { timeoutMs: 30_000, env },
  );
  if (list.status !== 0) return [];
  const numbers = list.stdout
    .trim()
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean)
    .map(Number);
  const prs: Array<Record<string, unknown>> = [];
  for (const num of numbers) {
    const pr = await runProcess("gh", ["api", `repos/${repo}/pulls/${num}`], {
      timeoutMs: 30_000,
      env,
    });
    if (pr.status === 0) {
      try {
        prs.push(JSON.parse(pr.stdout) as Record<string, unknown>);
      } catch {
        // skip
      }
    }
  }
  return prs;
}

// ── Subprocess helper ────────────────────────────────────────────────────

interface ProcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runProcess(
  cmd: string,
  args: string[],
  opts: {
    input?: string;
    timeoutMs: number;
    env?: Record<string, string>;
    cwd?: string;
  },
): Promise<ProcResult> {
  return await new Promise<ProcResult>((resolve) => {
    const child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    let closed: ProcResult | null = null;
    const tryFinish = () => {
      if (settled) return;
      if (closed === null) return;
      if (!stdoutEnded || !stderrEnded) return;
      settled = true;
      clearTimeout(timer);
      resolve(closed);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    if (child.stdout) child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
    else stdoutEnded = true;
    if (child.stderr) child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
    else stderrEnded = true;
    child.on("error", (err) => {
      stdoutEnded = true;
      stderrEnded = true;
      closed = { status: null, stdout, stderr: stderr || String(err), timedOut };
      tryFinish();
    });
    child.on("close", (code) => {
      closed = { status: code, stdout, stderr, timedOut };
      tryFinish();
    });
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

// ── Findings parser ──────────────────────────────────────────────────────

export class FindingsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingsParseError";
  }
}

/** Scan `text` for the first balanced, parseable JSON array. */
function findJsonArrayAt(text: string, startIdx: number): unknown[] | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(startIdx, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractFindingsPayload(cleaned: string): unknown[] {
  if (cleaned.startsWith("[")) {
    let payload: unknown;
    try {
      payload = JSON.parse(cleaned);
    } catch (exc) {
      throw new FindingsParseError(`invalid JSON array: ${(exc as Error).message}`);
    }
    if (Array.isArray(payload)) return payload;
    throw new FindingsParseError(`expected JSON array, got ${typeof payload}`);
  }
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] !== "[") continue;
    const arr = findJsonArrayAt(cleaned, i);
    if (arr !== null) return arr;
  }
  throw new FindingsParseError("no JSON findings array found in reviewer output");
}

export function parseFindings(agent: string, domain: string, raw: string): Finding[] {
  let cleaned = raw.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  } else {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "");
    cleaned = cleaned.replace(/\n?```\s*$/, "");
  }

  // Gemini double-encoded JSON (escaped content inside a JSON string).
  if (cleaned.includes("\\n") && cleaned.startsWith('"')) {
    try {
      const decoded = JSON.parse(cleaned);
      if (typeof decoded === "string") cleaned = decoded;
    } catch {
      // leave as-is
    }
  }

  const items = extractFindingsPayload(cleaned);
  const findings: Finding[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const it = item as Record<string, unknown>;
    findings.push(
      makeFinding({
        agent,
        domain,
        severity: String(it.severity ?? "medium").toLowerCase(),
        file: String(it.file ?? "unknown"),
        line: Number.parseInt(String(it.line ?? 0), 10) || 0,
        title: String(it.title ?? "Untitled"),
        description: String(it.description ?? ""),
        suggestion: String(it.suggestion ?? ""),
      }),
    );
  }
  return findings;
}

/** Apply severity_overrides config — min_severity + title_patterns capping. */
export function applySeverityOverrides(
  findings: Finding[],
  overrides: Record<string, Record<string, unknown>>,
): Finding[] {
  for (const f of findings) {
    const domainOverride = overrides[f.domain];
    if (!domainOverride) continue;
    const minSev = domainOverride["min_severity"] as string | undefined;
    if (
      minSev &&
      (SEVERITY_ORDER[f.severity] ?? 99) > (SEVERITY_ORDER[minSev] ?? 99)
    ) {
      f.severity = "low";
    }
    const titlePats = (domainOverride["title_patterns"] as Record<string, Record<string, unknown>>) ?? {};
    const titleLower = f.title.toLowerCase();
    const descLower = f.description.toLowerCase();
    for (const [pattern, rule] of Object.entries(titlePats)) {
      const pl = pattern.toLowerCase();
      if (titleLower.includes(pl) || descLower.includes(pl)) {
        const maxSev = (rule["max_severity"] as string) ?? "low";
        if ((SEVERITY_ORDER[f.severity] ?? 99) < (SEVERITY_ORDER[maxSev] ?? 99)) {
          f.severity = maxSev;
        }
        break;
      }
    }
  }
  return findings;
}

// ── Deduplication ────────────────────────────────────────────────────────

function dedupKey(f: Finding): string {
  const lineBucket = Math.floor(f.line / 5);
  const titleNorm = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `${f.file} ${lineBucket} ${titleNorm}`;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "in", "on", "of", "for", "to", "and", "or", "not", "no", "be",
]);

function titleWords(title: string): Set<string> {
  const norm = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return new Set(norm.split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w)));
}

function titlesOverlap(a: string, b: string, threshold = 0.5): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter += 1;
  const union = new Set([...wa, ...wb]).size;
  return inter / union >= threshold;
}

/** Collapse duplicate findings across agents/domains. */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  // Pass 1: exact key grouping.
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = dedupKey(f);
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const intermediates = [...groups.values()];

  // Pass 2: merge groups close in location + similar in title.
  const merged: Finding[][] = [];
  const used = new Array(intermediates.length).fill(false);
  for (let i = 0; i < intermediates.length; i++) {
    if (used[i]) continue;
    const combined = [...intermediates[i]];
    const repA = intermediates[i][0];
    for (let j = i + 1; j < intermediates.length; j++) {
      if (used[j]) continue;
      const repB = intermediates[j][0];
      if (repA.file !== repB.file) continue;
      if (Math.abs(repA.line - repB.line) > 5) continue;
      if (titlesOverlap(repA.title, repB.title)) {
        combined.push(...intermediates[j]);
        used[j] = true;
      }
    }
    used[i] = true;
    merged.push(combined);
  }

  // Pass 3: cross-agent collapse on exact file+line.
  const locGroups = new Map<string, number[]>();
  for (let idx = 0; idx < merged.length; idx++) {
    const rep = merged[idx][0];
    if (rep.line === 0) continue;
    const locKey = `${rep.file} ${rep.line}`;
    const arr = locGroups.get(locKey);
    if (arr) arr.push(idx);
    else locGroups.set(locKey, [idx]);
  }
  const finalMerged: Finding[][] = [];
  const usedFinal = new Array(merged.length).fill(false);
  for (const indices of locGroups.values()) {
    if (indices.length > 1) {
      const agentsInGroups = new Set<string>();
      for (const idx of indices) for (const f of merged[idx]) agentsInGroups.add(f.agent);
      if (agentsInGroups.size > 1) {
        const combinedGroup: Finding[] = [];
        for (const idx of indices) {
          combinedGroup.push(...merged[idx]);
          usedFinal[idx] = true;
        }
        finalMerged.push(combinedGroup);
        continue;
      }
    }
    for (const idx of indices) {
      if (!usedFinal[idx]) {
        usedFinal[idx] = true;
        finalMerged.push(merged[idx]);
      }
    }
  }
  for (let idx = 0; idx < merged.length; idx++) {
    if (!usedFinal[idx]) finalMerged.push(merged[idx]);
  }

  const deduped: Finding[] = [];
  for (const group of finalMerged) {
    group.sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 99) - (SEVERITY_ORDER[y.severity] ?? 99));
    const best: Finding = { ...group[0], cross_validated_by: [...group[0].cross_validated_by] };
    if (group.length > 1) {
      const seen = new Set<string>();
      const confirmers: string[] = [];
      for (const f of group.slice(1)) {
        const label = `${f.agent}/${f.domain}`;
        if (!seen.has(label)) {
          seen.add(label);
          confirmers.push(label);
        }
      }
      if (confirmers.length > 0) {
        best.description += ` (also flagged by: ${confirmers.join(", ")})`;
        best.cross_validated_by = [...seen];
      }
    }
    deduped.push(best);
  }
  return deduped.sort(
    (x, y) => (SEVERITY_ORDER[x.severity] ?? 99) - (SEVERITY_ORDER[y.severity] ?? 99),
  );
}

/** All findings from a round, deduplicated and severity-sorted. */
export function allFindings(rnd: ReviewRound): Finding[] {
  const findings: Finding[] = [];
  for (const result of rnd.results) findings.push(...result.findings);
  return deduplicateFindings(findings);
}

/** True if a round has critical/high/medium findings. */
export function hasActionableFindings(rnd: ReviewRound): boolean {
  return allFindings(rnd).some((f) => ["critical", "high", "medium"].includes(f.severity));
}

// ── Formatting ───────────────────────────────────────────────────────────

/** Format one agent's domain findings as a GitHub PR review body. */
export function formatAgentReviewBody(agent: string, rnd: ReviewRound): string {
  const agentCfg = AGENTS[agent];
  const agentResults = rnd.results.filter((r) => r.agent === agent);
  if (agentResults.length === 0) return "";

  const lines = [
    `## ${agentCfg.emoji} ${agentCfg.label} Review (Round ${rnd.round_num})`,
    "",
    `*${agentResults.length} domain sub-agents dispatched*`,
    "",
  ];

  const totalFindings = agentResults.reduce((s, r) => s + r.findings.length, 0);
  if (totalFindings === 0 && !agentResults.some((r) => r.error)) {
    lines.push("> No issues found across any domain.");
    return lines.join("\n");
  }

  const sorted = [...agentResults].sort(
    (a, b) =>
      (DOMAINS[a.domain]?.order ?? "99").localeCompare(DOMAINS[b.domain]?.order ?? "99"),
  );

  for (const result of sorted) {
    const domainCfg = DOMAINS[result.domain] ?? { label: result.domain };
    lines.push(`### ${domainCfg.label}`, "");
    if (result.error) {
      lines.push(`> **Error:** ${result.error}`, "");
      continue;
    }
    if (result.findings.length === 0) {
      lines.push("> Clean.", "");
      continue;
    }
    const bySeverity = new Map<string, Finding[]>();
    const sortedFindings = [...result.findings].sort(
      (a, b) => (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99),
    );
    for (const f of sortedFindings) {
      const g = bySeverity.get(f.severity);
      if (g) g.push(f);
      else bySeverity.set(f.severity, [f]);
    }
    for (const [sev, findings] of bySeverity) {
      const icon = SEVERITY_ICONS[sev] ?? "⚪";
      for (const f of findings) {
        const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
        lines.push(`- ${icon} **[${sev.toUpperCase()}]** ${f.title} — ${loc}`);
        lines.push(`  ${f.description}`);
        if (f.suggestion) lines.push(`  > **Fix:** ${f.suggestion}`);
        lines.push("");
      }
    }
  }
  return lines.join("\n");
}

/** Format the cross-round summary table. */
export function formatSummaryTable(rounds: ReviewRound[]): string {
  const lines = [
    "| Round | Agent | Domain | Critical | High | Medium | Low | Duration |",
    "|-------|-------|--------|----------|------|--------|-----|----------|",
  ];
  for (const rnd of rounds) {
    const sortedResults = [...rnd.results].sort((a, b) => {
      if (a.agent !== b.agent) return a.agent.localeCompare(b.agent);
      return (DOMAINS[a.domain]?.order ?? "99").localeCompare(DOMAINS[b.domain]?.order ?? "99");
    });
    for (const result of sortedResults) {
      const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const f of result.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      lines.push(
        `| ${rnd.round_num} | ${result.agent} | ${result.domain} | ` +
          `${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} | ` +
          `${result.duration_s.toFixed(1)}s |`,
      );
    }
    const allF = allFindings(rnd);
    const tc = allF.filter((f) => f.severity === "critical").length;
    const th = allF.filter((f) => f.severity === "high").length;
    const tm = allF.filter((f) => f.severity === "medium").length;
    const tl = allF.filter((f) => f.severity === "low").length;
    lines.push(
      `| ${rnd.round_num} | **TOTAL** | **all** | **${tc}** | **${th}** | **${tm}** | **${tl}** | |`,
    );
  }
  return lines.join("\n");
}

// ── History persistence ──────────────────────────────────────────────────

const HISTORY_SCHEMA_VERSION = 2;

function historyRoot(): string {
  return path.join(os.homedir(), ".claude", "code-review", "history");
}

function historyDir(repo: string, prNumber: number): string {
  const parts = repo.split("/");
  const d =
    parts.length === 2
      ? path.join(historyRoot(), parts[0], parts[1], String(prNumber))
      : path.join(historyRoot(), repo, String(prNumber));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Next unused round number based on existing history files (read-only). */
export function nextRoundNum(repo: string, prNumber: number): number {
  const parts = repo.split("/");
  const d =
    parts.length === 2
      ? path.join(historyRoot(), parts[0], parts[1], String(prNumber))
      : path.join(historyRoot(), repo, String(prNumber));
  let entries: string[];
  try {
    if (!fs.statSync(d).isDirectory()) return 1;
    entries = fs.readdirSync(d);
  } catch {
    return 1;
  }
  const nums: number[] = [];
  for (const name of entries) {
    const m = name.match(/^round-(\d+)\.json$/);
    if (m) nums.push(Number(m[1]));
  }
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function agentQuality(findings: Finding[], agent: string): Record<string, unknown> {
  const af = findings.filter((f) => f.agent === agent);
  const fix = af.filter((f) => f.classification === "fix").length;
  const noise = af.filter((f) => f.classification === "noise").length;
  const fp = af.filter((f) => f.classification === "false_positive").length;
  const ignored = af.filter((f) => f.classification === "ignored").length;
  const unclassified = af.filter((f) => f.classification === null).length;
  const totalEvaluated = fix + noise + fp;
  return {
    total: af.length,
    fix,
    noise,
    false_positive: fp,
    ignored,
    unclassified,
    signal_pct: totalEvaluated ? Math.round((fix / totalEvaluated) * 1000) / 10 : null,
  };
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Save one round's data to history. Returns the file path. */
export function saveRoundHistory(
  repo: string,
  prNumber: number,
  rnd: ReviewRound,
  mode: string,
  domainAgents: Record<string, string> | null,
  log: Logger,
): string {
  const d = historyDir(repo, prNumber);
  const filePath = path.join(d, `round-${rnd.round_num}.json`);

  const allF: Finding[] = [];
  for (const res of rnd.results) allF.push(...res.findings);

  const data = {
    schema_version: HISTORY_SCHEMA_VERSION,
    timestamp: isoNow(),
    repo,
    pr: prNumber,
    mode,
    round: rnd.round_num,
    domain_agents: domainAgents,
    models: Object.fromEntries(rnd.results.filter((r) => r.model).map((r) => [r.agent, r.model])),
    results: rnd.results.map((res) => ({
      agent: res.agent,
      model: res.model,
      domain: res.domain,
      duration_s: res.duration_s,
      error: res.error,
      api_key_fallback: res.api_key_fallback,
      findings: res.findings,
    })),
    classification_summary: {
      fix: allF.filter((f) => f.classification === "fix").length,
      noise: allF.filter((f) => f.classification === "noise").length,
      false_positive: allF.filter((f) => f.classification === "false_positive").length,
      ignored: allF.filter((f) => f.classification === "ignored").length,
      unclassified: allF.filter((f) => f.classification === null).length,
      total: allF.length,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  return filePath;
}

/** Save the full review summary across all rounds. Returns the file path. */
export function saveReviewSummary(
  repo: string,
  prNumber: number,
  base: string,
  rounds: ReviewRound[],
  mode: string,
  domainAgents: Record<string, string> | null,
  log: Logger,
): string {
  const d = historyDir(repo, prNumber);
  const filePath = path.join(d, "rounds.json");

  const allFlat: Finding[] = [];
  for (const rnd of rounds) for (const res of rnd.results) allFlat.push(...res.findings);

  const agentsSeen = [...new Set(allFlat.map((f) => f.agent))].sort();
  const perAgent: Record<string, unknown> = {};
  for (const a of agentsSeen) perAgent[a] = agentQuality(allFlat, a);

  const perAgentDomain: Record<string, { agent: string; domain: string; findings: Finding[] }> = {};
  for (const f of allFlat) {
    const key = `${f.agent}:${f.domain}`;
    if (!perAgentDomain[key]) perAgentDomain[key] = { agent: f.agent, domain: f.domain, findings: [] };
    perAgentDomain[key].findings.push(f);
  }
  const agentDomainQuality: Record<string, unknown> = {};
  for (const [key, info] of Object.entries(perAgentDomain)) {
    const q = agentQuality(info.findings, info.agent) as Record<string, unknown>;
    q.domain = info.domain;
    agentDomainQuality[key] = q;
  }

  const domainsSeen = [...new Set(allFlat.map((f) => f.domain))].sort();
  const perDomain: Record<string, unknown> = {};
  for (const domain of domainsSeen) {
    const df = allFlat.filter((f) => f.domain === domain);
    const fix = df.filter((f) => f.classification === "fix").length;
    const noise = df.filter((f) => f.classification === "noise" || f.classification === "false_positive").length;
    perDomain[domain] = {
      total: df.length,
      fix,
      noise,
      agents_that_found_real: [
        ...new Set(df.filter((f) => f.classification === "fix").map((f) => f.agent)),
      ].sort(),
    };
  }

  const durationStats: Record<string, number[]> = {};
  for (const rnd of rounds) {
    for (const res of rnd.results) {
      if (!res.error) (durationStats[res.agent] ??= []).push(res.duration_s);
    }
  }
  const avgDuration: Record<string, number> = {};
  for (const [a, ds] of Object.entries(durationStats)) {
    avgDuration[a] = Math.round((ds.reduce((s, x) => s + x, 0) / ds.length) * 10) / 10;
  }

  const errorCounts: Record<string, number> = {};
  for (const rnd of rounds) {
    for (const res of rnd.results) {
      if (res.error) errorCounts[res.agent] = (errorCounts[res.agent] ?? 0) + 1;
    }
  }

  const totalFix = allFlat.filter((f) => f.classification === "fix").length;
  const totalNoise = allFlat.filter(
    (f) => f.classification === "noise" || f.classification === "false_positive",
  ).length;
  const totalEvaluated = totalFix + totalNoise;
  const signalPct = totalEvaluated ? Math.round((totalFix / totalEvaluated) * 1000) / 10 : null;

  const data = {
    schema_version: HISTORY_SCHEMA_VERSION,
    timestamp: isoNow(),
    repo,
    pr: prNumber,
    base,
    mode,
    domain_agents: domainAgents,
    agents: agentsSeen,
    models: Object.fromEntries(
      rounds.flatMap((r) => r.results).filter((res) => res.model).map((res) => [res.agent, res.model]),
    ),
    domains: Object.keys(DOMAINS),
    rounds: rounds.map((rnd) => ({
      round: rnd.round_num,
      results: rnd.results.map((res) => ({
        agent: res.agent,
        model: res.model,
        domain: res.domain,
        findings: res.findings,
        error: res.error,
        duration_s: res.duration_s,
      })),
    })),
    summary: {
      total_rounds: rounds.length,
      total_findings: allFlat.length,
      total_fix: totalFix,
      total_noise: totalNoise,
      total_false_positive: allFlat.filter((f) => f.classification === "false_positive").length,
      total_ignored: allFlat.filter((f) => f.classification === "ignored").length,
      signal_to_noise_pct: signalPct,
      clean: rounds.length > 0 ? !hasActionableFindings(rounds[rounds.length - 1]) : true,
    },
    quality: {
      per_agent: perAgent,
      per_agent_domain: agentDomainQuality,
      per_domain: perDomain,
      avg_duration_s: avgDuration,
      error_counts: errorCounts,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  return filePath;
}

// ── Sub-agent runner ─────────────────────────────────────────────────────

interface RunSubagentOpts {
  cwd?: string;
  specContext?: string | null;
  overrideTimeoutS?: number | null;
  promptCache?: Map<string, string> | null;
  /** Round number (for sub-agent task labeling). */
  roundNum?: number;
}

async function runSubagent(
  agent: string,
  domainKey: string,
  base: string,
  opts: RunSubagentOpts,
  log: Logger,
): Promise<SubAgentResult> {
  if (agent === "gemini") await geminiSemaphore.acquire();
  try {
    const result = await runSubagentInner(agent, domainKey, base, opts, log);
    if (!result.model) result.model = agentModelLabel(agent);
    return result;
  } finally {
    if (agent === "gemini") geminiSemaphore.release();
  }
}

async function runSubagentInner(
  agent: string,
  domainKey: string,
  base: string,
  opts: RunSubagentOpts,
  log: Logger,
): Promise<SubAgentResult> {
  const t0 = Date.now();
  if (!isAgentEnabled(agent)) {
    return makeSubAgentResult({ agent, domain: domainKey, error: "agent_disabled" });
  }

  let preamble: string;
  let domainPrompt: string;
  if (opts.promptCache) {
    preamble = opts.promptCache.get(`${agent} __preamble__`) ?? "";
    domainPrompt = opts.promptCache.get(`${agent} ${domainKey}`) ?? "";
  } else {
    preamble = loadAgentPreamble(agent, opts.cwd);
    domainPrompt = loadDomainPrompt(agent, domainKey, opts.cwd, log);
  }
  const parts: string[] = [];
  if (preamble) parts.push(preamble);
  if (opts.specContext) parts.push(opts.specContext);
  parts.push(domainPrompt);
  const fullPrompt = parts.join("\n\n");

  const resolvedBase = resolveBaseRef(base, opts.cwd);

  let cmd: string[];
  let stdinInput: string | undefined;
  let geminiHome: string | null = null;

  if (agent === "claude") {
    const prompt =
      `Run 'git diff ${resolvedBase}...HEAD' and read all changed files. ` +
      `Then review them according to these instructions:\n\n${fullPrompt}`;
    cmd = buildClaudeCmd();
    stdinInput = prompt;
  } else if (agent === "codex") {
    const prompt =
      `Run 'git diff ${resolvedBase}...HEAD' and read all changed files. ` +
      `ONLY review files that appear in the diff. ` +
      `Then review them according to these instructions:\n\n${fullPrompt}`;
    cmd = [
      "codex",
      "exec",
      "-m",
      resolveModel("codex"),
      "-c",
      CODEX_REASONING_CONFIG,
      "--ephemeral",
      "--json",
      "-s",
      "read-only",
      "-",
    ];
    stdinInput = prompt;
  } else if (agent === "gemini") {
    const prompt =
      `Run 'git diff ${resolvedBase}...HEAD' and read all changed files. ` +
      `ONLY review files that appear in the diff. ` +
      `Then review them according to these instructions:\n\n${fullPrompt}`;
    const effectiveCwd = opts.cwd ?? process.cwd();
    geminiHome = setupGeminiHome("gemini-review-", effectiveCwd, "review", "plan");
    // gemini CLI 0.46+ gates headless runs behind a workspace-trust check;
    // --skip-trust matches plan_dispatch.ts / copilot_dispatch.ts (the trust
    // error is not in GEMINI_AUTH_ERROR_PATTERNS, so it never reaches the
    // API-key fallback — without this, gemini reviews fail hard with exit 55).
    cmd = ["gemini", "-m", resolveModel("gemini"), "--skip-trust", "-p", prompt, "-o", "json"];
    stdinInput = undefined;
  } else {
    return makeSubAgentResult({ agent, domain: domainKey, error: `Unknown agent: ${agent}` });
  }

  const cleanupTemp = () => {
    if (geminiHome) {
      try {
        fs.rmSync(geminiHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };

  const maxAttempts = 2;
  const timeoutS = opts.overrideTimeoutS ?? (agent === "gemini" ? 600 : 900);

  let env: Record<string, string> | undefined;
  if (agent === "claude" || agent === "codex") {
    env = await buildAgentEnv(agent, "review");
  } else if (geminiHome) {
    env = makeGeminiEnv(geminiHome);
  }

  let usedApiKeyFallback = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result: ProcResult;
    try {
      result = await runProcess(cmd[0], cmd.slice(1), {
        input: stdinInput,
        timeoutMs: timeoutS * 1000,
        env,
        cwd: opts.cwd,
      });
    } catch (e) {
      cleanupTemp();
      return makeSubAgentResult({
        agent,
        domain: domainKey,
        error: (e as Error).message,
        duration_s: (Date.now() - t0) / 1000,
      });
    }

    if (result.timedOut) {
      if (attempt < maxAttempts) {
        log(`    ${agent}:${domainKey} timed out, retrying (${attempt}/${maxAttempts})...`);
        continue;
      }
      cleanupTemp();
      return makeSubAgentResult({
        agent,
        domain: domainKey,
        error: `Timed out after ${timeoutS}s (2 attempts)`,
        duration_s: (Date.now() - t0) / 1000,
      });
    }

    if (result.status !== 0) {
      const stderrSnippet = result.stderr.slice(0, 500);
      log(`  [${agent}:${domainKey}] CLI error (exit ${result.status}): ${stderrSnippet}`);
      try {
        const errDir = path.join(os.homedir(), ".claude", "code-review", "logs");
        fs.mkdirSync(errDir, { recursive: true });
        fs.writeFileSync(
          path.join(errDir, `${agent}-${domainKey}-error.log`),
          `exit_code=${result.status}\ncmd=${cmd.join(" ")}\n` +
            `attempt=${attempt}/${maxAttempts}\nstderr:\n${result.stderr}\n` +
            `stdout:\n${result.stdout.slice(0, 1000)}\n`,
        );
      } catch {
        // best-effort
      }
      if (
        agent === "gemini" &&
        attempt < maxAttempts &&
        shouldFallbackToApiKey(stderrSnippet) &&
        env !== undefined &&
        tryGeminiApiKeyFallback({ env }, domainKey, stderrSnippet)
      ) {
        usedApiKeyFallback = true;
        await sleep(2000);
        continue;
      }
      if (attempt < maxAttempts) {
        const backoff = 5000 * attempt;
        log(`    ${agent}:${domainKey} retrying in ${backoff / 1000}s (${attempt}/${maxAttempts})...`);
        await sleep(backoff);
        continue;
      }
      cleanupTemp();
      return makeSubAgentResult({
        agent,
        domain: domainKey,
        error: "cli_error",
        duration_s: (Date.now() - t0) / 1000,
      });
    }

    let raw = result.stdout;
    if (agent === "codex") raw = parseJsonlOutput(raw);
    if (geminiHome) {
      raw = parseGeminiOutput(raw);
      cleanupTemp();
    }

    if (!raw.trim()) {
      log(`  [${agent}:${domainKey}] Empty output`);
      cleanupTemp();
      return makeSubAgentResult({
        agent,
        domain: domainKey,
        error: "empty_output",
        duration_s: (Date.now() - t0) / 1000,
      });
    }

    let findings: Finding[];
    try {
      findings = parseFindings(agent, domainKey, raw);
    } catch (exc) {
      log(`  [${agent}:${domainKey}] Parse error: ${(exc as Error).message}`);
      if (attempt < maxAttempts) {
        const backoff = 5000 * attempt;
        log(
          `    ${agent}:${domainKey} retrying after parse failure in ${backoff / 1000}s ` +
            `(${attempt}/${maxAttempts})...`,
        );
        await sleep(backoff);
        continue;
      }
      return makeSubAgentResult({
        agent,
        domain: domainKey,
        raw_output: raw,
        error: `parse_error: ${(exc as Error).message}`,
        duration_s: (Date.now() - t0) / 1000,
        api_key_fallback: usedApiKeyFallback,
      });
    }
    return makeSubAgentResult({
      agent,
      domain: domainKey,
      raw_output: raw,
      findings,
      duration_s: (Date.now() - t0) / 1000,
      api_key_fallback: usedApiKeyFallback,
    });
  }

  cleanupTemp();
  return makeSubAgentResult({
    agent,
    domain: domainKey,
    error: "unexpected loop exit",
    duration_s: (Date.now() - t0) / 1000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Orchestration ────────────────────────────────────────────────────────

/** Run one round of parallel reviews: agents × domains. */
export async function runReviewRound(
  base: string,
  roundNum: number,
  opts: {
    agents?: string[] | null;
    domains?: string[] | null;
    cwd?: string;
    specContext?: string | null;
  },
  log: Logger,
): Promise<ReviewRound> {
  const config = discoverConfig(opts.cwd);
  let agents = opts.agents ?? null;
  if (agents === null) {
    const configAgents = (config["agents"] as string[]) ?? Object.keys(AGENTS);
    agents = configAgents.filter((a) => a in AGENTS).filter((a) => isAgentEnabled(a));
  }
  let domains = opts.domains ?? null;
  if (domains === null) {
    const disabled = new Set((config["disabled_domains"] as string[]) ?? []);
    domains = Object.keys(DOMAINS).filter((d) => !disabled.has(d));
  }
  const rnd: ReviewRound = { round_num: roundNum, results: [] };

  const [fileCount, lineCount] = getDiffStats(base, opts.cwd);
  if (fileCount > 0 || lineCount > 0) {
    log(`  [diff] ${fileCount} files, ${lineCount} lines changed`);
  }
  const changedFiles = getChangedFiles(base, opts.cwd);

  const total = agents.length * domains.length;
  log(`\n${"=".repeat(60)}`);
  log(
    `  Review Round ${roundNum} — ${agents.length} agents × ${domains.length} domains = ${total} sub-agents`,
  );
  log("=".repeat(60));
  if (total === 0) {
    log("  No enabled agents available for this round.");
    return rnd;
  }

  printModelsInUse(agents, log);
  log(`  Domains: ${domains.join(", ")}`);
  const roundT0 = performance.now();

  const promptCache = new Map<string, string>();
  for (const agent of agents) {
    promptCache.set(`${agent} __preamble__`, loadAgentPreamble(agent, opts.cwd));
    for (const domainKey of domains) {
      promptCache.set(`${agent} ${domainKey}`, loadDomainPrompt(agent, domainKey, opts.cwd, log));
    }
  }

  const tasks: Array<Promise<{ agent: string; domain: string; result: SubAgentResult }>> = [];
  for (const agent of agents) {
    if (!isAgentEnabled(agent)) {
      log(`  [${agent}] skipped: disabled in config`);
      continue;
    }
    const agentCfg = AGENTS[agent];
    const agentTimeout = adaptiveTimeout(agent, fileCount, lineCount, config);
    for (const domainKey of domains) {
      const domainCfg = DOMAINS[domainKey] ?? { label: domainKey };
      log(
        `  [${agentCfg.emoji}] ${agent} × ${domainCfg.label}... ` +
          `(model=${agentModelLabel(agent)}, timeout=${agentTimeout}s)`,
      );
      tasks.push(
        runSubagent(
          agent,
          domainKey,
          base,
          {
            cwd: opts.cwd,
            specContext: opts.specContext,
            overrideTimeoutS: agentTimeout,
            promptCache,
            roundNum,
          },
          log,
        ).then((result) => ({ agent, domain: domainKey, result })),
      );
    }
  }

  for (const settled of await Promise.all(tasks)) {
    const { agent, domain: domainKey, result } = settled;
    const agentCfg = AGENTS[agent];
    const [kept, dropped] = filterOutOfDiffFindings(result.findings, changedFiles);
    if (dropped.length > 0) {
      result.findings = kept;
      const droppedFiles = [...new Set(dropped.map((f) => f.file).filter(Boolean))].sort();
      log(
        `  [${agentCfg.emoji}] ${agent} × ${domainKey}: ` +
          `dropped ${dropped.length} out-of-diff finding(s) referencing ${JSON.stringify(droppedFiles)}`,
      );
    }
    rnd.results.push(result);
    const n = result.findings.length;
    const crits = result.findings.filter((f) => f.severity === "critical").length;
    const highs = result.findings.filter((f) => f.severity === "high").length;
    if (result.error) {
      log(`  [${agentCfg.emoji}] ${agent} × ${domainKey}: ERROR — ${result.error}`);
    } else {
      log(
        `  [${agentCfg.emoji}] ${agent} × ${domainKey}: ` +
          `${n} findings (${crits}C/${highs}H) [${result.duration_s.toFixed(1)}s]`,
      );
    }
  }

  const succeeded = rnd.results.filter((r) => !r.error).length;
  log(
    `  Round ${roundNum} complete — ${succeeded}/${rnd.results.length} succeeded ` +
      `in ${((performance.now() - roundT0) / 1000).toFixed(1)}s`,
  );
  return rnd;
}

/** Build a domain→agent map for single-agent review mode. */
export function resolveDomainAgents(
  config: Record<string, unknown>,
  domains: string[],
  overrideAgent?: string | null,
): Record<string, string> {
  if (overrideAgent !== null && overrideAgent !== undefined) {
    if (typeof overrideAgent !== "string" || !overrideAgent.trim()) {
      throw new Error("--agent must be a non-empty string");
    }
    return Object.fromEntries(domains.map((d) => [d, overrideAgent.trim()]));
  }
  let da = config["domain_agents"] ?? {};
  if (da === null) da = {};
  if (typeof da !== "object" || Array.isArray(da)) {
    throw new Error("domain_agents must be an object mapping domains to agent names");
  }
  const daMap = da as Record<string, unknown>;
  const resolved: Record<string, string> = {};
  for (const domain of domains) {
    const agent = daMap[domain] ?? "codex";
    if (typeof agent !== "string" || !agent.trim()) {
      throw new Error(
        `Invalid domain_agents value for '${domain}': expected a non-empty string`,
      );
    }
    resolved[domain] = agent.trim();
  }
  return resolved;
}

/** Run one round dispatching exactly 1 agent per domain. */
export async function runSingleAgentRound(
  base: string,
  roundNum: number,
  domainAgentMap: Record<string, string>,
  opts: { cwd?: string; specContext?: string | null },
  log: Logger,
): Promise<ReviewRound> {
  const config = discoverConfig(opts.cwd);
  const rnd: ReviewRound = { round_num: roundNum, results: [] };
  const total = Object.keys(domainAgentMap).length;

  const [fileCount, lineCount] = getDiffStats(base, opts.cwd);
  if (fileCount > 0 || lineCount > 0) {
    log(`  [diff] ${fileCount} files, ${lineCount} lines changed`);
  }
  const changedFiles = getChangedFiles(base, opts.cwd);

  log(`\n${"=".repeat(60)}`);
  log(`  Review Round ${roundNum} — ${total} domains (1 agent each)`);
  log("=".repeat(60));
  if (total === 0) {
    log("  No enabled agents available for this round.");
    return rnd;
  }

  const uniqueAgents = [...new Set(Object.values(domainAgentMap).filter((a) => a in AGENTS))].sort();
  if (uniqueAgents.length > 0) printModelsInUse(uniqueAgents, log);
  log(
    "  Domain → agent: " +
      Object.entries(domainAgentMap)
        .map(([d, a]) => `${d}=${a}`)
        .join(", "),
  );
  const roundT0 = performance.now();

  const tasks: Array<Promise<{ agent: string; domain: string; result: SubAgentResult }>> = [];
  for (const [domainKey, agent] of Object.entries(domainAgentMap)) {
    if (!(agent in AGENTS)) {
      log(`  [!] Unknown agent '${agent}' for ${domainKey}, skipping`);
      continue;
    }
    if (!isAgentEnabled(agent)) {
      log(`  [${agent}] skipped for ${domainKey}: disabled in config`);
      continue;
    }
    const agentCfg = AGENTS[agent];
    const agentTimeout = adaptiveTimeout(agent, fileCount, lineCount, config);
    const domainCfg = DOMAINS[domainKey] ?? { label: domainKey };
    log(
      `  [${agentCfg.emoji}] ${agent} × ${domainCfg.label}... ` +
        `(model=${agentModelLabel(agent)}, timeout=${agentTimeout}s)`,
    );
    tasks.push(
      runSubagent(
        agent,
        domainKey,
        base,
        {
          cwd: opts.cwd,
          specContext: opts.specContext,
          overrideTimeoutS: agentTimeout,
          roundNum,
        },
        log,
      ).then((result) => ({ agent, domain: domainKey, result })),
    );
  }

  for (const settled of await Promise.all(tasks)) {
    const { agent, domain: domainKey, result } = settled;
    const agentCfg = AGENTS[agent];
    const [kept, dropped] = filterOutOfDiffFindings(result.findings, changedFiles);
    if (dropped.length > 0) {
      result.findings = kept;
      const droppedFiles = [...new Set(dropped.map((f) => f.file).filter(Boolean))].sort();
      log(
        `  [${agentCfg.emoji}] ${agent} × ${domainKey}: ` +
          `dropped ${dropped.length} out-of-diff finding(s) referencing ${JSON.stringify(droppedFiles)}`,
      );
    }
    rnd.results.push(result);
    const n = result.findings.length;
    const crits = result.findings.filter((f) => f.severity === "critical").length;
    const highs = result.findings.filter((f) => f.severity === "high").length;
    if (result.error) {
      log(`  [${agentCfg.emoji}] ${agent} × ${domainKey}: ERROR — ${result.error}`);
    } else {
      log(
        `  [${agentCfg.emoji}] ${agent} × ${domainKey}: ` +
          `${n} findings (${crits}C/${highs}H) [${result.duration_s.toFixed(1)}s]`,
      );
    }
  }

  const succeeded = rnd.results.filter((r) => !r.error).length;
  log(
    `  Round ${roundNum} complete — ${succeeded}/${rnd.results.length} succeeded ` +
      `in ${((performance.now() - roundT0) / 1000).toFixed(1)}s`,
  );
  return rnd;
}

// ── PR review entry points ───────────────────────────────────────────────

async function fetchPrBody(repo: string, prNumber: number, log: Logger): Promise<string | null> {
  try {
    const token = await getGhToken("stark-claude");
    const env = { ...process.env, GH_TOKEN: token } as Record<string, string>;
    const r = await runProcess(
      "gh",
      ["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".body"],
      { timeoutMs: 30_000, env },
    );
    if (r.status === 0) return r.stdout.trim() || null;
  } catch (e) {
    log(`  [!] Could not fetch PR body: ${(e as Error).message}`);
  }
  return null;
}

function buildSpecContext(specLink: string | null, specContent: string | null): string | null {
  if (specContent) {
    return `## Design Spec\nThe PR references this spec:\n\n${specContent}`;
  }
  if (specLink && specLink !== "N/A") {
    return (
      "## Design Spec\nThe PR references a spec at " +
      `\`${specLink}\` but it could not be resolved. Flag this in your review.`
    );
  }
  return null;
}

export interface ReviewOptions {
  base?: string;
  dryRun?: boolean;
  jsonOutput?: boolean;
  jsonOnly?: boolean;
  postRaw?: boolean;
  domains?: string | null;
  cwd?: string;
  roundNum?: number | null;
  persistHistory?: boolean;
}

/** Run single-agent review: 1 agent per domain (from domain_agents config). */
export async function reviewPrSingle(
  repo: string,
  prNumber: number,
  options: ReviewOptions & { overrideAgent?: string | null },
  log: Logger,
): Promise<Record<string, unknown>> {
  const base = options.base ?? "main";
  const config = discoverConfig(options.cwd);

  let domainsToReview: Record<string, DomainInfo>;
  if (options.domains) {
    const allowed = new Set(options.domains.split(","));
    domainsToReview = Object.fromEntries(
      Object.entries(DOMAINS).filter(([k]) => allowed.has(k)),
    );
  } else {
    domainsToReview = DOMAINS;
  }
  const disabled = new Set((config["disabled_domains"] as string[]) ?? []);
  const activeDomains = Object.keys(domainsToReview).filter((d) => !disabled.has(d));
  const sevOverrides =
    (config["severity_overrides"] as Record<string, Record<string, unknown>>) ?? {};
  const daMap = resolveDomainAgents(config, activeDomains, options.overrideAgent ?? null);

  const configuredAgents = [...new Set(Object.values(daMap))].sort();
  const invalidConfigured = configuredAgents.filter((a) => !(a in AGENTS)).sort();
  if (invalidConfigured.length > 0) {
    throw new Error(
      `Configured review agent(s) ${JSON.stringify(invalidConfigured)} are not enabled or unknown. ` +
        "Check --agent/domain_agents and models.<agent>.enabled before treating the PR as clean.",
    );
  }

  log(`\n${"#".repeat(60)}`);
  log(`  Single-Agent Review: ${repo} PR #${prNumber}`);
  log(`  Base: ${base}`);
  log(`  ${activeDomains.length} domains, agents: ${configuredAgents.join(", ")}`);
  log("#".repeat(60));

  if (Object.keys(domainsToReview).length === 0) {
    throw new Error(`No domain prompt files found in: ${globalPromptsDir()}`);
  }

  const prBody = await fetchPrBody(repo, prNumber, log);
  const specLink = extractSpecLink(prBody);
  const effectiveCwd = options.cwd ?? process.cwd();
  const specContent = specLink ? resolveSpecContent(specLink, effectiveCwd) : null;
  let specContext = buildSpecContext(specLink, specContent);
  const ctxFiles = resolveContextFiles((config["context_files"] as string[]) ?? [], effectiveCwd);
  if (ctxFiles) specContext = specContext ? `${specContext}\n\n${ctxFiles}` : ctxFiles;

  const effectiveRound = options.roundNum ?? nextRoundNum(repo, prNumber);
  const rnd = await runSingleAgentRound(
    base,
    effectiveRound,
    daMap,
    { cwd: options.cwd, specContext },
    log,
  );

  if (Object.keys(sevOverrides).length > 0) {
    for (const res of rnd.results) applySeverityOverrides(res.findings, sevOverrides);
  }

  const unknownAgents = [
    ...new Set(rnd.results.map((r) => r.agent).filter((a) => !(a in AGENTS))),
  ].sort();
  if (unknownAgents.length > 0) {
    throw new Error(
      `Review results carry unknown agent(s) ${JSON.stringify(unknownAgents)}; refusing to post or summarize.`,
    );
  }
  const usedAgents = [...new Set(rnd.results.map((r) => r.agent))].sort();
  if (usedAgents.length === 0) {
    throw new Error("No review sub-agents produced results.");
  }
  const resultDomains = new Set(rnd.results.map((r) => r.domain));
  const missingDomains = activeDomains.filter((d) => !resultDomains.has(d));
  if (missingDomains.length > 0) {
    throw new Error(
      `Review sub-agents did not produce results for domain(s): ${missingDomains.join(", ")}.`,
    );
  }

  if (options.persistHistory !== false) {
    try {
      const p = saveRoundHistory(repo, prNumber, rnd, "single", daMap, log);
      log(`  [history] persisted unclassified round to ${p}`);
    } catch (e) {
      log(`  [history] failed to persist round: ${(e as Error).message}`);
    }
  }

  if (!options.dryRun || options.postRaw) {
    log(`\n  Posting findings to PR #${prNumber}...`);
    for (const agent of usedAgents) {
      const agentCfg = AGENTS[agent];
      const body = formatAgentReviewBody(agent, rnd);
      if (body) {
        const ok = await postReview(repo, prNumber, agentCfg.app, body, log);
        log(`    ${agentCfg.emoji} ${agent} → ${ok ? "posted" : "FAILED"}`);
      }
    }
  }

  const dedupedFindings = allFindings(rnd);
  const failedResults = rnd.results.filter((r) => r.error).length;
  const output = {
    repo,
    pr: prNumber,
    base,
    mode: "single",
    domain_agents: daMap,
    models: Object.fromEntries(rnd.results.filter((r) => r.model).map((r) => [r.agent, r.model])),
    domains: activeDomains,
    rounds: [
      {
        round: rnd.round_num,
        results: rnd.results.map((res) => ({
          agent: res.agent,
          model: res.model,
          domain: res.domain,
          findings: res.findings,
          error: res.error,
          duration_s: res.duration_s,
        })),
      },
    ],
    summary: {
      total_findings: dedupedFindings.length,
      critical: dedupedFindings.filter((f) => f.severity === "critical").length,
      high: dedupedFindings.filter((f) => f.severity === "high").length,
      medium: dedupedFindings.filter((f) => f.severity === "medium").length,
      failed_results: failedResults,
      clean:
        failedResults === 0 &&
        !dedupedFindings.some((f) => ["critical", "high", "medium"].includes(f.severity)),
    },
  };

  if (!options.jsonOutput) {
    log(`\n${"=".repeat(60)}`);
    log("  Summary");
    log("=".repeat(60));
    log(formatSummaryTable([rnd]));
    log("");
  }
  return output;
}

/** Run the full multi-agent review on a single PR. */
export async function reviewPr(
  repo: string,
  prNumber: number,
  options: ReviewOptions,
  log: Logger,
): Promise<Record<string, unknown>> {
  const base = options.base ?? "main";
  const config = discoverConfig(options.cwd);
  const activeAgents = ((config["agents"] as string[]) ?? Object.keys(AGENTS)).filter(
    (a) => a in AGENTS,
  );

  let domainsToReview: Record<string, DomainInfo>;
  if (options.domains) {
    const allowed = new Set(options.domains.split(","));
    domainsToReview = Object.fromEntries(
      Object.entries(DOMAINS).filter(([k]) => allowed.has(k)),
    );
  } else {
    domainsToReview = DOMAINS;
  }
  const disabled = new Set((config["disabled_domains"] as string[]) ?? []);
  const activeDomains = Object.keys(domainsToReview).filter((d) => !disabled.has(d));
  const sevOverrides =
    (config["severity_overrides"] as Record<string, Record<string, unknown>>) ?? {};

  log(`\n${"#".repeat(60)}`);
  log(`  Multi-Agent Review: ${repo} PR #${prNumber}`);
  log(`  Base: ${base}`);
  log(
    `  ${activeAgents.length} agents × ${activeDomains.length} domains = ` +
      `${activeAgents.length * activeDomains.length} sub-agents`,
  );
  log("#".repeat(60));

  if (Object.keys(domainsToReview).length === 0) {
    throw new Error(`No domain prompt files found in: ${globalPromptsDir()}`);
  }

  const prBody = await fetchPrBody(repo, prNumber, log);
  const specLink = extractSpecLink(prBody);
  const effectiveCwd = options.cwd ?? process.cwd();
  const specContent = specLink ? resolveSpecContent(specLink, effectiveCwd) : null;
  let specContext = buildSpecContext(specLink, specContent);
  const ctxFiles = resolveContextFiles((config["context_files"] as string[]) ?? [], effectiveCwd);
  if (ctxFiles) specContext = specContext ? `${specContext}\n\n${ctxFiles}` : ctxFiles;

  const rounds: ReviewRound[] = [];
  const baseRound =
    options.roundNum !== null && options.roundNum !== undefined
      ? options.roundNum - 1
      : nextRoundNum(repo, prNumber) - 1;
  const loopRound = baseRound + 1;

  const rnd = await runReviewRound(
    base,
    loopRound,
    {
      agents: activeAgents,
      domains: activeDomains,
      cwd: options.cwd,
      specContext,
    },
    log,
  );
  rounds.push(rnd);

  if (Object.keys(sevOverrides).length > 0) {
    for (const res of rnd.results) applySeverityOverrides(res.findings, sevOverrides);
  }

  if (options.persistHistory !== false) {
    try {
      const p = saveRoundHistory(repo, prNumber, rnd, "team", null, log);
      log(`  [history] persisted unclassified round to ${p}`);
    } catch (e) {
      log(`  [history] failed to persist round: ${(e as Error).message}`);
    }
  }

  if (!options.dryRun || options.postRaw) {
    log(`\n  Posting per-agent findings to PR #${prNumber}...`);
    for (const agent of activeAgents) {
      const agentCfg = AGENTS[agent];
      const body = formatAgentReviewBody(agent, rnd);
      if (body) {
        const ok = await postReview(repo, prNumber, agentCfg.app, body, log);
        log(`    ${agentCfg.emoji} ${agent} → ${ok ? "posted" : "FAILED"}`);
      } else {
        const agentResults = rnd.results.filter((r) => r.agent === agent);
        let statusBody: string;
        if (agentResults.some((r) => r.error)) {
          const errors = agentResults
            .filter((r) => r.error)
            .map((r) => r.error)
            .join("; ");
          statusBody = `## ${agentCfg.emoji} stark-${agent} review — round ${rnd.round_num}\n\n⚠️ Agent failed: ${errors}`;
        } else {
          statusBody = `## ${agentCfg.emoji} stark-${agent} review — round ${rnd.round_num}\n\nNo findings.`;
        }
        const ok = await postReview(repo, prNumber, agentCfg.app, statusBody, log);
        log(`    ${agentCfg.emoji} ${agent} → ${ok ? "posted (empty)" : "FAILED"}`);
      }
    }
  }

  if (!hasActionableFindings(rnd)) {
    log(`\n  Round ${loopRound}: No critical/high/medium findings. Review clean.`);
  } else {
    const actionable = allFindings(rnd).filter((f) =>
      ["critical", "high", "medium"].includes(f.severity),
    );
    log(`\n  Round ${loopRound}: ${actionable.length} actionable findings to fix.`);
    log("  Findings require fixing. Outputting for orchestrator...");
  }

  const allDeduped = rounds.map((r) => allFindings(r));
  const output = {
    repo,
    pr: prNumber,
    base,
    agents: Object.keys(AGENTS),
    models: Object.fromEntries(
      rounds
        .flatMap((r) => r.results)
        .filter((res) => res.model)
        .map((res) => [res.agent, res.model]),
    ),
    domains: activeDomains,
    rounds: rounds.map((r) => ({
      round: r.round_num,
      results: r.results.map((res) => ({
        agent: res.agent,
        model: res.model,
        domain: res.domain,
        findings: res.findings,
        error: res.error,
        duration_s: res.duration_s,
      })),
    })),
    summary: {
      total_findings: allDeduped.reduce((s, d) => s + d.length, 0),
      critical: allDeduped.reduce(
        (s, d) => s + d.filter((f) => f.severity === "critical").length,
        0,
      ),
      high: allDeduped.reduce((s, d) => s + d.filter((f) => f.severity === "high").length, 0),
      medium: allDeduped.reduce(
        (s, d) => s + d.filter((f) => f.severity === "medium").length,
        0,
      ),
      clean:
        allDeduped.length > 0
          ? !allDeduped[allDeduped.length - 1].some((f) =>
              ["critical", "high", "medium"].includes(f.severity),
            )
          : false,
    },
  };

  if (!options.jsonOutput) {
    log(`\n${"=".repeat(60)}`);
    log("  Summary");
    log("=".repeat(60));
    log(formatSummaryTable(rounds));
    log("");
  }
  return output;
}
