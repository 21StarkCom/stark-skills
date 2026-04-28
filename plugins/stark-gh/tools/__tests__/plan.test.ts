import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { writePlan, readPlan, validatePlan, type Plan } from "../lib/plan.ts";

const minimal: Plan = {
  schemaVersion: 1,
  createdAt: "2026-04-28T00:00:00Z",
  branch: "feat/1-x",
  baseBranch: "main",
  remote: "origin",
  baseOid: "base-sha",
  baseOidSource: "remote",
  repo: { host: "github.com", owner: "evinced", name: "x", nameWithOwner: "evinced/x" },
  stateFingerprint: {
    headOid: "a",
    indexHash: "b",
    worktreeHash: "c",
    worktreeContentHash: null,
    existingPrSha: null,
    baseOid: "base-sha",
    branch: "feat/1-x",
    repoNameWithOwner: "evinced/x",
  },
  tree: { dirty: false, dirtyFiles: { staged: [], unstaged: [], untracked: [] }, hasUpstream: false, unpushedCommits: 0 },
  existingPr: null,
  secretScan: { scanned: true, hits: [], allowedCommit: false, allowedToLlm: false, redactions: [] },
  candidateIssues: { preflight: [] },
  closesLines: { preflight: [] },
  refsLines: { preflight: [] },
  promptBudget: { estimatedInputTokens: 100, cap: 32000, summarized: false },
  untrustedInputs: {
    combinedStat: "",
    committedDiff: "",
    stagedDiff: "",
    unstagedDiff: null,
    untrackedFiles: null,
    diffTruncated: false,
    prTemplate: null,
    commitMessages: "",
    userBody: null,
  },
  userArgs: {
    title: null,
    body: null,
    bodyFile: null,
    commitMessage: null,
    commitMessageFile: null,
    base: null,
    reviewer: [],
    label: [],
    assignee: [],
    commitAll: false,
    fullContext: false,
    noWatch: false,
    draft: false,
    allowSecretCommit: false,
    allowSecretToLlm: false,
  },
  stage2: {
    needTitle: false,
    needBody: false,
    needCommitMessage: false,
    skip: true,
    outputs: { titleFile: null, bodyFile: null, commitMessageFile: null },
  },
  stage3: {
    action: "push-only",
    willCommit: false,
    commitStrategy: "staged-only",
    willPush: false,
    willEditTitle: false,
    willEditBody: false,
    willAddReviewers: [],
    willAddLabels: [],
    willAddAssignees: [],
  },
};

test("validatePlan accepts minimal plan", () => {
  validatePlan(minimal);
});

test("validatePlan rejects wrong schemaVersion", () => {
  assert.throws(() => validatePlan({ ...minimal, schemaVersion: 2 } as unknown as Plan));
});

test("validatePlan rejects missing baseOid", () => {
  const bad = { ...minimal } as Record<string, unknown>;
  delete bad.baseOid;
  assert.throws(() => validatePlan(bad), /baseOid/);
});

test("write/read round trip", () => {
  const tmpfile = `/tmp/plan-test-${Date.now()}.json`;
  try {
    writePlan(tmpfile, minimal);
    const round = readPlan(tmpfile);
    assert.deepEqual(round, minimal);
  } finally {
    fs.unlinkSync(tmpfile);
  }
});
