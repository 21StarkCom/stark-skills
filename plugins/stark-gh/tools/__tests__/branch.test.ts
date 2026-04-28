import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBranchName } from "../lib/branch.ts";

const ok = ["main", "feat/123-foo", "fix-bug", "user.name/x", "release-1.2.3"];
const bad = [
  "-leading-dash",
  "double..dot",
  "trailing.lock",
  "with space",
  "double//slash",
  "ref@{}",
  "with\x07bell",
];

for (const name of ok) {
  test(`valid: ${name}`, () => assert.equal(validateBranchName(name).ok, true));
}

for (const name of bad) {
  test(`invalid: ${JSON.stringify(name)}`, () => {
    const r = validateBranchName(name);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /\S/);
  });
}
