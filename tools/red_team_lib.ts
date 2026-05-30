/**
 * Red-team dispatcher core.
 *
 * Shared by `tools/red_team_design.ts` and `tools/red_team_plan.ts`. Owns
 * the full red-team flow that previously lived in the Python dispatcher
 * (deleted in Phase 4 of the 2026-05-16 migration). No I/O at the top
 * level; functions that touch disk or spawn subprocesses take explicit
 * roots so they're unit-testable.
 *
 * What this lib owns:
 *   - persona / prompt resolution from `global/prompts/red-team/`
 *   - per-persona Codex dispatch (or a recorded transcript replay)
 *   - finding validation + aggregation
 *   - sidecar markdown rendering
 *   - local SQLite audit writes via `tools/red_team_audit_lib.ts`
 *   - pre-dispatch sensitive-data gate + post-write redaction
 *   - data-classification gate (frontmatter-driven)
 *
 * What this lib explicitly does NOT own (yet — Phase 5 follow-ups):
 *   - the fix-loop / multi-round refinement. The TS lib runs **one** round
 *     with all personas; stability testing + verification rounds were never
 *     ported (the Python equivalent was deleted in Phase 4).
 *   - PR posting (rendered body is returned; the caller posts).
 *   - excerpt-mode retention on free-text fields (`retention_mode: "full"`
 *     is hard-coded for audit writes; `redact()` is the
 *     defense-in-depth backstop).
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  loadAuditPolicy,
  recordRedTeamRun,
  recordFindings as auditRecordFindings,
  type FindingRow,
  type RedTeamRunRow,
} from "./red_team_audit_lib.ts";
import {
  applyToField,
  policyMode,
  type AuditRetentionPolicy,
} from "./red_team_audit_text_lib.ts";
import { resolveDb } from "./red_team_db_resolver.ts";
import { resolveOpenaiApiKey } from "./preflight_lib.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type Severity = "critical" | "high" | "medium" | "low";

export type PersonaSlug =
  | "security-trust"
  | "reliability-distsys"
  | "data"
  | "product-dx"
  | "cost-ops";

export type Stage = "design" | "plan";

export interface RedTeamFinding {
  id: string;
  persona: PersonaSlug;
  severity: Severity;
  concern: string;
  consequence: string;
  /** Concrete alternative, or the literal `REQUEST_HUMAN_REVIEW`. */
  counter_proposal: string;
  /** Required for Shape-A findings. */
  trade_off: string | null;
  /** Required for Shape-B (REQUEST_HUMAN_REVIEW) findings. */
  reason_for_uncertainty: string | null;
  /** FU-rt5 structured identity columns. */
  risk_key: string | null;
  affected_component: string | null;
  failure_mode: string | null;
  /** Stable hash over the canonical identity inputs. */
  concern_hash: string;
}

export interface RedTeamResult {
  stage: Stage;
  round_num: number;
  synthesis: string;
  findings: RedTeamFinding[];
  blocking_count: number;
  human_review_count: number;
  raw_output: string;
  duration_s: number;
  cost_usd: number;
  error: string | null;
  input_tokens: number;
  output_tokens: number;
}

export interface RedTeamRunContext {
  run_id: string;
  stage: Stage;
  artifact_path: string;
  source_spec_path: string | null;
  /** Repo nameWithOwner if detectable. */
  repo: string | null;
  /** Relative-to-repo-root path of the artifact. */
  artifact_relative_path: string | null;
  /** PR number if detectable (e.g. from a CI env var). */
  pr_number: number | null;
  /** Resolved at run-start; passed to the audit CLI on every shell-out. */
  db_path: string;
  /** ISO timestamp at run-start. */
  started_at: string;
}

export interface PersonaPrompts {
  preamble: string;
  stageTemplate: string;
  personas: Map<PersonaSlug, string>;
}

export interface DispatchResult {
  status: "clean" | "halted" | "halted_human_review" | "error";
  run_id: string;
  model: string;
  total_findings: number;
  blocking_count: number;
  human_review_count: number;
  cost_usd: number;
  duration_s: number;
  synthesis: string;
  sidecar_path: string | null;
  pr_comment_body: string | null;
  pr_comment_marker: string;
  error: string | null;
  findings: RedTeamFinding[];
  fix_plan_status: FixPlanStatus;
  fix_plan: RedTeamFixPlan | null;
}

export interface FixPlanMove {
  id: string;
  title: string;
  rationale: string;
  sections_touched: string[];
  addressed_finding_ids: string[];
  new_trade_off: string;
}

export interface RedTeamFixPlan {
  summary: string;
  moves: FixPlanMove[];
  unaddressed_finding_ids: string[];
  orphan_finding_ids: string[];
  notes: string;
  input_truncated: boolean;
  input_omitted_finding_ids: string[];
  warnings: string[];
  raw_output: string;
  duration_s: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  model: string;
  reasoning_effort: string;
  error: string | null;
}

export interface FixPlanConfig {
  enabled: boolean;
  model: string;
  reasoning_effort: string;
  timeout_s: number;
  min_moves: number;
  max_moves: number;
  max_input_chars: number;
}

export type FixPlanStatus =
  | "success"
  | "error"
  | "skipped_disabled"
  | "skipped_kill_switch"
  | "skipped_challenge_error"
  | "skipped_human_review_only"
  | "skipped_clean"
  | "skipped_budget_exhausted"
  | "skipped_input_too_large"
  | "skipped_replay";

// ── Constants ────────────────────────────────────────────────────────────

export const VALID_PERSONAS: readonly PersonaSlug[] = [
  "security-trust",
  "reliability-distsys",
  "data",
  "product-dx",
  "cost-ops",
] as const;

export const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "critical",
  "high",
  "medium",
  "low",
]);

export const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set([
  "critical",
  "high",
]);

export const REPO_ROOT = (() => {
  // The lib lives at <repo>/tools/red_team_lib.ts. Walk up two levels for
  // the repo root so dispatchers can resolve sibling paths (scripts/,
  // global/) without being passed an explicit root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
})();

export const PROMPTS_DIR = path.join(REPO_ROOT, "global", "prompts", "red-team");
// All audit writes go through `tools/red_team_audit_lib.ts` directly.

// ── Prompt resolution ────────────────────────────────────────────────────

/** Load all persona-related prompts from disk. Throws on missing files. */
export function loadPersonaPrompts(
  promptsDir: string = PROMPTS_DIR,
  stage: Stage = "design",
): PersonaPrompts {
  const preamblePath = path.join(promptsDir, "preamble.md");
  const stagePath = path.join(promptsDir, `${stage}.md`);
  const preamble = fs.readFileSync(preamblePath, "utf8");
  const stageTemplate = fs.readFileSync(stagePath, "utf8");
  const personas = new Map<PersonaSlug, string>();
  for (const slug of VALID_PERSONAS) {
    const p = path.join(promptsDir, "personas", `${slug}.md`);
    personas.set(slug, fs.readFileSync(p, "utf8"));
  }
  return { preamble, stageTemplate, personas };
}

/**
 * Assemble the full prompt sent to Codex.
 *
 * Wraps the artifact / source-spec inside guarded `<<<RED_TEAM_INPUT>>>`
 * envelopes that mirror the Python `assemble_prompt` injection-guard
 * pattern — a prompt-injection in the doc that tries to escape the
 * envelope hits a hash-validated boundary instead of the model's
 * instructions.
 */
export function assemblePrompt(args: {
  prompts: PersonaPrompts;
  personas: PersonaSlug[];
  artifact: string;
  sourceSpec: string;
  artifactName?: string;
}): string {
  const { prompts, personas, artifact, sourceSpec } = args;
  const parts: string[] = [];
  parts.push(prompts.preamble);
  parts.push("");
  parts.push("## Personas");
  for (const slug of personas) {
    const body = prompts.personas.get(slug);
    if (body) {
      parts.push(`### ${slug}`);
      parts.push(body);
    }
  }
  parts.push("");
  parts.push(prompts.stageTemplate);
  parts.push("");
  parts.push(`<<<RED_TEAM_INPUT name="artifact">>>`);
  parts.push(artifact);
  parts.push(`<<<RED_TEAM_INPUT_END name="artifact">>>`);
  parts.push("");
  parts.push(`<<<RED_TEAM_INPUT name="source_spec">>>`);
  parts.push(sourceSpec);
  parts.push(`<<<RED_TEAM_INPUT_END name="source_spec">>>`);
  parts.push("");
  return parts.join("\n");
}

// ── Redaction sanitizer ─────────────────────────────────────────────────
//
// Run before every
// output sink (sidecar, stdout, PR comment, audit shell-out body) as a
// defense-in-depth backstop after the pre-dispatch gate.

const REDACTION_RULES: ReadonlyArray<[RegExp, string]> = [
  // Token-shaped secrets (must come before generic base64).
  [/sk-[A-Za-z0-9_-]{10,}/g, "sk-[REDACTED]"],
  [/ghp_[A-Za-z0-9]{10,}/g, "ghp_[REDACTED]"],
  [/ghs_[A-Za-z0-9]{10,}/g, "ghs_[REDACTED]"],
  // PII patterns (mirror red_team_audit_text).
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[EMAIL-REDACTED]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP-REDACTED]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN-REDACTED]"],
  [/\b\d{4}[ \-]?\d{4}[ \-]?\d{4}[ \-]?\d{4}\b/g, "[CC-REDACTED]"],
  [/\b(?:\(?\d{3}\)?[ \-.]?)\d{3}[ \-.]?\d{4}\b/g, "[PHONE-REDACTED]"],
  // Catch-all for long base64-shaped secrets. Must run last because it
  // matches a lot.
  [/[A-Za-z0-9+/]{41,}={0,2}/g, "[BASE64-REDACTED]"],
];

/** Run the regex set over `text`. Returns the sanitized string. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Pre-dispatch sensitive-data gate. Scan the assembled provider request
 * (prompt + artifact + source-spec) for token / key / PII patterns AND
 * prompt-injection directives that try to exfiltrate adjacent files.
 *
 * Returns a non-empty array of matched pattern names when the gate should
 * refuse, or an empty array when clean. The caller writes an audit row
 * with `final_status: "halted"` + reason and exits non-zero.
 */
export function preDispatchSensitiveGate(payload: string): string[] {
  const hits: string[] = [];
  // Secret-shaped tokens.
  if (/sk-[A-Za-z0-9_-]{10,}/.test(payload)) hits.push("openai_token");
  if (/ghp_[A-Za-z0-9]{10,}/.test(payload)) hits.push("github_pat");
  if (/ghs_[A-Za-z0-9]{10,}/.test(payload)) hits.push("github_install_token");
  // GCP service-account key material.
  if (/"private_key"\s*:\s*"-----BEGIN PRIVATE KEY-----/.test(payload)) {
    hits.push("gcp_service_account_key");
  }
  // AWS access keys.
  if (/AKIA[0-9A-Z]{16}/.test(payload)) hits.push("aws_access_key_id");
  // JWT (three base64-url segments).
  if (/\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/.test(payload)) {
    hits.push("jwt");
  }
  // Prompt-injection patterns aimed at exfiltrating adjacent files.
  const injectionPatterns: ReadonlyArray<[RegExp, string]> = [
    [/cat\s+(?:\.\.\/)?\.env\b/i, "injection_cat_env"],
    [/cat\s+~?\/?\.ssh\//i, "injection_read_ssh"],
    [/please.+(?:read|cat|include).+\.env/i, "injection_please_env"],
    [/ignore\s+(?:all\s+)?previous\s+instructions/i, "injection_ignore_prior"],
  ];
  for (const [pattern, name] of injectionPatterns) {
    if (pattern.test(payload)) hits.push(name);
  }
  return hits;
}

// ── Sandbox ──────────────────────────────────────────────────────────────
//
// scrub_env — strip every host env var that isn't on the explicit
// allowlist before handing the subprocess off to codex. HOME is
// intentionally absent; isolateHome() supplies a synthetic directory
// with a symlink to ~/.codex only.

const SANDBOX_ENV_ALLOWLIST = [
  "PATH",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
] as const;

export function scrubEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export interface SandboxHome {
  /** The synthetic HOME path. */
  home: string;
  /** Cleanup function — call in a finally block. */
  cleanup: () => void;
}

/**
 * Create a temp HOME containing a fresh `.codex/` directory whose entries
 * are symlinked back to the operator's real `~/.codex/` — with one
 * exception: `auth.json` is excluded so the caller can drop in an
 * apikey-mode credential without clobbering the user's real (often
 * ChatGPT-account) login. dispatchCodex synthesizes that auth.json when
 * an OPENAI_API_KEY is resolvable; otherwise codex falls back to whatever
 * auth state the real home offers (e.g. ChatGPT oauth tokens). Returns
 * the synthetic HOME path and a cleanup closure.
 */
export function isolateHome(realHome: string = process.env.HOME ?? ""): SandboxHome {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "red-team-home-"));
  const realCodex = path.join(realHome, ".codex");
  const sandCodex = path.join(tmp, ".codex");
  if (fs.existsSync(realCodex)) {
    fs.mkdirSync(sandCodex, { recursive: true });
    for (const name of fs.readdirSync(realCodex)) {
      if (name === "auth.json") continue; // dispatchCodex owns this entry
      const src = path.join(realCodex, name);
      const dst = path.join(sandCodex, name);
      try {
        fs.symlinkSync(src, dst);
      } catch {
        // Fallback: copy if symlinks aren't allowed (e.g. some CI workspaces).
        fs.cpSync(src, dst, { recursive: true });
      }
    }
  }
  return {
    home: tmp,
    cleanup: () => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

// ── Classification gate ─────────────────────────────────────────────────
//
// Reads a YAML-frontmatter `classification:` block (level / dpa_required /
// retention_days / provider_allowlist / notes). When absent, falls back to
// the legacy default documented in
// docs/specs/red-team-classification-contract-2026-05-16.md.

export type ClassLevel = "public" | "internal" | "confidential" | "restricted";

export interface DocClassification {
  level: ClassLevel;
  dpa_required: boolean;
  retention_days: number;
  provider_allowlist: string[];
  notes: string;
  source: "frontmatter" | "legacy_default";
}

const LEGACY_DEFAULT_CLASSIFICATION: DocClassification = {
  level: "internal",
  dpa_required: false,
  retention_days: 30,
  provider_allowlist: ["openai-gpt-5.5", "anthropic-claude-opus-4-8"],
  notes: "legacy default — operator did not annotate classification:",
  source: "legacy_default",
};

/**
 * Extract the classification block from YAML-style frontmatter. Tolerates
 * absence, malformed YAML, or partially-specified blocks (missing fields
 * fall back to the legacy default).
 *
 * No YAML library dependency — we parse the minimal subset the contract
 * declares: `key: value` lines and `- item` lists inside a top-level
 * `classification:` key. Anything more complex is reported via the
 * returned `source` field so operators can audit.
 */
export function extractClassification(docText: string): DocClassification {
  const fm = matchFrontmatter(docText);
  if (!fm) return LEGACY_DEFAULT_CLASSIFICATION;
  const block = extractKeyBlock(fm, "classification");
  if (block === null) return LEGACY_DEFAULT_CLASSIFICATION;
  const partial = parseClassificationBlock(block);
  return {
    level: partial.level ?? LEGACY_DEFAULT_CLASSIFICATION.level,
    dpa_required: partial.dpa_required ?? LEGACY_DEFAULT_CLASSIFICATION.dpa_required,
    retention_days:
      partial.retention_days ?? LEGACY_DEFAULT_CLASSIFICATION.retention_days,
    provider_allowlist:
      partial.provider_allowlist ?? LEGACY_DEFAULT_CLASSIFICATION.provider_allowlist,
    notes: partial.notes ?? "",
    source: "frontmatter",
  };
}

function matchFrontmatter(text: string): string | null {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return null;
  return text.slice(4, end);
}

function extractKeyBlock(yamlSubset: string, key: string): string | null {
  const lines = yamlSubset.split(/\r?\n/);
  let inBlock = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (!inBlock) {
      if (line.match(new RegExp(`^${key}\\s*:\\s*$`))) {
        inBlock = true;
      }
      continue;
    }
    if (line.match(/^\S/) && !line.startsWith(" ") && !line.startsWith("\t")) {
      break; // dedent — end of block
    }
    collected.push(line);
  }
  return inBlock ? collected.join("\n") : null;
}

function parseClassificationBlock(block: string): Partial<DocClassification> {
  const out: Partial<DocClassification> = {};
  const lines = block.split(/\r?\n/);
  let listKey: string | null = null;
  let listAcc: string[] = [];
  const flushList = () => {
    if (listKey === "provider_allowlist") out.provider_allowlist = [...listAcc];
    listKey = null;
    listAcc = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && listKey) {
      listAcc.push(listMatch[1]!.trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    if (listKey) flushList();
    const kv = line.match(/^\s*(\w+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv as unknown as [string, string, string];
    const value = rawValue.trim();
    if (value === "") {
      // Maybe a list-typed key follows.
      listKey = key;
      continue;
    }
    if (key === "level") {
      const lvl = value.replace(/^["']|["']$/g, "");
      if (lvl === "public" || lvl === "internal" || lvl === "confidential" || lvl === "restricted") {
        out.level = lvl;
      }
    } else if (key === "dpa_required") {
      out.dpa_required = value === "true" || value === "True" || value === "yes";
    } else if (key === "retention_days") {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n) && n >= 0) out.retention_days = n;
    } else if (key === "notes") {
      out.notes = value.replace(/^["']|["']$/g, "");
    }
  }
  flushList();
  return out;
}

export interface ClassificationGateResult {
  allowed: boolean;
  classification: DocClassification;
  reason_code: string | null;
  reason: string | null;
}

/**
 * Refuse when:
 *   - level=restricted and no operator override is supplied.
 *   - dpa_required=true and the provider isn't on the DPA-on-file list.
 *   - provider isn't in the document's provider_allowlist.
 */
export function classificationGate(args: {
  docText: string;
  provider: string;
  /** Operator-supplied `--classification-override` (lowercase level string). */
  override: ClassLevel | null;
  /** Providers with a DPA on file (operator configures). Empty disables the check. */
  dpaOnFile?: ReadonlySet<string>;
}): ClassificationGateResult {
  const classification = extractClassification(args.docText);
  const dpaOnFile = args.dpaOnFile ?? new Set<string>();

  if (classification.level === "restricted" && args.override === null) {
    return {
      allowed: false,
      classification,
      reason_code: "classification_restricted_requires_override",
      reason:
        "level=restricted; pass --classification-override to acknowledge and proceed",
    };
  }
  if (classification.dpa_required && !dpaOnFile.has(args.provider)) {
    return {
      allowed: false,
      classification,
      reason_code: "classification_dpa_missing",
      reason: `provider ${args.provider!} has no DPA on file (dpa_required=true)`,
    };
  }
  if (
    classification.provider_allowlist.length > 0 &&
    !classification.provider_allowlist.includes(args.provider)
  ) {
    return {
      allowed: false,
      classification,
      reason_code: "classification_provider_not_allowed",
      reason: `provider ${args.provider} is not in the document's provider_allowlist`,
    };
  }
  return { allowed: true, classification, reason_code: null, reason: null };
}

// ── Finding validation ──────────────────────────────────────────────────

/** Stable concern hash — used for stable_key + cross-run identity. */
export function computeConcernHash(args: {
  persona: PersonaSlug;
  riskKey: string | null;
  affectedComponent: string | null;
  failureMode: string | null;
  concern: string;
}): string {
  const { persona, riskKey, affectedComponent, failureMode, concern } = args;
  // Structured identity wins when all three are present (FU-rt5 contract);
  // otherwise we hash the normalized concern (FU-rt7 fallback).
  if (riskKey && affectedComponent && failureMode) {
    return sha256(`${persona}:${riskKey}:${affectedComponent}:${failureMode}`);
  }
  return sha256(`${persona}:${normalizeConcern(concern)}`);
}

function normalizeConcern(concern: string): string {
  return concern.replace(/\s+/g, " ").trim().toLowerCase();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Validate + coerce raw model output (a JSON array of finding objects)
 * into typed `RedTeamFinding[]`. Skips invalid entries silently (the
 * dispatcher's `error` field surfaces the parse rate); a fully empty
 * result is reported as "no findings" rather than an error so a
 * genuinely-clean review reads as `clean`.
 */
export function validateFindings(rawJson: string): {
  findings: RedTeamFinding[];
  invalid_count: number;
  parse_error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return { findings: [], invalid_count: 0, parse_error: (err as Error).message };
  }
  if (!Array.isArray(parsed)) {
    return { findings: [], invalid_count: 0, parse_error: "expected JSON array" };
  }
  const out: RedTeamFinding[] = [];
  let invalid = 0;
  for (const [i, item] of parsed.entries()) {
    if (!isObject(item)) {
      invalid++;
      continue;
    }
    const persona = item.persona;
    const severity = item.severity;
    const concern = item.concern;
    const consequence = item.consequence;
    const counter = item.counter_proposal;
    if (
      typeof persona !== "string" ||
      !VALID_PERSONAS.includes(persona as PersonaSlug) ||
      typeof severity !== "string" ||
      !VALID_SEVERITIES.has(severity as Severity) ||
      typeof concern !== "string" ||
      typeof consequence !== "string" ||
      typeof counter !== "string"
    ) {
      invalid++;
      continue;
    }
    // Shape A vs Shape B contract. The Python validator tolerates
    // trade_off=null on Shape A (the preamble strongly recommends it but
    // doesn't reject) and tolerates reason_for_uncertainty=null on Shape
    // B for the same reason — keep TS parity so the recorded transcripts
    // built by either side round-trip cleanly.
    const tradeOff = typeof item.trade_off === "string" ? item.trade_off : null;
    const reason =
      typeof item.reason_for_uncertainty === "string"
        ? item.reason_for_uncertainty
        : null;
    const riskKey = typeof item.risk_key === "string" ? item.risk_key : null;
    const affectedComponent =
      typeof item.affected_component === "string" ? item.affected_component : null;
    const failureMode =
      typeof item.failure_mode === "string" ? item.failure_mode : null;
    out.push({
      id:
        typeof item.id === "string" && item.id
          ? item.id
          : `rt${out.length + 1}`,
      persona: persona as PersonaSlug,
      severity: severity as Severity,
      concern,
      consequence,
      counter_proposal: counter,
      trade_off: tradeOff,
      reason_for_uncertainty: reason,
      risk_key: riskKey,
      affected_component: affectedComponent,
      failure_mode: failureMode,
      concern_hash:
        typeof item.concern_hash === "string" && item.concern_hash
          ? item.concern_hash
          : computeConcernHash({
              persona: persona as PersonaSlug,
              riskKey,
              affectedComponent,
              failureMode,
              concern,
            }),
    });
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void i;
  }
  return { findings: out, invalid_count: invalid, parse_error: null };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function countBlocking(findings: readonly RedTeamFinding[]): number {
  return findings.filter(
    (f) =>
      BLOCKING_SEVERITIES.has(f.severity) &&
      f.counter_proposal !== "REQUEST_HUMAN_REVIEW",
  ).length;
}

export function countHumanReview(findings: readonly RedTeamFinding[]): number {
  return findings.filter((f) => f.counter_proposal === "REQUEST_HUMAN_REVIEW").length;
}

/** Map a RedTeamResult to the canonical status enum. */
export function deriveStatus(result: RedTeamResult): DispatchResult["status"] {
  if (result.error) return "error";
  if (result.human_review_count > 0) return "halted_human_review";
  if (result.blocking_count > 0) return "halted";
  return "clean";
}

// ── Replay transcript ───────────────────────────────────────────────────

export interface RecordedTranscript {
  schema_version: number;
  stage: Stage;
  model: string;
  round_num?: number;
  synthesis?: string;
  raw_output?: string;
  findings: unknown[];
  duration_s?: number;
  cost_usd?: number;
  input_tokens?: number;
  output_tokens?: number;
  error?: string | null;
}

export function buildResultFromTranscript(
  transcriptPath: string,
  stage: Stage,
): RedTeamResult {
  const data = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as RecordedTranscript;
  if (data.stage && data.stage !== stage) {
    throw new Error(
      `transcript stage mismatch (transcript=${data.stage!}, run stage=${stage})`,
    );
  }
  const validated = validateFindings(JSON.stringify(data.findings ?? []));
  if (validated.parse_error) {
    throw new Error(`transcript findings parse error: ${validated.parse_error}`);
  }
  const findings = validated.findings;
  return {
    stage,
    round_num: data.round_num ?? 1,
    synthesis: data.synthesis ?? "",
    findings,
    blocking_count: countBlocking(findings),
    human_review_count: countHumanReview(findings),
    raw_output: data.raw_output ?? "",
    duration_s: data.duration_s ?? 0,
    cost_usd: data.cost_usd ?? 0,
    error: data.error ?? null,
    input_tokens: data.input_tokens ?? 0,
    output_tokens: data.output_tokens ?? 0,
  };
}

// ── Audit shell-out ─────────────────────────────────────────────────────

export interface AuditEnvelope {
  ok?: boolean;
  status?: string;
  error?: string;
  detail?: unknown;
  run_id?: string;
  count?: number;
  findings?: unknown[];
  run?: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** Resolve the canonical DB path. TS-native after Phase 5b — no more
 *  shell-out to the Python audit CLI. Resolution precedence matches the
 *  former CLI: `--db` > `STARK_RED_TEAM_DB` env > `red_team.audit.db_path`
 *  config > default. */
export function resolveDbPath(cliDb?: string | null): { db_path: string; source: string } {
  return resolveDb(cliDb ?? null);
}

export interface RecordRunInput {
  run_id: string;
  stage: Stage;
  rounds_used: number;
  final_status: string;
  total_findings: number;
  critical_count: number;
  high_count: number;
  medium_count: number;
  human_review_count: number;
  duration_s: number;
  cost_usd: number;
  model: string;
  caller: string;
  repo?: string | null;
  artifact_relative_path?: string | null;
  pr_number?: number | null;
}

/** Persist one red-team run row. TS-native after Phase 5b — calls
 *  `red_team_audit_lib.ts::recordRedTeamRun` directly. Returns an
 *  `AuditEnvelope` for back-compat with the old CLI shell-out shape. */
export function recordRun(input: RecordRunInput, dbPath: string): AuditEnvelope {
  try {
    const row: RedTeamRunRow = {
      ...input,
      repo: input.repo ?? null,
      artifact_relative_path: input.artifact_relative_path ?? null,
      pr_number: input.pr_number ?? null,
    };
    recordRedTeamRun(row, dbPath);
    return { ok: true, run_id: input.run_id, status: "created" };
  } catch (err) {
    return { ok: false, error: "record_run_failed", detail: (err as Error).message };
  }
}

/** Persist N finding rows. TS-native after Phase 5b. Applies the
 *  operator's retention policy (resolved from config) so concern /
 *  consequence / counter_proposal / trade_off / reason_for_uncertainty
 *  get redacted + excerpted per the FU-rt6 contract. */
export function recordFindings(
  runId: string,
  findings: Array<Record<string, unknown>>,
  dbPath: string,
): AuditEnvelope {
  try {
    const rows = findings.map((f) => ({
      run_id: (f.run_id as string) ?? runId,
      stage: f.stage as string,
      round_num: f.round_num as number,
      finding_id: f.finding_id as string,
      persona: f.persona as string,
      severity: f.severity as string,
      concern: f.concern as string,
      consequence: f.consequence as string,
      counter_proposal: f.counter_proposal as string,
      trade_off: (f.trade_off as string | null) ?? null,
      reason_for_uncertainty: (f.reason_for_uncertainty as string | null) ?? null,
      stable_key: (f.stable_key as string | null) ?? null,
      concern_hash: (f.concern_hash as string | null) ?? null,
      risk_key: (f.risk_key as string | null) ?? null,
      affected_component: (f.affected_component as string | null) ?? null,
      failure_mode: (f.failure_mode as string | null) ?? null,
    })) satisfies FindingRow[];
    const policy = loadAuditPolicy(REPO_ROOT);
    auditRecordFindings(rows, dbPath, policy);
    return { ok: true, run_id: runId, count: rows.length, status: "recorded" };
  } catch (err) {
    return { ok: false, error: "record_findings_failed", detail: (err as Error).message };
  }
}

// ── Sidecar rendering ───────────────────────────────────────────────────

export function sidecarPathFor(artifactPath: string): string {
  if (artifactPath.endsWith(".md")) {
    return artifactPath.slice(0, -3) + ".red-team.md";
  }
  return artifactPath + ".red-team.md";
}

const SEVERITY_BADGE: Record<Severity, string> = {
  critical: "🟣",
  high: "🔴",
  medium: "🟡",
  low: "⚪",
};

function escapeInline(text: string): string {
  return text.replace(/[\\`*_{}\[\]()#+!]/g, (m) => `\\${m}`);
}

function escapeBlock(text: string): string {
  // For body text: only escape backticks (so ```{shell}`` snippets don't
  // break the surrounding fence) — preserve line breaks + ordinary markdown.
  return text.replace(/```/g, "``\\`");
}

export function renderSidecarMarkdown(args: {
  ctx: RedTeamRunContext;
  result: RedTeamResult;
  model: string;
  fixPlanStatus?: FixPlanStatus;
  fixPlan?: RedTeamFixPlan | null;
}): string {
  const { ctx, result, model } = args;
  const fixPlanStatus: FixPlanStatus = args.fixPlanStatus ?? "skipped_disabled";
  const fixPlan = args.fixPlan ?? null;
  const parts: string[] = [];
  const artifactBase = path.basename(ctx.artifact_path);
  parts.push(`# Red-team review — ${artifactBase}`);
  parts.push("");
  parts.push(`- **Date:** ${ctx.started_at}`);
  parts.push(`- **Run ID:** \`${ctx.run_id}\``);
  parts.push(`- **Model:** \`${model}\``);
  parts.push(`- **Stage:** ${ctx.stage}`);
  parts.push(`- **Status:** **${deriveStatus(result)}**`);
  parts.push(
    `- **Findings:** ${result.findings.length} total — ${result.blocking_count} blocking (≥ high), ${result.human_review_count} human-review`,
  );
  parts.push(
    `- **Cost:** $${result.cost_usd.toFixed(4)} | **Duration:** ${result.duration_s.toFixed(1)}s`,
  );
  parts.push("");
  if (result.synthesis) {
    parts.push("## Synthesis");
    parts.push("");
    parts.push(redact(escapeBlock(result.synthesis)));
    parts.push("");
  }
  if (result.findings.length === 0) {
    parts.push("## Findings");
    parts.push("");
    parts.push("_(no findings)_");
    parts.push("");
    parts.push(renderFixPlanSection({ status: fixPlanStatus, fixPlan }));
    return parts.join("\n");
  }
  parts.push("## Findings");
  parts.push("");
  // Sort: blocking first, then by severity rank, then by persona.
  const sorted = [...result.findings].sort((a, b) => {
    const severityRank: Record<Severity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    return (
      severityRank[a.severity] - severityRank[b.severity] ||
      a.persona.localeCompare(b.persona)
    );
  });
  for (const f of sorted) {
    parts.push(
      `### ${SEVERITY_BADGE[f.severity]} \`${f.id}\` — ${f.persona} (${f.severity})`,
    );
    parts.push("");
    parts.push(`**Concern.** ${redact(escapeBlock(f.concern))}`);
    parts.push("");
    parts.push(`**Consequence.** ${redact(escapeBlock(f.consequence))}`);
    parts.push("");
    if (f.counter_proposal === "REQUEST_HUMAN_REVIEW") {
      parts.push("**Counter-proposal.** `REQUEST_HUMAN_REVIEW`");
      parts.push("");
      if (f.reason_for_uncertainty) {
        parts.push(
          `**Reason for uncertainty.** ${redact(escapeBlock(f.reason_for_uncertainty))}`,
        );
        parts.push("");
      }
    } else {
      parts.push(`**Counter-proposal.** ${redact(escapeBlock(f.counter_proposal))}`);
      parts.push("");
      if (f.trade_off) {
        parts.push(`**Trade-off.** ${redact(escapeBlock(f.trade_off))}`);
        parts.push("");
      }
    }
    // Suppress the unused-variable lint for callers that don't yet pull
    // structured identity fields into the rendered sidecar.
    void escapeInline;
  }
  parts.push("");
  parts.push(renderFixPlanSection({ status: fixPlanStatus, fixPlan }));
  return parts.join("\n");
}

export function prCommentMarker(ctx: RedTeamRunContext): string {
  return `<!-- stark-red-team: stage=${ctx.stage} artifact=${ctx.artifact_relative_path ?? ctx.artifact_path} -->`;
}

export function renderPrCommentBody(args: {
  ctx: RedTeamRunContext;
  result: RedTeamResult;
  model: string;
  fixPlanStatus?: FixPlanStatus;
  fixPlan?: RedTeamFixPlan | null;
}): string {
  const marker = prCommentMarker(args.ctx);
  const sidecar = renderSidecarMarkdown(args);
  return `${marker}\n${sidecar}\n`;
}

// ── Dispatch orchestration ──────────────────────────────────────────────

export interface DispatchArgs {
  ctx: RedTeamRunContext;
  prompts: PersonaPrompts;
  personas: PersonaSlug[];
  artifact: string;
  sourceSpec: string;
  model: string;
  /** Per-run timeout for the codex subprocess. */
  timeoutMs: number;
  /** Optional recorded transcript path — bypass live codex. */
  replayTranscript?: string;
  /** Optional override for classification gate. */
  classificationOverride?: ClassLevel | null;
  /** Audit DB. Caller resolves up-front so all writes share one path. */
  dbPath: string;
  /** Skip the audit shell-out (used by --no-audit and tests). */
  noAudit?: boolean;
  /** Skip writing the sidecar to disk. */
  noSidecar?: boolean;
  /** Mock the codex spawn (used by tests). */
  codexFn?: (prompt: string, model: string) => {
    raw_output: string;
    duration_s: number;
    input_tokens: number;
    output_tokens: number;
    error: string | null;
  };
  /** Force-enable fix-plan even when `red_team.fix_plan.enabled` is false.
   *  Used by calibration runs that need to exercise the path without
   *  flipping the global config. Honored only when the kill switch is off
   *  and no other gate refuses. */
  enableFixPlanForCalibration?: boolean;
  /** Optional per-run cost budget (USD). If provided, the fix-plan resolver
   *  refuses on `challenge.cost_usd >= budget` and warns when the combined
   *  cost crosses the budget. TS dispatch currently reports `cost_usd: 0`,
   *  so leaving this undefined is the right default until cost tracking
   *  lands. */
  perRunBudgetUsd?: number;
  /** Mock the fix-plan codex call separately from the challenge codex.
   *  Falls back to `codexFn` when unset (tests typically share the mock). */
  fixPlanCodexFn?: ResolveFixPlanArgs["codexFn"];
  /** Optional fix-plan config override. Tests use this to pin behavior
   *  independent of the on-disk `red_team.fix_plan` defaults. */
  fixPlanCfg?: FixPlanConfig;
}

/**
 * The single user-facing entry point. Phase 2 (`tools/red_team_design.ts`)
 * and Phase 3 (`tools/red_team_plan.ts`) are thin wrappers that build the
 * context + persona list and call this. Returns a `DispatchResult` shaped
 * for the existing skill JSON receipt.
 */
export function dispatch(args: DispatchArgs): DispatchResult {
  const { ctx, prompts, personas, artifact, sourceSpec, model } = args;

  // Build the assembled provider request first so the pre-dispatch gate
  // sees the exact bytes the model would receive.
  const prompt = assemblePrompt({ prompts, personas, artifact, sourceSpec });

  // Pre-dispatch sensitive-data gate.
  const sensitiveHits = preDispatchSensitiveGate(prompt);
  if (sensitiveHits.length > 0) {
    return makeBlocked(
      ctx, model,
      "blocked_sensitive_input",
      `pre-dispatch gate refused: matched patterns ${sensitiveHits.join(", ")}`,
      args.dbPath, !!args.noAudit,
    );
  }

  // Classification gate.
  const gate = classificationGate({
    docText: artifact,
    provider: provider_for_model(model),
    override: args.classificationOverride ?? null,
  });
  if (!gate.allowed) {
    return makeBlocked(
      ctx, model,
      gate.reason_code ?? "blocked_classification",
      gate.reason ?? "classification gate refused",
      args.dbPath, !!args.noAudit,
    );
  }

  // Replay or live dispatch.
  let result: RedTeamResult;
  if (args.replayTranscript) {
    try {
      result = buildResultFromTranscript(args.replayTranscript, ctx.stage);
    } catch (err) {
      return errorResult(ctx, model, `replay transcript: ${(err as Error).message}`);
    }
  } else if (args.codexFn) {
    const dispatched = args.codexFn(prompt, model);
    const parsed = parseCommitteeOutput(dispatched.raw_output);
    const validated = validateFindings(parsed.findings_json);
    result = {
      stage: ctx.stage,
      round_num: 1,
      synthesis: parsed.synthesis,
      findings: validated.findings,
      blocking_count: countBlocking(validated.findings),
      human_review_count: countHumanReview(validated.findings),
      raw_output: dispatched.raw_output,
      duration_s: dispatched.duration_s,
      cost_usd: 0,
      error:
        validated.parse_error ?? dispatched.error ?? null,
      input_tokens: dispatched.input_tokens,
      output_tokens: dispatched.output_tokens,
    };
  } else {
    // Real codex dispatch.
    const dispatched = dispatchCodex(prompt, model, args.timeoutMs);
    const parsed = parseCommitteeOutput(dispatched.raw_output);
    const validated = validateFindings(parsed.findings_json);
    result = {
      stage: ctx.stage,
      round_num: 1,
      synthesis: parsed.synthesis,
      findings: validated.findings,
      blocking_count: countBlocking(validated.findings),
      human_review_count: countHumanReview(validated.findings),
      raw_output: dispatched.raw_output,
      duration_s: dispatched.duration_s,
      cost_usd: 0,
      error: validated.parse_error ?? dispatched.error ?? null,
      input_tokens: dispatched.input_tokens,
      output_tokens: dispatched.output_tokens,
    };
  }

  // Resolve fix-plan (gated by config + kill switch; default skipped_disabled).
  // Replay runs reproduce a captured transcript and must not call codex — skip
  // resolveFixPlan entirely so its codexFn never fires.
  const fixPlanResolution = args.replayTranscript
    ? { status: "skipped_replay" as FixPlanStatus, fixPlan: null, runWarnings: [] }
    : resolveFixPlan({
        ctx,
        challenge: result,
        artifact,
        sourceSpec,
        enableForCalibration: args.enableFixPlanForCalibration,
        perRunBudgetUsd: args.perRunBudgetUsd,
        codexFn: args.fixPlanCodexFn ?? args.codexFn,
        cfg: args.fixPlanCfg,
      });

  // Render sidecar (now including the fix-plan section).
  const sidecarBody = renderSidecarMarkdown({
    ctx,
    result,
    model,
    fixPlanStatus: fixPlanResolution.status,
    fixPlan: fixPlanResolution.fixPlan,
  });
  const sidecarPath = args.noSidecar
    ? null
    : (() => {
        const p = sidecarPathFor(ctx.artifact_path);
        fs.writeFileSync(p, sidecarBody, "utf8");
        return p;
      })();

  // PR comment body (caller posts).
  const prCommentBody = renderPrCommentBody({
    ctx,
    result,
    model,
    fixPlanStatus: fixPlanResolution.status,
    fixPlan: fixPlanResolution.fixPlan,
  });

  // Audit write.
  if (!args.noAudit) {
    try {
      auditPersistRun(ctx, result, model, args.dbPath);
    } catch (err) {
      console.error(
        `red_team_lib: audit persist failed (non-fatal): ${(err as Error).message}`,
      );
    }
  }

  return {
    status: deriveStatus(result),
    run_id: ctx.run_id,
    model,
    total_findings: result.findings.length,
    blocking_count: result.blocking_count,
    human_review_count: result.human_review_count,
    cost_usd: result.cost_usd,
    duration_s: result.duration_s,
    synthesis: result.synthesis,
    sidecar_path: sidecarPath,
    pr_comment_body: prCommentBody,
    pr_comment_marker: prCommentMarker(ctx),
    error: result.error,
    findings: result.findings,
    fix_plan_status: fixPlanResolution.status,
    fix_plan: fixPlanResolution.fixPlan,
  };
}

function provider_for_model(model: string): string {
  // Crude shape — Phase 2+ refines this as more providers come online.
  if (model.startsWith("gpt") || model.startsWith("o")) return "openai-gpt-5.5";
  if (model.startsWith("claude")) return "anthropic-claude-opus-4-8";
  return model;
}

function dispatchCodex(
  prompt: string,
  model: string,
  timeoutMs: number,
): {
  raw_output: string;
  duration_s: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
} {
  const sandbox = isolateHome();
  const env = scrubEnv();
  env.HOME = sandbox.home;
  // Resolve OPENAI_API_KEY (direct, or OPENAI_API_KEY_FILE +
  // OPENAI_API_KEY_LABEL). When present, write an apikey-mode auth.json
  // into the synthetic ~/.codex so codex talks to the Responses API —
  // gpt-5.5-pro, o3, etc., aren't available on the ChatGPT-account oauth
  // that a bare ~/.codex install carries. isolateHome already excluded
  // auth.json so this never clobbers the operator's real login. The env
  // allowlist still strips OPENAI_API_KEY at scrub time; this one
  // synthesized file is the only host-derived credential that crosses
  // the sandbox boundary.
  const apiKey = resolveOpenaiApiKey(process.env);
  if (apiKey) {
    const sandCodex = path.join(sandbox.home, ".codex");
    fs.mkdirSync(sandCodex, { recursive: true });
    const authPath = path.join(sandCodex, "auth.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: apiKey,
        tokens: null,
        last_refresh: null,
      }),
      { mode: 0o600 },
    );
    env.OPENAI_API_KEY = apiKey;
  }
  const start = Date.now();
  try {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="high"',
      "-m",
      model,
    ];
    const proc = spawnSync("codex", args, {
      input: prompt,
      encoding: "utf8",
      env,
      timeout: timeoutMs,
    });
    const elapsed = (Date.now() - start) / 1000;
    if (proc.error) {
      return {
        raw_output: "",
        duration_s: elapsed,
        input_tokens: 0,
        output_tokens: 0,
        error: `codex spawn failed: ${proc.error.message}`,
      };
    }
    if (proc.status !== 0) {
      return {
        raw_output: proc.stdout ?? "",
        duration_s: elapsed,
        input_tokens: 0,
        output_tokens: 0,
        error: `codex exited ${proc.status}: ${proc.stderr ?? ""}`.trim(),
      };
    }
    const parsed = parseCodexJsonl(proc.stdout ?? "");
    return {
      raw_output: parsed.text,
      duration_s: elapsed,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens,
      error: null,
    };
  } finally {
    sandbox.cleanup();
  }
}

/**
 * Async sibling of `dispatchCodex` that uses `spawn` (not spawnSync) and
 * buffers stdout/stderr. The prebuilt result is then threaded through sync
 * `dispatch()` via `codexFn` so all downstream paths (parse, validate,
 * sidecar, audit) stay untouched.
 */
export async function dispatchCodexAsync(
  prompt: string,
  model: string,
  timeoutMs: number,
): Promise<{
  raw_output: string;
  duration_s: number;
  input_tokens: number;
  output_tokens: number;
  error: string | null;
}> {
  const sandbox = isolateHome();
  const env = scrubEnv();
  env.HOME = sandbox.home;
  const apiKey = resolveOpenaiApiKey(process.env);
  if (apiKey) {
    const sandCodex = path.join(sandbox.home, ".codex");
    fs.mkdirSync(sandCodex, { recursive: true });
    const authPath = path.join(sandCodex, "auth.json");
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: apiKey,
        tokens: null,
        last_refresh: null,
      }),
      { mode: 0o600 },
    );
    env.OPENAI_API_KEY = apiKey;
  }
  const start = Date.now();
  try {
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-c",
      'model_reasoning_effort="high"',
      "-m",
      model,
    ];
    const child = spawn("codex", args, { env, stdio: ["pipe", "pipe", "pipe"] });

    // Buffer stdout/stderr.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr!.on("data", (b: Buffer) => stderrChunks.push(b));

    // Stream the prompt over stdin, then close to signal EOF.
    child.stdin!.end(prompt);

    // Wait for the subprocess to exit; enforce timeoutMs. E2: on timeout we
    // mark `timedOut: true` and SIGKILL the child, but DO NOT resolve until
    // `close` plus stdout/stderr "end" have all fired — so the buffers see
    // every final byte. Matches the runProcess pattern in copilot_dispatch.ts.
    const exitInfo = await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      error: Error | null;
    }>((resolve) => {
      let settled = false;
      let closed = false;
      let stdoutEnded = false;
      let stderrEnded = false;
      let result: {
        status: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        error: Error | null;
      } | null = null;
      const tryFinish = () => {
        if (settled) return;
        if (result === null) return;
        if (!closed) return;
        if (!stdoutEnded || !stderrEnded) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (result === null) {
          result = { status: null, signal: null, timedOut: true, error: null };
        }
        try { child.kill("SIGKILL"); } catch { /* */ }
        tryFinish();
      }, timeoutMs);
      if (child.stdout) child.stdout.once("end", () => { stdoutEnded = true; tryFinish(); });
      else stdoutEnded = true;
      if (child.stderr) child.stderr.once("end", () => { stderrEnded = true; tryFinish(); });
      else stderrEnded = true;
      child.on("error", (err) => {
        // streams may not emit "end" on spawn error — force the gate.
        stdoutEnded = true;
        stderrEnded = true;
        closed = true;
        if (result === null) {
          result = { status: null, signal: null, timedOut: false, error: err as Error };
        } else {
          result.error = err as Error;
        }
        tryFinish();
      });
      child.on("close", (status, signal) => {
        closed = true;
        if (result === null) {
          result = { status, signal, timedOut: false, error: null };
        } else {
          // Timer already populated result with timedOut: true — keep flag,
          // but record the real exit signal for diagnostics.
          result.signal = signal;
        }
        tryFinish();
      });
    });

    const elapsed = (Date.now() - start) / 1000;
    const stdoutStr = Buffer.concat(stdoutChunks).toString("utf8");
    const stderrStr = Buffer.concat(stderrChunks).toString("utf8");

    if (exitInfo.error) {
      return {
        raw_output: "",
        duration_s: elapsed,
        input_tokens: 0,
        output_tokens: 0,
        error: `codex spawn failed: ${exitInfo.error.message}`,
      };
    }
    if (exitInfo.timedOut) {
      return {
        raw_output: stdoutStr,
        duration_s: elapsed,
        input_tokens: 0,
        output_tokens: 0,
        error: `codex timed out after ${timeoutMs}ms`,
      };
    }
    if (exitInfo.status !== 0) {
      return {
        raw_output: stdoutStr,
        duration_s: elapsed,
        input_tokens: 0,
        output_tokens: 0,
        error: `codex exited ${exitInfo.status}: ${stderrStr}`.trim(),
      };
    }
    const parsed = parseCodexJsonl(stdoutStr);
    return {
      raw_output: parsed.text,
      duration_s: elapsed,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens,
      error: null,
    };
  } finally {
    sandbox.cleanup();
  }
}

/**
 * Async wrapper around sync `dispatch` that runs the codex subprocess via
 * `dispatchCodexAsync` and then threads the prebuilt result back through
 * `dispatch` via `codexFn`. The fix-plan codex call stays on the sync path
 * to avoid changing `resolveFixPlan`'s shape; callers wanting a custom
 * fix-plan codex fn should pass `fixPlanCodexFn` explicitly.
 */
export async function dispatchAsync(
  args: DispatchArgs,
): Promise<DispatchResult> {
  // No real subprocess to tap — fall through to sync dispatch.
  if (args.replayTranscript || args.codexFn) {
    return dispatch(args);
  }
  const prompt = assemblePrompt({
    prompts: args.prompts,
    personas: args.personas,
    artifact: args.artifact,
    sourceSpec: args.sourceSpec,
  });
  // Skip the codex spawn if the pre-dispatch sensitive gate will refuse
  // anyway — sync dispatch re-runs the gate and returns the blocked
  // envelope without ever calling our codexFn.
  if (preDispatchSensitiveGate(prompt).length > 0) {
    return dispatch(args);
  }
  const dispatched = await dispatchCodexAsync(
    prompt,
    args.model,
    args.timeoutMs,
  );
  // The fix-plan path runs its own codex spawn; default it to the real
  // sync dispatcher so we don't accidentally feed it the challenge's
  // prebuilt output (resolveFixPlan falls back to `args.codexFn` when
  // `fixPlanCodexFn` is undefined — see runRedTeamFixPlan).
  const fixPlanCodexFn =
    args.fixPlanCodexFn ??
    ((p: string, m: string) => {
      const cfg = loadFixPlanConfig();
      return dispatchCodex(p, m, cfg.timeout_s * 1000);
    });
  return dispatch({
    ...args,
    codexFn: () => dispatched,
    fixPlanCodexFn,
  });
}

/** Parse Codex `--json` JSONL output: collect assistant text + token counts. */
export function parseCodexJsonl(stdout: string): {
  text: string;
  inputTokens: number;
  outputTokens: number;
} {
  const parts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(ev)) continue;
    const usage = isObject(ev.usage) ? ev.usage : null;
    if (usage) {
      inputTokens += Number(usage.input_tokens ?? 0);
      outputTokens += Number(usage.output_tokens ?? 0);
    }
    if (ev.type !== "item.completed") continue;
    const item = ev.item;
    if (!isObject(item)) continue;
    const itype = item.type;
    if (itype === "agent_message" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (itype === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (isObject(c) && c.type === "output_text" && typeof c.text === "string") {
          parts.push(c.text);
        }
      }
    }
  }
  return { text: parts.join("\n"), inputTokens, outputTokens };
}

function auditPersistRun(
  ctx: RedTeamRunContext,
  result: RedTeamResult,
  model: string,
  dbPath: string,
): void {
  const status = deriveStatus(result);
  recordRun(
    {
      run_id: ctx.run_id,
      stage: ctx.stage,
      rounds_used: result.round_num,
      final_status: status === "halted_human_review" ? "halted_human_review" : status,
      total_findings: result.findings.length,
      critical_count: result.findings.filter((f) => f.severity === "critical").length,
      high_count: result.findings.filter((f) => f.severity === "high").length,
      medium_count: result.findings.filter((f) => f.severity === "medium").length,
      human_review_count: result.human_review_count,
      duration_s: result.duration_s,
      cost_usd: result.cost_usd,
      model,
      caller: "stark-red-team-ts",
      repo: ctx.repo,
      artifact_relative_path: ctx.artifact_relative_path,
      pr_number: ctx.pr_number,
    },
    dbPath,
  );
  if (result.findings.length > 0) {
    recordFindings(
      ctx.run_id,
      result.findings.map((f) => ({
        run_id: ctx.run_id,
        stage: ctx.stage,
        round_num: result.round_num,
        finding_id: f.id,
        persona: f.persona,
        severity: f.severity,
        concern: redact(f.concern),
        consequence: redact(f.consequence),
        counter_proposal: redact(f.counter_proposal),
        trade_off: f.trade_off === null ? null : redact(f.trade_off),
        reason_for_uncertainty:
          f.reason_for_uncertainty === null ? null : redact(f.reason_for_uncertainty),
        stable_key: `${ctx.run_id}:${ctx.stage}:${result.round_num}:${f.persona}:${f.id}:${f.concern_hash}`,
        concern_hash: f.concern_hash,
        risk_key: f.risk_key,
        affected_component: f.affected_component,
        failure_mode: f.failure_mode,
      })),
      dbPath,
    );
  }
}

function makeBlocked(
  ctx: RedTeamRunContext,
  model: string,
  reasonCode: string,
  reason: string,
  dbPath: string,
  noAudit: boolean,
): DispatchResult {
  if (!noAudit) {
    try {
      recordRun(
        {
          run_id: ctx.run_id,
          stage: ctx.stage,
          rounds_used: 0,
          final_status: "halted",
          total_findings: 0,
          critical_count: 0,
          high_count: 0,
          medium_count: 0,
          human_review_count: 0,
          duration_s: 0,
          cost_usd: 0,
          model,
          caller: `stark-red-team-ts:${reasonCode}`,
          repo: ctx.repo,
          artifact_relative_path: ctx.artifact_relative_path,
          pr_number: ctx.pr_number,
        },
        dbPath,
      );
    } catch {
      // best-effort
    }
  }
  return {
    status: "halted",
    run_id: ctx.run_id,
    model,
    total_findings: 0,
    blocking_count: 0,
    human_review_count: 0,
    cost_usd: 0,
    duration_s: 0,
    synthesis: "",
    sidecar_path: null,
    pr_comment_body: null,
    pr_comment_marker: prCommentMarker(ctx),
    error: `${reasonCode}: ${reason}`,
    findings: [],
    fix_plan_status: "skipped_challenge_error",
    fix_plan: null,
  };
}

function errorResult(
  ctx: RedTeamRunContext,
  model: string,
  error: string,
): DispatchResult {
  return {
    status: "error",
    run_id: ctx.run_id,
    model,
    total_findings: 0,
    blocking_count: 0,
    human_review_count: 0,
    cost_usd: 0,
    duration_s: 0,
    synthesis: "",
    sidecar_path: null,
    pr_comment_body: null,
    pr_comment_marker: prCommentMarker(ctx),
    error,
    findings: [],
    fix_plan_status: "skipped_challenge_error",
    fix_plan: null,
  };
}

// ── Context construction ────────────────────────────────────────────────

export function buildRunContext(args: {
  stage: Stage;
  artifactPath: string;
  sourceSpecPath: string | null;
  cwd?: string;
  dbPath: string;
}): RedTeamRunContext {
  const repo = detectRepo(args.cwd ?? process.cwd());
  const repoRoot = detectRepoRoot(args.cwd ?? process.cwd());
  const rel = repoRoot ? path.relative(repoRoot, args.artifactPath) : null;
  const prNumber = (() => {
    const v = process.env.GITHUB_PR_NUMBER ?? process.env.PR_NUMBER;
    if (!v) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  })();
  return {
    run_id: `manual-${shortId()}`,
    stage: args.stage,
    artifact_path: args.artifactPath,
    source_spec_path: args.sourceSpecPath,
    repo,
    artifact_relative_path: rel,
    pr_number: prNumber,
    db_path: args.dbPath,
    started_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

function shortId(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
}

function detectRepo(cwd: string): string | null {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trim();
    const sshMatch = url.match(/git@github\.com:(.+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1] ?? null;
    const httpsMatch = url.match(/https:\/\/github\.com\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1] ?? null;
    return null;
  } catch {
    return null;
  }
}

function detectRepoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ── Fix-plan: types, config, kill switch ────────────────────────────────

const FIX_PLAN_SECTION_LIMIT = 12 * 1024;
const FIX_PLAN_CAP_MARKER = "...[CAP]";
const FIX_PLAN_PROMPT_FILE = path.join(PROMPTS_DIR, "fix-plan.md");

export const DEFAULT_FIX_PLAN_CONFIG: FixPlanConfig = {
  enabled: false,
  model: "gpt-5.5-pro",
  reasoning_effort: "xhigh",
  timeout_s: 1200,
  min_moves: 2,
  max_moves: 6,
  max_input_chars: 200_000,
};

let _fixPlanCfgCache: FixPlanConfig | null = null;

/** Read `red_team.fix_plan` from `global/config.json`, falling back to
 *  DEFAULT_FIX_PLAN_CONFIG on any read/parse error or missing section.
 *  Cached after first call. Use `_resetFixPlanConfigCache` in tests. */
export function loadFixPlanConfig(): FixPlanConfig {
  if (_fixPlanCfgCache) return _fixPlanCfgCache;
  const cfgPath = path.join(REPO_ROOT, "global", "config.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rt = parsed?.["red_team"];
    const fp = isObject(rt) ? (rt["fix_plan"] as unknown) : undefined;
    if (isObject(fp)) {
      _fixPlanCfgCache = { ...DEFAULT_FIX_PLAN_CONFIG, ...(fp as Partial<FixPlanConfig>) };
      return _fixPlanCfgCache;
    }
  } catch {
    /* fall through to defaults */
  }
  _fixPlanCfgCache = DEFAULT_FIX_PLAN_CONFIG;
  return _fixPlanCfgCache;
}

export function _resetFixPlanConfigCache(): void {
  _fixPlanCfgCache = null;
}

export function killSwitchActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.STARK_RED_TEAM_FIX_PLAN_KILL ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ── Fix-plan: envelope + prompt assembly ────────────────────────────────

const SEVERITY_RANK_NUM: Record<Severity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

function isHumanReviewFinding(f: RedTeamFinding): boolean {
  return f.counter_proposal === "REQUEST_HUMAN_REVIEW";
}

function findingToEnvelopeDict(f: RedTeamFinding): Record<string, unknown> {
  return {
    id: f.id,
    persona: f.persona,
    severity: f.severity,
    concern: f.concern,
    consequence: f.consequence,
    counter_proposal: f.counter_proposal,
    trade_off: f.trade_off,
    reason_for_uncertainty: f.reason_for_uncertainty,
  };
}

/** Pack findings into a JSON envelope ≤ maxChars. Returns the envelope,
 *  any omitted IDs, and `fitsSafely=false` iff a blocking finding had to
 *  be dropped (caller should refuse to dispatch). Sort order matches the
 *  Python original: severity desc, human-review last within severity,
 *  then id asc — so high-severity blocking findings always win when the
 *  cap kicks in. */
export function serializeFindingsEnvelope(
  findings: readonly RedTeamFinding[],
  maxChars: number,
): { envelopeJson: string; omittedIds: string[]; fitsSafely: boolean } {
  const sorted = [...findings].sort((a, b) => {
    const rankDiff =
      (SEVERITY_RANK_NUM[b.severity] ?? 0) - (SEVERITY_RANK_NUM[a.severity] ?? 0);
    if (rankDiff !== 0) return rankDiff;
    const hrA = isHumanReviewFinding(a) ? 1 : 0;
    const hrB = isHumanReviewFinding(b) ? 1 : 0;
    if (hrA !== hrB) return hrA - hrB;
    return a.id.localeCompare(b.id);
  });
  const kept: Record<string, unknown>[] = [];
  const omittedIds: string[] = [];
  let omittedBlocking = false;
  const dump = (
    truncated: boolean,
    ids: readonly string[],
    rows: readonly Record<string, unknown>[],
  ): string =>
    JSON.stringify({
      truncated,
      omitted_finding_ids: ids,
      findings: rows,
    });
  for (const f of sorted) {
    const row = findingToEnvelopeDict(f);
    const candidateJson = dump(omittedIds.length > 0, omittedIds, [...kept, row]);
    if (candidateJson.length <= maxChars) {
      kept.push(row);
      continue;
    }
    omittedIds.push(f.id);
    if (
      !isHumanReviewFinding(f) &&
      (SEVERITY_RANK_NUM[f.severity] ?? 0) >= SEVERITY_RANK_NUM.high
    ) {
      omittedBlocking = true;
    }
  }
  return {
    envelopeJson: dump(omittedIds.length > 0, omittedIds, kept),
    omittedIds,
    fitsSafely: !omittedBlocking,
  };
}

function wrapFixPlanInput(name: string, text: string, maxChars: number): string {
  // Mirror of `assemblePrompt`'s input-wrapping convention — same delimiter
  // shape so the fix-plan model sees attacker-controllable input under the
  // same guard the challenge model uses.
  const escaped = text
    .replace(/<<<RED_TEAM_INPUT/g, "&lt;&lt;&lt;RED_TEAM_INPUT")
    .replace(/<<<END_RED_TEAM_INPUT/g, "&lt;&lt;&lt;END_RED_TEAM_INPUT");
  const truncated =
    escaped.length <= maxChars
      ? escaped
      : `${escaped.slice(0, maxChars)}\n[TRUNCATED to ${maxChars} chars]`;
  const digest = createHash("sha256").update(truncated, "utf8").digest("hex");
  return (
    `<<<RED_TEAM_INPUT name="${name}" hash="sha256:${digest}">>>\n` +
    `${truncated}\n` +
    `<<<END_RED_TEAM_INPUT name="${name}">>>`
  );
}

export function assembleFixPlanPrompt(args: {
  stage: Stage;
  artifact: string;
  sourceSpec: string;
  findings: readonly RedTeamFinding[];
  synthesis: string;
  maxInputChars: number;
}): { prompt: string; envelopeJson: string; omittedIds: string[]; fitsSafely: boolean } {
  const { envelopeJson, omittedIds, fitsSafely } = serializeFindingsEnvelope(
    args.findings,
    args.maxInputChars,
  );
  const promptHeader = fs.readFileSync(FIX_PLAN_PROMPT_FILE, "utf8");
  const inputs = [
    wrapFixPlanInput("artifact", args.artifact, args.maxInputChars),
    wrapFixPlanInput("source_spec", args.sourceSpec, args.maxInputChars),
    wrapFixPlanInput("findings_envelope", envelopeJson, args.maxInputChars),
    wrapFixPlanInput("synthesis", args.synthesis, args.maxInputChars),
  ];
  const prompt = [promptHeader, `Stage: ${args.stage}`, ...inputs].join("\n\n");
  return { prompt, envelopeJson, omittedIds, fitsSafely };
}

/**
 * Parse the committee's raw output into `{synthesis, findings_json}`.
 * The preamble instructs the model to return `{"synthesis": "...",
 * "findings": [...]}` — possibly wrapped in a ```json fence. Falls back
 * to a bare-array shape so older transcripts still work. Returns
 * `findings_json` as the JSON-stringified array so callers can hand it
 * straight to `validateFindings`.
 */
export function parseCommitteeOutput(raw: string): {
  synthesis: string;
  findings_json: string;
} {
  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return undefined; }
  };
  const trimmed = (raw ?? "").trim();
  const candidates: string[] = [];
  if (trimmed) candidates.push(trimmed);
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]+?)```/g)) {
    const body = (m[1] ?? "").trim();
    if (body) candidates.push(body);
  }
  const startIdx = trimmed.indexOf("{");
  const endIdx = trimmed.lastIndexOf("}");
  if (startIdx >= 0 && startIdx < endIdx) {
    candidates.push(trimmed.slice(startIdx, endIdx + 1));
  }
  const arrStart = trimmed.indexOf("[");
  const arrEnd = trimmed.lastIndexOf("]");
  if (arrStart >= 0 && arrStart < arrEnd) {
    candidates.push(trimmed.slice(arrStart, arrEnd + 1));
  }
  for (const s of candidates) {
    const v = tryParse(s);
    if (Array.isArray(v)) {
      return { synthesis: "", findings_json: JSON.stringify(v) };
    }
    if (isObject(v) && Array.isArray((v as Record<string, unknown>).findings)) {
      const obj = v as Record<string, unknown>;
      const synth = typeof obj.synthesis === "string" ? obj.synthesis : "";
      return { synthesis: synth, findings_json: JSON.stringify(obj.findings) };
    }
  }
  return { synthesis: "", findings_json: raw ?? "" };
}

// ── Fix-plan: parse + validate ──────────────────────────────────────────

export function parseFixPlanOutput(raw: string): Record<string, unknown> {
  // Mirror of Python `parse_output`: best-effort JSON-object extraction.
  // Try the raw text, then every ``` fenced block in order (matches the
  // Python loop — important for model output that emits a non-JSON code
  // sample before the actual JSON), then the first-`{`..last-`}` slice.
  // Returns {} on total failure (caller maps to error).
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v: unknown = JSON.parse(s);
      return isObject(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const direct = tryParse(trimmed);
  if (direct) return direct;
  for (const m of trimmed.matchAll(/```(?:json)?\s*([\s\S]+?)```/g)) {
    const body = (m[1] ?? "").trim();
    if (!body.startsWith("{")) continue;
    const fenced = tryParse(body);
    if (fenced) return fenced;
  }
  const startIdx = trimmed.indexOf("{");
  const endIdx = trimmed.lastIndexOf("}");
  if (startIdx >= 0 && startIdx < endIdx) {
    const sliced = tryParse(trimmed.slice(startIdx, endIdx + 1));
    if (sliced) return sliced;
  }
  return {};
}

function capText(value: string, limit: number, warnings: string[]): string {
  if (value.length <= limit) return value;
  if (!warnings.includes("field_capped")) warnings.push("field_capped");
  return value.slice(0, Math.max(0, limit - FIX_PLAN_CAP_MARKER.length)) + FIX_PLAN_CAP_MARKER;
}

function uniqueMoveId(rawId: string, used: Set<string>, fallback: number): string {
  let candidate = /^m\d+$/.test(rawId) ? rawId : `m${fallback}`;
  if (candidate && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let idx = fallback;
  while (true) {
    candidate = `m${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function emptyFixPlan(opts: {
  error: string | null;
  warnings?: string[];
  rawOutput?: string;
  durationS?: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  reasoningEffort?: string;
  inputTruncated?: boolean;
  inputOmittedFindingIds?: string[];
}): RedTeamFixPlan {
  return {
    summary: "",
    moves: [],
    unaddressed_finding_ids: [],
    orphan_finding_ids: [],
    notes: "",
    input_truncated: opts.inputTruncated ?? false,
    input_omitted_finding_ids: opts.inputOmittedFindingIds ?? [],
    warnings: opts.warnings ?? [],
    raw_output: opts.rawOutput ?? "",
    duration_s: opts.durationS ?? 0,
    cost_usd: opts.costUsd ?? 0,
    input_tokens: opts.inputTokens ?? 0,
    output_tokens: opts.outputTokens ?? 0,
    model: opts.model ?? "",
    reasoning_effort: opts.reasoningEffort ?? "",
    error: opts.error,
  };
}

export function validateFixPlan(
  raw: Record<string, unknown>,
  blockingFindingIds: readonly string[],
  cfg: Pick<FixPlanConfig, "min_moves" | "max_moves">,
): RedTeamFixPlan {
  const warnings: string[] = [];
  try {
    const minMoves = cfg.min_moves;
    const maxMoves = cfg.max_moves;
    const blockingIds = Array.from(new Set(blockingFindingIds.map(String)));
    const blockingSet = new Set(blockingIds);

    const rawMoves = raw["moves"];
    if (!Array.isArray(rawMoves)) {
      return emptyFixPlan({ error: "fix-plan output missing required 'moves' list" });
    }
    const rawCount = rawMoves.length;
    if (rawCount < minMoves || rawCount > maxMoves * 2) {
      return emptyFixPlan({
        error: `fix-plan returned ${rawCount} moves; expected ${minMoves}..${maxMoves}`,
      });
    }

    const parsed: Array<[number, FixPlanMove]> = [];
    const used = new Set<string>();
    rawMoves.forEach((rm, i) => {
      const idx = i + 1;
      if (!isObject(rm)) return;
      const required: ReadonlyArray<"id" | "title" | "rationale" | "new_trade_off"> = [
        "id",
        "title",
        "rationale",
        "new_trade_off",
      ];
      const values: Partial<Record<(typeof required)[number], string>> = {};
      for (const key of required) {
        const v = rm[key];
        if (typeof v !== "string" || !v.trim()) return;
        values[key] = v.trim();
      }
      const sectionsRaw = rm["sections_touched"];
      const idsRaw = rm["addressed_finding_ids"];
      if (!Array.isArray(sectionsRaw) || !Array.isArray(idsRaw)) return;

      const sections: string[] = [];
      for (const item of sectionsRaw.slice(0, 20)) {
        if (typeof item === "string") sections.push(capText(item.trim(), 100, warnings));
      }
      if (sectionsRaw.length > 20 && !warnings.includes("field_capped")) {
        warnings.push("field_capped");
      }

      const addressed: string[] = [];
      let invented = false;
      for (const item of idsRaw) {
        if (typeof item !== "string") {
          invented = true;
          continue;
        }
        if (!blockingSet.has(item)) {
          invented = true;
          continue;
        }
        if (!addressed.includes(item)) addressed.push(item);
      }
      if (invented && !warnings.includes("ids_invented")) warnings.push("ids_invented");
      if (addressed.length === 0 && sections.length === 0) return;

      const moveId = uniqueMoveId(values.id!, used, idx);
      parsed.push([
        idx,
        {
          id: moveId,
          title: capText(values.title!, 200, warnings),
          rationale: capText(values.rationale!, 1000, warnings),
          sections_touched: sections,
          addressed_finding_ids: addressed,
          new_trade_off: capText(values.new_trade_off!, 500, warnings),
        },
      ]);
    });

    if (parsed.length < minMoves) {
      return emptyFixPlan({
        error: `fix-plan returned ${parsed.length} valid moves after validation; expected at least ${minMoves}`,
        warnings,
      });
    }

    let kept = parsed;
    if (parsed.length > maxMoves) {
      kept = [...parsed]
        .sort(
          ([ai, a], [bi, b]) =>
            b.addressed_finding_ids.length - a.addressed_finding_ids.length || ai - bi,
        )
        .slice(0, maxMoves)
        .sort(([ai], [bi]) => ai - bi);
      if (!warnings.includes("move_cap_hit")) warnings.push("move_cap_hit");
    }

    const moves = kept.map(([, m]) => m);
    const addressedSet = new Set<string>();
    for (const m of moves) for (const fid of m.addressed_finding_ids) addressedSet.add(fid);

    const rawUnaddressed = raw["unaddressed_finding_ids"];
    const modelUnaddressed: string[] = [];
    if (Array.isArray(rawUnaddressed)) {
      for (const item of rawUnaddressed) {
        if (
          typeof item === "string" &&
          blockingSet.has(item) &&
          !addressedSet.has(item) &&
          !modelUnaddressed.includes(item)
        ) {
          modelUnaddressed.push(item);
        }
      }
    }
    const unaddressedSet = new Set(modelUnaddressed);
    const orphan = blockingIds.filter(
      (fid) => !addressedSet.has(fid) && !unaddressedSet.has(fid),
    );

    const summary = typeof raw["summary"] === "string" ? (raw["summary"] as string) : "";
    const notes = typeof raw["notes"] === "string" ? (raw["notes"] as string) : "";

    return {
      summary: capText(summary, 1000, warnings),
      moves,
      unaddressed_finding_ids: modelUnaddressed,
      orphan_finding_ids: orphan,
      notes: capText(notes, 3000, warnings),
      input_truncated: false,
      input_omitted_finding_ids: [],
      warnings,
      raw_output: "",
      duration_s: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      model: "",
      reasoning_effort: "",
      error: null,
    };
  } catch (err) {
    return emptyFixPlan({
      error: `fix-plan validation error: ${(err as Error).message}`,
      warnings,
    });
  }
}

// ── Fix-plan: dispatch + resolve ────────────────────────────────────────

/** Optional cost-budget hook. TS dispatch doesn't yet track challenge cost
 *  (always reports 0), so the Python `skipped_budget_exhausted` /
 *  `over_budget_after_fix` gates are no-ops in TS unless the caller wires
 *  in a budget. Left as a parameter so callers that DO track cost (future
 *  TS port of read-side calibration) can plug it in without changing the
 *  resolver signature. */
export interface ResolveFixPlanArgs {
  ctx: RedTeamRunContext;
  challenge: RedTeamResult;
  artifact: string;
  sourceSpec: string;
  enableForCalibration?: boolean;
  perRunBudgetUsd?: number;
  cfg?: FixPlanConfig;
  env?: NodeJS.ProcessEnv;
  /** Mock for tests — same shape as dispatch()'s codexFn. */
  codexFn?: (prompt: string, model: string) => {
    raw_output: string;
    duration_s: number;
    input_tokens: number;
    output_tokens: number;
    error: string | null;
  };
}

export function resolveFixPlan(args: ResolveFixPlanArgs): {
  status: FixPlanStatus;
  fixPlan: RedTeamFixPlan | null;
  runWarnings: string[];
} {
  const runWarnings: string[] = [];
  const env = args.env ?? process.env;
  if (killSwitchActive(env)) {
    runWarnings.push("red_team.fix_plan.kill_switch_active");
    return { status: "skipped_kill_switch", fixPlan: null, runWarnings };
  }
  const cfg = args.cfg ?? loadFixPlanConfig();
  if (!cfg.enabled && !args.enableForCalibration) {
    return { status: "skipped_disabled", fixPlan: null, runWarnings };
  }
  if (args.challenge.error !== null) {
    return { status: "skipped_challenge_error", fixPlan: null, runWarnings };
  }
  if (args.challenge.blocking_count === 0 && args.challenge.human_review_count > 0) {
    return { status: "skipped_human_review_only", fixPlan: null, runWarnings };
  }
  if (args.challenge.blocking_count === 0) {
    return { status: "skipped_clean", fixPlan: null, runWarnings };
  }
  if (
    args.perRunBudgetUsd !== undefined &&
    args.challenge.cost_usd >= args.perRunBudgetUsd
  ) {
    return { status: "skipped_budget_exhausted", fixPlan: null, runWarnings };
  }

  // Pre-flight the envelope so callers see the same skip behavior the
  // dispatcher would have produced.
  const filtered = args.challenge.findings.filter((f) => !isHumanReviewFinding(f));
  const pre = serializeFindingsEnvelope(filtered, cfg.max_input_chars);
  if (!pre.fitsSafely) {
    return { status: "skipped_input_too_large", fixPlan: null, runWarnings };
  }

  const fixPlan = runRedTeamFixPlan({
    ctx: args.ctx,
    artifact: args.artifact,
    sourceSpec: args.sourceSpec,
    challengeFindings: args.challenge.findings,
    synthesis: args.challenge.synthesis,
    cfg,
    codexFn: args.codexFn,
  });
  const status: FixPlanStatus = fixPlan.error === null ? "success" : "error";
  if (
    fixPlan.error === null &&
    args.perRunBudgetUsd !== undefined &&
    args.challenge.cost_usd + fixPlan.cost_usd > args.perRunBudgetUsd
  ) {
    runWarnings.push("over_budget_after_fix");
    if (!fixPlan.warnings.includes("over_budget_after_fix")) {
      fixPlan.warnings.push("over_budget_after_fix");
    }
  }
  return { status, fixPlan, runWarnings };
}

export function runRedTeamFixPlan(args: {
  ctx: RedTeamRunContext;
  artifact: string;
  sourceSpec: string;
  challengeFindings: readonly RedTeamFinding[];
  synthesis: string;
  cfg: FixPlanConfig;
  codexFn?: ResolveFixPlanArgs["codexFn"];
}): RedTeamFixPlan {
  const filtered = args.challengeFindings.filter((f) => !isHumanReviewFinding(f));
  const { prompt, omittedIds, fitsSafely } = assembleFixPlanPrompt({
    stage: args.ctx.stage,
    artifact: args.artifact,
    sourceSpec: args.sourceSpec,
    findings: filtered,
    synthesis: args.synthesis,
    maxInputChars: args.cfg.max_input_chars,
  });
  const inputTruncated = omittedIds.length > 0;
  if (!fitsSafely) {
    return emptyFixPlan({
      error: "findings JSON cannot be safely truncated",
      model: args.cfg.model,
      reasoningEffort: args.cfg.reasoning_effort,
      inputTruncated,
      inputOmittedFindingIds: omittedIds,
    });
  }
  const sensitiveHits = preDispatchSensitiveGate(prompt);
  if (sensitiveHits.length > 0) {
    return emptyFixPlan({
      error: `pre-dispatch gate refused: matched patterns ${sensitiveHits.join(", ")}`,
      model: args.cfg.model,
      reasoningEffort: args.cfg.reasoning_effort,
      inputTruncated,
      inputOmittedFindingIds: omittedIds,
    });
  }
  const dispatched = args.codexFn
    ? args.codexFn(prompt, args.cfg.model)
    : dispatchCodex(prompt, args.cfg.model, args.cfg.timeout_s * 1000);
  if (dispatched.error !== null) {
    return emptyFixPlan({
      error: dispatched.error,
      rawOutput: dispatched.raw_output,
      durationS: dispatched.duration_s,
      inputTokens: dispatched.input_tokens,
      outputTokens: dispatched.output_tokens,
      model: args.cfg.model,
      reasoningEffort: args.cfg.reasoning_effort,
      inputTruncated,
      inputOmittedFindingIds: omittedIds,
    });
  }
  const rawDict = parseFixPlanOutput(dispatched.raw_output);
  const blockingIds = filtered
    .filter(
      (f) =>
        (SEVERITY_RANK_NUM[f.severity] ?? 0) >= SEVERITY_RANK_NUM.high,
    )
    .map((f) => f.id);
  const validated = validateFixPlan(rawDict, blockingIds, args.cfg);
  validated.raw_output = dispatched.raw_output;
  validated.duration_s = dispatched.duration_s;
  validated.cost_usd = 0;
  validated.input_tokens = dispatched.input_tokens;
  validated.output_tokens = dispatched.output_tokens;
  validated.model = args.cfg.model;
  validated.reasoning_effort = args.cfg.reasoning_effort;
  validated.input_truncated = inputTruncated;
  validated.input_omitted_finding_ids = omittedIds;
  return validated;
}

// ── Fix-plan: markdown rendering ────────────────────────────────────────

const RT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function renderRtIds(ids: readonly string[]): string {
  const valid = ids.filter((id) => RT_ID_RE.test(id));
  return valid.length > 0 ? valid.map((id) => `\`${id}\``).join(", ") : "_None_";
}

function renderTextBlock(label: string, body: string): string[] {
  return [`**${label}.** ${redact(escapeBlock(body))}`];
}

export function renderFixPlanSection(args: {
  status: FixPlanStatus;
  fixPlan: RedTeamFixPlan | null;
}): string {
  const { status, fixPlan } = args;
  const lines: string[] = ["## Proposed Fix Plan", ""];
  if (status === "success" && fixPlan !== null) {
    const addressed = new Set<string>();
    for (const m of fixPlan.moves) for (const fid of m.addressed_finding_ids) addressed.add(fid);
    const addressedCount = addressed.size;
    const unaddressedCount = fixPlan.unaddressed_finding_ids.length;
    const orphanCount = fixPlan.orphan_finding_ids.length;
    const blockingTotal = addressedCount + unaddressedCount + orphanCount;
    lines.push("**Status:** success");
    lines.push(
      `**Generated by:** \`${fixPlan.model}\` at reasoning effort \`${fixPlan.reasoning_effort}\``,
    );
    lines.push(
      `**Cost / duration:** $${fixPlan.cost_usd.toFixed(4)} / ${fixPlan.duration_s.toFixed(1)}s | **Tokens:** in=${fixPlan.input_tokens} out=${fixPlan.output_tokens}`,
    );
    const coverageExtras: string[] = [];
    if (unaddressedCount) coverageExtras.push(`${unaddressedCount} deliberately deferred`);
    if (orphanCount) coverageExtras.push(`${orphanCount} orphaned`);
    const coverageSuffix = coverageExtras.length > 0 ? ` (${coverageExtras.join(", ")})` : "";
    lines.push(
      `**Coverage:** ${addressedCount} of ${blockingTotal} blocking findings addressed${coverageSuffix}`,
    );
    if (fixPlan.warnings.length > 0) {
      lines.push("**Warnings:** " + fixPlan.warnings.map((w) => `\`${w}\``).join(", "));
    }
    if (fixPlan.input_truncated && fixPlan.input_omitted_finding_ids.length > 0) {
      lines.push(
        "**Input truncated — omitted finding IDs:** " +
          renderRtIds(fixPlan.input_omitted_finding_ids),
      );
    }
    lines.push("");
    if (fixPlan.summary) {
      lines.push(...renderTextBlock("Summary", fixPlan.summary));
      lines.push("");
    }
    fixPlan.moves.forEach((move, i) => {
      lines.push(`### ${i + 1}. ${redact(escapeBlock(move.title))}`);
      lines.push("");
      lines.push(`**Addresses:** ${renderRtIds(move.addressed_finding_ids)}`);
      if (move.sections_touched.length > 0) {
        lines.push(
          "**Sections touched:** " + move.sections_touched.map((s) => `\`${s}\``).join(", "),
        );
      }
      lines.push("");
      lines.push(...renderTextBlock("Rationale", move.rationale));
      lines.push("");
      lines.push(...renderTextBlock("New trade-off", move.new_trade_off));
      lines.push("");
    });
    lines.push("### Unaddressed findings");
    lines.push(renderRtIds(fixPlan.unaddressed_finding_ids));
    lines.push("");
    lines.push("### Orphan findings");
    lines.push(renderRtIds(fixPlan.orphan_finding_ids));
    lines.push("");
    if (fixPlan.notes) {
      lines.push("### Notes");
      lines.push("");
      lines.push(redact(escapeBlock(fixPlan.notes)));
      lines.push("");
    }
  } else if (status === "error") {
    lines.push("**Status:** error");
    if (fixPlan?.error) {
      lines.push(`**Error:** ${redact(escapeBlock(fixPlan.error))}`);
    }
    if (fixPlan?.warnings.length) {
      lines.push("**Warnings:** " + fixPlan.warnings.map((w) => `\`${w}\``).join(", "));
    }
  } else if (status === "success") {
    // Defensive: resolveFixPlan only emits success with a non-null fixPlan,
    // but a future caller could violate that contract. Surface honestly
    // rather than silently mis-render as "skipped — success".
    lines.push("**Status:** error");
    lines.push("**Error:** fix-plan status was `success` but the plan body is missing");
  } else {
    lines.push(`**Status:** skipped — ${status}`);
  }
  // Enforce a hard cap so the sidecar can't blow past PR-comment limits.
  const rendered = lines.join("\n");
  if (rendered.length > FIX_PLAN_SECTION_LIMIT) {
    return rendered.slice(0, FIX_PLAN_SECTION_LIMIT) + "\n\n_[fix-plan section truncated]_";
  }
  return rendered;
}

// ── Payload builders (mirror Python `build_*_envelope` payload shape) ───

function worstSeverity(result: RedTeamResult): Severity | null {
  if (result.error) return null;
  const severities = result.findings
    .map((f) => f.severity)
    .filter((s): s is Severity => SEVERITY_RANK_NUM[s] !== undefined);
  if (severities.length === 0) return null;
  return severities.reduce((acc, s) =>
    SEVERITY_RANK_NUM[s] > SEVERITY_RANK_NUM[acc] ? s : acc,
  );
}

/** Default `caller` identity stamped onto the audit run row. Blocked /
 *  errored runs early-return before the audit write fires, so the
 *  reason-suffixed variant from `makeBlocked` never reaches here. */
const AUDIT_CALLER = "stark-red-team-ts";

export function buildRunPayload(args: {
  ctx: RedTeamRunContext;
  result: RedTeamResult;
  model: string;
  fixPlanStatus: FixPlanStatus | null;
  runWarnings: string[];
  caller?: string;
}): Record<string, unknown> {
  const { ctx, result, model, fixPlanStatus, runWarnings } = args;
  const repoLabel = ctx.repo ?? "unknown";
  return {
    run_id: ctx.run_id,
    stage: ctx.stage,
    model,
    caller: args.caller ?? AUDIT_CALLER,
    final_status: deriveStatus(result),
    worst_severity: worstSeverity(result),
    passed: deriveStatus(result) === "clean",
    rounds_used: result.round_num,
    total_findings: result.findings.length,
    blocking_count: result.blocking_count,
    human_review_count: result.human_review_count,
    critical_count: result.findings.filter((f) => f.severity === "critical").length,
    high_count: result.findings.filter((f) => f.severity === "high").length,
    medium_count: result.findings.filter((f) => f.severity === "medium").length,
    duration_s: result.duration_s,
    cost_usd: result.cost_usd,
    repo: repoLabel,
    artifact_relative_path: ctx.artifact_relative_path,
    pr_number: ctx.pr_number,
    fix_plan_status: fixPlanStatus,
    warnings: [...runWarnings],
    round_outcomes: [],
    terminal_transition: null,
  };
}

export function buildFindingPayload(args: {
  ctx: RedTeamRunContext;
  finding: RedTeamFinding;
  roundNum: number;
  /** Optional policy override for tests / calibration. Production callers
   *  pass undefined and let the function load it from global/config.json. */
  policy?: AuditRetentionPolicy;
}): Record<string, unknown> {
  const { ctx, finding, roundNum } = args;
  const repoLabel = ctx.repo ?? "unknown";
  const stableKey = `${ctx.run_id}:${ctx.stage}:${roundNum}:${finding.persona}:${finding.id}:${finding.concern_hash}`;
  // Resolve the FU-rt6 retention policy. Default ships as excerpt mode so
  // the metrics queue never carries verbatim model output unless an
  // operator explicitly flips `red_team.audit.retain_full_text` to true.
  const policy = args.policy ?? loadAuditPolicy(REPO_ROOT);
  const concern = applyToField(finding.concern, policy);
  const consequence = applyToField(finding.consequence, policy);
  const counter = applyToField(finding.counter_proposal, policy);
  const tradeOff = applyToField(finding.trade_off, policy);
  const reason = applyToField(finding.reason_for_uncertainty, policy);
  return {
    run_id: ctx.run_id,
    stage: ctx.stage,
    round_num: roundNum,
    finding_id: finding.id,
    persona: finding.persona,
    severity: finding.severity,
    stable_key: stableKey,
    concern_hash: finding.concern_hash,
    risk_key: finding.risk_key,
    affected_component: finding.affected_component,
    failure_mode: finding.failure_mode,
    retention_mode: policyMode(policy),
    concern: concern.stored,
    consequence: consequence.stored,
    counter_proposal: counter.stored ?? finding.counter_proposal,
    trade_off: tradeOff.stored,
    reason_for_uncertainty: reason.stored,
    concern_excerpt_hash: concern.hash,
    consequence_excerpt_hash: consequence.hash,
    counter_proposal_excerpt_hash: counter.hash,
    trade_off_excerpt_hash: tradeOff.hash,
    reason_for_uncertainty_excerpt_hash: reason.hash,
    is_human_review: isHumanReviewFinding(finding),
    repo: repoLabel,
    pr_number: ctx.pr_number,
  };
}

export function buildFixPlanPayload(args: {
  ctx: RedTeamRunContext;
  fixPlan: RedTeamFixPlan;
  fixPlanMd: string;
}): Record<string, unknown> {
  const { ctx, fixPlan, fixPlanMd } = args;
  const repoLabel = ctx.repo ?? "unknown";
  const addressed = new Set<string>();
  for (const m of fixPlan.moves) for (const fid of m.addressed_finding_ids) addressed.add(fid);
  return {
    run_id: ctx.run_id,
    stage: ctx.stage,
    model: fixPlan.model,
    reasoning_effort: fixPlan.reasoning_effort,
    summary: fixPlan.summary,
    notes: fixPlan.notes,
    moves: fixPlan.moves.map((m) => ({ ...m })),
    move_count: fixPlan.moves.length,
    addressed_finding_ids: [...addressed],
    unaddressed_finding_ids: [...fixPlan.unaddressed_finding_ids],
    orphan_finding_ids: [...fixPlan.orphan_finding_ids],
    input_truncated: fixPlan.input_truncated,
    input_omitted_finding_ids: [...fixPlan.input_omitted_finding_ids],
    warnings: [...fixPlan.warnings],
    cost_usd: fixPlan.cost_usd,
    duration_s: fixPlan.duration_s,
    input_tokens: fixPlan.input_tokens,
    output_tokens: fixPlan.output_tokens,
    fix_plan_md: fixPlanMd,
    repo: repoLabel,
    pr_number: ctx.pr_number,
  };
}

