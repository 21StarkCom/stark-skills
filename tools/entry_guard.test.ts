// Entry-guard regression test.
//
// `~/.claude/code-review/tools` is a symlink to this directory, and every skill
// invokes these tools through that symlinked path. A guard that compares
// `import.meta.url` against a raw `pathToFileURL(process.argv[1])` never matches
// through a symlink, so `main()` silently never runs and the process exits 0
// having done nothing — a false green that is far worse than a crash.
//
// Every CLI tool here must resolve both sides with `realpathSync` before
// comparing. This test spawns each one through a symlink and asserts it still
// produces output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** CLI entry points that must survive being invoked through a symlink. */
const CLI_TOOLS = ["write_spec.ts", "write_spec_land.ts", "preflight.ts"];

function runThroughSymlink(tool: string, args: string[]): { stdout: string; status: number | null } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "entry-guard-"));
  try {
    // Mirror the real deployment: a symlink pointing at the tools directory.
    const linkedTools = path.join(dir, "tools");
    fs.symlinkSync(HERE, linkedTools);

    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(linkedTools, tool), ...args],
      { encoding: "utf8" },
    );
    return { stdout: res.stdout ?? "", status: res.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const tool of CLI_TOOLS) {
  test(`${tool} runs main() when invoked through a symlinked path`, () => {
    const { stdout } = runThroughSymlink(tool, ["--help"]);
    assert.notEqual(
      stdout.trim(),
      "",
      `${tool} produced no stdout through a symlink — its entry guard failed to ` +
        `match, so main() never ran and it exited without doing anything`,
    );
  });
}

test("write_spec_land resolve-slug works through a symlinked path", () => {
  const { stdout, status } = runThroughSymlink("write_spec_land.ts", [
    "resolve-slug",
    "--topic",
    "live vault adoption sync",
  ]);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), "live-vault-adoption-sync");
});
