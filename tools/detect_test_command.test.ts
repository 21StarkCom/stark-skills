import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { detectTestCommand } from "./stark_review_lib.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "detect-tc-"));
});
afterEach(() => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // already gone
  }
});

const write = (rel: string, body = ""): void => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

test("empty repo → null (caller soft-skips the gate)", () => {
  assert.equal(detectTestCommand(root), null);
});

test("Makefile with a test: target → make test", () => {
  write("Makefile", "build:\n\tgo build\ntest:\n\tgo test ./...\n");
  assert.equal(detectTestCommand(root), "make test");
});

test("package.json scripts.test → npm test", () => {
  write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));
  assert.equal(detectTestCommand(root), "npm test");
});

test("Makefile target beats package.json (specificity precedence)", () => {
  write("Makefile", "test:\n\tnpm test\n");
  write("package.json", JSON.stringify({ scripts: { test: "vitest" } }));
  assert.equal(detectTestCommand(root), "make test");
});

test("go.mod → go test ./...", () => {
  write("go.mod", "module example.com/x\n");
  assert.equal(detectTestCommand(root), "go test ./...");
});

test("tools/*.test.ts → node (the stark-skills layout)", () => {
  write("tools/foo.test.ts", "// test");
  assert.equal(
    detectTestCommand(root),
    "node --test tools/*.test.ts",
  );
});

test("root-level *.test.js → node --test *.test.js", () => {
  write("widget.test.js", "// test");
  assert.equal(detectTestCommand(root), "node --test *.test.js");
});

test("pytest config WITHOUT test files → null (never repeat the exit-5 trap)", () => {
  write("pytest.ini", "[pytest]\n");
  assert.equal(detectTestCommand(root), null);
});

test("pytest config WITH test files → python3 -m pytest -q", () => {
  write("pytest.ini", "[pytest]\n");
  write("tests/test_app.py", "def test_ok():\n    assert True\n");
  assert.equal(detectTestCommand(root), "python3 -m pytest -q");
});

test("malformed package.json falls through to language defaults", () => {
  write("package.json", "{ not json");
  write("go.mod", "module x\n");
  assert.equal(detectTestCommand(root), "go test ./...");
});
