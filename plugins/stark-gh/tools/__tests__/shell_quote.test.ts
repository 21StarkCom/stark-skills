import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "../lib/shell_quote.ts";

test("tokenize splits on whitespace", () => {
  assert.deepEqual(tokenize("--title foo --reviewer alice"), [
    "--title",
    "foo",
    "--reviewer",
    "alice",
  ]);
});

test("tokenize honors double quotes", () => {
  assert.deepEqual(tokenize('--title "feat: add foo"'), ["--title", "feat: add foo"]);
});

test("tokenize honors single quotes", () => {
  assert.deepEqual(tokenize("--title 'one two'"), ["--title", "one two"]);
});

test("tokenize handles backslash escapes outside quotes", () => {
  assert.deepEqual(tokenize("a\\ b c"), ["a b", "c"]);
});

test("tokenize rejects unterminated quote", () => {
  assert.throws(() => tokenize('--title "unterminated'), /unterminated/);
});

test("tokenize handles empty input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});
