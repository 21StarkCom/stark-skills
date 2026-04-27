// Tests for review_setup_worktree. The runner is faked out so we never touch
// real `gh` or `git` — we verify the contract we want, not whatever the local
// CLI happens to do.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  defaultWorktreePath,
  fetchPrMetadata,
  repoSlug,
  SetupError,
  setupWorktree,
  type Runner,
} from "./review_setup_worktree.ts";

function fakeRunner(opts: {
  ghJson?: Record<string, Record<string, unknown>>;
  ghOnCall?: (cmd: string[]) => string;
  gitOnCall?: (cmd: string[], cwd?: string) => string;
  worktreeExists?: boolean;
}): Runner {
  return {
    gh: (args) => {
      if (opts.ghOnCall) return opts.ghOnCall(args);
      const key = args.join(" ");
      const map = opts.ghJson ?? {};
      // Match by suffix so callers can register short keys like "pr view 42".
      for (const [k, v] of Object.entries(map)) {
        if (key.includes(k)) return JSON.stringify(v);
      }
      throw new Error(`unmocked gh call: ${key}`);
    },
    git: (args, cwd) => (opts.gitOnCall ? opts.gitOnCall(args, cwd) : ""),
    fileExists: () => true,
    worktreeExistsAt: () => opts.worktreeExists ?? false,
  };
}

// ── Pure helpers ────────────────────────────────────────────────

test("repoSlug lowercases and replaces slashes", () => {
  assert.equal(repoSlug("Evinced/Foo-Bar"), "evinced-foo-bar");
});

test("defaultWorktreePath embeds repo, pr, and mode", () => {
  assert.equal(
    defaultWorktreePath("Evinced/foo", 42, "single"),
    "/tmp/review-evinced-foo-pr42-single",
  );
});

// ── fetchPrMetadata ─────────────────────────────────────────────

test("fetchPrMetadata parses every field gh returns", () => {
  const runner = fakeRunner({
    ghJson: {
      "pr view": {
        number: 42,
        headRefName: "feat/x",
        headRefOid: "abc123",
        baseRefName: "main",
        isCrossRepository: true,
        maintainerCanModify: false,
      },
    },
  });
  const meta = fetchPrMetadata(42, "Evinced/foo", runner);
  assert.equal(meta.number, 42);
  assert.equal(meta.branch, "feat/x");
  assert.equal(meta.headSha, "abc123");
  assert.equal(meta.base, "main");
  assert.equal(meta.isFork, true);
  assert.equal(meta.maintainerCanModify, false);
});

test("fetchPrMetadata throws SetupError when gh returns non-JSON", () => {
  const runner: Runner = {
    gh: () => "not json",
    git: () => "",
    fileExists: () => true,
    worktreeExistsAt: () => false,
  };
  assert.throws(
    () => fetchPrMetadata(42, "Evinced/foo", runner),
    (err: unknown) => err instanceof SetupError && err.code === "gh-cli-failure",
  );
});

// ── setupWorktree (fresh path) ─────────────────────────────────

test("setupWorktree creates a fresh worktree and verifies HEAD", () => {
  const gitCalls: string[][] = [];
  const runner = fakeRunner({
    ghJson: {
      "repo view": { nameWithOwner: "Evinced/foo" },
      "pr view": {
        number: 42,
        headRefName: "feat/x",
        headRefOid: "deadbeef",
        baseRefName: "main",
        isCrossRepository: false,
        maintainerCanModify: true,
      },
    },
    gitOnCall: (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      return "";
    },
    worktreeExists: false,
  });
  const receipt = setupWorktree({ pr: 42, repo: "Evinced/foo", mode: "single", runner });
  assert.equal(receipt.reused, false);
  assert.equal(receipt.worktreePath, "/tmp/review-evinced-foo-pr42-single");
  assert.equal(receipt.pr.headSha, "deadbeef");
  // The fetch calls must precede `worktree add`.
  const fetchIdx = gitCalls.findIndex((c) => c[0] === "fetch" && c[2]?.startsWith("+main"));
  const worktreeIdx = gitCalls.findIndex((c) => c[0] === "worktree" && c[1] === "add");
  assert.ok(fetchIdx >= 0 && worktreeIdx >= 0 && fetchIdx < worktreeIdx);
});

test("setupWorktree fails fast when fresh HEAD doesn't match the PR", () => {
  const runner = fakeRunner({
    ghJson: {
      "repo view": { nameWithOwner: "Evinced/foo" },
      "pr view": {
        number: 42,
        headRefName: "feat/x",
        headRefOid: "expected",
        baseRefName: "main",
        isCrossRepository: false,
        maintainerCanModify: true,
      },
    },
    gitOnCall: (args) =>
      args[0] === "rev-parse" && args[1] === "HEAD" ? "different-sha\n" : "",
    worktreeExists: false,
  });
  assert.throws(
    () => setupWorktree({ pr: 42, repo: "Evinced/foo", mode: "single", runner }),
    (err: unknown) =>
      err instanceof SetupError && err.code === "worktree-head-mismatch",
  );
});

// ── setupWorktree (reuse path) ──────────────────────────────────

test("setupWorktree reuses a clean worktree at the right HEAD", () => {
  const runner = fakeRunner({
    ghJson: {
      "repo view": { nameWithOwner: "Evinced/foo" },
      "pr view": {
        number: 42,
        headRefName: "feat/x",
        headRefOid: "deadbeef",
        baseRefName: "main",
        isCrossRepository: false,
        maintainerCanModify: true,
      },
    },
    gitOnCall: (args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      return ""; // diff --quiet exits 0 for clean.
    },
    worktreeExists: true,
  });
  const receipt = setupWorktree({ pr: 42, repo: "Evinced/foo", mode: "single", runner });
  assert.equal(receipt.reused, true);
  assert.equal(receipt.pr.headSha, "deadbeef");
});

test("setupWorktree refuses to reuse a dirty worktree", () => {
  const runner: Runner = {
    gh: (args) => {
      const key = args.join(" ");
      if (key.includes("repo view")) return JSON.stringify({ nameWithOwner: "Evinced/foo" });
      if (key.includes("pr view"))
        return JSON.stringify({
          number: 42,
          headRefName: "feat/x",
          headRefOid: "deadbeef",
          baseRefName: "main",
          isCrossRepository: false,
          maintainerCanModify: true,
        });
      throw new Error(`unmocked gh: ${key}`);
    },
    git: (args) => {
      // Simulate `diff --quiet` exit 1 (dirty) by throwing a status-1 error.
      if (args[0] === "diff" && args[1] === "--quiet") {
        const err: NodeJS.ErrnoException & { status?: number } = new Error("dirty");
        err.status = 1;
        throw err;
      }
      if (args[0] === "rev-parse" && args[1] === "HEAD") return "deadbeef\n";
      return "";
    },
    fileExists: () => true,
    worktreeExistsAt: () => true,
  };
  assert.throws(
    () => setupWorktree({ pr: 42, repo: "Evinced/foo", mode: "single", runner }),
    (err: unknown) => err instanceof SetupError && err.code === "worktree-dirty",
  );
});

// ── repo mismatch ───────────────────────────────────────────────

test("setupWorktree refuses when the local checkout is a different repo", () => {
  const runner = fakeRunner({
    ghJson: {
      "repo view": { nameWithOwner: "Evinced/other" },
    },
  });
  assert.throws(
    () => setupWorktree({ pr: 42, repo: "Evinced/foo", mode: "single", runner }),
    (err: unknown) => err instanceof SetupError && err.code === "repo-mismatch",
  );
});

test("setupWorktree skips the repo check when --skip-repo-check is set", () => {
  const runner = fakeRunner({
    ghJson: {
      "pr view": {
        number: 42,
        headRefName: "feat/x",
        headRefOid: "deadbeef",
        baseRefName: "main",
        isCrossRepository: false,
        maintainerCanModify: true,
      },
    },
    gitOnCall: (args) =>
      args[0] === "rev-parse" && args[1] === "HEAD" ? "deadbeef\n" : "",
    worktreeExists: false,
  });
  // No "repo view" key registered — would throw if assertRepoMatches ran.
  const receipt = setupWorktree({
    pr: 42,
    repo: "Evinced/foo",
    mode: "single",
    skipRepoCheck: true,
    runner,
  });
  assert.equal(receipt.reused, false);
});
