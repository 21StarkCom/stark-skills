import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildPlan } from "../gh_pr_open_preflight.ts";
import { reverifyState, spawnWatcher } from "../gh_pr_open_execute.ts";
import { lockFile, ensurePrDir } from "../lib/watcher_paths.ts";

function withRepo(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-reg-"));
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-origin-"));
  const cwd = process.cwd();
  try {
    execFileSync("git", ["init", "--bare"], { cwd: origin });
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "README.md"), "x");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
    execFileSync("git", ["push", "origin", "main"], { cwd: dir });
    execFileSync("git", ["checkout", "-b", "feat/9-untracked"], { cwd: dir });
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
  }
}

const fakeRepoView = JSON.stringify({
  nameWithOwner: "evinced/x",
  defaultBranchRef: { name: "main" },
  url: "https://github.com/evinced/x",
});

const fakeExec = (m: Record<string, string>, fallthrough: (cmd: string, args: readonly string[]) => Buffer) =>
  ((cmd: string, args: readonly string[], opts: never) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in m) return Buffer.from(m[key]!);
    return fallthrough(cmd, args);
  }) as never;

function realGit(cmd: string, args: readonly string[]): Buffer {
  if (cmd !== "git") throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  return execFileSync("git", args as readonly string[]);
}

test("F-2: untracked file content is redacted when --allow-secret-commit alone", () => {
  withRepo(() => {
    fs.writeFileSync("secret.txt", "leaking AKIAIOSFODNN7EXAMPLE here\n");
    const exec = fakeExec(
      {
        "gh repo view --json nameWithOwner,defaultBranchRef,url": fakeRepoView,
        "gh pr list --head feat/9-untracked --state open --json number,url,title,body,headRefOid": "[]",
      },
      realGit,
    );
    const plan = buildPlan({ rawArgs: "--commit-all --allow-secret-commit", exec });
    const ut = plan.untrustedInputs.untrackedFiles ?? [];
    const found = ut.find(u => u.path === "secret.txt");
    assert.ok(found, "untracked file present");
    assert.equal(
      found!.content?.includes("AKIA"),
      false,
      "AKIA literal must not survive in LLM-bound untracked content",
    );
    assert.match(found!.content ?? "", /<<REDACTED:aws-access-key>>/);
  });
});

test("F-3: >4KB untracked file fingerprint is symmetric across preflight and execute", () => {
  withRepo(() => {
    const big = "abc".repeat(4096); // ~12KB, well above the old 4KB cap.
    fs.writeFileSync("large.txt", big);
    const exec = fakeExec(
      {
        "gh repo view --json nameWithOwner,defaultBranchRef,url": fakeRepoView,
        "gh pr list --head feat/9-untracked --state open --json number,url,title,body,headRefOid": "[]",
      },
      realGit,
    );
    const plan = buildPlan({ rawArgs: "--commit-all", exec });
    // reverifyState recomputes the fingerprint and throws on mismatch.
    reverifyState(plan, { exec });
  });
});

test("F-1: spawnWatcher launches gh_watch_runs.ts with the expected argv", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-watcher-spawn-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  let captured: { cmd: string; argv: readonly string[]; options: { detached: boolean; stdio: "ignore" } } | null = null;
  try {
    const r = spawnWatcher(
      { host: "github.com", owner: "evinced", repo: "x", pr: 42, headSha: "deadbeef" },
      {
        spawnFn: (cmd, argv, options) => {
          captured = { cmd, argv, options };
          return { pid: 12345, unref: () => {} };
        },
      },
    );
    assert.equal(r.alreadyRunning, false);
    assert.equal(r.pid, 12345);
    assert.ok(r.stateFile && r.stateFile.endsWith("deadbeef.json"));
    assert.ok(captured, "spawnFn must be called when no lock is present");
    const c = captured as unknown as { cmd: string; argv: readonly string[] };
    assert.equal(c.cmd, process.execPath);
    assert.ok(c.argv.includes("--experimental-strip-types"));
    assert.ok(c.argv.some(a => a.endsWith("gh_watch_runs.ts")));
    const idx = (flag: string) => c.argv.indexOf(flag);
    assert.equal(c.argv[idx("--host") + 1], "github.com");
    assert.equal(c.argv[idx("--repo") + 1], "evinced/x");
    assert.equal(c.argv[idx("--pr") + 1], "42");
    assert.equal(c.argv[idx("--head-sha") + 1], "deadbeef");
    const co = (captured as unknown as { options: { detached: boolean; stdio: "ignore" } }).options;
    assert.equal(co.detached, true);
    assert.equal(co.stdio, "ignore");
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("F-1: spawnWatcher returns alreadyRunning when our pid holds a fresh lock", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-watcher-"));
  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const args = { host: "github.com", owner: "evinced", repo: "x", pr: 42, headSha: "deadbeef" };
    ensurePrDir(args.host, args.owner, args.repo, args.pr);
    fs.writeFileSync(
      lockFile(args.host, args.owner, args.repo, args.pr, args.headSha),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        headSha: args.headSha,
        command: "gh-watch-runs",
        ownerToken: "t",
      }),
    );
    const r = spawnWatcher(args);
    assert.equal(r.alreadyRunning, true);
    assert.equal(r.pid, null);
    assert.ok(r.stateFile && r.stateFile.endsWith(".json"));
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
