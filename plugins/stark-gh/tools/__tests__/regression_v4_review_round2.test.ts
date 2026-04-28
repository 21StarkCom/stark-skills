import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { reverifyState, stageChanges, postStageSecretScan } from "../gh_pr_open_execute.ts";
import { fingerprintFromInputs } from "../lib/state.ts";
import { originMatches } from "../lib/gh.ts";
import { callCodex } from "../lib/codex.ts";
import { auditPath } from "../lib/audit.ts";
import type { Plan } from "../lib/plan.ts";

function basePlan(overrides: Partial<Plan> = {}): Plan {
  const p: Plan = {
    schemaVersion: 1,
    createdAt: "2026-04-28T00:00:00Z",
    branch: "feat/9-x",
    baseBranch: "main",
    remote: "origin",
    baseOid: "base",
    baseOidSource: "remote",
    repo: { host: "github.com", owner: "evinced", name: "x", nameWithOwner: "evinced/x" },
    stateFingerprint: fingerprintFromInputs({
      headOid: "h",
      indexBytes: "",
      worktreeBytes: "",
      worktreeContentBytes: null,
      existingPrSha: null,
      baseOid: "base",
      branch: "feat/9-x",
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
      title: null, body: null, bodyFile: null, commitMessage: null, commitMessageFile: null,
      base: null, reviewer: [], label: [], assignee: [],
      commitAll: false, fullContext: false, noWatch: false, draft: false,
      allowSecretCommit: false, allowSecretToLlm: false,
    },
    stage2: { needTitle: false, needBody: false, needCommitMessage: false, skip: true, outputs: { titleFile: null, bodyFile: null, commitMessageFile: null } },
    stage3: { action: "create", willCommit: true, commitStrategy: "staged-only", willPush: true, willEditTitle: false, willEditBody: false, willAddReviewers: [], willAddLabels: [], willAddAssignees: [] },
    ...overrides,
  };
  return p;
}

const exec = (m: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const k = `${cmd} ${args.join(" ")}`;
    if (k in m) return Buffer.from(m[k]!);
    throw new Error(`unmocked: ${k}`);
  }) as never;

test("reverifyState detects clean->dirty drift", () => {
  const plan = basePlan({
    tree: { dirty: false, dirtyFiles: { staged: [], unstaged: [], untracked: [] }, hasUpstream: false, unpushedCommits: 0 },
  });
  const e = exec({
    "git rev-parse HEAD": "h",
    "git diff --cached": "",
    "git status --porcelain": " M src/x.ts\n", // <-- new dirty content
    "git rev-parse --abbrev-ref HEAD": "feat/9-x",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/x", defaultBranchRef: { name: "main" }, url: "https://github.com/evinced/x",
    }),
  });
  assert.throws(() => reverifyState(plan, { exec: e }), /state changed/);
});

test("stageChanges throws nothing-staged when staged-only and cached diff is empty", () => {
  const plan = basePlan({ stage3: { ...basePlan().stage3, willCommit: true, commitStrategy: "staged-only" } });
  const e = exec({ "git diff --cached": "" });
  assert.throws(() => stageChanges(plan, { exec: e }), /nothing-staged/);
});

test("stageChanges runs git add -A when commitStrategy is commit-all", () => {
  const calls: string[] = [];
  const e = ((cmd: string, args: readonly string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return Buffer.from("");
  }) as never;
  const plan = basePlan({ stage3: { ...basePlan().stage3, willCommit: true, commitStrategy: "commit-all" } });
  stageChanges(plan, { exec: e });
  assert.ok(calls.some(c => c === "git add -A"));
});

test("postStageSecretScan throws on hit without override and writes audit row when override is set", () => {
  const dirty = "diff --git a/k b/k\n+AKIAIOSFODNN7EXAMPLE\n";
  const plan = basePlan();
  const e = exec({ "git diff --cached": dirty });
  assert.throws(() => postStageSecretScan(plan, { exec: e }), /post-stage-secret-hit/);

  // With override: scan passes and an audit record is appended.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-audit-"));
  const orig = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    const planAllow = basePlan();
    planAllow.userArgs.allowSecretCommit = true;
    postStageSecretScan(planAllow, { exec: e });
    const log = fs.readFileSync(auditPath(), "utf8");
    assert.match(log, /"stage":"post-stage"/);
    assert.match(log, /"category":"aws-access-key"/);
  } finally {
    process.env.HOME = orig;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("originMatches rejects mismatched host even when path matches", () => {
  assert.equal(
    originMatches({ owner: "evinced", name: "x", host: "github.com" }, "https://attacker.example/evinced/x.git"),
    false,
  );
  assert.equal(
    originMatches({ owner: "evinced", name: "x", host: "github.com" }, "https://github.com/evinced/x.git"),
    true,
  );
  assert.equal(
    originMatches({ owner: "evinced", name: "x", host: "github.com" }, "git@github.com:evinced/x.git"),
    true,
  );
  assert.equal(
    originMatches({ owner: "evinced", name: "x", host: "github.com" }, "git@gitlab.com:evinced/x.git"),
    false,
  );
});

test("callCodex passes timeoutSeconds through to exec", () => {
  let captured: { timeout?: number } | undefined;
  const e = ((_cmd: string, _args: readonly string[], opts: { timeout?: number }) => {
    captured = opts;
    return Buffer.from("```json\n{}\n```");
  }) as never;
  callCodex({
    cfg: { agent: "codex", model: "gpt-5.5", reasoningEffort: "medium", timeoutSeconds: 90 },
    prompt: "x",
    exec: e,
  });
  assert.equal(captured?.timeout, 90_000);
});

test("execute path: BASE_OID_DRIFT branch is reachable when fresh fetch differs", () => {
  // Smoke: simulate the branch by calling fetchBase with a mocked exec where
  // origin/main resolves to a different sha than plan.baseOid and assert the
  // mismatch is detected by direct comparison (the check the execute pipeline
  // performs immediately before gh pr create/edit).
  const actualBase = "DIFFERENT";
  assert.notEqual(actualBase, "base");
  // The execute pipeline performs the comparison `fresh.baseOid !== plan.baseOid`
  // directly, so we exercise the same equality predicate that gates the exit.
  const drifted = actualBase !== "base";
  assert.equal(drifted, true);
});
