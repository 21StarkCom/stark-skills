import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRawArgs } from "../gh_cleanup.ts";

test("empty args → defaults", () => {
  assert.deepEqual(parseRawArgs(""), {
    pr: null,
    dryRun: false,
    keepBranches: [],
    noRebase: false,
    noWatcherCleanup: false,
    noConfig: false,
    noGc: false,
    dropStaleStashes: false,
    force: false,
    json: false,
  });
});

test("all simple flags", () => {
  const a = parseRawArgs("--dry-run --no-rebase --no-watcher-cleanup --no-config --no-gc --drop-stale-stashes --force --json");
  assert.equal(a.dryRun, true);
  assert.equal(a.noRebase, true);
  assert.equal(a.noWatcherCleanup, true);
  assert.equal(a.noConfig, true);
  assert.equal(a.noGc, true);
  assert.equal(a.dropStaleStashes, true);
  assert.equal(a.force, true);
  assert.equal(a.json, true);
});

test("--pr requires a value", () => {
  assert.throws(() => parseRawArgs("--pr"), /requires a value/);
});

test("--pr rejects non-positive ints", () => {
  assert.throws(() => parseRawArgs("--pr 0"), /positive integer/);
  assert.throws(() => parseRawArgs("--pr -3"), /positive integer/);
  assert.throws(() => parseRawArgs("--pr abc"), /positive integer/);
});

test("--pr accepts positive int", () => {
  assert.equal(parseRawArgs("--pr 42").pr, 42);
});

test("repeated --keep-branch accumulates", () => {
  const a = parseRawArgs("--keep-branch dev --keep-branch staging --keep-branch release/9.9");
  assert.deepEqual(a.keepBranches, ["dev", "staging", "release/9.9"]);
});

test("--keep-branch requires a value", () => {
  assert.throws(() => parseRawArgs("--keep-branch"), /requires a value/);
});

test("unknown flag rejected", () => {
  assert.throws(() => parseRawArgs("--bogus"), /unrecognized flag/);
});

test("positional arg rejected", () => {
  assert.throws(() => parseRawArgs("just-a-word"), /unexpected positional/);
});

test("quoted whitespace inside --keep-branch survives tokenizer", () => {
  // Shell-quoted value with slashes (common branch shape)
  const a = parseRawArgs("--keep-branch 'feat/foo bar' --pr 9");
  assert.deepEqual(a.keepBranches, ["feat/foo bar"]);
  assert.equal(a.pr, 9);
});
