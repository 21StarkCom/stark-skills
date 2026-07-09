// Tests for stark_handover_lib.ts — the /stark-handover storage engine.
//
// Covers the deterministic core: slug sanitization (path-traversal safe),
// git-context derivation (main checkout vs linked worktree vs non-git),
// root resolution precedence, seq numbering, save round-trips (atomic
// writes + frontmatter + chain links), task picking by recency, and the
// resume payload.

import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chainFiles,
  deriveGitContext,
  listTasks,
  nextSeq,
  pickTask,
  resolveRoot,
  resumePayload,
  sanitizeSlug,
  saveHandover,
  taskDirFor,
  type GitContext,
} from "./stark_handover_lib.ts";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stark-handover-test-"));
}

const CTX: GitContext = {
  isGit: true,
  project: "stark-skills",
  worktree: "stark-handover",
  branch: "worktree-stark-handover",
  head: "abc1234",
};

// ---------------------------------------------------------------------------
// sanitizeSlug
// ---------------------------------------------------------------------------

test("sanitizeSlug: kebab-cases free text", () => {
  assert.equal(sanitizeSlug("Fix Auth Bug!"), "fix-auth-bug");
  assert.equal(sanitizeSlug("feature/foo_bar"), "feature-foo-bar");
});

test("sanitizeSlug: strips path traversal", () => {
  assert.equal(sanitizeSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeSlug("..".repeat(5)), "task");
});

test("sanitizeSlug: empty input falls back to 'task'", () => {
  assert.equal(sanitizeSlug(""), "task");
  assert.equal(sanitizeSlug("  ---  "), "task");
});

test("sanitizeSlug: caps length at 60", () => {
  const long = "a".repeat(200);
  assert.ok(sanitizeSlug(long).length <= 60);
});

// ---------------------------------------------------------------------------
// resolveRoot
// ---------------------------------------------------------------------------

test("resolveRoot: STARK_HANDOVER_ROOT env wins", () => {
  const root = resolveRoot({
    env: { STARK_HANDOVER_ROOT: "/custom/root" },
    home: "/home/u",
    configRoot: "~/Code/Handovers",
  });
  assert.equal(root, "/custom/root");
});

test("resolveRoot: config root expands ~ against home", () => {
  const root = resolveRoot({
    env: {},
    home: "/home/u",
    configRoot: "~/Code/Handovers",
  });
  assert.equal(root, path.join("/home/u", "Code", "Handovers"));
});

test("resolveRoot: absolute config root passes through", () => {
  const root = resolveRoot({ env: {}, home: "/home/u", configRoot: "/x/y" });
  assert.equal(root, "/x/y");
});

// ---------------------------------------------------------------------------
// deriveGitContext
// ---------------------------------------------------------------------------

type FakeGit = Record<string, string | null>;

function fakeRunGit(answers: FakeGit) {
  return (args: string[]): string | null => answers[args.join(" ")] ?? null;
}

test("deriveGitContext: linked worktree → project from common dir, worktree from toplevel basename", () => {
  const ctx = deriveGitContext({
    cwd: "/a/b/repo/.claude/worktrees/wt-x/sub",
    runGit: fakeRunGit({
      "rev-parse --is-inside-work-tree": "true",
      "rev-parse --show-toplevel": "/a/b/repo/.claude/worktrees/wt-x",
      "rev-parse --git-common-dir": "/a/b/repo/.git",
      "rev-parse --git-dir": "/a/b/repo/.git/worktrees/wt-x",
      "branch --show-current": "worktree-x",
      "rev-parse --short HEAD": "abc1234",
    }),
  });
  assert.deepEqual(ctx, {
    isGit: true,
    project: "repo",
    worktree: "wt-x",
    branch: "worktree-x",
    head: "abc1234",
  });
});

test("deriveGitContext: main checkout → worktree is the branch, relative common dir resolves", () => {
  const ctx = deriveGitContext({
    cwd: "/a/b/repo",
    runGit: fakeRunGit({
      "rev-parse --is-inside-work-tree": "true",
      "rev-parse --show-toplevel": "/a/b/repo",
      "rev-parse --git-common-dir": ".git",
      "rev-parse --git-dir": ".git",
      "branch --show-current": "main",
      "rev-parse --short HEAD": "def5678",
    }),
  });
  assert.deepEqual(ctx, {
    isGit: true,
    project: "repo",
    worktree: "main",
    branch: "main",
    head: "def5678",
  });
});

test("deriveGitContext: detached HEAD on main checkout → worktree 'detached'", () => {
  const ctx = deriveGitContext({
    cwd: "/a/b/repo",
    runGit: fakeRunGit({
      "rev-parse --is-inside-work-tree": "true",
      "rev-parse --show-toplevel": "/a/b/repo",
      "rev-parse --git-common-dir": ".git",
      "rev-parse --git-dir": ".git",
      "branch --show-current": "",
      "rev-parse --short HEAD": "def5678",
    }),
  });
  assert.equal(ctx.worktree, "detached");
  assert.equal(ctx.branch, null);
});

test("deriveGitContext: non-git dir → cwd basename + 'no-git'", () => {
  const ctx = deriveGitContext({
    cwd: "/some/plain/dir",
    runGit: fakeRunGit({}),
  });
  assert.deepEqual(ctx, {
    isGit: false,
    project: "dir",
    worktree: "no-git",
    branch: null,
    head: null,
  });
});

// ---------------------------------------------------------------------------
// nextSeq + chainFiles
// ---------------------------------------------------------------------------

test("nextSeq: missing dir → 1; chainFiles → []", () => {
  const dir = path.join(tmpRoot(), "nope");
  assert.equal(nextSeq(dir), 1);
  assert.deepEqual(chainFiles(dir), []);
});

test("nextSeq/chainFiles: counts only handover_N.md, gaps keep max+1", () => {
  const dir = tmpRoot();
  for (const f of ["handover_1.md", "handover_2.md", "PROGRESS.md", "handover_x.md", "notes.md"]) {
    fs.writeFileSync(path.join(dir, f), "x");
  }
  assert.deepEqual(
    chainFiles(dir).map((c) => c.seq),
    [1, 2],
  );
  assert.equal(nextSeq(dir), 3);

  const gappy = tmpRoot();
  fs.writeFileSync(path.join(gappy, "handover_5.md"), "x");
  assert.equal(nextSeq(gappy), 6);
});

// ---------------------------------------------------------------------------
// saveHandover
// ---------------------------------------------------------------------------

test("saveHandover: first save creates chain + PROGRESS.md with frontmatter", () => {
  const root = tmpRoot();
  const res = saveHandover({
    root,
    ctx: CTX,
    task: "Fix Auth!",
    body: "## The Goal\nShip it.\n",
    progress: "# Progress\n- [ ] step one\n",
    nowIso: () => "2026-07-08T10:00:00Z",
  });

  assert.equal(res.seq, 1);
  assert.equal(res.task, "fix-auth");
  assert.equal(res.dir, taskDirFor(root, CTX, "fix-auth"));
  assert.ok(res.handoverPath.endsWith("handover_1.md"));

  const content = fs.readFileSync(res.handoverPath, "utf8");
  assert.ok(content.startsWith("---\n"), "frontmatter present");
  assert.match(content, /task: fix-auth/);
  assert.match(content, /seq: 1/);
  assert.match(content, /project: stark-skills/);
  assert.match(content, /worktree: stark-handover/);
  assert.match(content, /branch: worktree-stark-handover/);
  assert.match(content, /head: abc1234/);
  assert.match(content, /created: 2026-07-08T10:00:00Z/);
  assert.match(content, /prev: none/);
  assert.ok(content.includes("## The Goal"), "body appended");

  assert.ok(res.progressPath);
  assert.equal(fs.readFileSync(res.progressPath!, "utf8"), "# Progress\n- [ ] step one\n");
});

test("saveHandover: stores task directory and artifacts with private modes", () => {
  const root = tmpRoot();
  const res = saveHandover({ root, ctx: CTX, task: "private", body: "body", progress: "progress" });

  assert.equal(fs.statSync(res.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(res.handoverPath).mode & 0o777, 0o600);
  assert.ok(res.progressPath);
  assert.equal(fs.statSync(res.progressPath!).mode & 0o777, 0o600);
});

test("saveHandover: redacts likely secrets before persisting", () => {
  const root = tmpRoot();
  const res = saveHandover({
    root,
    ctx: CTX,
    task: "redact",
    body: "token: abcdefghijklmnop\nkeep: value\n",
    progress: "password = supersecretvalue\n",
  });

  const handover = fs.readFileSync(res.handoverPath, "utf8");
  assert.ok(handover.includes("token: [REDACTED]"));
  assert.ok(!handover.includes("abcdefghijklmnop"));
  assert.equal(fs.readFileSync(res.progressPath!, "utf8"), "password = [REDACTED]\n");
  assert.deepEqual(res.warnings, ["possible secret value redacted"]);
});

test("saveHandover: second save increments seq and links prev; progress replaced", () => {
  const root = tmpRoot();
  const first = saveHandover({
    root,
    ctx: CTX,
    task: "fix-auth",
    body: "one",
    progress: "p1",
    nowIso: () => "2026-07-08T10:00:00Z",
  });
  const second = saveHandover({
    root,
    ctx: CTX,
    task: "fix-auth",
    body: "two",
    progress: "p2",
    nowIso: () => "2026-07-08T11:00:00Z",
  });

  assert.equal(second.seq, 2);
  const content = fs.readFileSync(second.handoverPath, "utf8");
  assert.match(content, /prev: handover_1\.md/);
  assert.equal(fs.readFileSync(first.progressPath!, "utf8"), "p2");
});

test("saveHandover: without progress leaves PROGRESS.md untouched", () => {
  const root = tmpRoot();
  saveHandover({ root, ctx: CTX, task: "t", body: "one", progress: "keep me" });
  const res = saveHandover({ root, ctx: CTX, task: "t", body: "two" });
  assert.equal(res.progressPath, null);
  assert.equal(
    fs.readFileSync(path.join(res.dir, "PROGRESS.md"), "utf8"),
    "keep me",
  );
});

// ---------------------------------------------------------------------------
// listTasks + pickTask
// ---------------------------------------------------------------------------

function touch(dir: string, when: Date): void {
  for (const f of fs.readdirSync(dir)) {
    fs.utimesSync(path.join(dir, f), when, when);
  }
  fs.utimesSync(dir, when, when);
}

test("listTasks: sorted newest-first; pickTask defaults to newest", () => {
  const root = tmpRoot();
  saveHandover({ root, ctx: CTX, task: "older", body: "x" });
  saveHandover({ root, ctx: CTX, task: "newer", body: "y" });
  touch(taskDirFor(root, CTX, "older"), new Date("2026-07-01T00:00:00Z"));
  touch(taskDirFor(root, CTX, "newer"), new Date("2026-07-08T00:00:00Z"));

  const tasks = listTasks(root, CTX);
  assert.deepEqual(
    tasks.map((t) => t.task),
    ["newer", "older"],
  );
  assert.equal(tasks[0].latestSeq, 1);

  assert.equal(pickTask(root, CTX), "newer");
  assert.equal(pickTask(root, CTX, "older"), "older");
  assert.equal(pickTask(root, CTX, "missing"), null);
});

test("listTasks: empty/missing root → []", () => {
  const root = path.join(tmpRoot(), "void");
  assert.deepEqual(listTasks(root, CTX), []);
  assert.equal(pickTask(root, CTX), null);
});

test("listTasks: non-directory storage path surfaces filesystem errors", () => {
  const root = tmpRoot();
  const base = path.join(root, CTX.project, CTX.worktree);
  fs.mkdirSync(path.dirname(base), { recursive: true });
  fs.writeFileSync(base, "not a directory");
  assert.throws(() => listTasks(root, CTX), /ENOTDIR/);
});

// ---------------------------------------------------------------------------
// resumePayload
// ---------------------------------------------------------------------------

test("resumePayload: returns latest handover + progress + chain", () => {
  const root = tmpRoot();
  saveHandover({ root, ctx: CTX, task: "fix-auth", body: "round one", progress: "p1" });
  saveHandover({ root, ctx: CTX, task: "fix-auth", body: "round two", progress: "p2" });

  const payload = resumePayload({ root, ctx: CTX });
  assert.ok(payload);
  assert.equal(payload!.task, "fix-auth");
  assert.equal(payload!.seq, 2);
  assert.ok(payload!.handoverPath.endsWith("handover_2.md"));
  assert.ok(payload!.handoverContent.includes("round two"));
  assert.equal(payload!.progressContent, "p2");
  assert.deepEqual(
    payload!.chain.map((c) => c.seq),
    [1, 2],
  );
  assert.deepEqual(payload!.taskSlugs, ["fix-auth"]);
});

test("resumePayload: explicit task + missing progress tolerated", () => {
  const root = tmpRoot();
  saveHandover({ root, ctx: CTX, task: "a", body: "task a" });
  saveHandover({ root, ctx: CTX, task: "b", body: "task b" });

  const payload = resumePayload({ root, ctx: CTX, task: "a" });
  assert.ok(payload);
  assert.equal(payload!.task, "a");
  assert.ok(payload!.handoverContent.includes("task a"));
  assert.equal(payload!.progressContent, null);
});

test("resumePayload: nothing saved → null", () => {
  const root = tmpRoot();
  assert.equal(resumePayload({ root, ctx: CTX }), null);
});
