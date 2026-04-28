import { test } from "node:test";
import assert from "node:assert/strict";
import { collectState, fetchBase } from "../gh_pr_open_preflight.ts";

const fakeExec = (responses: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in responses) return Buffer.from(responses[key]!);
    throw new Error(`unmocked: ${key}`);
  }) as never;

test("collectState returns shape including branch + base", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git\n",
    "git rev-parse --abbrev-ref HEAD": "feat/1-foo\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/stark",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/stark",
    }),
    "git status --porcelain": "M src/x.ts\n",
    "git rev-parse HEAD": "abc123\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feat/1-foo\n",
    "git rev-list --count @{u}..HEAD": "0\n",
    "gh pr list --head feat/1-foo --state open --json number,url,title,body,headRefOid": "[]\n",
    "git diff --cached": "",
    "git diff": "",
    "git remote get-url origin": "https://github.com/evinced/stark.git\n",
  });
  const s = collectState({ exec });
  assert.equal(s.branch, "feat/1-foo");
  assert.equal(s.baseBranch, "main");
  assert.equal(s.repo.nameWithOwner, "evinced/stark");
});

test("collectState refuses on default branch", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git\n",
    "git rev-parse --abbrev-ref HEAD": "main\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/stark",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/stark",
    }),
  });
  assert.throws(() => collectState({ exec }), /default branch/);
});

test("fetchBase records remote source after successful fetch", () => {
  const exec = fakeExec({
    "git fetch --no-tags --quiet origin main": "",
    "git rev-parse origin/main": "base123\n",
  });
  assert.deepEqual(fetchBase("main", { exec }), { baseOid: "base123", source: "remote" });
});
