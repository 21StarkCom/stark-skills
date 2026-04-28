import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunbook, watcherStatePathForPlan } from "../gh_pr_merge_complete.ts";
import type { PrMergePlan } from "../lib/plan.ts";

const plan: PrMergePlan = {
  command: "pr-merge",
  schemaVersion: 1,
  createdAt: "2026-04-28T00:00:00Z",
  runId: "test-run",
  pr: {
    number: 7,
    headRef: "feat/x",
    baseRef: "main",
    url: "https://github.com/o/r/pull/7",
    nameWithOwner: "o/r",
    headRepositoryOwner: "o",
    headRepositoryName: "r",
    isCrossRepository: false,
  },
  baseOid: "base",
  originalHeadOid: "orig",
  rebasedHeadOid: "rebased",
  changelogCommitOid: "cl",
  pushedHeadOid: "pushed",
  originalChangelogPath: "/tmp/cl.md",
  changelog: { filePath: "/tmp/CL.md", section: "Added", markerComment: "<!-- m -->" },
  startingRef: "feat/x",
  forceReason: null,
  stage2: { skip: false, subjectFile: "/tmp/s", bodyFile: "/tmp/b", changelogBulletFile: "/tmp/bl", model: "gpt-5.5", reasoningEffort: "medium" },
  execute: { watch: true, force: false, watchTimeoutHours: 6, secretOverrides: { commit: false, toLlm: false }, allowNoRequiredChecks: false },
};

test("buildRunbook returns operator-actionable hints", () => {
  const r = buildRunbook(plan);
  assert.equal(r.remote_was_force_pushed, true);
  assert.equal(r.original_head_oid, "orig");
  assert.equal(r.current_remote_head_oid, "pushed");
  assert.equal(r.cleanup_command, "/stark-gh:cleanup --pr 7");
  // No raw shell commands with untrusted refs:
  assert.doesNotMatch(r.cleanup_command, /\$/);
  assert.doesNotMatch(r.cleanup_command, /;/);
});

test("buildRunbook handles missing pushedHeadOid", () => {
  const noPushed = { ...plan, pushedHeadOid: null };
  const r = buildRunbook(noPushed);
  assert.equal(r.current_remote_head_oid, "<unknown>");
});

test("watcherStatePathForPlan layout matches watcher-side computation", () => {
  const p = watcherStatePathForPlan(plan);
  // path includes owner / repo / pr-N / <pushedHeadOid>.json
  assert.match(p, /watchers\/github\.com\/o\/r\/pr-7\/pushed\.json$/);
});
