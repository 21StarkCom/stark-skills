import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMergeOids } from "../lib/verify_oids.ts";
import type { PrMergePlan } from "../lib/plan.ts";

const basePlan: PrMergePlan = {
  command: "pr-merge",
  schemaVersion: 1,
  createdAt: "2026-04-28T00:00:00Z",
  runId: "run-1",
  pr: {
    number: 1,
    headRef: "feat/x",
    baseRef: "main",
    url: "https://github.com/o/r/pull/1",
    nameWithOwner: "o/r",
    headRepositoryOwner: "o",
    headRepositoryName: "r",
    isCrossRepository: false,
  },
  baseOid: "BASE_OK",
  originalHeadOid: "ORIG",
  rebasedHeadOid: "REB",
  changelogCommitOid: null,
  pushedHeadOid: "PUSHED_OK",
  originalChangelogPath: "/tmp/cl.md",
  changelog: { filePath: "CHANGELOG.md", section: "Added", markerComment: "<!-- m -->" },
  startingRef: "main",
  forceReason: null,
  stage2: { skip: false, subjectFile: null, bodyFile: null, changelogBulletFile: null, model: "gpt-5.5", reasoningEffort: "medium" },
  execute: { watch: true, force: false, watchTimeoutHours: 6, secretOverrides: { commit: false, toLlm: false }, allowNoRequiredChecks: false },
};

// Build a fake exec that matches argv prefixes (cmd + first few args), so we
// don't have to recreate the exact GraphQL query string in tests.
const fakeExecPrefix = (responses: { match: (cmd: string, args: readonly string[]) => string | null }[]) =>
  ((cmd: string, args: readonly string[]) => {
    for (const r of responses) {
      const v = r.match(cmd, args);
      if (v !== null) return Buffer.from(v);
    }
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;

test("verifyMergeOids ok when base and head match plan", async () => {
  const exec = fakeExecPrefix([
    {
      match: (c, a) => c === "git" && a[0] === "fetch" ? "" : null,
    },
    {
      match: (c, a) =>
        c === "git" && a[0] === "rev-parse" && a[1] === "refs/remotes/origin/main"
          ? "BASE_OK\n"
          : null,
    },
    {
      match: (c, a) =>
        c === "gh" && a[0] === "api" && a[1] === "graphql"
          ? JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "PUSHED_OK" } } } })
          : null,
    },
  ]);
  const r = await verifyMergeOids(basePlan, { exec });
  assert.deepEqual(r, { ok: true });
});

test("verifyMergeOids: base_moved when origin base SHA drifted", async () => {
  const exec = fakeExecPrefix([
    { match: (c, a) => c === "git" && a[0] === "fetch" ? "" : null },
    {
      match: (c, a) =>
        c === "git" && a[0] === "rev-parse" && a[1] === "refs/remotes/origin/main"
          ? "BASE_DRIFTED\n"
          : null,
    },
  ]);
  const r = await verifyMergeOids(basePlan, { exec });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "base_moved");
    assert.equal(r.expected, "BASE_OK");
    assert.equal(r.actual, "BASE_DRIFTED");
  }
});

test("verifyMergeOids: head_moved when GitHub head SHA differs from pushedHeadOid", async () => {
  const exec = fakeExecPrefix([
    { match: (c, a) => c === "git" && a[0] === "fetch" ? "" : null },
    {
      match: (c, a) =>
        c === "git" && a[0] === "rev-parse" && a[1] === "refs/remotes/origin/main"
          ? "BASE_OK\n"
          : null,
    },
    {
      match: (c, a) =>
        c === "gh" && a[0] === "api" && a[1] === "graphql"
          ? JSON.stringify({ data: { repository: { pullRequest: { headRefOid: "DIFFERENT_HEAD" } } } })
          : null,
    },
  ]);
  const r = await verifyMergeOids(basePlan, { exec });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.kind, "head_moved");
    assert.equal(r.expected, "PUSHED_OK");
    assert.equal(r.actual, "DIFFERENT_HEAD");
  }
});

test("verifyMergeOids: head_moved when pushedHeadOid is null (caller misuse)", async () => {
  const planNoPush = { ...basePlan, pushedHeadOid: null };
  const exec = fakeExecPrefix([
    { match: (c, a) => c === "git" && a[0] === "fetch" ? "" : null },
    {
      match: (c, a) =>
        c === "git" && a[0] === "rev-parse" && a[1] === "refs/remotes/origin/main"
          ? "BASE_OK\n"
          : null,
    },
  ]);
  const r = await verifyMergeOids(planNoPush, { exec });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.kind, "head_moved");
});
