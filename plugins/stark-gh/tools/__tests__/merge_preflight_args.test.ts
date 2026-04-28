import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawArgs, inferSection, isSelfModifying, workingTreeBlocker } from "../gh_pr_merge_preflight.ts";

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
  const a = parseRawArgs("--no-watch --allow-secret-commit --allow-secret-to-llm --allow-no-required-checks");
  assert.equal(a.noWatch, true);
  assert.equal(a.allowSecretCommit, true);
  assert.equal(a.allowSecretToLlm, true);
  assert.equal(a.allowNoRequiredChecks, true);
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

test("isSelfModifying: catches plugins/stark-gh/** path", () => {
  const r = isSelfModifying([{ path: "plugins/stark-gh/tools/lib/secret.ts" }]);
  assert.equal(r.offending, "plugins/stark-gh/tools/lib/secret.ts");
});

test("isSelfModifying: catches scripts/** path", () => {
  const r = isSelfModifying([{ path: "scripts/preflight.py" }]);
  assert.equal(r.offending, "scripts/preflight.py");
});

test("isSelfModifying: catches every guarded prefix", () => {
  const guarded = ["plugins/stark-gh/", "scripts/", "tools/", "global/", "skill/", "standards/"];
  for (const prefix of guarded) {
    const r = isSelfModifying([{ path: prefix + "x.ts" }]);
    assert.equal(r.offending, prefix + "x.ts", `should match ${prefix}`);
  }
});

test("isSelfModifying: docs/ and root .md OK", () => {
  const r1 = isSelfModifying([{ path: "docs/x.md" }]);
  assert.equal(r1.offending, null);
  const r2 = isSelfModifying([{ path: "README.md" }]);
  assert.equal(r2.offending, null);
});

test("isSelfModifying: empty file list OK", () => {
  assert.equal(isSelfModifying([]).offending, null);
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
