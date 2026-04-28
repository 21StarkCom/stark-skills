import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintFromInputs, fingerprintsMatch, diffFingerprints } from "../lib/state.ts";

const a = fingerprintFromInputs({
  headOid: "abc",
  indexBytes: "x",
  worktreeBytes: "y",
  worktreeContentBytes: null,
  existingPrSha: "p",
  baseOid: "base",
  branch: "b",
  repoNameWithOwner: "o/r",
});
const b = fingerprintFromInputs({
  headOid: "abc",
  indexBytes: "x",
  worktreeBytes: "y",
  worktreeContentBytes: null,
  existingPrSha: "p",
  baseOid: "base",
  branch: "b",
  repoNameWithOwner: "o/r",
});
const c = fingerprintFromInputs({
  headOid: "different",
  indexBytes: "x",
  worktreeBytes: "y",
  worktreeContentBytes: null,
  existingPrSha: "p",
  baseOid: "base",
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

test("worktreeContentBytes change is detected", () => {
  const x = fingerprintFromInputs({
    headOid: "h",
    indexBytes: "i",
    worktreeBytes: "w",
    worktreeContentBytes: "X",
    existingPrSha: null,
    baseOid: "b",
    branch: "br",
    repoNameWithOwner: "o/r",
  });
  const y = fingerprintFromInputs({
    headOid: "h",
    indexBytes: "i",
    worktreeBytes: "w",
    worktreeContentBytes: "Y",
    existingPrSha: null,
    baseOid: "b",
    branch: "br",
    repoNameWithOwner: "o/r",
  });
  assert.deepEqual(diffFingerprints(x, y), ["worktreeContentHash"]);
});

test("baseOid drift is detected", () => {
  const x = fingerprintFromInputs({
    headOid: "h",
    indexBytes: "i",
    worktreeBytes: "w",
    worktreeContentBytes: null,
    existingPrSha: null,
    baseOid: "B1",
    branch: "br",
    repoNameWithOwner: "o/r",
  });
  const y = fingerprintFromInputs({
    headOid: "h",
    indexBytes: "i",
    worktreeBytes: "w",
    worktreeContentBytes: null,
    existingPrSha: null,
    baseOid: "B2",
    branch: "br",
    repoNameWithOwner: "o/r",
  });
  assert.deepEqual(diffFingerprints(x, y), ["baseOid"]);
});
