import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runtimeDir, mktempInRuntime } from "../lib/runtime.ts";

test("runtimeDir resolves under ~/.claude/code-review/stark-gh/runtime", () => {
  const dir = runtimeDir();
  assert.equal(
    dir,
    path.join(os.homedir(), ".claude", "code-review", "stark-gh", "runtime"),
  );
});

test("mktempInRuntime creates a 0600 file inside a 0700 dir", () => {
  const p = mktempInRuntime("test-XXXXXX");
  try {
    assert.ok(fs.existsSync(p));
    const fileMode = fs.statSync(p).mode & 0o777;
    assert.equal(fileMode, 0o600, `file mode 0${fileMode.toString(8)}`);
    const dirMode = fs.statSync(path.dirname(p)).mode & 0o777;
    assert.equal(dirMode, 0o700, `dir mode 0${dirMode.toString(8)}`);
  } finally {
    fs.unlinkSync(p);
  }
});
