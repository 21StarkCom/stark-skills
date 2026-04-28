import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { extractLateLines } from "../gh_pr_open_execute.ts";

test("extractLateLines parses fixes #N from user-provided commit message file", () => {
  const tmpfile = `/tmp/late-msg-${Date.now()}`;
  fs.writeFileSync(tmpfile, "feat: foo\n\nFixes #99\n", { mode: 0o600 });
  try {
    const lines = extractLateLines(tmpfile, { owner: "evinced", name: "x" }, [], "user-provided", {
      issueExists: () => true,
    });
    assert.deepEqual(lines.closesLines, ["Closes #99"]);
  } finally {
    fs.unlinkSync(tmpfile);
  }
});

test("extractLateLines downgrades llm-drafted closes to refs", () => {
  const tmpfile = `/tmp/late-msg-${Date.now()}-llm`;
  fs.writeFileSync(tmpfile, "feat: foo\n\nFixes #99\n", { mode: 0o600 });
  try {
    const lines = extractLateLines(tmpfile, { owner: "evinced", name: "x" }, [], "llm-drafted", {
      issueExists: () => true,
    });
    assert.deepEqual(lines.closesLines, []);
    assert.deepEqual(lines.refsLines, ["Refs #99"]);
  } finally {
    fs.unlinkSync(tmpfile);
  }
});

test("extractLateLines drops candidates that don't verify", () => {
  const tmpfile = `/tmp/late-msg-${Date.now()}-b`;
  fs.writeFileSync(tmpfile, "feat: foo\n\nfixes #404\n", { mode: 0o600 });
  try {
    const lines = extractLateLines(tmpfile, { owner: "evinced", name: "x" }, [], "user-provided", {
      issueExists: () => false,
    });
    assert.deepEqual(lines.closesLines, []);
  } finally {
    fs.unlinkSync(tmpfile);
  }
});
