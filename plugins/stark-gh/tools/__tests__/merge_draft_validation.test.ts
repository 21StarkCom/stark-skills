import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft, extractTicketPrefix } from "../lib/draft_schema.ts";

const ok = {
  subject: "feat: add pr-merge command",
  body: "Implements stark-gh:pr-merge per design spec.\n\nIncludes preflight, draft, execute.",
  changelog_bullet: "- pr-merge: rebase + changelog + watcher merge",
};

test("accepts valid draft", () => {
  const r = validateDraft(ok);
  assert.equal(r.ok, true);
});

test("rejects subject > 72 chars", () => {
  const r = validateDraft({ ...ok, subject: "x".repeat(73) });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /subject length 73 not in/);
});

test("rejects empty subject", () => {
  const r = validateDraft({ ...ok, subject: "" });
  assert.equal(r.ok, false);
});

test("rejects subject with newline", () => {
  const r = validateDraft({ ...ok, subject: "line1\nline2" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /must not contain newlines/);
});

test("rejects body > 16384 chars", () => {
  const r = validateDraft({ ...ok, body: "x".repeat(16385) });
  assert.equal(r.ok, false);
});

test("accepts body up to 16384 chars", () => {
  const r = validateDraft({ ...ok, body: "x".repeat(16384) });
  assert.equal(r.ok, true);
});

test("rejects bullet without dash-space prefix", () => {
  const r = validateDraft({ ...ok, changelog_bullet: "no dash" });
  assert.equal(r.ok, false);
});

test("rejects bullet with embedded newline", () => {
  const r = validateDraft({ ...ok, changelog_bullet: "- foo\nbar" });
  assert.equal(r.ok, false);
});

test("rejects bullet > 200 chars total", () => {
  const r = validateDraft({ ...ok, changelog_bullet: "- " + "x".repeat(199) });
  assert.equal(r.ok, false);
});

test("rejects 'Closes #N' anywhere", () => {
  for (const field of ["subject", "body", "changelog_bullet"] as const) {
    const draft = { ...ok };
    if (field === "subject") draft.subject = "feat closes #1";
    else if (field === "body") draft.body = "...\nCloses #42";
    else draft.changelog_bullet = "- thing closes #5";
    const r = validateDraft(draft);
    assert.equal(r.ok, false, `should reject ${field}`);
  }
});

test("rejects 'Refs #N' / 'Resolves #N' / 'Fixes #N'", () => {
  const variants = ["Refs #1", "refs #1", "resolves #2", "resolved #2", "fixes #3", "fixed #4", "fix #5"];
  for (const v of variants) {
    const r = validateDraft({ ...ok, body: `... ${v}` });
    assert.equal(r.ok, false, `should reject body containing ${v}`);
  }
});

test("rejects extra properties (additionalProperties: false)", () => {
  const r = validateDraft({ ...ok, extra: "not allowed" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unknown key extra/);
});

test("rejects non-object input", () => {
  for (const v of [null, "string", 42, [1, 2], undefined]) {
    const r = validateDraft(v);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(v)}`);
  }
});

test("rejects missing required field", () => {
  const r = validateDraft({ subject: "x", body: "y" });   // no changelog_bullet
  assert.equal(r.ok, false);
});

// --- ticket-prefix inheritance (STARK-229) ---------------------------------

test("extractTicketPrefix: pulls type(TICKET-n) from a PR title", () => {
  assert.equal(
    extractTicketPrefix("feat(STARK-193): Human plane slice A — todo store and CLI"),
    "feat(STARK-193):",
  );
  assert.equal(extractTicketPrefix("  fix(STARK-7): trim leading space  "), "fix(STARK-7):");
  assert.equal(extractTicketPrefix("chore(EI-1234): jira-style key"), "chore(EI-1234):");
});

test("extractTicketPrefix: the breaking marker is not part of the prefix", () => {
  assert.equal(extractTicketPrefix("feat(STARK-193)!: breaking"), "feat(STARK-193):");
});

test("extractTicketPrefix: null when the title carries no ticket scope", () => {
  for (const t of [
    "feat: no scope",
    "feat(tools): non-ticket scope",
    "Add cool feature",
    "STARK-193: no type",
    "feat(STARK-abc): no number",
    "",
  ]) {
    assert.equal(extractTicketPrefix(t), null, `expected null for ${JSON.stringify(t)}`);
  }
});

test("extractTicketPrefix: ordinary word-digit scopes are not ticket keys", () => {
  // A merge-blocking requirement must never be minted from a scope that is
  // simply versioned or numbered — these repos have no ticket convention.
  for (const t of [
    "docs(adr-0007): record the caching decision",
    "feat(gpt-5): switch model",
    "chore(node-22): bump",
    "fix(utf-8): decode fix",
    "refactor(es-2015): x",
  ]) {
    assert.equal(extractTicketPrefix(t), null, `expected null for ${JSON.stringify(t)}`);
  }
});

test("extractTicketPrefix: a capitalized type mints no requirement (fail open)", () => {
  // The drafter emits lower-case types; requiring "Fix(STARK-7): " would be
  // unsatisfiable and would abort the merge over one character's case.
  assert.equal(extractTicketPrefix("Fix(STARK-7): correct the watcher backoff"), null);
});

test("requires the ticket prefix on the subject when one is given", () => {
  const r = validateDraft(ok, { requiredSubjectPrefix: "feat(STARK-193):" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /must start with the PR title's ticket prefix/);
});

test("accepts a subject that carries the required prefix", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193): add pr-merge command" },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, true);
});

test("rejects a prefix that is not followed by a space", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193):add pr-merge command" },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, false);
});

test("accepts a breaking-marker subject under a non-breaking title prefix", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193)!: swap the config resolver" },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, true);
});

test("rejects a doubled separator after the prefix", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193):  add the todo store" },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /single space/);
});

test("rejects a prefix echoed inside the summary", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193): feat(STARK-193): add the todo store" },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /repeated/);
});

test("rejects a prefix with an empty summary", () => {
  const r = validateDraft(
    { ...ok, subject: "feat(STARK-193): " },
    { requiredSubjectPrefix: "feat(STARK-193):" },
  );
  assert.equal(r.ok, false);
});

test("the required prefix does not eat the 72-char summary budget", () => {
  const prefix = "feat(STARK-193):";
  const subject = `${prefix} ${"x".repeat(72)}`;      // 72 chars of summary
  assert.equal(validateDraft({ ...ok, subject }, { requiredSubjectPrefix: prefix }).ok, true);
  const tooLong = `${prefix} ${"x".repeat(73)}`;
  const r = validateDraft({ ...ok, subject: tooLong }, { requiredSubjectPrefix: prefix });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /subject length \d+ not in \[1,89\]/);
});

test("rejects a different ticket number or type than the PR title's", () => {
  for (const subject of ["feat(STARK-194): wrong ticket", "fix(STARK-193): wrong type"]) {
    const r = validateDraft({ ...ok, subject }, { requiredSubjectPrefix: "feat(STARK-193):" });
    assert.equal(r.ok, false, `should reject ${subject}`);
  }
});

test("no prefix requirement when the option is absent or null", () => {
  assert.equal(validateDraft(ok).ok, true);
  assert.equal(validateDraft(ok, { requiredSubjectPrefix: null }).ok, true);
});
