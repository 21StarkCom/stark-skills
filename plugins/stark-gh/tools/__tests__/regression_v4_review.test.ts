import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildPlan, collectState } from "../gh_pr_open_preflight.ts";
import { assembleBody } from "../gh_pr_open_execute.ts";
import { redactSecrets } from "../lib/redact.ts";
import { prCreate, prEdit } from "../lib/gh.ts";

const fakeRepoView = JSON.stringify({
  nameWithOwner: "evinced/x",
  defaultBranchRef: { name: "main" },
  url: "https://github.com/evinced/x",
});

const fakeExec = (m: Record<string, string>, fallthrough?: (cmd: string, args: readonly string[]) => Buffer) =>
  ((cmd: string, args: readonly string[]) => {
    const k = `${cmd} ${args.join(" ")}`;
    if (k in m) return Buffer.from(m[k]!);
    if (fallthrough) return fallthrough(cmd, args);
    throw new Error(`unmocked: ${k}`);
  }) as never;

test("redactSecrets redacts high-entropy tokens", () => {
  const r = redactSecrets("prefix 9f3a8b67c2e1d540af89bc73a16e2f0d958c4b71e02d6f3a8b67c2e1d540af89 suffix");
  assert.match(r.text, /<<REDACTED:high-entropy>>/);
  assert.ok(r.spans.find(s => s.category === "high-entropy"));
});

test("redactSecrets leaves low-entropy long strings alone", () => {
  const r = redactSecrets("a".repeat(60));
  assert.equal(r.spans.find(s => s.category === "high-entropy"), undefined);
});

test("collectState refuses detached HEAD", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git",
    "git rev-parse --abbrev-ref HEAD": "HEAD\n",
  });
  assert.throws(() => collectState({ exec }), /detached HEAD/);
});

test("decideStage3: existing PR + only metadata flags routes to edit (not push-only)", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git",
    "git rev-parse --abbrev-ref HEAD": "feat/9-x\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": fakeRepoView,
    "git status --porcelain": "",
    "git rev-parse HEAD": "h\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feat/9-x",
    "git rev-list --count @{u}..HEAD": "0\n",
    "gh pr list --head feat/9-x --state open --json number,url,title,body,headRefOid": JSON.stringify([
      { number: 9, url: "https://x/pr/9", title: "t", body: "b", headRefOid: "head" },
    ]),
    "git diff --cached": "",
    "git diff": "",
    "git fetch --no-tags --quiet origin main": "",
    "git rev-parse origin/main": "base\n",
    "git diff origin/main...HEAD": "",
    "git diff --stat origin/main...HEAD": "",
    "git log --format=%B%x1f origin/main..HEAD": "",
    "git remote get-url origin": "https://github.com/evinced/x.git\n",
  });
  const plan = buildPlan({ rawArgs: "--label bug", exec });
  assert.equal(plan.stage3.action, "edit");
  assert.deepEqual(plan.stage3.willAddLabels, ["bug"]);
});

test("assembleBody never returns the user's --body-file path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stark-gh-body-"));
  try {
    const userBody = path.join(dir, "user-body.md");
    fs.writeFileSync(userBody, "## Summary\nuser-provided body\n");
    const out = assembleBody({ bodyFile: userBody, closesLines: [], refsLines: [] });
    assert.notEqual(out, userBody, "must write a fresh tempfile so cleanup never unlinks the user's file");
    fs.unlinkSync(out);
    assert.ok(fs.existsSync(userBody), "user body file must survive cleanup");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prCreate argv includes --draft, --reviewer, --label, --assignee", () => {
  let captured: readonly string[] | null = null;
  const exec = ((_cmd: string, args: readonly string[]) => {
    captured = args;
    return Buffer.from("");
  }) as never;
  prCreate(
    {
      title: "t",
      bodyFile: "/tmp/b",
      base: "main",
      reviewers: ["a", "b"],
      labels: ["bug"],
      assignees: ["c"],
      draft: true,
    },
    { exec },
  );
  const argv = captured! as unknown as readonly string[];
  assert.deepEqual(argv.slice(0, 8), ["pr", "create", "--title", "t", "--body-file", "/tmp/b", "--base", "main"]);
  assert.equal(argv.indexOf("--reviewer") >= 0, true);
  assert.equal(argv[argv.indexOf("--reviewer") + 1], "a,b");
  assert.equal(argv.indexOf("--label") >= 0, true);
  assert.equal(argv[argv.indexOf("--label") + 1], "bug");
  assert.equal(argv.indexOf("--assignee") >= 0, true);
  assert.equal(argv[argv.indexOf("--assignee") + 1], "c");
  assert.equal(argv.indexOf("--draft") >= 0, true);
});

test("prCreate omits --draft when draft is false", () => {
  let captured: readonly string[] | null = null;
  const exec = ((_cmd: string, args: readonly string[]) => {
    captured = args;
    return Buffer.from("");
  }) as never;
  prCreate({ title: "t", bodyFile: "/tmp/b", base: "main", draft: false }, { exec });
  const argv = captured! as unknown as readonly string[];
  assert.equal(argv.includes("--draft"), false);
});

test("prEdit argv routes metadata-only flags through --add-*", () => {
  let captured: readonly string[] | null = null;
  const exec = ((_cmd: string, args: readonly string[]) => {
    captured = args;
    return Buffer.from("");
  }) as never;
  prEdit(7, { addReviewers: ["a"], addLabels: ["bug"], addAssignees: ["c"] }, { exec });
  const argv = captured! as unknown as readonly string[];
  assert.deepEqual(argv.slice(0, 3), ["pr", "edit", "7"]);
  assert.equal(argv.indexOf("--add-reviewer") >= 0, true);
  assert.equal(argv.indexOf("--add-label") >= 0, true);
  assert.equal(argv.indexOf("--add-assignee") >= 0, true);
});

test("preflight: secret in user --body content trips pre-LLM scan", () => {
  const exec = fakeExec({
    "git rev-parse --git-dir": ".git",
    "git rev-parse --abbrev-ref HEAD": "feat/9-x\n",
    "gh repo view --json nameWithOwner,defaultBranchRef,url": fakeRepoView,
    "git status --porcelain": "",
    "git rev-parse HEAD": "h\n",
    "git rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feat/9-x",
    "git rev-list --count @{u}..HEAD": "0\n",
    "gh pr list --head feat/9-x --state open --json number,url,title,body,headRefOid": "[]",
    "git diff --cached": "",
    "git diff": "",
    "git fetch --no-tags --quiet origin main": "",
    "git rev-parse origin/main": "base\n",
    "git diff origin/main...HEAD": "",
    "git diff --stat origin/main...HEAD": "",
    "git log --format=%B%x1f origin/main..HEAD": "",
    "git remote get-url origin": "https://github.com/evinced/x.git\n",
  });
  assert.throws(
    () => buildPlan({ rawArgs: '--body "leaked AKIAIOSFODNN7EXAMPLE"', exec }),
    /secret-scan-hit/,
  );
});
