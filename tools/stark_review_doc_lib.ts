/**
 * Pure helpers for the doc-review dispatcher (`stark_review_doc.ts`).
 *
 * Shared by /stark-review-design and /stark-review-plan. No I/O at the top
 * level; functions that touch disk take explicit roots. Designed for
 * unit-test friendliness — every step that has an interesting branch lives
 * here behind a pure function.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import type { AgentName, Severity } from "./stark_review_lib.ts";
import { severityMeetsThreshold, severityRank } from "./stark_review_lib.ts";

// ─── Types ───────────────────────────────────────────────────────────────

export type Classification = "fix" | "recurring" | "false_positive" | "noise" | "ignored";

export interface DocFinding {
  id: string;
  agent: AgentName;
  domain: string;
  severity: Severity;
  section: string;
  title: string;
  description: string;
  suggestion: string;
  classification?: Classification;
  classification_reason?: string;
}

export interface DomainEntry {
  /** Slug derived from filename (e.g. "completeness"). */
  key: string;
  /** Source filename (e.g. "01-completeness.md"). */
  filename: string;
  /** Order prefix from the filename, used for stable sort. */
  order: string;
}

export interface PromptSources {
  agentMd: string;
  domainPrompt: string;
}

export interface DocReviewConfig {
  agents: AgentName[];
  fix_threshold: Severity;
  disabled_domains: string[];
  max_rounds: number;
  /** Skill-local cap on concurrent codex dispatches (codex serializes hard on
   * ChatGPT-tier accounts; bump cautiously). */
  max_codex_concurrent: number;
}

export const DEFAULT_DOC_REVIEW_CONFIG: DocReviewConfig = {
  agents: ["codex"],
  fix_threshold: "medium",
  disabled_domains: [],
  max_rounds: 3,
  max_codex_concurrent: 3,
};

/** Hard ceiling — mirrors `stark_review.ts` MAX_ROUNDS_CEILING. Stops runaway
 * config from spending hours on a single document. */
export const MAX_ROUNDS_CEILING = 10;

// ─── Prompt resolution ──────────────────────────────────────────────────

const DOMAIN_FILE_RE = /^(\d{2})-(.+)\.md$/;

/**
 * Discover domains for a doc-review prompts dir.
 *
 * Walks each agent subdirectory first (in `agents` order) for `NN-*.md`
 * files; falls back to `<promptsDir>/domains/` when an agent dir is empty
 * or missing. Agent-specific entries override shared ones with the same
 * slug. Returns a stable sorted list.
 */
export function discoverDomains(
  promptsDir: string,
  agents: readonly AgentName[],
): DomainEntry[] {
  const found = new Map<string, DomainEntry>();

  for (const agent of agents) {
    const dir = path.join(promptsDir, agent);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const m = entry.match(DOMAIN_FILE_RE);
      if (!m) continue;
      const order = m[1]!;
      const key = m[2]!;
      if (!found.has(key)) found.set(key, { key, filename: entry, order });
    }
  }

  const sharedDir = path.join(promptsDir, "domains");
  if (fs.existsSync(sharedDir)) {
    for (const entry of fs.readdirSync(sharedDir)) {
      const m = entry.match(DOMAIN_FILE_RE);
      if (!m) continue;
      const order = m[1]!;
      const key = m[2]!;
      if (!found.has(key)) found.set(key, { key, filename: entry, order });
    }
  }

  return [...found.values()].sort((a, b) => {
    if (a.order !== b.order) return a.order < b.order ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
}

/**
 * Resolve an agent's `agent.md` + per-domain prompt for a single doc-review
 * dispatch.
 *
 * Lookup order for the domain prompt:
 *   1. `<repoDir>/.code-review/<repoSubdir>/<agent>/<domain-file>`
 *   2. `<promptsDir>/<agent>/<NN-domain>.md`
 *   3. `<promptsDir>/domains/<NN-domain>.md`            (cross-agent fallback)
 *
 * Lookup order for `agent.md`:
 *   1. `<repoDir>/.code-review/<repoSubdir>/<agent>/agent.md`
 *   2. `<promptsDir>/<agent>/agent.md`
 *
 * Throws when the domain prompt cannot be found anywhere.
 */
export function resolveDocPromptSources(opts: {
  agent: AgentName;
  domain: string;
  promptsDir: string;
  repoDir?: string | null;
  /** Repo override subdirectory under `.code-review/`. Matches the Python
   * dispatcher_base convention (`design-prompts`, `plan-prompts`). */
  repoSubdir: string;
}): PromptSources {
  const { agent, domain, promptsDir, repoSubdir } = opts;
  const repoDir = opts.repoDir ?? null;

  let domainText: string | null = null;
  let agentText: string | null = null;

  if (repoDir) {
    const repoAgentDir = path.join(repoDir, ".code-review", repoSubdir, agent);
    if (fs.existsSync(repoAgentDir)) {
      const f = findDomainFileInDir(repoAgentDir, domain);
      if (f) domainText = fs.readFileSync(path.join(repoAgentDir, f), "utf-8");
      const a = path.join(repoAgentDir, "agent.md");
      if (fs.existsSync(a)) agentText = fs.readFileSync(a, "utf-8");
    }
  }

  const globalAgentDir = path.join(promptsDir, agent);
  if (domainText === null) {
    const f = findDomainFileInDir(globalAgentDir, domain);
    if (f) domainText = fs.readFileSync(path.join(globalAgentDir, f), "utf-8");
  }
  if (agentText === null) {
    const a = path.join(globalAgentDir, "agent.md");
    if (fs.existsSync(a)) agentText = fs.readFileSync(a, "utf-8");
  }

  if (domainText === null) {
    const sharedDir = path.join(promptsDir, "domains");
    const f = findDomainFileInDir(sharedDir, domain);
    if (f) domainText = fs.readFileSync(path.join(sharedDir, f), "utf-8");
  }

  if (domainText === null) {
    throw new Error(
      `resolveDocPromptSources: domain prompt not found for agent=${agent} domain=${domain} (checked repo override, ${path.join(promptsDir, agent)}, ${path.join(promptsDir, "domains")})`,
    );
  }

  return {
    agentMd: agentText ?? "",
    domainPrompt: domainText,
  };
}

function findDomainFileInDir(dir: string, domain: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    const m = entry.match(DOMAIN_FILE_RE);
    if (m && m[2] === domain) return entry;
  }
  return null;
}

// ─── Reviewer prompt assembly ───────────────────────────────────────────

/**
 * Reviewer output contract — strict JSON-array shape mirroring the Python
 * `FINDINGS_FORMAT`. Reviewers emit a single JSON array on stdout (with the
 * codex JSONL wrapper handled by the agent_codex parser).
 *
 * Distinct from `FINDING_SCHEMA_PROMPT` in stark_review_lib.ts (which is
 * JSONL with `file`/`line` for PR reviews) — design/plan reviews are
 * section-oriented and do not have file/line locations.
 */
export const DOC_FINDINGS_FORMAT = [
  "## Output Contract (CANONICAL)",
  "",
  "Emit findings as a single JSON array. Output ONLY the JSON array — no preamble, no markdown fences, no commentary.",
  "",
  "Each finding object:",
  '  {"severity": "critical|high|medium|low", "section": "<heading text>", "title": "<short title>", "description": "<what is wrong>", "suggestion": "<how to fix it>"}',
  "",
  "If you have nothing to report, emit EXACTLY:",
  "  []",
  "",
  "An empty stdout, prose-only stdout, or a JSON object instead of an array is treated as a parser failure and your review is discarded.",
].join("\n");

export function buildReviewerPrompt(opts: {
  agentMd: string;
  domainPrompt: string;
  doc: string;
}): string {
  const parts = [
    opts.agentMd.trim(),
    "",
    opts.domainPrompt.trim(),
    "",
    DOC_FINDINGS_FORMAT,
    "",
    "## Document under review",
    "",
    opts.doc,
  ];
  return parts.filter((p, i) => p.length > 0 || i === 0).join("\n");
}

/**
 * Parse a reviewer's raw stdout into findings. Tolerates code fences, surrounding
 * prose, and trailing/leading whitespace. Returns `null` on parse failure so the
 * caller can decide whether to treat it as `dispatch_failure` or `noise`.
 */
export interface ReviewerParseOutcome {
  findings: Array<Pick<DocFinding, "severity" | "section" | "title" | "description" | "suggestion">>;
  /** True when the agent emitted an explicit empty array (clean review). */
  emptyAck: boolean;
  /** Raw text actually parsed (post-fence-strip), surfaced on failure. */
  candidate: string;
}

export function parseReviewerOutput(raw: string): ReviewerParseOutcome | null {
  if (!raw) return null;
  let text = raw.trim();

  const fence = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fence && fence[1]) text = fence[1].trim();

  // Try parsing the whole text first — if it parses to something non-array
  // (object, string, number), that's a contract violation. Bracket extraction
  // would otherwise pull the inner array out of `{"findings": []}` and
  // pretend it was a clean review.
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }

  let candidate = text;
  if (parsed === undefined) {
    // Fall back to substring extraction only when the whole text isn't valid
    // JSON — handles preamble/postamble noise around an otherwise-valid array.
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end <= start) return null;
    candidate = text.slice(start, end + 1);
    try {
      parsed = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;

  if (parsed.length === 0) {
    return { findings: [], emptyAck: true, candidate };
  }

  const out: ReviewerParseOutcome["findings"] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const severity = typeof o.severity === "string" ? o.severity.toLowerCase() : "";
    if (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low") continue;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    if (!title) continue;
    out.push({
      severity: severity as Severity,
      section: typeof o.section === "string" ? o.section : "",
      title,
      description: typeof o.description === "string" ? o.description : "",
      suggestion: typeof o.suggestion === "string" ? o.suggestion : "",
    });
  }
  return { findings: out, emptyAck: false, candidate };
}

/**
 * Stable 12-hex-char id for a finding, derived from (domain, agent, section, title).
 * Used to detect recurring findings across rounds.
 */
export function docFindingId(opts: {
  domain: string;
  agent: AgentName;
  section: string;
  title: string;
}): string {
  const normalized = `${opts.domain}|${opts.agent}|${opts.section.toLowerCase().trim()}|${opts.title.toLowerCase().trim()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

// ─── Classification ─────────────────────────────────────────────────────

export interface ClassifyContext {
  /** Findings from prior rounds that were flagged for fix. Used to detect
   * `recurring` findings — same (section, domain, agent) showed up again. */
  priorFixed: DocFinding[];
  fixThreshold: Severity;
}

/**
 * Light heuristic classifier — deterministic, no LLM call.
 *
 * - severity < threshold        → `ignored`
 * - same (section,domain,agent) as a prior `fix` finding → `recurring`
 * - cross-agent dedup match (same section+title across agents) → keep first as `fix`, mark others `noise`
 * - else                        → `fix`
 */
export function classifyFindings(
  raw: DocFinding[],
  ctx: ClassifyContext,
): DocFinding[] {
  const priorKeys = new Set(
    ctx.priorFixed.map((f) => `${f.section}|${f.domain}|${f.agent}`),
  );
  const seenAgentTitle = new Set<string>();
  const out: DocFinding[] = [];
  for (const f of raw) {
    let classification: Classification;
    let reason = "";
    if (!severityMeetsThreshold(f.severity, ctx.fixThreshold)) {
      classification = "ignored";
      reason = `severity ${f.severity} < threshold ${ctx.fixThreshold}`;
    } else if (priorKeys.has(`${f.section}|${f.domain}|${f.agent}`)) {
      classification = "recurring";
      reason = "same (section, domain, agent) flagged in a prior round";
    } else {
      const dedupKey = `${f.section}|${f.title}`;
      if (seenAgentTitle.has(dedupKey)) {
        classification = "noise";
        reason = "duplicate (section, title) within this round";
      } else {
        seenAgentTitle.add(dedupKey);
        classification = "fix";
        reason = `severity ${f.severity} >= threshold ${ctx.fixThreshold}`;
      }
    }
    out.push({ ...f, classification, classification_reason: reason });
  }
  return out;
}

export function selectFindingsToFix(findings: DocFinding[]): DocFinding[] {
  return findings.filter(
    (f) => f.classification === "fix" || f.classification === "recurring",
  ).sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

// ─── Wing fixer prompt + patch contract ─────────────────────────────────

/**
 * Wing fixer output contract — a JSON object with a `patches` array.
 *
 * Each patch is a surgical block-replacement on the document. `old` must
 * appear EXACTLY ONCE in the current document; the host applier rejects
 * patches whose `old` matches zero or multiple times. To insert content,
 * include an anchor in `old` (e.g. the heading the new content follows).
 */
export const WING_FIXER_CONTRACT = [
  "## Output Contract (CANONICAL)",
  "",
  "Emit EXACTLY ONE JSON object at the end of your response and nothing else after it. The block-replace shape:",
  "",
  "```json",
  "{",
  '  "summary": "<one sentence describing what you changed>",',
  '  "patches": [',
  "    {",
  '      "finding_id": "<id from the findings list>",',
  '      "old": "<exact existing text — must occur EXACTLY ONCE in the document>",',
  '      "new": "<replacement text>"',
  "    }",
  "  ],",
  '  "skipped": [',
  '    {"finding_id": "<id>", "reason": "<why this finding was not addressed>"}',
  "  ]",
  "}",
  "```",
  "",
  "Rules:",
  "- `old` MUST be a non-empty substring of the CURRENT document AND occur exactly once. To insert new content, include an anchor in `old` (e.g. the heading or sentence the new content should follow) and put the anchor + new content in `new`.",
  "- Preserve all surrounding markdown formatting verbatim (whitespace, blank lines, indentation, list markers).",
  "- Make the MINIMUM change needed to address each finding. Do not rewrite whole sections when a sentence-level edit will do.",
  "- Group multiple findings that touch the same paragraph into ONE patch with all the needed edits.",
  "- If you cannot address a finding (out of scope, requires author judgment, etc.), put it in `skipped` with a one-sentence reason. Do not silently drop findings.",
  "- Output ONLY the JSON object after your reasoning. No prose after the closing brace.",
].join("\n");

export interface FixerPatch {
  finding_id: string;
  old: string;
  new: string;
}

export interface FixerOutput {
  summary: string;
  patches: FixerPatch[];
  skipped: Array<{ finding_id: string; reason: string }>;
}

export interface FixerParseOutcome {
  parsed: FixerOutput | null;
  /** When the model emitted prose without a JSON object, or the JSON did not
   * match the contract, this carries a short reason for the receipt. */
  error: string | null;
}

export function buildFixerPrompt(opts: {
  doc: string;
  findings: DocFinding[];
  /** Patches that were rejected in a prior fixer attempt this round, with the
   * reason. Used when retrying the wing after a partial failure. */
  retryFailures?: Array<{ patch: FixerPatch; reason: string }>;
  /** Round number — surfaced to the model so it sees how many attempts have
   * happened. */
  roundNum: number;
}): string {
  const findingsJson = JSON.stringify(
    opts.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      domain: f.domain,
      section: f.section,
      title: f.title,
      description: f.description,
      suggestion: f.suggestion,
    })),
    null,
    2,
  );
  const parts: string[] = [
    "# Design Review Fix Pass — Round " + String(opts.roundNum),
    "",
    "You are the **wing fixer** for stark-review-doc. The **lead reviewer** (codex) has surfaced the findings below against the document. Your job is to address every finding with surgical edits.",
    "",
    "## Document under review",
    "",
    opts.doc,
    "",
    "## Findings to address (JSON)",
    "",
    "```json",
    findingsJson,
    "```",
    "",
  ];
  if (opts.retryFailures && opts.retryFailures.length > 0) {
    parts.push(
      "## Prior patch failures this round",
      "",
      "These patches from your previous attempt could not be applied. Either include more surrounding context so `old` becomes unique, or revise the patch entirely. Do not repeat the same patch verbatim.",
      "",
      "```json",
      JSON.stringify(opts.retryFailures, null, 2),
      "```",
      "",
    );
  }
  parts.push(WING_FIXER_CONTRACT);
  return parts.join("\n");
}

/**
 * Extract the trailing JSON object from the wing's raw output.
 *
 * Walks the text balancing braces with string/escape awareness — `{` inside
 * a JSON string never desyncs the depth counter. Returns the LAST top-level
 * object that parses to a dict containing `patches`. Mirrors the
 * `extractVerdictJson` strategy from copilot_dispatch.ts.
 */
export function extractFixerJson(text: string): Record<string, unknown> | null {
  if (!text) return null;

  const fenceCandidates: string[] = [];
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;
  for (const m of text.matchAll(fenceRe)) {
    if (m[1]) fenceCandidates.push(m[1].trim());
  }

  const bareCandidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          bareCandidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  // Try fenced first (they're explicitly intended as the structured payload);
  // fall back to bare candidates in reverse order so the trailing object wins.
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object" && !Array.isArray(obj) && "patches" in obj) {
        return obj as Record<string, unknown>;
      }
    } catch { /* ignore */ }
    return null;
  };
  for (let i = fenceCandidates.length - 1; i >= 0; i--) {
    const p = tryParse(fenceCandidates[i]!);
    if (p) return p;
  }
  for (let i = bareCandidates.length - 1; i >= 0; i--) {
    const p = tryParse(bareCandidates[i]!);
    if (p) return p;
  }
  return null;
}

export function parseFixerOutput(raw: string): FixerParseOutcome {
  const obj = extractFixerJson(raw);
  if (!obj) {
    return { parsed: null, error: "no_json_object_with_patches" };
  }

  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const patchesRaw = Array.isArray(obj.patches) ? obj.patches : null;
  if (!patchesRaw) {
    return { parsed: null, error: "patches_not_an_array" };
  }
  const patches: FixerPatch[] = [];
  for (const p of patchesRaw) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    const id = typeof r.finding_id === "string" ? r.finding_id : "";
    const oldText = typeof r.old === "string" ? r.old : "";
    const newText = typeof r.new === "string" ? r.new : "";
    if (!oldText) continue;
    patches.push({ finding_id: id, old: oldText, new: newText });
  }
  const skippedRaw = Array.isArray(obj.skipped) ? obj.skipped : [];
  const skipped: Array<{ finding_id: string; reason: string }> = [];
  for (const s of skippedRaw) {
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    skipped.push({
      finding_id: typeof r.finding_id === "string" ? r.finding_id : "",
      reason: typeof r.reason === "string" ? r.reason : "",
    });
  }
  return { parsed: { summary, patches, skipped }, error: null };
}

// ─── Patch applier ──────────────────────────────────────────────────────

export interface PatchApplyResult {
  newDoc: string;
  applied: FixerPatch[];
  failures: Array<{ patch: FixerPatch; reason: string }>;
}

/**
 * Apply patches sequentially against `doc`.
 *
 * Each patch's `old` must appear exactly once in the CURRENT document state
 * (after prior patches in this batch have landed). Patches that fail
 * (`old_not_found`, `old_ambiguous`) are collected in `failures` so the
 * caller can retry the wing with more context. Successful patches stay
 * applied — partial progress is preserved.
 *
 * Note: ordering matters. The wing may produce overlapping patches whose
 * `old` strings depend on each other — we apply in submission order so
 * earlier patches can dissolve duplicates that would otherwise make later
 * patches ambiguous.
 */
export function applyPatches(doc: string, patches: readonly FixerPatch[]): PatchApplyResult {
  let current = doc;
  const applied: FixerPatch[] = [];
  const failures: PatchApplyResult["failures"] = [];

  for (const patch of patches) {
    if (patch.old.length === 0) {
      failures.push({ patch, reason: "empty_old" });
      continue;
    }
    const first = current.indexOf(patch.old);
    if (first === -1) {
      failures.push({ patch, reason: "old_not_found" });
      continue;
    }
    const second = current.indexOf(patch.old, first + 1);
    if (second !== -1) {
      failures.push({ patch, reason: "old_ambiguous" });
      continue;
    }
    current = current.slice(0, first) + patch.new + current.slice(first + patch.old.length);
    applied.push(patch);
  }
  return { newDoc: current, applied, failures };
}

// ─── Round persistence ─────────────────────────────────────────────────

export interface PersistedRound {
  round: number;
  kind: "review-fix" | "final-review";
  agents_run: AgentName[];
  domains_run: string[];
  results_count: number;
  failed_count: number;
  findings: DocFinding[];
  fix?: {
    attempted: number;
    applied: number;
    skipped_by_wing: number;
    patch_failures: Array<{ patch: FixerPatch; reason: string }>;
    commit_sha: string | null;
    wing_error: string | null;
  };
  duration_s: number;
}

export function buildHistoryDir(opts: {
  home: string;
  promptsDir: string;
  docPath: string;
}): string {
  const base = path.join(
    opts.home,
    ".claude",
    "code-review",
    "history",
    opts.promptsDir + "s",
  );
  const slug = path.basename(opts.docPath).replace(/\.md$/i, "");
  return path.join(base, slug);
}

export function persistRoundsHistory(opts: {
  historyDir: string;
  docPath: string;
  promptsDir: string;
  rounds: PersistedRound[];
  models: Record<string, string>;
}): void {
  fs.mkdirSync(opts.historyDir, { recursive: true });
  const payload = {
    doc: opts.docPath,
    prompts_dir: opts.promptsDir,
    models: opts.models,
    rounds: opts.rounds,
    generated_at: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(opts.historyDir, "rounds.json"),
    JSON.stringify(payload, null, 2),
  );
}

// ─── Concurrency primitives ────────────────────────────────────────────

/**
 * Run `tasks` with at most `limit` running concurrently. Returns results in
 * submission order. Tasks throwing reject the entire batch — callers should
 * catch inside each task and surface error as a result.
 */
export async function pmap<T, U>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (limit <= 0) throw new Error("pmap: limit must be > 0");
  const out: U[] = new Array(items.length);
  let cursor = 0;
  const runners: Array<Promise<void>> = [];
  const active = Math.min(limit, items.length);
  for (let w = 0; w < active; w++) {
    runners.push((async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await worker(items[i]!, i);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}
