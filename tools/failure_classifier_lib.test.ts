// Tests for `tools/failure_classifier_lib.ts` — the stderr → failure
// category classifier ported from `scripts/failure_classifier.py`.

import { strict as assert } from "node:assert";
import test from "node:test";

import { CATEGORIES, classify } from "./failure_classifier_lib.ts";

test("classify: empty stderr → UNCLASSIFIED at 0.5 confidence", () => {
  for (const input of ["", "   ", "\n\n  \t\n"]) {
    const r = classify(input);
    assert.equal(r.category, "UNCLASSIFIED");
    assert.equal(r.confidence, 0.5);
    assert.equal(r.pattern_id, null);
    assert.equal(r.recommended_action, "inspect stderr manually");
  }
});

test("classify: literal pattern match → confidence 1.0", () => {
  const r = classify("remote: HTTP 401 Unauthorized");
  assert.equal(r.category, "AUTH_STALE");
  assert.equal(r.confidence, 1.0);
  assert.equal(r.pattern_id, "auth-stale");
  assert.equal(r.recommended_action, "refresh GitHub App token");
});

test("classify: regex pattern match → confidence 0.7", () => {
  const r = classify("error: this is a type mismatch in the call");
  assert.equal(r.category, "TYPE_ERROR");
  assert.equal(r.confidence, 0.7);
  assert.equal(r.pattern_id, null);
});

test("classify: regex is case-insensitive (matches Python re.IGNORECASE)", () => {
  const r = classify("ALEMBIC head REVISION conflict detected");
  assert.equal(r.category, "MIGRATION_CONFLICT");
  assert.equal(r.confidence, 0.7);
});

test("classify: category priority — AUTH_STALE outranks SYNTAX_ERROR", () => {
  // Both an auth signal and a syntax signal present; AUTH_STALE is index 0.
  const r = classify("SyntaxError near here\nBad credentials returned");
  assert.equal(r.category, "AUTH_STALE");
});

test("classify: no recognized pattern → UNCLASSIFIED", () => {
  const r = classify("everything went perfectly fine, nothing to see");
  assert.equal(r.category, "UNCLASSIFIED");
  assert.equal(r.confidence, 0.5);
});

test("classify: TYPE_ERROR literal beats DEPENDENCY_MISMATCH regex by priority", () => {
  // "TypeError" (TYPE_ERROR, index 2) and "version conflict"
  // (DEPENDENCY_MISMATCH, index 5) both present — TYPE_ERROR wins.
  const r = classify("TypeError raised\nversion conflict in deps");
  assert.equal(r.category, "TYPE_ERROR");
  assert.equal(r.confidence, 1.0);
});

test("CATEGORIES: every category has a non-empty pattern list", () => {
  assert.ok(CATEGORIES.length > 0);
  for (const c of CATEGORIES) {
    assert.ok(c.patterns.length > 0, `${c.name} has no patterns`);
  }
});
