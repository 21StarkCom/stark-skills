import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawArgs } from "../gh_pr_open_preflight.ts";

test("parse empty raw-args", () => {
  assert.deepEqual(parseRawArgs(""), {
    pr: null,
    title: null,
    body: null,
    bodyFile: null,
    commitMessage: null,
    commitMessageFile: null,
    base: null,
    reviewer: [],
    label: [],
    assignee: [],
    commitAll: true,
    fullContext: false,
    noWatch: false,
    draft: false,
    allowSecretCommit: false,
    allowSecretToLlm: false,
  });
});

test("bare integer sets pr", () => {
  const a = parseRawArgs("540 --title foo");
  assert.equal(a.pr, 540);
  assert.equal(a.title, "foo");
});

test("bare integer + --pr conflicts", () => {
  assert.throws(() => parseRawArgs("540 --pr 541"), /--pr already set/);
  assert.throws(() => parseRawArgs("--pr 540 541"), /--pr already set/);
});

test("'0' rejected", () => {
  assert.throws(() => parseRawArgs("0"), /bare PR number must be a positive integer/);
});

test("'-5' rejected", () => {
  // It falls through to the switch and throws unrecognized flag, or matches and throws.
  assert.throws(() => parseRawArgs("-5"), /bare PR number must be a positive integer|unrecognized flag/);
});

test("'abc' still rejected as unknown flag", () => {
  assert.throws(() => parseRawArgs("abc"), /unrecognized flag/);
});

test("parse simple flags", () => {
  const a = parseRawArgs('--title "feat: x" --reviewer alice,bob --commit-all --draft');
  assert.equal(a.title, "feat: x");
  assert.deepEqual(a.reviewer, ["alice", "bob"]);
  assert.equal(a.commitAll, true);
  assert.equal(a.draft, true);
});

test("commitAll defaults to true; --staged-only opts out", () => {
  assert.equal(parseRawArgs("").commitAll, true);
  assert.equal(parseRawArgs("--staged-only").commitAll, false);
  // explicit --commit-all still wins as true
  assert.equal(parseRawArgs("--commit-all").commitAll, true);
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
