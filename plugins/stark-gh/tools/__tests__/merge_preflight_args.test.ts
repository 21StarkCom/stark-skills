import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawArgs, inferSection, workingTreeBlocker } from "../gh_pr_merge_preflight.ts";

test("parseRawArgs: defaults", () => {
  const a = parseRawArgs("");
  assert.equal(a.pr, null);
  assert.equal(a.changelogSection, null);
  assert.equal(a.force, false);
  assert.equal(a.forceReason, null);
  assert.equal(a.noWatch, false);
  assert.equal(a.watchTimeoutHours, 6);
  assert.equal(a.allowSecretCommit, false);
  assert.equal(a.allowSecretToLlm, false);
  assert.equal(a.allowNoRequiredChecks, false);
  // The STARK-357 skipped-required-check refusal has exactly one opt-out. If
  // this default ever flips, every merge silently accepts a SKIPPED required
  // check again — the #877 false-green.
  assert.equal(a.allowSkippedChecks, false);
});

test("bare integer sets pr", () => {
  const a = parseRawArgs("540");
  assert.equal(a.pr, 540);
});

test("bare integer + --pr conflicts", () => {
  assert.throws(() => parseRawArgs("540 --pr 541"), /--pr already set/);
  assert.throws(() => parseRawArgs("--pr 540 541"), /--pr already set/);
});

test("'0' rejected", () => {
  assert.throws(() => parseRawArgs("0"), /bare PR number must be a positive integer/);
});

test("'-5' rejected", () => {
  assert.throws(() => parseRawArgs("-5"), /bare PR number must be a positive integer|unknown flag/);
});

test("'abc' still rejected as unknown flag", () => {
  assert.throws(() => parseRawArgs("abc"), /unknown flag/);
});

test("parseRawArgs: --pr accepts positive integer", () => {
  const a = parseRawArgs("--pr 123");
  assert.equal(a.pr, 123);
});

test("parseRawArgs: --pr rejects 0 and negative", () => {
  assert.throws(() => parseRawArgs("--pr 0"), /positive integer/);
  assert.throws(() => parseRawArgs("--pr -1"), /positive integer/);
  assert.throws(() => parseRawArgs("--pr abc"), /positive integer/);
});

test("parseRawArgs: --changelog-section validates against allowed set", () => {
  for (const s of ["Added", "Changed", "Fixed", "Removed", "Deprecated", "Security"]) {
    const a = parseRawArgs(`--changelog-section ${s}`);
    assert.equal(a.changelogSection, s);
  }
  assert.throws(() => parseRawArgs("--changelog-section Bogus"), /invalid/);
});

test("parseRawArgs: --force requires --force-reason", () => {
  assert.throws(() => parseRawArgs("--force"), /requires --force-reason/);
  const a = parseRawArgs("--force --force-reason 'release-train hotfix'");
  assert.equal(a.force, true);
  assert.equal(a.forceReason, "release-train hotfix");
});

test("parseRawArgs: --watch-timeout positive number", () => {
  const a = parseRawArgs("--watch-timeout 12");
  assert.equal(a.watchTimeoutHours, 12);
  assert.throws(() => parseRawArgs("--watch-timeout 0"), /positive/);
  assert.throws(() => parseRawArgs("--watch-timeout -1"), /positive/);
});

test("parseRawArgs: secret + no-required + no-watch flags", () => {
  const a = parseRawArgs("--no-watch --allow-secret-commit --allow-secret-to-llm --allow-no-required-checks --allow-skipped-checks");
  assert.equal(a.noWatch, true);
  assert.equal(a.allowSecretCommit, true);
  assert.equal(a.allowSecretToLlm, true);
  assert.equal(a.allowNoRequiredChecks, true);
  assert.equal(a.allowSkippedChecks, true);
});

test("parseRawArgs: --allow-skipped-checks parses on its own", () => {
  assert.equal(parseRawArgs("--allow-skipped-checks").allowSkippedChecks, true);
});

test("parseRawArgs: rejects unknown flag", () => {
  assert.throws(() => parseRawArgs("--bogus"), /unknown flag/);
});

test("inferSection: bug/fix labels → Fixed", () => {
  assert.equal(inferSection([{ name: "bug" }]), "Fixed");
  assert.equal(inferSection([{ name: "fix" }]), "Fixed");
  assert.equal(inferSection([{ name: "Bug" }]), "Fixed");
  assert.equal(inferSection([{ name: "bug:high" }]), "Fixed");
  assert.equal(inferSection([{ name: "feature" }, { name: "fix" }]), "Fixed");
});

test("inferSection: default Added", () => {
  assert.equal(inferSection([]), "Added");
  assert.equal(inferSection([{ name: "feature" }]), "Added");
  assert.equal(inferSection([{ name: "documentation" }]), "Added");
});

test("inferSection: fix-type title → Fixed when no labels", () => {
  // The label-only version filed PR #882 (`fix(STARK-408): …`, zero labels)
  // under ### Added, which makes release_changelog recommend a minor bump for
  // a patch-only cycle.
  assert.equal(inferSection([], "fix(STARK-408): kill the pr-merge self-modifying gate"), "Fixed");
  assert.equal(inferSection([], "fix: stop the watcher lying"), "Fixed");
  assert.equal(inferSection([], "Fix(scope): capitalized type still counts"), "Fixed");
  assert.equal(inferSection([], "fix(scope)!: breaking fix"), "Fixed");
  assert.equal(inferSection([], "revert(STARK-1): back out the thing"), "Fixed");
});

test("inferSection: non-fix titles stay Added", () => {
  assert.equal(inferSection([], "feat(STARK-9): add a thing"), "Added");
  assert.equal(inferSection([], "chore: bump deps"), "Added");
  assert.equal(inferSection([], "prefix fix: not at the start"), "Added");
  assert.equal(inferSection([], "fixture(STARK-2): not a fix type"), "Added");
  assert.equal(inferSection([], ""), "Added");
});

test("inferSection: labels still win over the title", () => {
  assert.equal(inferSection([{ name: "bug" }], "feat(STARK-9): add a thing"), "Fixed");
});

test("workingTreeBlocker: clean tree returns null", () => {
  const r = workingTreeBlocker({ porcelain: "", gitDir: ".git", exists: () => false });
  assert.equal(r, null);
});

test("workingTreeBlocker: dirty porcelain", () => {
  const r = workingTreeBlocker({ porcelain: " M file.txt\n", gitDir: ".git", exists: () => false });
  assert.equal(r, "dirty-tree");
});

test("workingTreeBlocker: in-progress rebase", () => {
  const r = workingTreeBlocker({ porcelain: "", gitDir: ".git", exists: (p) => p === ".git/rebase-merge" });
  assert.equal(r, "rebase-merge");
});

test("workingTreeBlocker: in-progress cherry-pick", () => {
  const r = workingTreeBlocker({ porcelain: "", gitDir: ".git", exists: (p) => p === ".git/CHERRY_PICK_HEAD" });
  assert.equal(r, "CHERRY_PICK_HEAD");
});

test("workingTreeBlocker: in-progress merge", () => {
  const r = workingTreeBlocker({ porcelain: "", gitDir: ".git", exists: (p) => p === ".git/MERGE_HEAD" });
  assert.equal(r, "MERGE_HEAD");
});
