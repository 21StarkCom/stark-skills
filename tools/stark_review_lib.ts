import fs from "node:fs";
import path from "node:path";

export type Agent = "claude" | "codex" | "gemini";

export type Severity = "critical" | "high" | "medium" | "low";

export type Classification = "fix" | "false_positive" | "noise" | "ignored";

export type Finding = {
  id: string;
  domain: string;
  agent: Agent;
  severity: Severity;
  file: string | null;
  line: number | null;
  title: string;
  body: string;
  classification?: Classification;
  classification_reason?: string;
  extra?: Record<string, unknown>;
};

/**
 * Canonical finding-output contract prepended to every domain prompt at render
 * time. Reviewer agents are instructed to emit JSONL (one Finding per line).
 *
 * Field nullability is the contract: `file` and `line` MAY be null when a
 * finding is repository-wide; `classification` / `classification_reason` are
 * filled by the classifier stage and SHOULD be omitted at first emission;
 * `extra` is an open object for domain-specific metadata.
 */
export const FINDING_SCHEMA_PROMPT = `## Reviewer Output Contract (CANONICAL)

Emit findings as JSONL — one JSON object per line. Output ONLY the JSONL stream: no prose, no markdown fences, no surrounding array. If you have no findings, emit nothing (zero lines).

Each line MUST be a JSON object with these fields:

- \`id\` (string, required) — stable identifier for this finding within the run (e.g. a short slug or hash)
- \`domain\` (string, required) — the review domain slug (e.g. \`architecture\`, \`security\`)
- \`agent\` (string, required) — one of \`claude\`, \`codex\`, \`gemini\`
- \`severity\` (string, required) — one of \`critical\`, \`high\`, \`medium\`, \`low\`
- \`file\` (string | null, required) — repo-relative path, or \`null\` for repo-wide findings
- \`line\` (number | null, required) — 1-based line number, or \`null\` when not applicable
- \`title\` (string, required) — short, single-line summary
- \`body\` (string, required) — full explanation including evidence and recommended fix
- \`classification\` (string, optional) — one of \`fix\`, \`false_positive\`, \`noise\`, \`ignored\`. Omit at initial emission; the classifier stage fills it.
- \`classification_reason\` (string, optional) — one-sentence justification, paired with \`classification\`.
- \`extra\` (object, optional) — open-ended metadata for domain-specific fields.

Example line:

{"id":"sec-001","domain":"security","agent":"codex","severity":"high","file":"src/api/handler.ts","line":42,"title":"Unvalidated input forwarded to query builder","body":"The handler reads req.query.id and passes it directly to db.raw(...). Validate or parameterize.","extra":{}}

Do NOT emit a JSON array. Do NOT wrap output in code fences. Do NOT include any preamble or trailing commentary.
`;

const LEGACY_OUTPUT_PATTERNS: RegExp[] = [
  /\n##\s+Output\b[\s\S]*$/,
  /\nOutput a JSON array only:[\s\S]*$/,
  /\nOutput:\s*\n```json[\s\S]*$/,
  /\nIMPORTANT:\s*Output ONLY a raw JSON array[\s\S]*$/,
];

/**
 * Strip the trailing legacy output-contract section ("description"/"suggestion"
 * JSON-array shape) from a raw domain prompt. Returns the body without that
 * section. Idempotent: a prompt with no legacy section is returned unchanged.
 */
export function stripLegacyOutputSection(raw: string): string {
  let stripped = raw;
  for (const pat of LEGACY_OUTPUT_PATTERNS) {
    stripped = stripped.replace(pat, "");
  }
  return stripped.replace(/\s+$/u, "") + "\n";
}

/**
 * Render a per-domain prompt for the new TS pipeline.
 *
 * Reads the legacy NN-*.md source, strips its trailing JSON-array output
 * section, and appends FINDING_SCHEMA_PROMPT. Existing per-domain prompt files
 * remain unmodified on disk (the Python pipeline still parses them); the
 * normalization happens at render time only.
 */
export function renderDomainPrompt(rawPrompt: string): string {
  const body = stripLegacyOutputSection(rawPrompt);
  return body + "\n" + FINDING_SCHEMA_PROMPT;
}

/**
 * Convenience helper: load and render a domain prompt from disk.
 */
export function renderDomainPromptFile(filePath: string): string {
  const raw = fs.readFileSync(filePath, "utf8");
  return renderDomainPrompt(raw);
}

/**
 * Discover every per-agent NN-*.md domain prompt under <repoRoot>/global/prompts.
 * Returns absolute paths for parametrized testing.
 */
export function listDomainPromptFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const agents: Agent[] = ["claude", "codex", "gemini"];
  for (const agent of agents) {
    const dir = path.join(repoRoot, "global", "prompts", agent);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/^\d{2}-.+\.md$/.test(entry)) {
        out.push(path.join(dir, entry));
      }
    }
  }
  return out.sort();
}

const LEGACY_MARKERS: RegExp[] = [
  /"description"\s*:/,
  /"suggestion"\s*:/,
  /\bdescription\b.*\bsuggestion\b/i,
  /\[\{"severity"/,
];

/**
 * Returns the list of legacy markers still present in the rendered prompt.
 * Empty list = clean.
 */
export function findLegacyMarkers(rendered: string): string[] {
  const hits: string[] = [];
  for (const m of LEGACY_MARKERS) {
    if (m.test(rendered)) hits.push(m.source);
  }
  return hits;
}
