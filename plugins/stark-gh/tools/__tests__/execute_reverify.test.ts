import { test } from "node:test";
import assert from "node:assert/strict";
import { reverifyState } from "../gh_pr_open_execute.ts";
import { fingerprintFromInputs } from "../lib/state.ts";
import type { Plan } from "../lib/plan.ts";

const plan: Plan = {
  schemaVersion: 1,
  createdAt: "2026-04-28T00:00:00Z",
  branch: "feat/1-x",
  baseBranch: "main",
  remote: "origin",
  baseOid: "base",
  baseOidSource: "remote",
  repo: { host: "github.com", owner: "evinced", name: "x", nameWithOwner: "evinced/x" },
  stateFingerprint: fingerprintFromInputs({
    headOid: "a",
    indexBytes: "",
    worktreeBytes: "",
    worktreeContentBytes: null,
    existingPrSha: null,
    baseOid: "base",
    branch: "feat/1-x",
    repoNameWithOwner: "evinced/x",
  }),
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
  stage2: { needTitle: false, needBody: false, needCommitMessage: false, skip: true, outputs: { titleFile: null, bodyFile: null, commitMessageFile: null } },
  stage3: { action: "push-only", willCommit: false, commitStrategy: "staged-only", willPush: false, willEditTitle: false, willEditBody: false, willAddReviewers: [], willAddLabels: [], willAddAssignees: [] },
};

const fakeExec = (m: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const k = `${cmd} ${args.join(" ")}`;
    if (k in m) return Buffer.from(m[k]!);
    throw new Error(`unmocked: ${k}`);
  }) as never;

test("reverifyState passes when fingerprints match", () => {
  const exec = fakeExec({
    "git rev-parse HEAD": "a",
    "git diff --cached": "",
    "git status --porcelain": "",
    "git rev-parse --abbrev-ref HEAD": "feat/1-x",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/x",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/x",
    }),
  });
  reverifyState(plan, { exec });
});

test("reverifyState throws on drift", () => {
  const exec = fakeExec({
    "git rev-parse HEAD": "DIFFERENT",
    "git diff --cached": "",
    "git status --porcelain": "",
    "git rev-parse --abbrev-ref HEAD": "feat/1-x",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/x",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/x",
    }),
  });
  assert.throws(() => reverifyState(plan, { exec }), /state changed/);
});
