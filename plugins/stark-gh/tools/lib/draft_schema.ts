// Lightweight schema validator for the Codex draft output. We don't pull a
// full JSON-Schema library; the constraints are simple enough to enforce
// directly. Mirrors plugins/stark-gh/tools/lib/draft_schema.json.

export interface CodexDraft {
  subject: string;
  body: string;
  changelog_bullet: string;
}

const ALLOWED_KEYS = new Set(["subject", "body", "changelog_bullet"]);
const BULLET_RE = /^- [^\n]{1,198}$/;

// Patterns rejected anywhere in any field (issue-linking is pr-open's job;
// the squash commit body should not gain new Closes/Refs lines).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bcloses\s+#\d+/i,
  /\bclosed\s+#\d+/i,
  /\bcloseses?\s+#\d+/i,
  /\bfix(?:es|ed)?\s+#\d+/i,
  /\bresolve[sd]?\s+#\d+/i,
  /\brefs?\s+#\d+/i,
];

// The `type(TICKET-<n>)` prefix convention. The squash subject must inherit it
// from the PR title, otherwise merged commits on main lose the ticket trail
// (the drafter writes the subject from the diff, and nothing else checks it
// since alfred's CI was deleted 2026-08-08).
const TITLE_PREFIX_RE = /^([a-zA-Z]+)\(([A-Za-z][A-Za-z0-9]*-\d+)\)(!?):/;

// Returns the required subject prefix (e.g. "feat(STARK-193):") when the PR
// title carries a ticket-scoped conventional prefix, else null. Null means no
// requirement — stark-gh runs against repos with other title conventions, so an
// unrecognised title must not block the merge.
export function extractTicketPrefix(prTitle: string): string | null {
  const m = TITLE_PREFIX_RE.exec(prTitle.trim());
  if (!m) return null;
  return `${m[1]}(${m[2]})${m[3]}:`;
}

export interface ValidateOptions {
  // When set, the subject must start with this exact prefix followed by a space.
  requiredSubjectPrefix?: string | null;
}

export interface ValidationOk { ok: true; value: CodexDraft }
export interface ValidationFail { ok: false; reason: string }
export type ValidationResult = ValidationOk | ValidationFail;

export function validateDraft(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "draft must be a JSON object" };
  }
  const o = input as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: `unknown key ${k}` };
  }
  if (typeof o.subject !== "string") return { ok: false, reason: "subject must be string" };
  if (typeof o.body !== "string") return { ok: false, reason: "body must be string" };
  if (typeof o.changelog_bullet !== "string") return { ok: false, reason: "changelog_bullet must be string" };

  if (o.subject.length === 0 || o.subject.length > 72) {
    return { ok: false, reason: `subject length ${o.subject.length} not in [1,72]` };
  }
  if (o.subject.includes("\n")) {
    return { ok: false, reason: "subject must not contain newlines" };
  }
  const prefix = opts.requiredSubjectPrefix;
  if (prefix && !o.subject.startsWith(prefix + " ")) {
    return {
      ok: false,
      reason: `subject must start with the PR title's ticket prefix ${JSON.stringify(prefix + " ")} (got ${JSON.stringify(o.subject)})`,
    };
  }
  if (o.body.length > 16384) {
    return { ok: false, reason: `body length ${o.body.length} > 16384` };
  }
  if (!BULLET_RE.test(o.changelog_bullet)) {
    return { ok: false, reason: `changelog_bullet must match /^- [^\\n]{1,198}$/` };
  }

  // Forbidden-pattern scan across all fields.
  for (const field of ["subject", "body", "changelog_bullet"] as const) {
    for (const re of FORBIDDEN_PATTERNS) {
      if (re.test(o[field] as string)) {
        return { ok: false, reason: `${field} contains forbidden pattern ${re}` };
      }
    }
  }

  return { ok: true, value: { subject: o.subject, body: o.body, changelog_bullet: o.changelog_bullet } };
}
