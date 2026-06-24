/**
 * iac_review_lib — multi-agent IaC review orchestrator.
 *
 * Runs a Terraform/OpenTofu or Terragrunt review across one or more configured
 * LLM agents (claude / codex / gemini), each dispatched as its own headless
 * subagent (text-in, JSON-findings-out), then merges + cross-validates the
 * findings. Backs the /stark-terraform-review and /stark-terragrunt-review
 * skills. Agents are configurable (CLI `--agents` > config `iac_review.agents`
 * > default) so you can, e.g., run reviews with Gemini AND Codex.
 *
 * Reuses the proven dispatch primitives from copilot_dispatch.ts (subprocess
 * runner, isolated env, gemini-home + Vertex/API-key fallback, output parsers),
 * the same way plan_dispatch.ts does. Read-only: the dispatcher runs only
 * read-only scanners and read-only agent sandboxes; it never mutates the target.
 */
import { readFile } from "node:fs/promises";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildAgentEnv,
  isAgentEnabled,
  makeGeminiEnv,
  parseCodexJsonl,
  parseGeminiJson,
  releaseAgentTempDir,
  resolveModel,
  run,
  setupGeminiHome,
  shouldFallbackToApiKey,
  tryGeminiApiKeyFallback,
  VALID_AGENTS,
  type AgentName,
} from "./copilot_dispatch.ts";
import { assetPromptsDir } from "./asset_root_lib.ts";
import { getIacReviewConfig } from "./stark_config_lib.ts";
import { prReview, type AppName } from "./github_app_lib.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Kind = "terraform" | "terragrunt";
export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface IacFinding {
  agent: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  description: string;
  suggestion: string;
  cross_validated_by: string[];
}

export interface AgentRunReport {
  agent: AgentName;
  model: string;
  ok: boolean;
  error: string | null;
  finding_count: number;
  duration_s: number;
  api_key_fallback: boolean;
}

export interface IacReviewReceipt {
  kind: Kind;
  target: string;
  agents: AgentName[];
  files_reviewed: string[];
  scanners_run: string[];
  scanners_skipped: string[];
  agent_runs: AgentRunReport[];
  findings: IacFinding[];
  posted_pr: number | null;
  posted_ok: boolean | null;
  dry_run: boolean;
}

export interface RunIacReviewOpts {
  kind: Kind;
  target: string;
  agents?: string[] | null; // CLI override
  changed?: boolean;
  noTools?: boolean;
  /** Vouch for the source so HCL-evaluating scanners (terragrunt) may run. */
  trustSource?: boolean;
  minSeverity?: Severity;
  pr?: number | null;
  repo?: string | null;
  dryRun?: boolean;
  timeoutSec?: number;
  log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const APP_FOR_AGENT: Record<AgentName, AppName> = {
  claude: "stark-claude",
  codex: "stark-codex",
  gemini: "stark-gemini",
};

const CODEX_REASONING_EFFORT = 'model_reasoning_effort="high"';

function elapsedSec(t0: bigint): number {
  return Number(process.hrtime.bigint() - t0) / 1e9;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** File globs per kind. Terragrunt is HCL-centric; Terraform is .tf-centric. */
const TERRAFORM_RE = /\.(tf|tfvars)$|\.tftest\.hcl$/;

function isLikelyTerragruntFile(rel: string): boolean {
  // Terragrunt live/catalog repos use many named .hcl files (account/region/env,
  // _envcommon, units, stacks), so we accept .hcl broadly — but exclude
  // Terraform *test* HCL, which belongs to the Terraform reviewer, not here.
  if (/\.tftest\.hcl$/.test(rel)) return false;
  return /\.hcl$/.test(rel);
}

// ---------------------------------------------------------------------------
// Agent resolution
// ---------------------------------------------------------------------------

/**
 * Resolve which agents run the review.
 * Precedence: explicit CLI `--agents` > config `iac_review.agents` > ["codex"].
 * Filters to valid + enabled agents, de-duplicated, order preserved.
 */
export function resolveAgents(
  cliAgents: string[] | null | undefined,
  configAgents: string[] | undefined,
): { agents: AgentName[]; skipped: string[] } {
  const requested =
    cliAgents && cliAgents.length > 0
      ? cliAgents
      : configAgents && configAgents.length > 0
        ? configAgents
        : ["codex"];

  const agents: AgentName[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of requested) {
    const a = String(raw).trim().toLowerCase();
    if (seen.has(a)) continue;
    seen.add(a);
    if (!(VALID_AGENTS as readonly string[]).includes(a)) {
      skipped.push(`${a} (unknown)`);
      continue;
    }
    if (!isAgentEnabled(a)) {
      skipped.push(`${a} (disabled)`);
      continue;
    }
    agents.push(a as AgentName);
  }
  return { agents, skipped };
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

function gitChangedFiles(root: string): string[] | null {
  // Best-effort: files changed vs the merge-base with the default branch,
  // plus working-tree changes. Returns repo-relative paths, or null if not git.
  try {
    const merge = spawnText("git", ["-C", root, "merge-base", "HEAD", "origin/HEAD"]);
    const ref = merge.ok ? merge.out.trim() : "HEAD";
    const diff = spawnText("git", ["-C", root, "diff", "--name-only", ref]);
    const status = spawnText("git", ["-C", root, "status", "--porcelain"]);
    if (!diff.ok && !status.ok) return null;
    const set = new Set<string>();
    for (const l of diff.out.split("\n")) if (l.trim()) set.add(l.trim());
    for (const l of status.out.split("\n")) {
      const p = l.slice(3).trim();
      if (p) set.add(p);
    }
    return [...set];
  } catch {
    return null;
  }
}

function walk(dir: string, acc: string[], skip: Set<string>): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") {
      if (skip.has(e.name)) continue;
    }
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skip.has(e.name)) continue;
      walk(full, acc, skip);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
}

const SKIP_DIRS = new Set([
  ".git",
  ".terraform",
  ".terragrunt-cache",
  "node_modules",
  ".terragrunt-stack",
]);

export interface CollectedFile {
  rel: string;
  abs: string;
  content: string;
}

export function collectFiles(
  kind: Kind,
  target: string,
  changed: boolean,
  maxFiles: number,
  maxBytes: number,
): CollectedFile[] {
  const absTarget = path.resolve(target);
  const isDir = existsSync(absTarget) && statSync(absTarget).isDirectory();
  const root = isDir ? absTarget : path.dirname(absTarget);

  let candidates: string[] = [];
  if (!isDir) {
    candidates = [absTarget];
  } else if (changed) {
    const rels = gitChangedFiles(root);
    candidates = (rels ?? [])
      .map((r) => path.resolve(root, r))
      .filter((p) => existsSync(p) && statSync(p).isFile());
    if (candidates.length === 0) {
      // fall back to full scan if git gave nothing
      walk(root, candidates, SKIP_DIRS);
    }
  } else {
    walk(root, candidates, SKIP_DIRS);
  }

  const matcher =
    kind === "terraform"
      ? (rel: string) => TERRAFORM_RE.test(rel)
      : (rel: string) => isLikelyTerragruntFile(rel);

  const out: CollectedFile[] = [];
  for (const abs of candidates) {
    const rel = path.relative(root, abs) || path.basename(abs);
    if (!matcher(rel)) continue;
    let content: string;
    try {
      const sz = statSync(abs).size;
      content = readFileSync(abs, "utf8");
      if (sz > maxBytes) {
        content =
          content.slice(0, maxBytes) +
          `\n# … [truncated at ${maxBytes} bytes for review] …\n`;
      }
    } catch {
      continue;
    }
    out.push({ rel, abs, content });
    if (out.length >= maxFiles) break;
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/** Number each line so the agent can anchor findings precisely. */
function numberLines(content: string): string {
  const lines = content.split("\n");
  const width = String(lines.length).length;
  return lines
    .map((l, i) => `${String(i + 1).padStart(width, " ")}  ${l}`)
    .join("\n");
}

export function buildContextPack(files: CollectedFile[], scannerReport: string): string {
  const parts: string[] = [];
  if (scannerReport.trim()) {
    parts.push(
      "## Scanner output (host-run, read-only — evidence)\n\n" +
        scannerReport.trim() +
        "\n",
    );
  }
  parts.push("## Files under review\n");
  for (const f of files) {
    parts.push(`===== FILE: ${f.rel} =====\n${numberLines(f.content)}\n`);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Scanners (host-run, best-effort, read-only)
// ---------------------------------------------------------------------------

function spawnText(
  cmd: string,
  args: string[],
  cwd?: string,
): { ok: boolean; out: string; code: number | null } {
  // Synchronous best-effort exec for short scanner/git calls.
  try {
    const r = spawnSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) return { ok: false, out: "", code: null };
    return {
      ok: r.status === 0,
      out: (r.stdout || "") + (r.stderr ? `\n${r.stderr}` : ""),
      code: r.status,
    };
  } catch {
    return { ok: false, out: "", code: null };
  }
}

function have(cmd: string): boolean {
  return spawnText("command", ["-v", cmd]).ok || spawnText("which", [cmd]).ok;
}

/**
 * Run whichever read-only scanners are installed; capture their output as
 * evidence for the agents. Never throws; never mutates. Returns
 * { report, ran[] }.
 */
export function runScanners(
  kind: Kind,
  dir: string,
  trustSource: boolean = false,
): { report: string; ran: string[]; skipped: string[] } {
  const ran: string[] = [];
  const skipped: string[] = [];
  const blocks: string[] = [];
  const tf = have("terraform") ? "terraform" : have("tofu") ? "tofu" : null;

  const add = (label: string, res: { ok: boolean; out: string }) => {
    ran.push(label);
    const out = res.out.trim().slice(0, 6000);
    blocks.push(`### ${label}\n\n\`\`\`\n${out || "(no output)"}\n\`\`\``);
  };

  // Static, side-effect-free scanners — safe on untrusted source.
  if (kind === "terraform" && tf) {
    add(`${tf} fmt -check`, spawnText(tf, ["fmt", "-check", "-recursive"], dir));
    add(`${tf} validate`, spawnText(tf, ["validate", "-no-color"], dir));
  }
  if (have("tflint")) add("tflint", spawnText("tflint", ["--format", "compact"], dir));
  if (have("trivy")) add("trivy config", spawnText("trivy", ["config", "--quiet", "."], dir));
  if (have("checkov")) add("checkov", spawnText("checkov", ["-d", ".", "--compact", "--quiet"], dir));

  // Terragrunt config parsing can evaluate HCL functions (e.g. `run_cmd`),
  // so these EXECUTE the reviewed source. Only run them when the operator
  // vouches for the source via --trust-source (sec-001).
  if (kind === "terragrunt" && have("terragrunt")) {
    if (trustSource) {
      add("terragrunt hcl validate", spawnText("terragrunt", ["hcl", "validate"], dir));
      add(
        "terragrunt find --dag --dependencies",
        spawnText("terragrunt", ["find", "--dag", "--dependencies"], dir),
      );
    } else {
      skipped.push("terragrunt hcl validate / find (HCL exec — pass --trust-source)");
    }
  }

  return { report: blocks.join("\n\n"), ran, skipped };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const OUTPUT_CONTRACT = `
## Output contract (STRICT)

After any brief reasoning, output your findings as a SINGLE JSON array and
nothing after it. Each element:

{
  "severity": "critical" | "high" | "medium" | "low",
  "file": "relative/path.tf",
  "line": <integer, 1-based; use 0 if not line-specific>,
  "title": "<short imperative title>",
  "description": "<why it matters; name the failure mode>",
  "suggestion": "<concrete fix>"
}

Rules:
- Anchor "line" to the numbered lines shown in the file context.
- Only real findings. If the code is clean, output exactly: []
- Do not invent low-value nits to look thorough.
- Do not wrap the array in markdown fences if you can avoid it; the array must
  be the last thing in your output.
`;

export async function loadRubric(kind: Kind): Promise<string> {
  const p = path.join(assetPromptsDir(), "iac-review", `${kind}.md`);
  return readFile(p, "utf8");
}

export function buildPrompt(rubric: string, contextPack: string): string {
  return [
    rubric.trim(),
    OUTPUT_CONTRACT.trim(),
    "---",
    contextPack,
    "---",
    "Review the code above. Output the JSON array of findings now.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Agent dispatch (text-in, JSON-out) — mirrors plan_dispatch.ts::callAgent
// ---------------------------------------------------------------------------

interface AgentCallOutcome {
  raw: string;
  error: string | null;
  duration_s: number;
  api_key_fallback: boolean;
}

function buildClaudeCmd(): { cmd: string; args: string[] } {
  return {
    cmd: "claude",
    args: ["-p", "-", "--output-format", "text", "--model", resolveModel("claude"), "--no-session-persistence"],
  };
}
function buildCodexCmd(): { cmd: string; args: string[] } {
  return {
    cmd: "codex",
    args: ["exec", "-m", resolveModel("codex"), "-c", CODEX_REASONING_EFFORT, "--ephemeral", "--json", "-s", "read-only", "-"],
  };
}

export async function callAgent(
  agent: AgentName,
  prompt: string,
  timeoutSec: number,
): Promise<AgentCallOutcome> {
  const t0 = process.hrtime.bigint();
  const out: AgentCallOutcome = { raw: "", error: null, duration_s: 0, api_key_fallback: false };

  if (!isAgentEnabled(agent)) {
    out.error = "agent_disabled";
    out.duration_s = elapsedSec(t0);
    return out;
  }

  let cmd: string;
  let args: string[];
  let stdin: string | undefined;
  let geminiHome: string | null = null;
  let geminiCwd: string | null = null;
  let agentTempDir: string | null = null;
  let env: NodeJS.ProcessEnv;

  try {
    if (agent === "claude") {
      const c = buildClaudeCmd();
      cmd = c.cmd; args = c.args; stdin = prompt;
      const built = await buildAgentEnv("claude", "local");
      env = built.env; agentTempDir = built.tempDir;
    } else if (agent === "codex") {
      const c = buildCodexCmd();
      cmd = c.cmd; args = c.args; stdin = prompt;
      const built = await buildAgentEnv("codex", "local");
      env = built.env; agentTempDir = built.tempDir;
    } else {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "stark-iac-gemini-cwd-"));
      geminiCwd = cwd;
      geminiHome = setupGeminiHome("gemini-iac-review-", cwd, "iac-review", "plan");
      cmd = "gemini";
      // Prompt over stdin, NOT argv: the prompt embeds reviewed file contents
      // (possibly .tfvars secrets), and argv is visible in `ps`/proc (sec-002).
      args = ["-m", resolveModel("gemini"), "--skip-trust"];
      stdin = prompt;
      env = makeGeminiEnv(geminiHome);
    }
  } catch (err) {
    out.error = `env_setup_failed:${(err as Error).message}`;
    out.duration_s = elapsedSec(t0);
    if (geminiHome) try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    if (geminiCwd) try { rmSync(geminiCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    return out;
  }

  try {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const cwd = agent === "gemini" && geminiCwd ? geminiCwd : undefined;
      const res = await run(cmd, args, { timeoutSec, env, stdin, cwd });
      if (res.notFound) { out.error = "agent_unavailable"; break; }
      if (res.timedOut) {
        if (attempt < maxAttempts) continue;
        out.error = "timeout"; break;
      }
      if (res.code !== 0) {
        const stderrSnippet = res.stderr.slice(0, 500);
        if (
          agent === "gemini" &&
          attempt < maxAttempts &&
          shouldFallbackToApiKey(stderrSnippet) &&
          (await tryGeminiApiKeyFallback(env, "iac-review", stderrSnippet))
        ) {
          out.api_key_fallback = true;
          await sleep(2_000);
          continue;
        }
        if (attempt < maxAttempts) { await sleep(5_000 * attempt); continue; }
        out.error = "cli_error"; break;
      }
      let raw = res.stdout;
      if (agent === "codex") raw = parseCodexJsonl(raw);
      else if (agent === "gemini") raw = parseGeminiJson(raw);
      out.raw = raw;
      break;
    }
  } finally {
    if (geminiHome) try { rmSync(geminiHome, { recursive: true, force: true }); } catch { /* ignore */ }
    if (geminiCwd) try { rmSync(geminiCwd, { recursive: true, force: true }); } catch { /* ignore */ }
    if (agentTempDir) releaseAgentTempDir(agentTempDir);
  }

  out.duration_s = elapsedSec(t0);
  return out;
}

// ---------------------------------------------------------------------------
// Findings parsing + merge
// ---------------------------------------------------------------------------

const VALID_SEV = new Set<Severity>(["critical", "high", "medium", "low"]);

/** Extract the last JSON array of finding-like objects from agent text. */
export function parseFindings(raw: string, agent: string): IacFinding[] {
  if (!raw || !raw.trim()) return [];
  const text = raw.trim();
  // Try progressively-earlier closing brackets so trailing prose is ignored.
  for (let end = text.lastIndexOf("]"); end >= 0; end = text.lastIndexOf("]", end - 1)) {
    let depth = 0;
    let start = -1;
    for (let i = end; i >= 0; i--) {
      const ch = text[i];
      if (ch === "]") depth++;
      else if (ch === "[") {
        depth--;
        if (depth === 0) { start = i; break; }
      }
    }
    if (start < 0) continue;
    const candidate = text.slice(start, end + 1);
    let arr: unknown;
    try {
      arr = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const out: IacFinding[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const sevRaw = String(o.severity ?? "").toLowerCase() as Severity;
      const severity = VALID_SEV.has(sevRaw) ? sevRaw : "medium";
      const title = String(o.title ?? "").trim();
      if (!title) continue;
      out.push({
        agent,
        severity,
        file: String(o.file ?? "").trim(),
        line: Number.isFinite(Number(o.line)) ? Math.max(0, Math.floor(Number(o.line))) : 0,
        title,
        description: String(o.description ?? "").trim(),
        suggestion: String(o.suggestion ?? "").trim(),
        cross_validated_by: [],
      });
    }
    return out; // first parseable array wins
  }
  return [];
}

function normTitle(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Merge findings across agents; same file + nearby line + similar title ⇒ one. */
export function dedupeFindings(findings: IacFinding[]): IacFinding[] {
  const groups: IacFinding[][] = [];
  for (const f of findings) {
    let placed = false;
    for (const g of groups) {
      const h = g[0];
      const sameFile = h.file === f.file;
      const nearLine = Math.abs(h.line - f.line) <= 3 || h.line === 0 || f.line === 0;
      const sameTitle = normTitle(h.title) === normTitle(f.title);
      // Cross-agent findings on the exact same file+line are almost always the
      // same issue phrased differently — collapse them (matches multi_review).
      const sameLineCrossAgent = h.line > 0 && h.line === f.line && h.agent !== f.agent;
      if (sameFile && (sameTitle || sameLineCrossAgent || (nearLine && titlesOverlap(h.title, f.title)))) {
        g.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([f]);
  }

  const merged: IacFinding[] = [];
  for (const g of groups) {
    g.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    const canonical = { ...g[0], cross_validated_by: [] as string[] };
    const others = [...new Set(g.slice(1).map((x) => x.agent))].filter((a) => a !== canonical.agent);
    canonical.cross_validated_by = others;
    merged.push(canonical);
  }
  merged.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  return merged;
}

function titlesOverlap(a: string, b: string): boolean {
  const wa = new Set(normTitle(a).split(" ").filter((w) => w.length > 3));
  const wb = new Set(normTitle(b).split(" ").filter((w) => w.length > 3));
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size) >= 0.5;
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export function renderReport(receipt: IacReviewReceipt): string {
  const { kind, findings, agents, agent_runs } = receipt;
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  // Concise target label — never leak an absolute local/scratchpad path into a
  // posted PR comment; show the trailing path segments only.
  const segs = receipt.target.replace(/\/+$/, "").split("/").filter(Boolean);
  const targetLabel = segs.length <= 3 ? receipt.target : `…/${segs.slice(-3).join("/")}`;

  const lines: string[] = [];
  lines.push(`# ${kind} review — \`${targetLabel}\``);
  lines.push("");
  lines.push(
    `Agents: ${agents.join(", ") || "(none)"} · Files: ${receipt.files_reviewed.length}` +
      (receipt.scanners_run.length ? ` · Scanners: ${receipt.scanners_run.join(", ")}` : ""),
  );
  if (receipt.scanners_skipped.length) {
    lines.push(`_Scanners skipped: ${receipt.scanners_skipped.join("; ")}_`);
  }
  const runBits = agent_runs.map(
    (r) => `${r.agent}${r.ok ? "" : `✗(${r.error})`}${r.api_key_fallback ? "·apikey" : ""}=${r.finding_count}`,
  );
  if (runBits.length) lines.push(`Runs: ${runBits.join(" · ")}`);
  lines.push("");

  if (findings.length === 0) {
    lines.push("✅ No findings. Clean for the reviewed scope.");
  } else {
    for (const sev of ["critical", "high", "medium", "low"] as Severity[]) {
      const group = findings.filter((f) => f.severity === sev);
      if (group.length === 0) continue;
      for (const f of group) {
        const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "_general_";
        const xval = f.cross_validated_by.length
          ? ` _(also flagged by: ${f.cross_validated_by.join(", ")})_`
          : "";
        lines.push(`### [${sev.toUpperCase()}] ${f.title}`);
        lines.push(`- **Where:** ${where} · _via ${f.agent}_${xval}`);
        if (f.description) lines.push(`- **Why:** ${f.description}`);
        if (f.suggestion) lines.push(`- **Fix:** ${f.suggestion}`);
        lines.push("");
      }
    }
  }

  const block = counts.critical > 0 || counts.high > 0;
  lines.push("---");
  lines.push(
    `**Verdict:** ${counts.critical} critical · ${counts.high} high · ${counts.medium} medium · ${counts.low} low — ` +
      (findings.length === 0 ? "approve" : block ? "block (fix critical/high)" : "approve-with-nits"),
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runIacReview(opts: RunIacReviewOpts): Promise<IacReviewReceipt> {
  const log = opts.log ?? (() => {});
  const cfg = getIacReviewConfig();
  const { agents, skipped } = resolveAgents(opts.agents, cfg.agents);
  for (const s of skipped) log(`skip agent: ${s}`);

  const maxFiles = cfg.max_files ?? 80;
  const maxBytes = cfg.max_bytes_per_file ?? 100_000;
  const timeoutSec = opts.timeoutSec ?? cfg.timeout_sec ?? 600;

  const files = collectFiles(opts.kind, opts.target, !!opts.changed, maxFiles, maxBytes);
  const absTarget = path.resolve(opts.target);
  const dir = existsSync(absTarget) && statSync(absTarget).isDirectory() ? absTarget : path.dirname(absTarget);

  let scannerReport = "";
  let scannersRan: string[] = [];
  let scannersSkipped: string[] = [];
  if (!opts.noTools && files.length > 0) {
    const s = runScanners(opts.kind, dir, !!opts.trustSource);
    scannerReport = s.report;
    scannersRan = s.ran;
    scannersSkipped = s.skipped;
    if (scannersRan.length) log(`scanners: ${scannersRan.join(", ")}`);
    for (const sk of scannersSkipped) log(`scanner skipped: ${sk}`);
  }

  const receipt: IacReviewReceipt = {
    kind: opts.kind,
    target: opts.target,
    agents,
    files_reviewed: files.map((f) => f.rel),
    scanners_run: scannersRan,
    scanners_skipped: scannersSkipped,
    agent_runs: [],
    findings: [],
    posted_pr: null,
    posted_ok: null,
    dry_run: !!opts.dryRun,
  };

  if (opts.dryRun) {
    log(`[dry-run] would dispatch ${agents.join(", ")} over ${files.length} file(s)`);
    return receipt;
  }
  if (agents.length === 0) {
    log("no enabled agents resolved — nothing to dispatch");
    return receipt;
  }
  if (files.length === 0) {
    log(`no ${opts.kind} files found under ${opts.target}`);
    return receipt;
  }

  const rubric = await loadRubric(opts.kind);
  const prompt = buildPrompt(rubric, buildContextPack(files, scannerReport));

  // Dispatch every agent in parallel — each is its own subagent.
  const results = await Promise.all(
    agents.map(async (agent): Promise<{ agent: AgentName; outcome: AgentCallOutcome; findings: IacFinding[] }> => {
      log(`dispatch: ${agent} (${resolveModel(agent)})`);
      const outcome = await callAgent(agent, prompt, timeoutSec);
      const parsed = outcome.error ? [] : parseFindings(outcome.raw, agent);
      return { agent, outcome, findings: parsed };
    }),
  );

  const all: IacFinding[] = [];
  for (const r of results) {
    receipt.agent_runs.push({
      agent: r.agent,
      model: resolveModel(r.agent),
      ok: !r.outcome.error,
      error: r.outcome.error,
      finding_count: r.findings.length,
      duration_s: Math.round(r.outcome.duration_s * 10) / 10,
      api_key_fallback: r.outcome.api_key_fallback,
    });
    all.push(...r.findings);
  }

  let findings = dedupeFindings(all);
  if (opts.minSeverity) {
    const floor = SEVERITY_ORDER[opts.minSeverity];
    findings = findings.filter((f) => SEVERITY_ORDER[f.severity] <= floor);
  }
  receipt.findings = findings;

  // Optional PR posting (authored by the first agent's GitHub App).
  if (opts.pr && opts.repo) {
    const app = APP_FOR_AGENT[agents[0]];
    const body =
      renderReport(receipt) +
      `\n\n<sub>🤖 stark-${opts.kind}-review · agents: ${agents.join(", ")}</sub>`;
    try {
      await prReview(opts.repo, opts.pr, "COMMENT", body, app);
      receipt.posted_pr = opts.pr;
      receipt.posted_ok = true;
      log(`posted findings to ${opts.repo}#${opts.pr} as ${app}`);
    } catch (err) {
      receipt.posted_pr = opts.pr;
      receipt.posted_ok = false;
      log(`PR post failed: ${(err as Error).message}`);
    }
  }

  return receipt;
}
