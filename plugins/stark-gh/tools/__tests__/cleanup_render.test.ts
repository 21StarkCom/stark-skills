import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlan, renderReceipt, parseRawArgs } from "../gh_cleanup.ts";
import type { CleanupPlan, ExecuteReceipt } from "../gh_cleanup.ts";

const repo = {
  host: "github.com",
  owner: "starks",
  name: "winterfell",
  nameWithOwner: "starks/winterfell",
  defaultBranch: "main",
  currentBranch: "feat/dragon",
};

function plan(overrides: Partial<CleanupPlan> = {}): CleanupPlan {
  return {
    repo,
    protectedBranches: ["main", "feat/dragon"],
    fetchPruned: true,
    rebase: { skipped: false },
    configChanges: [],
    localBranches: [],
    remoteBranches: [],
    worktrees: [],
    watcherDirs: [],
    staleStashes: [],
    gc: { willRun: false, looseObjects: 0 },
    notes: [],
    ...overrides,
  };
}

test("renderPlan: empty plan reads as 'nothing to do'", () => {
  const out = renderPlan(plan(), parseRawArgs(""));
  assert.match(out, /starks\/winterfell/);
  assert.match(out, /Local branches to delete \(0\)/);
  assert.match(out, /Remote branches to delete \(0\)/);
  assert.match(out, /fetched \+ pruned/);
});

test("renderPlan: --dry-run emits DRY RUN banner", () => {
  const out = renderPlan(plan(), parseRawArgs("--dry-run"));
  assert.match(out, /DRY RUN/);
});

test("renderPlan: shows merged-PR branches with PR number, no UNMERGED tag", () => {
  const p = plan({
    localBranches: [
      { name: "feat/A", reason: "merged-pr", prNumber: 42, safeDelete: true },
      // merged-pr + safeDelete=false (squash-merge case) still must NOT carry [UNMERGED]
      { name: "feat/B", reason: "merged-pr", prNumber: 43, safeDelete: false },
    ],
    remoteBranches: [{ name: "feat/A", reason: "merged-pr", prNumber: 42 }],
  });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /feat\/A.*PR #42/);
  assert.match(out, /feat\/B.*PR #43/);
  assert.doesNotMatch(out, /\[UNMERGED\]/);
  assert.match(out, /origin\/feat\/A.*PR #42/);
});

test("renderPlan: shows [UNMERGED] only for non-merged-pr reasons", () => {
  const p = plan({
    localBranches: [
      { name: "feat/dead", reason: "gone-upstream", safeDelete: false },
    ],
  });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /feat\/dead.*\[UNMERGED\]/);
});

test("renderPlan: shows worktree and watcher dirs", () => {
  const p = plan({
    worktrees: [{ path: "/tmp/review-x", branch: "feat/A", reason: "branch-deleted" }],
    watcherDirs: [{ path: "/x/pr-7", prNumber: 7, state: "MERGED" }],
  });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /\/tmp\/review-x.*branch-deleted/);
  assert.match(out, /\/x\/pr-7.*PR #7 MERGED/);
});

test("renderPlan: notes section renders when present", () => {
  const p = plan({ notes: ["unmerged commits on 3 branches"] });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /Notes:/);
  assert.match(out, /unmerged commits on 3 branches/);
});

test("renderReceipt: summarises counts and surfaces errors", () => {
  const r: ExecuteReceipt = {
    configApplied: [{ key: "pull.rebase", value: "true" }],
    rebased: true,
    localBranchesDeleted: ["feat/A", "feat/B"],
    localBranchesSkipped: [{ name: "feat/C", reason: "unmerged" }],
    remoteBranchesDeleted: ["feat/A"],
    remoteBranchesFailed: [],
    worktreesRemoved: ["/tmp/wt1"],
    worktreesFailed: [],
    watcherDirsRemoved: ["/x/pr-7"],
    stashesDropped: ["stash@{0}"],
    gcRan: true,
    errors: ["fs error"],
  };
  const out = renderReceipt(r);
  assert.match(out, /local branches deleted: 2/);
  assert.match(out, /local branches skipped: 1/);
  assert.match(out, /feat\/C: unmerged/);
  assert.match(out, /remote branches deleted: 1/);
  assert.match(out, /worktrees removed: 1/);
  assert.match(out, /watcher state dirs removed: 1/);
  assert.match(out, /stale stashes dropped: 1/);
  assert.match(out, /git gc: done/);
  assert.match(out, /errors: 1/);
  assert.match(out, /fs error/);
});

test("renderPlan: stale stashes surface with drop hint", () => {
  const p = plan({
    staleStashes: [
      { ref: "stash@{0}", baseBranch: "feat/dead", message: "On feat/dead: WIP" },
    ],
  });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /Stale stashes.*--drop-stale-stashes/);
  assert.match(out, /stash@\{0\}.*feat\/dead.*is gone/);
});

test("renderPlan: review-merged worktree shows PR number", () => {
  const p = plan({
    worktrees: [{ path: "/tmp/review-x-pr9-single", branch: null, reason: "review-merged", prNumber: 9 }],
    gc: { willRun: true, looseObjects: 120 },
  });
  const out = renderPlan(p, parseRawArgs(""));
  assert.match(out, /review-merged.*PR #9/);
  assert.match(out, /git gc: will run \(120 loose objects\)/);
});
