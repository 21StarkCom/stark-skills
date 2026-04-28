import { test } from "node:test";
import assert from "node:assert/strict";
import { pushBranch, assembleBody } from "../gh_pr_open_execute.ts";
import * as fs from "node:fs";

test("pushBranch verifies origin URL matches plan", () => {
  const calls: string[][] = [];
  const exec = ((cmd: string, args: readonly string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "git" && args[0] === "remote") return Buffer.from("https://github.com/evinced/stark.git\n");
    if (cmd === "git" && args[0] === "push") return Buffer.from("");
    if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return Buffer.from("abc\n");
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;
  const head = pushBranch({ branch: "feat/x", repo: { owner: "evinced", name: "stark" } }, { exec });
  assert.equal(head, "abc");
  assert.ok(calls.some(c => c.join(" ") === "git push origin HEAD:refs/heads/feat/x"));
});

test("pushBranch refuses if origin URL mismatches", () => {
  const exec = ((cmd: string, args: readonly string[]) => {
    if (cmd === "git" && args[0] === "remote") return Buffer.from("https://github.com/elsewhere/repo.git\n");
    throw new Error(`unmocked: ${cmd} ${args.join(" ")}`);
  }) as never;
  assert.throws(() => pushBranch({ branch: "feat/x", repo: { owner: "evinced", name: "stark" } }, { exec }), /origin/);
});

test("assembleBody appends closes/refs after a blank line", () => {
  const tmpfile = `/tmp/body-${Date.now()}`;
  fs.writeFileSync(tmpfile, "## Summary\nfoo\n", { mode: 0o600 });
  try {
    const out = assembleBody({ bodyFile: tmpfile, closesLines: ["Closes #1"], refsLines: ["Refs #2"] });
    const final = fs.readFileSync(out, "utf8");
    assert.match(final, /## Summary[\s\S]*\n\nCloses #1\nRefs #2\n$/);
    fs.unlinkSync(out);
  } finally {
    fs.unlinkSync(tmpfile);
  }
});
