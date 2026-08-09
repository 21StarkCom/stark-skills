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
//
// The scope must look like a TICKET KEY — an upper-case project key plus a
// number (STARK-229, EI-1234) — not merely "letters-digits". An ordinary
// conventional scope such as `adr-0007`, `node-22`, `gpt-5` or `utf-8` is NOT a
// ticket, and treating it as one would install a hard, merge-blocking subject
// requirement on repos that have no ticket convention at all. The type is
// lower-case only, per the same convention: an unrecognised shape yields no
// requirement (fail open) rather than a prefix the drafter cannot satisfy.
const TICKET_PREFIX_RE = /^([a-z]+)\(([A-Z][A-Z0-9]{1,9}-\d+)\)(!?):/;

// Returns the required subject prefix (e.g. "feat(STARK-193):") when the PR
// title carries a ticket-scoped conventional prefix, else null. Null means no
// requirement — stark-gh runs against repos with other title conventions, so an
// unrecognised title must not block the merge. The optional `!` breaking marker
// is deliberately NOT part of the returned prefix: it describes the change, not
// the ticket, and the subject is free to carry or omit it.
export function extractTicketPrefix(prTitle: string): string | null {
  const m = TICKET_PREFIX_RE.exec(prTitle.trim());
  if (!m) return null;
  return `${m[1]}(${m[2]}):`;
}

// Checks the subject against a required `type(TICKET-<n>):` prefix as a TOKEN,
// not as a literal string prefix: the subject's own `!` marker is allowed, but a
// doubled separator or an echoed prefix ("feat(X-1): feat(X-1): thing") is not —
// startsWith accepted both, and the malformed subject would land on main.
// Returns null when the subject is acceptable, else the rejection reason.
export function checkSubjectPrefix(subject: string, requiredPrefix: string): string | null {
  const bad = (why: string) =>
    `subject must start with the PR title's ticket prefix ${JSON.stringify(requiredPrefix + " ")} — ${why} (got ${JSON.stringify(subject)})`;
  const m = TICKET_PREFIX_RE.exec(subject);
  if (!m) return bad("no ticket prefix found");
  if (`${m[1]}(${m[2]}):` !== requiredPrefix) return bad("different type or ticket");
  const rest = subject.slice(m[0].length);
  if (!rest.startsWith(" ")) return bad("prefix must be followed by a single space");
  const summary = rest.slice(1);
  if (summary.length === 0 || summary.startsWith(" ")) {
    return bad("prefix must be followed by a single space and a non-empty summary");
  }
  if (TICKET_PREFIX_RE.test(summary)) return bad("prefix is repeated in the summary");
  return null;
}

// Budget the mandated prefix out of the subject length cap. Without this the
// two constraints collide inside driveDraft's 2-attempt budget: the model
// prepends the prefix on the retry, blows 72, and the merge aborts.
export const SUBJECT_MAX = 72;

export interface ValidateOptions {
  // When set, the subject must carry this exact `type(TICKET-<n>):` prefix,
  // followed by one space and a summary. The prefix does not count against
  // SUBJECT_MAX.
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

  const prefix = opts.requiredSubjectPrefix || null;
  const maxSubject = SUBJECT_MAX + (prefix ? prefix.length + 1 : 0);
  if (o.subject.length === 0 || o.subject.length > maxSubject) {
    return { ok: false, reason: `subject length ${o.subject.length} not in [1,${maxSubject}]` };
  }
  if (o.subject.includes("\n")) {
    return { ok: false, reason: "subject must not contain newlines" };
  }
  if (prefix) {
    const why = checkSubjectPrefix(o.subject, prefix);
    if (why) return { ok: false, reason: why };
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
