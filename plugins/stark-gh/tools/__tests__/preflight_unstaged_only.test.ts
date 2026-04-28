import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan } from "../gh_pr_open_preflight.ts";

const fakeExec = (m: Record<string, string>) =>
  ((cmd: string, args: readonly string[]) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (key in m) return Buffer.from(m[key]!);
    throw new Error(`unmocked: ${key}`);
  }) as never;

test("buildPlan refuses unstaged-only changes without --commit-all", () => {
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
  assert.throws(() => buildPlan({ rawArgs: "", exec }), /unstaged-only/);
});
