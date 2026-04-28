import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../gh_pr_open_preflight.ts";

const fakeExec = (m: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in m) return Buffer.from(m[key]!);
    throw new Error(`unmocked: ${key}`);
  }) as never;

test("buildPlan emits a valid plan with TS-emitted refs line", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git",
    "git rev-parse --abbrev-ref HEAD": "feat/123-foo\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/stark",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/stark",
    }),
    "git status --porcelain": "M  src/foo.ts\n",
    "git rev-parse HEAD": "deadbeef\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feat/123-foo\n",
    "git rev-list --count @{u}..HEAD": "0\n",
    "gh pr list --head feat/123-foo --state open --json number,url,title,body,headRefOid": "[]",
    "git diff --cached": "diff --git a/src/foo.ts b/src/foo.ts\n+x\n",
    "git diff": "",
    "git fetch --no-tags --quiet origin main": "",
    "git rev-parse origin/main": "baseoid\n",
    "git diff origin/main...HEAD": "diff --git a/src/foo.ts b/src/foo.ts\n+y\n",
    "git diff --stat origin/main...HEAD": " src/foo.ts | 2 +-\n",
    "git log --format=%B%x1f origin/main..HEAD": "feat: add foo\n\u001f",
    "gh issue view 123 --repo evinced/stark --json state": "{\"state\":\"OPEN\"}",
    "git remote get-url origin": "https://github.com/evinced/stark.git\n",
  });
  const plan = buildPlan({ rawArgs: "", exec });
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.branch, "feat/123-foo");
  assert.equal(plan.baseOid, "baseoid");
  assert.deepEqual(plan.refsLines.preflight, ["Refs #123"]);
  assert.equal(plan.secretScan.hits.length, 0);
});
