// Tests for review_cleanup_worktree. The runner is faked out so we can
// drive every reason path without touching a real git repo.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { cleanupWorktree, type Runner } from "./review_cleanup_worktree.ts";

function fakeRunner(opts: {
  worktreeExists?: boolean;
  unstagedDirty?: boolean;
  stagedDirty?: boolean;
  observedHead?: string;
  removeCalls?: string[];
}): Runner {
  return {
    git: (args, _cwd) => {
      if (args[0] === "diff" && args[1] === "--quiet") {
        if (opts.unstagedDirty) {
          const err: NodeJS.ErrnoException & { status?: number } = new Error(
            "unstaged",
          );
          err.status = 1;
          throw err;
        }
        return "";
      }
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") {
        if (opts.stagedDirty) {
          const err: NodeJS.ErrnoException & { status?: number } = new Error(
            "staged",
          );
          err.status = 1;
          throw err;
        }
        return "";
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") {
        return `${opts.observedHead ?? "deadbeef"}\n`;
      }
      throw new Error(`unmocked git: ${args.join(" ")}`);
    },
    worktreeRemove: (worktreePath) => {
      opts.removeCalls?.push(worktreePath);
      return "";
    },
    worktreeExists: () => opts.worktreeExists ?? true,
  };
}

test("cleanupWorktree returns no-such-worktree when path is gone", () => {
  const removeCalls: string[] = [];
  const runner = fakeRunner({ worktreeExists: false, removeCalls });
  const r = cleanupWorktree({
    worktreePath: "/tmp/gone",
    expectedHead: "x",
    runner,
  });
  assert.equal(r.removed, false);
  assert.equal(r.reason, "no-such-worktree");
  assert.equal(removeCalls.length, 0);
});

test("cleanupWorktree refuses to remove a worktree with unstaged changes", () => {
  const removeCalls: string[] = [];
  const runner = fakeRunner({ unstagedDirty: true, removeCalls });
  const r = cleanupWorktree({
    worktreePath: "/tmp/x",
    expectedHead: "deadbeef",
    runner,
  });
  assert.equal(r.removed, false);
  assert.equal(r.reason, "unstaged-changes");
  assert.equal(removeCalls.length, 0);
});

test("cleanupWorktree refuses to remove a worktree with staged changes", () => {
  const removeCalls: string[] = [];
  const runner = fakeRunner({ stagedDirty: true, removeCalls });
  const r = cleanupWorktree({
    worktreePath: "/tmp/x",
    expectedHead: "deadbeef",
    runner,
  });
  assert.equal(r.removed, false);
  assert.equal(r.reason, "staged-changes");
  assert.equal(removeCalls.length, 0);
});

test("cleanupWorktree refuses to remove a worktree whose HEAD has drifted", () => {
  // The drift case usually means a fix commit landed locally but was never
  // pushed — removing the worktree would silently destroy that work.
  const removeCalls: string[] = [];
  const runner = fakeRunner({
    observedHead: "moved-on",
    removeCalls,
  });
  const r = cleanupWorktree({
    worktreePath: "/tmp/x",
    expectedHead: "expected",
    runner,
  });
  assert.equal(r.removed, false);
  assert.equal(r.reason, "head-drift");
  assert.equal(r.observedHead, "moved-on");
  assert.equal(removeCalls.length, 0);
});

test("cleanupWorktree removes a clean worktree at the expected HEAD", () => {
  const removeCalls: string[] = [];
  const runner = fakeRunner({
    observedHead: "deadbeef",
    removeCalls,
  });
  const r = cleanupWorktree({
    worktreePath: "/tmp/x",
    expectedHead: "deadbeef",
    runner,
  });
  assert.equal(r.removed, true);
  assert.equal(r.reason, "removed");
  assert.deepEqual(removeCalls, ["/tmp/x"]);
});
