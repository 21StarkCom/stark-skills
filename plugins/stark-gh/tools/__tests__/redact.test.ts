import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../lib/redact.ts";

test("redacts AWS access key in place", () => {
  const r = redactSecrets("foo AKIAIOSFODNN7EXAMPLE bar");
  assert.match(r.text, /<<REDACTED:aws-access-key>>/);
  assert.equal(r.spans.length, 1);
  assert.equal(r.spans[0]!.category, "aws-access-key");
});

test("redacts multiple categories in one pass", () => {
  const r = redactSecrets("AKIAIOSFODNN7EXAMPLE\nghp_" + "a".repeat(36));
  assert.equal(r.spans.length, 2);
  assert.match(r.text, /<<REDACTED:aws-access-key>>/);
  assert.match(r.text, /<<REDACTED:github-token>>/);
});

test("clean text returns no spans", () => {
  const r = redactSecrets("nothing to see here");
  assert.equal(r.spans.length, 0);
  assert.equal(r.text, "nothing to see here");
});
