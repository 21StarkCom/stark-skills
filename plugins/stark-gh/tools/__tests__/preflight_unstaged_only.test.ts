import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, collectState } from "../gh_pr_open_preflight.ts";

const fakeExec = (m: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in m) return Buffer.from(m[key]!);
    throw new Error(`unmocked: ${key}`);
  }) as never;

// Unstaged-only changes are staged-and-committed by default (commit-all is the
// default). The guard only fires when the caller explicitly opts into
// --staged-only and has nothing staged.
test("buildPlan refuses unstaged-only changes under --staged-only", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git",
    "git rev-parse --abbrev-ref HEAD": "feat/123-foo\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/stark",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/stark",
    }),
    "git status --porcelain": " M src/foo.ts\n",
  });
  assert.throws(() => buildPlan({ rawArgs: "--staged-only", exec }), /unstaged-only/);
});

test("collectState allows unstaged-only changes when commitAll (the default)", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git\n",
    "git rev-parse --abbrev-ref HEAD": "feat/123-foo\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": JSON.stringify({
      nameWithOwner: "evinced/stark",
      defaultBranchRef: { name: "main" },
      url: "https://github.com/evinced/stark",
    }),
    "git status --porcelain": " M src/foo.ts\n",
    "git rev-parse HEAD": "abc123\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feat/123-foo\n",
    "git rev-list --count @{u}..HEAD": "0\n",
    "gh pr list --head feat/123-foo --state open --json number,url,title,body,headRefOid": "[]\n",
    "git diff --cached": "",
    "git diff": "diff --git a/src/foo.ts b/src/foo.ts\n",
    "git remote get-url origin": "https://github.com/evinced/stark.git\n",
  });
  const s = collectState({ exec, commitAll: true });
  assert.equal(s.dirty, true);
  assert.deepEqual(s.dirtyFiles.unstaged, ["src/foo.ts"]);
});
