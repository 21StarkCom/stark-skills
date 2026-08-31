import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileAtRef } from "../lib/git.ts";

// fileAtRef reads a repo-root file at a ref. The pathspec MUST be root-relative,
// or running from a repo subdirectory (a leftover `cd ts/`) silently misses it —
// the bug that skipped `.stark-gh.json` merge config on pr-merge.

let repo: string;
let originalCwd: string;

before(() => {
  originalCwd = process.cwd();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "fileatref-"));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  g("init", "-q");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  g("commit", "--allow-empty", "-qm", "root"); // ensure a HEAD even on odd default configs
  fs.writeFileSync(path.join(repo, ".stark-gh.json"), '{"merge":{"noWatch":true}}\n');
  fs.mkdirSync(path.join(repo, "sub"));
  fs.writeFileSync(path.join(repo, "sub", "nested.txt"), "x\n");
  g("add", "-A");
  g("commit", "-qm", "add config");
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("finds a repo-root file when run from the repo root", () => {
  process.chdir(repo);
  try {
    const got = fileAtRef("HEAD", ".stark-gh.json");
    assert.equal(got?.trim(), '{"merge":{"noWatch":true}}');
  } finally {
    process.chdir(originalCwd);
  }
});

test("finds a repo-root file when run from a SUBDIRECTORY (the regression)", () => {
  process.chdir(path.join(repo, "sub"));
  try {
    // Without --full-tree the pathspec resolves to sub/.stark-gh.json → null.
    const got = fileAtRef("HEAD", ".stark-gh.json");
    assert.equal(got?.trim(), '{"merge":{"noWatch":true}}');
  } finally {
    process.chdir(originalCwd);
  }
});

test("returns null for a genuinely absent file (from a subdirectory)", () => {
  process.chdir(path.join(repo, "sub"));
  try {
    assert.equal(fileAtRef("HEAD", "does-not-exist.json"), null);
  } finally {
    process.chdir(originalCwd);
  }
});
