import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { restoreBranchFromPlan } from "../lib/restore_branch.ts";
import { writePrMergePlan, type PrMergePlan } from "../lib/plan.ts";

// Builds a minimal valid PrMergePlan with overridable fields. Tests pass an
// ExecFn shim to avoid touching real git.
function makePlan(overrides: Partial<PrMergePlan> = {}): PrMergePlan {
  return {
    command: "pr-merge",
    schemaVersion: 1,
    createdAt: "2026-04-28T00:00:00Z",
    runId: "test-run",
    pr: {
      number: 1,
      headRef: "feat/foo",
      baseRef: "main",
      url: "https://github.com/o/r/pull/1",
      nameWithOwner: "o/r",
      headRepositoryOwner: "o",
      headRepositoryName: "r",
      isCrossRepository: false,
    },
    baseOid: "base",
    originalHeadOid: "orig",
    rebasedHeadOid: "rebased",
    changelogCommitOid: null,
    pushedHeadOid: null,
    originalChangelogPath: "/nonexistent/changelog-pre-edit.md",
    changelog: {
      filePath: "/nonexistent/CHANGELOG.md",
      section: "Added",
      markerComment: "<!-- stark-gh:pr-merge pr=1 runId=test-run -->",
    },
    startingRef: "feat/foo",
    forceReason: null,
    stage2: { skip: true, subjectFile: null, bodyFile: null, changelogBulletFile: null, model: "gpt-5.5", reasoningEffort: "medium" },
    execute: { watch: true, force: false, watchTimeoutHours: 6, secretOverrides: { commit: false, toLlm: false }, allowNoRequiredChecks: false },
    ...overrides,
  };
}

interface ExecCall {
  cmd: string;
  args: string[];
}

function makeExec(responses: Record<string, string | { throw: string }>): { exec: any; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    const r = responses[key];
    if (r === undefined) return Buffer.from("");
    if (typeof r === "object" && "throw" in r) {
      throw new Error(r.throw);
    }
    return Buffer.from(r);
  };
  return { exec, calls };
}

test("restoreBranchFromPlan no-op when branch already at originalHeadOid and on startingRef", () => {
  const tmp = `/tmp/plan-restore-noop-${Date.now()}.json`;
  writePrMergePlan(tmp, makePlan());
  try {
    const { exec, calls } = makeExec({
      "git rev-parse refs/heads/feat/foo": "orig\n",
      "git symbolic-ref --short HEAD": "feat/foo\n",
    });
    const result = restoreBranchFromPlan(tmp, { exec });
    assert.equal(result.branchUpdated, false);
    assert.equal(result.checkedOut, false);
    assert.equal(result.changelogRestored, false);
    // Should NOT call update-ref or checkout when no-op.
    const updateRefCalled = calls.some(c => c.cmd === "git" && c.args[0] === "update-ref");
    const checkoutCalled = calls.some(c => c.cmd === "git" && c.args[0] === "checkout");
    assert.equal(updateRefCalled, false);
    assert.equal(checkoutCalled, false);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("restoreBranchFromPlan runs update-ref when branch advanced past originalHeadOid", () => {
  const tmp = `/tmp/plan-restore-update-${Date.now()}.json`;
  writePrMergePlan(tmp, makePlan({ startingRef: "main" }));
  try {
    const { exec, calls } = makeExec({
      "git rev-parse refs/heads/feat/foo": "rebased+changelog-sha\n",  // advanced past orig
      "git symbolic-ref --short HEAD": "main\n",
    });
    const result = restoreBranchFromPlan(tmp, { exec });
    assert.equal(result.branchUpdated, true);
    assert.equal(result.checkedOut, false);  // already on startingRef=main
    const updateRefCall = calls.find(c => c.args[0] === "update-ref");
    assert.ok(updateRefCall, "update-ref should be called");
    assert.deepEqual(updateRefCall!.args, ["update-ref", "refs/heads/feat/foo", "orig"]);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("restoreBranchFromPlan checks out startingRef when on different ref", () => {
  const tmp = `/tmp/plan-restore-checkout-${Date.now()}.json`;
  writePrMergePlan(tmp, makePlan({ startingRef: "main" }));
  try {
    const { exec, calls } = makeExec({
      "git rev-parse refs/heads/feat/foo": "orig\n",      // already at orig
      "git symbolic-ref --short HEAD": "feat/foo\n",      // on rebased branch, not startingRef
    });
    const result = restoreBranchFromPlan(tmp, { exec });
    assert.equal(result.branchUpdated, false);
    assert.equal(result.checkedOut, true);
    const checkoutCall = calls.find(c => c.args[0] === "checkout");
    assert.ok(checkoutCall);
    assert.deepEqual(checkoutCall!.args, ["checkout", "main"]);
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("restoreBranchFromPlan restores CHANGELOG.md from tempfile when content differs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-restore-"));
  const tempCl = path.join(dir, "pre-edit.md");
  const liveCl = path.join(dir, "CHANGELOG.md");
  fs.writeFileSync(tempCl, "ORIGINAL CONTENT\n");
  fs.writeFileSync(liveCl, "MUTATED CONTENT\n");

  const tmp = path.join(dir, "plan.json");
  writePrMergePlan(tmp, makePlan({
    originalChangelogPath: tempCl,
    changelog: {
      filePath: liveCl,
      section: "Added",
      markerComment: "<!-- stark-gh:pr-merge pr=1 runId=test-run -->",
    },
  }));

  const { exec } = makeExec({
    "git rev-parse refs/heads/feat/foo": "orig\n",
    "git symbolic-ref --short HEAD": "feat/foo\n",
  });
  const result = restoreBranchFromPlan(tmp, { exec });
  assert.equal(result.changelogRestored, true);
  assert.equal(fs.readFileSync(liveCl, "utf8"), "ORIGINAL CONTENT\n");

  fs.rmSync(dir, { recursive: true });
});

test("restoreBranchFromPlan no-op CHANGELOG when content is byte-identical", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-restore-eq-"));
  const tempCl = path.join(dir, "pre-edit.md");
  const liveCl = path.join(dir, "CHANGELOG.md");
  const content = "IDENTICAL\n";
  fs.writeFileSync(tempCl, content);
  fs.writeFileSync(liveCl, content);

  const tmp = path.join(dir, "plan.json");
  writePrMergePlan(tmp, makePlan({
    originalChangelogPath: tempCl,
    changelog: { filePath: liveCl, section: "Added", markerComment: "<!-- m -->" },
  }));

  const { exec } = makeExec({
    "git rev-parse refs/heads/feat/foo": "orig\n",
    "git symbolic-ref --short HEAD": "feat/foo\n",
  });
  const result = restoreBranchFromPlan(tmp, { exec });
  assert.equal(result.changelogRestored, false);

  fs.rmSync(dir, { recursive: true });
});

test("restoreBranchFromPlan tolerates rev-parse failure (fresh branch)", () => {
  const tmp = `/tmp/plan-restore-noref-${Date.now()}.json`;
  writePrMergePlan(tmp, makePlan());
  try {
    const { exec } = makeExec({
      "git rev-parse refs/heads/feat/foo": { throw: "unknown ref" },
      "git symbolic-ref --short HEAD": "feat/foo\n",
    });
    const result = restoreBranchFromPlan(tmp, { exec });
    assert.equal(result.branchUpdated, false);
    assert.ok(result.warnings.length > 0, "should emit a warning when rev-parse fails");
  } finally {
    fs.unlinkSync(tmp);
  }
});

test("restoreBranchFromPlan is idempotent (running twice yields same final state)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-restore-idem-"));
  const tempCl = path.join(dir, "pre-edit.md");
  const liveCl = path.join(dir, "CHANGELOG.md");
  fs.writeFileSync(tempCl, "ORIGINAL\n");
  fs.writeFileSync(liveCl, "ORIGINAL\n");

  const tmp = path.join(dir, "plan.json");
  writePrMergePlan(tmp, makePlan({
    originalChangelogPath: tempCl,
    changelog: { filePath: liveCl, section: "Added", markerComment: "<!-- m -->" },
  }));

  const { exec } = makeExec({
    "git rev-parse refs/heads/feat/foo": "orig\n",
    "git symbolic-ref --short HEAD": "feat/foo\n",
  });
  const r1 = restoreBranchFromPlan(tmp, { exec });
  const r2 = restoreBranchFromPlan(tmp, { exec });
  // Both runs should report the same (idempotent).
  assert.deepEqual(r1, r2);

  fs.rmSync(dir, { recursive: true });
});
