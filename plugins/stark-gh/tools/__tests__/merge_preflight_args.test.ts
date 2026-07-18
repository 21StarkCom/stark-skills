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

const SELF = "21StarkCom/stark-skills";

test("isSelfModifying: catches plugins/stark-gh/** path in the self repo", () => {
  const r = isSelfModifying([{ path: "plugins/stark-gh/tools/lib/secret.ts" }], SELF);
  assert.equal(r.offending, "plugins/stark-gh/tools/lib/secret.ts");
});

test("isSelfModifying: catches scripts/** path in the self repo", () => {
  const r = isSelfModifying([{ path: "scripts/preflight.py" }], SELF);
  assert.equal(r.offending, "scripts/preflight.py");
});

test("isSelfModifying: catches every guarded prefix in the self repo", () => {
  const guarded = ["plugins/stark-gh/", "scripts/", "tools/", "global/", "skill/", "standards/"];
  for (const prefix of guarded) {
    const r = isSelfModifying([{ path: prefix + "x.ts" }], SELF);
    assert.equal(r.offending, prefix + "x.ts", `should match ${prefix}`);
  }
});

test("isSelfModifying: guarded prefixes are inert in other repos", () => {
  // Regression: Atlas's tools/CLAUDE.md blocked a docs-only merge (guard
  // matched the generic tools/ prefix in a repo that is not stark-skills).
  const r1 = isSelfModifying([{ path: "tools/CLAUDE.md" }], "21StarkCom/Atlas");
  assert.equal(r1.offending, null);
  const r2 = isSelfModifying(
    [{ path: "scripts/deploy.sh" }, { path: "plugins/stark-gh/x.ts" }],
    "21StarkCom/some-other-repo",
  );
  assert.equal(r2.offending, null);
});

test("isSelfModifying: matches by repo name, not owner — survives org moves", () => {
  const r = isSelfModifying([{ path: "tools/x.ts" }], "GetEvinced/stark-skills");
  assert.equal(r.offending, "tools/x.ts");
});

test("isSelfModifying: docs/ and root .md OK in the self repo", () => {
  const r1 = isSelfModifying([{ path: "docs/x.md" }], SELF);
  assert.equal(r1.offending, null);
  const r2 = isSelfModifying([{ path: "README.md" }], SELF);
  assert.equal(r2.offending, null);
});

test("isSelfModifying: empty file list OK", () => {
  assert.equal(isSelfModifying([], SELF).offending, null);
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
