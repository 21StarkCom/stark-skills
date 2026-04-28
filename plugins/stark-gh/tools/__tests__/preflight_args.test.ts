import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawArgs } from "../gh_pr_open_preflight.ts";

test("parse empty raw-args", () => {
  assert.deepEqual(parseRawArgs(""), {
    title: null,
    body: null,
    bodyFile: null,
    commitMessage: null,
    commitMessageFile: null,
    base: null,
    reviewer: [],
    label: [],
    assignee: [],
    commitAll: false,
    fullContext: false,
    noWatch: false,
    draft: false,
    allowSecretCommit: false,
    allowSecretToLlm: false,
  });
});

test("parse simple flags", () => {
  const a = parseRawArgs('--title "feat: x" --reviewer alice,bob --commit-all --draft');
  assert.equal(a.title, "feat: x");
  assert.deepEqual(a.reviewer, ["alice", "bob"]);
  assert.equal(a.commitAll, true);
  assert.equal(a.draft, true);
});

test("parse secret override flags", () => {
  const a = parseRawArgs("--allow-secret-commit --allow-secret-to-llm");
  assert.equal(a.allowSecretCommit, true);
  assert.equal(a.allowSecretToLlm, true);
});

test("parse rejects unknown flag", () => {
  assert.throws(() => parseRawArgs("--bogus"), /unrecognized flag/);
});

test("parse rejects oversized title", () => {
  assert.throws(() => parseRawArgs(`--title ${'"'}${"a".repeat(5000)}${'"'}`), /too long/);
});

test("parse caps list length", () => {
  const r = "--reviewer " + Array.from({ length: 17 }, (_, i) => `u${i}`).join(",");
  assert.throws(() => parseRawArgs(r), /too many/);
});
