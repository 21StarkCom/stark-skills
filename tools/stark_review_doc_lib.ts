/**
 * Pure helpers for the doc-review dispatcher (`stark_review_doc.ts`).
 *
 * Shared by /stark-review-spec and /stark-review-plan. No I/O at the top
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
  /** Domains (beyond this finding's own) that independently raised the same
   * issue this round — populated by dedupeDocFindings when cross-domain
   * refractions of one root cause are merged into this canonical finding. */
  cross_validated_by?: string[];
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
  /** Cap on patches handed to the wing per round, top-N by severity. The
   * overflow stays recorded as findings (final review + Phase 5 catch them)
   * but is not patched — bulk medium "add detail" batches are what compound
   * doc growth. 0 = uncapped. */
  max_fixes_per_round: number;
  /** A fix round whose applied result grows the doc past this ratio gets one
   * in-round compress pass (the coherence net-reducing contract, applied
   * before commit) — fixes create next round's review surface, so the shrink
   * force runs per round, not once at the end. 0 disables. */
  compress_retry_growth_ratio: number;
  /** Skill-local cap on concurrent codex dispatches (codex serializes hard on
   * ChatGPT-tier accounts; bump cautiously). */
  max_codex_concurrent: number;
  /** Run the single coherence pass (contradictions / repetitions / fluff /
   * leftovers) after the fix loop, before the final review. */
  coherence_pass: boolean;
  /** Per-doc history retention: keep this many run dirs (`<slug>/<run-id>/`),
   * prune older ones. */
  history_keep_runs: number;
  /** Process-health circuit breakers — see stark_review_doc_analytics_lib.ts. */
  analytics: {
    max_doc_growth_ratio: number;
    hard_doc_growth_ratio: number;
    max_round_growth_ratio: number;
    non_convergent_rounds: number;
    churn_recurring_share: number;
    /** On a padding abort (hard-growth cap or invent-then-condemn), restore the
     * document to its pre-loop state instead of leaving the operator the bloat. */
    rollback_on_hard_growth: boolean;
  };
}

export const DEFAULT_DOC_REVIEW_CONFIG: DocReviewConfig = {
  agents: ["codex"],
  fix_threshold: "medium",
  disabled_domains: [],
  // 2, not 3: with the fix cap + anti-churn feedback in place, round 3 was
  // where runs padded rather than converged (the kotodama balloon paid for a
  // third round only to roll it back). A run that genuinely needs more passes
  // opts in via --rounds.
  max_rounds: 2,
  max_fixes_per_round: 8,
  compress_retry_growth_ratio: 1.15,
  max_codex_concurrent: 3,
  coherence_pass: true,
  history_keep_runs: 20,
  analytics: {
    max_doc_growth_ratio: 2.0,
    hard_doc_growth_ratio: 3.0,
    max_round_growth_ratio: 1.5,
    non_convergent_rounds: 2,
    churn_recurring_share: 0.5,
    rollback_on_hard_growth: true,
  },
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
   * dispatcher_base convention (`spec-prompts`, `plan-prompts`). */
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
  /** Rendered summary of the previous round's wing patches (see
   * renderPriorRoundChanges) — the anti-churn feedback that stops reviewers
   * from re-raising findings against text that was just added to resolve
   * their prior findings. */
  priorRoundNote?: string;
}): string {
  const parts = [
    opts.agentMd.trim(),
    "",
    opts.domainPrompt.trim(),
    "",
    DOC_FINDINGS_FORMAT,
    "",
    ...(opts.priorRoundNote ? [opts.priorRoundNote, ""] : []),
    "## Document under review",
    "",
    opts.doc,
  ];
  return parts.filter((p, i) => p.length > 0 || i === 0).join("\n");
}

/**
 * Render the previous round's applied wing patches as reviewer context.
 *
 * The `priorFixed` recurring-dedup keys on (section, domain, agent) — which
 * freshly-ADDED sections evade (new section names → new keys), so reviewers
 * kept piling findings onto last round's fix text and the loop churned. This
 * block shows reviewers exactly what the previous round added and forbids
 * "extend it" findings against it; "revert it" stays legitimate.
 *
 * Per-patch excerpts are truncated and the whole block is capped so a big
 * fix round cannot crowd out the document itself.
 */
export function renderPriorRoundChanges(
  applied: readonly FixerPatch[],
  maxChars = 6000,
): string {
  if (applied.length === 0) return "";
  const header = [
    "## Text added by previous fix rounds (do not re-review it)",
    "",
    "The excerpts below were added or rewritten by earlier rounds' fixer to resolve findings already raised. **Do not raise findings against this text** — not \"expand it\", not \"add detail\", not \"also cover X\": that creates a churn loop where every fix becomes next round's finding. If text added by a previous round is WRONG or overreaches the document's scope, the correct finding is **\"revert it\"**, not \"extend it\".",
    "",
  ].join("\n");
  const parts: string[] = [];
  let used = 0;
  const perPatchCap = 800;
  for (const p of applied) {
    const body = p.new.length > 0 ? p.new : "(text removed)";
    const excerpt = body.length > perPatchCap ? body.slice(0, perPatchCap) + "\n…(truncated)" : body;
    // Fence-safe: the excerpt may itself contain ``` (fixes routinely add
    // fenced examples). Use a fence longer than any backtick run inside it —
    // computed AFTER truncation so a cut can't leave an unbalanced fence.
    const runs = excerpt.match(/`+/g);
    const fence = "`".repeat(Math.max(3, (runs ? Math.max(...runs.map((r) => r.length)) : 0) + 1));
    const block = fence + "\n" + excerpt + "\n" + fence;
    if (used + block.length > maxChars) {
      parts.push(`…(${applied.length - parts.length} more patch(es) omitted)`);
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return header + parts.join("\n\n");
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

// ─── Cross-domain dedup ─────────────────────────────────────────────────

function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Token-overlap similarity on title+description — the iac_review_lib
 * `titlesOverlap` pattern, fed with more text since doc findings have no
 * file/line anchor to lean on. */
function findingsOverlap(a: DocFinding, b: DocFinding): boolean {
  const tok = (f: DocFinding): Set<string> =>
    new Set(normText(`${f.title} ${f.description}`).split(" ").filter((w) => w.length > 3));
  const wa = tok(a);
  const wb = tok(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.min(wa.size, wb.size) >= 0.5;
}

/**
 * Merge cross-domain refractions of one root cause within a round.
 *
 * One real defect routinely comes back as 4-5 findings — the same hole
 * reported by data-modeling, api-design, completeness, consistency, and
 * test-plan with different phrasing. Uncollapsed, the convergence breaker
 * and analytics count the refractions and the wing patches each one
 * separately. Group on same anchor section (or an empty section on either
 * side) + (same normalized title OR strong token overlap on
 * title+description); the canonical survivor is the highest-severity one and
 * carries the other DOMAINS in `cross_validated_by`. Mirrors
 * iac_review_lib::dedupeFindings / multi_review's cross-agent collapse.
 */
export function dedupeDocFindings(findings: DocFinding[]): DocFinding[] {
  const groups: DocFinding[][] = [];
  for (const f of findings) {
    let placed = false;
    for (const g of groups) {
      const h = g[0]!;
      // Sections must MATCH (both-empty counts as a match). No empty-section
      // wildcard: a section-less finding merging into any section on generic
      // token overlap silently drops distinct findings — losing a real
      // finding is strictly worse than posting a duplicate.
      const sameSection = normText(h.section) === normText(f.section);
      const sameTitle = normText(h.title) === normText(f.title);
      if (sameSection && (sameTitle || findingsOverlap(h, f))) {
        g.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([f]);
  }

  const merged: DocFinding[] = [];
  for (const g of groups) {
    g.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    const canonical: DocFinding = { ...g[0]! };
    const otherDomains = [...new Set(g.slice(1).map((x) => x.domain))]
      .filter((d) => d !== canonical.domain);
    if (otherDomains.length > 0) canonical.cross_validated_by = otherDomains;
    merged.push(canonical);
  }
  return merged;
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
  // Recurring keys span the canonical domain AND every cross_validated_by
  // domain — dedup picks the canonical by severity, so the same refracted
  // concern can surface under a different canonical domain next round; keying
  // on one domain only would blind the recurring/churn detection.
  const domainsOf = (f: DocFinding): string[] => [f.domain, ...(f.cross_validated_by ?? [])];
  const priorKeys = new Set(
    ctx.priorFixed.flatMap((f) => domainsOf(f).map((d) => `${f.section}|${d}|${f.agent}`)),
  );
  const seenAgentTitle = new Set<string>();
  const out: DocFinding[] = [];
  for (const f of raw) {
    let classification: Classification;
    let reason = "";
    if (!severityMeetsThreshold(f.severity, ctx.fixThreshold)) {
      classification = "ignored";
      reason = `severity ${f.severity} < threshold ${ctx.fixThreshold}`;
    } else if (domainsOf(f).some((d) => priorKeys.has(`${f.section}|${d}|${f.agent}`))) {
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

export interface FixSelection {
  /** The per-round wing batch: top-`cap` by severity. */
  selected: DocFinding[];
  /** Eligible findings deferred by the cap — recorded, not patched this
   * round (the final review + Phase 5 pick them up). */
  deferred: DocFinding[];
}

/**
 * Cap the per-round fix batch. `sorted` must already be severity-sorted
 * (selectFindingsToFix's output). Uncapped runs passed 16-21 patches to the
 * wing per round — mostly medium "add detail" — which is what compounds doc
 * growth; the cap keeps each round to the top-N most severe findings and
 * lets the rest accumulate as recorded findings instead of patches.
 * `cap <= 0` means uncapped.
 */
export function capFindingsToFix(sorted: DocFinding[], cap: number): FixSelection {
  if (cap <= 0 || sorted.length <= cap) return { selected: sorted, deferred: [] };
  return { selected: sorted.slice(0, cap), deferred: sorted.slice(cap) };
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
  "- **DELETION-FIRST — fixes must be allowed to delete.** Prefer resolving a finding by tightening, correcting, or REMOVING text over appending new prose. Every character you add is next round's review surface: additive fixes are how documents balloon. A patch whose `new` is NET LONGER than its `old` is justified only when the finding names genuinely missing substance (a hole, not a wording/clarity/consistency complaint) — and then add the minimal statement, not a subsection. A contradiction is fixed by deleting the wrong half, not by adding a paragraph reconciling both. If most of your patches add text, you are doing it wrong.",
  "- Group multiple findings that touch the same paragraph into ONE patch with all the needed edits.",
  "- **SCOPE GUARD — do not add production machinery to a playground document.** If the document declares single-user / local / personal / playground scope (or states a small scale), and a finding would have you ADD platform hardening — HA / failover / distributed-recovery or crash-consistency semantics, audit trails or append-only history, credential/token rotation, homoglyph / adversarial-input / injection defenses, schema-version counters or migration/backfill frameworks for a local single-writer store, rate limiting / pagination / backpressure / budget circuit-breakers, fleet alerting or multi-tenant isolation — do NOT patch it. Put it in `skipped` with reason \"out of scope for declared playground scope\". You are the amplifier that turns an over-scoped finding into committed doc growth; refuse. The reviewer being technically correct in the abstract does not make the machinery in scope. When in doubt between adding a subsystem and skipping, skip.",
  "- **DEFERRED-SCOPE GUARD — the document's own V1 boundary is binding, even on a production system.** Playground scope is not the only protection. When the document EXPLICITLY defers a concern — a \"What this is NOT\" section, \"Out of scope for V1\", \"deferred to Phase 2\", a \"dark by default\" rollout statement — the absence of that concern is the author's decision, not a gap, no matter how production-grade the surrounding system is (IAP / Cloud Run / Secret Manager around the slice do not void the boundary). If a finding would have you ADD an explicitly-deferred concern (SLOs, validation, retention policies, monitoring, hardening, migrations, …), do NOT patch it. Put it in `skipped` with reason \"author deferred to V1 boundary / out of scope\". If the deferral itself is genuinely dangerous, the only in-bounds patch is one that flags or adjusts the boundary statement — never one that smuggles in the deferred machinery.",
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

// ─── Coherence pass ──────────────────────────────────────────────────────

/**
 * Build the prompt for the single post-fix-loop coherence pass. Reuses the
 * WING_FIXER_CONTRACT patch shape (finding_id = "coherence") and the same
 * applier, so no new parse path is needed.
 *
 * The pass is a net-reducer: after several fix rounds the document tends to
 * accumulate contradictions between patched sections, repeated statements,
 * filler prose, and leftovers (references to text a patch removed). This
 * pass tightens; it must never add new requirements or grow the document.
 */
export function buildCoherencePrompt(opts: { doc: string }): string {
  return [
    "# Document Coherence Pass",
    "",
    "You are the **coherence editor** for stark-review-doc. The document below has been through several automated review-fix rounds. Patches from different rounds may have left it internally inconsistent. Your ONLY job is to tighten it — you must NOT add new requirements, sections, caveats, or content.",
    "",
    "Look for exactly these four defect classes:",
    "",
    "1. **Contradictions** — two passages that state incompatible things (a limit set to different values, a step described as both required and optional, a decision reversed elsewhere). Keep the version consistent with the document's overall intent; fix or remove the other.",
    "2. **Repetitions** — the same statement, rule, or explanation appearing more than once (verbatim or paraphrased). Keep the best-placed occurrence; delete the rest.",
    "3. **Fluff** — filler that adds no information: restated context, hedging boilerplate, empty summaries, sentences that only announce what the next sentence says.",
    "4. **Leftovers** — artifacts of prior edits: references to sections/terms that no longer exist, orphaned transition sentences, duplicated headings, stale numbering, half-merged paragraphs.",
    "",
    "Rules:",
    "- Every patch must REDUCE or preserve the document's length. If a rewrite would grow it, don't make it.",
    "- Do not change the technical meaning of any requirement. When resolving a contradiction, prefer the reading most consistent with the rest of the document.",
    "- If the document is already coherent, emit an empty `patches` array. That is a good outcome, not a failure.",
    "- Use `finding_id: \"coherence\"` on every patch.",
    "",
    "## Document",
    "",
    opts.doc,
    "",
    WING_FIXER_CONTRACT,
  ].join("\n");
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

// ─── Growth baseline pinning ────────────────────────────────────────────

// ─── Disposition threading across rounds ────────────────────────────────

export type FindingDisposition =
  | "fixed"          // a wing patch for this finding was applied
  | "skipped"        // the wing explicitly declined (reason attached)
  | "deferred"       // pushed out by max_fixes_per_round this round
  | "patch_failed"   // the wing tried but no patch applied cleanly
  | "discarded";     // applied, then thrown away by a round revert

export interface PriorDisposition {
  finding: DocFinding;
  disposition: FindingDisposition;
  round: number;
  reason?: string;
}

/**
 * Render prior rounds' finding dispositions as reviewer context — the
 * red-team `spec_dispositions` pattern ported to the doc-review loop.
 *
 * Rounds are otherwise stateless: a concern the wing already resolved (or
 * explicitly skipped as an accepted trade-off / out-of-scope deferral)
 * re-surfaces every round forever, from multiple domains. This block tells
 * the lead what was already raised and how it was resolved, and narrows
 * re-raising to broken/contradicted resolutions only.
 */
export function renderPriorDispositions(
  dispositions: readonly PriorDisposition[],
  maxChars = 6000,
): string {
  if (dispositions.length === 0) return "";
  const label: Record<FindingDisposition, string> = {
    fixed: "fixed via patch",
    skipped: "skipped by fixer",
    deferred: "deferred to a later fix round — still open",
    patch_failed: "patch failed — still open",
    discarded: "fix discarded by a round revert — still open",
  };
  // Reconcile: one entry per finding, the LATEST disposition wins — a finding
  // deferred in round 1 and fixed in round 2 must not render two
  // contradictory lines.
  const byId = new Map<string, PriorDisposition>();
  for (const d of dispositions) byId.set(d.finding.id, d);
  const reconciled = [...byId.values()];
  const header = [
    "## Findings already raised in earlier rounds — and how each was resolved",
    "",
    "The list below is this review's own memory. Do NOT re-raise a finding whose resolution stands — not verbatim, not re-phrased, not from a different domain's angle. A `skipped by fixer` entry is a standing decision (accepted trade-off / declared out-of-scope), not an open item. Re-raise ONLY when you can point at current document text that breaks or contradicts the recorded resolution, and say so explicitly in the description.",
    "",
  ].join("\n");
  const lines: string[] = [];
  let used = header.length;
  for (const d of reconciled) {
    const f = d.finding;
    const line = `- [${f.severity}/${f.domain}] ${f.section || "(no section)"} — ${f.title}: **${label[d.disposition]}** (round ${d.round}${d.reason ? `; ${d.reason}` : ""})`;
    if (used + line.length > maxChars) {
      lines.push(`- …(${reconciled.length - lines.length} more omitted)`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return header + lines.join("\n");
}

/**
 * True when a git commit subject is one of this pipeline's own UNATTENDED
 * mutations of the document — a wing fix round, the coherence pass, or a
 * padding revert. Used to pin the growth baseline: a re-run or resumed
 * review walks past these commits to the last authored/accepted version of
 * the doc, so growth is measured against that content instead of a moving
 * baseline that already contains previous rounds' growth.
 *
 * Phase-5b manual fix commits (`docs(review-spec): fix …`) are deliberately
 * NOT matched: they are operator-in-the-loop edits made after the growth-ack
 * gate, so they count as acceptance of the doc's current size — the baseline
 * resets there, and a later re-run does not re-litigate acked growth.
 */
export function isReviewMutationCommitSubject(subject: string): boolean {
  return (
    /^docs: (spec|plan)-review (round \d+ fixes|coherence pass)/.test(subject) ||
    /^revert\(review-doc\):/.test(subject)
  );
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

/** Run id: sortable timestamp + pid — unique per process, lexicographic
 * order == chronological order. */
export function newRunId(now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}` +
    `-${process.pid}`
  );
}

/** Per-RUN history dir: `<home>/.claude/code-review/history/<promptsDir>s/<slug>/<runId>`.
 * A re-run of the same doc gets its own dir — previous runs are never
 * clobbered (the analytics contract). */
export function buildHistoryDir(opts: {
  home: string;
  promptsDir: string;
  docPath: string;
  runId: string;
}): string {
  const base = path.join(
    opts.home,
    ".claude",
    "code-review",
    "history",
    opts.promptsDir + "s",
  );
  const slug = path.basename(opts.docPath).replace(/\.md$/i, "");
  return path.join(base, slug, opts.runId);
}

/** Atomic JSON write: tmp file + rename, so a crash mid-write never leaves a
 * truncated file where a reader expects valid JSON. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/** Point `<slugDir>/latest` at the given run (atomic symlink swap; falls back
 * to a `latest.txt` pointer file on filesystems without symlink support). */
export function updateLatestPointer(slugDir: string, runId: string): void {
  const link = path.join(slugDir, "latest");
  const tmp = `${link}.tmp-${process.pid}`;
  try {
    try { fs.unlinkSync(tmp); } catch { /* stale tmp from a dead run */ }
    fs.symlinkSync(runId, tmp);
    fs.renameSync(tmp, link);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    fs.writeFileSync(path.join(slugDir, "latest.txt"), runId + "\n");
  }
}

/** Keep the newest `keep` run dirs under `<slugDir>` (run-ids sort
 * lexicographically == chronologically), remove the rest. Never touches the
 * `latest` pointer entries. Returns the pruned run-ids. */
export function pruneRunDirs(slugDir: string, keep: number): string[] {
  if (!fs.existsSync(slugDir) || keep <= 0) return [];
  const runs = fs
    .readdirSync(slugDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.isSymbolicLink() && e.name !== "latest")
    .map((e) => e.name)
    .sort()
    .reverse();
  const pruned: string[] = [];
  for (const name of runs.slice(keep)) {
    try {
      fs.rmSync(path.join(slugDir, name), { recursive: true, force: true });
      pruned.push(name);
    } catch { /* best-effort retention */ }
  }
  return pruned;
}

export function persistRoundsHistory(opts: {
  historyDir: string;
  docPath: string;
  promptsDir: string;
  runId: string;
  rounds: PersistedRound[];
  models: Record<string, string>;
}): void {
  fs.mkdirSync(opts.historyDir, { recursive: true });
  const payload = {
    doc: opts.docPath,
    prompts_dir: opts.promptsDir,
    run_id: opts.runId,
    models: opts.models,
    rounds: opts.rounds,
    generated_at: new Date().toISOString(),
  };
  writeJsonAtomic(path.join(opts.historyDir, "rounds.json"), payload);
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

// ─── Coverage + adaptive timeouts ────────────────────────────────────────

export interface DomainCoverage {
  attempts: number;
  completions: number;
  timeouts: number;
  last_error: string | null;
}

export interface CoverageReport {
  domains: Record<string, DomainCoverage>;
  /** Sorted keys of domains with attempts > 0 && completions === 0. */
  gaps: string[];
}

/**
 * Aggregate per-domain completion across every round of a run. A domain that
 * was attempted but never completed in ANY round is a coverage gap — the
 * review it was responsible for never happened, which is not the same thing
 * as a clean pass.
 */
export function computeCoverage(
  rounds: ReadonlyArray<{ results: ReadonlyArray<{ domain: string; error: string | null }> }>,
  allDomains: readonly string[],
): CoverageReport {
  const domains: Record<string, DomainCoverage> = {};
  for (const d of allDomains) domains[d] = { attempts: 0, completions: 0, timeouts: 0, last_error: null };
  for (const round of rounds) {
    for (const r of round.results) {
      const c = domains[r.domain] ?? (domains[r.domain] = { attempts: 0, completions: 0, timeouts: 0, last_error: null });
      c.attempts++;
      if (r.error === null) c.completions++;
      else {
        if (r.error === "timeout") c.timeouts++;
        c.last_error = r.error;
      }
    }
  }
  const gaps = Object.keys(domains)
    .filter((d) => domains[d]!.attempts > 0 && domains[d]!.completions === 0)
    .sort();
  return { domains, gaps };
}

/** Doubling escalation capped at 3× base: 600 → 1200 → 1800 → 1800. A domain
 * that timed out gets a bigger ceiling on its next attempt instead of
 * re-failing at the same one every round. */
export function nextDomainTimeout(currentSec: number, baseSec: number): number {
  return Math.min(baseSec * 3, currentSec * 2);
}

export const TIMEOUT_SCALE_CHARS = 16_000;

/** Scale the base lead timeout with document size: 1× up to
 * TIMEOUT_SCALE_CHARS, linear above, capped at 3× base. A 200-line spec
 * reviews fine at 600s; a 700-line plan starved at the same ceiling. */
export function scaleTimeoutForDocSize(baseSec: number, docChars: number): number {
  const scaled = Math.round(baseSec * (docChars / TIMEOUT_SCALE_CHARS));
  return Math.min(baseSec * 3, Math.max(baseSec, scaled));
}

/** Single source of truth for run outcome: a coverage gap is a failed run —
 * `ok` and the exit code must say so, not just a buried per-round error. */
export function deriveRunOutcome(opts: {
  dispatchFailureEarlyExit: boolean;
  coverageGaps: readonly string[];
}): { ok: boolean; exitCode: 0 | 1; error: { code: string; message: string } | null } {
  if (opts.dispatchFailureEarlyExit) {
    return {
      ok: false,
      exitCode: 1,
      error: { code: "dispatch_failure", message: "All lead reviewers failed in a round; see rounds[].failed_results" },
    };
  }
  if (opts.coverageGaps.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      error: {
        code: "coverage_gap",
        message: `domains never completed a review in any round: ${opts.coverageGaps.join(", ")}`,
      },
    };
  }
  return { ok: true, exitCode: 0, error: null };
}

// ─── Convergence pass (ADR 0022) ─────────────────────────────────────────

/**
 * Resolve the convergence prompt (root-level `convergence.md`, NOT a
 * discovered domain) + the agent preamble. Repo override first
 * (`.code-review/<repoSubdir>/convergence.md`), then the global prompts dir.
 * Returns null when no convergence prompt exists anywhere.
 */
export function resolveConvergencePromptSources(opts: {
  agent: AgentName;
  promptsDir: string;
  repoDir?: string | null;
  repoSubdir: string;
}): PromptSources | null {
  const repoDir = opts.repoDir ?? null;
  let convText: string | null = null;
  let agentText: string | null = null;

  if (repoDir) {
    const base = path.join(repoDir, ".code-review", opts.repoSubdir);
    const c = path.join(base, "convergence.md");
    if (fs.existsSync(c)) convText = fs.readFileSync(c, "utf-8");
    const a = path.join(base, opts.agent, "agent.md");
    if (fs.existsSync(a)) agentText = fs.readFileSync(a, "utf-8");
  }
  if (convText === null) {
    const c = path.join(opts.promptsDir, "convergence.md");
    if (fs.existsSync(c)) convText = fs.readFileSync(c, "utf-8");
  }
  if (agentText === null) {
    const a = path.join(opts.promptsDir, opts.agent, "agent.md");
    if (fs.existsSync(a)) agentText = fs.readFileSync(a, "utf-8");
  }
  if (convText === null) return null;
  return { agentMd: agentText ?? "", domainPrompt: convText };
}

/**
 * The convergence reviewer's input: the delta under review first, the full
 * document after it as verification context. Fed to `buildReviewerPrompt` in
 * place of the bare document.
 */
export function buildConvergenceInput(opts: {
  base: string;
  delta: string;
  doc: string;
}): string {
  return [
    `## Delta under review (git diff ${opts.base}..HEAD)`,
    "",
    "```diff",
    opts.delta.trim(),
    "```",
    "",
    "## Full document (context only — verify the delta against it, do not re-review it)",
    "",
    opts.doc,
  ].join("\n");
}
