import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedBranch } from "../gh_cleanup.ts";

test("isProtectedBranch: explicit protected names match, others don't", () => {
  const prot = ["main", "feat/dragon"];
  assert.equal(isProtectedBranch("main", prot), true);
  assert.equal(isProtectedBranch("feat/dragon", prot), true);
  assert.equal(isProtectedBranch("feat/other", prot), false);
});

test("isProtectedBranch: release-please branches are ALWAYS protected", () => {
  // The reused release-please branch must never be swept, even with an empty
  // protected set — a branch->merged-PR lookup matches it to an OLD merged
  // release PR and would otherwise delete it out from under the LIVE release PR.
  assert.equal(isProtectedBranch("release-please--branches--main--components--tyr", []), true);
  assert.equal(isProtectedBranch("release-please--branches--main", []), true);
});

test("isProtectedBranch: prefix match is precise (double-dash convention only)", () => {
  // Not release-please-action branches — must stay sweepable.
  assert.equal(isProtectedBranch("feat/release-please-thing", []), false);
  assert.equal(isProtectedBranch("release-pleaser", []), false);
  assert.equal(isProtectedBranch("release-please-single-dash", []), false);
});
