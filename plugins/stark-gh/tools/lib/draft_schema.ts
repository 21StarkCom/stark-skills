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

export interface ValidationOk { ok: true; value: CodexDraft }
export interface ValidationFail { ok: false; reason: string }
export type ValidationResult = ValidationOk | ValidationFail;

export function validateDraft(input: unknown): ValidationResult {
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
