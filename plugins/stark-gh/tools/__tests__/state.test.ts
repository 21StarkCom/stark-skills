import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintFromInputs, fingerprintsMatch, diffFingerprints } from "../lib/state.ts";

const a = fingerprintFromInputs({
  headOid: "abc",
  indexBytes: "x",
  worktreeBytes: "y",
  existingPrSha: "p",
  branch: "b",
  repoNameWithOwner: "o/r",
});
const b = fingerprintFromInputs({
  headOid: "abc",
  indexBytes: "x",
  worktreeBytes: "y",
  existingPrSha: "p",
  branch: "b",
  repoNameWithOwner: "o/r",
});
const c = fingerprintFromInputs({
  headOid: "different",
  indexBytes: "x",
  worktreeBytes: "y",
  existingPrSha: "p",
  branch: "b",
  repoNameWithOwner: "o/r",
});

test("identical inputs produce equal fingerprints", () => {
  assert.deepEqual(a, b);
  assert.equal(fingerprintsMatch(a, b), true);
});

test("differing headOid produces differing fingerprint", () => {
  assert.notDeepEqual(a, c);
  assert.equal(fingerprintsMatch(a, c), false);
});

test("diffFingerprints reports field changes", () => {
  const d = diffFingerprints(a, c);
  assert.deepEqual(d.sort(), ["headOid"]);
});
