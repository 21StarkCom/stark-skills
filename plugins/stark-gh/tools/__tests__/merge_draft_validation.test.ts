import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft } from "../lib/draft_schema.ts";

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
